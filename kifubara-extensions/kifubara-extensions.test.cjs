const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'kifubara-extensions.user.js'), 'utf8');

function harness(sensitivity = 1, globals = {}) {
  const listeners = new Map();
  const windowListeners = new Map();
  const classes = new Set();
  const keys = [];
  const warnings = [];
  const viewer = {};
  const column = { closest: () => viewer };
  const target = {
    closest(selector) {
      if (selector === '.sgf-viewer-board-col') return this.outside ? null : column;
      return this.editing ? {} : null;
    },
  };
  let focused = true;
  let dialog = false;
  let handled = true;
  let move = 50;
  let clock = 0;
  const document = {
    hidden: false,
    activeElement: null,
    body: { classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    } },
    hasFocus: () => focused,
    querySelector: () => dialog ? {} : null,
    querySelectorAll: () => [],
    documentElement: {},
    addEventListener(type, callback, options) {
      listeners.set(type, { callback, options });
    },
    dispatchEvent(event) {
      if (event.type === 'keydown') {
        keys.push({ key: event.key, fast: classes.has('kifu-nav-fast') });
        if (handled) {
          event.preventDefault();
          move = Math.max(0, Math.min(100, move + (event.key === 'ArrowRight' ? 1 : -1)));
        }
      }
      if (event.type === 'keyup') classes.delete('kifu-nav-fast');
      return !event.defaultPrevented;
    },
  };
  Object.assign(document, globals.document);
  const configuredSource = sensitivity === null ? source
    : source.replace(/const WHEEL_SENSITIVITY = [\d.]+;/, `const WHEEL_SENSITIVITY = ${sensitivity};`);
  vm.runInNewContext(configuredSource, {
    window: { addEventListener: (type, callback) => windowListeners.set(type, callback) },
    console: { warn: (...args) => warnings.push(args) },
    MutationObserver: class { observe() {} },
    KeyboardEvent: class {
      constructor(type, options) { Object.assign(this, { type, defaultPrevented: false }, options); }
      preventDefault() { this.defaultPrevented = true; }
    },
    ...globals,
    document,
  });
  return {
    keys, warnings, classes, document, target, listeners,
    get move() { return move; },
    set move(value) { move = value; },
    set focused(value) { focused = value; },
    set dialog(value) { dialog = value; },
    set handled(value) { handled = value; },
    blur() { windowListeners.get('blur')(); },
    wheel(options = {}) {
      clock += 10;
      const event = {
        target, deltaY: 100, deltaX: 0, deltaMode: 0, timeStamp: clock, cancelable: true,
        defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.propagationStopped = true; },
        ...options,
      };
      listeners.get('wheel').callback(event);
      return event;
    },
  };
}

test('default sensitivity starts on the first notch and reduces sustained move travel by 15%', () => {
  const h = harness(null);
  h.wheel({ deltaY: 100, wheelDeltaY: -120 });
  assert.equal(h.move, 51);
  h.wheel({ deltaY: 100, wheelDeltaY: -120 });
  assert.equal(h.move, 51);
  for (let i = 0; i < 18; i++) h.wheel({ deltaY: 100, wheelDeltaY: -120 });
  assert.equal(h.move, 67);
  h.wheel({ deltaY: -200, wheelDeltaY: 240 });
  assert.equal(h.move, 66);
});

test('default sensitivity starts immediately after pauses, reversals and focus loss', () => {
  const h = harness(null);
  h.wheel({ wheelDeltaY: -120 });
  assert.equal(h.move, 51);
  h.wheel({ wheelDeltaY: -120, timeStamp: 1000 });
  assert.equal(h.move, 52);
  h.wheel({ deltaY: -100, wheelDeltaY: 120, timeStamp: 1010 });
  assert.equal(h.move, 51);
  h.blur();
  h.wheel({ deltaY: -100, wheelDeltaY: 120, timeStamp: 1020 });
  assert.equal(h.move, 50);
});

