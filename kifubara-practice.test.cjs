const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'kifubara-practice.user.js'), 'utf8');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
  }
}

class Element extends Target {
  constructor() {
    super();
    this._children = [];
    this.attributes = new Map();
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.parentElement = null;
    this._textContent = '';
    this.style = {};
  }
  get children() { return this._children; }
  get firstChild() { return this._children[0] ?? null; }
  get textContent() { return this._textContent; }
  set textContent(value) {
    this._textContent = String(value);
    if (value === '') {
      for (const child of this._children) child.parentElement = null;
      this._children = [];
    }
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this._children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  insertBefore(child, ref) {
    child.parentElement = this;
    const idx = this._children.indexOf(ref);
    if (idx < 0) this._children.push(child);
    else this._children.splice(idx, 0, child);
    return child;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  click() { this.dispatchEvent({ type: 'click' }); }
}

function harness({ mobile = false } = {}) {
  const document = new Target();
  document.head = new Element();
  document.body = new Element();
  document.documentElement = new Element();
  const classes = new Set();
  document.body.classList = {
    toggle(name, force) {
      if (force) classes.add(name);
      else classes.delete(name);
    },
  };
  document.createElement = () => new Element();
  const viewer = new Element();
  const panel = new Element();
  const movesPane = new Element();
  movesPane.append(new Element());
  const ai = new Element();
  ai.setAttribute('aria-pressed', 'true');
  let state = {
    currentNodeId: 'node-5',
    currentMoveNumber: 5,
    currentPlayer: 'B',
    forwardMoves: [{ id: 'node-6', coord: 'D4', isTrunk: true }],
    aiCandidates: [
      { move: 'Q16', scoreLead: 2.5 },
      { move: 'D4', scoreLead: 1.0 },
    ],
  };
  const positions = new Map([[state.currentMoveNumber, state]]);
  let pingState = null;
  function rememberState(next) {
    if (next.forwardMoves?.length) positions.set(next.currentMoveNumber, next);
  }
  const requests = [];
  viewer.addEventListener('kifubara:reviewping', () => document.dispatchEvent({
    type: 'kifubara:reviewstate', target: viewer, detail: pingState ?? state,
  }));
  viewer.addEventListener('kifubara:gotoMove', (event) => {
    requests.push(event.detail);
    if (positions.has(event.detail.move)) {
      state = positions.get(event.detail.move);
      document.dispatchEvent({ type: 'kifubara:reviewstate', target: viewer, detail: state });
    }
  });
  document.querySelector = (selector) => ({
    '.sgf-viewer': viewer,
    '.gd-panel': panel,
    '.gtf-pane[data-pane="moves"]': mobile ? movesPane : null,
    '[data-gtf-panes]': mobile ? movesPane : null,
    'button[data-kifubara-ai-toggle]': ai,
  })[selector] ?? null;
  const timers = new Map();
  let sequence = 0;
  const prefs = { 'ai-next-move': true };
  const windowObj = {
    __KIFU_EXPLORE_ENABLED: true,
    __KIFU_IS_EDITOR_GAME: false,
    __KIFU_AI_ENABLED: true,
    KIFU_PREFS: prefs,
    matchMedia: () => ({ matches: mobile, addEventListener() {} }),
    addEventListener() {},
  };
  vm.runInNewContext(source, {
    document,
    window: windowObj,
    location: { pathname: '/games/example' },
    console: { debug() {}, warn() {} },
    MutationObserver: class { observe() {} },
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    setTimeout(callback, delay) {
      timers.set(++sequence, { callback, delay });
      return sequence;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const host = mobile ? movesPane : panel;
  const practicePanel = host.children[0];
  const topBar = practicePanel.children[0];
  const statsBox = practicePanel.children[1];
  const toggle = topBar.children[0];
  const status = topBar.children[1];
  const statsToggle = topBar.children[2];
  function statsMap() {
    const out = {};
    for (const row of statsBox.children) {
      if (row.children.length === 3 && row.className.startsWith('kp-row')) {
        out[row.children[1].textContent] = [
          row.children[0].textContent,
          row.children[2].textContent,
        ];
      }
    }
    return out;
  }
  return {
    document, viewer, ai, windowObj, prefs, practicePanel, movesPane,
    toggle, status, statsToggle, statsBox, statsMap, classes, requests, timers,
    setState(next) { state = next; rememberState(next); },
    setPingState(next) { pingState = next; },
    announce(next) {
      state = next;
      rememberState(next);
      document.dispatchEvent({ type: 'kifubara:reviewstate', target: viewer, detail: next });
    },
    variation(detail) {
      document.dispatchEvent({ type: 'kifubara:variation', target: viewer, detail });
    },
  };
}

test('enabling snapshots the recorded continuation and masks spoilers', () => {
  const h = harness();
  h.toggle.click();
  assert.equal(h.toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(h.classes.has('kifubara-practice-awaiting'), true);
  assert.equal(h.classes.has('is-ai-off'), true);
  assert.equal(h.windowObj.__KIFU_AI_ENABLED, false);
  assert.equal(h.prefs['ai-next-move'], true);
  assert.equal(h.ai.getAttribute('aria-pressed'), 'false');
  assert.equal(h.status.textContent, 'Practice on · play your move');
});

test('playing the recorded child immediately starts the next question', () => {
  const h = harness();
  h.toggle.click();
  h.announce({
    currentNodeId: 'node-6',
    currentMoveNumber: 6,
    forwardMoves: [{ id: 'node-7', coord: 'Q16', isTrunk: true }],
    aiCandidates: [],
  });
  assert.equal(h.status.textContent, 'Practice on · play your move');
  assert.equal(h.requests.length, 0);
  assert.equal(h.classes.has('kifubara-practice-awaiting'), true);
});

test('practice resumes when a position without a recorded continuation gets a fresh review state', () => {
  const h = harness();
  h.toggle.click();
  h.announce({
    currentNodeId: 'node-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  assert.equal(h.status.textContent, 'Practice on · no recorded next move');
  h.announce({
    currentNodeId: 'node-6',
    currentMoveNumber: 6,
    forwardMoves: [{ id: 'node-7', coord: 'C3', color: 'W', isTrunk: true }],
    aiCandidates: [],
  });
  assert.equal(h.status.textContent, 'Practice on · play your move');
  h.announce({
    currentNodeId: 'node-7',
    currentMoveNumber: 7,
    forwardMoves: [{ id: 'node-8', coord: 'D16', color: 'B', isTrunk: true }],
    aiCandidates: [],
  });
  assert.deepEqual(h.statsMap()['Matched / Guessed'], ['1 / 1', '1 / 1']);
  assert.equal(h.classes.has('kifubara-practice-awaiting'), true);
});

test('navigation after reveal ignores a stale ping and supports the next guess cycle', () => {
  const h = harness();
  h.toggle.click();
  const firstGuess = {
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  };
  h.announce(firstGuess);
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    variationMoves: [{ coord: 'Q16', phase: 'full', score_lead: 2.5 }],
  });
  assert.match(h.status.textContent, /You: Q16/);
  const next = {
    currentNodeId: 'node-6',
    currentMoveNumber: 6,
    forwardMoves: [{ id: 'node-7', coord: 'C3', color: 'W', isTrunk: true }],
    aiCandidates: [],
  };
  h.setState(next);
  h.setPingState(firstGuess);
  h.document.dispatchEvent({
    type: 'kifubara:movechange', target: h.viewer, detail: { move: 6 },
  });
  h.setPingState(null);
  h.announce(next);
  assert.equal(h.status.textContent, 'Practice on · play your move');
  assert.equal(h.classes.has('kifubara-practice-awaiting'), true);
  h.announce({
    currentNodeId: 'guess-7',
    currentMoveNumber: 7,
    forwardMoves: [],
    aiCandidates: [],
  });
  assert.equal(h.status.textContent, 'Analyzing your move…');
  h.variation({
    branchMove: 6,
    currentIdx: 0,
    variationMoves: [{ coord: 'D16', phase: 'full', score_lead: 1.0 }],
  });
  assert.match(h.status.textContent, /You: D16/);
  assert.deepEqual(h.requests.map((request) => request.move), [5, 6]);
  assert.deepEqual(h.statsMap()['Matched / Guessed'], ['0 / 1', '0 / 1']);
  h.announce({
    currentNodeId: 'node-7',
    currentMoveNumber: 7,
    forwardMoves: [{ id: 'node-8', coord: 'D4', color: 'B', isTrunk: true }],
    aiCandidates: [],
  });
  assert.equal(h.status.textContent, 'Practice on · play your move');
});

test('different child waits for full analysis, returns, and reveals comparison', () => {
  const h = harness();
  h.toggle.click();
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  assert.equal(h.status.textContent, 'Analyzing your move…');
  assert.equal(h.classes.has('kifubara-practice-awaiting'), true);
  assert.equal(h.windowObj.__KIFU_AI_ENABLED, true);
  assert.equal(h.prefs['ai-next-move'], true);
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    variationMoves: [{
      coord: 'Q16',
      phase: 'full',
      score_lead: 2.5,
      candidates: [{ move: 'C3' }],
    }],
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].move, 5);
  assert.equal(h.requests[0].scope, 'mainline');
  assert.equal(h.classes.has('kifubara-practice-awaiting'), false);
  assert.equal(h.windowObj.__KIFU_AI_ENABLED, true);
  assert.equal(h.prefs['ai-next-move'], true);
  assert.match(h.status.textContent, /You: Q16 \(2\.5\)/);
  assert.match(h.status.textContent, /Game: D4/);
  assert.match(h.status.textContent, /Better than game by 1\.5/);
});

test('analysis timeout returns and reports unavailable without inventing a score', () => {
  const h = harness();
  h.toggle.click();
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  const timer = [...h.timers.values()].find(({ delay }) => delay === 60000);
  timer.callback();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].move, 5);
  assert.equal(h.requests[0].scope, 'mainline');
  assert.match(h.status.textContent, /analysis unavailable/);
  assert.match(h.status.textContent, /Comparison unavailable/);
});

test('disabling clears masking and ignores subsequent analysis', () => {
  const h = harness();
  h.toggle.click();
  h.toggle.click();
  assert.equal(h.toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(h.classes.has('kifubara-practice-awaiting'), false);
  assert.equal(h.windowObj.__KIFU_AI_ENABLED, true);
  assert.equal(h.prefs['ai-next-move'], true);
  assert.equal(h.ai.getAttribute('aria-pressed'), 'true');
  h.announce({ currentNodeId: 'guess-6', currentMoveNumber: 6, forwardMoves: [] });
  assert.equal(h.status.textContent, 'Practice off');
  assert.equal(h.requests.length, 0);
});

test('viewer attachment disconnects MutationObserver so status updates cannot loop', () => {
  let hasViewer = false;
  let observer = null;
  let statusWrites = 0;
  const document = new Target();
  document.head = new Element();
  document.body = new Element();
  document.documentElement = new Element();
  document.body.classList = { toggle() {} };
  document.createElement = () => {
    const el = new Element();
    let text = '';
    Object.defineProperty(el, 'textContent', {
      get: () => text,
      set(val) {
        text = val;
        if (el.id === 'kifubara-practice-status') {
          statusWrites++;
          if (observer && !observer.disconnected) observer.callback();
        }
      },
    });
    return el;
  };
  const viewer = new Element();
  const panel = new Element();
  document.querySelector = (selector) => ({
    '.sgf-viewer': hasViewer ? viewer : null,
    '.gd-panel': panel,
  })[selector] ?? null;
  vm.runInNewContext(source, {
    document,
    window: { addEventListener() {} },
    location: { pathname: '/games/example' },
    console: { debug() {}, warn() {} },
    MutationObserver: class {
      constructor(cb) { this.callback = cb; observer = this; }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    CustomEvent: class {},
    setTimeout() {},
    clearTimeout() {},
  });
  assert.equal(observer.disconnected, undefined);
  hasViewer = true;
  observer.callback();
  assert.equal(observer.disconnected, true);
  assert.equal(statusWrites, 2);
});

test('practice stats show recorded matches and game comparisons without AI grading', () => {
  const h = harness({ mobile: true });
  assert.equal(h.movesPane.firstChild, h.practicePanel);
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['0 / 0', '0 / 0']);
  assert.deepEqual(h.statsMap().Accuracy, ['–', '–']);

  h.toggle.click();
  // Guess Q16 (2.5) instead of game D4 (1.0): +1.5 vs game.
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['0 / 1', '0 / 0']);
  assert.deepEqual(h.statsMap().Pending, ['1', '0']);
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    variationMoves: [{
      coord: 'Q16',
      phase: 'full',
      score_lead: 2.5,
      candidates: [{ move: 'C3' }],
    }],
  });
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['1 / 1', '0 / 0']);
  assert.deepEqual(h.statsMap().Accuracy, ['0.0%', '–']);
  for (const label of ['AI quality', 'Mean pt loss', 'Top moves', 'Scored / Guessed']) {
    assert.equal(h.statsMap()[label], undefined);
  }
  assert.deepEqual(h.statsMap()['Better than game'], ['1', '–']);
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['+1.50', '–']);

  // A recorded match is equivalent to the game even if AI dislikes it.
  h.announce({
    currentNodeId: 'node-6',
    currentMoveNumber: 6,
    currentPlayer: 'W',
    forwardMoves: [{ id: 'node-7', coord: 'C3', isTrunk: true }],
    aiCandidates: [
      { coord: 'R4', color: 'W', ptsLoss: 0, isBest: true },
      { coord: 'C3', color: 'W', ptsLoss: -2.0, isBest: false },
    ],
  });
  h.announce({
    currentNodeId: 'node-7',
    currentMoveNumber: 7,
    currentPlayer: 'B',
    forwardMoves: [],
    aiCandidates: [],
  });
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['1 / 1', '1 / 1']);
  assert.deepEqual(h.statsMap().Accuracy, ['0.0%', '100.0%']);
  assert.deepEqual(h.statsMap()['Better than game'], ['1', '0']);
  assert.deepEqual(h.statsMap()['Equivalent to game'], ['0', '1']);
  assert.deepEqual(h.statsMap()['Worse than game'], ['0', '0']);
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['+1.50', '0.00']);
  const buckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
  assert.deepEqual(buckets.children.map((cell) => cell.children[1].textContent), Array(6).fill('0·0'));

  // Collapsing and expanding stats works and persists across Practice toggle
  h.statsToggle.click();
  assert.equal(h.statsBox.hidden, true);
  h.statsToggle.click();
  assert.equal(h.statsBox.hidden, false);
});

