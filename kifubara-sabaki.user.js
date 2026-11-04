// ==UserScript==
// @name         Kifubara to Sabaki
// @namespace    https://github.com/TransientError
// @version      0.16
// @description  Send Fox SGF independently to paired Sabaki and Alerts receivers using one watched connection.
// @author       TransientError
// @match        https://kifubara.app/*
// @run-at       document-start
// @inject-into  content
// @grant        GM_addElement
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CHANNEL = 'kifubara-sabaki-capture-v1';
  const VERSION = '0.16';
  const ROUTINE_KINDS = [
    'welcome', 'followList', 'liveList', 'profile', 'other', 'lobby',
    'invitableReply', 'audience', 'talkFound', 'servers', 'push', 'watchBeat',
  ];
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_MOVES = 20000;
  const STATES = new Set(['waiting', 'queued', 'current', 'retrying', 'error', 'stopped', 'finished']);
  const prompt = window.prompt.bind(window);
  const alert = window.alert.bind(window);
  const senderId = crypto.randomUUID();
  const sockets = new Map();
  let rooms = new Map();
  const sabaki = createTarget('Sabaki', true);
  const alerts = createTarget('Alerts', false);
  const targets = [sabaki, alerts];
  const refreshOwners = new Set();
  let refreshControl = null;
  let socketId = null;
  let socketState = 'waiting';
  let observed = null;
  let candidate = null;
  let candidateReady = false;
  let captureMessage = 'Waiting for full history. Reload Fox page if capture started too late.';
  let panel = null;
  let status = null;
  let details = null;
  let detailsToggle = null;
  let pairAlertsButton = null;
  let verbose = false;
  let captureBlocked = false;
  let hookConfirmed = false;
  const eventCounts = new Map();
  let roomEvents = 0;
  let snapshotEvents = 0;
  let lastSnapshotMoves = null;
  let captureBase = null;
  const captureEvents = [];
  const endEvents = [];
  let lastResultEvidence = null;
  let refreshMessage = '';
  let lastRefreshFailure = null;

  function createTarget(name, visible) {
    return {
      name, visible, pairing: null, pinnedGame: null, active: null, lastAttempt: null,
      deliveryMessage: 'Not paired.', notice: '', ui: null,
    };
  }

  function watchedResult(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      && value.ending === 'resign' && [1, 2].includes(value.winColor)
      ? { ending: 'resign', winColor: value.winColor } : null;
  }

  function endFields(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const fields = {};
    for (const key of [
      'state', 'status', 'gameState', 'gameStatus', 'roomState', 'roomStatus', 'phase',
      'result', 'gameResult', 'resultCode', 'resultType', 'ending', 'winner', 'winnerColor',
      'winColor', 'winningColor', 'winType', 'reason', 'endReason', 'finishReason',
      'completed', 'finished', 'ended', 'over', 'isOver', 'isEnd', 'isEnded',
      'isFinished', 'gameOver', 'isGameOver', 'isGameEnd', 'endType',
      'score', 'margin', 'winBy', 'resign', 'draw', 'moveNum',
    ]) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const item = value[key];
      const safe = item === null || typeof item === 'boolean'
        || (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 1000000)
        || (typeof item === 'string' && item.length <= 32
          && /^(?:[BW]\+(?:R|Resign|T|Time|F|Forfeit|\d{1,3}(?:\.\d{1,3})?)|-?\d{1,4}(?:\.\d{1,3})?|playing|ended|finished|completed|over|scoring|counting|count|resigned|resign|draw|jigo|void|unknown|black|white|B|W|win|loss|timeout|time|disconnect|escape|aborted|cancelled|in-progress|settled|done|end|paused)$/i.test(item));
      fields[key] = safe ? item : null;
    }
    return fields;
  }

  // This function runs in the page realm. It receives no pairing or GM capabilities.
  function pageHook(channel, maxBytes, maxMoves, endFields, routineKinds, watchedResult) {
    'use strict';
    const NativeSocket = window.WebSocket;
    const dispatch = document.dispatchEvent.bind(document);
    const records = new Map();
    let serial = 0;
    const emit = (value) => dispatch(new CustomEvent(channel, {
      detail: JSON.stringify({ channel, ...value }),
    }));
    const text = (value, limit) => typeof value === 'string' && value.length <= limit ? value : '';
    const integer = (value) => Number.isSafeInteger(value) ? value : null;

    function refreshState(record, message, eventKind) {
      emit({ kind: 'refresh-state', socketId: record.id, message, eventKind });
    }

    function stopRefresh(record, message, eventKind) {
      clearTimeout(record.timer);
      clearTimeout(record.timeout);
      record.timer = null;
      record.timeout = null;
      record.enabled = false;
      record.outstanding = false;
      if (message) refreshState(record, message, eventKind);
    }

    function needsRefresh(record) {
      const info = record.infos.get(record.refreshRoom);
      return info && (info.moveNum > record.fullCount
        || (info.moveNum === record.fullCount && record.fullBoard !== null
          && info.board !== record.fullBoard)
        || (info.state === 4 && !record.finalHistory));
    }

    function scheduleRefresh(record, backoff = 0) {
      if (!record.enabled || record.outstanding || record.timer !== null || !needsRefresh(record)) return;
      if (record.attempts >= 3) {
        stopRefresh(record, 'Full-history refresh paused after three incomplete attempts. Choose Send to retry.');
        return;
      }
      if (record.ws.readyState !== NativeSocket.OPEN || record.watch?.roomKey !== record.refreshRoom
        || record.fullRoom !== record.refreshRoom) {
        stopRefresh(record, 'Full-history refresh paused: selected connection or room changed.');
        return;
      }
      const delay = Math.max(backoff, 1000 - (Date.now() - record.lastRequest), 0);
      record.timer = setTimeout(() => {
        record.timer = null;
        if (!record.enabled || record.outstanding || !needsRefresh(record)) return;
        if (record.ws.readyState !== NativeSocket.OPEN || record.watch?.roomKey !== record.refreshRoom
          || record.fullRoom !== record.refreshRoom) {
          stopRefresh(record, 'Full-history refresh paused: selected connection or room changed.');
          return;
        }
        record.outstanding = true;
        record.requestedTerminal = record.infos.get(record.refreshRoom)?.state === 4;
        record.attempts++;
        record.lastRequest = Date.now();
        refreshState(record, 'Requesting complete history on the existing selected connection.');
        try {
          // Replay only the site's exact observed watch, never login or constructed auth.
          Reflect.apply(record.nativeSend, record.ws, [record.watch.payload]);
        } catch (_) {
          stopRefresh(record, 'Full-history refresh failed; choose Send explicitly to retry.');
          return;
        }
        record.timeout = setTimeout(() => {
          record.timeout = null;
          record.outstanding = false;
          if (!record.enabled) return;
          if (record.attempts >= 3) {
            stopRefresh(record, 'Full-history refresh paused after three timeouts. Choose Send to retry.');
          } else {
            scheduleRefresh(record, 1000 * (2 ** (record.attempts - 1)));
          }
        }, 3000);
      }, delay);
    }

    document.addEventListener(`${channel}-control`, (event) => {
      if (event.target !== document || typeof event.detail !== 'string' || event.detail.length > 1024) return;
      let control;
      try { control = JSON.parse(event.detail); } catch (_) { return; }
      if (control?.type !== 'refresh' || typeof control.enabled !== 'boolean'
        || typeof control.socketId !== 'string' || typeof control.roomKey !== 'string') return;
      const record = records.get(control.socketId);
      if (!record) return;
      if (!control.enabled) {
        stopRefresh(record, 'Full-history refresh disabled.');
        return;
      }
      if (record.ws.readyState !== NativeSocket.OPEN || !record.nativeSend
        || record.watch?.roomKey !== control.roomKey || record.fullRoom !== control.roomKey) {
        stopRefresh(record, 'Full-history refresh paused: waiting for an observed native watch and full record.');
        return;
      }
      if (record.enabled && record.refreshRoom === control.roomKey) {
        refreshState(record, 'Full-history refresh already enabled; waiting for the outstanding complete record.');
        scheduleRefresh(record);
        return;
      }
      for (const other of records.values()) if (other !== record) stopRefresh(other);
      clearTimeout(record.timer);
      clearTimeout(record.timeout);
      record.timer = null;
      record.timeout = null;
      record.outstanding = false;
      record.enabled = true;
      record.refreshRoom = control.roomKey;
      record.attempts = 0;
      refreshState(record, 'Full-history refresh enabled on the existing selected connection.');
      scheduleRefresh(record);
    });

    window.WebSocket = new Proxy(NativeSocket, {
      construct(target, args, newTarget) {
        const ws = Reflect.construct(target, args, newTarget);
        let url;
        try { url = new URL(ws.url); } catch (_) { return ws; }
        if (url.protocol !== 'wss:' || url.hostname !== 'kifu-fox-bridge.groovy-art.workers.dev'
          || url.pathname !== '/link') return ws;
        const id = String(++serial);
        const record = {
          id, ws, nativeSend: ws.send, watch: null, infos: new Map(),
          fullRoom: null, fullCount: null, fullBoard: null, refreshRoom: null,
          enabled: false, outstanding: false, timer: null, timeout: null,
          attempts: 0, lastRequest: -Infinity, lastEndEvidence: '',
          requestedTerminal: null, finalHistory: false,
        };
        records.set(id, record);
        if (records.size > 32) {
          const obsolete = [...records.values()].find((item) => item !== record && !item.enabled);
          if (obsolete) records.delete(obsolete.id);
        }
        if (typeof record.nativeSend === 'function') {
          ws.send = function (...values) {
            const result = Reflect.apply(record.nativeSend, this, values);
            if (this === ws && typeof values[0] === 'string' && values[0].length <= maxBytes) {
              let outgoing;
              try { outgoing = JSON.parse(values[0]); } catch (_) { return result; }
              if (outgoing?.k === 'watch' && typeof outgoing.key === 'string'
                && outgoing.key.length > 0 && outgoing.key.length <= 100) {
                if (record.enabled && outgoing.key !== record.refreshRoom) {
                  stopRefresh(record, 'Full-history refresh paused: the site selected another room.');
                }
                record.watch = { roomKey: outgoing.key, payload: values[0] };
                record.requestedTerminal = record.infos.get(outgoing.key)?.state === 4;
              }
            }
            return result;
          };
        }
        const state = (value) => emit({ kind: 'socket', socketId: id, state: value });
        state('connecting');
        ws.addEventListener('open', () => state('open'));
        ws.addEventListener('close', () => {
          stopRefresh(record);
          state('closed');
        });
        ws.addEventListener('error', () => {
          stopRefresh(record);
          state('error');
        });
        ws.addEventListener('message', (event) => {
          if (typeof event.data !== 'string' || event.data.length > maxBytes) {
            emit({ kind: 'unsupported', socketId: id });
            return;
          }
          let data;
          try { data = JSON.parse(event.data); } catch (_) { return; }
          if (!data || typeof data !== 'object') return;
          if (record.fullRoom
            || (data.k === 'roomInfo' && typeof data.roomBrief?.roomKey === 'string')
            || (data.k === 'watched' && typeof data.observeRoomKey === 'string')) {
            const evidence = {};
            for (const [name, value] of [
              ['event', data], ['roomBrief', data.roomBrief], ['result', data.result],
              ['game', data.game], ['gameInfo', data.gameInfo], ['room', data.room],
              ['lobby', data.lobby], ['data', data.data], ['data.result', data.data?.result],
              ['observeResult', data.observeResult],
            ]) {
              const fields = endFields(value);
              if (Object.keys(fields).length) evidence[name] = fields;
            }
            if (Object.keys(evidence).length) {
              const eventKind = typeof data.k === 'string' && /^[a-zA-Z][a-zA-Z0-9._:-]{0,47}$/.test(data.k)
                ? data.k : 'unrecognized';
              const signature = JSON.stringify([eventKind, evidence]);
              if (signature !== record.lastEndEvidence) {
                record.lastEndEvidence = signature;
                emit({
                  kind: 'end-evidence', socketId: id, eventKind, evidence,
                  roomKey: text(data.observeRoomKey || data.roomBrief?.roomKey || record.fullRoom, 100),
                });
              }
            }
          }
          if (data.k === 'roomInfo' && data.roomBrief && typeof data.roomBrief === 'object') {
            const r = data.roomBrief;
            if (typeof r.roomKey === 'string' && r.roomKey.length <= 100
              && Number.isInteger(r.boardSize) && r.boardSize >= 2 && r.boardSize <= 25
              && Number.isInteger(r.moveNum) && r.moveNum >= 0 && r.moveNum <= maxMoves
              && typeof r.board === 'string' && r.board.length === r.boardSize ** 2
              && /^[012]+$/.test(r.board) && r.variant === 0) {
              record.infos.set(r.roomKey, { moveNum: r.moveNum, board: r.board, state: integer(r.state) });
              if (r.roomKey === record.fullRoom && r.state !== 4) record.finalHistory = false;
              if (record.infos.size > 8) record.infos.delete(record.infos.keys().next().value);
            }
            emit({
              kind: 'room', socketId: id,
              room: {
                roomKey: text(r.roomKey, 100), boardSize: integer(r.boardSize),
                moveNum: integer(r.moveNum), board: text(r.board, 625), variant: integer(r.variant),
                state: integer(r.state),
                black: text(r.black, 256), white: text(r.white, 256),
                event: text(r.event, 256), title: text(r.title, 256),
              },
            });
            scheduleRefresh(record);
          } else if (data.k === 'watched' && Array.isArray(data.moves)
            && data.moves.length <= maxMoves) {
            const result = watchedResult(data.observeResult);
            if (typeof data.observeRoomKey === 'string') {
              if (record.enabled && data.observeRoomKey !== record.refreshRoom) {
                stopRefresh(record, 'Full-history refresh paused: returned history belongs to another room.');
              }
              clearTimeout(record.timeout);
              record.timeout = null;
              record.outstanding = false;
              record.fullRoom = data.observeRoomKey;
              record.fullCount = data.moves.length;
              const info = record.infos.get(record.fullRoom);
              record.fullBoard = info?.moveNum === record.fullCount ? info.board : null;
              record.finalHistory = Boolean(record.fullBoard !== null && info?.state === 4
                && (result || record.requestedTerminal !== false));
              record.requestedTerminal = null;
              if (record.fullBoard !== null) record.attempts = 0;
            }
            emit({
              kind: 'snapshot', socketId: id, roomKey: text(data.observeRoomKey, 100),
              result, terminalHistory: record.finalHistory,
              moves: data.moves.map((move) => ({
                x: integer(move?.x), y: integer(move?.y), color: integer(move?.color),
                pass: typeof move?.pass === 'boolean' ? move.pass : null,
              })),
            });
            scheduleRefresh(record);
          } else {
            if (record.enabled && ['error', 'unauthorized', 'auth', 'login'].includes(data.k)) {
              const eventKind = typeof data.k === 'string' && /^[a-zA-Z][a-zA-Z0-9._:-]{0,47}$/.test(data.k)
                ? data.k : 'unrecognized';
              stopRefresh(record, `Full-history refresh paused after response: ${eventKind}.`, eventKind);
            }
            if (data.k === 'lobby' && data.move && typeof data.move === 'object') {
              const move = data.move;
              emit({
                kind: 'move-candidate', socketId: id,
                move: {
                  x: integer(move.x), y: integer(move.y), color: integer(move.color),
                  pass: typeof move.pass === 'boolean' ? move.pass : null,
                  synSeq: integer(move.synSeq), roundNum: integer(move.roundNum),
                },
              });
            }
            // Unknown events cannot establish either a played move or continuous freshness.
            emit({
              kind: 'unsupported', socketId: id,
              routine: routineKinds.includes(data.k)
                && !(data.move && data.move.color !== 0)
                && (data.moves == null || (Array.isArray(data.moves) && data.moves.length === 0))
                && !data.observeUndo && !data.observeSwap && !data.observePass,
              eventKind: typeof data.k === 'string' && /^[a-zA-Z][a-zA-Z0-9._:-]{0,47}$/.test(data.k)
                ? data.k : 'unrecognized',
            });
          }
        });
        return ws;
      },
    });
    emit({ kind: 'installed' });
  }

  function render() {
    const refreshPaused = /paused|failed/.test(refreshMessage);
    const moves = (count) => `${count} ${count === 1 ? 'move' : 'moves'}`;
    for (const target of targets) {
      if (!target.ui) continue;
      const { active, pairing, notice, lastAttempt, ui } = target;
      let message;
      if (notice) message = notice;
      else if (active) {
        const retained = active.moveCount == null ? '' : ` ${moves(active.moveCount)} retained.`;
        if (active.roomChanged) message = `Game changed. Stop before switching.${retained}`;
        else if (['closed', 'error'].includes(socketState)) message = `Feed disconnected.${retained}`;
        else if (refreshPaused) message = `Refresh paused. Retry or open Details.${retained}`;
        else if (active.phase === 'retrying') message = `Receiver unavailable; retrying.${retained}`;
        else if (active.acceptedSequence === null) {
          message = active.phase === 'queued'
            ? `Waiting for ${target.name} to accept ${moves(active.latest.moves)}.`
            : `Sending ${moves(active.latest.moves)}...`;
        } else if (!active.ready) {
          message = `Catching up; waiting for verified history.${retained}`;
        } else if (active.pending || active.phase === 'queued'
          || active.flight?.envelope.sgf) {
          message = `Updating ${moves(active.latest.moves)}...`;
        } else {
          const received = active.moveCount == null ? 'Game received.' : `${moves(active.moveCount)} received.`;
          message = feed(active).upstream === 'current' ? `Caught up. ${received}` : received;
        }
      } else if (captureBlocked) message = 'Capture unavailable. Open Details.';
      else if (candidate) {
        message = pairing ? `${moves(candidate.moves)} ready. Send to ${target.name}.` : `${moves(candidate.moves)} captured. Pair to send.`;
      } else message = 'Waiting for Fox game history.';
      ui.container.hidden = !target.visible;
      ui.summary.textContent = `${target.name}: ${message}`;
      ui.buttons.get('Pair').hidden = Boolean(pairing || active);
      const send = ui.buttons.get('Send');
      send.hidden = !pairing || Boolean(active && (!refreshPaused || active.roomChanged));
      send.textContent = active ? 'Retry' : 'Send';
      send.disabled = !candidate;
      const stop = ui.buttons.get('Stop');
      stop.hidden = !pairing && !active;
      stop.textContent = active || lastAttempt ? 'Stop' : 'Unpair';
    }
    if (details) details.hidden = !verbose;
    if (pairAlertsButton) pairAlertsButton.hidden = alerts.visible;
    if (panel) panel.style.maxWidth = verbose ? '380px' : '300px';
    if (detailsToggle) {
      detailsToggle.textContent = verbose ? 'Less' : 'Details';
      detailsToggle.setAttribute('aria-expanded', String(verbose));
    }
    if (status) {
      status.textContent = `v${VERSION}. ${captureMessage} `
        + targets.filter((target) => target.visible).map((target) => {
          const count = target.active?.moveCount;
          return `${target.name}: ${target.deliveryMessage}`
            + (count == null ? '' : ` ${count} moves accepted.`);
        }).join(' ')
        + (refreshMessage ? ` ${refreshMessage}` : '')
        + ' Full snapshots only; incremental events unverified.';
    }
  }

  function toggleVerbose() {
    verbose = !verbose;
    render();
  }

  function plain(value, limit = 256) {
    if (typeof value !== 'string') return '';
    return value.slice(0, limit).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  function validRoom(value) {
    if (!value || typeof value !== 'object' || typeof value.roomKey !== 'string'
      || !value.roomKey.length || value.roomKey.length > 100
      || !Number.isInteger(value.boardSize) || value.boardSize < 2 || value.boardSize > 25
      || !Number.isInteger(value.moveNum) || value.moveNum < 0 || value.moveNum > MAX_MOVES
      || value.variant !== 0 || typeof value.board !== 'string'
      || value.board.length !== value.boardSize ** 2 || !/^[012]+$/.test(value.board)) return null;
    return {
      roomKey: value.roomKey, boardSize: value.boardSize, moveNum: value.moveNum,
      board: value.board, black: plain(value.black), white: plain(value.white),
      state: Number.isInteger(value.state) ? value.state : null,
      event: plain(value.event), title: plain(value.title),
    };
  }

  function validMoves(value) {
    if (!Array.isArray(value) || value.length > MAX_MOVES) return null;
    const moves = [];
    for (const move of value) {
      if (!move || typeof move !== 'object' || ![1, 2].includes(move.color)
        || typeof move.pass !== 'boolean'
        || !Number.isInteger(move.x) || !Number.isInteger(move.y)) return null;
      moves.push({ x: move.x, y: move.y, color: move.color, pass: move.pass });
    }
    return moves;
  }

  function toSgf(room, moves, result) {
    const size = room.boardSize;
    if (moves.length !== room.moveNum) throw new Error('History length does not match room snapshot.');
    const board = Array(size * size).fill(0);
    const neighbors = (point) => {
      const result = [];
      const x = point % size;
      const y = Math.floor(point / size);
      if (x > 0) result.push(point - 1);
      if (x + 1 < size) result.push(point + 1);
      if (y > 0) result.push(point - size);
      if (y + 1 < size) result.push(point + size);
      return result;
    };
    function group(point) {
      const color = board[point];
      const stones = new Set([point]);
      let liberty = false;
      const pending = [point];
      while (pending.length) {
        for (const next of neighbors(pending.pop())) {
          if (board[next] === 0) liberty = true;
          else if (board[next] === color && !stones.has(next)) {
            stones.add(next);
            pending.push(next);
          }
        }
      }
      return { stones, liberty };
    }
    let nodes = '';
    for (const move of moves) {
      const color = move.color === 1 ? 'B' : 'W';
      if (move.pass) {
        nodes += `;${color}[]`;
        continue;
      }
      if (move.x < 0 || move.y < 0 || move.x >= size || move.y >= size) {
        throw new Error('Move outside board.');
      }
      const point = move.y * size + move.x;
      if (board[point]) throw new Error('History contains an occupied move.');
      board[point] = move.color;
      for (const next of neighbors(point)) {
        if (!board[next] || board[next] === move.color) continue;
        const enemy = group(next);
        if (!enemy.liberty) for (const stone of enemy.stones) board[stone] = 0;
      }
      if (!group(point).liberty) throw new Error('Unsupported self-capture or starting setup.');
      nodes += `;${color}[${String.fromCharCode(97 + move.x, 97 + move.y)}]`;
    }
    if (board.join('') !== room.board) {
      throw new Error('Board/history mismatch; setup or missing moves unsupported.');
    }
    const escape = (text) => text.replace(/\r\n?/g, '\n').replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
    let root = `(;FF[4]GM[1]CA[UTF-8]SZ[${size}]`;
    for (const [key, value] of [
      ['PB', room.black], ['PW', room.white], ['EV', room.event], ['GN', room.title],
    ]) {
      if (value) root += `${key}[${escape(value)}]`;
    }
    if (result) root += `RE[${result.winColor === 1 ? 'B' : 'W'}+R]`;
    return `${root}${nodes})`;
  }

  function feed(state) {
    const ready = Boolean(state?.ready && candidateReady && candidate?.gameId === state.gameId
      && !state.roomChanged);
    const paused = /paused|failed/.test(refreshMessage);
    return {
      capture: ready ? 'ready' : 'waiting',
      upstream: ['closed', 'error'].includes(socketState) ? 'interrupted'
        : ready && socketState === 'open' && !paused ? 'current' : 'unknown',
      message: plain(paused ? refreshMessage : captureMessage),
    };
  }

  function invalidate(message) {
    candidate = null;
    candidateReady = false;
    captureMessage = message;
    for (const target of targets) {
      if (target.active) {
        target.active.ready = false;
        target.active.pending = null;
      }
    }
    render();
  }

  function buildCandidate() {
    if (!observed) return;
    const room = rooms.get(observed.roomKey);
    if (!room) {
      invalidate('Waiting for matching room metadata and a full watched snapshot.');
      return;
    }
    const previous = candidate;
    try {
      const result = room.state === 4 ? observed.result : null;
      candidate = {
        gameId: `kifubara-fox:${room.roomKey}`,
        sgf: toSgf(room, observed.moves, result),
        label: plain([room.black, room.white].filter(Boolean).join(' - ') || room.title),
        moves: observed.moves.length,
        completed: room.state === 4 && Boolean(observed.terminalHistory || result),
        result: result ? `${result.winColor === 1 ? 'B' : 'W'}+R` : '',
      };
      candidateReady = true;
      lastSnapshotMoves = candidate.moves;
      if (!captureBase || captureBase.roomKey !== room.roomKey || captureBase.socketId !== socketId) {
        captureBase = {
          socketId, roomKey: room.roomKey, boardSize: room.boardSize,
          moveNum: room.moveNum, board: room.board,
          moves: observed.moves.map((move) => ({ ...move })),
        };
        captureEvents.length = 0;
      }
    } catch (error) {
      invalidate(`Waiting for a complete supported snapshot. ${error.message}`);
      if (previous?.gameId === `kifubara-fox:${room.roomKey}`) candidate = previous;
      return;
    }
    captureMessage = `Captured ${candidate.moves} moves: ${candidate.label || candidate.gameId}.`;
    for (const target of targets) {
      const { active } = target;
      if (!active) continue;
      if (candidate.gameId !== active.gameId || active.roomChanged) {
        active.roomChanged = true;
        active.ready = false;
        active.pending = null;
        continue;
      }
      const restored = !active.ready;
      active.ready = true;
      const changed = active.latest.sgf !== candidate.sgf
        || active.latest.completed !== candidate.completed;
      active.latest = candidate;
      if (changed || restored) active.pending = candidate;
      pump(target);
    }
    render();
  }

  document.addEventListener(CHANNEL, (event) => {
    // String details cross Firefox/Chromium realms without sharing page objects.
    if (event.target !== document || typeof event.detail !== 'string'
      || event.detail.length > MAX_BYTES) return;
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || typeof data !== 'object' || data.channel !== CHANNEL) return;
    if (data.kind === 'installed') {
      hookConfirmed = true;
      captureBlocked = false;
      captureMessage = 'Hook installed; waiting for full history. Reload Fox page if needed.';
      render();
      return;
    }
    if (typeof data.socketId !== 'string' || !/^\d{1,10}$/.test(data.socketId)) return;
    if (data.kind === 'socket' && data.state === 'connecting') {
      sockets.set(data.socketId, { state: 'connecting', rooms: new Map(), pendingEnd: [] });
      if (sockets.size > 32) {
        const obsolete = [...sockets.keys()].find((id) => id !== socketId);
        sockets.delete(obsolete);
      }
      if (!socketId) {
        captureMessage = 'Hook connected; waiting for the game socket full snapshot.';
        render();
      }
      return;
    }
    const socket = sockets.get(data.socketId);
    if (!socket || ['closed', 'error'].includes(socket.state)) return;
    if (data.kind === 'socket' && ['open', 'closed', 'error'].includes(data.state)) {
      socket.state = data.state;
      if (data.socketId === socketId) socketState = data.state;
      if (data.socketId === socketId && data.state !== 'open') {
        observed = null;
        rooms.clear();
        invalidate('Feed interrupted; reconnect needs a fresh full snapshot.');
        refreshMessage = 'Full-history refresh paused; after a fresh record, choose Send to enable it again.';
      }
    } else if (data.kind === 'room') {
      roomEvents++;
      const room = validRoom(data.room);
      if (!room) {
        if (!socketId || data.socketId === socketId) {
          invalidate('Unsupported room metadata/setup; waiting for a complete supported snapshot.');
        }
        return;
      }
      socket.rooms.delete(room.roomKey);
      socket.rooms.set(room.roomKey, room);
      if (socket.rooms.size > 8) socket.rooms.delete(socket.rooms.keys().next().value);
      if (data.socketId === socketId && room.roomKey === captureBase?.roomKey) {
        recordCapture({
          kind: 'roomInfo', moveNum: room.moveNum, boardSize: room.boardSize, board: room.board,
        });
      }
      if (data.socketId === socketId && observed?.roomKey === room.roomKey) buildCandidate();
    } else if (data.kind === 'snapshot') {
      snapshotEvents++;
      const moves = validMoves(data.moves);
      if (!moves || typeof data.roomKey !== 'string' || !data.roomKey.length || data.roomKey.length > 100) {
        if (!socketId || data.socketId === socketId) {
          invalidate('Invalid full history; waiting for a supported watched snapshot.');
        }
        return;
      }
      if (targets.some((target) => target.active)
        && data.socketId !== socketId && !['closed', 'error'].includes(socketState)) return;
      socketId = data.socketId;
      socketState = socket.state;
      rooms = socket.rooms;
      observed = {
        roomKey: data.roomKey, moves, result: watchedResult(data.result),
        terminalHistory: data.terminalHistory === true,
      };
      if (lastResultEvidence?.roomKey !== data.roomKey
        || lastResultEvidence?.socketId !== socketId) lastResultEvidence = null;
      for (let i = endEvents.length - 1; i >= 0; i--) {
        const entry = endEvents[i];
        if (entry.socketId === socketId && entry.roomKey === data.roomKey && entry.evidence.observeResult) {
          lastResultEvidence = entry;
          break;
        }
      }
      for (const entry of socket.pendingEnd.splice(0)) {
        entry.lastFullMoves = moves.length;
        recordEndEntry(entry);
      }
      for (const target of targets) {
        if (target.active && `kifubara-fox:${data.roomKey}` !== target.active.gameId) {
          target.active.roomChanged = true;
        }
      }
      buildCandidate();
    } else if (data.kind === 'end-evidence') {
      if (!data.evidence || typeof data.evidence !== 'object') return;
      const evidence = {};
      for (const name of ['event', 'roomBrief', 'result', 'game', 'gameInfo', 'room', 'lobby', 'data', 'data.result', 'observeResult']) {
        const fields = endFields(data.evidence[name]);
        if (Object.keys(fields).length) evidence[name] = fields;
      }
      if (Object.keys(evidence).length) {
        const entry = {
          socketId: data.socketId, lastFullMoves: data.socketId === socketId ? lastSnapshotMoves : null,
          roomKey: typeof data.roomKey === 'string' ? plain(data.roomKey, 100) : '',
          eventKind: typeof data.eventKind === 'string'
            && /^[a-zA-Z][a-zA-Z0-9._:-]{0,47}$/.test(data.eventKind) ? data.eventKind : 'unrecognized',
          evidence,
        };
        if (data.socketId === socketId) {
          recordEndEntry(entry);
        } else {
          socket.pendingEnd.push(entry);
          if (socket.pendingEnd.length > 8) socket.pendingEnd.shift();
        }
      }
      return;
    } else if (data.kind === 'refresh-state' && data.socketId === socketId) {
      if (typeof data.message === 'string' && data.message.length <= 256) refreshMessage = plain(data.message);
      if (typeof data.eventKind === 'string' && /^[a-zA-Z][a-zA-Z0-9._:-]{0,47}$/.test(data.eventKind)) {
        lastRefreshFailure = { eventKind: data.eventKind, message: refreshMessage };
      }
    } else if (data.kind === 'move-candidate' && data.socketId === socketId) {
      const move = data.move;
      if (move && typeof move === 'object') {
        const integer = (value) => Number.isSafeInteger(value) ? value : null;
        recordCapture({
          kind: 'lobby.move',
          move: {
            x: integer(move.x), y: integer(move.y), color: integer(move.color),
            pass: typeof move.pass === 'boolean' ? move.pass : null,
            synSeq: integer(move.synSeq), roundNum: integer(move.roundNum),
          },
        });
      }
    } else if (data.kind === 'unsupported') {
      const eventKind = typeof data.eventKind === 'string'
        && /^[a-zA-Z][a-zA-Z0-9._:-]{0,47}$/.test(data.eventKind) ? data.eventKind : 'unrecognized';
      if (eventCounts.has(eventKind) || eventCounts.size < 16) {
        eventCounts.set(eventKind, (eventCounts.get(eventKind) || 0) + 1);
      }
      if (data.socketId !== socketId) {
        if (!socketId) {
          captureMessage = `Waiting for game history; auxiliary event: ${eventKind}. `
            + `Room messages: ${roomEvents}; histories: ${snapshotEvents}.`;
        }
        render();
        return;
      }
      if (data.routine === true && ROUTINE_KINDS.includes(eventKind)) return;
      const lastFullRecord = candidate;
      observed = null;
      invalidate(`Unverified event: ${eventKind}. Room messages: ${roomEvents}; histories: ${snapshotEvents}; `
        + `last valid history: ${lastSnapshotMoves ?? 'none'}. `
        + (lastFullRecord ? 'Send can export that last full snapshot; freshness unknown.' : 'Waiting for full snapshot.'));
      candidate = lastFullRecord;
    }
    render();
  });

  function pair(target) {
    target.visible = true;
    if (target.active) {
      target.deliveryMessage = 'Stop current Send before pairing.';
      render();
      return;
    }
    const input = prompt(`Paste ${target.name} pairing details JSON. Do not paste website credentials.`);
    if (input === null) { render(); return; }
    try {
      if (input.length > 2048) throw new Error();
      const value = JSON.parse(input);
      const url = new URL(value.endpoint);
      if (value.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || !url.port || Number(url.port) < 1 || url.pathname !== '/v1/browser-sgf'
        || url.username || url.password || url.search || url.hash
        || url.href !== value.endpoint || typeof value.token !== 'string'
        || !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token)) throw new Error();
      target.pairing = { endpoint: value.endpoint, token: value.token };
      target.pinnedGame = null;
      target.lastAttempt = null;
      target.deliveryMessage = 'Paired locally. Choose the observed game with Send.';
      target.notice = '';
    } catch (_) {
      target.deliveryMessage = 'Invalid pairing details; expected version 1, literal loopback endpoint and token.';
      target.notice = `Invalid pairing details. Copy them from ${target.name} and try again.`;
    }
    render();
  }

  function end(target, state, message, revoke = false) {
    if (state !== target.active) return;
    setRefresh(state, false);
    target.active = null;
    clearTimeout(state.heartbeat);
    clearTimeout(state.retryTimer);
    state.flight?.handle?.abort();
    state.pending = null;
    if (revoke) target.pairing = null;
    target.deliveryMessage = message;
    target.notice = message;
    render();
  }

  function start(target) {
    const { active, pairing, pinnedGame } = target;
    target.notice = '';
    if (active) {
      if (!active.roomChanged && candidate?.gameId === active.gameId) {
        active.captureSocketId = socketId;
        setRefresh(active, true);
        target.deliveryMessage = 'Already sending selected game; requested full-history refresh.';
      } else {
        target.deliveryMessage = active.roomChanged ? 'Room changed; Stop and pair again.' : 'Waiting for a fresh full record.';
      }
    } else if (!pairing) {
      target.deliveryMessage = `Pair with enabled ${target.name} receiving first.`;
    } else if (!candidate) {
      target.deliveryMessage = 'Waiting for full history; reload Fox page if capture missed the socket.';
    } else if (candidate.result && !candidateReady) {
      target.deliveryMessage = 'Waiting for a fresh terminal history before sending the game result.';
      target.notice = target.deliveryMessage;
    } else if (targets.some((other) => other.active && other.active.gameId !== candidate.gameId)) {
      target.deliveryMessage = 'Stop the other target before selecting another game.';
      target.notice = target.deliveryMessage;
    } else if (pinnedGame && pinnedGame !== candidate.gameId) {
      target.deliveryMessage = `Different game requires disabling/re-enabling ${target.name} receiving and pairing again.`;
      target.notice = target.deliveryMessage;
    } else {
      target.pinnedGame = candidate.gameId;
      target.active = {
        gameId: candidate.gameId, sendId: crypto.randomUUID(), sequence: 0, captureSocketId: socketId,
        latest: candidate, ready: candidateReady, roomChanged: false,
        pending: null, contactDue: false, flight: null,
        acceptedSequence: null, moveCount: null, sentSnapshots: new Set(),
        resnapshotSequence: null,
        phase: 'sending',
      };
      const state = target.active;
      target.lastAttempt = state;
      setRefresh(state, true);
      const heartbeat = () => {
        if (state !== target.active) return;
        state.contactDue = true;
        pump(target);
        state.heartbeat = setTimeout(heartbeat, 5000);
      };
      state.heartbeat = setTimeout(heartbeat, 5000);
      dispatch(target, makeEnvelope('start', candidate, state));
    }
    render();
  }

  function makeEnvelope(type, snapshot, state) {
    const envelope = {
      version: 1, type, senderId, sendId: state.sendId,
      gameId: state.gameId, sequence: ++state.sequence, feed: feed(state),
    };
    if (snapshot) {
      envelope.sgf = snapshot.sgf;
      envelope.label = snapshot.label;
      if (snapshot.completed && state.ready && !state.roomChanged) envelope.completed = true;
      state.sentSnapshots.add(envelope.sequence);
      if (state.sentSnapshots.size > 128) {
        state.sentSnapshots.delete(state.sentSnapshots.values().next().value);
      }
    }
    return envelope;
  }

  function setRefresh(state, enabled) {
    if (enabled) {
      refreshOwners.add(state);
      for (const owner of refreshOwners) {
        if (owner.gameId === state.gameId) owner.captureSocketId = state.captureSocketId;
      }
    } else refreshOwners.delete(state);
    const owner = refreshOwners.values().next().value;
    const next = owner ? { socketId: owner.captureSocketId, gameId: owner.gameId } : null;
    if (next && refreshControl?.socketId === next.socketId
      && refreshControl.gameId === next.gameId && !enabled) return;
    if (!next && !refreshControl) return;
    const control = next || refreshControl;
    refreshControl = next;
    document.dispatchEvent(new CustomEvent(`${CHANNEL}-control`, {
      detail: JSON.stringify({
        type: 'refresh', enabled: Boolean(next), socketId: control.socketId,
        roomKey: control.gameId.slice('kifubara-fox:'.length),
      }),
    }));
  }

  function pump(target) {
    const { active } = target;
    if (!active || active.flight) return;
    if (active.pending && active.ready && !active.roomChanged) {
      const snapshot = active.pending;
      active.pending = null;
      const envelope = makeEnvelope('snapshot', snapshot, active);
      if (active.requestResnapshot) {
        active.resnapshotSequence = envelope.sequence;
        active.requestResnapshot = false;
      }
      dispatch(target, envelope);
    } else if (active.contactDue) {
      active.contactDue = false;
      dispatch(target, makeEnvelope('status', null, active));
    }
  }

  function dispatch(target, envelope) {
    const state = target.active;
    if (!state || !target.pairing) return;
    const body = JSON.stringify(envelope);
    if (new TextEncoder().encode(body).length > MAX_BYTES) {
      end(target, state, 'Snapshot exceeds 8 MiB; delivery stopped.');
      return;
    }
    const flight = { envelope, attempts: 0, handle: null };
    state.flight = flight;
    const credentials = target.pairing;
    function current() { return target.active === state && state.flight === flight; }
    function terminal(message, revoke = false) { end(target, state, message, revoke); }
    function transient() {
      if (!current()) return;
      if (envelope.type !== 'start' && state.pending && state.ready) {
        state.flight = null;
        pump(target);
        return;
      }
      if (flight.attempts >= 4) {
        terminal('Local receiver unavailable; retries failed. Disable/re-enable receiving and pair again.', true);
        return;
      }
      target.deliveryMessage = 'Local delivery interrupted; retrying.';
      state.phase = 'retrying';
      render();
      state.retryTimer = setTimeout(attempt, 1000 * (2 ** (flight.attempts - 1)));
    }
    function receive(response) {
      if (!current()) return;
      if ([429, 503].includes(response.status)) { transient(); return; }
      let value;
      try {
        if (typeof response.responseText !== 'string' || response.responseText.length > 16384) throw new Error();
        value = JSON.parse(response.responseText);
      } catch (_) {
        terminal('Invalid receiver response; delivery stopped.');
        return;
      }
      const kind = value?.error?.kind;
      if (response.status === 401 || kind === 'unauthorized') {
        terminal('Authorization expired. Disable/re-enable receiving and pair again.', true);
        return;
      }
      if (kind === 'wrong-source') {
        terminal('Different sender/game is already associated. Disable/re-enable receiving and pair again.', true);
        return;
      }
      if (kind === 'cancelled') {
        terminal('Start cancelled. Choose Send explicitly to try again with the same pairing.');
        return;
      }
      if (['invalid-input', 'invalid-content', 'incompatible'].includes(kind)) {
        terminal('Record rejected or incompatible. Fix capture before choosing Send again.');
        return;
      }
      const accepted = value?.acceptedSequence;
      if (response.status < 200 || response.status >= 300 || value?.ok !== true
        || !STATES.has(value.state) || typeof value.needsSnapshot !== 'boolean'
        || (accepted !== null && (!Number.isSafeInteger(accepted) || accepted < 1
          || (!state.sentSnapshots.has(accepted) && accepted !== state.acceptedSequence)))
        || (value.moveCount !== null && (!Number.isInteger(value.moveCount)
          || value.moveCount < 0 || value.moveCount > MAX_MOVES))
        || value.state === 'error') {
        terminal('Invalid or failed receiver acknowledgement; delivery stopped.');
        return;
      }
      state.flight = null;
      if (accepted !== null && (state.acceptedSequence === null || accepted >= state.acceptedSequence)) {
        state.acceptedSequence = accepted;
        state.moveCount = value.moveCount;
      }
      if (value.state === 'stopped' || value.state === 'finished') {
        terminal(value.state === 'finished' ? 'Receiver finished.' : 'Receiver stopped. Pair again.', true);
        return;
      }
      target.deliveryMessage = response.status === 202 || value.state === 'queued'
        ? 'Snapshot queued; waiting for actual game acceptance.'
        : state.acceptedSequence === null ? 'Contact established; waiting for game acceptance.' : 'Game acceptance confirmed.';
      state.phase = response.status === 202 || value.state === 'queued' ? 'queued' : 'accepted';
      target.notice = '';
      if (!value.needsSnapshot) {
        if (state.resnapshotSequence !== null && accepted >= state.resnapshotSequence) {
          state.resnapshotSequence = null;
        }
      } else if (state.resnapshotSequence === null && !state.requestResnapshot) {
        state.requestResnapshot = true;
        if (state.ready && !state.roomChanged) state.pending = state.latest;
      }
      render();
      pump(target);
    }
    function attempt() {
      if (!current()) return;
      flight.attempts++;
      target.deliveryMessage = `Delivering to local ${target.name}; receipt is not acceptance.`;
      state.phase = 'sending';
      render();
      try {
        flight.handle = GM_xmlhttpRequest({
          method: 'POST', url: credentials.endpoint,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credentials.token}`,
          },
          anonymous: true, redirect: 'error', timeout: 1500, data: body,
          onload: receive, onerror: transient, ontimeout: transient,
        });
      } catch (_) { transient(); }
    }
    attempt();
  }

  function stop(target) {
    const state = target.active || target.lastAttempt;
    const credentials = target.pairing;
    const envelope = state ? makeEnvelope('stop', null, state) : null;
    if (target.active) end(target, target.active, 'Stopped. Receiving was revoked; pair again to resume.', true);
    else if (state) setRefresh(state, false);
    target.pairing = null;
    target.pinnedGame = null;
    target.lastAttempt = null;
    target.deliveryMessage = 'Stopped. Disable/re-enable receiving and pair again to resume.';
    target.notice = 'Stopped. Pair again to resume.';
    render();
    if (!envelope || !credentials) return;
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: credentials.endpoint,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.token}`,
        },
        anonymous: true, redirect: 'error', timeout: 1500,
        data: JSON.stringify(envelope),
      });
    } catch (_) {}
  }

  function help() {
    const info = typeof GM_info === 'object' ? GM_info : {};
    alert(`Kifubara to Sabaki v${VERSION}. `
      + `Manager: ${plain(info.scriptHandler || 'unknown')} ${plain(info.version || '')}. `
      + `Injection: ${plain(info.injectInto || 'unknown')}. `
      + `Hook handshake: ${hookConfirmed ? 'confirmed' : 'NOT confirmed'}.\n\n`
      + `Capture diagnostics (no credentials): roomInfo=${roomEvents}, watched=${snapshotEvents}, `
      + `last valid moves=${lastSnapshotMoves ?? 'none'}; other events: `
      + `${[...eventCounts].map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'}.\n\n`
      + 'Experimental: confirmed full watched snapshots only; incremental events are unverified.\n\n'
      + 'Send also enables bounded same-room full-history refresh on the existing connection. '
      + 'Only the exact previously observed native watch is reused, inside the page; no login is replayed. '
      + 'A higher room move count requests a new complete history; it never invents moves from the board. '
      + 'After socket reconnect, choose Send again to authorize refresh on the newly observed connection.\n\n'
      + 'Install in Violentmonkey with content injection, then reload the existing Fox page. '
      + 'Allow only 127.0.0.1 requests. Enable receiving in Sabaki, Copy pairing details, Pair here, then Send. '
      + 'For independent alerts, choose Pair alerts in the main controls and paste the watcher pairing JSON. '
      + 'Each receiver has its own Send, Stop, queue and authorization. Sabaki is optional; '
      + 'closing it does not stop Alerts. Keep the Fox browser tab open. '
      + 'Never paste the pairing token into the page console. A missed hook/CSP block requires checking manager injection; '
      + 'do not disable browser security.\n\n'
      + 'For manual verification capture roomInfo.roomBrief and watched.moves before/after one actual played move, '
      + 'then reconnect and switch rooms. Compare exact played histories, not just boards. '
      + 'Caught up means matching the latest advertised room position, not proving that Fox has no broadcast delay. '
      + 'Routine notifications do not invalidate that position; unknown or potentially mutating events require a fresh full snapshot. '
      + 'Diagnostics should contain only event kinds, room IDs, board size, move counts, and move x/y/color/pass. '
      + 'Exclude cookies, authorization headers, tokens, session replies, WebSocket URLs with credentials, '
      + 'commentary, and all unrelated traffic. Do not share a raw HAR.\n\n'
      + 'Completion requires selected-room state 4 and matching full history, count and board. '
      + 'A final history refresh captures late results; verified watched resignation results become SGF RE[B+R] or RE[W+R]. '
      + 'Other result formats remain unknown; no counted margin is guessed. '
      + 'Pass serialization is supported; runtime pass/correction behavior still needs verification. '
      + 'Nonempty setup, self-capture, pure-truncation takebacks, and continuous incremental capture are not claimed. '
      + 'Socket connectivity is not proof of upstream freshness; quiet games remain freshness unknown. '
      + 'Reload clears pairing. New games require disabling/re-enabling receiving and new pairing.');
  }

  function recordCapture(event) {
    captureEvents.push(event);
    if (captureEvents.length > 64) captureEvents.shift();
  }

  function recordEndEntry(entry) {
    endEvents.push(entry);
    if (endEvents.length > 128) endEvents.shift();
    if (entry.evidence.observeResult && entry.roomKey === observed?.roomKey) lastResultEvidence = entry;
  }

  function copyDiagnostics() {
    const info = typeof GM_info === 'object' ? GM_info : {};
    const targetStatus = (target) => ({
      compact: target.ui?.summary.textContent || '',
      delivery: target.deliveryMessage,
      sending: Boolean(target.active),
      acceptedSequence: target.active?.acceptedSequence ?? null,
      acceptedMoves: target.active?.moveCount ?? null,
      ready: target.active?.ready ?? candidateReady,
    });
    GM_setClipboard(JSON.stringify({
      version: VERSION,
      manager: { name: plain(info.scriptHandler), version: plain(info.version), injection: plain(info.injectInto) },
      status: {
        ...targetStatus(sabaki),
        verbose: status?.textContent || '',
        capture: captureMessage, refresh: refreshMessage,
        hookConfirmed, sourceSocket: socketId, socketState,
        eventKinds: Object.fromEntries(eventCounts),
        lastRefreshFailure,
      },
      targets: Object.fromEntries(targets.map((target) => [target.name, targetStatus(target)])),
      snapshot: captureBase, events: captureEvents, endEvents, lastResultEvidence,
    }, null, 2), 'text/plain');
    sabaki.deliveryMessage = 'Sanitized status and move diagnostics copied. No cookies or pairing token included.';
    sabaki.notice = 'Diagnostics copied.';
    render();
  }

  for (const target of targets) {
    GM_registerMenuCommand(`${target.name}: Pair receiver`, () => pair(target));
    GM_registerMenuCommand(`${target.name}: Send observed game`, () => start(target));
    GM_registerMenuCommand(`${target.name}: Stop sending`, () => stop(target));
  }
  GM_registerMenuCommand('Sabaki: Capture help / limitations', help);
  GM_registerMenuCommand('Sabaki: Copy diagnostics', copyDiagnostics);
  GM_registerMenuCommand('Sabaki: Toggle verbose details', toggleVerbose);
  window.addEventListener('pagehide', () => targets.forEach(stop));

  function mount() {
    if (panel || !document.documentElement) return;
    panel = document.createElement('div');
    panel.style.cssText = 'all:initial;position:fixed;bottom:12px;right:12px;z-index:2147483647;'
      + 'max-width:300px;padding:8px 10px;background:#20242a;color:white;font:12px sans-serif;'
      + 'border:1px solid #888;border-radius:6px;box-shadow:0 2px 8px #0008;';
    const button = (parent, label, action) => {
      const element = document.createElement('button');
      element.textContent = label;
      element.style.cssText = 'margin:6px 6px 0 0;padding:3px 8px;';
      element.addEventListener('click', action);
      parent.append(element);
      return element;
    };
    for (const target of targets) {
      const container = document.createElement('div');
      const summary = document.createElement('div');
      summary.setAttribute('role', 'status');
      const controls = document.createElement('div');
      const buttons = new Map([
        ['Pair', button(controls, 'Pair', () => pair(target))],
        ['Send', button(controls, 'Send', () => start(target))],
        ['Stop', button(controls, 'Stop', () => stop(target))],
      ]);
      target.ui = { container, summary, buttons };
      container.append(summary, controls);
      panel.append(container);
    }
    const controls = document.createElement('div');
    details = document.createElement('div');
    details.setAttribute('id', 'kifubara-sabaki-details');
    details.style.cssText = 'margin-top:8px;line-height:1.4;color:#cbd5e1;';
    status = document.createElement('div');
    details.append(status);
    panel.append(controls, details);
    pairAlertsButton = button(controls, 'Pair alerts', () => pair(alerts));
    detailsToggle = button(controls, 'Details', toggleVerbose);
    detailsToggle.setAttribute('aria-controls', 'kifubara-sabaki-details');
    button(details, 'Help', help);
    button(details, 'Copy diagnostics', copyDiagnostics);
    document.documentElement.append(panel);
    render();
  }
  mount();
  document.addEventListener('DOMContentLoaded', mount, { once: true });

  try {
    const hook = GM_addElement(document.documentElement, 'script', {
      textContent: `(${pageHook.toString()})(${JSON.stringify(CHANNEL)},${MAX_BYTES},${MAX_MOVES},${endFields.toString()},${JSON.stringify(ROUTINE_KINDS)},${watchedResult.toString()});`,
    });
    hook?.remove();
  } catch (_) {
    captureBlocked = true;
    invalidate('Page hook blocked. Check Violentmonkey content injection and reload; do not disable browser security.');
  }
  setTimeout(() => {
    if (!hookConfirmed) {
      captureBlocked = true;
      invalidate('Page hook did not confirm. Check Help for version/manager details and console injection errors.');
    }
  }, 2000);
})();
