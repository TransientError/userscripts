const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, 'kifubara-sabaki.user.js'), 'utf8');
const PAIR = {
  version: 1,
  endpoint: 'http://127.0.0.1:49152/v1/browser-sgf',
  token: 'test-only-secret-'.padEnd(64, 'x'),
};
const ALERT_PAIR = {
  version: 1,
  endpoint: 'http://127.0.0.1:49153/v1/browser-sgf',
  token: 'alerts-only-test-secret-'.padEnd(64, 'y'),
};

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatchEvent(event) {
    event.target ??= this;
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    return true;
  }
}

class Element extends Target {
  constructor(tag = '') {
    super();
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.textContent = '';
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  remove() { this.removed = true; }
}

function harness({ blocked = false, wrappedWindow = false, nullSource = false, verbose = true } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const menus = new Map();
  const requests = [];
  const alerts = [];
  const prompts = [];
  const clipboard = [];
  const bridge = [];
  const page = new Target();
  const isolated = new Target();
  const document = new Target();
  document.defaultView = isolated;
  class CustomEvent {
    constructor(type, options) { this.type = type; this.detail = options.detail; }
  }
  document.addEventListener('kifubara-sabaki-capture-v1', (event) => {
    bridge.push(JSON.parse(event.detail));
  });
  document.documentElement = new Element('html');
  document.createElement = (tag) => new Element(tag);
  const location = { origin: 'https://kifubara.app', href: 'https://kifubara.app/play/fox' };
  class Socket extends Target {
    static OPEN = 1;
    constructor(url, protocols) {
      super();
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this.sent = [];
    }
    send(value) {
      if (this.readyState !== 1) throw new Error('Socket not open');
      this.sent.push(value);
    }
    open() { this.readyState = 1; this.dispatchEvent({ type: 'open' }); }
    receive(value) {
      const data = typeof value === 'string' ? value : JSON.stringify(value);
      this.dispatchEvent({ type: 'message', data });
    }
    close() { this.readyState = 3; this.dispatchEvent({ type: 'close' }); }
  }
  const setTimeout = (callback, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  page.WebSocket = Socket;
  isolated.prompt = () => prompts.shift() ?? null;
  isolated.alert = (text) => alerts.push(text);
  page.postMessage = (data, origin) => {
    bridge.push(data);
    isolated.dispatchEvent({ type: 'message', source: nullSource ? null : isolated, origin, data });
  };
  const pageContext = vm.createContext({
    window: page, document, CustomEvent, location, URL, console, JSON, Reflect, Proxy,
    setTimeout, clearTimeout, Date: { now: () => now },
  });
  const context = {
    window: wrappedWindow ? new Proxy(isolated, {}) : isolated,
    document, CustomEvent, location, URL, TextEncoder,
    crypto: webcrypto, console, setTimeout, clearTimeout,
    GM_registerMenuCommand: (label, callback) => menus.set(label, callback),
    GM_setClipboard: (text, type) => clipboard.push({ text, type }),
    GM_addElement: (parent, tag, attributes) => {
      const element = new Element(tag);
      if (!blocked) vm.runInContext(attributes.textContent, pageContext);
      return element;
    },
    GM_xmlhttpRequest: (options) => {
      const request = {
        ...options,
        body: JSON.parse(options.data),
        aborted: false,
        reply(status = 200, value = {}) {
          this.responded = true;
          options.onload?.({
            status,
            responseText: JSON.stringify({
              ok: true, state: 'current', acceptedSequence: null,
              moveCount: null, message: 'Waiting', needsSnapshot: false, ...value,
            }),
          });
        },
        fail() { this.responded = true; options.onerror({}); },
      };
      requests.push(request);
      return { abort() { request.aborted = true; } };
    },
  };
  vm.runInNewContext(source, context);
  const elements = (element, visible = false) => {
    if (visible && element.hidden) return [];
    return [element, ...element.children.flatMap((child) => elements(child, visible))];
  };
  const button = (label) => elements(document.documentElement)
    .find((element) => element.tagName === 'button' && element.textContent === label);
  if (verbose) button('Details')?.dispatchEvent({ type: 'click' });
  const menu = (prefix) => {
    const match = [...menus.entries()].find(([name]) => name.startsWith(prefix));
    assert.ok(match, `Missing menu: ${prefix}`);
    return match[1]();
  };
  function tick(ms) {
    const until = now + ms;
    let safety = 0;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++safety < 1000, 'timer loop');
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  }
  function socket(url = 'wss://kifu-fox-bridge.groovy-art.workers.dev/link') {
    const ws = new page.WebSocket(url, ['unchanged']);
    ws.open();
    return ws;
  }
  return {
    page, isolated, document, requests, bridge, alerts, prompts, clipboard, menu, tick, socket,
    Socket,
    pair(value = PAIR) {
      prompts.push(typeof value === 'string' ? value : JSON.stringify(value));
      menu('Sabaki: Pair');
    },
    pairAlerts(value = ALERT_PAIR) {
      prompts.push(JSON.stringify(value));
      menu('Alerts: Pair');
    },
    send: () => menu('Sabaki: Send'),
    stop: () => menu('Sabaki: Stop'),
    sendAlerts: () => menu('Alerts: Send'),
    stopAlerts: () => menu('Alerts: Stop'),
    help: () => menu('Sabaki: Capture help'),
    copyDiagnostics: () => menu('Sabaki: Copy diagnostics'),
    toggleDetails() {
      const toggle = button('Details') || button('Less');
      assert.ok(toggle, 'Details toggle exists');
      toggle.dispatchEvent({ type: 'click' });
    },
    click(label) {
      const element = button(label);
      assert.ok(element, `Missing button: ${label}`);
      element.dispatchEvent({ type: 'click' });
    },
    clickTarget(name, label) {
      const row = elements(document.documentElement).find((element) => element.children
        .some((child) => child.textContent.startsWith(`${name}:`)));
      const element = elements(row).find((child) => child.tagName === 'button' && child.textContent === label);
      assert.ok(element, `Missing ${name} button: ${label}`);
      element.dispatchEvent({ type: 'click' });
    },
    visibleButtons() {
      return elements(document.documentElement, true)
        .filter((element) => element.tagName === 'button')
        .map((element) => element.textContent);
    },
    status() {
      return elements(document.documentElement, true).map((element) => element.textContent).join(' ');
    },
    spoof(data) {
      document.dispatchEvent(new CustomEvent('kifubara-sabaki-capture-v1', {
        detail: JSON.stringify(data),
      }));
    },
  };
}

function room(ws, {
  id = 'room-a', moves = [{ x: 3, y: 3, color: 1, pass: false }],
  black = 'Black', white = 'White', board, ...extra
} = {}) {
  if (!board) {
    const points = Array(361).fill('0');
    for (const move of moves) {
      if (!move.pass) points[move.y * 19 + move.x] = String(move.color);
    }
    board = points.join('');
  }
  ws.receive({
    k: 'roomInfo',
    roomBrief: {
      roomKey: id, boardSize: 19, moveNum: moves.length, board, variant: 0,
      black, white, ...extra,
    },
  });
  ws.receive({
    k: 'watched', observeRoomKey: id, moves,
    commentary: [{ text: 'Not played', moves: [{ x: 0, y: 0, color: 2 }] }],
    fineArt: [[0, 0]],
  });
}

function start(h, options) {
  const ws = h.socket();
  room(ws, options);
  h.pair();
  h.send();
  return ws;
}

test('native constructor preserved; only matching existing sockets observed additively', () => {
  const h = harness();
  assert.equal(h.page.WebSocket.OPEN, 1);
  const ws = h.socket();
  assert.ok(ws instanceof h.Socket);
  assert.deepEqual(ws.protocols, ['unchanged']);
  let siteMessages = 0;
  ws.addEventListener('message', () => siteMessages++);
  room(ws);
  assert.equal(siteMessages, 2);
  const other = h.socket('wss://example.com/link');
  room(other, { id: 'wrong' });
  h.pair();
  h.send();
  assert.equal(h.requests[0].body.gameId, 'kifubara-fox:room-a');
});

test('explicit pairing/send produces complete UTF8 SGF, escaped metadata, B/W and pass', () => {
  const h = harness();
  start(h, {
    black: '一力 ]\\\r\n遼',
    moves: [
      { x: 3, y: 3, color: 1, pass: false },
      { x: 15, y: 15, color: 2, pass: false },
      { x: -1, y: -1, color: 1, pass: true },
    ],
  });
  const request = h.requests[0];
  assert.equal(request.body.sgf,
    '(;FF[4]GM[1]CA[UTF-8]SZ[19]PB[一力 \\]\\\\\n遼]PW[White];B[dd];W[pp];B[])');
  assert.doesNotMatch(request.body.sgf, /KM\[|RU\[|Not played|fineArt/);
  assert.equal(request.body.type, 'start');
  assert.equal(request.body.version, 1);
  assert.equal(request.body.feed.upstream, 'unknown');
  assert.equal(request.anonymous, true);
  assert.equal(request.headers.Authorization, `Bearer ${PAIR.token}`);
  assert.equal(request.url, PAIR.endpoint);
  assert.equal(request.method, 'POST');
  assert.equal(JSON.stringify(h.bridge).includes(PAIR.token), false);
  assert.equal(h.status().includes(PAIR.token), false);
});

test('no automatic delivery before explicit Send or without pairing', () => {
  const h = harness();
  room(h.socket());
  h.send();
  assert.equal(h.requests.length, 0);
  h.pair();
  assert.equal(h.requests.length, 0);
});

test('pairing rejects arbitrary hosts, ports, credentials, query and fragment', () => {
  for (const endpoint of [
    'https://example.com/v1/browser-sgf',
    'http://localhost:49152/v1/browser-sgf',
    'http://127.0.0.1:0/v1/browser-sgf',
    'http://127.0.0.1:49152/not-sgf',
    'http://x:y@127.0.0.1:49152/v1/browser-sgf',
    'http://127.0.0.1:49152/v1/browser-sgf?token=x',
    'http://127.0.0.1:49152/v1/browser-sgf#x',
  ]) {
    const h = harness();
    room(h.socket());
    h.pair({ ...PAIR, endpoint });
    h.send();
    assert.equal(h.requests.length, 0, endpoint);
  }
});

test('page messages cannot pair, send, choose privileged destination or leak credentials', () => {
  const h = harness();
  const ws = h.socket();
  room(ws);
  h.pair();
  const message = h.bridge.find((value) => value.kind === 'snapshot');
  h.spoof({ ...message, type: 'send', endpoint: 'https://attacker.example', token: 'evil' });
  assert.equal(h.requests.length, 0);
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a',
    moves: [{ x: 3, y: 3, color: 1, pass: false }],
    auth: 'website-secret', commentary: [{ text: 'website-secret' }],
  });
  h.send();
  assert.equal(h.requests[0].url, PAIR.endpoint);
  assert.equal(JSON.stringify(h.bridge).includes('website-secret'), false);
  assert.equal(h.requests[0].data.includes('website-secret'), false);
});

test('missing hook or history waits with reload guidance, not empty synchronized SGF', () => {
  const h = harness({ blocked: true });
  h.tick(3000);
  h.pair();
  h.send();
  assert.equal(h.requests.length, 0);
  assert.match(h.status(), /reload|waiting/i);
  h.help();
  assert.match(h.alerts.at(-1), /incremental|snapshot/i);
  assert.match(h.alerts.at(-1), /credential|cookie|token/i);
});

test('invalid moves, color0, partial histories and unsupported setup are refused', () => {
  for (const options of [
    { moves: [{ x: 19, y: 0, color: 1, pass: false }] },
    { moves: [{ x: 0, y: 0, color: 0, pass: false }] },
    { moves: [{ x: 3, y: 3, color: 1 }] },
    { moveNum: 4 },
    { board: `2${'0'.repeat(360)}` },
    { variant: 1 },
  ]) {
    const h = harness();
    start(h, options);
    assert.equal(h.requests.length, 0, JSON.stringify(options));
  }
});

test('zero-move empty opening is complete; commentary and lobby moves never append', () => {
  const h = harness();
  const ws = start(h, { moves: [] });
  assert.match(h.requests[0].body.sgf, /PW\[White\]\)$/);
  h.requests[0].reply(202, { state: 'queued' });
  ws.receive({ k: 'lobby.move', color: 0, x: 3, y: 3 });
  ws.receive({ k: 'commentary', moves: [{ x: 4, y: 4, color: 1 }] });
  assert.equal(h.requests.length, 1);
  assert.match(h.status(), /unverified|unsupported|snapshot/i);
});