test('exact matches are comparable without analysis and missing comparisons are not bucketed', () => {
  const h = harness();
  h.setState({
    currentNodeId: 'node-3',
    currentMoveNumber: 3,
    forwardMoves: [{ id: 'node-4', coord: 'D4', color: 'W', isTrunk: true }],
    aiCandidates: [],
  });
  h.toggle.click();
  h.announce({
    currentNodeId: 'node-4',
    currentMoveNumber: 4,
    forwardMoves: [{ id: 'node-5', coord: 'Q16', color: 'B', isTrunk: true }],
    aiCandidates: [],
  });
  h.announce({
    currentNodeId: 'node-5',
    currentMoveNumber: 5,
    forwardMoves: [{ id: 'node-6', coord: 'D16', color: 'W', isTrunk: true }],
    aiCandidates: [],
  });
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    variationMoves: [{ coord: 'D17', phase: 'full', score_lead: -0.2 }],
  });
  assert.deepEqual(h.statsMap()['Matched / Guessed'], ['1 / 1', '1 / 2']);
  assert.deepEqual(h.statsMap().Accuracy, ['100.0%', '50.0%']);
  assert.equal(h.statsBox.firstChild.textContent, 'Recorded matches: 2 / 3 (66.7%)');
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['1 / 1', '1 / 2']);
  assert.deepEqual(h.statsMap()['Equivalent to game'], ['1', '1']);
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['0.00', '0.00']);
  assert.deepEqual(h.statsMap().Unavailable, ['0', '1']);
  const buckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
  assert.deepEqual(buckets.children.map((cell) => cell.children[1].textContent), Array(6).fill('0·0'));

  h.toggle.click();
  h.windowObj.__KIFU_ANALYSIS = {
    moves: [{ move_number: 7, score_estimate: -0.3 }],
  };
  h.setState({
    currentNodeId: 'node-5',
    currentMoveNumber: 5,
    forwardMoves: [{ id: 'node-6', coord: 'D16', color: 'W', isTrunk: true }],
    aiCandidates: [],
  });
  h.toggle.click();
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    variationMoves: [{ coord: 'D17', phase: 'full', score_lead: -0.2 }],
  });
  assert.equal(h.statsBox.firstChild.textContent, 'Recorded matches: 2 / 3 (66.7%)');
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['1 / 1', '2 / 2']);
  assert.deepEqual(h.statsMap()['Equivalent to game'], ['1', '1']);
  assert.deepEqual(h.statsMap()['Worse than game'], ['0', '1']);
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['0.00', '-0.05']);
  assert.equal(h.statsMap().Unavailable, undefined);
  const updatedBuckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
  assert.deepEqual(
    updatedBuckets.children.map((cell) => cell.children[1].textContent),
    ['0·1', '0·0', '0·0', '0·0', '0·0', '0·0']
  );
});

