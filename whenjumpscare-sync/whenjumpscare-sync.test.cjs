const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'whenjumpscare-sync.user.js'), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { this.append(child); return child; }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  prepend(child) { child.parentElement = this; this.children.unshift(child); }
  after(child) {
    child.parentElement = this.parentElement;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, child);
  }
  closest(tag) {
    return this.tagName === tag ? this : this.parentElement?.closest(tag);
  }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector) {
    if (selector === 'ol > li time[datetime]') {
      return this.descendants().filter((child) => child.tagName === 'time' &&
        child.closest('li')?.parentElement.tagName === 'ol' && child.getAttribute('datetime'));
    }
    return this.descendants().filter((child) =>
      selector.startsWith('#') ? child.id === selector.slice(1) :
        selector.startsWith('.') && child.className.split(' ').includes(selector.slice(1)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); return true; }
  click() {
    if (!this.disabled) this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
  }
}

function harness({ active = true, duration = 6660 } = {}) {
  const sheet = new Element('section');
  const list = new Element('ol');
  sheet.append(list);
  const times = [];
  function addRow(datetime, label, severity) {
    const row = new Element('li');
    const content = new Element('div');
    const line = new Element('div');
    const time = new Element('time');
    time.setAttribute('datetime', datetime);
    time.textContent = label;
    const badge = new Element('span');
    badge.textContent = severity;
    const spoiler = new Element('p');
    spoiler.className = 'hidden';
    spoiler.textContent = 'Existing spoiler';
    line.append(time, badge);
    content.append(line, spoiler);
    row.append(content);
    list.append(row);
    times.push(time);
    return { row, time, spoiler };
  }
  const minor = addRow('PT0H3M53S', '00:03:53', 'Minor');
  const major = addRow('PT1H12M5S', '01:12:05', 'Major');
  const slider = new Element('div');
  slider.setAttribute('aria-valuemax', duration);
  slider.setAttribute('aria-valuenow', 120);
  let rect = { left: 31.5, top: 400, width: 811.25, height: 28 };
  slider.getBoundingClientRect = () => rect;
  const seeks = [];
  slider.addEventListener('click', (event) => {
    assert.equal(event.bubbles, true);
    const target = (event.clientX - rect.left) / rect.width * duration;
    seeks.push(target);
    slider.setAttribute('aria-valuenow', Math.floor(target));
  });
  const callbacks = [];
  let observer;
  const window = new Element('window');
  const document = {
    head: new Element('head'),
    body: new Element('body'),
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => selector === '#scare-sheet' ? sheet : active ? slider : null,
  };
  vm.runInNewContext(source, {
    document, window,
    MouseEvent: class {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
        this.clientX = Math.trunc(options.clientX);
        this.clientY = Math.trunc(options.clientY);
      }
    },
    MutationObserver: class {
      constructor(callback) { observer = callback; }
      observe() {}
    },
    setTimeout: (callback) => callbacks.push(callback),
  });
  function refresh() {
    observer();
    while (callbacks.length) callbacks.shift()();
  }
  return {
    sheet, list, minor, major, times, seeks, slider, refresh, addRow,
    button: (row) => row.querySelector('.wjs-quick-sync-button'),
    status: () => sheet.querySelector('#wjs-quick-sync-panel').children.at(-1).textContent,
    setActive: (value) => { active = value; refresh(); },
    setRect: (value) => { rect = value; },
  };
}

test('minor and major sync buttons seek via native timeline without exposing spoilers', () => {
  const h = harness();
  h.button(h.minor.row).click();
  assert.ok(Math.abs(h.seeks[0] - 233) < 0.00001);
  h.button(h.major.row).click();
  assert.ok(Math.abs(h.seeks[1] - 4325) < 0.00001);
  assert.equal(h.minor.spoiler.className, 'hidden');
  assert.match(h.status(), /01:12:05/);
  assert.match(h.button(h.minor.row).getAttribute('aria-label'), /00:03:53/);
});

test('subpixel seek coordinates land on the requested second even on a narrow timeline', () => {
  const h = harness();
  for (const width of [180, 738.5, 811.25]) {
    h.setRect({ left: 563.2, top: 400, width, height: 28 });
    h.button(h.minor.row).click();
    assert.equal(Number(h.slider.getAttribute('aria-valuenow')), 233);
  }
});

test('controls remain disabled until native watch-along is open, and disable when closed', () => {
  const h = harness({ active: false });
  h.button(h.minor.row).click();
  assert.equal(h.seeks.length, 0);
  h.setActive(true);
  h.button(h.minor.row).click();
  assert.equal(h.seeks.length, 1);
  h.setActive(false);
  assert.equal(h.button(h.minor.row).disabled, true);
});

test('rerenders do not duplicate controls; replacement rows receive buttons', () => {
  const h = harness();
  h.refresh();
  h.refresh();
  assert.equal(h.sheet.querySelectorAll('.wjs-quick-sync-button').length, 2);
  h.list.children = [];
  const replacement = h.addRow('PT0H4M12S', '00:04:12', 'Minor');
  h.refresh();
  assert.equal(h.sheet.querySelectorAll('.wjs-quick-sync-button').length, 1);
  h.button(replacement.row).click();
  assert.ok(Math.abs(h.seeks[0] - 252) < 0.00001);
});

test('sync reads updated timestamp and clamps to native duration', () => {
  const h = harness({ duration: 300 });
  h.minor.time.setAttribute('datetime', 'PT0H4M12S');
  h.button(h.minor.row).click();
  assert.ok(Math.abs(h.seeks[0] - 252) < 0.00001);
  h.button(h.major.row).click();
  assert.ok(Math.abs(h.seeks[1] - 300) < 1e-9);
});

test('invalid timestamps and unavailable geometry never dispatch seeks', () => {
  const h = harness();
  const invalid = h.addRow('PT0H99M0S', '00:99:00', 'Minor');
  h.refresh();
  assert.equal(h.button(invalid.row), null);
  h.setRect({ left: 0, top: 0, width: 0, height: 28 });
  h.button(h.minor.row).click();
  assert.equal(h.seeks.length, 0);
  assert.match(h.status(), /controls must be visible/);
  h.slider.setAttribute('aria-valuemax', 'not a number');
  h.refresh();
  assert.equal(h.button(h.minor.row).disabled, true);
});