test('startup credit still requires a full notch of accumulated high-resolution travel', () => {
  const h = harness(null);
  for (let i = 0; i < 3; i++) h.wheel({ deltaY: 10, wheelDeltaY: -30 });
  assert.equal(h.move, 50);
  h.wheel({ deltaY: 10, wheelDeltaY: -30 });
  assert.equal(h.move, 51);
  for (let i = 0; i < 4; i++) h.wheel({ deltaY: 10, wheelDeltaY: -30 });
  assert.equal(h.move, 51);
  h.wheel({ deltaY: 10, wheelDeltaY: -30 });
  assert.equal(h.move, 52);
});

test('at unit sensitivity each notch moves immediately without 120ms suppression', () => {
  const h = harness();
  assert.deepEqual(h.listeners.get('wheel').options.capture, true);
  assert.equal(h.listeners.get('wheel').options.passive, false);
  for (let i = 0; i < 5; i++) {
    const event = h.wheel({ deltaY: 53, wheelDeltaY: -120 });
    assert.equal(h.move, 51 + i);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
  assert.equal(h.keys.every((press) => press.fast), true);
  assert.equal(h.classes.size, 0);
});

test('accelerated events preserve notch count regardless of configured pixel distance', () => {
  const h = harness();
  h.wheel({ deltaY: 159, wheelDeltaY: -360 });
  assert.equal(h.move, 53);
  h.wheel({ deltaY: -240, wheelDeltaY: 240 });
  assert.equal(h.move, 51);
  assert.equal(h.keys.length, 5);
});

test('high-resolution wheel and trackpad deltas accumulate proportionally without per-event rounding', () => {
  const h = harness();
  for (let i = 0; i < 3; i++) h.wheel({ deltaY: 10, wheelDeltaY: -30 });
  assert.equal(h.move, 50);
  h.wheel({ deltaY: 10, wheelDeltaY: -30 });
  assert.equal(h.move, 51);
  h.wheel({ deltaY: 80, wheelDeltaY: -240 });
  assert.equal(h.move, 53);
});

test('pixel, line and page events have explicit units when legacy notch data is absent', () => {
  const h = harness();
  h.wheel({ deltaY: 250 });
  assert.equal(h.move, 52);
  h.wheel({ deltaY: 50 });
  assert.equal(h.move, 53);
  h.wheel({ deltaY: 3, deltaMode: 1 });
  assert.equal(h.move, 54);
  h.wheel({ deltaY: -2, deltaMode: 2 });
  assert.equal(h.move, 52);
});

test('reversal discards opposite residual instead of making reverse feel sticky', () => {
  const h = harness();
  h.wheel({ deltaY: 90 });
  h.wheel({ deltaY: -100 });
  assert.equal(h.move, 49);
  h.wheel({ deltaY: 100 });
  assert.equal(h.move, 50);
});

test('idle gaps, backwards timestamps, focus loss and visibility changes discard partial travel', () => {
  for (const reset of [
    (h) => h.wheel({ deltaY: 20, timeStamp: 1000 }),
    (h) => h.wheel({ deltaY: 20, timeStamp: -1 }),
    (h) => { h.blur(); h.wheel({ deltaY: 20 }); },
    (h) => { h.listeners.get('visibilitychange').callback(); h.wheel({ deltaY: 20 }); },
  ]) {
    const h = harness();
    h.wheel({ deltaY: 90 });
    reset(h);
    assert.equal(h.move, 50);
  }
});

test('zoom/modifiers, horizontal gestures, editing and dialogs bypass native swallowing without navigating', () => {
  for (const options of [
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
    { deltaX: 100 }, { deltaY: 0 }, { deltaY: NaN }, { cancelable: false }, { deltaMode: 3 },
  ]) {
    const h = harness();
    const event = h.wheel(options);
    assert.equal(h.move, 50);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, true);
  }
  for (const configure of [
    (h) => { h.target.editing = true; },
    (h) => { h.document.activeElement = { closest: () => ({}) }; },
    (h) => { h.dialog = true; },
    (h) => { h.document.hidden = true; },
    (h) => { h.focused = false; },
  ]) {
    const h = harness();
    configure(h);
    assert.equal(h.wheel().defaultPrevented, false);
    assert.equal(h.move, 50);
  }
});