test('board validation handles captures without guessing starting setup', () => {
  const moves = [
    { x: 1, y: 0, color: 1, pass: false },
    { x: 0, y: 0, color: 2, pass: false },
    { x: 0, y: 1, color: 1, pass: false },
  ];
  const board = Array(361).fill('0');
  board[1] = '1';
  board[19] = '1';
  const h = harness();
  start(h, { moves, board: board.join('') });
  assert.equal(h.requests[0].body.sgf,
    '(;FF[4]GM[1]CA[UTF-8]SZ[19]PB[Black]PW[White];B[ba];W[aa];B[ab])');
});

test('202 is queued; status contacts retrieve actual acceptance without another start', () => {
  const h = harness();
  start(h);
  h.requests[0].reply(202, { state: 'queued' });
  assert.match(h.status(), /queued|delivering/i);
  h.tick(5000);
  assert.equal(h.requests[1].body.type, 'status');
  assert.equal(h.requests[1].body.sequence, 2);
  h.requests[1].reply(200, {
    state: 'current', acceptedSequence: 1, moveCount: 1, message: 'Accepted',
  });
  assert.match(h.status(), /1 move/);
});

test('bursts serialize requests and retain only newest pending complete snapshot', () => {
  const h = harness();
  const ws = start(h);
  const first = { x: 3, y: 3, color: 1, pass: false };
  room(ws, { moves: [first, { x: 4, y: 4, color: 2, pass: false }] });
  room(ws, { moves: [first, { x: 5, y: 5, color: 2, pass: false }] });
  assert.equal(h.requests.length, 1);
  h.requests[0].reply(202, { state: 'queued' });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.type, 'snapshot');
  assert.match(h.requests[1].body.sgf, /;W\[ff\]\)$/);
  assert.doesNotMatch(h.requests[1].body.sgf, /W\[ee\]/);
  assert.ok(h.requests[1].body.sequence > h.requests[0].body.sequence);
});

test('handoff resnapshot resends immediately without another move or re-pairing', () => {
  const h = harness();
  start(h);
  h.requests[0].reply(202, { state: 'queued', needsSnapshot: true });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.type, 'snapshot');
  assert.equal(h.requests[1].body.sgf, h.requests[0].body.sgf);
  h.requests[1].reply(202, { state: 'queued', needsSnapshot: true });
  assert.equal(h.requests.length, 2, 'do not loop while resnapshot awaits ack');
  h.tick(5000);
  h.requests[2].reply(200, {
    state: 'current', acceptedSequence: 2, moveCount: 1, needsSnapshot: false,
  });
  assert.equal(h.requests.length, 3);
});

test('socket close and reconnect require new full history; old socket messages ignored', () => {
  const h = harness();
  const ws = start(h);
  h.requests[0].reply(202, { state: 'queued' });
  ws.close();
  assert.match(h.status(), /interrupted|full snapshot/i);
  const next = h.socket();
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a',
    moves: [{ x: 3, y: 3, color: 1, pass: false }],
  });
  assert.equal(h.requests.length, 1);
  room(next, {
    moves: [
      { x: 3, y: 3, color: 1, pass: false },
      { x: 4, y: 4, color: 2, pass: false },
    ],
  });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.type, 'snapshot');
  assert.equal(h.requests[1].body.sendId, h.requests[0].body.sendId);
});

test('room switch refuses silent takeover and retains selected game on heartbeat', () => {
  const h = harness();
  const ws = start(h);
  h.requests[0].reply(202, { state: 'queued' });
  room(ws, { id: 'room-b' });
  assert.equal(h.requests.length, 1);
  h.tick(5000);
  assert.equal(h.requests[1].body.type, 'status');
  assert.equal(h.requests[1].body.gameId, 'kifubara-fox:room-a');
  assert.equal(h.requests[1].body.feed.capture, 'waiting');
  h.send();
  assert.equal(h.requests.length, 2);
  assert.match(h.status(), /room|game/i);
});

