// ==UserScript==
// @name         WGo SGF Copy
// @namespace    https://github.com/TransientError
// @version      1.4
// @description  Copy SGF from WGo.js players and Yike game IDs from igo-kifu.com
// @author       TransientError
// @match        *://igo-kifu.com/*
// @match        *://*.igo-kifu.com/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[WGo SGF Copy]';
  const LOG = (...a) => console.log(TAG, ...a);
  LOG('loaded on', location.href);

  const HOTKEY = { key: 'c', alt: true, shift: true }; // Alt+Shift+C
  const BADGE_MS = 2200;

  // ---------- SGF discovery ----------
  // igo-kifu is a Next.js app; WGo auto-inits any [data-wgo] element after hydration.
  function findPlayers() {
    return Array.from(document.querySelectorAll('[data-wgo]'));
  }
  const isInlineSgf = (v) => /^\s*\(\s*;/.test(v);

    async function extractSgf(el) {
      const raw = el.getAttribute('data-wgo') || '';
      if (isInlineSgf(raw)) return raw.trim();
      // otherwise it's a path/URL to an .sgf file
      const url = new URL(raw, location.href).href;
      LOG('data-wgo is a URL, fetching', url);
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
      return (await res.text()).trim();
    }

    // ---------- clipboard (Chrome + Wayland friendly) ----------
    async function toClipboard(text) {
      // 1. Standard async Clipboard API — writes a clean text/plain target.
      //    Needs https + focused document + user gesture (the button click gives all).
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          return 'navigator.clipboard';
        } catch (e) {
          LOG('navigator.clipboard failed', e && e.name, e && e.message);
        }
      }
      // 2. execCommand on a hidden textarea — also yields a proper text/plain target.
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
        LOG('execCommand returned false');
      } catch (e) {
        LOG('execCommand failed', e);
      }
      // 3. GM_setClipboard — last resort. Pass the mimetype as a STRING.
      //    Passing an options object here makes Violentmonkey write
      //    chromium/x-web-custom-data ONLY (no text/plain), so wl-paste and other
      //    apps see a mangled "[object object]…" blob instead of the SGF.
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

    async function copyFrom(el) {
      try {
        const sgf = await extractSgf(el);
        if (!sgf) throw new Error('empty SGF');
        const method = await toClipboard(sgf);
        LOG(`copied ${sgf.length} chars via ${method}`);
        badge(`SGF copied ✓  (${sgf.length} chars via ${method})`);
      } catch (e) {
        console.error(TAG, e);
        badge('SGF copy FAILED: ' + (e && e.message || e), false);
      }
    }

    function copyAll() {
      const players = findPlayers();
      LOG('boards found:', players.length);
      if (!players.length) return badge('No WGo board found on page', false);
      if (players.length > 1) LOG(`${players.length} boards; copying the first`);
      return copyFrom(players[0]);
    }

    async function copyYikeId() {
      try {
        // Fetch the current route: Next.js client navigation can leave __NEXT_DATA__ stale.
        const res = await fetch(location.href, { credentials: 'include' });
        if (!res.ok) throw new Error(`fetch ${location.href} -> ${res.status}`);
        const page = new DOMParser().parseFromString(await res.text(), 'text/html');
        const data = JSON.parse(page.querySelector('#__NEXT_DATA__')?.textContent || '{}');
        const streamingUrl = data.props?.pageProps?.initialKifu?.streamingUrl;
        if (!streamingUrl) throw new Error('No Yike game ID found on page');
        const url = new URL(streamingUrl);
        const id = url.searchParams.get('id');
        if (url.hostname !== 'api.yikeweiqi.com' || url.pathname !== '/golive/dtl' || !/^\d+$/.test(id || '')) {
          throw new Error('No Yike game ID found on page');
        }
        await toClipboard(id);
        badge(`Yike ID copied: ${id}`);
      } catch (e) {
        console.error(TAG, e);
        badge('Yike ID copy FAILED: ' + (e && e.message || e), false);
      }
    }

    // ---------- UI mounted OUTSIDE #__next so React never wipes it ----------
    let uiRoot = null;
    function ensureUiRoot() {
      if (uiRoot && uiRoot.isConnected) return uiRoot;
      uiRoot = document.createElement('div');
      uiRoot.id = 'wgo-sgf-copy-root';
      uiRoot.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
      // append to <html>, sibling of <body>/#__next — safe from React reconciliation
      document.documentElement.appendChild(uiRoot);

      const btn = document.createElement('button');
      btn.textContent = '⧉ Copy SGF';
      btn.title = 'Copy SGF to clipboard (Alt+Shift+C)';
      btn.style.cssText = [
        'font:600 13px system-ui,sans-serif', 'cursor:pointer',
        'padding:8px 12px', 'border:1px solid #555', 'border-radius:6px',
        'background:#1e1e1e', 'color:#fff', 'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      ].join(';');
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyAll();
      });
      uiRoot.appendChild(btn);
      const yikeBtn = document.createElement('button');
      yikeBtn.textContent = 'Copy Yike ID';
      yikeBtn.title = 'Copy the upstream Yike game ID to clipboard';
      yikeBtn.style.cssText = btn.style.cssText + ';margin-left:8px;';
      yikeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyYikeId();
      });
      uiRoot.appendChild(yikeBtn);
      return uiRoot;
    }

  function badge(msg, ok = true) {
    const root = ensureUiRoot();
    const b = document.createElement('div');
    b.textContent = msg;
    b.style.cssText = [
      'margin-top:8px', 'padding:8px 12px', 'border-radius:6px',
      'font:600 12px/1.3 system-ui,sans-serif', 'color:#fff', 'max-width:320px',
      'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      'background:' + (ok ? '#2e7d32' : '#c62828'),
    ].join(';');
    root.appendChild(b);
    setTimeout(() => b.remove(), BADGE_MS);
  }

  // ---------- wiring ----------
  document.addEventListener('keydown', (e) => {
    if (
      e.key.toLowerCase() === HOTKEY.key &&
      (!HOTKEY.alt || e.altKey) &&
      (!HOTKEY.shift || e.shiftKey)
    ) {
      e.preventDefault();
      copyAll();
    }
  });

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Copy SGF to clipboard', copyAll);
    GM_registerMenuCommand('Copy Yike ID to clipboard', copyYikeId);
  }

  // Board renders after hydration -> mount the button once one exists, keep it alive.
  const mo = new MutationObserver(() => {
    if (findPlayers().length) ensureUiRoot();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  ensureUiRoot();
})();