for (const [player, sign] of [['B', 1], ['W', -1]]) {
  test(`${player}: off-list guesses use the recorded move score, not the AI baseline`, () => {
    const h = harness();
    h.windowObj.__KIFU_ANALYSIS = {
      moves: [
        { move_number: 6, top_move: 'Q16', score_estimate: sign * 2.5 },
        { move_number: 7, score_estimate: sign * 1.0 },
      ],
    };
    const parent = {
      currentNodeId: 'node-5',
      currentMoveNumber: 5,
      forwardMoves: [{ id: 'node-6', coord: 'D4', color: player, isTrunk: true }],
      aiCandidates: [{ coord: 'Q16', color: player, ptsLoss: 0, isBest: true }],
    };
    h.setState(parent);
    h.toggle.click();
    h.announce({
      currentNodeId: 'node-6',
      currentMoveNumber: 6,
      forwardMoves: [],
      aiCandidates: [],
    });
    const values = (value, empty = '–') => player === 'B' ? [value, empty] : [empty, value];
    assert.deepEqual(h.statsMap()['Compared / Guessed'], values('1 / 1', '0 / 0'));
    assert.deepEqual(h.statsMap().Accuracy, values('100.0%'));
    assert.deepEqual(h.statsMap()['Mean vs game (pts)'], values('0.00'));
    let buckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
    assert.deepEqual(buckets.children.map((cell) => cell.children[1].textContent), Array(6).fill('0·0'));

    h.toggle.click();
    h.setState(parent);
    h.toggle.click();
    h.announce({
      currentNodeId: 'guess-6',
      currentMoveNumber: 6,
      forwardMoves: [],
      aiCandidates: [],
    });
    h.variation({
      branchMove: 5,
      currentIdx: 0,
      variationMoves: [{ coord: 'C3', phase: 'full', score_lead: sign * 0.9 }],
    });
    assert.deepEqual(h.statsMap()['Compared / Guessed'], values('1 / 1', '0 / 0'));
    assert.deepEqual(h.statsMap().Accuracy, values('0.0%'));
    assert.deepEqual(h.statsMap()['Mean vs game (pts)'], values('-0.10'));
    assert.deepEqual(h.statsMap()['Equivalent to game'], values('0'));
    assert.deepEqual(h.statsMap()['Worse than game'], values('1'));
    assert.match(h.status.textContent, /Worse than game by 0\.1/);
    buckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
    assert.equal(buckets.children[0].children[1].textContent, player === 'B' ? '1·0' : '0·1');
    assert.equal(buckets.children[2].children[1].textContent, '0·0');
  });
}

