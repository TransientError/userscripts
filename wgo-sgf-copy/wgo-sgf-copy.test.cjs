const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'wgo-sgf-copy.user.js'), 'utf8');

function harness({ streamingUrl, ok = true, status = 200, sgf = '(;SZ[19];B[qd])' } = {}) {
  const menus = new Map();
  const copied = [];
  const requests = [];
  const location = { href: 'https://igo-kifu.com/en/kifu/109477' };
  const element = () => ({
    style: {},
    children: [],
    isConnected: true,
    appendChild(child) { this.children.push(child); },
    addEventListener() {},
    remove() {},
  });
  const root = element();
  vm.runInNewContext(source, {
    location,
    document: {
      documentElement: root,
      createElement: element,
      addEventListener() {},
      querySelectorAll: () => [{ getAttribute: () => sgf }],
    },
    navigator: { clipboard: { writeText: async (text) => copied.push(text) } },
    fetch: async (url) => {
      requests.push(url);
      return {
        ok, status,
        text: async () => JSON.stringify({ props: { pageProps: { initialKifu: { streamingUrl } } } }),
      };
    },
    DOMParser: class {
      parseFromString(text) {
        return { querySelector: () => ({ textContent: text }) };
      }
    },
    URL,
    MutationObserver: class { observe() {} },
    GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
    console: { log() {}, error() {} },
    setTimeout() {},
  });
  return {
    copied, requests, location,
    copyId: () => menus.get('Copy Yike ID to clipboard')(),
    copySgf: () => menus.get('Copy SGF to clipboard')(),
    messages: () => root.children[0].children.slice(2).map((child) => child.textContent),
  };
}

test('copies upstream ID, fetching current route after client navigation', async () => {
  const h = harness({ streamingUrl: 'https://api.yikeweiqi.com/golive/dtl?id=197538' });
  h.location.href = 'https://igo-kifu.com/en/kifu/109478';
  await h.copyId();
  assert.deepEqual(h.requests, [h.location.href]);
  assert.deepEqual(h.copied, ['197538']);
  assert.match(h.messages()[0], /Yike ID copied: 197538/);
});

test('missing, unrelated, or invalid streaming URLs do not overwrite clipboard', async () => {
  for (const streamingUrl of [
    undefined,
    'https://example.com/golive/dtl?id=197538',
    'https://api.yikeweiqi.com/other?id=197538',
    'https://api.yikeweiqi.com/golive/dtl',
    'https://api.yikeweiqi.com/golive/dtl?id=invalid',
    'not a URL',
  ]) {
    const h = harness({ streamingUrl });
    await h.copyId();
    assert.deepEqual(h.copied, []);
    assert.match(h.messages()[0], /Yike ID copy FAILED/);
  }
});

test('failed page fetch reports failure without overwriting clipboard', async () => {
  const h = harness({ ok: false, status: 503 });
  await h.copyId();
  assert.deepEqual(h.copied, []);
  assert.match(h.messages()[0], /503/);
});

test('existing inline SGF copy remains unchanged', async () => {
  const h = harness();
  await h.copySgf();
  assert.deepEqual(h.copied, ['(;SZ[19];B[qd])']);
  assert.deepEqual(h.requests, []);
});
