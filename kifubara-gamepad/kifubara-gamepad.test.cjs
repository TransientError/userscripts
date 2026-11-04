const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'kifubara-gamepad.user.js'), 'utf8');
const autoSource = fs.readFileSync(path.join(__dirname, '..', 'kifubara-auto-advance.user.js'), 'utf8');

class Target {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners.get(event.type) || []) {
      listener(event);
      if (event.immediatePropagationStopped) break;
    }
    return true;
  }
}

class Element extends Target {
  constructor() {
    super();
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.textContent = '';
    this.disabled = false;
  }

  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  after(child) {
    const parent = this.parentElement;
    child.remove();
    child.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
  }
  get valueAsNumber() { return this.value ? Number(this.value) : NaN; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  closest(selector) { return this.editing ? this : this.ancestors?.get(selector) || null; }
  blur() {}
  click() {
    if (!this.disabled) this.dispatchEvent({ type: 'click' });
  }
}

function pad({ index = 0, id = 'Test controller', mapping = 'standard' } = {}) {
  return {
    index, id, mapping, connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })),
    axes: [0, 0],
  };
}

function harness({
  script = source, supported = true, blockedAPI = false, wakeRequest, delayedViewer = false,
  userAgent = 'Desktop browser', touchLayout = true, hasPanelContainers = true,
} = {}) {
  const document = new Target();
  document.documentElement = new Element();
  document.head = new Element();
  document.createElement = () => new Element();
  document.hidden = false;
  document.activeElement = null;
  const bodyClasses = new Set();
  document.body = new Element();
  document.body.classList = {
    contains: (name) => bodyClasses.has(name),
    add: (name) => bodyClasses.add(name),
    remove: (name) => bodyClasses.delete(name),
  };
  let focused = true;
  document.hasFocus = () => focused;
  const viewer = new Element();
  viewer.isConnected = true;
  const board = new Element();
  const panes = new Element();
  const rail = new Element();
  const paneContent = new Element();
  const railContent = new Element();
  panes.append(paneContent);
  rail.append(railContent);
  if (script === autoSource) {
    board.append(viewer);
    document.body.append(board);
    viewer.ancestors = new Map([['.gd-board-wrap', board]]);
  }
  const ai = new Element();
  ai.setAttribute('aria-pressed', 'false');
  let aiClicks = 0;
  ai.addEventListener('click', () => {
    aiClicks++;
    ai.setAttribute('aria-pressed', String(ai.getAttribute('aria-pressed') !== 'true'));
  });
  const blackPlayer = new Element();
  blackPlayer.textContent = 'Nakane Naoyuki';
  const whitePlayer = new Element();
  whitePlayer.textContent = 'Muramoto Wataru';
  const blackRank = new Element();
  blackRank.textContent = '9p';
  const whiteRank = new Element();
  whiteRank.textContent = '5p';
  const metadata = new Element();
  metadata.setAttribute('data-player-b', blackPlayer.textContent);
  metadata.setAttribute('data-player-w', whitePlayer.textContent);
  const reveal = new Element();
  let revealClicks = 0;
  let resultHidden = true;
  reveal.addEventListener('click', () => { revealClicks++; resultHidden = false; });
  let hasPlayerChips = true;
  let hasMetadata = true;
  let hasReveal = true;
  let hasViewer = !delayedViewer;
  let hasAi = true;
  let dialog = false;
  document.querySelector = (selector) => {
    if (selector === '.sgf-viewer') return hasViewer ? viewer : null;
    if (selector === '[data-gtf-panes]') return hasPanelContainers ? panes : null;
    if (selector === '.gd-panel') return hasPanelContainers ? rail : null;
    if (selector === 'button[data-kifubara-ai-toggle]') return hasAi ? ai : null;
    if (selector === '[data-player-b][data-player-w]') return hasMetadata ? metadata : null;
    if (selector === '.gd-players .player-chip-black .player-chip-name') {
      return hasPlayerChips ? blackPlayer : null;
    }
    if (selector === '.gd-players .player-chip-white .player-chip-name') {
      return hasPlayerChips ? whitePlayer : null;
    }
    if (selector === '.gd-players .player-chip-black .player-chip-rank') {
      return hasPlayerChips ? blackRank : null;
    }
    if (selector === '.gd-players .player-chip-white .player-chip-rank') {
      return hasPlayerChips ? whiteRank : null;
    }
    if (selector === 'button[data-kifubara-reveal-score]') return hasReveal ? reveal : null;
    if (selector.startsWith('dialog')) return dialog ? new Element() : null;
    throw new Error(`Unexpected selector: ${selector}`);
  };
  const window = new Target();
  const layoutMedia = new Target();
  layoutMedia.matches = touchLayout;
  window.matchMedia = () => layoutMedia;
  Object.assign(window, { isSecureContext: true, __KIFU_CURRENT_MOVE: 5, __KIFU_TOTAL_MOVES: 10 });
  const location = { pathname: '/games/test-game' };
  const frames = new Map();
  const timers = new Map();
  const intervals = new Map();
  const observers = [];
  const warnings = [];
  const messages = [];
  let sequence = 0;
  let pads = [];
  let confirm = true;
  const moves = [];
  const playRequests = [];
  const reviewState = {
    currentNodeId: 'node-5', currentMoveNumber: 5, forwardMoves: [], regionState: {},
  };
  function emitReview() {
    document.dispatchEvent({
      type: 'kifubara:reviewstate', target: viewer, detail: { ...reviewState },
    });
  }
  viewer.addEventListener('kifubara:reviewping', emitReview);
  viewer.addEventListener('kifubara:playCoord', (event) => playRequests.push(event.detail.coord));
  function announce(move, totalMoves = 10, target = viewer) {
    if (target === viewer) {
      window.__KIFU_CURRENT_MOVE = move;
      window.__KIFU_TOTAL_MOVES = totalMoves;
    }
    document.dispatchEvent({
      type: 'kifubara:movechange', target, detail: { move, totalMoves },
    });
  }
  viewer.addEventListener('kifubara:gotoMove', (event) => {
    moves.push({ ...event.detail });
    if (confirm) announce(event.detail.move);
  });
  vm.runInNewContext(script, {
    document, window, location,
    navigator: {
      userAgent,
      ...(supported ? {
        getGamepads() {
          if (blockedAPI) throw new Error('Permission denied');
          return pads;
        },
      } : {}),
      ...(wakeRequest ? { wakeLock: { request: wakeRequest } } : {}),
    },
    console: {
      warn: (...args) => { warnings.push(args); messages.push(args[1]); },
      debug: (...args) => messages.push(args[1]),
    },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    CustomEvent: class {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    requestAnimationFrame: (callback) => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => { intervals.set(++sequence, { callback, delay }); return sequence; },
    clearInterval: (id) => intervals.delete(id),
  });
  return {
    document, window, viewer, board, panes, rail, paneContent, railContent,
    ai, moves, timers, intervals, observers, warnings, messages,
    set touchLayout(value) {
      layoutMedia.matches = value;
      layoutMedia.dispatchEvent({ type: 'change' });
    },
    location, playRequests, reviewState, emitReview,
    emitVariation(detail) {
      document.dispatchEvent({ type: 'kifubara:variation', target: viewer, detail });
      if (detail === null) bodyClasses.delete('is-off-mainline');
      else bodyClasses.add('is-off-mainline');
    },
    playoutTick() {
      const entry = [...timers].find(([, timer]) => timer.delay === 150);
      if (!entry) return false;
      timers.delete(entry[0]);
      entry[1].callback();
      return true;
    },
    expireTimer(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(id); timer.callback(); }
      }
    },
    blackPlayer, whitePlayer, blackRank, whiteRank, metadata, reveal,
    get revealClicks() { return revealClicks; },
    get resultHidden() { return resultHidden; },
    set hasPlayerChips(value) { hasPlayerChips = value; },
    set hasMetadata(value) { hasMetadata = value; },
    set hasReveal(value) { hasReveal = value; },
    get lastMessage() { return messages.at(-1); },
    get notice() {
      return document.documentElement.children.find((child) => child.id === 'kifubara-gamepad-notice');
    },
    get autoRoot() {
      return [...document.body.children, ...panes.children, ...rail.children]
        .find((child) => child.id === 'kifubara-auto-advance-root');
    },
    toggleAwake() {
      this.key('keydown', 'KeyJ');
      this.key('keyup', 'KeyJ');
    },
    expireNotices() {
      for (const [id, timer] of timers) {
        if (timer.delay === 4000) { timers.delete(id); timer.callback(); }
      }
    },
    get aiClicks() { return aiClicks; },
    set pads(value) { pads = value; },
    set confirm(value) { confirm = value; },
    set hasViewer(value) { hasViewer = value; },
    set hasAi(value) { hasAi = value; },
    set dialog(value) { dialog = value; },
    announce,
    step() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback();
    },
    press(gamepad, button) {
      gamepad.buttons[button].pressed = true;
      this.step();
      gamepad.buttons[button].pressed = false;
      this.step();
    },
    key(type, code, options = {}) {
      const event = {
        type, code, key: code.startsWith('Key') ? code.slice(3).toLowerCase() : code,
        repeat: false, defaultPrevented: false, immediatePropagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.immediatePropagationStopped = true; },
        ...options,
      };
      window.dispatchEvent(event);
      return event;
    },
    focus(value) {
      focused = value;
      window.dispatchEvent({ type: value ? 'focus' : 'blur' });
    },
    hide(value) {
      document.hidden = value;
      document.dispatchEvent({ type: 'visibilitychange' });
    },
  };
}

