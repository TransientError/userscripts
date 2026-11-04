// ==UserScript==
// @name         Jisho Romaji Readings
// @namespace    https://github.com/TransientError
// @version      1.0
// @description  Show romaji for Jisho.org's kana readings so you can read names/words without knowing kana. Targets Jisho's own furigana (the kana-from-kanji it already computes) and romanizes it deterministically with wanakana — no guessing, no layout clipping. Toggle from the userscript menu.
// @author       TransientError
// @match        *://jisho.org/*
// @match        *://*.jisho.org/*
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/wanakana@5.3.1/wanakana.min.js
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[Jisho Romaji]';
  const log = (...a) => console.log(TAG, ...a);

  const LS_KEY = 'jisho-romaji-on'; // "1" = on (default), "0" = off
  const isOn = () => localStorage.getItem(LS_KEY) !== '0';
  const setOn = (v) => localStorage.setItem(LS_KEY, v ? '1' : '0');

  const DATA_ORIG = 'data-romaji-orig'; // stash original kana here
  const CLASS_DONE = 'romaji-done';

  const wk = window.wanakana;
  if (!wk || typeof wk.toRomaji !== 'function') {
    log('wanakana failed to load; aborting');
    return;
  }

  // Only convert when the string actually contains kana. wanakana passes
  // kanji/latin through untouched, but this lets us skip pure-kanji nodes and
  // avoid touching things needlessly.
  const hasKana = (s) => wk.isKana(s) || /[\u3040-\u30ff]/.test(s) && wk.toRomaji(s) !== s;

  // Reading elements Jisho renders as kana. These are the "answer" Jisho
  // computed (kanji -> kana); we just transliterate that kana to romaji.
  //  - .japanese_word__furigana : the search suggestion box (was getting clipped)
  //  - .furigana > span         : per-kanji ruby readings above words
  const READING_SELECTORS = [
    '.japanese_word__furigana',
    '.concept_light-representation .furigana > span',
  ];

  function romanizeEl(el) {
    if (el.classList.contains(CLASS_DONE)) return;
    const kana = el.textContent.trim();
    if (!kana || !hasKana(kana)) {
      el.classList.add(CLASS_DONE); // nothing to do, but don't re-check
      return;
    }
    el.setAttribute(DATA_ORIG, kana);
    el.textContent = wk.toRomaji(kana);
    el.classList.add(CLASS_DONE);
  }

  function restoreEl(el) {
    if (!el.hasAttribute(DATA_ORIG)) return;
    el.textContent = el.getAttribute(DATA_ORIG);
    el.removeAttribute(DATA_ORIG);
    el.classList.remove(CLASS_DONE);
  }

  function eachReading(fn) {
    for (const sel of READING_SELECTORS) {
      document.querySelectorAll(sel).forEach(fn);
    }
  }

  function apply() {
    if (!isOn()) return;
    eachReading(romanizeEl);
  }

  function teardown() {
    eachReading(restoreEl);
  }

  // Jisho updates the suggestion box (as you type) and appends results on
  // scroll, both via AJAX — so watch for new reading nodes.
  const observer = new MutationObserver((muts) => {
    if (!isOn()) return;
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        // Fast path: the added node itself, plus any readings inside it.
        if (node.matches && READING_SELECTORS.some((s) => node.matches(s))) {
          romanizeEl(node);
        }
        if (node.querySelectorAll) {
          for (const sel of READING_SELECTORS) {
            node.querySelectorAll(sel).forEach(romanizeEl);
          }
        }
      }
      // textContent can be swapped in place on the same node (suggestion box).
      if (m.type === 'characterData') {
        const el = m.target.parentElement;
        if (el && READING_SELECTORS.some((s) => el.matches && el.matches(s))) {
          el.classList.remove(CLASS_DONE);
          el.removeAttribute(DATA_ORIG);
          romanizeEl(el);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  GM_registerMenuCommand(
    (isOn() ? '✓ ' : '') + 'Romaji readings (toggle)',
    () => {
      const next = !isOn();
      setOn(next);
      if (next) apply();
      else teardown();
      log('romaji', next ? 'ON' : 'OFF');
    }
  );

  apply();
  log('ready, romaji', isOn() ? 'ON' : 'OFF');
})();
