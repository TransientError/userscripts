// ==UserScript==
// @name         Kifubara Auto Advance
// @namespace    https://github.com/TransientError
// @version      1.4
// @description  Step through Kifubara moves at a configurable interval, keeping the screen awake while playing.
// @author       TransientError
// @match        *://kifubara.app/games/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[Kifubara Auto Advance]';
  const INTERVAL_KEY = 'kifubara-auto-advance-interval';
  const DEFAULT_INTERVAL = 5;
  const MIN_INTERVAL = 0.1;

  let viewer = null;
  let currentMove = null;
  let totalMoves = null;
  let timer = null;
  let pendingMove = null;
  let pendingTimeout = null;
  let wakeLock = null;
  let wakeGeneration = 0;

  const root = document.createElement('div');
  root.id = 'kifubara-auto-advance-root';
  root.style.cssText = [
    'all:initial',
    'display:block',
    'box-sizing:border-box',
    'width:100%',
    'margin:8px 0',
    'flex-shrink:0',
    'font:14px/1.3 system-ui,sans-serif',
    'color:#fff',
  ].join(';');

  const dockStyle = document.createElement('style');
  dockStyle.textContent = `
    body.gtf-expanded #kifubara-auto-advance-root {
      display: none !important;
    }
  `;
  document.head.appendChild(dockStyle);

  const panel = document.createElement('div');
  panel.style.cssText = [
    'display:flex',
    'flex-wrap:wrap',
    'align-items:center',
    'gap:8px',
    'padding:10px',
    'border:1px solid #666',
    'border-radius:10px',
    'background:#1e1e1e',
    'box-shadow:0 2px 10px rgba(0,0,0,.45)',
  ].join(';');
  root.appendChild(panel);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Start';
  button.style.cssText = [
    'min-height:42px',
    'padding:8px 12px',
    'border:0',
    'border-radius:7px',
    'background:#357a38',
    'color:#fff',
    'font:600 14px system-ui,sans-serif',
    'touch-action:manipulation',
  ].join(';');
  panel.appendChild(button);

  const intervalLabel = document.createElement('label');
  intervalLabel.textContent = 'Seconds';
  intervalLabel.style.cssText = 'display:flex;align-items:center;gap:5px;white-space:nowrap;';
  const intervalInput = document.createElement('input');
  intervalInput.type = 'number';
  intervalInput.min = String(MIN_INTERVAL);
  intervalInput.step = String(MIN_INTERVAL);
  intervalInput.inputMode = 'decimal';
  intervalInput.setAttribute('aria-label', 'Seconds between moves');
  intervalInput.style.cssText = [
    'box-sizing:border-box',
    'width:68px',
    'min-height:42px',
    'padding:6px',
    'border:1px solid #777',
    'border-radius:6px',
    'background:#292929',
    'color:#fff',
    'font:16px system-ui,sans-serif',
  ].join(';');
  const intervalControls = document.createElement('span');
  intervalControls.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

  function makeIntervalButton(text, label, delta) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.setAttribute('aria-label', label);
    control.title = label;
    control.style.cssText = [
      'width:32px',
      'height:20px',
      'padding:0',
      'border:1px solid #777',
      'border-radius:4px',
      'background:#383838',
      'color:#fff',
      'font:600 12px/1 system-ui,sans-serif',
      'touch-action:manipulation',
    ].join(';');
    control.addEventListener('click', () => {
      const current = Number.isFinite(intervalInput.valueAsNumber)
        ? intervalInput.valueAsNumber
        : DEFAULT_INTERVAL;
      setIntervalValue(Math.max(MIN_INTERVAL, Math.round((current + delta) * 10) / 10));
    });
    return control;
  }

  intervalControls.append(
    makeIntervalButton('▲', 'Increase interval by 0.1 seconds', 0.1),
    makeIntervalButton('▼', 'Decrease interval by 0.1 seconds', -0.1)
  );

  let savedInterval = DEFAULT_INTERVAL;
  try {
    const stored = Number(localStorage.getItem(INTERVAL_KEY));
    if (Number.isFinite(stored) && stored >= MIN_INTERVAL) savedInterval = stored;
  } catch (error) {
    console.warn(TAG, 'Could not read saved interval', error);
  }
  intervalInput.value = String(savedInterval);
  intervalLabel.appendChild(intervalInput);
  intervalLabel.appendChild(intervalControls);
  panel.appendChild(intervalLabel);

  const status = document.createElement('span');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'min-width:74px;text-align:right;font-size:12px;color:#ccc;';
  panel.appendChild(status);
  const wakeStatus = document.createElement('span');
  wakeStatus.setAttribute('aria-live', 'polite');
  wakeStatus.style.cssText = 'font-size:12px;color:#ccc;';
  panel.appendChild(wakeStatus);

  function reportWake(message, error) {
    wakeStatus.textContent = message;
    wakeStatus.title = error ? error.message : message;
    if (error) console.warn(TAG, message, error);
  }

  async function updateWakeLock() {
    const generation = ++wakeGeneration;
    if (timer === null || document.hidden) {
      try {
        if (wakeLock && !wakeLock.released) await wakeLock.release();
        if (generation === wakeGeneration) reportWake(timer === null ? '' : 'Awake paused');
      } catch (error) {
        if (generation === wakeGeneration) reportWake('Wake release failed', error);
        else console.warn(TAG, 'Wake release failed', error);
      }
      return;
    }
    if (!window.isSecureContext || typeof navigator.wakeLock?.request !== 'function') {
      reportWake('Keep awake unavailable', new Error('Wake Lock API unavailable'));
      return;
    }
    if (wakeLock && !wakeLock.released) {
      reportWake('Screen awake');
      return;
    }
    reportWake('Requesting wake lock');
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (generation !== wakeGeneration || timer === null || document.hidden) {
        await lock.release();
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock !== lock) return;
        wakeLock = null;
        reportWake(timer === null ? '' : 'Wake lock released');
      });
      reportWake(lock.released ? 'Wake lock released' : 'Screen awake');
    } catch (error) {
      if (generation === wakeGeneration) reportWake('Keep awake failed', error);
      else console.warn(TAG, 'Screen wake lock request failed', error);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (timer !== null || wakeLock) updateWakeLock();
  });

  function isReady() {
    return currentMove !== null && totalMoves !== null && viewer && viewer.isConnected;
  }

  function render() {
    const ready = isReady();
    const finished = ready && currentMove >= totalMoves;
    button.disabled = !ready;
    button.textContent = timer ? 'Pause' : (finished ? 'Replay' : 'Start');
    button.style.background = timer ? '#8b302c' : '#357a38';
    button.style.opacity = ready ? '1' : '0.55';
    status.textContent = ready
      ? `${timer ? 'Playing · ' : ''}${currentMove}/${totalMoves}`
      : 'Loading…';
    if (finished && timer) stop('Finished');
  }

  function stop(message) {
    if (timer !== null) clearInterval(timer);
    timer = null;
    pendingMove = null;
    if (pendingTimeout !== null) clearTimeout(pendingTimeout);
    pendingTimeout = null;
    updateWakeLock();
    render();
    if (message) status.textContent = message;
  }

  function intervalMilliseconds() {
    const value = intervalInput.valueAsNumber;
    return Number.isFinite(value) && value >= MIN_INTERVAL
      ? Math.round(value * 1000)
      : Math.round(DEFAULT_INTERVAL * 1000);
  }

  function setIntervalValue(value) {
    intervalInput.value = String(value);
    try {
      localStorage.setItem(INTERVAL_KEY, String(value));
    } catch (error) {
      console.warn(TAG, 'Could not save interval', error);
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = setInterval(advance, intervalMilliseconds());
    }
  }

  function advance() {
    if (!isReady() || pendingMove !== null) return;
    if (currentMove >= totalMoves) {
      stop('Finished');
      return;
    }

    pendingMove = currentMove + 1;
    viewer.dispatchEvent(new CustomEvent('kifubara:gotoMove', {
      detail: { move: pendingMove, scope: 'mainline' },
    }));
    pendingTimeout = setTimeout(() => {
      if (pendingMove !== null) {
        pendingMove = null;
        pendingTimeout = null;
        status.textContent = 'Move did not advance';
        console.warn(TAG, 'Viewer did not confirm the requested move');
      }
    }, 2000);
  }

  function start() {
    if (!isReady()) return;
    if (currentMove >= totalMoves) {
      viewer.dispatchEvent(new CustomEvent('kifubara:gotoMove', {
        detail: { move: 0, scope: 'mainline' },
      }));
    }
    timer = setInterval(advance, intervalMilliseconds());
    render();
    updateWakeLock();
  }

  button.addEventListener('click', () => {
    if (timer !== null) stop();
    else start();
  });

  intervalInput.addEventListener('change', () => {
    let value = intervalInput.valueAsNumber;
    if (!Number.isFinite(value) || value < MIN_INTERVAL) value = DEFAULT_INTERVAL;
    value = Math.round(value * 10) / 10;
    setIntervalValue(value);
  });

  document.addEventListener('kifubara:movechange', (event) => {
    const detail = event.detail;
    if (!detail || !Number.isFinite(detail.move) || detail.move < 0) return;
    currentMove = detail.move;
    if (Number.isFinite(detail.totalMoves)) totalMoves = detail.totalMoves;
    if (pendingMove !== null && currentMove >= pendingMove) {
      pendingMove = null;
      if (pendingTimeout !== null) clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
    render();
  });

  const touchLayout = window.matchMedia('(max-width: 1279px)');

  function placeControls() {
    const container = document.querySelector(touchLayout.matches ? '[data-gtf-panes]' : '.gd-panel')
      || document.body;
    container.appendChild(root);
  }

  touchLayout.addEventListener('change', () => {
    if (viewer) placeControls();
  });

  function attachViewer() {
    const found = document.querySelector('.sgf-viewer');
    if (!found) return false;
    viewer = found;
    // Follow panel content in its scroller, outside the board renderer.
    placeControls();
    const move = window.__KIFU_CURRENT_MOVE;
    const total = window.__KIFU_TOTAL_MOVES;
    if (Number.isFinite(move) && Number.isFinite(total)) {
      currentMove = move;
      totalMoves = total;
    }
    render();
    return true;
  }

  if (!attachViewer()) {
    const observer = new MutationObserver(() => {
      if (attachViewer()) observer.disconnect();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
