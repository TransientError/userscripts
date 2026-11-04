// ==UserScript==
// @name         Keep Screen Awake
// @namespace    https://github.com/TransientError
// @version      1.0
// @description  Keep the screen awake using menu commands, with optional per-site defaults and no page UI.
// @author       TransientError
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[Keep Screen Awake]';
  const siteKey = `always-awake:${location.origin}`;
  const supported = window.isSecureContext && typeof navigator.wakeLock?.request === 'function';
  let alwaysAwake = GM_getValue(siteKey, false) === true;
  let enabled = alwaysAwake;
  let wakeLock = null;
  let busy = false;
  let again = false;
  let pageHidden = false;
  let failure = '';
  let toggleMenu = null;
  let siteMenu = null;

  function shouldHold() {
    return enabled && !document.hidden && !pageHidden;
  }

  function renderMenu() {
    if (toggleMenu !== null) GM_unregisterMenuCommand(toggleMenu);
    if (siteMenu !== null) GM_unregisterMenuCommand(siteMenu);

    let status;
    if (!supported) status = 'unavailable (requires HTTPS and browser support)';
    else if (wakeLock && !wakeLock.released) status = failure ? 'ON (release failed; tap to retry)' : 'ON';
    else if (!enabled) status = 'OFF';
    else if (failure) status = 'blocked (tap to turn off)';
    else if (!shouldHold()) status = 'paused';
    else status = busy ? 'starting' : 'paused (browser released lock)';

    toggleMenu = GM_registerMenuCommand(`Keep screen awake: ${status}`, () => {
      if (!supported) return;
      enabled = wakeLock && !wakeLock.released ? false : !enabled;
      failure = '';
      return syncWakeLock();
    }, { title: failure || 'Toggle for this page. Navigation uses the per-site default.' });

    siteMenu = GM_registerMenuCommand(
      `Always keep awake on ${location.host}: ${alwaysAwake ? 'ON' : 'OFF'}`,
      () => {
        if (!supported) return;
        const next = !alwaysAwake;
        try {
          GM_setValue(siteKey, next);
        } catch (error) {
          console.warn(TAG, 'Could not save site preference', error);
          return;
        }
        alwaysAwake = next;
        enabled = next;
        failure = '';
        return syncWakeLock();
      },
      { title: 'Remember for this origin, including future visits. Also updates this page.' }
    );
  }

  async function syncWakeLock() {
    if (busy) {
      again = true;
      renderMenu();
      return;
    }
    busy = true;
    renderMenu();
    try {
      do {
        again = false;
        if (!supported) break;
        if (!shouldHold()) {
          if (wakeLock && !wakeLock.released) await wakeLock.release();
          wakeLock = null;
        } else if (!wakeLock || wakeLock.released) {
          const lock = await navigator.wakeLock.request('screen');
          wakeLock = lock;
          lock.addEventListener('release', () => {
            if (wakeLock === lock) {
              wakeLock = null;
              renderMenu();
            }
          });
          // A toggle or visibility change may have happened during the request.
          if (!shouldHold()) again = true;
        }
        failure = '';
      } while (again);
    } catch (error) {
      failure = error.message || String(error);
      console.warn(TAG, 'Could not update screen wake lock', error);
    } finally {
      busy = false;
      renderMenu();
    }
  }

  document.addEventListener('visibilitychange', () => {
    failure = '';
    void syncWakeLock();
  });
  window.addEventListener('pagehide', () => {
    pageHidden = true;
    void syncWakeLock();
  });
  window.addEventListener('pageshow', () => {
    pageHidden = false;
    failure = '';
    void syncWakeLock();
  });

  void syncWakeLock();
})();
