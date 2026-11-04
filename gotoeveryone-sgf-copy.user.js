// ==UserScript==
// @name         GoToEveryone SGF Copy
// @namespace    https://github.com/TransientError
// @version      1.1
// @description  On gotoeveryone.k2ss.info listing pages, make the SGF links copy the game record to the clipboard instead of downloading a file.
// @author       TransientError
// @match        *://gotoeveryone.k2ss.info/*
// @grant        GM_setClipboard
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[GoToEveryone SGF Copy]';
  const LOG = (...a) => console.log(TAG, ...a);
  LOG('loaded on', location.href);

  // The SGF anchors are tagged with this MIME type on the listing pages.
  const SGF_SELECTOR = 'a[type="application/x-go-sgf"], a[href*="/kifu/"]';
  const TITLE = 'Click to copy SGF to clipboard';
  const FLASH_MS = 1400;

  // ---------- clipboard (Chrome + Wayland friendly) ----------
  async function toClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return 'navigator.clipboard';
      } catch (e) {
        LOG('navigator.clipboard failed', e && e.name, e && e.message);
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return 'execCommand';
    } catch (e) {
      LOG('execCommand failed', e);
    }
    // GM_setClipboard needs the mimetype as a STRING so a proper text/plain
    // target is written (an options object makes some managers write a mangled blob).
    if (typeof GM_setClipboard === 'function') {
      try {
        GM_setClipboard(text, 'text/plain');
        return 'GM_setClipboard';
      } catch (e) {
        LOG('GM_setClipboard failed', e);
      }
    }
    throw new Error('no clipboard method available');
  }

  // ---------- per-link feedback ----------
  function flash(a, msg, ok = true) {
    const original = a.dataset.sgfOriginal || a.textContent;
    a.dataset.sgfOriginal = original;
    a.textContent = msg;
    a.style.outline = '2px solid ' + (ok ? '#2e7d32' : '#c62828');
    a.style.borderRadius = '3px';
    clearTimeout(a._sgfFlashTimer);
    a._sgfFlashTimer = setTimeout(() => {
      a.textContent = a.dataset.sgfOriginal;
      a.style.outline = '';
    }, FLASH_MS);
  }

  async function copyFromLink(a) {
    const url = a.href;
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
      const sgf = (await res.text()).trim();
      if (!sgf) throw new Error('empty SGF');
      const method = await toClipboard(sgf);
      LOG(`copied ${sgf.length} chars from ${url} via ${method}`);
      flash(a, '✓ copied', true);
    } catch (err) {
      console.error(TAG, err);
      flash(a, '✗ failed', false);
    }
  }

  // ---------- wiring ----------
  // Use ONE delegated listener on document in the capture phase instead of
  // per-anchor listeners. This site is a Vue app that mounts and re-renders
  // the listing client-side. On a cold load that mount happens *after* this
  // script runs at document-idle, so Vue replaces the anchors we wired with
  // fresh nodes: attributes we set (title, data-*) get copied into Vue's
  // compiled template, but per-element click listeners are lost on the new
  // nodes, so the link falls back to downloading the file until a refresh.
  // A delegated listener on document survives any number of re-renders, so
  // the copy behaviour works on the very first load.
  document.addEventListener(
    'click',
    (e) => {
      const a = e.target && e.target.closest && e.target.closest(SGF_SELECTOR);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      copyFromLink(a);
    },
    true
  );

  // Cosmetic only: show a tooltip on the SGF links so it's clear they copy.
  // Clicks are handled by the delegated listener above regardless of this.
  function decorate(root = document) {
    root.querySelectorAll(SGF_SELECTOR).forEach((a) => {
      if (a.title !== TITLE) a.title = TITLE;
    });
  }

  decorate();

  // Re-apply the tooltip when Vue (re-)renders or the listing is paginated.
  const mo = new MutationObserver(() => decorate());
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
