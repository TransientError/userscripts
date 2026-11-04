const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'keep-screen-awake.user.js'), 'utf8');

function harness({ supported = true, secure = true, saved = false, request } = {}) {
  const document = new EventTarget();
  document.hidden = false;
  const window = new EventTarget();
  window.isSecureContext = secure;
  const values = new Map([['always-awake:https://example.com', saved]]);
  const menus = new Map();
  const locks = [];
  let requests = 0;
  let menuId = 0;

  function makeLock() {
    const lock = new EventTarget();
    lock.released = false;
    lock.release = async () => {
      lock.released = true;
      lock.dispatchEvent(new Event('release'));
    };
    locks.push(lock);
    return lock;
  }

  vm.runInNewContext(source, {
    document,
    window,
    location: { origin: 'https://example.com', host: 'example.com' },
    navigator: supported ? {
      wakeLock: {
        request: async (type) => {
          assert.equal(type, 'screen');
          requests++;
          return request ? request(makeLock) : makeLock();
        },
      },
    } : {},
    console: { warn() {} },
    GM_getValue: (key, fallback) => values.get(key) ?? fallback,
    GM_setValue: (key, value) => values.set(key, value),
    GM_registerMenuCommand: (label, callback, options) => {
      const id = ++menuId;
      menus.set(id, { label, callback, options });
      return id;
    },
    GM_unregisterMenuCommand: (id) => menus.delete(id),
  });

  function menu(prefix = 'Keep screen awake:') {
    return [...menus.values()].find((item) => item.label.startsWith(prefix));
  }

  return {
    document, window, locks, values, menu,
    get requests() { return requests; },
    toggle: () => menu().callback(),
    toggleSite: () => menu('Always keep awake').callback(),
    visibility: async (hidden) => {
      document.hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('default off; menu acquires and releases without changing site default', async () => {
  const h = harness();
  assert.equal(h.requests, 0);
  assert.match(h.menu().label, /OFF$/);
  await h.toggle();
  assert.equal(h.requests, 1);
  assert.match(h.menu().label, /ON$/);
  await h.toggle();
  assert.equal(h.locks[0].released, true);
  assert.match(h.menu().label, /OFF$/);
  assert.equal(h.values.get('always-awake:https://example.com'), false);
});

test('site opt-in persists per origin and applies on next visit', async () => {
  const h = harness();
  await h.toggleSite();
  assert.equal(h.values.get('always-awake:https://example.com'), true);
  assert.match(h.menu().label, /ON$/);
  const next = harness({ saved: h.values.get('always-awake:https://example.com') });
  await flush();
  assert.equal(next.requests, 1);
  await h.toggleSite();
  assert.equal(h.values.get('always-awake:https://example.com'), false);
  assert.equal(h.locks[0].released, true);
});

test('hiding releases; returning reacquires only while enabled', async () => {
  const h = harness();
  await h.toggle();
  await h.visibility(true);
  assert.equal(h.locks[0].released, true);
  assert.match(h.menu().label, /paused$/);
  await h.visibility(false);
  assert.equal(h.requests, 2);
  await h.toggle();
  await h.visibility(true);
  await h.visibility(false);
  assert.equal(h.requests, 2);
});

test('turning off during pending acquisition releases late result', async () => {
  let resolve;
  const h = harness({
    request: (makeLock) => new Promise((done) => {
      resolve = () => done(makeLock());
    }),
  });
  const pending = h.toggle();
  await h.toggle();
  resolve();
  await pending;
  assert.equal(h.locks[0].released, true);
  assert.match(h.menu().label, /OFF$/);
});

test('unsupported and insecure contexts remain unavailable without requesting', async () => {
  for (const options of [{ supported: false }, { secure: false }]) {
    const h = harness(options);
    await h.toggle();
    await h.toggleSite();
    assert.equal(h.requests, 0);
    assert.match(h.menu().label, /unavailable/);
  }
});

test('request rejection reports blocked status and retries after returning', async () => {
  let blocked = true;
  const h = harness({
    request: (makeLock) => {
      if (blocked) throw new Error('Denied by policy or battery settings');
      return makeLock();
    },
  });
  await h.toggle();
  assert.match(h.menu().label, /blocked/);
  assert.match(h.menu().options.title, /Denied/);
  blocked = false;
  await h.visibility(true);
  await h.visibility(false);
  assert.match(h.menu().label, /ON$/);
});

test('browser release does not spin retries; page restore reacquires', async () => {
  const h = harness({ saved: true });
  await flush();
  await h.locks[0].release();
  await flush();
  assert.equal(h.requests, 1);
  assert.match(h.menu().label, /browser released/);
  h.window.dispatchEvent(new Event('pagehide'));
  await flush();
  h.window.dispatchEvent(new Event('pageshow'));
  await flush();
  assert.equal(h.requests, 2);
  assert.match(h.menu().label, /ON$/);
});
