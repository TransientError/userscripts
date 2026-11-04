// ==UserScript==
// @name         Kifubara Practice Prototype
// @namespace    https://github.com/TransientError
// @version      0.4
// @description  Guess the next recorded move before revealing Kifubara's game and AI choices.
// @author       TransientError
// @match        https://kifubara.app/games/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[Kifubara Practice]';
  const ANALYSIS_TIMEOUT = 60000;
  const RETURN_TIMEOUT = 5000;
  const LOSS_THRESHOLDS = [12, 6, 3, 1.5, 0.5, 0];
  const LOSS_LABELS = ['≥ 12', '≥ 6', '≥ 3', '≥ 1.5', '≥ 0.5', '< 0.5'];
  const LOSS_COLORS = ['#72216b', '#cc0000', '#e6661a', '#f2f200', '#abe62e', '#1e9600'];

  let viewer = null;
  let enabled = false;
  let practicePath = null;
  let phase = 'off';
  let review = null;
  let attempt = null;
  let timeout = null;
  let generation = 0;
  let savedAiEnabled = null;
  let internalAiToggle = false;
  let statsExpanded = true;
  const gameRecords = new Map();

  function recordsForGame(path = location.pathname) {
    if (!gameRecords.has(path)) gameRecords.set(path, new Map());
    return gameRecords.get(path);
  }

  function classifyLossIndex(pointsLost) {
    let index = 0;
    while (index < LOSS_THRESHOLDS.length - 1 && pointsLost < LOSS_THRESHOLDS[index]) {
      index++;
    }
    return index;
  }

  function buildPracticeReport(records = recordsForGame()) {
    const makePlayer = () => ({
      guesses: 0,
      matched: 0,
      accuracy: null,
      comparableGuesses: 0,
      betterThanGame: 0,
      equivalentToGame: 0,
      worseThanGame: 0,
      totalGameDifference: 0,
      meanGameDifference: null,
      pending: 0,
      unavailable: 0,
      buckets: [0, 0, 0, 0, 0, 0],
    });
    const report = {
      B: makePlayer(), W: makePlayer(), totalGuesses: 0, matched: 0,
      accuracy: null, pending: 0, unavailable: 0,
    };
    for (const record of records.values()) {
      const p = report[record.player];
      if (!p) continue;
      p.guesses++;
      report.totalGuesses++;
      if (record.matched) {
        p.matched++;
        report.matched++;
      }
      if (Number.isFinite(record.deltaRecorded)) {
        p.comparableGuesses++;
        p.totalGameDifference += record.deltaRecorded;
        if (Math.abs(record.deltaRecorded) < 0.05) {
          p.equivalentToGame++;
        } else if (record.deltaRecorded > 0) {
          p.betterThanGame++;
        } else {
          p.worseThanGame++;
          p.buckets[classifyLossIndex(-record.deltaRecorded)]++;
        }
      } else if (record.status === 'pending') {
        p.pending++;
        report.pending++;
      } else {
        p.unavailable++;
        report.unavailable++;
      }
    }
    for (const side of ['B', 'W']) {
      const p = report[side];
      if (p.guesses > 0) p.accuracy = (100 * p.matched) / p.guesses;
      if (p.comparableGuesses > 0) {
        p.meanGameDifference = p.totalGameDifference / p.comparableGuesses;
      }
    }
    if (report.totalGuesses > 0) {
      report.accuracy = (100 * report.matched) / report.totalGuesses;
    }
    return report;
  }

  const style = document.createElement('style');
  style.textContent = `
    body.gtf-expanded #kifubara-practice-panel {
      display: none !important;
    }
    body.kifubara-practice-awaiting .shudan-heat,
    body.kifubara-practice-awaiting .shudan-heatlabel,
    body.kifubara-practice-awaiting .shudan-tip,
    body.kifubara-practice-awaiting .shudan-marker_playedB .shudan-marker,
    body.kifubara-practice-awaiting .shudan-marker_playedW .shudan-marker,
    body.kifubara-practice-awaiting .shudan-ghost_mistakenext .shudan-ghost,
    body.kifubara-practice-awaiting [data-continuations],
    body.kifubara-practice-awaiting [data-gtf-ai-off-note],
    body.kifubara-practice-awaiting .sgf-viewer-variations,
    body.kifubara-practice-awaiting .sgf-viewer-analysis,
    body.kifubara-practice-awaiting [data-kifubara-ai-candidates] {
      visibility: hidden !important;
      pointer-events: none !important;
    }
    #kifubara-practice-panel {
      all: initial;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      gap: 8px;
      width: 100%;
      margin: 8px 0;
      padding: 10px;
      border: 1px solid #666;
      border-radius: 10px;
      background: #1e1e1e;
      color: #fff;
      font: 14px/1.35 system-ui, sans-serif;
      box-shadow: 0 2px 10px rgba(0, 0, 0, .45);
    }
    .kifubara-practice-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      width: 100%;
    }
    #kifubara-practice-panel button {
      min-height: 42px;
      padding: 8px 12px;
      border: 0;
      border-radius: 7px;
      background: #444;
      color: #fff;
      font: 600 14px system-ui, sans-serif;
      touch-action: manipulation;
      cursor: pointer;
    }
    #kifubara-practice-panel button[aria-pressed="true"] {
      background: #357a38;
    }
    #kifubara-practice-stats-toggle {
      margin-left: auto;
      background: #2e2e2e !important;
      border: 1px solid #666 !important;
      font-size: 13px !important;
      padding: 6px 10px !important;
    }
    #kifubara-practice-status {
      flex: 1 1 12em;
      min-width: 10em;
      white-space: pre-line;
      font-size: 13px;
    }
    #kifubara-practice-stats {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-top: 6px;
      border-top: 1px solid #3a3a3a;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    #kifubara-practice-stats[hidden] {
      display: none !important;
    }
    .kp-row {
      display: grid;
      grid-template-columns: minmax(4.2em, 1fr) auto minmax(4.2em, 1fr);
      align-items: center;
      gap: 6px;
      padding: 2px 0;
    }
    .kp-head {
      font-weight: 600;
      color: #ddd;
      padding-bottom: 3px;
      border-bottom: 1px solid #333;
    }
    .kp-divider {
      border-top: 1px solid #333;
      padding-top: 4px;
      margin-top: 2px;
    }
    .kp-left {
      text-align: left;
    }
    .kp-label {
      text-align: center;
      color: #aaa;
    }
    .kp-right {
      text-align: right;
    }
    .kp-buckets {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 4px;
      padding-top: 4px;
      border-top: 1px solid #333;
      text-align: center;
      font-size: 11px;
    }
    .kp-bucket {
      display: flex;
      flex-direction: column;
      padding: 3px 2px;
      border-radius: 5px;
      background: #292929;
    }
    .kp-bucket-label {
      font-weight: 600;
      font-size: 10px;
    }
    .kp-note {
      text-align: center;
      color: #999;
      font-size: 11px;
    }
  `;
  document.head.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'kifubara-practice-panel';
  const topBar = document.createElement('div');
  topBar.className = 'kifubara-practice-bar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Practice';
  toggle.setAttribute('aria-pressed', 'false');
  const status = document.createElement('span');
  status.id = 'kifubara-practice-status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading review…';
  const statsToggle = document.createElement('button');
  statsToggle.type = 'button';
  statsToggle.id = 'kifubara-practice-stats-toggle';
  statsToggle.textContent = 'Stats';
  statsToggle.setAttribute('aria-expanded', 'true');
  topBar.append(toggle, status, statsToggle);

  const statsBox = document.createElement('div');
  statsBox.id = 'kifubara-practice-stats';
  panel.append(topBar, statsBox);

  function fmtPct(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : '–';
  }

  function fmtSignedMean(value) {
    if (!Number.isFinite(value)) return '–';
    const fixed = value.toFixed(2);
    return Number(fixed) === 0 ? '0.00' : Number(fixed) > 0 ? `+${fixed}` : fixed;
  }

  function makeStatRow(label, bVal, wVal, extraClass = '') {
    const row = document.createElement('div');
    row.className = `kp-row${extraClass ? ` ${extraClass}` : ''}`;
    const left = document.createElement('span');
    left.className = 'kp-left';
    left.textContent = String(bVal);
    const mid = document.createElement('span');
    mid.className = 'kp-label';
    mid.textContent = label;
    const right = document.createElement('span');
    right.className = 'kp-right';
    right.textContent = String(wVal);
    row.append(left, mid, right);
    return row;
  }

  function renderStats() {
    statsBox.hidden = !statsExpanded;
    statsToggle.setAttribute('aria-expanded', String(statsExpanded));
    const report = buildPracticeReport();
    statsToggle.textContent = `Stats (${report.totalGuesses})`;
    const { B, W } = report;
    const summary = document.createElement('div');
    summary.className = 'kp-note';
    summary.textContent = report.totalGuesses > 0
      ? `Recorded matches: ${report.matched} / ${report.totalGuesses} (${fmtPct(report.accuracy)})`
      : 'Accuracy counts recorded-move matches';
    const rows = [
      summary,
      makeStatRow('Practice stats', '● Black', '○ White', 'kp-head'),
      makeStatRow('Matched / Guessed', `${B.matched} / ${B.guesses}`, `${W.matched} / ${W.guesses}`),
      makeStatRow('Accuracy', fmtPct(B.accuracy), fmtPct(W.accuracy)),
      makeStatRow(
        'Compared / Guessed',
        `${B.comparableGuesses} / ${B.guesses}`,
        `${W.comparableGuesses} / ${W.guesses}`,
        'kp-divider'
      ),
      makeStatRow(
        'Better than game',
        B.comparableGuesses > 0 ? B.betterThanGame : '–',
        W.comparableGuesses > 0 ? W.betterThanGame : '–'
      ),
      makeStatRow(
        'Equivalent to game',
        B.comparableGuesses > 0 ? B.equivalentToGame : '–',
        W.comparableGuesses > 0 ? W.equivalentToGame : '–'
      ),
      makeStatRow(
        'Worse than game',
        B.comparableGuesses > 0 ? B.worseThanGame : '–',
        W.comparableGuesses > 0 ? W.worseThanGame : '–'
      ),
      makeStatRow('Mean vs game (pts)', fmtSignedMean(B.meanGameDifference), fmtSignedMean(W.meanGameDifference)),
    ];
    if (report.pending > 0) {
      rows.push(makeStatRow('Pending', B.pending, W.pending));
    }
    if (report.unavailable > 0) {
      rows.push(makeStatRow('Unavailable', B.unavailable, W.unavailable));
    }
    const bucketWrap = document.createElement('div');
    bucketWrap.className = 'kp-buckets';
    for (let i = LOSS_LABELS.length - 1; i >= 0; i--) {
      const cell = document.createElement('div');
      cell.className = 'kp-bucket';
      const lbl = document.createElement('span');
      lbl.className = 'kp-bucket-label';
      lbl.style.color = LOSS_COLORS[i];
      lbl.textContent = LOSS_LABELS[i];
      const val = document.createElement('span');
      val.textContent = `${B.buckets[i]}·${W.buckets[i]}`;
      cell.append(lbl, val);
      bucketWrap.appendChild(cell);
    }
    const note = document.createElement('div');
    note.className = 'kp-note';
    note.textContent = report.totalGuesses === 0
      ? 'No guesses yet'
      : 'Loss vs game: worse guesses only (B·W; approximate)';
    statsBox.textContent = '';
    statsBox.append(...rows, bucketWrap, note);
  }

  statsToggle.addEventListener('click', () => {
    statsExpanded = !statsExpanded;
    renderStats();
  });

  function normalizeCoord(value) {
    if (typeof value !== 'string') return null;
    const coord = value.trim().toUpperCase();
    return coord === 'PASS' || /^[A-HJ-Z][1-9][0-9]*$/.test(coord) ? coord : null;
  }

  function clearTimer() {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  }

  function setMask(masked) {
    document.body.classList.toggle('kifubara-practice-awaiting', masked);
  }

  function setTransientAi(aiOn) {
    window.__KIFU_VIEWING_MISTAKE = null;
    window.__KIFU_AI_ENABLED = aiOn;
    document.body.classList.toggle('is-ai-off', !aiOn);
    const ai = document.querySelector('button[data-kifubara-ai-toggle]');
    if (ai) ai.setAttribute('aria-pressed', aiOn ? 'true' : 'false');
    internalAiToggle = true;
    try {
      document.dispatchEvent(new CustomEvent('kifubara:ai-toggle', {
        detail: { enabled: aiOn },
      }));
    } finally {
      internalAiToggle = false;
    }
  }

  function restoreAiState() {
    if (savedAiEnabled !== null) {
      setTransientAi(savedAiEnabled);
    }
    savedAiEnabled = null;
  }

  function report(message, error) {
    if (status.textContent !== message) status.textContent = message;
    if (error) console.warn(TAG, message, error);
    else console.debug(TAG, message);
  }

  function readReview() {
    review = null;
    viewer?.dispatchEvent(new CustomEvent('kifubara:reviewping'));
    return review;
  }

  function candidatesFrom(detail) {
    const candidates = detail.aiCandidates ?? detail.candidates;
    return Array.isArray(candidates) ? candidates.map((candidate) => ({
      coord: normalizeCoord(candidate.move ?? candidate.coord ?? candidate.gtp),
      score: Number.isFinite(candidate.scoreLead) ? candidate.scoreLead
        : Number.isFinite(candidate.score_lead) ? candidate.score_lead : null,
      ptsLoss: Number.isFinite(candidate.ptsLoss) ? candidate.ptsLoss : null,
    })).filter((candidate) => candidate.coord) : [];
  }

  function playerFrom(detail) {
    const value = detail.currentPlayer ?? detail.toPlay ?? detail.player
      ?? detail.aiCandidates?.[0]?.color
      ?? (detail.forwardMoves?.find((move) => move.isTrunk) ?? detail.forwardMoves?.[0])?.color;
    if (typeof value !== 'string') return null;
    const player = value.trim().toUpperCase();
    return player === 'B' || player === 'BLACK' ? 'B'
      : player === 'W' || player === 'WHITE' ? 'W' : null;
  }

  function storedScoresAt(moveNumber) {
    const rows = window.__KIFU_ANALYSIS?.moves;
    if (!Array.isArray(rows) || !Number.isInteger(moveNumber) || moveNumber < 0) {
      return { topMove: null, afterGameScore: null };
    }
    const nextRow = rows.find((entry) => entry.move_number === moveNumber + 1);
    const afterRow = rows.find((entry) => entry.move_number === moveNumber + 2);
    return {
      topMove: normalizeCoord(nextRow?.top_move),
      afterGameScore: Number.isFinite(afterRow?.score_estimate) ? afterRow.score_estimate : null,
    };
  }

  function computeGameDifference(run) {
    if (run.guessCoord === run.recordedCoord) return 0;
    const sign = run.mover === 'B' ? 1 : run.mover === 'W' ? -1 : 0;
    const gameCand = run.candidates.find((c) => c.coord === run.recordedCoord);
    const guessCand = run.candidates.find((c) => c.coord === run.guessCoord);
    const gameScore = Number.isFinite(gameCand?.score) ? gameCand.score : run.gameScore;
    if (sign !== 0 && Number.isFinite(run.guessScore) && Number.isFinite(gameScore)) {
      return (run.guessScore - gameScore) * sign;
    }
    if (Number.isFinite(guessCand?.ptsLoss) && Number.isFinite(gameCand?.ptsLoss)) {
      return guessCand.ptsLoss - gameCand.ptsLoss;
    }
    return null;
  }

  function recordAttempt(run, statusValue) {
    if (!run || !run.mover || !run.parentId || !run.recordedCoord) return;
    const key = `${run.parentId}:${run.recordedId ?? run.recordedCoord}`;
    const deltaRecorded = computeGameDifference(run);
    recordsForGame(run.path).set(key, {
      key,
      parentMove: run.parentMove,
      player: run.mover,
      guessCoord: run.guessCoord,
      recordedCoord: run.recordedCoord,
      matched: run.guessCoord === run.recordedCoord,
      deltaRecorded,
      status: Number.isFinite(deltaRecorded) ? 'ready' : statusValue,
    });
    renderStats();
  }

  function beginAwaiting(detail = readReview()) {
    clearTimer();
    attempt = null;
    if (!enabled || !detail) return;
    const recorded = detail.forwardMoves?.find((move) => move.isTrunk)
      ?? detail.forwardMoves?.[0];
    const coord = normalizeCoord(recorded?.coord);
    const candidates = candidatesFrom(detail);
    const stored = storedScoresAt(detail.currentMoveNumber);
    phase = 'awaiting';
    setMask(true);
    if (!recorded || !coord) {
      renderStats();
      report('Practice on · no recorded next move');
      setTransientAi(false);
      return;
    }
    attempt = {
      generation: ++generation,
      path: location.pathname,
      parentId: detail.currentNodeId,
      parentMove: detail.currentMoveNumber,
      recordedId: recorded.id ?? null,
      recordedCoord: coord,
      mover: playerFrom(detail),
      candidates,
      gameScore: stored.afterGameScore,
      childId: null,
      guessCoord: null,
      guessScore: null,
      aiCoord: candidates[0]?.coord ?? stored.topMove ?? null,
    };
    renderStats();
    report('Practice on · play your move');
    setTransientAi(false);
  }

  function stop(message = 'Practice off') {
    clearTimer();
    enabled = false;
    practicePath = null;
    phase = 'off';
    attempt = null;
    generation++;
    setMask(false);
    restoreAiState();
    toggle.setAttribute('aria-pressed', 'false');
    renderStats();
    report(message);
  }

  function verdict(run) {
    const deltaRecorded = computeGameDifference(run);
    if (!Number.isFinite(deltaRecorded)) {
      const game = run.candidates.find((candidate) => candidate.coord === run.recordedCoord);
      const gameScore = Number.isFinite(game?.score) ? game.score : run.gameScore;
      if (Number.isFinite(run.guessScore) && Number.isFinite(gameScore) && !run.mover) {
        return 'Scores shown from Black perspective';
      }
      return 'Comparison unavailable';
    }
    if (Math.abs(deltaRecorded) < 0.05) return 'Equivalent to game';
    return deltaRecorded > 0 ? `Better than game by ${deltaRecorded.toFixed(1)}`
      : `Worse than game by ${Math.abs(deltaRecorded).toFixed(1)}`;
  }

  function showReveal() {
    const run = attempt;
    if (!enabled || !run || phase !== 'returning') return;
    clearTimer();
    phase = 'revealing';
    setMask(false);
    setTransientAi(true);
    recordAttempt(run, 'unavailable');
    report([
      `You: ${run.guessCoord ?? 'unknown'}${Number.isFinite(run.guessScore)
        ? ` (${run.guessScore.toFixed(1)})` : ' (analysis unavailable)'}`,
      `Game: ${run.recordedCoord}`,
      `AI: ${run.aiCoord ?? 'unavailable'}`,
      verdict(run),
      'Forward follows the recorded game.',
    ].join('\n'));
  }

  function returnForReveal() {
    const run = attempt;
    if (!enabled || !run || phase !== 'analyzing') return;
    clearTimer();
    phase = 'returning';
    timeout = setTimeout(() => {
      if (attempt === run && phase === 'returning') {
        stop('Practice stopped · could not return to the guess position');
      }
    }, RETURN_TIMEOUT);
    viewer.dispatchEvent(new CustomEvent('kifubara:gotoMove', {
      detail: { move: run.parentMove, scope: 'mainline' },
    }));
  }

  toggle.addEventListener('click', () => {
    if (enabled) {
      stop();
      return;
    }
    viewer = document.querySelector('.sgf-viewer');
    const ai = document.querySelector('button[data-kifubara-ai-toggle]');
    if (!viewer || !ai || ai.disabled || window.__KIFU_EXPLORE_ENABLED === false
      || window.__KIFU_IS_EDITOR_GAME) {
      report('Practice unavailable on this page version',
        new Error('Review bridge or AI exploration unavailable'));
      return;
    }
    const current = readReview();
    if (!current || current.currentNodeId == null
      || !Number.isInteger(current.currentMoveNumber)) {
      report('Practice unavailable on this page version',
        new Error('No synchronous review state'));
      return;
    }
    savedAiEnabled = typeof window.__KIFU_AI_ENABLED === 'boolean'
      ? window.__KIFU_AI_ENABLED
      : ai.getAttribute('aria-pressed') === 'true';
    enabled = true;
    practicePath = location.pathname;
    toggle.setAttribute('aria-pressed', 'true');
    document.dispatchEvent(new CustomEvent('kifubara:practice-toggle', {
      detail: { enabled: true },
    }));
    beginAwaiting(current);
  });

  document.addEventListener('kifubara:reviewstate', (event) => {
    if (event.target !== document.querySelector('.sgf-viewer')) return;
    const detail = event.detail;
    if (!detail || detail.currentNodeId == null
      || !Number.isInteger(detail.currentMoveNumber)) return;
    review = detail;
    if (!enabled || location.pathname !== practicePath) return;
    if (!attempt) {
      const recorded = detail.forwardMoves?.find((move) => move.isTrunk)
        ?? detail.forwardMoves?.[0];
      if (phase === 'awaiting' && normalizeCoord(recorded?.coord)) beginAwaiting(detail);
      return;
    }
    const run = attempt;
    if (phase === 'awaiting' && detail.currentNodeId !== run.parentId) {
      if (detail.currentMoveNumber !== run.parentMove + 1) {
        beginAwaiting(detail);
        return;
      }
      if (run.recordedId != null && detail.currentNodeId === run.recordedId) {
        run.guessCoord = run.recordedCoord;
        recordAttempt(run, 'unavailable');
        beginAwaiting(detail);
        return;
      }
      phase = 'analyzing';
      run.childId = detail.currentNodeId;
      recordAttempt(run, 'pending');
      report('Analyzing your move…');
      timeout = setTimeout(() => {
        if (attempt !== run || phase !== 'analyzing') return;
        run.guessScore = null;
        returnForReveal();
      }, ANALYSIS_TIMEOUT);
      setTransientAi(true);
    } else if (phase === 'returning' && detail.currentNodeId === run.parentId) {
      showReveal();
    } else if (phase === 'revealing' && detail.currentNodeId !== run.parentId) {
      beginAwaiting(detail);
    }
  }, true);

  document.addEventListener('kifubara:variation', (event) => {
    if (!enabled || phase !== 'analyzing' || event.target !== viewer || !attempt) return;
    const current = readReview();
    const detail = event.detail;
    const index = detail?.currentIdx;
    const pill = Number.isInteger(index) ? detail.variationMoves?.[index] : null;
    if (!current || current.currentNodeId !== attempt.childId || !pill
      || detail.branchMove + index + 1 !== current.currentMoveNumber
      || pill.phase !== 'full') return;
    attempt.guessCoord = normalizeCoord(pill.coord);
    attempt.guessScore = Number.isFinite(pill.score_lead) ? pill.score_lead : null;
    if (Array.isArray(detail.parentCandidates) && detail.parentCandidates.length) {
      const candidates = candidatesFrom({ aiCandidates: detail.parentCandidates });
      if (candidates.length) {
        attempt.candidates = candidates;
        attempt.aiCoord = candidates[0].coord;
      }
    }
    returnForReveal();
  }, true);

  document.addEventListener('kifubara:ai-toggle', (event) => {
    if (!enabled || internalAiToggle) return;
    if (phase === 'awaiting' && event.detail?.enabled === true) {
      stop('Practice stopped · AI turned on manually');
    } else if ((phase === 'analyzing' || phase === 'revealing') && event.detail?.enabled === false) {
      stop('Practice stopped · AI turned off manually');
    }
  });
  document.addEventListener('kifubara:automation-start', () => {
    if (enabled) stop('Practice stopped · automation started');
  });
  window.addEventListener('popstate', () => {
    if (enabled) stop('Practice stopped · game changed');
  });

  const touchLayout = window.matchMedia?.('(max-width: 1279px)');

  function placeControls() {
    const mobileMoves = touchLayout?.matches
      ? document.querySelector('.gtf-pane[data-pane="moves"]') || document.querySelector('[data-gtf-panes]')
      : null;
    const container = mobileMoves
      || document.querySelector('.gd-panel')
      || document.querySelector('[data-gtf-panes]')
      || document.body;
    if (panel.parentElement !== container) {
      if (mobileMoves && container.firstChild) container.insertBefore(panel, container.firstChild);
      else container.appendChild(panel);
    }
  }

  touchLayout?.addEventListener?.('change', () => {
    if (viewer) placeControls();
  });

  function attachViewer() {
    const found = document.querySelector('.sgf-viewer');
    if (!found) return false;
    viewer = found;
    placeControls();
    renderStats();
    if (!enabled) report('Practice ready');
    return true;
  }

  if (!attachViewer()) {
    const observer = new MutationObserver(() => {
      if (attachViewer()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