test('Stop clears pending snapshots; late reply cannot revive sender or heartbeat', () => {
  const h = harness();
  const ws = start(h);
  room(ws, {
    moves: [
      { x: 3, y: 3, color: 1, pass: false },
      { x: 4, y: 4, color: 2, pass: false },
    ],
  });
  h.stop();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.type, 'stop');
  assert.ok(h.requests[1].body.sequence > h.requests[0].body.sequence);
  h.requests[0].reply(200, { state: 'current', acceptedSequence: 1, moveCount: 1 });
  h.requests[1].reply(200, { state: 'stopped' });
  h.tick(20000);
  assert.equal(h.requests.length, 2);
  h.send();
  assert.equal(h.requests.length, 2);
  assert.match(h.status(), /pair/i);
});

test('401 revokes local pair; cancelled permits explicit new sendId with same pair', () => {
  const h = harness();
  start(h);
  h.requests[0].reply(409, {
    ok: false, state: 'error', error: { kind: 'cancelled', message: 'Cancelled' },
  });
  h.tick(10000);
  assert.equal(h.requests.length, 1);
  h.send();
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.requests[1].body.sendId, h.requests[0].body.sendId);
  assert.equal(h.requests[1].headers.Authorization, h.requests[0].headers.Authorization);
  h.requests[1].reply(401, {
    ok: false, state: 'error', error: { kind: 'unauthorized', message: 'Pair again' },
  });
  h.send();
  assert.equal(h.requests.length, 2);
});

test('malformed response and terminal ack error never report accepted or auto-start again', () => {
  for (const response of [
    { state: 'error', error: { kind: 'invalid-content', message: 'Invalid SGF' } },
    { state: 'error', error: { kind: 'incompatible', message: 'Wrong opening' } },
    { state: 'current', acceptedSequence: 999, moveCount: 999 },
  ]) {
    const h = harness();
    start(h);
    h.requests[0].reply(200, response);
    assert.doesNotMatch(h.status(), /999 move/);
    h.tick(20000);
    assert.equal(h.requests.length, 1);
  }
});

test('transient retries are bounded, never replay start prompts as a new send attempt', () => {
  const h = harness();
  start(h);
  const sendId = h.requests[0].body.sendId;
  h.requests[0].fail();
  h.tick(1000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.sendId, sendId);
  assert.equal(h.requests[1].body.sequence, h.requests[0].body.sequence);
  h.requests[1].fail();
  h.tick(2000);
  h.requests[2].fail();
  h.tick(4000);
  h.requests[3].fail();
  h.tick(30000);
  assert.equal(h.requests.length, 4);
  assert.match(h.status(), /retry|failed|unavailable/i);
});

test('new page does not inherit pairing or history; diagnostics reveal shape only', () => {
  const first = harness();
  start(first);
  const next = harness();
  next.send();
  assert.equal(next.requests.length, 0);
  next.help();
  assert.match(next.alerts.at(-1), /roomInfo|watched/);
  assert.equal(next.alerts.at(-1).includes(PAIR.token), false);
});

test('switch to a room without metadata still latches refusal before returning to old room', () => {
  const h = harness();
  const ws = start(h);
  h.requests[0].reply(202, { state: 'queued' });
  ws.receive({ k: 'watched', observeRoomKey: 'room-b', moves: [] });
  room(ws);
  assert.equal(h.requests.length, 1, 'returning to old room must not silently resume');
  h.tick(5000);
  assert.equal(h.requests[1].body.feed.capture, 'waiting');
});

test('Stop after cancelled start still revokes same grant with newer sequence', () => {
  const h = harness();
  start(h);
  h.requests[0].reply(409, {
    ok: false, state: 'error', error: { kind: 'cancelled', message: 'Cancelled' },
  });
  h.stop();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.type, 'stop');
  assert.equal(h.requests[1].body.sendId, h.requests[0].body.sendId);
  assert.ok(h.requests[1].body.sequence > h.requests[0].body.sequence);
});

test('page hook strips nonprimitive fields rather than forwarding nested site data', () => {
  const h = harness();
  const ws = h.socket();
  ws.receive({
    k: 'roomInfo',
    roomBrief: {
      roomKey: 'room-a', boardSize: { auth: 'site-credential' },
      moveNum: 0, board: '0'.repeat(361), variant: 0,
    },
  });
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a',
    moves: [{ x: { auth: 'site-credential' }, y: 0, color: 1, pass: false }],
  });
  assert.equal(JSON.stringify(h.bridge).includes('site-credential'), false);
  h.pair();
  h.send();
  assert.equal(h.requests.length, 0);
});

test('status sequence can never impersonate accepted SGF sequence', () => {
  const h = harness();
  start(h);
  h.requests[0].reply(202, { state: 'queued' });
  h.tick(5000);
  h.requests[1].reply(200, {
    state: 'current', acceptedSequence: 2, moveCount: 123,
  });
  assert.doesNotMatch(h.status(), /123 moves/);
  h.tick(20000);
  assert.equal(h.requests.length, 2);
});

test('foreign origin or frame cannot replace selected capture', () => {
  const h = harness();
  start(h);
  h.requests[0].reply(202, { state: 'queued' });
  for (const [source, origin] of [
    [h.isolated, 'https://attacker.example'],
    [{}, 'https://kifubara.app'],
  ]) {
    h.isolated.dispatchEvent({
      type: 'message', source, origin,
      data: { channel: 'kifubara-sabaki-capture-v1', kind: 'unsupported', socketId: '1' },
    });
  }
  h.tick(5000);
  assert.equal(h.requests[1].body.feed.capture, 'ready');
});

test('Violentmonkey window wrapper does not reject native same-document capture messages', () => {
  const h = harness({ wrappedWindow: true });
  start(h);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.gameId, 'kifubara-fox:room-a');
  assert.match(h.status(), /Captured 1 moves/);
});

test('capture bridge works even when extension MessageEvent.source would be null', () => {
  const h = harness({ wrappedWindow: true, nullSource: true });
  start(h);
  assert.equal(h.requests.length, 1);
  assert.match(h.status(), /Captured 1 moves/);
});

test('blocked page execution reports missing handshake with installed script version', () => {
  const h = harness({ blocked: true });
  h.tick(3000);
  assert.match(h.status(), /v\d+\.\d+/);
  assert.match(h.status(), /hook.*not confirmed|hook.*did not confirm/i);
});

test('unknown-event diagnostics expose event names and counts, never raw event data', () => {
  const h = harness();
  const ws = start(h);
  ws.receive({ k: 'lobby.move', auth: 'site-credential', color: 0 });
  assert.match(h.status(), /Unverified event: lobby\.move/);
  assert.match(h.status(), /histories: 1/);
  assert.match(h.status(), /last valid history: 1/);
  h.help();
  assert.match(h.alerts.at(-1), /lobby\.move=1/);
  assert.equal(h.alerts.at(-1).includes('site-credential'), false);
});

test('auxiliary bridge sockets cannot hide played history on original game socket', () => {
  const h = harness();
  const game = h.socket();
  const servers = h.socket();
  servers.receive({ k: 'servers', list: [] });
  servers.close();
  const push = h.socket();
  push.receive({ k: 'push' });
  room(game);
  push.receive({ k: 'push' });
  h.pair();
  h.send();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].body.sgf, /;B\[dd\]\)$/);
  assert.equal(h.requests[0].body.feed.capture, 'ready');
  push.close();
  game.close();
  assert.match(h.status(), /interrupted/);
});

test('unverified events preserve last full record for explicit snapshot delivery, never claim freshness', () => {
  const h = harness();
  const ws = h.socket();
  room(ws);
  ws.receive({ k: 'unknown-game-update', messages: [] });
  h.pair();
  h.send();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].body.sgf, /;B\[dd\]\)$/);
  assert.equal(h.requests[0].body.feed.capture, 'waiting');
  assert.equal(h.requests[0].body.feed.upstream, 'unknown');
});

