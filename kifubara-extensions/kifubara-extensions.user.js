// ==UserScript==
// @name         Kifubara Extensions
// @namespace    https://github.com/TransientError
// @version      1.3
// @description  Proportional scroll-wheel move navigation and a Copy SGF button beside the download.
// @author       TransientError
// @match        https://kifubara.app/games/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const WHEEL_SENSITIVITY = 0.85;
  const PIXELS_PER_MOVE = 100;
  const LINES_PER_MOVE = 3;
  const GESTURE_GAP = 250;
  const MAX_STEPS_PER_EVENT = 100;
  let viewer = null;
  let remainder = 0;
  let direction = 0;
  let lastTime = -Infinity;

  function reset() {
    viewer = null;
    remainder = 0;
    direction = 0;
    lastTime = -Infinity;
  }

  document.addEventListener('wheel', (event) => {
    const column = event.target.closest?.('.sgf-viewer-board-col');
    if (!column) {
      reset();
      return;
    }
    // Even ignored gestures must bypass the native handler: it cancels
    // zoom, horizontal scrolling and scrolls over inputs indiscriminately.
    event.stopImmediatePropagation();
    const found = column.closest('.sgf-viewer');
    if (!found || !event.cancelable || document.hidden || !document.hasFocus()
      || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || !Number.isFinite(event.deltaY) || !event.deltaY
      || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      || event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
      || document.activeElement?.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
      || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])')) {
      reset();
      return;
    }

    let travel;
    if (event.deltaMode === 0) {
      // Chromium's legacy delta preserves wheel notches (120 per notch)
      // even when OS settings change how many pixels each notch scrolls.
      travel = Number.isFinite(event.wheelDeltaY) && event.wheelDeltaY !== 0
        ? Math.sign(event.deltaY) * Math.abs(event.wheelDeltaY) / 120
        : event.deltaY / PIXELS_PER_MOVE;
    } else if (event.deltaMode === 1) {
      travel = event.deltaY / LINES_PER_MOVE;
    } else if (event.deltaMode === 2) {
      travel = event.deltaY;
    } else {
      reset();
      return;
    }
    event.preventDefault();
    const now = event.timeStamp;
    const nextDirection = Math.sign(travel);
    if (viewer !== found || now < lastTime || now - lastTime > GESTURE_GAP
      || direction !== nextDirection) {
      // Start on the first full notch without increasing sustained sensitivity.
      remainder = nextDirection * Math.max(0, 1 - WHEEL_SENSITIVITY);
    }
    viewer = found;
    direction = nextDirection;
    lastTime = now;
    remainder += travel * WHEEL_SENSITIVITY;
    const steps = Math.trunc(remainder);
    remainder -= steps;
    const key = steps > 0 ? 'ArrowRight' : 'ArrowLeft';
    const wasFast = document.body.classList.contains('kifu-nav-fast');
    try {
      for (let i = 0; i < Math.min(Math.abs(steps), MAX_STEPS_PER_EVENT); i++) {
        // Native navigation reads a synchronous node ref, so rapid steps do
        // not get lost between renders and remain on the selected variation.
        document.body.classList.add('kifu-nav-fast');
        const press = new KeyboardEvent('keydown', {
          key, code: key, bubbles: true, cancelable: true,
        });
        document.dispatchEvent(press);
        document.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true }));
        if (!press.defaultPrevented) {
          console.warn('[Kifubara Extensions]', 'Viewer did not handle move navigation.');
          reset();
          break;
        }
      }
    } finally {
      if (wasFast) document.body.classList.add('kifu-nav-fast');
      else document.body.classList.remove('kifu-nav-fast');
    }
  }, { capture: true, passive: false });

  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', reset);

  const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>';

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Clipboard permissions can reject the async API even on HTTPS.
    }
    const active = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    try {
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      if (!document.execCommand('copy')) throw new Error('Clipboard access denied');
    } finally {
      textarea.remove();
      active?.focus();
    }
  }

  function copyButtons() {
    document.querySelectorAll('a[data-kifubara-sgf-download]').forEach((download) => {
      if (download.nextElementSibling?.matches('[data-kifubara-sgf-copy]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = download.className;
      button.setAttribute('data-kifubara-sgf-copy', '');
      function status(label, icon = COPY_ICON) {
        button.title = label;
        button.setAttribute('data-tooltip', label);
        button.setAttribute('aria-label', label);
        button.innerHTML = icon;
      }
      status('Copy SGF');
      let timer;
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        clearTimeout(timer);
        button.disabled = true;
        status('Copying SGF...');
        try {
          const response = await fetch(download.href, { credentials: 'include' });
          if (!response.ok) throw new Error(`SGF download failed (${response.status})`);
          const sgf = await response.text();
          if (!/^\s*\(\s*;/.test(sgf)) throw new Error('No SGF returned; sign in or check download access');
          await copyText(sgf);
          status('SGF copied', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l4 4L19 6"/></svg>');
        } catch (error) {
          console.warn('[Kifubara Extensions]', error);
          status(`Copy failed: ${error.message}`, '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M6 18L18 6"/></svg>');
        } finally {
          button.disabled = false;
          timer = setTimeout(() => status('Copy SGF'), 1800);
        }
      });
      download.after(button);
    });
  }

  copyButtons();
  new MutationObserver(copyButtons).observe(document.documentElement, { childList: true, subtree: true });
})();