test('outside board preserves ordinary page scrolling and clears residual', () => {
  const h = harness();
  h.wheel({ deltaY: 90 });
  h.target.outside = true;
  const event = h.wheel();
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
  h.target.outside = false;
  h.wheel({ deltaY: 20 });
  assert.equal(h.move, 50);
});

test('native navigation clamps boundaries, immediately reverses, and no work is queued after wheel stops', () => {
  const h = harness();
  h.move = 99;
  h.wheel({ deltaY: 500 });
  assert.equal(h.move, 100);
  h.wheel({ deltaY: -100 });
  assert.equal(h.move, 99);
  h.move = 0;
  h.wheel({ deltaY: -300 });
  assert.equal(h.move, 0);
  h.wheel({ deltaY: 100 });
  assert.equal(h.move, 1);
});

test('extreme delta is bounded without banking a delayed backlog; missing native handler warns', () => {
  const h = harness();
  h.wheel({ deltaY: 1000000 });
  assert.equal(h.keys.length, 100);
  h.wheel({ deltaY: -100 });
  assert.equal(h.keys.length, 101);
  const missing = harness();
  missing.handled = false;
  missing.wheel({ deltaY: 500 });
  assert.equal(missing.keys.length, 1);
  assert.equal(missing.warnings.length, 1);
  assert.equal(missing.classes.size, 0);
});

function copyHarness({ clipboardFails = false, fallbackWorks = true } = {}) {
  const downloads = [];
  const requests = [];
  const copied = [];
  const timers = new Map();
  let observer;
  let response = { ok: true, text: async () => ' \n(;GM[1]PB[Black]PW[White];B[pd])\n' };
  let textarea;
  let active;
  let fallbackCalls = 0;
  const originalFocus = { focus() { active = this; } };
  function download(href) {
    return {
      href, className: 'gd-action', nextElementSibling: null,
      after(button) { this.nextElementSibling = button; },
    };
  }
  downloads.push(download('https://kifubara.app/games/first/sgf?r=share'));
  const h = harness(1, {
    navigator: { clipboard: { async writeText(text) {
      if (clipboardFails) throw new Error('Permission denied');
      copied.push(text);
    } } },
    fetch: async (url, options) => {
      requests.push({ url, credentials: options.credentials });
      return response;
    },
    setTimeout(callback) { timers.set(callback, callback); return callback; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
    },
    document: {
      activeElement: originalFocus,
      querySelectorAll(selector) {
        assert.equal(selector, 'a[data-kifubara-sgf-download]');
        return downloads;
      },
      body: { appendChild(element) { textarea = element; element.attached = true; } },
      createElement(tag) {
        const attributes = new Map();
        const handlers = new Map();
        return {
          tag, style: {}, disabled: false,
          setAttribute(name, value) { attributes.set(name, value); },
          getAttribute(name) { return attributes.get(name); },
          matches(selector) { return selector === '[data-kifubara-sgf-copy]' && attributes.has('data-kifubara-sgf-copy'); },
          addEventListener(type, callback) { handlers.set(type, callback); },
          focus() { active = this; },
          select() { this.selected = true; },
          remove() { this.attached = false; },
          click() {
            const event = {
              preventDefault() { this.prevented = true; },
              stopPropagation() { this.stopped = true; },
            };
            const finished = handlers.get('click')(event);
            assert.equal(event.prevented, true);
            assert.equal(event.stopped, true);
            return finished;
          },
        };
      },
      execCommand(command) {
        assert.equal(command, 'copy');
        assert.equal(textarea.selected, true);
        fallbackCalls++;
        if (fallbackWorks) copied.push(textarea.value);
        return fallbackWorks;
      },
    },
  });
  return {
    ...h, downloads, requests, copied,
    get button() { return downloads[0].nextElementSibling; },
    get textarea() { return textarea; },
    get focusRestored() { return active === originalFocus; },
    get fallbackCalls() { return fallbackCalls; },
    set response(value) { response = value; },
    mutate: () => observer(),
    addDownload(href) { const link = download(href); downloads.push(link); observer(); return link; },
    expire() { for (const callback of timers.values()) callback(); timers.clear(); },
  };
}