test('standard L/R navigate mainline once per press; right face toggles native AI', () => {
  const h = harness();
  const p = pad();
  h.pads = [null, p];
  h.step();
  h.press(p, 5);
  assert.deepEqual(h.moves, [{ move: 6, scope: 'mainline' }]);
  assert.equal(h.lastMessage, 'Move 6/10');
  p.buttons[4].pressed = true;
  h.step();
  h.step();
  h.step();
  assert.equal(h.moves.length, 2);
  assert.equal(h.moves[1].move, 5);
  p.buttons[4].pressed = false;
  h.step();
  h.press(p, 4);
  assert.equal(h.moves[2].move, 4);
  p.buttons[1].pressed = true;
  h.step();
  h.step();
  assert.equal(h.aiClicks, 1);
  assert.equal(h.lastMessage, 'AI on');
  assert.equal(h.notice, undefined);
  p.buttons[1].pressed = false;
  h.step();
  h.press(p, 1);
  assert.equal(h.aiClicks, 2);
  assert.equal(h.lastMessage, 'AI off');
  assert.equal(h.notice, undefined);
  h.press(p, 14);
  h.press(p, 15);
  assert.equal(h.moves.length, 3);
  h.expireNotices();
  assert.equal(h.timers.size, 0);
});

test('initial held buttons and reconnects require release before action', () => {
  const h = harness();
  const p = pad();
  p.buttons[5].pressed = true;
  h.pads = [p];
  h.step();
  h.step();
  assert.equal(h.moves.length, 0);
  p.buttons[5].pressed = false;
  h.step();
  h.press(p, 5);
  assert.equal(h.moves.length, 1);
  h.pads = [];
  h.step();
  p.buttons[5].pressed = true;
  h.pads = [p];
  h.step();
  assert.equal(h.moves.length, 1);
});

test('multiple standard controllers work; duplicate and opposing presses do not double act', () => {
  const h = harness();
  const a = pad();
  const b = pad({ index: 1, id: 'Other brand' });
  h.pads = [a, null, b];
  h.step();
  h.press(b, 5);
  h.press(a, 4);
  assert.deepEqual(h.moves.map((move) => move.move), [6, 5]);
  a.buttons[1].pressed = true;
  b.buttons[1].pressed = true;
  h.step();
  assert.equal(h.aiClicks, 1);
  a.buttons[4].pressed = true;
  b.buttons[5].pressed = true;
  h.step();
  assert.equal(h.moves.length, 2);
});

test('Android Micro D mode maps Nintendo face labels through Chromium Android indices', async () => {
  const lock = sentinel();
  const h = harness({ userAgent: 'Mozilla/5.0 (Linux; Android 16) Chrome/140',
    wakeRequest: async () => lock });
  const p = pad({ mapping: '', id: '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9020)' });
  h.pads = [p];
  h.step();
  assert.equal(h.warnings.length, 0);
  h.press(p, 5);
  h.press(p, 4);
  assert.deepEqual(h.moves.map((move) => move.move), [6, 5]);
  h.press(p, 0);
  assert.equal(h.aiClicks, 1);
  h.press(p, 1);
  await settle();
  assert.equal(lock.released, false);
  assert.match(h.notice.textContent, /^Keep awake on:/);
  h.press(p, 2);
  assert.match(h.notice.textContent, /^Black:.*\nWhite:/);
  assert.equal(h.resultHidden, true);
  h.press(p, 3);
  assert.equal(h.revealClicks, 1);
  assert.equal(h.moves.length, 2);
});

