// ==UserScript==
// @name         GoKifu Spoiler Hider
// @namespace    https://github.com/TransientError
// @version      1.0
// @description  Hide game results on gokifu.com so you can open/download games without the score catching your eye (Stroop-proof: text is removed from the DOM, not just blurred).
// @author       TransientError
// @match        *://gokifu.com/*
// @match        *://*.gokifu.com/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[GoKifu Spoiler Hider]';
  const LS_KEY = 'gokifu-spoiler-hidden'; // "1" = hide by default (default), "0" = reveal all
  const HOTKEY = { key: 'r', alt: true, shift: true }; // Alt+Shift+R = toggle all

  // The result column header text — not a spoiler, leave it legible.
  const HEADER_LABELS = new Set(['Game result', 'Result']);

  const hiddenByDefault = () => localStorage.getItem(LS_KEY) !== '0';
  const setHiddenByDefault = (v) => localStorage.setItem(LS_KEY, v ? '1' : '0');

  // ---- per-cell hide/reveal --------------------------------------------------
  // Move the score out of the visible DOM into a data attribute, and show a
  // fixed-width placeholder button. Fixed width hides result *length* too, so
  // you can't infer "resignation vs counted game" from the shape.
  function hideCell(el) {
    if (el.dataset.spoilerReady === '1') {
      // already processed — just switch to hidden state
      renderHidden(el);
      return;
    }
    const text = (el.textContent || '').trim();
    if (!text || HEADER_LABELS.has(text)) return; // skip header / empty
    el.dataset.result = text;
    el.dataset.spoilerReady = '1';
    renderHidden(el);
  }

  function renderHidden(el) {
    el.textContent = '';
    el.classList.add('spoiler-hidden');
    const btn = document.createElement('span');
    btn.className = 'spoiler-reveal-btn';
    btn.textContent = '••••';
    btn.title = 'Click to reveal result';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      revealCell(el);
    });
    el.appendChild(btn);
  }

  function revealCell(el) {
    if (el.dataset.spoilerReady !== '1') return;
    el.classList.remove('spoiler-hidden');
    el.textContent = el.dataset.result || '';
  }

  // ---- bulk operations -------------------------------------------------------
  function eachResult(fn) {
    document.querySelectorAll('.game_result').forEach(fn);
  }

  function hideAll() {
    setHiddenByDefault(true);
    eachResult(hideCell);
    log('all results hidden');
  }

  function revealAll() {
    setHiddenByDefault(false);
    eachResult((el) => {
      if (el.dataset.spoilerReady === '1') revealCell(el);
    });
    log('all results revealed');
  }

  function toggleAll() {
    hiddenByDefault() ? revealAll() : hideAll();
  }

  // Apply the current default state to any (new) result cells.
  function applyState() {
    if (hiddenByDefault()) {
      eachResult(hideCell);
    } else {
      // reveal any that got processed, leave the rest as raw page text
      eachResult((el) => {
        if (el.dataset.spoilerReady === '1') revealCell(el);
      });
    }
  }

  // ---- styling ---------------------------------------------------------------
  function injectCss() {
    const css = `
      .game_result.spoiler-hidden { min-width: 3.2em; }
      .spoiler-reveal-btn {
        display: inline-block; min-width: 3.2em; text-align: center;
        padding: 0 4px; cursor: pointer; border-radius: 3px;
        background: #444; color: #bbb; font-family: monospace; letter-spacing: 1px;
        user-select: none;
      }
      .spoiler-reveal-btn:hover { background: #666; color: #fff; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  const log = (...a) => console.log(TAG, ...a);

  // ---- wiring ----------------------------------------------------------------
  injectCss();
  applyState();

  // gokifu is server-rendered, but the Archive view can inject rows via AJAX.
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches('.game_result')) { if (hiddenByDefault()) hideCell(n); }
        else if (n.querySelectorAll) {
          const hits = n.querySelectorAll('.game_result');
          if (hits.length && hiddenByDefault()) hits.forEach(hideCell);
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('keydown', (e) => {
    if (
      e.key.toLowerCase() === HOTKEY.key &&
      (!HOTKEY.alt || e.altKey) && (!HOTKEY.shift || e.shiftKey)
    ) { e.preventDefault(); toggleAll(); }
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Hide all results', hideAll);
    GM_registerMenuCommand('Reveal all results', revealAll);
  }

  log('active — results ' + (hiddenByDefault() ? 'HIDDEN' : 'shown') + ' by default. Alt+Shift+R toggles.');
})();