test('explicit diagnostic copy contains bounded primitive move candidates, not credentials or invented played moves', () => {
  const h = harness();
  const ws = start(h);
  h.requests[0].reply(202, { state: 'queued' });
  ws.receive({
    k: 'lobby', auth: 'website-secret',
    move: { x: 4, y: 4, color: 2, pass: false, synSeq: 0, roundNum: 0, token: 'website-secret' },
  });
  assert.equal(h.requests.length, 1, 'candidate is diagnostic, not yet a played move');
  h.copyDiagnostics();
  const copied = h.clipboard[0];
  assert.equal(copied.type, 'text/plain');
  const data = JSON.parse(copied.text);
  assert.equal(data.snapshot.moveNum, 1);
  assert.deepEqual(data.events[0], {
    kind: 'lobby.move',
    move: { x: 4, y: 4, color: 2, pass: false, synSeq: 0, roundNum: 0 },
  });
  assert.equal(copied.text.includes('website-secret'), false);
  assert.equal(copied.text.includes(PAIR.token), false);
  for (let i = 0; i < 80; i++) ws.receive({ k: 'lobby', move: { x: 0, y: 0, color: 0 } });
  h.copyDiagnostics();
  assert.equal(JSON.parse(h.clipboard[1].text).events.length, 64);
});

function watchRequest(ws, key = 'room-a') {
  const payload = JSON.stringify({ k: 'watch', key, n: 1, u: 2, h: 'browser-only-watch-secret', r: [1, 2] });
  ws.send(payload);
  return payload;
}

function boardUpdate(ws, moves, id = 'room-a') {
  const board = Array(361).fill('0');
  for (const move of moves) if (!move.pass) board[move.y * 19 + move.x] = String(move.color);
  ws.receive({
    k: 'roomInfo',
    roomBrief: {
      roomKey: id, boardSize: 19, moveNum: moves.length, board: board.join(''),
      variant: 0, black: 'Black', white: 'White',
    },
  });
}

const opening = { x: 3, y: 3, color: 1, pass: false };
const reply = { x: 4, y: 4, color: 2, pass: false };

test('approved refresh reuses exact observed watch on same socket; only returned full history is sent', () => {
  const h = harness();
  const ws = h.socket();
  const payload = watchRequest(ws);
  room(ws);
  h.pair(); h.send();
  h.requests[0].reply(202, { state: 'queued' });
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  assert.deepEqual(ws.sent, [payload, payload]);
  assert.equal(h.requests.length, 1, 'board update alone cannot fabricate move');
  h.tick(1000);
  assert.equal(ws.sent.length, 2, 'one outstanding refresh');
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  assert.equal(h.requests.length, 2);
  assert.match(h.requests[1].body.sgf, /;B\[dd\];W\[ee\]\)$/);
  assert.equal(JSON.stringify(h.bridge).includes('browser-only-watch-secret'), false);
  assert.equal(h.requests[1].data.includes('browser-only-watch-secret'), false);
  h.copyDiagnostics();
  assert.equal(h.clipboard[0].text.includes('browser-only-watch-secret'), false);
});

test('refresh never sends before explicit Send and can start with last full snapshot behind metadata', () => {
  const h = harness();
  const ws = h.socket();
  const payload = watchRequest(ws);
  room(ws);
  boardUpdate(ws, [opening, reply]);
  h.tick(10000);
  assert.deepEqual(ws.sent, [payload]);
  h.pair(); h.send(); h.tick(0);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(ws.sent, [payload, payload]);
});

test('Stop and native room changes cancel page-only refresh without replaying another room', () => {
  for (const action of ['stop', 'room']) {
    const h = harness();
    const ws = h.socket();
    watchRequest(ws);
    room(ws); h.pair(); h.send();
    boardUpdate(ws, [opening, reply]);
    if (action === 'stop') h.stop();
    else watchRequest(ws, 'room-b');
    const count = ws.sent.length;
    h.tick(20000);
    assert.equal(ws.sent.length, count);
  }
});

test('refresh timeout stays bounded; only explicit error/auth events immediately pause', () => {
  for (const error of [null, 'error', 'unauthorized', 'auth', 'login', 'new-unknown-response', 'watchBeat']) {
    const h = harness();
    const ws = h.socket();
    watchRequest(ws);
    room(ws); h.pair(); h.send();
    boardUpdate(ws, [opening, reply]);
    h.tick(0);
    assert.equal(ws.sent.length, 2);
    if (error) ws.receive({ k: error, token: 'website-secret' });
    h.tick(30000);
    assert.equal(ws.sent.length, ['error', 'unauthorized', 'auth', 'login'].includes(error) ? 2 : 4);
    assert.equal(JSON.stringify(h.bridge).includes('website-secret'), false);
    assert.match(h.status(), /refresh.*paused|refresh.*failed/i);
  }
});

test('refresh cannot replay hello/login or old-socket authorization after reconnect', () => {
  const h = harness();
  const ws = h.socket();
  ws.send(JSON.stringify({ k: 'hello', token: 'hello-secret' }));
  const payload = watchRequest(ws);
  room(ws); h.pair(); h.send();
  boardUpdate(ws, [opening, reply]);
  ws.close();
  h.tick(20000);
  assert.equal(ws.sent.length, 2);
  const next = h.socket();
  const nextPayload = watchRequest(next);
  room(next, { moves: [opening, reply] });
  boardUpdate(next, [opening, reply, { x: 5, y: 5, color: 1, pass: false }]);
  h.tick(1000);
  assert.deepEqual(next.sent, [nextPayload], 'new socket needs explicit Send to enable refresh');
  assert.equal(JSON.stringify(h.bridge).includes('hello-secret'), false);
  assert.equal(ws.sent[1], payload);
});

test('repeated Send cannot create concurrent full-history refresh requests', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws);
  room(ws); h.pair(); h.send();
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  h.send(); h.send(); h.tick(1000);
  assert.equal(ws.sent.length, 2);
});

test('repeated incomplete full-history responses cannot reset refresh retry bound', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws);
  room(ws); h.pair(); h.send();
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  for (let i = 0; i < 3; i++) {
    ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [] });
    h.tick(1000);
  }
  h.tick(10000);
  assert.equal(ws.sent.length, 4);
  assert.match(h.status(), /refresh.*paused/i);
});

test('default compact panel hides verbose capture text and diagnostic tools', () => {
  const h = harness({ verbose: false });
  assert.match(h.status(), /Waiting for.*game/i);
  assert.doesNotMatch(h.status(), /Hook installed|incremental|v0\./);
  assert.deepEqual(h.visibleButtons(), ['Pair', 'Pair alerts', 'Details']);
  room(h.socket());
  assert.match(h.status(), /1 move captured/);
  assert.doesNotMatch(h.status(), /Full snapshots only/);
});

test('compact controls follow pairing/send and report accepted moves, not queued receipt', () => {
  const h = harness({ verbose: false });
  const ws = h.socket();
  watchRequest(ws);
  room(ws);
  h.pair();
  assert.deepEqual(h.visibleButtons(), ['Send', 'Unpair', 'Pair alerts', 'Details']);
  h.send();
  assert.deepEqual(h.visibleButtons(), ['Stop', 'Pair alerts', 'Details']);
  h.requests[0].reply(202, { state: 'queued' });
  assert.doesNotMatch(h.status(), /1 move received/);
  assert.match(h.status(), /Waiting for.*accept/i);
  h.tick(5000);
  h.requests[1].reply(200, {
    acceptedSequence: 1, moveCount: 1, state: 'current',
  });
  assert.match(h.status(), /1 move received/);
});

test('Details reveals full diagnostics and capture tools without changing sender or network traffic', () => {
  const h = harness({ verbose: false });
  const ws = start(h);
  ws.receive({ k: 'unknown-update', move: { x: 1, y: 0, color: 0, pass: false } });
  const count = h.requests.length;
  assert.doesNotMatch(h.status(), /Unverified event|histories:/);
  h.toggleDetails();
  assert.match(h.status(), /Unverified event: unknown-update/);
  assert.match(h.status(), /histories: 1/);
  assert.ok(h.visibleButtons().includes('Copy diagnostics'));
  assert.ok(h.visibleButtons().includes('Help'));
  assert.ok(h.visibleButtons().includes('Less'));
  assert.equal(h.status().includes(PAIR.token), false);
  h.toggleDetails();
  assert.doesNotMatch(h.status(), /Unverified event|histories:/);
  assert.equal(h.visibleButtons().includes('Copy diagnostics'), false);
  assert.equal(h.requests.length, count);
});