test('Micro special mapping is limited to Android unnormalized vendor/product match', () => {
  const id = '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9020)';
  for (const [userAgent, controllerId] of [
    ['Desktop browser', id],
    ['Android', 'Other gamepad (Vendor: 2dc8 Product: 9020)'],
    ['Android', '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9999)'],
  ]) {
    const h = harness({ userAgent });
    const p = pad({ mapping: '', id: controllerId });
    h.pads = [p];
    h.step();
    h.press(p, 0);
    assert.equal(h.aiClicks, 0);
    assert.match(h.warnings[0][1], /Unmapped/);
  }
  const h = harness({ userAgent: 'Android' });
  const p = pad({ id });
  h.pads = [p];
  h.step();
  h.press(p, 1);
  assert.equal(h.aiClicks, 1);
});

test('unknown layouts are inert and expose raw button/axis diagnostics', () => {
  const h = harness();
  const p = pad({ mapping: '', id: '8BitDo Micro' });
  h.pads = [p];
  h.step();
  p.axes[0] = -1;
  h.press(p, 5);
  assert.equal(h.moves.length, 0);
  assert.match(h.warnings[0][1], /Unmapped/);
  assert.match(h.lastMessage, /axis 0: -1.00/);
  p.axes[0] = 0;
  h.press(p, 3);
  assert.match(h.messages.join('\n'), /button 3/);
});

test('fixed controller overrides support button and directional axis bindings', () => {
  const script = source.replace('const CONTROLLER_OVERRIDES = [', `const CONTROLLER_OVERRIDES = [{
    idIncludes: 'Micro',
    bindings: {
      previous: { axis: 0, direction: -1 },
      next: { button: 7 },
      toggleAi: { button: 2 },
    },
  },`);
  const h = harness({ script });
  const p = pad({ mapping: '', id: '8BitDo Micro' });
  h.pads = [p];
  h.step();
  h.press(p, 7);
  p.axes[0] = -0.3;
  h.step();
  assert.equal(h.moves.length, 1);
  p.axes[0] = -1;
  h.step();
  h.step();
  assert.deepEqual(h.moves.map((move) => move.move), [6, 5]);
  h.press(p, 2);
  assert.equal(h.aiClicks, 1);
});

test('start/end boundaries clamp and external move changes update position', () => {
  const h = harness();
  const p = pad();
  h.pads = [p];
  h.step();
  h.announce(0);
  h.press(p, 4);
  assert.equal(h.lastMessage, 'Start of game.');
  h.announce(10);
  h.press(p, 5);
  assert.equal(h.lastMessage, 'End of game.');
  assert.equal(h.moves.length, 0);
  h.announce(2);
  h.press(p, 5);
  assert.equal(h.moves[0].move, 3);
});

test('hidden, unfocused, editing and modal states suppress actions', () => {
  const h = harness();
  const p = pad();
  h.pads = [p];
  h.step();
  h.focus(false);
  h.press(p, 5);
  h.focus(true);
  h.step();
  const input = new Element();
  input.editing = true;
  h.document.activeElement = input;
  h.press(p, 5);
  h.document.activeElement = null;
  h.dialog = true;
  h.press(p, 5);
  h.dialog = false;
  h.hide(true);
  p.buttons[5].pressed = true;
  h.step();
  h.hide(false);
  h.step();
  assert.equal(h.moves.length, 0);
  p.buttons[5].pressed = false;
  h.step();
  assert.equal(h.moves.length, 0);
  h.press(p, 5);
  assert.equal(h.moves.length, 1);
});

test('pending requests block extra navigation, confirm, and report timeouts explicitly', () => {
  const h = harness();
  const p = pad();
  h.pads = [p];
  h.step();
  h.confirm = false;
  h.press(p, 5);
  h.press(p, 5);
  assert.equal(h.moves.length, 1);
  assert.equal(h.timers.size, 1);
  h.announce(6);
  assert.equal(h.timers.size, 0);
  h.press(p, 5);
  const timeout = [...h.timers.values()][0].callback;
  h.timers.clear();
  timeout();
  assert.match(h.notice.textContent, /did not confirm/);
  assert.equal(h.warnings.length, 1);
  h.confirm = true;
  h.press(p, 4);
  assert.equal(h.moves.at(-1).move, 5);
});

test('errors still show notices independently of routine action feedback', () => {
  const h = harness();
  const p = pad();
  h.pads = [p];
  h.step();
  h.hasViewer = false;
  h.press(p, 5);
  assert.equal(h.notice.textContent, 'Game viewer not ready.');
  h.hasViewer = true;
  h.hasAi = false;
  h.press(p, 1);
  assert.equal(h.notice.textContent, 'AI toggle unavailable.');
  assert.equal(h.warnings.length, 2);
  const unsupported = harness({ supported: false });
  assert.match(unsupported.notice.textContent, /API unavailable/);
  const denied = harness({ blockedAPI: true });
  denied.step();
  assert.match(denied.notice.textContent, /Gamepad access blocked/);
  assert.equal(denied.warnings.length, 1);
});

test('Minus/Select shows controls once per press on standard and Android Micro pads', () => {
  for (const android of [false, true]) {
    const h = harness({ userAgent: android ? 'Android' : 'Desktop browser', delayedViewer: true });
    const p = pad(android
      ? { mapping: '', id: '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9020)' } : {});
    h.pads = [p];
    h.step();
    p.buttons[8].pressed = true;
    h.step();
    assert.equal(h.notice.textContent, [
      'Micro controls (keyboard)',
      'L / R: previous / next move (L / R)',
      'A: toggle AI (G)',
      'B: keep awake (J)',
      'X: show players (H)',
      'Y: reveal result (I)',
      'Plus / Start: toggle AI playout (O)',
      'Minus / Select: show controls (?)',
    ].join('\n'));
    h.expireTimer(12000);
    h.step();
    assert.equal(h.notice, undefined);
    p.buttons[8].pressed = false;
    h.step();
    h.press(p, 8);
    assert.match(h.notice.textContent, /B: keep awake/);
    assert.equal(h.aiClicks, 0);
    assert.equal(h.revealClicks, 0);
    assert.equal(h.moves.length, 0);
  }
});