test('full parent analysis supplies missing candidates in AI ranking order', () => {
  const h = harness();
  h.setState({
    currentNodeId: 'node-5',
    currentMoveNumber: 5,
    forwardMoves: [{ id: 'node-6', coord: 'D4', color: 'B', isTrunk: true }],
    aiCandidates: [{ coord: 'R4', color: 'B', ptsLoss: 0, isBest: true }],
  });
  h.toggle.click();
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    parentScoreLead: 2.0,
    parentCandidates: [
      { move: 'Q16', scoreLead: 2.5 },
      { move: 'C3', scoreLead: 2.0 },
      { move: 'D4', scoreLead: 1.0 },
    ],
    variationMoves: [{ coord: 'C3', phase: 'full', score_lead: 1.8 }],
  });
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['1 / 1', '0 / 0']);
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['+0.80', '–']);
  assert.match(h.status.textContent, /AI: Q16/);
});

test('a parent AI root score cannot substitute for the recorded move evaluation', () => {
  const h = harness();
  h.setState({
    currentNodeId: 'node-5',
    currentMoveNumber: 5,
    forwardMoves: [{ id: 'node-6', coord: 'D4', color: 'W', isTrunk: true }],
    aiCandidates: [],
  });
  h.toggle.click();
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    parentScoreLead: -2.0,
    variationMoves: [{ coord: 'C3', phase: 'full', score_lead: -1.0 }],
  });
  assert.deepEqual(h.statsMap()['Compared / Guessed'], ['0 / 0', '0 / 1']);
  assert.deepEqual(h.statsMap().Unavailable, ['0', '1']);
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['–', '–']);
  assert.match(h.status.textContent, /Comparison unavailable/);
});