test('compact errors remain actionable without requiring verbose mode', () => {
  const h = harness({ verbose: false });
  start(h);
  h.requests[0].reply(401, {
    ok: false, state: 'error', error: { kind: 'unauthorized', message: 'Pair again' },
  });
  assert.match(h.status(), /Authorization expired/i);
  assert.match(h.status(), /pair again/i);
  assert.deepEqual(h.visibleButtons(), ['Pair', 'Pair alerts', 'Details']);
});

test('compact refresh failure exposes Retry without disabling verbose diagnostics', () => {
  const h = harness({ verbose: false });
  const ws = h.socket();
  watchRequest(ws);
  room(ws); h.pair(); h.send();
  boardUpdate(ws, [opening, reply]);
  h.tick(30000);
  assert.match(h.status(), /Refresh paused/i);
  assert.ok(h.visibleButtons().includes('Retry'));
  assert.ok(h.visibleButtons().includes('Stop'));
  assert.ok(h.visibleButtons().includes('Details'));
});

test('one Copy diagnostics includes visible/full status and sanitized capture together', () => {
  const h = harness({ verbose: false });
  const ws = h.socket();
  watchRequest(ws);
  room(ws); h.pair(); h.send();
  h.requests[0].reply(200, {
    state: 'current', acceptedSequence: 1, moveCount: 1,
  });
  h.menu('Sabaki: Copy diagnostics');
  const data = JSON.parse(h.clipboard[0].text);
  assert.equal(data.snapshot.moveNum, 1);
  assert.equal(data.status.acceptedMoves, 1);
  assert.match(data.status.compact, /1 move received/);
  assert.match(data.status.verbose, /Game acceptance confirmed/);
  assert.equal(data.status.hookConfirmed, true);
  assert.equal(h.clipboard[0].text.includes(PAIR.token), false);
  assert.equal(h.clipboard[0].text.includes('browser-only-watch-secret'), false);
});

test('diagnostics work before any full snapshot and identify missing hook', () => {
  const h = harness({ blocked: true, verbose: false });
  h.tick(3000);
  h.menu('Sabaki: Copy diagnostics');
  const data = JSON.parse(h.clipboard[0].text);
  assert.equal(data.snapshot, null);
  assert.equal(data.status.hookConfirmed, false);
  assert.match(data.status.verbose, /hook did not confirm/i);
});

test('diagnostics retain event name responsible for refresh pause, without raw response fields', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws);
  room(ws); h.pair(); h.send();
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  ws.receive({ k: 'unauthorized', auth: 'website-secret', message: 'website-secret' });
  h.menu('Sabaki: Copy diagnostics');
  const copied = h.clipboard[0].text;
  const data = JSON.parse(copied);
  assert.equal(data.status.lastRefreshFailure.eventKind, 'unauthorized');
  assert.match(data.status.refresh, /unauthorized/);
  assert.equal(copied.includes('website-secret'), false);
});

function targetRequests(h, pairing) {
  return h.requests.filter((request) => request.url === pairing.endpoint);
}

function dualStart(h) {
  const ws = h.socket();
  watchRequest(ws);
  room(ws);
  h.pair(); h.send();
  h.pairAlerts(); h.sendAlerts();
  return ws;
}

test('parallel targets have independent grants, send attempts and accepted cursors', () => {
  const h = harness();
  dualStart(h);
  const sabaki = targetRequests(h, PAIR)[0];
  const alerts = targetRequests(h, ALERT_PAIR)[0];
  assert.equal(sabaki.body.sequence, 1);
  assert.equal(alerts.body.sequence, 1);
  assert.notEqual(sabaki.body.sendId, alerts.body.sendId);
  assert.equal(sabaki.body.gameId, alerts.body.gameId);
  assert.equal(sabaki.body.sgf, alerts.body.sgf);
  assert.equal(sabaki.headers.Authorization, `Bearer ${PAIR.token}`);
  assert.equal(alerts.headers.Authorization, `Bearer ${ALERT_PAIR.token}`);
  sabaki.reply(202, { state: 'queued' });
  alerts.reply(200, { state: 'current', acceptedSequence: 1, moveCount: 1 });
  h.copyDiagnostics();
  const data = JSON.parse(h.clipboard[0].text);
  assert.equal(data.targets.Sabaki.acceptedMoves, null);
  assert.equal(data.targets.Alerts.acceptedMoves, 1);
  assert.equal(data.targets.Alerts.acceptedSequence, 1);
  assert.equal(h.clipboard[0].text.includes(ALERT_PAIR.token), false);
  assert.equal(JSON.stringify(h.bridge).includes(ALERT_PAIR.token), false);
});

test('stopping Sabaki leaves Alerts and shared full-history acquisition running', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  h.stop();
  const stopped = targetRequests(h, PAIR).at(-1);
  assert.equal(stopped.body.type, 'stop');
  assert.equal(targetRequests(h, ALERT_PAIR).length, 1);
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  assert.equal(ws.sent.length, 2, 'Alerts still owns source refresh');
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  const snapshot = targetRequests(h, ALERT_PAIR).at(-1);
  assert.equal(snapshot.body.type, 'snapshot');
  assert.match(snapshot.body.sgf, /;W\[ee\]\)$/);
  assert.equal(targetRequests(h, PAIR).length, 2, 'no more Sabaki snapshots');
  snapshot.reply(200, { acceptedSequence: snapshot.body.sequence, moveCount: 2 });
  h.tick(5000);
  assert.equal(targetRequests(h, ALERT_PAIR).at(-1).body.type, 'status');
  assert.equal(targetRequests(h, PAIR).length, 2);
});

test('closed Sabaki exhausts only its retries; Alerts keeps heartbeat and new moves', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  for (const delay of [1000, 2000, 4000, 0]) {
    targetRequests(h, PAIR).at(-1).fail();
    h.tick(delay);
    for (const request of targetRequests(h, ALERT_PAIR)) {
      if (!request.responded) request.reply(200, { acceptedSequence: 1, moveCount: 1 });
    }
  }
  assert.equal(targetRequests(h, PAIR).length, 4);
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  assert.equal(ws.sent.length, 2);
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  assert.equal(targetRequests(h, ALERT_PAIR).at(-1).body.type, 'snapshot');
  assert.match(targetRequests(h, ALERT_PAIR).at(-1).body.sgf, /;W\[ee\]\)$/);
});

test('each target coalesces its own pending snapshot without blocking the other', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  const third = { x: 5, y: 5, color: 1, pass: false };
  room(ws, { moves: [opening, reply] });
  const alertSecond = targetRequests(h, ALERT_PAIR).at(-1);
  room(ws, { moves: [opening, reply, third] });
  assert.equal(targetRequests(h, PAIR).length, 1);
  alertSecond.reply(200, { acceptedSequence: alertSecond.body.sequence, moveCount: 2 });
  assert.match(targetRequests(h, ALERT_PAIR).at(-1).body.sgf, /;B\[ff\]\)$/);
  targetRequests(h, PAIR)[0].reply(202, { state: 'queued' });
  const sabakiLatest = targetRequests(h, PAIR).at(-1);
  assert.equal(sabakiLatest.body.type, 'snapshot');
  assert.match(sabakiLatest.body.sgf, /;B\[ff\]\)$/);
  assert.equal(targetRequests(h, PAIR).length, 2);
});

test('Alerts revocation does not revoke Sabaki; last stopped target stops source acquisition', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(401, {
    ok: false, state: 'error', error: { kind: 'unauthorized', message: 'Pair again' },
  });
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  assert.equal(ws.sent.length, 2);
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  assert.equal(targetRequests(h, PAIR).at(-1).body.type, 'snapshot');
  assert.equal(targetRequests(h, ALERT_PAIR).length, 1);
  h.stop();
  boardUpdate(ws, [opening, reply, { x: 5, y: 5, color: 1, pass: false }]);
  h.tick(10000);
  assert.equal(ws.sent.length, 2, 'no remaining source owner');
});