test('question mark shows controls without gamepad API and respects input guards', () => {
  const h = harness({ supported: false, delayedViewer: true });
  h.expireNotices();
  const press = () => h.key('keydown', 'Slash', { key: '?', shiftKey: true });
  const release = () => h.key('keyup', 'Slash', { key: '?', shiftKey: true });
  const input = new Element();
  input.editing = true;
  for (const guard of ['editing', 'dialog', 'hidden', 'focus', 'ctrlKey', 'altKey', 'metaKey', 'isComposing']) {
    h.document.activeElement = guard === 'editing' ? input : null;
    h.dialog = guard === 'dialog';
    h.document.hidden = guard === 'hidden';
    h.focus(guard !== 'focus');
    const event = h.key('keydown', 'Slash', { key: '?', shiftKey: true, [guard]: true });
    assert.equal(event.defaultPrevented, false, guard);
    assert.equal(h.notice, undefined, guard);
    release();
  }
  h.focus(true);
  const event = press();
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediatePropagationStopped, true);
  assert.match(h.notice.textContent, /Y: reveal result/);
  h.expireTimer(12000);
  press();
  assert.equal(h.notice, undefined);
  release();
  press();
  assert.match(h.notice.textContent, /Minus \/ Select: show controls/);
});

test('Micro keyboard defaults work without gamepad API and suppress conflicting native shortcuts', () => {
  const h = harness({ supported: false });
  let nativeKeys = 0;
  h.window.addEventListener('keydown', () => nativeKeys++);
  h.key('keydown', 'KeyR');
  h.key('keydown', 'KeyR', { repeat: true });
  h.key('keydown', 'KeyR');
  assert.deepEqual(h.moves.map((move) => move.move), [6]);
  h.key('keyup', 'KeyR');
  h.key('keydown', 'KeyR');
  h.key('keyup', 'KeyR');
  h.key('keydown', 'KeyL');
  h.key('keyup', 'KeyL');
  assert.deepEqual(h.moves.map((move) => move.move), [6, 7, 6]);
  const aiPress = h.key('keydown', 'KeyG');
  h.key('keydown', 'KeyG', { repeat: true });
  assert.equal(h.aiClicks, 1);
  assert.equal(aiPress.defaultPrevented, true);
  assert.equal(nativeKeys, 0);
  h.key('keyup', 'KeyG');
  h.key('keydown', 'KeyG');
  assert.equal(h.aiClicks, 2);
  h.key('keydown', 'KeyZ');
  assert.equal(nativeKeys, 1);
});

test('keyboard leaves typing, modifiers, composition and dialogs alone', () => {
  const h = harness();
  const input = new Element();
  input.editing = true;
  h.document.activeElement = input;
  assert.equal(h.key('keydown', 'KeyR').defaultPrevented, false);
  h.key('keyup', 'KeyR');
  h.document.activeElement = null;
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing']) {
    assert.equal(h.key('keydown', 'KeyR', { [modifier]: true }).defaultPrevented, false);
    h.key('keyup', 'KeyR');
  }
  h.dialog = true;
  assert.equal(h.key('keydown', 'KeyG').defaultPrevented, false);
  h.key('keyup', 'KeyG');
  h.dialog = false;
  h.focus(false);
  assert.equal(h.key('keydown', 'KeyR').defaultPrevented, false);
  h.focus(true);
  h.key('keydown', 'KeyR', { repeat: true });
  assert.equal(h.moves.length, 0);
  h.key('keyup', 'KeyR');
  h.key('keydown', '', { key: 'r' });
  assert.equal(h.moves.length, 1);
  assert.equal(h.aiClicks, 0);
});

