// ==UserScript==
// @name         GoRatings Utils
// @namespace    https://github.com/TransientError
// @version      3.1
// @description  Utilities for goratings.org. (1) Spoiler hider: mask per-game Win/Loss results so you can check a player's WHR rating without spoiling a game you're watching. (2) Filter the rating list / game list by gender and nationality. (3) SGF copy: make kifu links that carry a downloadable .sgf (Nihon Kiin / cyberoro, incl. giboviewer links) copy the record to the clipboard instead of downloading a file or opening a viewer tab. (4) Head-to-Head: click players into A/B slots (from the rating list or a player page) to get the Elo-based expected W/L. Features are independently toggleable from the userscript menu.
// @author       TransientError
// @match        *://www.goratings.org/*
// @match        *://goratings.org/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      nihonkiin.or.jp
// @connect      cyberoro.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[GoRatings Utils]';
  const log = (...a) => console.log(TAG, ...a);

  const BAR_ID = 'gu-bar';
  const MALE = '\u2642';   // ♂
  const FEMALE = '\u2640'; // ♀

  // ===========================================================================
  // Feature enable flags (persisted). Toggle from the userscript menu; toggling
  // reloads the page so features apply/teardown cleanly.
  // ===========================================================================
  const featureEnabled = (id, dflt) => {
    const v = localStorage.getItem('gu-feat-' + id);
    return v === null ? dflt : v === '1';
  };
  const setFeatureEnabled = (id, on) => localStorage.setItem('gu-feat-' + id, on ? '1' : '0');

  // ===========================================================================
  // Shared DOM helpers
  // ===========================================================================

  // A "header row" is one whose cells are all <th> (and there are a few of
  // them). This distinguishes the game list / rating list (all-<th> header)
  // from the top Data / Statistics tables (interleaved <th>/<td> rows).
  const isHeaderRow = (row) => {
    if (!row.cells.length || row.cells.length < 4) return false;
    for (const c of row.cells) if (c.tagName !== 'TH') return false;
    return true;
  };

  // The primary table on the page: first table that has an all-<th> header row.
  // On player pages that's the Game List; on the index it's the Rating List.
  function findPrimaryTable() {
    for (const table of document.querySelectorAll('table')) {
      for (const row of table.rows) if (isHeaderRow(row)) return table;
    }
    return null;
  }

  const headerRowOf = (table) => {
    for (const row of table.rows) if (isHeaderRow(row)) return row;
    return null;
  };

  // Data rows = every row except the header (and any stray all-<th> rows).
  function bodyRows(table, headerRow) {
    const out = [];
    for (const row of table.rows) {
      if (row === headerRow) continue;
      if (row.cells.length && [...row.cells].every((c) => c.tagName === 'TH')) continue;
      out.push(row);
    }
    return out;
  }

  // Resolve a logical column index to the actual cell in a row, honoring colspan.
  function cellAtColumn(row, targetCol) {
    let col = 0;
    for (const cell of row.cells) {
      if (col === targetCol) return cell;
      col += cell.colSpan || 1;
    }
    return null;
  }

  // Per-row gender ('m' | 'f' | null) detected by the ♂/♀ glyph — works in any
  // language and on both the rating list and the game list (opponent column).
  function rowGender(row) {
    for (const td of row.cells) {
      const t = td.textContent || '';
      if (t.indexOf(MALE) !== -1) return 'm';
      if (t.indexOf(FEMALE) !== -1) return 'f';
    }
    return null;
  }

  // Per-row nationality as an ISO country code (e.g. 'kr'), from the flag <img>.
  function rowCountry(row) {
    const img = row.querySelector('td img[src*="/flags/"]');
    if (!img) return null;
    const m = /\/flags\/([a-z0-9-]+)\.svg/i.exec(img.getAttribute('src') || '');
    if (m) return m[1].toLowerCase();
    const alt = (img.getAttribute('alt') || '').trim(); // e.g. "kr flag"
    return alt ? alt.split(/\s+/)[0].toLowerCase() : null;
  }

  // Single shared control bar, anchored directly above the primary table (i.e.
  // right under its heading). Both features drop their controls in here.
  function controlBar(table) {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'gu-bar';
    table.parentNode.insertBefore(bar, table);
    return bar;
  }

  // ===========================================================================
  // Feature: Spoiler hider (mask the Win/Loss "Result" column)
  // ===========================================================================
  const SPOILER = (() => {
    const LS_KEY = 'gu-spoiler-hidden'; // "1" hide by default (default), "0" reveal
    const CELL_CLASS = 'gu-mask';
    const BTN_ID = 'gu-reveal-btn';
    const HOTKEY = { key: 'r', alt: true, shift: true }; // Alt+Shift+R toggles all

    // "Result" column header across the site's four languages.
    const RESULT_LABELS = new Set(['Result', '对局结果', '対局結果', '결과']);

    const hiddenByDefault = () => localStorage.getItem(LS_KEY) !== '0';
    const setHiddenByDefault = (v) => localStorage.setItem(LS_KEY, v ? '1' : '0');

    function resultColIndex(headerRow) {
      let col = 0;
      for (const cell of headerRow.cells) {
        if (RESULT_LABELS.has((cell.textContent || '').trim())) return col;
        col += cell.colSpan || 1;
      }
      return -1; // no Result column here (e.g. the rating list) -> no-op
    }

    function tagCell(el) {
      if (el.classList.contains(CELL_CLASS)) return;
      const text = (el.textContent || '').trim();
      if (!text) return;
      el.dataset.result = text;
      el.classList.add(CELL_CLASS);
    }

    // Fixed-width placeholder hides the result *length* too, so you can't infer
    // Win (3) vs Loss (4) from the shape.
    function renderHidden(el) {
      el.textContent = '';
      el.dataset.spoilerState = 'hidden';
      el.classList.add('gu-mask-hidden');
      const btn = document.createElement('span');
      btn.className = 'gu-mask-btn';
      btn.textContent = '••••';
      btn.title = 'Click to reveal result';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        revealCell(el);
      });
      el.appendChild(btn);
    }

    function renderRevealed(el) {
      el.dataset.spoilerState = 'shown';
      el.classList.remove('gu-mask-hidden');
      el.textContent = el.dataset.result || '';
    }

    const hideCell = (el) => { if (el.classList.contains(CELL_CLASS)) renderHidden(el); };
    const revealCell = (el) => { if (el.classList.contains(CELL_CLASS)) renderRevealed(el); };
    const eachCell = (fn) => document.querySelectorAll('.' + CELL_CLASS).forEach(fn);

    // Apply the default only to freshly-tagged cells, so an individually
    // revealed cell isn't re-hidden when the observer re-runs.
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

    function ensureButton(bar) {
      if (document.getElementById(BTN_ID)) { updateBtnLabel(); return; }
      const btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.className = 'gu-btn';
      btn.addEventListener('click', (e) => { e.preventDefault(); toggleAll(); });
      bar.appendChild(btn);
      updateBtnLabel();
    }

    function apply(bar, table, headerRow) {
      const col = resultColIndex(headerRow);
      if (col < 0) return; // nothing to hide on this page
      for (const row of bodyRows(table, headerRow)) {
        const cell = cellAtColumn(row, col);
        if (cell && cell.tagName === 'TD') tagCell(cell);
      }
      ensureButton(bar);
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
  // Feature: Filter by gender and nationality
  // ===========================================================================
  const FILTER = (() => {
    const GROUP_ID = 'gu-filter-group';
    const CLEAR_ID = 'gu-filter-clear';
    // Positive-selection semantics: empty set = show all; non-empty = show only.
    const selectedGenders = new Set();
    const selectedCountries = new Set();

    const toggleSet = (set, val) => (set.has(val) ? set.delete(val) : set.add(val));

    function applyFilter(table, headerRow) {
      for (const row of bodyRows(table, headerRow)) {
        const g = rowGender(row);
        const c = rowCountry(row);
        const okG = selectedGenders.size === 0 || (g && selectedGenders.has(g));
        const okC = selectedCountries.size === 0 || (c && selectedCountries.has(c));
        row.style.display = okG && okC ? '' : 'none';
      }
      updateStates();
    }

    function updateStates() {
      const grp = document.getElementById(GROUP_ID);
      if (!grp) return;
      grp.querySelectorAll('[data-gender]').forEach((b) =>
        b.classList.toggle('gu-on', selectedGenders.has(b.dataset.gender)));
      grp.querySelectorAll('[data-country]').forEach((b) =>
        b.classList.toggle('gu-on', selectedCountries.has(b.dataset.country)));
      const clear = document.getElementById(CLEAR_ID);
      if (clear) clear.style.display = (selectedGenders.size || selectedCountries.size) ? '' : 'none';
    }

    function genderButton(g, table, headerRow) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gu-gender';
      b.dataset.gender = g;
      b.textContent = g === 'm' ? MALE : FEMALE;
      b.style.color = g === 'm' ? '#0295FF' : '#FE0097';
      b.title = (g === 'm' ? 'Male' : 'Female') + ' — click to filter';
      b.addEventListener('click', () => { toggleSet(selectedGenders, g); applyFilter(table, headerRow); });
      return b;
    }

    function countryButton(c, table, headerRow) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gu-flag';
      b.dataset.country = c;
      b.title = c.toUpperCase() + ' — click to filter';
      const img = document.createElement('img');
      img.src = '/flags/' + c + '.svg';
      img.alt = c;
      b.appendChild(img);
      b.addEventListener('click', () => { toggleSet(selectedCountries, c); applyFilter(table, headerRow); });
      return b;
    }

    function apply(bar, table, headerRow) {
      if (document.getElementById(GROUP_ID)) { applyFilter(table, headerRow); return; }

      const rows = bodyRows(table, headerRow);
      const genders = new Set();
      const countries = [];
      const seen = new Set();
      for (const row of rows) {
        const g = rowGender(row);
        if (g) genders.add(g);
        const c = rowCountry(row);
        if (c && !seen.has(c)) { seen.add(c); countries.push(c); }
      }
      if (!genders.size && !countries.length) return; // nothing filterable here
      countries.sort();

      const group = document.createElement('span');
      group.id = GROUP_ID;
      group.className = 'gu-group';

      const label = document.createElement('span');
      label.className = 'gu-label';
      label.textContent = 'Filter:';
      group.appendChild(label);

      ['m', 'f'].forEach((g) => { if (genders.has(g)) group.appendChild(genderButton(g, table, headerRow)); });
      countries.forEach((c) => group.appendChild(countryButton(c, table, headerRow)));

      const clear = document.createElement('button');
      clear.id = CLEAR_ID;
      clear.type = 'button';
      clear.className = 'gu-btn';
      clear.textContent = 'Clear';
      clear.style.display = 'none';
      clear.addEventListener('click', () => {
        selectedGenders.clear();
        selectedCountries.clear();
        applyFilter(table, headerRow);
      });
      group.appendChild(clear);

      bar.appendChild(group);
      applyFilter(table, headerRow);
    }

    return { apply };
  })();

  // ===========================================================================
  // Feature: Head-to-Head expected W/L (click players into A vs B slots)
  // ===========================================================================
  // Fill two slots by clicking the little "A"/"B" pills that appear next to any
  // player (rating-list rows on the index, or the player + their opponents on a
  // player page). State is persisted in localStorage so you can pick A on one
  // page, navigate to another player, and pick B there. Win probability uses the
  // standard Elo logistic (divisor 400), matching the site's rating scale.
  const HEADTOHEAD = (() => {
    const PANEL_ID = 'gu-h2h';
    const PICK_ATTR = 'guH2hPicked';

    // Slots are intentionally NOT persisted across navigation — each page starts
    // fresh (on a player page, that player auto-fills A). Only the collapse
    // preference is remembered.
    const COLLAPSE_KEY = 'gu-h2h-collapsed';
    let state = { collapsed: localStorage.getItem(COLLAPSE_KEY) === '1' };
    const saveState = () => localStorage.setItem(COLLAPSE_KEY, state.collapsed ? '1' : '0');

    const parseElo = (txt) => {
      const m = /-?\d{3,4}/.exec((txt || '').replace(/[,\s]/g, ''));
      return m ? parseInt(m[0], 10) : null;
    };

    // P(A beats B) on the Elo scale.
    const winProb = (eloA, eloB) => 1 / (1 + Math.pow(10, (eloB - eloA) / 400));

    function assign(slot, player) {
      if (!player || player.elo == null) return;
      state[slot] = { name: player.name, elo: player.elo };
      saveState();
      render();
    }

    function makePicker(getPlayer) {
      const w = document.createElement('span');
      w.className = 'gu-h2h-pick';
      ['A', 'B'].forEach((slot) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gu-h2h-pill';
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

    // Attach a picker into `host` exactly once, sourcing the player lazily so
    // the Elo is read at click time.
    function attachPicker(host, getPlayer) {
      if (!host || host.dataset[PICK_ATTR]) return;
      host.dataset[PICK_ATTR] = '1';
      host.appendChild(makePicker(getPlayer));
    }

    // --- Wiring: index rating list ------------------------------------------
    function wireRatingList(table, headerRow) {
      for (const row of bodyRows(table, headerRow)) {
        const link = row.querySelector('a[href*="players/"]');
        if (!link) continue;
        const nameCell = link.closest('td');
        if (!nameCell) continue;
        // Elo is the last integer-bearing cell on the row.
        let eloCell = null;
        for (const c of row.cells) if (parseElo(c.textContent) != null) eloCell = c;
        if (!eloCell || eloCell === nameCell) continue;
        attachPicker(nameCell, () => ({
          name: link.textContent.trim(),
          elo: parseElo(eloCell.textContent),
        }));
      }
    }

    // --- Wiring: player page (self + opponents) -----------------------------
    function wirePlayerPage() {
      const h1 = document.querySelector('h1');
      const table = findPrimaryTable();
      const headerRow = table && headerRowOf(table);
      const rows = table && headerRow ? bodyRows(table, headerRow) : [];

      // Self: current Elo = most recent game's Rating cell (column index 1).
      if (h1 && rows.length) {
        const selfEloCell = rows[0].cells[1];
        const getSelf = () => ({
          name: h1.textContent.replace(/[AB]{2}$/, '').trim(),
          elo: parseElo(selfEloCell && selfEloCell.textContent),
        });
        attachPicker(h1, getSelf);
        // Default the player themselves into slot A.
        if (!state.A) {
          const self = getSelf();
          if (self.elo != null) state.A = self;
        }
      }

      // Opponents: relative "<id>.html" link, Elo in the immediately-following cell.
      for (const row of rows) {
        const link = row.querySelector('td a[href$=".html"]:not([href^="http"])');
        if (!link) continue;
        const nameCell = link.closest('td');
        const eloCell = nameCell && nameCell.nextElementSibling;
        if (!eloCell) continue;
        attachPicker(nameCell, () => ({
          name: link.textContent.trim(),
          elo: parseElo(eloCell.textContent),
        }));
      }
    }

    // --- Panel ---------------------------------------------------------------
    function ensurePanel() {
      let panel = document.getElementById(PANEL_ID);
      if (panel) return panel;
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.innerHTML =
        '<div class="gu-h2h-head">' +
          '<span class="gu-h2h-title">Head-to-Head</span>' +
          '<span class="gu-h2h-actions">' +
            '<button type="button" class="gu-h2h-mini" data-act="swap" title="Swap A/B">\u21C4</button>' +
            '<button type="button" class="gu-h2h-mini" data-act="clear" title="Clear both">\u2715</button>' +
            '<button type="button" class="gu-h2h-mini" data-act="toggle" title="Collapse/expand">\u2013</button>' +
          '</span>' +
        '</div>' +
        '<div class="gu-h2h-body"></div>';
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

    function slotHtml(slot) {
      const p = state[slot];
      const filled = p && p.elo != null;
      return (
        '<div class="gu-h2h-slot' + (filled ? '' : ' gu-h2h-empty') + '">' +
          '<span class="gu-h2h-tag">' + slot + '</span>' +
          '<span class="gu-h2h-name">' + (filled ? escapeHtml(p.name) : 'click a player\u2026') + '</span>' +
          '<span class="gu-h2h-elo">' + (filled ? p.elo : '') + '</span>' +
        '</div>'
      );
    }

    const escapeHtml = (s) => (s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function render() {
      const panel = ensurePanel();
      panel.classList.toggle('gu-h2h-collapsed', !!state.collapsed);
      panel.querySelector('[data-act="toggle"]').textContent = state.collapsed ? '+' : '\u2013';
      const body = panel.querySelector('.gu-h2h-body');

      let html = slotHtml('A') + slotHtml('B');
      const a = state.A, b = state.B;
      if (a && b && a.elo != null && b.elo != null) {
        const pA = winProb(a.elo, b.elo);
        const pctA = Math.round(pA * 100);
        const pctB = 100 - pctA;
        html +=
          '<div class="gu-h2h-bar">' +
            '<div class="gu-h2h-seg gu-h2h-segA" style="width:' + pA * 100 + '%">' +
              (pctA >= 12 ? pctA + '%' : '') + '</div>' +
            '<div class="gu-h2h-seg gu-h2h-segB" style="width:' + (100 - pA * 100) + '%">' +
              (pctB >= 12 ? pctB + '%' : '') + '</div>' +
          '</div>' +
          '<div class="gu-h2h-verdict">Expected W/L \u2014 <b>A</b> ' + pctA +
            '% &nbsp;\u2022&nbsp; <b>B</b> ' + pctB + '%</div>';
      } else {
        html += '<div class="gu-h2h-hint">Pick two players to see expected W/L.</div>';
      }
      body.innerHTML = html;
    }

    function apply() {
      ensurePanel();
      if (/\/players\/\d+/.test(location.pathname)) {
        wirePlayerPage();
      } else {
        const table = findPrimaryTable();
        const headerRow = table && headerRowOf(table);
        if (table && headerRow && table.querySelector('a[href*="players/"]')) {
          wireRatingList(table, headerRow);
        }
      }
      render();
    }

    function clearAll() { delete state.A; delete state.B; saveState(); render(); }

    return { apply, clearAll };
  })();

  // ===========================================================================
  // Feature: SGF copy (kifu links -> copy record to clipboard)
  // ===========================================================================
  // goratings' Kifu column links point at three kinds of targets:
  //   - Nihon Kiin direct .sgf .......... downloads a file
  //   - giboviewer.asp?...gibo=<.sgf> ... opens a viewer tab (Nihon Kiin / cyberoro)
  //   - go4go /sgfview/NNN .............. a viewer page, no .sgf reachable
  // We take over only links from which a real .sgf URL is extractable (the first
  // two), fetch it cross-origin, decode it, and copy it. go4go links are left
  // completely untouched.
  const SGFCOPY = (() => {
    const FLASH_MS = 1400;

    const httpsify = (u) => u.replace(/^http:\/\//i, 'https://');

    // Return an https .sgf URL extractable from an anchor href, or null.
    function extractSgfUrl(href) {
      let u;
      try { u = new URL(href, location.href); } catch (e) { return null; }
      if (/\.sgf$/i.test(u.pathname)) return httpsify(u.href); // direct .sgf file
      for (const v of u.searchParams.values()) {               // viewer ?gibo=<sgf>
        const m = /(https?:\/\/[^\s&]+?\.sgf)/i.exec(v);
        if (m) return httpsify(m[1]);
      }
      return null;
    }

    // These "application/gibo" files carry no charset. Names/events are in the
    // publisher's legacy encoding; decode by host so they aren't mojibake.
    function charsetFor(host) {
      host = (host || '').toLowerCase();
      if (host.indexOf('nihonkiin') !== -1) return 'shift_jis';
      if (host.indexOf('cyberoro') !== -1) return 'euc-kr';
      return 'utf-8';
    }

    function decode(buf, host) {
      const bytes = new Uint8Array(buf);
      try { return new TextDecoder(charsetFor(host)).decode(bytes); }
      catch (e) { return new TextDecoder('utf-8').decode(bytes); }
    }

    // Cross-origin fetch: goratings' targets send no CORS headers, so a plain
    // fetch() is blocked — GM_xmlhttpRequest (with @connect) is required.
    function fetchArrayBuffer(url) {
      return new Promise((resolve, reject) => {
        const xhr = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
          : (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
        if (!xhr) { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
        xhr({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout: 20000,
          onload: (r) => (r.status >= 200 && r.status < 300)
            ? resolve(r.response)
            : reject(new Error('HTTP ' + r.status + ' for ' + url)),
          onerror: () => reject(new Error('network error for ' + url)),
          ontimeout: () => reject(new Error('timeout for ' + url)),
        });
      });
    }

    // Clipboard, Chrome + Wayland friendly. The GM_xmlhttpRequest callback runs
    // after the click's user-activation lapses, so navigator.clipboard /
    // execCommand may fail; GM_setClipboard is the reliable fallback.
    async function toClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); return 'navigator.clipboard'; }
        catch (e) { log('navigator.clipboard failed', e && e.name); }
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
      } catch (e) { log('execCommand failed', e); }
      // Pass the mimetype as a STRING so a proper text/plain target is written
      // (an options object makes some managers write a mangled blob).
      if (typeof GM_setClipboard === 'function') {
        try { GM_setClipboard(text, 'text/plain'); return 'GM_setClipboard'; }
        catch (e) { log('GM_setClipboard failed', e); }
      }
      throw new Error('no clipboard method available');
    }

    function flash(a, msg, ok) {
      if (!('sgfOriginal' in a.dataset)) a.dataset.sgfOriginal = a.textContent;
      a.textContent = msg;
      a.style.outline = '2px solid ' + (ok ? '#2e7d32' : '#c62828');
      a.style.borderRadius = '3px';
      clearTimeout(a._sgfTimer);
      a._sgfTimer = setTimeout(() => {
        a.textContent = a.dataset.sgfOriginal;
        a.style.outline = '';
      }, FLASH_MS);
    }

    async function handleClick(e) {
      const a = e.currentTarget;
      const sgfUrl = a.dataset.guSgfUrl;
      if (!sgfUrl) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const buf = await fetchArrayBuffer(sgfUrl);
        const text = decode(buf, new URL(sgfUrl).host).trim();
        if (!text) throw new Error('empty record');
        const method = await toClipboard(text);
        log('copied ' + text.length + ' chars from ' + sgfUrl + ' via ' + method);
        flash(a, '\u2713 copied', true);
      } catch (err) {
        console.error(TAG, err);
        flash(a, '\u2717 failed', false);
      }
    }

    function wire() {
      let n = 0;
      document.querySelectorAll('a[href]').forEach((a) => {
        if (a.dataset.guSgfWired) return;
        const sgfUrl = extractSgfUrl(a.href);
        if (!sgfUrl) return; // not an SGF-bearing link (e.g. go4go) -> leave alone
        a.dataset.guSgfWired = '1';
        a.dataset.guSgfUrl = sgfUrl;
        a.title = 'Click to copy SGF to clipboard';
        a.classList.add('gu-sgf-link');
        a.addEventListener('click', handleClick);
        n++;
      });
      if (n) log('wired ' + n + ' SGF link(s)');
    }

    return { wire };
  })();

  // ===========================================================================
  // Styling
  // ===========================================================================
  function injectCss() {
    const css = `
      .gu-bar {
        display: flex; flex-wrap: wrap; justify-content: center; align-items: center;
        gap: 8px; margin: 8px auto; padding: 6px 10px; max-width: 95%;
        background: #eee; border: 1px solid #ccc; border-radius: 4px; font-size: 14px;
      }
      .gu-group { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
      .gu-label { font-weight: bold; color: #333; margin-right: 2px; }
      .gu-bar button { cursor: pointer; font-family: inherit; }
      .gu-btn {
        padding: 3px 10px; border: 1px solid #bbb; border-radius: 3px;
        background: #fff; color: #333;
      }
      .gu-btn:hover { background: #f5f5f5; }
      .gu-gender {
        min-width: 1.9em; font-size: 1.1em; line-height: 1; padding: 2px 6px;
        border: 1px solid #bbb; border-radius: 3px; background: #fff;
      }
      .gu-flag {
        padding: 2px 3px; border: 1px solid #bbb; border-radius: 3px;
        background: #fff; display: inline-flex; align-items: center;
      }
      .gu-flag img { height: 1.1em; display: block; }
      .gu-on { outline: 2px solid #0a7; border-color: #0a7; background: #dff5ec; }
      td.gu-mask.gu-mask-hidden { text-align: center; }
      .gu-mask-btn {
        display: inline-block; min-width: 3.2em; text-align: center; padding: 0 4px;
        cursor: pointer; border-radius: 3px; background: #ccc; color: #666;
        font-family: monospace; letter-spacing: 1px; user-select: none;
      }
      .gu-mask-btn:hover { background: #bbb; color: #000; }
      a.gu-sgf-link { text-decoration: underline dotted; text-underline-offset: 2px; }

      /* Head-to-Head pick pills (inline next to a player name / h1) */
      .gu-h2h-pick { display: inline-flex; gap: 2px; margin-left: 6px; vertical-align: middle;
        opacity: 0; transition: opacity .12s; }
      tr:hover .gu-h2h-pick, h1:hover .gu-h2h-pick, .gu-h2h-pick:hover { opacity: 1; }
      .gu-h2h-pill {
        font: bold 11px/1.4 monospace; min-width: 1.5em; padding: 0 4px;
        border: 1px solid #0a7; border-radius: 3px; background: #dff5ec; color: #076;
      }
      .gu-h2h-pill:hover { background: #0a7; color: #fff; }
      h1 .gu-h2h-pick { opacity: .55; }

      /* Head-to-Head floating panel */
      #gu-h2h {
        position: fixed; right: 14px; bottom: 14px; z-index: 99999; width: 280px;
        background: #1c2530; color: #e8eef5; border: 1px solid #3a4a5c;
        border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,.4);
        font: 13px/1.4 system-ui, sans-serif; overflow: hidden;
      }
      .gu-h2h-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; background: #232f3d; border-bottom: 1px solid #3a4a5c;
      }
      .gu-h2h-title { font-weight: 700; }
      .gu-h2h-actions { display: inline-flex; gap: 4px; }
      .gu-h2h-mini {
        width: 22px; height: 22px; padding: 0; line-height: 1; cursor: pointer;
        border: 1px solid #3a4a5c; border-radius: 4px; background: #2c3a4a; color: #cfe0f0;
      }
      .gu-h2h-mini:hover { background: #3a4a5c; }
      .gu-h2h-body { padding: 8px 10px; }
      #gu-h2h.gu-h2h-collapsed .gu-h2h-body { display: none; }
      .gu-h2h-slot {
        display: flex; align-items: center; gap: 8px; padding: 4px 0;
      }
      .gu-h2h-tag {
        flex: 0 0 auto; width: 20px; height: 20px; border-radius: 4px; text-align: center;
        font-weight: 700; line-height: 20px; background: #3a4a5c; color: #fff;
      }
      .gu-h2h-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .gu-h2h-empty .gu-h2h-name { color: #7d8fa3; font-style: italic; }
      .gu-h2h-elo { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: #9fd0ff; font-weight: 600; }
      .gu-h2h-bar {
        display: flex; height: 22px; margin: 8px 0 4px; border-radius: 4px; overflow: hidden;
        border: 1px solid #3a4a5c;
      }
      .gu-h2h-seg {
        display: flex; align-items: center; justify-content: center; min-width: 0;
        font-size: 11px; font-weight: 700; color: #fff; white-space: nowrap;
      }
      .gu-h2h-segA { background: #2e9e5b; }
      .gu-h2h-segB { background: #d34b4b; }
      .gu-h2h-verdict { text-align: center; color: #cfe0f0; }
      .gu-h2h-hint { text-align: center; color: #7d8fa3; font-style: italic; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ===========================================================================
  // Bootstrap
  // ===========================================================================
  const spoilerOn = featureEnabled('spoiler', true);
  const filterOn = featureEnabled('filter', true);
  const sgfcopyOn = featureEnabled('sgfcopy', true);
  const h2hOn = featureEnabled('headtohead', true);

  function run() {
    if (sgfcopyOn) SGFCOPY.wire(); // kifu links live in the game list rows
    if (h2hOn) HEADTOHEAD.apply(); // works on index (rating list) and player pages

    const table = findPrimaryTable();
    if (!table) return;
    const headerRow = headerRowOf(table);
    if (!headerRow) return;

    const bar = controlBar(table);
    if (filterOn) FILTER.apply(bar, table, headerRow);
    if (spoilerOn) SPOILER.apply(bar, table, headerRow);

    if (!bar.children.length) bar.remove(); // nothing to show on this page
  }

  injectCss();
  run();

  // goratings is server-rendered; the d3 graph mutates the DOM. Re-run (idempotent)
  // only when table markup actually changes.
  let pending = false;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const hit = (n.matches && n.matches('table, tr, td, th')) ||
                    (n.querySelector && n.querySelector('table, tr, td'));
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
    GM_registerMenuCommand((filterOn ? 'Disable' : 'Enable') + ' gender/nationality filter', () => {
      setFeatureEnabled('filter', !filterOn); location.reload();
    });
    GM_registerMenuCommand((sgfcopyOn ? 'Disable' : 'Enable') + ' SGF copy on kifu links', () => {
      setFeatureEnabled('sgfcopy', !sgfcopyOn); location.reload();
    });
    if (h2hOn) {
      GM_registerMenuCommand('Clear head-to-head slots', HEADTOHEAD.clearAll);
    }
    GM_registerMenuCommand((h2hOn ? 'Disable' : 'Enable') + ' head-to-head predictor', () => {
      setFeatureEnabled('headtohead', !h2hOn); location.reload();
    });
  }

  log('active — spoiler:' + (spoilerOn ? 'on' : 'off') +
      ' filter:' + (filterOn ? 'on' : 'off') +
      ' sgfcopy:' + (sgfcopyOn ? 'on' : 'off') +
      ' headtohead:' + (h2hOn ? 'on' : 'off'));
})();
