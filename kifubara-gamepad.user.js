// ==UserScript==
// @name         Kifubara Gamepad
// @namespace    https://github.com/TransientError
// @version      1.9
// @description  Replay games, show players, reveal results, toggle AI, and keep the screen awake.
// @author       TransientError
// @match        https://kifubara.app/games/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[Kifubara Gamepad]';
  const STANDARD_BINDINGS = {
    previous: { button: 4 }, // L / LB / L1
    next: { button: 5 }, // R / RB / R1
    toggleAi: { button: 1 }, // Right face button: Micro A / Xbox B / PlayStation Circle.
    toggleAwake: { button: 0 }, // Bottom face button: Micro B / Xbox A / PlayStation Cross.
    showPlayers: { button: 3 }, // Top face button: Micro X / Xbox Y / PlayStation Triangle.
    revealResult: { button: 2 }, // Left face button: Micro Y / Xbox X / PlayStation Square.
    showControls: { button: 8 }, // Minus / Select / Share.
    togglePlayout: { button: 9 }, // Plus / Start / Options.
  };
  // Chromium's unknown-Android mapping uses Android A/B/X/Y key codes.
  // Micro D mode keeps Nintendo labels rather than standard physical positions.
  const MICRO_ANDROID_BINDINGS = {
    previous: { button: 4 },
    next: { button: 5 },
    toggleAi: { button: 0 },
    toggleAwake: { button: 1 },
    showPlayers: { button: 2 },
    revealResult: { button: 3 },
    showControls: { button: 8 },
    togglePlayout: { button: 9 },
  };
  // Reported Micro defaults; edit here if your saved keyboard profile differs.
  // https://github.com/bfalkowski/micro-tester/blob/main/src/mapping.ts
  const KEYBOARD_BINDINGS = {
    KeyL: 'previous', KeyR: 'next', KeyG: 'toggleAi', KeyJ: 'toggleAwake',
    KeyH: 'showPlayers', KeyI: 'revealResult', KeyO: 'togglePlayout',
  };

  // Overrides take precedence over the browser's standard mapping.
  // Match part of the controller ID logged in the browser console. For axis-based D-pads,
  // a binding can instead be { axis: 0, direction: -1 } (or direction: 1).
  const CONTROLLER_OVERRIDES = [
    // {
    //   idIncludes: 'controller name',
    //   bindings: {
    //     previous: { button: 4 },
    //     next: { button: 5 },
    //     toggleAi: { button: 1 },
    //     toggleAwake: { button: 0 },
    //     showPlayers: { button: 3 },
    //     revealResult: { button: 2 },
    //     showControls: { button: 8 },
    //     togglePlayout: { button: 9 },
    //   },
    // },
  ];

  const states = new Map();
  const heldKeys = new Set();
  let frame = null;
  let pending = null;
  let lastPosition = null;

  let notice = null;
  let noticeTimeout = null;

  function notify(message, duration = 4000) {
    if (document.hidden) return;
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'kifubara-gamepad-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = [
        'all:initial', 'position:fixed', 'z-index:2147483647',
        'top:max(12px, env(safe-area-inset-top))', 'left:50%', 'transform:translateX(-50%)',
        'box-sizing:border-box', 'max-width:calc(100vw - 24px)', 'width:max-content',
        'padding:10px', 'border-radius:8px', 'background:#1e1e1e', 'color:#fff',
        'font:14px/1.4 system-ui,sans-serif', 'pointer-events:none',
        'white-space:pre-line', 'overflow-wrap:anywhere',
      ].join(';');
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    if (noticeTimeout !== null) clearTimeout(noticeTimeout);
    noticeTimeout = setTimeout(() => {
      notice.remove();
      notice = null;
      noticeTimeout = null;
    }, duration);
  }

  let awakeWanted = false;
  let wakeLock = null;
  let wakeGeneration = 0;
  let wakeRequestPending = false;
  const wakeSupported = window.isSecureContext && typeof navigator.wakeLock?.request === 'function';

  function renderWakeLock(message) {
    const active = wakeLock && !wakeLock.released;
    const text = `Keep awake ${active ? 'on' : 'off'}: ${message}`;
    report(text);
    notify(text);
  }

  async function updateWakeLock() {
    const generation = ++wakeGeneration;
    wakeRequestPending = false;
    if (!awakeWanted || document.hidden) {
      try {
        if (wakeLock && !wakeLock.released) await wakeLock.release();
        if (generation === wakeGeneration) {
          renderWakeLock(awakeWanted ? 'Paused while tab is hidden.' : 'Screen may sleep normally.');
        }
      } catch (error) {
        console.warn(TAG, 'Could not release screen wake lock', error);
        if (generation === wakeGeneration) {
          awakeWanted = true;
          renderWakeLock(`Could not release wake lock: ${error.message}. Press B to retry.`);
        }
      }
      return;
    }
    if (wakeLock && !wakeLock.released) {
      renderWakeLock('Screen stays awake while this tab is visible.');
      return;
    }
    wakeRequestPending = true;
    renderWakeLock('Requesting screen wake lock...');
    try {
      const lock = await navigator.wakeLock.request('screen');
      // A request can finish after the user turns this off or hides the tab.
      if (generation !== wakeGeneration || !awakeWanted || document.hidden) {
        await lock.release();
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock !== lock) return;
        wakeLock = null;
        renderWakeLock(awakeWanted
          ? 'Wake lock released. Return to this tab or press B to retry.'
          : 'Screen may sleep normally.');
      });
      renderWakeLock(lock.released
        ? 'Wake lock released. Press B to retry.'
        : 'Screen stays awake while this tab is visible.');
    } catch (error) {
      console.warn(TAG, 'Screen wake lock request failed', error);
      if (generation === wakeGeneration) {
        renderWakeLock(`Keep awake failed: ${error.message}. Press B to retry.`);
      }
    } finally {
      if (generation === wakeGeneration) wakeRequestPending = false;
    }
  }

  function toggleAwake() {
    if (!wakeSupported) {
      const message = 'Screen wake lock unavailable in this browser.';
      report(message, new Error('Wake Lock API unavailable'));
      return;
    }
    awakeWanted = !((wakeLock && !wakeLock.released) || wakeRequestPending);
    updateWakeLock();
  }

  document.addEventListener('visibilitychange', () => {
    if (awakeWanted || wakeLock) updateWakeLock();
  });

  function report(message, error) {
    if (error) console.warn(TAG, message, error);
    else console.debug(TAG, message);
    if (error) notify(message);
  }

  function clearPending() {
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending = null;
  }

  function position(viewer) {
    if (lastPosition && lastPosition.viewer === viewer) return lastPosition;
    const move = window.__KIFU_CURRENT_MOVE;
    const totalMoves = window.__KIFU_TOTAL_MOVES;
    return Number.isInteger(move) && Number.isInteger(totalMoves)
      && move >= 0 && totalMoves >= move ? { move, totalMoves } : null;
  }

  const PLAYOUT_MAX_MOVES = 722;
  const PLAYOUT_ANALYSIS_TIMEOUT = 60000;
  const PLAYOUT_MOVE_TIMEOUT = 5000;
  const nodeAnalysis = new Map();
  let review = null;
  let playout = null;

  function stopPlayout(message, error) {
    if (!playout) return;
    clearTimeout(playout.tick);
    clearTimeout(playout.deadline);
    playout = null;
    report(message, error);
    if (!error) notify(message);
  }

  function armPlayoutDeadline(milliseconds, message) {
    const run = playout;
    clearTimeout(run.deadline);
    run.deadline = setTimeout(() => {
      if (playout === run) stopPlayout(message, new Error(message));
    }, milliseconds);
  }

  function schedulePlayout() {
    if (!playout || playout.tick !== null) return;
    playout.tick = setTimeout(() => {
      if (!playout) return;
      playout.tick = null;
      stepPlayout();
    }, 150);
  }

  function readReview(viewer) {
    review = null;
    viewer.dispatchEvent(new CustomEvent('kifubara:reviewping'));
    return review;
  }

  document.addEventListener('kifubara:reviewstate', (event) => {
    const detail = event.detail;
    if (event.target !== document.querySelector('.sgf-viewer') || !detail
      || detail.currentNodeId == null || !Number.isInteger(detail.currentMoveNumber)) return;
    review = { viewer: event.target, ...detail };
    if (!playout || playout.viewer !== event.target) return;
    const run = playout;
    if (run.nodeId === null) {
      run.nodeId = detail.currentNodeId;
      run.moveNumber = detail.currentMoveNumber;
    } else if (run.nodeId !== detail.currentNodeId) {
      const expected = run.awaiting;
      if (!expected || detail.currentMoveNumber !== run.moveNumber + 1
        || (expected.id != null && expected.id !== detail.currentNodeId)) {
        stopPlayout('AI playout stopped: position changed.');
        return;
      }
      run.nodeId = detail.currentNodeId;
      run.moveNumber = detail.currentMoveNumber;
      run.lastMove = expected;
      run.awaiting = null;
      run.moves++;
      armPlayoutDeadline(PLAYOUT_ANALYSIS_TIMEOUT,
        'AI playout stopped: no full analysis arrived within 60 seconds.');
    }
    schedulePlayout();
  }, true);

  document.addEventListener('kifubara:variation', (event) => {
    if (event.target !== document.querySelector('.sgf-viewer')) return;
    // reviewstate's candidate list can lag one render behind navigation.
    // Variation pills, unlike that list, are stamped with node-matched full analysis.
    const current = readReview(event.target);
    if (!current) return;
    if (event.detail === null) {
      nodeAnalysis.set(current.currentNodeId, { viewer: event.target, mainline: true });
    } else {
      const detail = event.detail;
      const index = detail?.currentIdx;
      const pill = Number.isInteger(index) ? detail.variationMoves?.[index] : null;
      if (!pill || detail.branchMove + index + 1 !== current.currentMoveNumber) return;
      nodeAnalysis.set(current.currentNodeId, {
        viewer: event.target, mainline: false, moveNumber: current.currentMoveNumber,
        coord: pill.coord, phase: pill.phase, candidates: pill.candidates,
        score: pill.score_lead,
      });
    }
    schedulePlayout();
  }, true);

  function stepPlayout() {
    const run = playout;
    if (!run) return;
    if (blocked() || document.querySelector('.sgf-viewer') !== run.viewer
      || location.pathname !== run.path) {
      stopPlayout('AI playout stopped: page or focus changed.');
      return;
    }
    const ai = document.querySelector('button[data-kifubara-ai-toggle]');
    if (ai?.getAttribute('aria-pressed') !== 'true') {
      stopPlayout('AI playout stopped: AI is off.');
      return;
    }
    const current = readReview(run.viewer);
    if (playout !== run || !current || run.awaiting) return;
    if (current.regionState?.active || current.regionState?.armed) {
      stopPlayout('AI playout stopped: clear the AI focus/ignore region first.',
        new Error('Playout requires whole-board analysis'));
      return;
    }
    if (run.moves >= PLAYOUT_MAX_MOVES) {
      stopPlayout(`AI playout stopped at ${PLAYOUT_MAX_MOVES}-move safety limit.`,
        new Error('Playout move limit reached'));
      return;
    }
    const analysis = nodeAnalysis.get(run.nodeId);
    const offMainline = document.body.classList.contains('is-off-mainline');
    let coord;
    let score;
    if (analysis?.viewer === run.viewer && !analysis.mainline && offMainline
      && analysis.moveNumber === run.moveNumber && analysis.phase === 'full') {
      if (run.lastMove && String(analysis.coord).toUpperCase() !== run.lastMove.coord) {
        stopPlayout('AI playout stopped: unexpected continuation.',
          new Error('Viewer entered a different move'));
        return;
      }
      coord = analysis.candidates?.[0]?.move;
      score = analysis.score;
    } else if (!offMainline && (!analysis || analysis.mainline)) {
      // Stored row K analyzes turn K-1, so position N uses row N+1.
      // Never use reviewstate.aiCandidates here: it has no freshness stamp.
      if (run.lastMove && run.lastMove.id == null) {
        stopPlayout('AI playout stopped: variation was not confirmed.',
          new Error('Unconfirmed mainline navigation'));
        return;
      }
      const rows = window.__KIFU_ANALYSIS?.moves;
      const row = Array.isArray(rows)
        ? rows.find((entry) => entry.move_number === run.moveNumber + 1) : null;
      coord = row?.top_move;
      score = row?.score_estimate;
    }
    if (typeof coord !== 'string') return;
    coord = coord.trim().toUpperCase();
    if (coord === 'PASS') {
      const estimate = Number.isFinite(score)
        ? ` Estimated ${score > 0 ? `Black +${score.toFixed(1)}`
          : score < 0 ? `White +${Math.abs(score).toFixed(1)}` : 'even'} (AI, not final scoring).`
        : '';
      stopPlayout(`AI playout finished: top move is pass.${estimate}`);
      return;
    }
    if (!/^[A-HJ-Z][1-9][0-9]*$/.test(coord)) {
      stopPlayout('AI playout stopped: invalid AI move.', new Error(`Invalid coordinate: ${coord}`));
      return;
    }
    const child = current.forwardMoves?.find((move) => String(move.coord).toUpperCase() === coord);
    run.awaiting = { coord, id: child?.id ?? null };
    armPlayoutDeadline(PLAYOUT_MOVE_TIMEOUT, 'AI playout stopped: viewer did not confirm move.');
    run.viewer.dispatchEvent(new CustomEvent('kifubara:playCoord', { detail: { coord } }));
  }

  function togglePlayout() {
    if (playout) {
      stopPlayout('AI playout stopped.');
      return;
    }
    const viewer = document.querySelector('.sgf-viewer');
    const ai = document.querySelector('button[data-kifubara-ai-toggle]');
    if (!viewer || !ai || ai.disabled || window.__KIFU_EXPLORE_ENABLED === false
      || window.__KIFU_IS_EDITOR_GAME) {
      report('AI playout unavailable: needs an AI-enabled game review.',
        new Error('Viewer, AI exploration, or review mode unavailable'));
      return;
    }
    if (pending) {
      report('Wait for move navigation before starting AI playout.', new Error('Move still pending'));
      return;
    }
    if (ai.getAttribute('aria-pressed') !== 'true') ai.click();
    if (ai.getAttribute('aria-pressed') !== 'true') {
      report('AI playout unavailable: AI could not be enabled.', new Error('AI remained off'));
      return;
    }
    playout = {
      viewer, path: location.pathname, nodeId: null, moveNumber: null,
      awaiting: null, lastMove: null, moves: 0, tick: null, deadline: null,
    };
    notify('AI playout on. Plus/Start stops; ends at first recommended pass.');
    armPlayoutDeadline(PLAYOUT_ANALYSIS_TIMEOUT,
      'AI playout stopped: no full analysis arrived within 60 seconds.');
    readReview(viewer);
    schedulePlayout();
  }

  document.addEventListener('pointerdown', () => {
    stopPlayout('AI playout stopped: touch/mouse input.');
  }, true);
  document.addEventListener('kifubara:ai-toggle', (event) => {
    if (event.detail?.enabled === false) stopPlayout('AI playout stopped: AI is off.');
  });

  function act(action) {
    if (action === 'showControls') {
      notify([
        'Micro controls (keyboard)',
        'L / R: previous / next move (L / R)',
        'A: toggle AI (G)',
        'B: keep awake (J)',
        'X: show players (H)',
        'Y: reveal result (I)',
        'Plus / Start: toggle AI playout (O)',
        'Minus / Select: show controls (?)',
      ].join('\n'), 12000);
      return;
    }
    if (action === 'togglePlayout') {
      togglePlayout();
      return;
    }
    if (action === 'previous' || action === 'next' || action === 'toggleAi') {
      stopPlayout('AI playout stopped: manual control.');
    }
    if (action === 'toggleAwake') {
      toggleAwake();
      return;
    }
    if (action === 'showPlayers') {
      const metadata = document.querySelector('[data-player-b][data-player-w]');
      const black = document.querySelector('.gd-players .player-chip-black .player-chip-name')
        ?.textContent?.trim() || metadata?.getAttribute('data-player-b')?.trim();
      const white = document.querySelector('.gd-players .player-chip-white .player-chip-name')
        ?.textContent?.trim() || metadata?.getAttribute('data-player-w')?.trim();
      if (!black || !white) {
        report('Player names unavailable.', new Error('Missing Black or White player name'));
        return;
      }
      const blackRank = document.querySelector('.gd-players .player-chip-black .player-chip-rank')
        ?.textContent?.trim();
      const whiteRank = document.querySelector('.gd-players .player-chip-white .player-chip-rank')
        ?.textContent?.trim();
      notify(`Black: ${black}${blackRank ? ` (${blackRank})` : ''}`
        + `\nWhite: ${white}${whiteRank ? ` (${whiteRank})` : ''}`);
      return;
    }
    if (action === 'revealResult') {
      const button = document.querySelector('button[data-kifubara-reveal-score]');
      if (!button || button.disabled) {
        report('Result reveal unavailable.', new Error('Native result reveal is missing or disabled'));
        return;
      }
      button.click();
      return;
    }
    const viewer = document.querySelector('.sgf-viewer');
    if (!viewer) {
      report('Game viewer not ready.', new Error('No .sgf-viewer found'));
      return;
    }
    if (action === 'toggleAi') {
      const button = document.querySelector('button[data-kifubara-ai-toggle]');
      if (!button || button.disabled) {
        report('AI toggle unavailable.', new Error('Native AI toggle is missing or disabled'));
        return;
      }
      button.click();
      const message = `AI ${button.getAttribute('aria-pressed') === 'true' ? 'on' : 'off'}`;
      report(message);
      return;
    }
    const current = position(viewer);
    if (!current) {
      report('Move position not ready.', new Error('No valid move position received'));
      return;
    }
    if (pending && pending.viewer !== viewer) clearPending();
    if (pending) {
      report('Waiting for viewer to confirm move.');
      return;
    }
    const move = Math.max(0, Math.min(current.totalMoves,
      current.move + (action === 'next' ? 1 : -1)));
    if (move === current.move) {
      report(action === 'next' ? 'End of game.' : 'Start of game.');
      return;
    }
    report(`Requesting move ${move}/${current.totalMoves}`);
    pending = {
      viewer,
      move,
      timeout: setTimeout(() => {
        pending = null;
        report('Viewer did not confirm move.', new Error('Move request timed out'));
      }, 2000),
    };
    viewer.dispatchEvent(new CustomEvent('kifubara:gotoMove', {
      detail: { move, scope: 'mainline' },
    }));
  }

  document.addEventListener('kifubara:movechange', (event) => {
    const detail = event.detail;
    if (event.target !== document.querySelector('.sgf-viewer') || !detail
      || !Number.isInteger(detail.move) || !Number.isInteger(detail.totalMoves)
      || detail.move < 0 || detail.totalMoves < detail.move) return;
    lastPosition = { viewer: event.target, move: detail.move, totalMoves: detail.totalMoves };
    if (pending && pending.viewer === event.target && pending.move === detail.move) {
      clearPending();
      report(`Move ${detail.move}/${detail.totalMoves}`);
    }
  });

  function isPressed(gamepad, binding) {
    if ('button' in binding) return Boolean(gamepad.buttons[binding.button]?.pressed);
    return (gamepad.axes[binding.axis] ?? 0) * binding.direction > 0.6;
  }

  function bindingsFor(gamepad) {
    const override = CONTROLLER_OVERRIDES.find((entry) => gamepad.id.includes(entry.idIncludes));
    if (override) return override.bindings;
    if (gamepad.mapping === 'standard') return STANDARD_BINDINGS;
    if (/Android/i.test(navigator.userAgent)
      && /8BitDo Micro gamepad \(Vendor: 2dc8 Product: 9020\)/i.test(gamepad.id)) {
      return MICRO_ANDROID_BINDINGS;
    }
    return null;
  }

  function rawInputs(gamepad) {
    const inputs = [];
    gamepad.buttons.forEach((button, index) => {
      if (button.pressed) inputs.push(`button ${index}`);
    });
    gamepad.axes.forEach((value, index) => {
      if (Math.abs(value) > 0.6) inputs.push(`axis ${index}: ${value.toFixed(2)}`);
    });
    return inputs.join(', ');
  }

  function blocked() {
    return document.hidden || !document.hasFocus()
      || Boolean(document.activeElement?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))
      || Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])'));
  }

  function keyCode(event) {
    return event.code || (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.key);
  }

  window.addEventListener('keydown', (event) => {
    const code = keyCode(event);
    const action = event.key === '?' ? 'showControls' : KEYBOARD_BINDINGS[code];
    if (playout && !action && !event.repeat) {
      stopPlayout('AI playout stopped: keyboard input.');
    }
    if (!action) return;
    const held = heldKeys.has(code);
    heldKeys.add(code);
    if (blocked() || event.ctrlKey || event.altKey || event.metaKey
      || (event.shiftKey && action !== 'showControls') || event.isComposing) return;
    // Micro A sends G, which otherwise opens Kifubara's game-details dialog.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!held && !event.repeat) act(action);
  }, true);
  window.addEventListener('keyup', (event) => heldKeys.delete(keyCode(event)), true);

  function poll() {
    frame = null;
    if (document.hidden) return;
    let gamepads;
    try {
      gamepads = navigator.getGamepads();
    } catch (error) {
      report('Gamepad access blocked; keyboard still available. Reload to retry gamepad.', error);
      return;
    }
    const live = new Set();
    const actions = new Set();
    const ignore = blocked();
    if (ignore) stopPlayout('AI playout stopped: page or focus changed.');
    for (const gamepad of gamepads) {
      if (!gamepad || !gamepad.connected) continue;
      live.add(gamepad.index);
      const bindings = bindingsFor(gamepad);
      const identity = `${gamepad.id}\n${gamepad.mapping}`;
      let state = states.get(gamepad.index);
      const fresh = !state || state.identity !== identity;
      if (fresh) {
        state = { identity, pressed: {}, lastInput: '' };
        states.set(gamepad.index, state);
        if (bindings) report(`Connected: ${gamepad.id} (${gamepad.mapping || 'custom'})`);
        else report(`Unmapped controller: ${gamepad.id}. Add a CONTROLLER_OVERRIDES entry;`
          + ' raw inputs are logged in the browser console.', new Error('Unknown controller layout'));
      }
      if (bindings) {
        for (const [action, binding] of Object.entries(bindings)) {
          const pressed = isPressed(gamepad, binding);
          // Seed on connection/resume so a held button never becomes a new press.
          if (!fresh && !ignore && pressed && !state.pressed[action]) actions.add(action);
          state.pressed[action] = pressed;
        }
      } else {
        const input = rawInputs(gamepad);
        if (input && input !== state.lastInput) report(`${gamepad.id}: ${input}`);
        state.lastInput = input;
      }
    }
    for (const index of states.keys()) {
      if (!live.has(index)) states.delete(index);
    }
    // Opposite directions cancel; simultaneous presses from two pads count once.
    if (actions.has('previous') && actions.has('next')) {
      actions.delete('previous');
      actions.delete('next');
    }
    for (const action of actions) act(action);
    frame = requestAnimationFrame(poll);
  }

  function resume() {
    states.clear();
    if (frame === null && !document.hidden) frame = requestAnimationFrame(poll);
  }

  window.addEventListener('blur', () => {
    stopPlayout('AI playout stopped: page or focus changed.');
    states.clear();
    heldKeys.clear();
  });
  window.addEventListener('focus', resume);
  window.addEventListener('gamepaddisconnected', (event) => {
    states.delete(event.gamepad.index);
    stopPlayout('AI playout stopped: controller disconnected.');
  });
  document.addEventListener('visibilitychange', () => {
    states.clear();
    heldKeys.clear();
    clearPending();
    if (document.hidden) stopPlayout('AI playout stopped: tab hidden.');
    if (document.hidden && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
    if (!document.hidden) resume();
  });

  if (!window.isSecureContext || typeof navigator.getGamepads !== 'function') {
    report('Gamepad API unavailable; keyboard still available. Use HTTPS and a supported browser.',
      new Error('Gamepad API unavailable'));
  } else {
    report('One action per press. Release after connecting or returning to this tab.');
    resume();
  }
})();