function sentinel() {
  const lock = new Target();
  lock.released = false;
  lock.release = async () => {
    lock.released = true;
    lock.dispatchEvent({ type: 'release' });
  };
  return lock;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('keep awake is opt-in, requests a screen lock, and can be turned off', async () => {
  const requests = [];
  const lock = sentinel();
  const h = harness({ wakeRequest: async (type) => { requests.push(type); return lock; } });
  assert.equal(requests.length, 0);
  assert.equal(h.notice, undefined);
  h.toggleAwake();
  await settle();
  assert.deepEqual(requests, ['screen']);
  assert.match(h.notice.textContent, /^Keep awake on:/);
  assert.equal(lock.released, false);
  h.toggleAwake();
  await settle();
  assert.equal(lock.released, true);
  assert.match(h.notice.textContent, /^Keep awake off:/);
  h.hide(true);
  h.hide(false);
  await settle();
  assert.equal(requests.length, 1);
});

test('keep awake releases on hiding and reacquires on returning without another tap', async () => {
  const locks = [];
  const h = harness({ wakeRequest: async () => {
    const lock = sentinel();
    locks.push(lock);
    return lock;
  } });
  h.toggleAwake();
  await settle();
  h.hide(true);
  await settle();
  assert.equal(locks[0].released, true);
  assert.match(h.lastMessage, /^Keep awake off:/);
  h.hide(false);
  await settle();
  assert.equal(locks.length, 2);
  assert.equal(locks[1].released, false);
  assert.match(h.notice.textContent, /^Keep awake on:/);
});

test('system-released wake lock is visible and manually retryable without a request loop', async () => {
  const locks = [];
  const h = harness({ wakeRequest: async () => {
    const lock = sentinel();
    locks.push(lock);
    return lock;
  } });
  h.toggleAwake();
  await settle();
  await locks[0].release();
  await settle();
  assert.equal(locks.length, 1);
  assert.match(h.notice.textContent, /^Keep awake off:.*released/);
  h.toggleAwake();
  await settle();
  assert.equal(locks.length, 2);
  assert.match(h.notice.textContent, /^Keep awake on:/);
});

test('late wake lock requests are released after cancellation or visibility changes', async () => {
  const requests = [];
  const h = harness({ wakeRequest: () => new Promise((resolve) => requests.push(resolve)) });
  h.toggleAwake();
  h.toggleAwake();
  const cancelled = sentinel();
  requests[0](cancelled);
  await settle();
  assert.equal(cancelled.released, true);
  assert.match(h.notice.textContent, /^Keep awake off:/);
  h.toggleAwake();
  h.hide(true);
  h.hide(false);
  const newest = sentinel();
  requests[2](newest);
  await settle();
  const stale = sentinel();
  requests[1](stale);
  await settle();
  assert.equal(stale.released, true);
  assert.equal(newest.released, false);
  assert.match(h.notice.textContent, /^Keep awake on:/);
});

test('wake lock support, request failures and release failures report actual state', async () => {
  const unsupported = harness();
  unsupported.toggleAwake();
  assert.match(unsupported.notice.textContent, /unavailable/);
  let denied = true;
  const lock = sentinel();
  const h = harness({ wakeRequest: async () => {
    if (denied) throw new Error('Battery saver enabled');
    return lock;
  } });
  h.toggleAwake();
  await settle();
  assert.match(h.notice.textContent, /^Keep awake off:.*Battery saver enabled/);
  assert.equal(h.warnings.length, 1);
  denied = false;
  h.toggleAwake();
  await settle();
  assert.match(h.notice.textContent, /^Keep awake on:/);
  lock.release = async () => { throw new Error('Release denied'); };
  h.toggleAwake();
  await settle();
  assert.match(h.notice.textContent, /^Keep awake on:.*Release denied/);
  assert.equal(h.warnings.length, 2);
  h.key('keydown', 'KeyR');
  assert.equal(h.moves.length, 1);
});

test('Micro B toggles keep awake once per press without requiring a ready viewer', async () => {
  const locks = [];
  const h = harness({ wakeRequest: async () => {
    const lock = sentinel();
    locks.push(lock);
    return lock;
  } });
  const p = pad();
  h.hasViewer = false;
  h.pads = [p];
  h.step();
  p.buttons[0].pressed = true;
  h.step();
  await settle();
  h.step();
  assert.equal(locks.length, 1);
  assert.equal(locks[0].released, false);
  assert.match(h.notice.textContent, /^Keep awake on:/);
  p.buttons[0].pressed = false;
  h.step();
  h.press(p, 0);
  await settle();
  assert.equal(locks[0].released, true);
  assert.match(h.notice.textContent, /^Keep awake off:/);
  assert.equal(h.moves.length, 0);
  assert.equal(h.aiClicks, 0);
});

test('keyboard-mode B sends J and shares wake-lock state with gamepad B', async () => {
  const locks = [];
  const h = harness({ wakeRequest: async () => {
    const lock = sentinel();
    locks.push(lock);
    return lock;
  } });
  const p = pad();
  h.pads = [p];
  h.step();
  const event = h.key('keydown', 'KeyJ');
  await settle();
  assert.equal(event.defaultPrevented, true);
  h.key('keydown', 'KeyJ', { repeat: true });
  await settle();
  assert.equal(locks.length, 1);
  assert.equal(locks[0].released, false);
  h.key('keyup', 'KeyJ');
  h.press(p, 0);
  await settle();
  assert.equal(locks[0].released, true);
  h.key('keydown', 'KeyJ');
  h.key('keyup', 'KeyJ');
  await settle();
  assert.equal(locks.length, 2);
  h.key('keydown', 'KeyJ');
  h.key('keyup', 'KeyJ');
  await settle();
  assert.equal(locks[1].released, true);
  assert.equal(h.aiClicks, 0);
});

test('B reports missing wake-lock support without disturbing navigation', () => {
  const h = harness();
  h.key('keydown', 'KeyJ');
  h.key('keyup', 'KeyJ');
  assert.match(h.notice.textContent, /wake lock unavailable/);
  assert.equal(h.warnings.length, 1);
  h.key('keydown', 'KeyR');
  assert.equal(h.moves[0].move, 6);
});

test('only keep-awake gets routine notices; they do not intercept touch and disappear', async () => {
  const h = harness({ wakeRequest: async () => sentinel() });
  h.step();
  assert.equal(h.document.documentElement.children.length, 0);
  h.key('keydown', 'KeyR');
  h.key('keyup', 'KeyR');
  assert.equal(h.document.documentElement.children.length, 0);
  h.key('keydown', 'KeyL');
  h.key('keyup', 'KeyL');
  assert.equal(h.document.documentElement.children.length, 0);
  h.key('keydown', 'KeyG');
  assert.equal(h.aiClicks, 1);
  assert.equal(h.document.documentElement.children.length, 0);
  h.toggleAwake();
  await settle();
  assert.match(h.notice.textContent, /^Keep awake on:/);
  assert.equal(h.notice.getAttribute('role'), 'status');
  assert.match(h.notice.style.cssText, /pointer-events:none/);
  h.expireNotices();
  assert.equal(h.document.documentElement.children.length, 0);
  assert.equal(h.timers.size, 0);
});

test('Micro X shows Black/White names and ranks, once per press, without revealing result', () => {
  const h = harness();
  const p = pad();
  h.pads = [p];
  h.step();
  p.buttons[3].pressed = true;
  h.step();
  assert.equal(h.notice.textContent, 'Black: Nakane Naoyuki (9p)\nWhite: Muramoto Wataru (5p)');
  assert.match(h.notice.style.cssText, /white-space:pre-line/);
  const timeout = [...h.timers.keys()][0];
  h.step();
  assert.deepEqual([...h.timers.keys()], [timeout]);
  assert.equal(h.revealClicks, 0);
  assert.equal(h.resultHidden, true);
  assert.equal(h.aiClicks, 0);
  assert.equal(h.moves.length, 0);
  h.expireNotices();
  assert.equal(h.notice, undefined);
  p.buttons[3].pressed = false;
  h.step();
  h.press(p, 3);
  assert.equal(h.notice.textContent, 'Black: Nakane Naoyuki (9p)\nWhite: Muramoto Wataru (5p)');
});

test('keyboard H reads fresh player names, supports metadata fallback, and never reveals result', () => {
  const h = harness();
  h.hasViewer = false;
  h.key('keydown', 'KeyH');
  h.key('keyup', 'KeyH');
  assert.equal(h.notice.textContent, 'Black: Nakane Naoyuki (9p)\nWhite: Muramoto Wataru (5p)');
  h.blackPlayer.textContent = '  New Black  ';
  h.whitePlayer.textContent = '  New White  ';
  h.blackRank.textContent = '  7d  ';
  h.whiteRank.textContent = '';
  h.key('keydown', 'KeyH');
  h.key('keyup', 'KeyH');
  assert.equal(h.notice.textContent, 'Black: New Black (7d)\nWhite: New White');
  h.hasPlayerChips = false;
  h.metadata.setAttribute('data-player-b', 'Fallback Black');
  h.metadata.setAttribute('data-player-w', 'Fallback White');
  h.key('keydown', 'KeyH');
  h.key('keyup', 'KeyH');
  assert.equal(h.notice.textContent, 'Black: Fallback Black\nWhite: Fallback White');
  assert.equal(h.resultHidden, true);
  assert.equal(h.revealClicks, 0);
});

test('Micro Y and keyboard I use native result reveal, not a result popup or AI toggle', () => {
  const h = harness();
  const p = pad();
  h.pads = [p];
  h.step();
  p.buttons[2].pressed = true;
  h.step();
  h.step();
  assert.equal(h.revealClicks, 1);
  assert.equal(h.resultHidden, false);
  assert.equal(h.notice, undefined);
  p.buttons[2].pressed = false;
  h.step();
  h.key('keydown', 'KeyI');
  h.key('keydown', 'KeyI', { repeat: true });
  h.key('keyup', 'KeyI');
  assert.equal(h.revealClicks, 2);
  assert.equal(h.resultHidden, false);
  assert.equal(h.aiClicks, 0);
  assert.equal(h.moves.length, 0);
  assert.equal(h.notice, undefined);
});

test('missing player info or result control shows errors rather than guessing or leaking metadata', () => {
  const h = harness();
  h.hasPlayerChips = false;
  h.hasMetadata = false;
  h.key('keydown', 'KeyH');
  h.key('keyup', 'KeyH');
  assert.equal(h.notice.textContent, 'Player names unavailable.');
  assert.equal(h.resultHidden, true);
  h.hasReveal = false;
  h.key('keydown', 'KeyI');
  h.key('keyup', 'KeyI');
  assert.equal(h.notice.textContent, 'Result reveal unavailable.');
  h.hasReveal = true;
  h.reveal.disabled = true;
  h.key('keydown', 'KeyI');
  h.key('keyup', 'KeyI');
  assert.equal(h.revealClicks, 0);
  assert.equal(h.warnings.length, 3);
});

test('player and result shortcuts leave typing, modifiers and dialogs alone', () => {
  const h = harness();
  const input = new Element();
  input.editing = true;
  h.document.activeElement = input;
  for (const code of ['KeyH', 'KeyI']) {
    assert.equal(h.key('keydown', code).defaultPrevented, false);
    h.key('keyup', code);
  }
  h.document.activeElement = null;
  h.dialog = true;
  for (const code of ['KeyH', 'KeyI']) {
    assert.equal(h.key('keydown', code).defaultPrevented, false);
    h.key('keyup', code);
  }
  h.dialog = false;
  for (const code of ['KeyH', 'KeyI']) {
    assert.equal(h.key('keydown', code, { ctrlKey: true }).defaultPrevented, false);
    h.key('keyup', code);
  }
  assert.equal(h.notice, undefined);
  assert.equal(h.resultHidden, true);
  assert.equal(h.revealClicks, 0);
});

function autoControls(h) {
  const [button, intervalLabel, status, wakeStatus] = h.autoRoot.children[0].children;
  return { button, input: intervalLabel.children[0], status, wakeStatus };
}

function playoutHarness(options = {}) {
  const h = harness(options);
  h.window.__KIFU_ANALYSIS = {
    moves: [{ move_number: 6, top_move: 'D4', score_estimate: 2.5 }],
  };
  return h;
}

function variationAt(h, { coord = 'D4', phase = 'full', best = 'Q16', score = 3.5 } = {}) {
  const index = h.reviewState.currentMoveNumber - 6;
  const pills = Array.from({ length: index + 1 }, () => ({}));
  pills[index] = { coord, phase, candidates: [{ move: best }], score_lead: score };
  h.emitVariation({ branchMove: 5, currentIdx: index, variationMoves: pills });
}

function startPlayout(h) {
  h.key('keydown', 'KeyO');
  h.key('keyup', 'KeyO');
  h.playoutTick();
}

test('Plus/Start and O toggle playout once per press on standard and Android Micro pads', () => {
  for (const android of [false, true]) {
    const h = playoutHarness({ userAgent: android ? 'Android' : 'Desktop' });
    const p = pad(android
      ? { id: '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9020)', mapping: '' } : {});
    h.pads = [p];
    h.step();
    p.buttons[9].pressed = true;
    h.step();
    h.playoutTick();
    assert.deepEqual(h.playRequests, ['D4']);
    h.step();
    assert.equal(h.playRequests.length, 1);
    p.buttons[9].pressed = false;
    h.step();
    h.press(p, 9);
    assert.equal(h.notice.textContent, 'AI playout stopped.');
    h.playoutTick();
    assert.equal(h.playRequests.length, 1);
    startPlayout(h);
    assert.equal(h.playRequests.length, 2);
    h.key('keydown', 'KeyO', { repeat: true });
    assert.notEqual(h.notice.textContent, 'AI playout stopped.');
  }
});

test('playout enables AI, uses next stored row, and never uses stale review candidates', () => {
  const h = playoutHarness();
  h.window.__KIFU_ANALYSIS.moves.unshift({ move_number: 5, top_move: 'A1' });
  h.reviewState.aiCandidates = [{ coord: 'T19', isBest: true }];
  assert.equal(h.ai.getAttribute('aria-pressed'), 'false');
  startPlayout(h);
  assert.equal(h.ai.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.playRequests, ['D4']);
  assert.equal(h.moves.length, 0);
  assert.equal(h.revealClicks, 0);
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4']);
});

test('playout waits for move confirmation and node-matched full variation analysis', () => {
  const h = playoutHarness();
  startPlayout(h);
  Object.assign(h.reviewState, { currentNodeId: 'branch-6', currentMoveNumber: 6,
    aiCandidates: [{ coord: 'A1', isBest: true }] });
  h.emitReview();
  variationAt(h, { phase: 'quick', best: 'A1' });
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4']);
  variationAt(h, { phase: 'full', best: 'Q16' });
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4', 'Q16']);
  Object.assign(h.reviewState, { currentNodeId: 'branch-7', currentMoveNumber: 7 });
  h.emitReview();
  h.playoutTick();
  assert.equal(h.playRequests.length, 2);
  variationAt(h, { coord: 'Q16', best: 'pass', score: -4.2 });
  h.playoutTick();
  assert.equal(h.playRequests.length, 2);
  assert.match(h.notice.textContent, /finished: top move is pass.*White \+4.2/);
  assert.match(h.notice.textContent, /not final scoring/);
  assert.equal([...h.timers.values()].some((timer) => timer.delay === 60000), false);
  h.playoutTick();
  assert.equal(h.playRequests.length, 2);
});

test('KaTrain stopping rule stops before first recommended pass, even at starting position', () => {
  const h = playoutHarness();
  h.window.__KIFU_ANALYSIS.moves[0].top_move = 'pass';
  startPlayout(h);
  assert.deepEqual(h.playRequests, []);
  assert.match(h.notice.textContent, /finished: top move is pass.*Black \+2.5/);
});

test('playout can follow a confirmed existing mainline child without treating next row as stale', () => {
  const h = playoutHarness();
  h.reviewState.forwardMoves = [{ id: 'node-6', coord: 'D4', isTrunk: true }];
  h.window.__KIFU_ANALYSIS.moves.push({ move_number: 7, top_move: 'Q16' });
  startPlayout(h);
  Object.assign(h.reviewState, { currentNodeId: 'node-6', currentMoveNumber: 6 });
  h.emitReview();
  h.emitVariation(null);
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4', 'Q16']);
});

test('playout can start inside a fully analyzed variation without consulting mainline suggestions', () => {
  const h = playoutHarness();
  Object.assign(h.reviewState, { currentNodeId: 'existing-branch-6', currentMoveNumber: 6 });
  variationAt(h, { best: 'C3' });
  startPlayout(h);
  assert.deepEqual(h.playRequests, ['C3']);
});

test('stale/incorrect variation position and wrong entered coordinate never advance playout', () => {
  const h = playoutHarness();
  startPlayout(h);
  Object.assign(h.reviewState, { currentNodeId: 'branch-6', currentMoveNumber: 6 });
  h.emitReview();
  h.emitVariation({ branchMove: 5, currentIdx: 1,
    variationMoves: [{}, { coord: 'D4', phase: 'full', candidates: [{ move: 'A1' }] }] });
  h.playoutTick();
  assert.equal(h.playRequests.length, 1);
  variationAt(h, { coord: 'Q4', best: 'A1' });
  h.playoutTick();
  assert.equal(h.playRequests.length, 1);
  assert.match(h.notice.textContent, /unexpected continuation/);
});

test('manual position changes and mismatched existing-child IDs stop rather than redirect playout', () => {
  const h = playoutHarness();
  h.reviewState.forwardMoves = [{ id: 'expected-child', coord: 'D4' }];
  startPlayout(h);
  Object.assign(h.reviewState, { currentNodeId: 'other-child', currentMoveNumber: 6 });
  h.emitReview();
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4']);
  assert.match(h.notice.textContent, /position changed/);
});

test('stop while analyzing prevents delayed AI results from playing another move', () => {
  const h = playoutHarness();
  startPlayout(h);
  Object.assign(h.reviewState, { currentNodeId: 'branch-6', currentMoveNumber: 6 });
  h.emitReview();
  h.key('keydown', 'KeyO');
  h.key('keyup', 'KeyO');
  variationAt(h, { best: 'Q16' });
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4']);
  assert.equal(h.notice.textContent, 'AI playout stopped.');
});

test('playout stops on touch, focus loss, hiding, disconnect, AI-off, and manual navigation', () => {
  for (const interrupt of [
    (h) => h.document.dispatchEvent({ type: 'pointerdown' }),
    (h) => h.focus(false),
    (h) => h.hide(true),
    (h) => h.window.dispatchEvent({ type: 'gamepaddisconnected', gamepad: { index: 0 } }),
    (h) => h.document.dispatchEvent({ type: 'kifubara:ai-toggle', detail: { enabled: false } }),
    (h) => h.key('keydown', 'KeyL'),
    (h) => h.key('keydown', 'ArrowLeft'),
    (h) => { h.location.pathname = '/games/another'; h.playoutTick(); },
  ]) {
    const h = playoutHarness();
    startPlayout(h);
    interrupt(h);
    Object.assign(h.reviewState, { currentNodeId: 'branch-6', currentMoveNumber: 6 });
    h.emitReview();
    variationAt(h);
    h.playoutTick();
    assert.deepEqual(h.playRequests, ['D4']);
    assert.match(h.messages.join('\n'), /AI playout stopped/);
  }
});

test('analysis and move-confirmation timeouts fail visibly without retrying or guessing', () => {
  const h = playoutHarness();
  startPlayout(h);
  h.expireTimer(5000);
  assert.match(h.notice.textContent, /viewer did not confirm move/);
  assert.equal(h.warnings.length, 1);
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4']);
  const missing = playoutHarness();
  missing.window.__KIFU_ANALYSIS.moves = [];
  missing.reviewState.aiCandidates = [{ coord: 'A1', isBest: true }];
  startPlayout(missing);
  missing.expireTimer(60000);
  assert.match(missing.notice.textContent, /no full analysis/);
  assert.deepEqual(missing.playRequests, []);
});

test('unavailable exploration, editor games, AI failure, constrained analysis and invalid coordinates stop safely', () => {
  for (const configure of [
    (h) => { h.window.__KIFU_EXPLORE_ENABLED = false; },
    (h) => { h.window.__KIFU_IS_EDITOR_GAME = true; },
    (h) => { h.ai.disabled = true; },
    (h) => { h.ai.click = () => {}; },
    (h) => { h.reviewState.regionState = { active: 'focus' }; },
    (h) => { h.window.__KIFU_ANALYSIS.moves[0].top_move = 'resign'; },
  ]) {
    const h = playoutHarness();
    configure(h);
    startPlayout(h);
    assert.deepEqual(h.playRequests, []);
    assert.equal(h.warnings.length, 1);
    assert.match(h.notice.textContent, /unavailable|stopped/);
  }
});

test('playout safety cap bounds engine work even when AI never recommends pass', () => {
  const h = playoutHarness({ script: source.replace('const PLAYOUT_MAX_MOVES = 722;',
    'const PLAYOUT_MAX_MOVES = 2;') });
  startPlayout(h);
  Object.assign(h.reviewState, { currentNodeId: 'branch-6', currentMoveNumber: 6 });
  h.emitReview();
  variationAt(h, { best: 'Q16' });
  h.playoutTick();
  Object.assign(h.reviewState, { currentNodeId: 'branch-7', currentMoveNumber: 7 });
  h.emitReview();
  variationAt(h, { coord: 'Q16', best: 'C3' });
  h.playoutTick();
  assert.deepEqual(h.playRequests, ['D4', 'Q16']);
  assert.match(h.notice.textContent, /safety limit/);
});

test('auto-advance controls follow all bottom-panel content in normal scroll flow', () => {
  const h = harness({ script: autoSource });
  assert.deepEqual(h.panes.children, [h.paneContent, h.autoRoot]);
  assert.equal(h.autoRoot.parentElement, h.panes);
  assert.equal(h.viewer.children.length, 0);
  assert.match(h.autoRoot.style.cssText, /display:block/);
  assert.doesNotMatch(h.autoRoot.style.cssText, /position:fixed|position:absolute|position:sticky|z-index/);
  assert.match(h.autoRoot.style.cssText, /width:100%/);
  assert.match(h.autoRoot.style.cssText, /flex-shrink:0/);
  assert.match(h.autoRoot.children[0].style.cssText, /flex-wrap:wrap/);
  assert.equal(autoControls(h).button.disabled, false);
});

test('auto-advance follows desktop rail content and moves between responsive scrollers', () => {
  const h = harness({ script: autoSource, touchLayout: false });
  const root = h.autoRoot;
  assert.deepEqual(h.rail.children, [h.railContent, root]);
  h.touchLayout = true;
  assert.deepEqual(h.panes.children, [h.paneContent, root]);
  assert.deepEqual(h.rail.children, [h.railContent]);
  h.touchLayout = false;
  assert.deepEqual(h.rail.children, [h.railContent, root]);
  assert.deepEqual(h.panes.children, [h.paneContent]);
});

test('auto-advance falls back to document flow when panel containers are absent', () => {
  const h = harness({ script: autoSource, hasPanelContainers: false });
  assert.deepEqual(h.document.body.children, [h.board, h.autoRoot]);
});

test('auto-advance hides through CSS while bottom pane is expanded without changing playback', () => {
  const h = harness({ script: autoSource });
  assert.match(h.document.head.children[0].textContent,
    /body\.gtf-expanded #kifubara-auto-advance-root\s*\{\s*display:\s*none !important;/);
  autoControls(h).button.click();
  h.document.body.classList.add('gtf-expanded');
  assert.equal(h.intervals.size, 1);
  h.document.body.classList.remove('gtf-expanded');
  assert.equal(h.intervals.size, 1);
  assert.equal(autoControls(h).button.textContent, 'Pause');
});

test('auto-advance waits for a late viewer before inserting controls', () => {
  const h = harness({ script: autoSource, delayedViewer: true });
  assert.equal(h.autoRoot, undefined);
  assert.equal(h.document.body.children.length, 1);
  h.hasViewer = true;
  h.observers[0].callback();
  assert.equal(h.observers[0].disconnected, true);
  assert.equal(h.panes.children.at(-1), h.autoRoot);
});

test('auto-advance acquires wake lock only while playing and releases on pause', async () => {
  const types = [];
  const lock = sentinel();
  const h = harness({
    script: autoSource, wakeRequest: async (type) => { types.push(type); return lock; },
  });
  const { button, wakeStatus } = autoControls(h);
  assert.equal(types.length, 0);
  assert.equal(wakeStatus.textContent, '');
  button.click();
  await settle();
  assert.deepEqual(types, ['screen']);
  assert.equal(wakeStatus.textContent, 'Screen awake');
  assert.equal(h.intervals.size, 1);
  button.click();
  await settle();
  assert.equal(lock.released, true);
  assert.equal(h.intervals.size, 0);
  assert.equal(wakeStatus.textContent, '');
  assert.equal(button.textContent, 'Start');
});

test('auto-advance still advances at configured interval and releases wake lock at game end', async () => {
  const lock = sentinel();
  const h = harness({ script: autoSource, wakeRequest: async () => lock });
  const { button, input, status } = autoControls(h);
  input.value = '1.5';
  input.dispatchEvent({ type: 'change' });
  button.click();
  await settle();
  assert.equal([...h.intervals.values()][0].delay, 1500);
  for (let count = 0; count < 5; count++) {
    for (const interval of [...h.intervals.values()]) interval.callback();
  }
  await settle();
  assert.deepEqual(h.moves.map((move) => move.move), [6, 7, 8, 9, 10]);
  assert.equal(h.intervals.size, 0);
  assert.equal(lock.released, true);
  assert.equal(status.textContent, 'Finished');
  assert.equal(button.textContent, 'Replay');
});

test('auto-advance reacquires on visibility return, but not after pausing', async () => {
  const locks = [];
  const h = harness({ script: autoSource, wakeRequest: async () => {
    const lock = sentinel();
    locks.push(lock);
    return lock;
  } });
  const { button, wakeStatus } = autoControls(h);
  button.click();
  await settle();
  h.hide(true);
  await settle();
  assert.equal(locks[0].released, true);
  assert.equal(wakeStatus.textContent, 'Awake paused');
  h.hide(false);
  await settle();
  assert.equal(locks.length, 2);
  assert.equal(wakeStatus.textContent, 'Screen awake');
  await locks[1].release();
  assert.equal(wakeStatus.textContent, 'Wake lock released');
  assert.equal(locks.length, 2);
  button.click();
  h.hide(true);
  h.hide(false);
  await settle();
  assert.equal(locks.length, 2);
});

test('auto-advance discards late wake-lock requests after pause or a newer playback request', async () => {
  const requests = [];
  const h = harness({
    script: autoSource, wakeRequest: () => new Promise((resolve) => requests.push(resolve)),
  });
  const { button, wakeStatus } = autoControls(h);
  button.click();
  button.click();
  button.click();
  const current = sentinel();
  requests[1](current);
  await settle();
  const stale = sentinel();
  requests[0](stale);
  await settle();
  assert.equal(stale.released, true);
  assert.equal(current.released, false);
  assert.equal(wakeStatus.textContent, 'Screen awake');
  button.click();
  await settle();
  assert.equal(current.released, true);
});

test('auto-advance surfaces unavailable or rejected wake locks without stopping playback', async () => {
  const unsupported = harness({ script: autoSource });
  const unsupportedControls = autoControls(unsupported);
  unsupportedControls.button.click();
  await settle();
  assert.equal(unsupported.intervals.size, 1);
  assert.equal(unsupportedControls.wakeStatus.textContent, 'Keep awake unavailable');
  assert.equal(unsupported.warnings.length, 1);
  const h = harness({ script: autoSource, wakeRequest: async () => {
    throw new Error('Battery saver enabled');
  } });
  const { button, wakeStatus } = autoControls(h);
  button.click();
  await settle();
  assert.equal(h.intervals.size, 1);
  assert.equal(wakeStatus.textContent, 'Keep awake failed');
  assert.equal(wakeStatus.title, 'Battery saver enabled');
  assert.equal(h.warnings.length, 1);
});