test('Alerts can run alone without ever pairing or contacting Sabaki', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws); room(ws);
  h.pairAlerts(); h.sendAlerts();
  assert.equal(targetRequests(h, PAIR).length, 0);
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  h.tick(5000);
  assert.equal(targetRequests(h, ALERT_PAIR).at(-1).body.type, 'status');
  h.isolated.dispatchEvent({ type: 'pagehide' });
  const stop = targetRequests(h, ALERT_PAIR).at(-1);
  assert.equal(stop.body.type, 'stop');
  assert.equal(stop.headers.Authorization, `Bearer ${ALERT_PAIR.token}`);
  assert.equal(targetRequests(h, PAIR).length, 0);
});

test('second target cannot silently choose another game while first target is active', () => {
  const h = harness();
  const ws = start(h);
  room(ws, { id: 'room-b' });
  h.pairAlerts(); h.sendAlerts();
  assert.equal(targetRequests(h, ALERT_PAIR).length, 0);
  assert.match(h.status(), /Stop.*other|another.*game/i);
  h.stop();
  h.sendAlerts();
  assert.equal(targetRequests(h, ALERT_PAIR)[0].body.gameId, 'kifubara-fox:room-b');
});

test('compact UI exposes Pair alerts directly, with scoped Send and Stop after pairing', () => {
  const h = harness({ verbose: false });
  const ws = h.socket();
  watchRequest(ws); room(ws);
  assert.equal(h.status().includes('Alerts:'), false);
  assert.equal(h.visibleButtons().includes('Pair alerts'), true);
  h.prompts.push(JSON.stringify(ALERT_PAIR));
  h.click('Pair alerts');
  assert.equal(h.visibleButtons().includes('Pair alerts'), false);
  h.clickTarget('Alerts', 'Send');
  assert.equal(targetRequests(h, PAIR).length, 0);
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  assert.match(h.status(), /Alerts: Caught up\. 1 move received/);
  h.clickTarget('Alerts', 'Stop');
  assert.equal(targetRequests(h, ALERT_PAIR).at(-1).body.type, 'stop');
  assert.equal(targetRequests(h, PAIR).length, 0);
  assert.equal(h.visibleButtons().includes('Copy diagnostics'), false);
});

test('stopping Alerts preserves Sabaki source refresh and its own authorization', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  h.stopAlerts();
  const stopped = targetRequests(h, ALERT_PAIR).at(-1);
  assert.equal(stopped.body.type, 'stop');
  assert.equal(stopped.headers.Authorization, `Bearer ${ALERT_PAIR.token}`);
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  assert.equal(ws.sent.length, 2);
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  const snapshot = targetRequests(h, PAIR).at(-1);
  assert.equal(snapshot.body.type, 'snapshot');
  assert.equal(snapshot.headers.Authorization, `Bearer ${PAIR.token}`);
  assert.equal(targetRequests(h, ALERT_PAIR).length, 2);
});

test('cancelled Alerts can explicitly restart without replacing Sabaki or accepting late old replies', () => {
  const h = harness();
  dualStart(h);
  const sabaki = targetRequests(h, PAIR)[0];
  const cancelled = targetRequests(h, ALERT_PAIR)[0];
  sabaki.reply(200, { acceptedSequence: 1, moveCount: 1 });
  cancelled.reply(409, {
    ok: false, state: 'stopped', error: { kind: 'cancelled', message: 'Cancelled' },
  });
  h.sendAlerts();
  const restarted = targetRequests(h, ALERT_PAIR).at(-1);
  assert.notEqual(restarted.body.sendId, cancelled.body.sendId);
  assert.equal(restarted.body.sequence, 1);
  assert.equal(restarted.headers.Authorization, cancelled.headers.Authorization);
  cancelled.reply(401, { ok: false, error: { kind: 'unauthorized' } });
  restarted.reply(200, { acceptedSequence: 1, moveCount: 1 });
  h.tick(5000);
  assert.equal(targetRequests(h, PAIR).at(-1).body.sendId, sabaki.body.sendId);
  assert.equal(targetRequests(h, PAIR).at(-1).body.type, 'status');
  assert.equal(targetRequests(h, ALERT_PAIR).at(-1).body.sendId, restarted.body.sendId);
  assert.equal(targetRequests(h, ALERT_PAIR).at(-1).body.type, 'status');
});

test('either target can authorize shared refresh on a fresh reconnected socket', () => {
  const h = harness();
  const old = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  old.close();
  const fresh = h.socket();
  watchRequest(fresh); room(fresh);
  h.sendAlerts();
  h.stop();
  boardUpdate(fresh, [opening, reply]);
  h.tick(0);
  assert.equal(fresh.sent.length, 2, 'new shared connection authorized, not the stale first owner');
  fresh.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  const waiting = targetRequests(h, ALERT_PAIR).filter((request) => !request.responded);
  waiting[0].reply(200, { acceptedSequence: waiting[0].body.sequence, moveCount: 1 });
  assert.match(targetRequests(h, ALERT_PAIR).at(-1).body.sgf, /;W\[ee\]\)$/);
  h.stopAlerts();
  boardUpdate(fresh, [opening, reply, { x: 5, y: 5, color: 1, pass: false }]);
  h.tick(10000);
  assert.equal(fresh.sent.length, 2);
});

test('end diagnostics retain state/result transitions without raw text or credentials', () => {
  const h = harness();
  const ws = start(h);
  room(ws, { state: 1, result: '' });
  ws.receive({
    k: 'gameOver', winner: 1, result: 'B+R', completed: true,
    reason: 'sensitive-free-text', token: 'website-secret',
    data: { result: { winnerColor: 1, score: 2.5, auth: 'nested-secret' } },
  });
  h.copyDiagnostics();
  const copied = h.clipboard.at(-1).text;
  const data = JSON.parse(copied);
  assert.ok(data.endEvents.some((event) => event.evidence.roomBrief?.state === 1));
  const end = data.endEvents.at(-1);
  assert.equal(end.eventKind, 'gameOver');
  assert.equal(end.evidence.event.result, 'B+R');
  assert.equal(end.evidence.event.completed, true);
  assert.equal(end.evidence.event.reason, null);
  assert.equal(end.evidence['data.result'].score, 2.5);
  for (const secret of ['sensitive-free-text', 'website-secret', 'nested-secret']) {
    assert.equal(copied.includes(secret), false);
    assert.equal(JSON.stringify(h.bridge).includes(secret), false);
  }
  assert.equal(h.requests.length, 1, 'instrumentation never sends a completion request');
  assert.equal(h.requests[0].body.completed, undefined);
  assert.doesNotMatch(h.requests[0].body.sgf, /RE\[/);
});

test('end evidence deduplicates repeated packets and retains a bounded final event window', () => {
  const h = harness();
  const ws = start(h);
  for (let i = 0; i < 150; i++) {
    ws.receive({ k: 'gameStatus', status: i });
    ws.receive({ k: 'gameStatus', status: i });
  }
  h.copyDiagnostics();
  const events = JSON.parse(h.clipboard.at(-1).text).endEvents;
  assert.equal(events.length, 128);
  assert.equal(events[0].evidence.event.status, 22);
  assert.equal(events.at(-1).evidence.event.status, 149);
});

test('auxiliary socket terminal flags do not contaminate selected-game diagnostics', () => {
  const h = harness();
  start(h);
  const auxiliary = h.socket();
  room(auxiliary, { id: 'other-game' });
  auxiliary.receive({ k: 'gameOver', result: 'W+R', completed: true });
  h.copyDiagnostics();
  const data = JSON.parse(h.clipboard.at(-1).text);
  assert.ok(data.endEvents.length > 0);
  assert.ok(data.endEvents.every((event) => event.socketId === data.status.sourceSocket));
  assert.equal(JSON.stringify(data.endEvents).includes('W+R'), false);
});

test('initial room end flags survive selection of its first full snapshot after reload', () => {
  const h = harness();
  start(h, { state: 9, result: 'B+R', finished: true });
  h.copyDiagnostics();
  const data = JSON.parse(h.clipboard.at(-1).text);
  const room = data.endEvents.find((event) => event.evidence.roomBrief?.result === 'B+R');
  assert.ok(room);
  assert.equal(room.evidence.roomBrief.state, 9);
  assert.equal(room.evidence.roomBrief.finished, true);
});

test('watchBeat and unrelated packets do not reject an outstanding refresh for either target', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  for (const kind of ['watchBeat', 'line', 'new-notice']) {
    ws.receive({ k: kind, token: 'website-secret' });
  }
  assert.doesNotMatch(h.status(), /refresh.*paused/i);
  assert.equal(ws.sent.length, 2, 'still waiting on the same request');
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  for (const pairing of [PAIR, ALERT_PAIR]) {
    const snapshot = targetRequests(h, pairing).at(-1);
    assert.equal(snapshot.body.type, 'snapshot');
    assert.match(snapshot.body.sgf, /;W\[ee\]\)$/);
    assert.equal(snapshot.body.completed, undefined);
  }
  h.copyDiagnostics();
  const data = JSON.parse(h.clipboard.at(-1).text);
  assert.equal(data.status.lastRefreshFailure, null);
  assert.equal(h.clipboard.at(-1).text.includes('website-secret'), false);
});

