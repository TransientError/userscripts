// ==UserScript==
// @name         WhenJumpScare Quick Sync
// @namespace    https://github.com/TransientError
// @version      1.1
// @description  Sync the existing watch-along timer to any scare as it happens.
// @author       TransientError
// @match        https://www.whenjumpscare.com/movie/*
// @match        https://whenjumpscare.com/movie/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const PREFIX = 'wjs-quick-sync';
  const TIMELINE = '[role="slider"][aria-label^="Film timeline"]';
  let status = null;
  let pending = false;

  function readTimeline() {
    const element = document.querySelector(TIMELINE);
    if (!element) return null;
    const maximum = element.getAttribute('aria-valuemax');
    const current = element.getAttribute('aria-valuenow');
    if (maximum === null || current === null) return null;
    const duration = Number(maximum);
    const elapsed = Number(current);
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(elapsed) || rect.width < 1) return null;
    return { element, duration, elapsed, rect };
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60]
      .map((part) => String(part).padStart(2, '0')).join(':');
  }

  function parseTime(element) {
    const match = /^PT(\d+)H(\d+)M(\d+)S$/.exec(element.getAttribute('datetime') || '');
    if (!match) return null;
    const [, hours, minutes, seconds] = match.map(Number);
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function seek(seconds) {
    const timeline = readTimeline();
    if (!timeline) {
      if (status) status.textContent = 'Start watching along first. Timer controls must be visible.';
      return false;
    }
    const target = Math.max(0, Math.min(timeline.duration, seconds));
    // The site's Math.floor must not round just below the intended second.
    const position = Math.min(timeline.duration, target + 0.000001);
    const clientX = timeline.rect.left + position / timeline.duration * timeline.rect.width;
    // Use the site's normal scrub handler so it also reschedules audio warnings.
    const event = new MouseEvent('click', {
      bubbles: true,
      clientX,
      clientY: timeline.rect.top + timeline.rect.height / 2,
    });
    // MouseEvent can truncate to whole pixels, which represent several seconds here.
    Object.defineProperty(event, 'clientX', {
      value: clientX,
    });
    timeline.element.dispatchEvent(event);
    if (status) status.textContent = `Synced to ${formatTime(target)}. Play/pause state unchanged.`;
    return true;
  }

  function makeButton(text, title, callback) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${PREFIX}-button`;
    button.textContent = text;
    button.title = title;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      callback();
    });
    return button;
  }

  function refresh() {
    pending = false;
    const sheet = document.querySelector('#scare-sheet');
    if (!sheet) return;

    if (!sheet.querySelector(`#${PREFIX}-panel`)) {
      const panel = document.createElement('div');
      panel.id = `${PREFIX}-panel`;
      const help = document.createElement('p');
      help.textContent = 'Start watching along, then tap "Sync now" as that scare happens in your film. Minor scares make useful sync points. Paused timer stays paused.';
      status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = 'Uses the existing timer and warning audio.';
      panel.append(help, status);
      sheet.prepend(panel);
    }

    for (const time of sheet.querySelectorAll('ol > li time[datetime]')) {
      const row = time.closest('li');
      if (row.querySelector(`.${PREFIX}-row`)) continue;
      if (parseTime(time) === null) continue;
      const controls = document.createElement('div');
      controls.className = `${PREFIX}-row`;
      const button = makeButton('Sync now', `Set watch-along to ${time.textContent.trim()} when this scare happens`, () => {
        const seconds = parseTime(time);
        if (seconds !== null) seek(seconds);
      });
      button.setAttribute('aria-label', `Sync now to scare at ${time.textContent.trim()}`);
      controls.appendChild(button);
      time.parentElement.after(controls);
    }

    const ready = readTimeline() !== null;
    for (const button of sheet.querySelectorAll(`.${PREFIX}-button`)) {
      button.disabled = !ready;
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #${PREFIX}-panel {
      border: 1px solid var(--rule-strong, #555); border-radius: 3px;
      padding: 12px; margin-bottom: 14px; color: var(--bone, inherit);
      font-size: 13px; line-height: 1.5;
    }
    #${PREFIX}-panel p { margin: 0 0 8px; }
    #${PREFIX}-panel p:last-child { margin: 8px 0 0; }
    .${PREFIX}-row { margin-top: 10px; }
    .${PREFIX}-button {
      min-height: 44px; padding: 8px 14px; border: 1px solid var(--rule-strong, #777);
      border-radius: 3px; background: var(--ink-2, #222); color: var(--bone, #eee);
      font: inherit; cursor: pointer; touch-action: manipulation;
    }
    .${PREFIX}-button:hover:not(:disabled) { border-color: var(--ember-lt, #e97); }
    .${PREFIX}-button:focus-visible { outline: 2px solid var(--ember-lt, #e97); outline-offset: 2px; }
    .${PREFIX}-button:disabled { opacity: .45; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(refresh, 0);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', refresh);
  refresh();
})();