test('relative-only bridge candidates can compare a guess directly to the game', () => {
  const h = harness();
  h.setState({
    currentNodeId: 'node-5',
    currentMoveNumber: 5,
    forwardMoves: [{ id: 'node-6', coord: 'D4', color: 'W', isTrunk: true }],
    aiCandidates: [
      { coord: 'Q16', color: 'W', ptsLoss: 0, isBest: true },
      { coord: 'D4', color: 'W', ptsLoss: -2 },
      { coord: 'C3', color: 'W', ptsLoss: -2.1 },
    ],
  });
  h.toggle.click();
  h.announce({
    currentNodeId: 'guess-6',
    currentMoveNumber: 6,
    forwardMoves: [],
    aiCandidates: [],
  });
  h.variation({
    branchMove: 5,
    currentIdx: 0,
    variationMoves: [{ coord: 'C3', phase: 'full' }],
  });
  assert.deepEqual(h.statsMap()['Mean vs game (pts)'], ['–', '-0.10']);
  assert.deepEqual(h.statsMap()['Worse than game'], ['–', '1']);
  const buckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
  assert.deepEqual(
    buckets.children.map((cell) => cell.children[1].textContent),
    ['0·1', '0·0', '0·0', '0·0', '0·0', '0·0']
  );
});

test('game-relative buckets count only worse guesses at the correct loss thresholds for both colors', () => {
  const cases = [
    { delta: 3, outcome: 'Better than game', bucket: null },
    { delta: 0.04, outcome: 'Equivalent to game', bucket: null },
    { delta: -0.04, outcome: 'Equivalent to game', bucket: null },
    { delta: -0.1, outcome: 'Worse than game', bucket: 0 },
    { delta: -0.5, outcome: 'Worse than game', bucket: 1 },
    { delta: -1.5, outcome: 'Worse than game', bucket: 2 },
    { delta: -3, outcome: 'Worse than game', bucket: 3 },
    { delta: -6, outcome: 'Worse than game', bucket: 4 },
    { delta: -12, outcome: 'Worse than game', bucket: 5 },
  ];
  for (const [player, sign] of [['B', 1], ['W', -1]]) {
    for (const { delta, outcome, bucket } of cases) {
      const h = harness();
      h.setState({
        currentNodeId: 'node-5',
        currentMoveNumber: 5,
        forwardMoves: [{ id: 'node-6', coord: 'D4', color: player, isTrunk: true }],
        aiCandidates: [
          { move: 'Q16', color: player, scoreLead: sign * 100 },
          { move: 'D4', color: player, scoreLead: 0 },
        ],
      });
      h.toggle.click();
      h.announce({
        currentNodeId: 'guess-6',
        currentMoveNumber: 6,
        forwardMoves: [],
        aiCandidates: [],
      });
      h.variation({
        branchMove: 5,
        currentIdx: 0,
        variationMoves: [{ coord: 'C3', phase: 'full', score_lead: delta * sign }],
      });
      const side = player === 'B' ? 0 : 1;
      assert.equal(h.statsMap()[outcome][side], '1', `${player}: ${delta}`);
      const buckets = h.statsBox.children.find((row) => row.className === 'kp-buckets');
      for (let i = 0; i < 6; i++) {
        const expected = i === bucket ? (side === 0 ? '1·0' : '0·1') : '0·0';
        assert.equal(buckets.children[i].children[1].textContent, expected, `${player}: ${delta}, bucket ${i}`);
      }
      assert.equal(h.statsBox.children.at(-1).textContent, 'Loss vs game: worse guesses only (B·W; approximate)');
    }
  }
});