test('continuous watchBeat traffic cannot reset full-history timeout or retry limits', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws); room(ws); h.pair(); h.send();
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  for (let i = 0; i < 20; i++) {
    ws.receive({ k: 'watchBeat' });
    h.tick(1000);
  }
  assert.equal(ws.sent.length, 4);
  assert.match(h.status(), /refresh.*paused after three timeouts/i);
});

function roomFrame(options) {
  let frame;
  room({ receive(value) { if (value.k === 'roomInfo') frame = value; } }, options);
  return frame;
}

test('only exact numeric room state4 marks a validated initial full snapshot completed', () => {
  for (const state of [undefined, 1, 2, 3, 4, '4', 9]) {
    const h = harness();
    start(h, { state });
    assert.equal(h.requests[0].body.completed, state === 4 ? true : undefined);
    assert.equal(h.requests[0].body.type, 'start');
    assert.doesNotMatch(h.requests[0].body.sgf, /RE\[/);
  }
});

test('same-move state3 to4 sends independent completion snapshots to both targets', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive(roomFrame({ state: 3 }));
  assert.equal(h.requests.length, 2, 'state3 is still in play');
  ws.receive(roomFrame({ state: 4 }));
  assert.equal(h.requests.length, 2, 'cached pre-end history must not finish before final result refresh');
  h.tick(0);
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening] });
  assert.equal(h.requests.length, 4);
  for (const pairing of [PAIR, ALERT_PAIR]) {
    const [initial, final] = targetRequests(h, pairing);
    assert.equal(final.body.type, 'snapshot');
    assert.equal(final.body.completed, true);
    assert.equal(final.body.sgf, initial.body.sgf, 'terminal metadata changes without another move');
    assert.equal(final.body.gameId, initial.body.gameId);
    assert.equal(final.body.sendId, initial.body.sendId);
    assert.equal(final.body.sequence, 2);
    assert.doesNotMatch(final.body.sgf, /RE\[/);
  }
  ws.receive(roomFrame({ state: 4 }));
  assert.equal(h.requests.length, 4, 'no duplicate terminal transition');
  targetRequests(h, PAIR)[1].reply(202, { state: 'queued', acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[1].reply(200, { state: 'finished', acceptedSequence: 2, moveCount: 1 });
  h.tick(5000);
  const status = targetRequests(h, PAIR).at(-1);
  assert.equal(status.body.type, 'status');
  assert.equal(status.body.completed, undefined, 'control packets never declare completion');
  assert.equal(targetRequests(h, ALERT_PAIR).length, 2, 'finished Alerts heartbeat stopped independently');
  status.reply(200, { state: 'finished', acceptedSequence: 2, moveCount: 1 });
  boardUpdate(ws, [opening, reply]);
  h.tick(10000);
  assert.equal(ws.sent.length, 2, 'last completion ACK ends shared acquisition after one final refresh');
});

test('unrelated room state4 cannot complete either pinned target', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive(roomFrame({ id: 'other-room', state: 4 }));
  h.tick(5000);
  assert.ok(h.requests.every((request) => request.body.completed === undefined));
  assert.ok(h.requests.every((request) => request.body.gameId === 'kifubara-fox:room-a'));
});

test('terminal room metadata cannot bypass full-history count or board validation', () => {
  for (const mismatch of ['count', 'board']) {
    const h = harness();
    const ws = start(h);
    h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
    const frame = roomFrame({ state: 4 });
    if (mismatch === 'count') frame.roomBrief.moveNum = 2;
    else frame.roomBrief.board = '1' + frame.roomBrief.board.slice(1);
    ws.receive(frame);
    ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening] });
    h.tick(5000);
    assert.ok(h.requests.every((request) => request.body.completed === undefined));
    assert.equal(h.requests.filter((request) => request.body.sgf).length, 1);
  }
});

test('queued initial delivery does not lose a same-move final snapshot', () => {
  const h = harness();
  const ws = start(h);
  ws.receive(roomFrame({ state: 4 }));
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening] });
  assert.equal(h.requests.length, 1);
  h.requests[0].reply(202, { state: 'queued' });
  assert.equal(h.requests[1].body.completed, true);
  assert.equal(h.requests[1].body.sgf, h.requests[0].body.sgf);
});

test('last retained terminal record with invalidated capture cannot newly declare completion', () => {
  const h = harness();
  const ws = h.socket();
  room(ws, { state: 4 });
  ws.receive({ k: 'unverified-notice' });
  h.pair(); h.send();
  assert.equal(h.requests[0].body.feed.capture, 'waiting');
  assert.equal(h.requests[0].body.completed, undefined);
  ws.receive(roomFrame({ state: 4 }));
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening] });
  h.requests[0].reply(202, { state: 'queued' });
  assert.equal(h.requests[1].body.completed, true);
});

test('caught-up status survives quietness and routine traffic without claiming broadcast freshness', () => {
  const h = harness({ verbose: false });
  const ws = h.socket();
  watchRequest(ws); room(ws); h.pair(); h.send();
  assert.equal(h.requests[0].body.feed.capture, 'ready');
  assert.equal(h.requests[0].body.feed.upstream, 'current');
  h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  assert.match(h.status(), /Caught up\. 1 move received/);
  for (let i = 0; i < 10; i++) {
    for (const kind of ['watchBeat', 'other', 'push', 'lobby']) {
      ws.receive({ k: kind, move: { x: 1, y: 0, color: 0, pass: false } });
    }
    h.tick(5000);
    const contact = h.requests.at(-1);
    assert.equal(contact.body.type, 'status');
    assert.equal(contact.body.feed.capture, 'ready');
    assert.equal(contact.body.feed.upstream, 'current');
    contact.reply(200, { acceptedSequence: 1, moveCount: 1 });
  }
  assert.equal(h.requests.filter((request) => request.body.sgf).length, 1);
  assert.match(h.status(), /Caught up/);
});

test('ahead, recovered and disconnected source states are reflected in heartbeats and compact UI', () => {
  const h = harness({ verbose: false });
  const ws = h.socket();
  watchRequest(ws); room(ws); h.pair(); h.send();
  h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  boardUpdate(ws, [opening, reply]);
  assert.match(h.status(), /Catching up/);
  h.tick(5000);
  let latest = h.requests.at(-1);
  assert.equal(latest.body.feed.capture, 'waiting');
  assert.equal(latest.body.feed.upstream, 'unknown');
  latest.reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  latest = h.requests.at(-1);
  assert.equal(latest.body.feed.upstream, 'current');
  latest.reply(200, { acceptedSequence: latest.body.sequence, moveCount: 2 });
  assert.match(h.status(), /Caught up\. 2 moves received/);
  ws.close();
  assert.match(h.status(), /Feed disconnected/);
  h.tick(5000);
  latest = h.requests.at(-1);
  assert.equal(latest.body.feed.capture, 'waiting');
  assert.equal(latest.body.feed.upstream, 'interrupted');
});

