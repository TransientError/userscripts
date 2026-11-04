// ==UserScript==
// @name         JRatings Utils
// @namespace    https://github.com/TransientError
// @version      2.0
// @description  Utilities for jratings.org/Go. (1) Spoiler hider: mask the per-game "Result" (Win/Loss/Draw) and rating "Δ" columns on player pages so you can check a player's rating and pre-game Expected W/L odds without spoiling a game you're watching (the odds bar stays visible). (2) Head-to-Head: pick any two players — by name search or by clicking A/B pills on the rating list / game rows — to get the Elo-based expected W/L for an arbitrary pairing, even one the site hasn't recorded. Features are independently toggleable from the userscript menu.
// @author       TransientError
// @match        *://jratings.org/*
// @match        *://www.jratings.org/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[JRatings Utils]';
  const log = (...a) => console.log(TAG, ...a);

  const escapeHtml = (s) => (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ===========================================================================
  // Feature enable flags (persisted). Toggle from the userscript menu; toggling
  // reloads the page so features apply/teardown cleanly.
  // ===========================================================================
  const featureEnabled = (id, dflt) => {
    const v = localStorage.getItem('jr-feat-' + id);
    return v === null ? dflt : v === '1';
  };
  const setFeatureEnabled = (id, on) => localStorage.setItem('jr-feat-' + id, on ? '1' : '0');

  // The sport data root, derived from the path (e.g. /Go/player/ -> /Go/data/).
  function dataUrl(file) {
    const seg = location.pathname.split('/').filter(Boolean)[0] || 'Go';
    return location.origin + '/' + seg + '/data/' + file;
  }

  // ===========================================================================
  // Feature: Spoiler hider (mask the Result + Δ columns on player pages)
  // ===========================================================================
  const SPOILER = (() => {
    const LS_KEY = 'jr-spoiler-hidden'; // "1" hide by default (default), "0" reveal
    const CELL_CLASS = 'jr-mask';
    const BAR_ID = 'jr-spoiler-bar';
    const BTN_ID = 'jr-reveal-btn';
    const HOTKEY = { key: 'r', alt: true, shift: true }; // Alt+Shift+R toggles all

    const hiddenByDefault = () => localStorage.getItem(LS_KEY) !== '0';
    const setHiddenByDefault = (v) => localStorage.setItem(LS_KEY, v ? '1' : '0');

    // The games table on a player page. Result (`td.result`) and delta (`td.delta`)
    // cells both leak the outcome, so both get masked. The Expected W/L odds bar
    // (`td.wl-cell`) is left alone — that's the whole point of using this site.
    const gamesTable = () => document.getElementById('games');
    const spoilerCells = (table) =>
      table ? table.querySelectorAll('td.result, td.delta') : [];

    function tagCell(el) {
      if (el.classList.contains(CELL_CLASS)) return;
      el.dataset.result = el.textContent;
      el.dataset.origClass = el.className;
      el.classList.add(CELL_CLASS);
    }

    // Fixed-width placeholder hides the *length* too, so you can't infer
    // Win (3) vs Loss (4) — or the sign of the delta — from the shape.
    function renderHidden(el) {
      el.textContent = '';
      el.dataset.spoilerState = 'hidden';
      el.className = CELL_CLASS + ' jr-mask-hidden';
      const btn = document.createElement('span');
      btn.className = 'jr-mask-btn';
      btn.textContent = '••••';
      btn.title = 'Click to reveal';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        revealCell(el);
      });
      el.appendChild(btn);
    }

    function renderRevealed(el) {
      el.dataset.spoilerState = 'shown';
      // Keep CELL_CLASS so hideAll() can re-hide this cell later.
      el.className = ((el.dataset.origClass || '') + ' ' + CELL_CLASS).trim();
      el.textContent = el.dataset.result || '';
    }

    const hideCell = (el) => { if (el.classList.contains(CELL_CLASS)) renderHidden(el); };
    const revealCell = (el) => { if (el.classList.contains(CELL_CLASS)) renderRevealed(el); };
    const eachCell = (fn) => document.querySelectorAll('.' + CELL_CLASS).forEach(fn);

    // Apply the default only to freshly-tagged cells, so an individually revealed
    // cell isn't re-hidden when the observer re-runs.
    function applyDefaultToUnset() {
      eachCell((el) => {
        if (el.dataset.spoilerState) return;
        hiddenByDefault() ? hideCell(el) : revealCell(el);
      });
    }

    function updateBtnLabel() {
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.textContent = hiddenByDefault() ? 'Reveal all results' : 'Hide all results';
    }

    function hideAll() { setHiddenByDefault(true); eachCell(hideCell); updateBtnLabel(); log('all results hidden'); }
    function revealAll() { setHiddenByDefault(false); eachCell(revealCell); updateBtnLabel(); log('all results revealed'); }
    const toggleAll = () => (hiddenByDefault() ? revealAll() : hideAll());

    function ensureBar(table) {
      let bar = document.getElementById(BAR_ID);
      if (!bar) {
        bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.className = 'jr-spoiler-bar';
        const wrap = document.getElementById('gamesWrap') || table.parentNode;
        wrap.parentNode.insertBefore(bar, wrap);
      }
      if (!document.getElementById(BTN_ID)) {
        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.type = 'button';
        btn.className = 'jr-btn';
        btn.addEventListener('click', (e) => { e.preventDefault(); toggleAll(); });
        bar.appendChild(btn);
      }
      updateBtnLabel();
    }

    function apply() {
      const table = gamesTable();
      if (!table) return;
      const cells = spoilerCells(table);
      if (!cells.length) return; // table not populated yet
      cells.forEach(tagCell);
      ensureBar(table);
      applyDefaultToUnset();
    }

    document.addEventListener('keydown', (e) => {
      if (
        e.key.toLowerCase() === HOTKEY.key &&
        (!HOTKEY.alt || e.altKey) && (!HOTKEY.shift || e.shiftKey)
      ) { e.preventDefault(); toggleAll(); }
    });

    return { apply, hideAll, revealAll };
  })();

  // ===========================================================================
  // Feature: Head-to-Head expected W/L (search or click any two players)
  // ===========================================================================
  const HEADTOHEAD = (() => {
    const PANEL_ID = 'jr-h2h';
    const PICK_ATTR = 'jrH2hPicked';
    const COLLAPSE_KEY = 'jr-h2h-collapsed';
    const SLOTS_KEY = 'jr-h2h-slots';

    let state = { collapsed: localStorage.getItem(COLLAPSE_KEY) === '1' };
    try {
      const saved = JSON.parse(localStorage.getItem(SLOTS_KEY) || '{}');
      if (saved.A) state.A = saved.A;
      if (saved.B) state.B = saved.B;
    } catch (e) { /* ignore */ }

    function saveState() {
      localStorage.setItem(COLLAPSE_KEY, state.collapsed ? '1' : '0');
      localStorage.setItem(SLOTS_KEY, JSON.stringify({ A: state.A || null, B: state.B || null }));
    }

    let players = [];               // [{name, rating}]
    const byName = new Map();       // lowercased name -> {name, rating}

    // P(A beats B) on the Elo scale (divisor 400, matching the site).
    const winProb = (eloA, eloB) => 1 / (1 + Math.pow(10, (eloB - eloA) / 400));

    async function loadPlayers() {
      try {
        const res = await fetch(dataUrl('players.json'), { credentials: 'omit' });
        const data = await res.json();
        players = data
          .filter((p) => p && p.name != null && Number.isFinite(+p.rating))
          .map((p) => ({ name: p.name, rating: Math.round(+p.rating) }));
        byName.clear();
        for (const p of players) byName.set(p.name.toLowerCase(), p);
        log('loaded ' + players.length + ' players for head-to-head');
        fillDatalist();
        render();
      } catch (e) {
        console.error(TAG, 'failed to load players.json', e);
      }
    }

    function assign(slot, player) {
      if (!player || player.rating == null) return;
      state[slot] = { name: player.name, elo: player.rating };
      saveState();
      render();
    }

    // --- Click pickers on page rows -----------------------------------------
    function makePicker(getPlayer) {
      const w = document.createElement('span');
      w.className = 'jr-h2h-pick';
      ['A', 'B'].forEach((slot) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'jr-h2h-pill';
        b.textContent = slot;
        b.title = 'Set as player ' + slot + ' (head-to-head)';
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          assign(slot, getPlayer());
        });
        w.appendChild(b);
      });
      return w;
    }

    function attachPicker(host, getPlayer) {
      if (!host || host.dataset[PICK_ATTR]) return;
      host.dataset[PICK_ATTR] = '1';
      host.appendChild(makePicker(getPlayer));
    }

    // Look up a live rating by name (fallback to any Elo text on the row).
    function playerByName(name, fallbackElo) {
      const hit = byName.get((name || '').trim().toLowerCase());
      if (hit) return { name: hit.name, rating: hit.rating };
      if (Number.isFinite(fallbackElo)) return { name: (name || '').trim(), rating: fallbackElo };
      return null;
    }

    // Home rating list: #players tbody rows (name link + rating cell).
    function wireRatingList() {
      const tbody = document.querySelector('#players tbody');
      if (!tbody) return;
      for (const row of tbody.rows) {
        const link = row.querySelector('td a[href*="player/"]');
        if (!link) continue;
        const nameCell = link.closest('td');
        if (!nameCell) continue;
        const ratingCell = row.cells[row.cells.length - 1];
        const rating = parseInt((ratingCell && ratingCell.textContent || '').replace(/[^\d-]/g, ''), 10);
        attachPicker(nameCell, () =>
          playerByName(link.textContent, Number.isFinite(rating) ? rating : NaN));
      }
    }

    // Player page games table: each Black/White player cell + its Elo cell.
    function wireGamesTable() {
      const tbody = document.querySelector('#games tbody');
      if (!tbody) return;
      for (const row of tbody.rows) {
        // Columns: Date, Black, Elo, White, Elo, W/L, Result, Δ
        const pairs = [[1, 2], [3, 4]];
        for (const [nameIdx, eloIdx] of pairs) {
          const nameCell = row.cells[nameIdx];
          const eloCell = row.cells[eloIdx];
          if (!nameCell || nameCell.dataset[PICK_ATTR]) continue;
          const nameText = nameCell.textContent.trim();
          if (!nameText) continue;
          const elo = parseInt((eloCell && eloCell.textContent || '').replace(/[^\d-]/g, ''), 10);
          attachPicker(nameCell, () =>
            playerByName(nameText, Number.isFinite(elo) ? elo : NaN));
        }
      }
    }

    // --- Panel ---------------------------------------------------------------
    function ensurePanel() {
      let panel = document.getElementById(PANEL_ID);
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.innerHTML =
        '<div class="jr-h2h-head">' +
          '<span class="jr-h2h-title">Head-to-Head</span>' +
          '<span class="jr-h2h-actions">' +
            '<button type="button" class="jr-h2h-mini" data-act="swap" title="Swap A/B">\u21C4</button>' +
            '<button type="button" class="jr-h2h-mini" data-act="clear" title="Clear both">\u2715</button>' +
            '<button type="button" class="jr-h2h-mini" data-act="toggle" title="Collapse/expand">\u2013</button>' +
          '</span>' +
        '</div>' +
        '<div class="jr-h2h-body"></div>' +
        '<datalist id="jr-h2h-names"></datalist>';
      document.body.appendChild(panel);
      panel.querySelector('[data-act="swap"]').addEventListener('click', () => {
        const t = state.A; state.A = state.B; state.B = t; saveState(); render();
      });
      panel.querySelector('[data-act="clear"]').addEventListener('click', () => {
        delete state.A; delete state.B; saveState(); render();
      });
      panel.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        state.collapsed = !state.collapsed; saveState(); render();
      });
      return panel;
    }

    function fillDatalist() {
      const dl = document.getElementById('jr-h2h-names');
      if (!dl || !players.length || dl.childElementCount) return;
      const frag = document.createDocumentFragment();
      for (const p of players) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.label = String(p.rating);
        frag.appendChild(opt);
      }
      dl.appendChild(frag);
    }

    function onSearchInput(slot, e) {
      const p = byName.get((e.target.value || '').trim().toLowerCase());
      if (p) assign(slot, p);
    }

    function render() {
      const panel = ensurePanel();
      panel.classList.toggle('jr-h2h-collapsed', !!state.collapsed);
      panel.querySelector('[data-act="toggle"]').textContent = state.collapsed ? '+' : '\u2013';
      const body = panel.querySelector('.jr-h2h-body');

      body.innerHTML =
        slotHtml('A') + slotHtml('B') + resultHtml();

      // Wire the two search inputs after (re)building the body.
      ['A', 'B'].forEach((slot) => {
        const inp = body.querySelector('.jr-h2h-input[data-slot="' + slot + '"]');
        if (inp) {
          inp.addEventListener('change', (e) => onSearchInput(slot, e));
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') onSearchInput(slot, e); });
        }
      });
    }

    function slotHtml(slot) {
      const p = state[slot];
      const filled = p && p.elo != null;
      return (
        '<div class="jr-h2h-slot">' +
          '<span class="jr-h2h-tag">' + slot + '</span>' +
          '<input class="jr-h2h-input" data-slot="' + slot + '" list="jr-h2h-names" ' +
            'placeholder="search player\u2026" value="' + (filled ? escapeHtml(p.name) : '') + '">' +
          '<span class="jr-h2h-elo">' + (filled ? p.elo : '') + '</span>' +
        '</div>'
      );
    }

    function resultHtml() {
      const a = state.A, b = state.B;
      if (a && b && a.elo != null && b.elo != null) {
        const pA = winProb(a.elo, b.elo);
        const pctA = Math.round(pA * 100);
        const pctB = 100 - pctA;
        return (
          '<div class="jr-h2h-bar">' +
            '<div class="jr-h2h-seg jr-h2h-segA" style="width:' + pA * 100 + '%">' +
              (pctA >= 12 ? pctA + '%' : '') + '</div>' +
            '<div class="jr-h2h-seg jr-h2h-segB" style="width:' + (100 - pA * 100) + '%">' +
              (pctB >= 12 ? pctB + '%' : '') + '</div>' +
          '</div>' +
          '<div class="jr-h2h-verdict">Expected W/L \u2014 <b>A</b> ' + pctA +
            '% &nbsp;\u2022&nbsp; <b>B</b> ' + pctB + '%</div>'
        );
      }
      return '<div class="jr-h2h-hint">Pick two players to see expected W/L.</div>';
    }

    function apply() {
      ensurePanel();
      if (!players.length) loadPlayers(); else { fillDatalist(); }
      wireRatingList();
      wireGamesTable();
      render();
    }

    function clearAll() { delete state.A; delete state.B; saveState(); render(); }

    return { apply, clearAll };
  })();

  // ===========================================================================
  // Styling
  // ===========================================================================
  function injectCss() {
    const css = `
      .jr-spoiler-bar {
        display: flex; justify-content: center; align-items: center;
        gap: 8px; margin: 12px auto; padding: 6px 10px; max-width: 95%;
      }
      .jr-btn {
        cursor: pointer; font-family: inherit; padding: 5px 14px;
        border: 1px solid rgba(128,128,128,0.5); border-radius: 6px;
        background: rgba(255,255,255,0.06); color: inherit; font-weight: 700;
      }
      .jr-btn:hover { background: rgba(255,255,255,0.14); }
      td.jr-mask.jr-mask-hidden { text-align: center; }
      .jr-mask-btn {
        display: inline-block; min-width: 3.2em; text-align: center; padding: 0 4px;
        cursor: pointer; border-radius: 4px; background: rgba(128,128,128,0.35);
        color: rgba(200,200,200,0.9); font-family: monospace; letter-spacing: 1px;
        user-select: none;
      }
      .jr-mask-btn:hover { background: rgba(128,128,128,0.6); color: #fff; }

      /* Head-to-Head click pills next to a player name */
      .jr-h2h-pick { display: inline-flex; gap: 2px; margin-left: 6px; vertical-align: middle;
        opacity: 0; transition: opacity .12s; }
      tr:hover .jr-h2h-pick, .jr-h2h-pick:hover { opacity: 1; }
      .jr-h2h-pill {
        font: bold 11px/1.4 monospace; min-width: 1.5em; padding: 0 4px;
        border: 1px solid #2e9e5b; border-radius: 3px; background: #dff5ec; color: #076;
        cursor: pointer;
      }
      .jr-h2h-pill:hover { background: #2e9e5b; color: #fff; }

      /* Head-to-Head floating panel */
      #jr-h2h {
        position: fixed; right: 14px; bottom: 14px; z-index: 99999; width: 300px;
        background: #1c2530; color: #e8eef5; border: 1px solid #3a4a5c;
        border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
        font: 13px/1.4 system-ui, sans-serif; overflow: hidden;
      }
      .jr-h2h-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; background: #232f3d; border-bottom: 1px solid #3a4a5c;
      }
      .jr-h2h-title { font-weight: 700; }
      .jr-h2h-actions { display: inline-flex; gap: 4px; }
      .jr-h2h-mini {
        width: 22px; height: 22px; padding: 0; line-height: 1; cursor: pointer;
        border: 1px solid #3a4a5c; border-radius: 4px; background: #2c3a4a; color: #cfe0f0;
      }
      .jr-h2h-mini:hover { background: #3a4a5c; }
      .jr-h2h-body { padding: 8px 10px; }
      #jr-h2h.jr-h2h-collapsed .jr-h2h-body { display: none; }
      .jr-h2h-slot { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
      .jr-h2h-tag {
        flex: 0 0 auto; width: 20px; height: 20px; border-radius: 4px; text-align: center;
        font-weight: 700; line-height: 20px; background: #3a4a5c; color: #fff;
      }
      .jr-h2h-input {
        flex: 1 1 auto; min-width: 0; padding: 3px 6px; border-radius: 4px;
        border: 1px solid #3a4a5c; background: #12191f; color: #e8eef5; font: inherit;
      }
      .jr-h2h-input:focus { outline: none; border-color: #9fd0ff; }
      .jr-h2h-elo { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: #9fd0ff; font-weight: 600; min-width: 2.6em; text-align: right; }
      .jr-h2h-bar {
        display: flex; height: 22px; margin: 8px 0 4px; border-radius: 4px; overflow: hidden;
        border: 1px solid #3a4a5c;
      }
      .jr-h2h-seg {
        display: flex; align-items: center; justify-content: center; min-width: 0;
        font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap;
      }
      .jr-h2h-segA { background: #2e9e5b; }
      .jr-h2h-segB { background: #d34b4b; }
      .jr-h2h-verdict { text-align: center; color: #cfe0f0; }
      .jr-h2h-hint { text-align: center; color: #7d8fa3; font-style: italic; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ===========================================================================
  // Bootstrap
  // ===========================================================================
  const spoilerOn = featureEnabled('spoiler', true);
  const h2hOn = featureEnabled('headtohead', true);

  function run() {
    if (spoilerOn) SPOILER.apply();
    if (h2hOn) HEADTOHEAD.apply();
  }

  injectCss();
  run();

  // The tables/panels are rendered by the page's own JS after fetching JSON.
  // Re-run (idempotent) only when relevant markup actually changes.
  let pending = false;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const hit = (n.matches && n.matches('table, tbody, tr, td')) ||
                    (n.querySelector && n.querySelector('td.result, td.delta, #players tbody tr, #games tbody tr'));
        if (hit && !pending) {
          pending = true;
          setTimeout(() => { pending = false; run(); }, 50);
          return;
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });

  if (typeof GM_registerMenuCommand === 'function') {
    if (spoilerOn) {
      GM_registerMenuCommand('Reveal all results', SPOILER.revealAll);
      GM_registerMenuCommand('Hide all results', SPOILER.hideAll);
    }
    GM_registerMenuCommand((spoilerOn ? 'Disable' : 'Enable') + ' spoiler hider', () => {
      setFeatureEnabled('spoiler', !spoilerOn); location.reload();
    });
    if (h2hOn) {
      GM_registerMenuCommand('Clear head-to-head slots', HEADTOHEAD.clearAll);
    }
    GM_registerMenuCommand((h2hOn ? 'Disable' : 'Enable') + ' head-to-head predictor', () => {
      setFeatureEnabled('headtohead', !h2hOn); location.reload();
    });
  }

  log('active — spoiler:' + (spoilerOn ? 'on' : 'off') +
      ' head-to-head:' + (h2hOn ? 'on' : 'off'));
})();