test('copy button sits beside download, preserves its URL and copies exact SGF as text', async () => {
  const h = copyHarness();
  const button = h.button;
  assert.equal(button.className, 'gd-action');
  assert.equal(button.type, 'button');
  assert.equal(button.getAttribute('aria-label'), 'Copy SGF');
  const finished = button.click();
  assert.equal(button.disabled, true);
  await button.click();
  await finished;
  assert.deepEqual(h.requests, [{
    url: 'https://kifubara.app/games/first/sgf?r=share', credentials: 'include',
  }]);
  assert.deepEqual(h.copied, [' \n(;GM[1]PB[Black]PW[White];B[pd])\n']);
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-label'), 'SGF copied');
  assert.equal(h.downloads[0].href, 'https://kifubara.app/games/first/sgf?r=share');
  h.expire();
  assert.equal(button.getAttribute('aria-label'), 'Copy SGF');
});

test('DOM changes do not duplicate buttons; new and changed download links copy current game', async () => {
  const h = copyHarness();
  const first = h.button;
  h.mutate();
  assert.equal(h.button, first);
  h.downloads[0].href = 'https://kifubara.app/games/updated/sgf';
  await first.click();
  const second = h.addDownload('https://kifubara.app/games/second/sgf');
  await second.nextElementSibling.click();
  assert.deepEqual(h.requests.map(({ url }) => url), [
    'https://kifubara.app/games/updated/sgf', 'https://kifubara.app/games/second/sgf',
  ]);
});

test('HTTP errors, sign-in HTML and empty responses never overwrite clipboard; retry works', async () => {
  for (const response of [
    { ok: false, status: 403 },
    { ok: false, status: 429 },
    { ok: true, text: async () => '<!doctype html><title>Sign in</title>' },
    { ok: true, text: async () => '' },
    { ok: true, text: async () => '{"error":"denied"}' },
  ]) {
    const h = copyHarness();
    h.response = response;
    await h.button.click();
    assert.equal(h.copied.length, 0);
    assert.match(h.button.title, /^Copy failed:/);
    assert.equal(h.button.disabled, false);
    assert.equal(h.warnings.length, 1);
    h.response = { ok: true, text: async () => '(;GM[1])' };
    await h.button.click();
    assert.deepEqual(h.copied, ['(;GM[1])']);
  }
});

test('clipboard rejection falls back to plain text, removes textarea and restores focus', async () => {
  const h = copyHarness({ clipboardFails: true });
  await h.button.click();
  assert.equal(h.fallbackCalls, 1);
  assert.equal(h.copied.length, 1);
  assert.equal(h.textarea.attached, false);
  assert.equal(h.focusRestored, true);
  assert.equal(h.button.title, 'SGF copied');
});

test('denied clipboard fallback reports failure and still cleans up', async () => {
  const h = copyHarness({ clipboardFails: true, fallbackWorks: false });
  await h.button.click();
  assert.equal(h.copied.length, 0);
  assert.equal(h.textarea.attached, false);
  assert.equal(h.focusRestored, true);
  assert.match(h.button.title, /Clipboard access denied/);
  assert.equal(h.button.disabled, false);
});