test('routine event names cannot hide possible moves, undo, swap or pass updates', () => {
  for (const event of [
    { k: 'lobby', move: reply },
    { k: 'other', observeUndo: 1 },
    { k: 'push', observeSwap: true },
    { k: 'watchBeat', observePass: true },
    { k: 'other', moves: 'malformed' },
  ]) {
    const h = harness();
    const ws = h.socket();
    watchRequest(ws); room(ws); h.pair(); h.send();
    h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
    ws.receive(event);
    h.tick(5000);
    const latest = h.requests.at(-1);
    assert.equal(latest.body.type, 'status');
    assert.equal(latest.body.feed.capture, 'waiting');
    assert.equal(latest.body.feed.upstream, 'unknown');
    assert.equal(latest.body.completed, undefined);
  }
});

test('paused acquisition cannot advertise current even when a full record remains exportable', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws); room(ws); h.pair(); h.send();
  h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive({ k: 'unauthorized' });
  h.tick(5000);
  const latest = h.requests.at(-1);
  assert.equal(latest.body.feed.upstream, 'unknown');
  assert.match(latest.body.feed.message, /paused.*unauthorized/);
});

test('observeResult evidence survives noisy diagnostics without inventing SGF results', () => {
  const h = harness();
  const ws = start(h);
  ws.receive({ k: 'unknown-game-update' });
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a', moves: [opening],
    observeResult: { ending: 'resign', winColor: 2, margin: 0, token: 'website-secret' },
  });
  for (let i = 0; i < 150; i++) ws.receive({ k: 'lobby', status: i });
  h.copyDiagnostics();
  const copied = h.clipboard.at(-1).text;
  const data = JSON.parse(copied);
  assert.deepEqual(data.lastResultEvidence.evidence.observeResult, { ending: 'resign', winColor: 2, margin: 0 });
  assert.equal(data.lastResultEvidence.roomKey, 'room-a');
  assert.equal(data.endEvents.some((event) => event.evidence.observeResult), false, 'ordinary ring has rolled over');
  assert.equal(copied.includes('website-secret'), false);
  assert.equal(JSON.stringify(h.bridge).includes('website-secret'), false);
  assert.ok(h.requests.every((request) => !/RE\[/.test(request.body.sgf || '')));
});

test('verified watched resignation result is encoded at SGF root on initial terminal delivery', () => {
  for (const [winColor, expected] of [[1, 'B+R'], [2, 'W+R']]) {
    const h = harness();
    const ws = h.socket();
    room(ws, { state: 4 });
    ws.receive({
      k: 'watched', observeRoomKey: 'room-a', moves: [opening],
      observeResult: { ending: 'resign', winColor, margin: 0 },
    });
    h.pair(); h.send();
    const body = h.requests[0].body;
    assert.ok(body.sgf.includes(`RE[${expected}];B[dd]`));
    assert.equal(body.completed, true);
  }
});

test('result arriving before terminal metadata is held until state4 and fans out with completion', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive(roomFrame({ state: 3 }));
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a', moves: [opening],
    observeResult: { ending: 'resign', winColor: 2, margin: 0 },
  });
  assert.equal(h.requests.length, 2);
  ws.receive(roomFrame({ state: 4 }));
  for (const pairing of [PAIR, ALERT_PAIR]) {
    const final = targetRequests(h, pairing).at(-1).body;
    assert.equal(final.completed, true);
    assert.match(final.sgf, /RE\[W\+R\]/);
    assert.equal(final.sequence, 2);
  }
  assert.equal(ws.sent.length, 1, 'known result avoids unnecessary extra watch');
});

test('terminal metadata before result requests final history before either receiver can finish', () => {
  const h = harness();
  const ws = dualStart(h);
  targetRequests(h, PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  targetRequests(h, ALERT_PAIR)[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive(roomFrame({ state: 4 }));
  assert.equal(h.requests.length, 2);
  h.tick(0);
  assert.equal(ws.sent.length, 2);
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a', moves: [opening],
    observeResult: { ending: 'resign', winColor: 2, margin: 0 },
  });
  for (const pairing of [PAIR, ALERT_PAIR]) {
    const final = targetRequests(h, pairing).at(-1);
    assert.match(final.body.sgf, /RE\[W\+R\]/);
    assert.equal(final.body.completed, true);
    final.reply(200, { state: 'finished', acceptedSequence: final.body.sequence, moveCount: 1 });
  }
  h.tick(10000);
  assert.equal(ws.sent.length, 2);
  assert.equal(h.requests.length, 4);
});

test('a pre-terminal in-flight watch without result cannot prematurely finish after state4', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws); room(ws, { state: 3 }); h.pair(); h.send();
  h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  boardUpdate(ws, [opening, reply]);
  h.tick(0);
  ws.receive(roomFrame({ state: 4, moves: [opening, reply] }));
  ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply] });
  const ongoing = h.requests.at(-1);
  assert.equal(ongoing.body.completed, undefined);
  ongoing.reply(200, { acceptedSequence: ongoing.body.sequence, moveCount: 2 });
  h.tick(1000);
  assert.equal(ws.sent.length, 3, 'one additional post-terminal request');
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a', moves: [opening, reply],
    observeResult: { ending: 'resign', winColor: 2 },
  });
  assert.match(h.requests.at(-1).body.sgf, /RE\[W\+R\]/);
  assert.equal(h.requests.at(-1).body.completed, true);
});

test('unknown, malformed and lobby result values never become SGF RE', () => {
  for (const result of [
    { ending: 'count', winColor: 2, margin: 1 },
    { ending: 'resign', winColor: 31086 },
    { ending: 'resign', winColor: '2' },
    { ending: 'private-secret', winColor: 2 },
  ]) {
    const h = harness();
    const ws = h.socket();
    room(ws, { state: 4 });
    ws.receive({ k: 'lobby', observeResult: { ending: 'resign', winColor: 1 }, winColor: 31086 });
    ws.receive({ k: 'watched', observeRoomKey: 'room-a', moves: [opening], observeResult: result });
    h.pair(); h.send();
    assert.doesNotMatch(h.requests[0].body.sgf, /RE\[/);
    assert.equal(JSON.stringify(h.bridge).includes('private-secret'), false);
  }
});

test('wrong-room or mismatched terminal result cannot bypass selected full-history validation', () => {
  for (const mismatch of ['room', 'board', 'count']) {
    const h = harness();
    const ws = start(h);
    h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
    const frame = roomFrame({ state: 4 });
    if (mismatch === 'room') frame.roomBrief.roomKey = 'other-room';
    if (mismatch === 'board') frame.roomBrief.board = '1' + frame.roomBrief.board.slice(1);
    if (mismatch === 'count') frame.roomBrief.moveNum = 2;
    ws.receive(frame);
    ws.receive({
      k: 'watched', observeRoomKey: mismatch === 'room' ? 'other-room' : 'room-a', moves: [opening],
      observeResult: { ending: 'resign', winColor: 2 },
    });
    h.tick(5000);
    assert.ok(h.requests.every((request) => request.body.completed === undefined));
    assert.ok(h.requests.every((request) => !/RE\[/.test(request.body.sgf || '')));
  }
});

test('invalidated retained result cannot bypass terminal readiness through SGF RE alone', () => {
  const h = harness();
  const ws = h.socket();
  room(ws, { state: 4 });
  ws.receive({
    k: 'watched', observeRoomKey: 'room-a', moves: [opening],
    observeResult: { ending: 'resign', winColor: 2 },
  });
  ws.receive({ k: 'unknown-update' });
  h.pair(); h.send();
  assert.equal(h.requests.length, 0);
  assert.match(h.status(), /fresh terminal history/);
});

test('missing final history stays bounded and never finishes from cached pre-end moves', () => {
  const h = harness();
  const ws = h.socket();
  watchRequest(ws); room(ws, { state: 3 }); h.pair(); h.send();
  h.requests[0].reply(200, { acceptedSequence: 1, moveCount: 1 });
  ws.receive(roomFrame({ state: 4 }));
  h.tick(30000);
  assert.equal(ws.sent.length, 4, 'original native watch plus three bounded final refresh attempts');
  assert.ok(h.requests.every((request) => request.body.completed === undefined));
  assert.ok(h.requests.every((request) => !/RE\[/.test(request.body.sgf || '')));
  assert.match(h.status(), /refresh.*paused after three timeouts/i);
});
