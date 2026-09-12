/* scope.js — "what's in the brain". Reads /api/scope once, renders four verdict buckets and two
   sortable, searchable tables. Every number on this page comes from that payload; nothing is typed
   here. With JS off the page shows the as-of rule and an honest "needs the console server" line. */
(function () {
  'use strict';

  /* ── theme toggle — same key and mechanism as the console ───────────────── */
  var KEY = 'rbc-theme';
  var btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', function () {
      var t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem(KEY, t); } catch (e) { /* private mode is fine */ }
    });
  }

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var day = function (iso) { return iso ? String(iso).slice(0, 10) : null; };
  var BUCKET = {
    current:      { cls: 'b-current',    label: 'in the brain · current' },
    behind:       { cls: 'b-behind',     label: 'in the brain · behind' },
    unverified:   { cls: 'b-unverified', label: 'in the brain · currency unverified' },
    'not-in-brain': { cls: 'b-notin',    label: 'not in the brain' }
  };
  var RANK = { current: 0, behind: 1, unverified: 2, 'not-in-brain': 3 };            // column sort on "verdict"
  var RANK_BEHIND = { behind: 0, unverified: 1, 'not-in-brain': 2, current: 3 };     // the "Behind first" view

  /* ── three views + one search, as pure functions (owner, 2026-09-12: "alphabetically, or
     thematically, or by date"). Published on window.RBScope so the page and its test share them. ── */
  function byName(a, b) {
    return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
  }
  function newestFirst(a, b) {
    var x = a.ruvChangedAt, y = b.ruvChangedAt;
    if (x == null && y == null) return byName(a, b);
    if (x == null) return 1;   // unknown dates sink to the bottom
    if (y == null) return -1;
    return x < y ? 1 : x > y ? -1 : byName(a, b);
  }
  /** Which comparator a named view uses. An unknown view reads as "newest", never throws. */
  function sortFor(view) {
    if (view === 'az') return byName;
    if (view === 'behind') {
      return function (a, b) {
        var ra = RANK_BEHIND[a.bucket], rb = RANK_BEHIND[b.bucket];
        var d = (ra == null ? 9 : ra) - (rb == null ? 9 : rb);
        return d !== 0 ? d : newestFirst(a, b);
      };
    }
    return newestFirst;
  }
  /** Does a row answer the query — by name, or by what it does (desc)? An empty query matches everything. */
  function match(row, q) {
    var needle = String(q == null ? '' : q).trim().toLowerCase();
    if (!needle) return true;
    return String(row.name || '').toLowerCase().indexOf(needle) !== -1
      || String(row.desc || '').toLowerCase().indexOf(needle) !== -1;
  }
  window.RBScope = { match: match, sortFor: sortFor };

  var VIEW_SORT = { newest: ['ruvChangedAt', 'desc'], az: ['name', 'asc'], behind: ['bucket', 'asc'] };
  var state = { data: null, q: '', view: 'newest', sort: { repos: ['ruvChangedAt', 'desc'], gists: ['ruvChangedAt', 'desc'] } };

  function cmp(key, dir) {
    var m = dir === 'asc' ? 1 : -1;
    return function (a, b) {
      var x = a[key], y = b[key];
      if (key === 'bucket') { x = RANK[x]; y = RANK[y]; }
      // unknown dates always sink to the bottom, whichever direction is chosen
      if (x == null && y == null) return a.name.localeCompare(b.name);
      if (x == null) return 1;
      if (y == null) return -1;
      if (x < y) return -1 * m;
      if (x > y) return 1 * m;
      return a.name.localeCompare(b.name);
    };
  }

  function rowHtml(r) {
    var b = BUCKET[r.bucket] || BUCKET.unverified;
    var gap = r.bucket === 'behind' && r.behindDays != null ? '<span class="gap">behind ' + r.behindDays + ' d</span>' : '';
    var d1 = day(r.ruvChangedAt), d2 = day(r.brainReadAt);
    return '<tr>' +
      '<td class="name"><a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.name) + '</a>' +
        (r.desc ? '<small class="desc" title="' + esc(r.desc) + '">' + esc(r.desc) + '</small>' : '') + '</td>' +
      '<td class="date' + (d1 ? '' : ' unknown') + '">' + (d1 || 'unknown') + '</td>' +
      '<td class="date' + (d2 ? '' : ' unknown') + '">' + (d2 || (r.bucket === 'not-in-brain' ? '—' : 'unknown')) + '</td>' +
      '<td class="verdict"><span class="badge ' + b.cls + '">' + b.label + '</span>' + gap + '</td>' +
      '<td class="sha" title="brain holds ' + esc(r.brainSha || '—') + ' · upstream ' + esc(r.upstreamSha || '—') + '">' +
        esc((r.brainSha || '—').slice(0, 7)) + ' → ' + esc((r.upstreamSha || '—').slice(0, 7)) + '</td>' +
    '</tr>';
  }

  function renderTable(kind) {
    var rows = state.data[kind] || [];
    var q = state.q.trim().toLowerCase();
    if (q) rows = rows.filter(function (r) { return match(r, q); });
    var s = state.sort[kind];
    // a named view sorts both tables the same way; a column click switches to a per-table sort
    rows = rows.slice().sort(state.view === 'custom' ? cmp(s[0], s[1]) : sortFor(state.view));
    var body = $(kind + '-body');
    var t0 = performance.now();
    body.innerHTML = rows.length ? rows.map(rowHtml).join('') : '<tr><td colspan="5" class="empty">no ' + kind + ' match “' + esc(state.q) + '”</td></tr>';
    $(kind + '-count').textContent = rows.length + (q ? ' of ' + (state.data[kind] || []).length : '');
    var ths = $(kind + '-table').querySelectorAll('thead th[data-key]');
    for (var i = 0; i < ths.length; i++) {
      var k = ths[i].getAttribute('data-key');
      ths[i].setAttribute('aria-sort', k === s[0] ? (s[1] === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    if (window.console && rows.length > 200) console.debug('[scope] rendered', kind, rows.length, 'rows in', Math.round(performance.now() - t0), 'ms');
  }

  function renderBuckets(d) {
    var c = d.counts || {};
    var r = c.repos || {}, g = c.gists || {};
    var tile = function (cls, key, label, desc) {
      var n = (r[key] || 0) + (g[key] || 0);
      return '<div class="bucket ' + cls + '"><div class="n">' + n + '<small>' + (r[key] || 0) + ' repos · ' + (g[key] || 0) + ' gists</small></div>' +
        '<div class="l">' + label + '</div><div class="d">' + desc + '</div></div>';
    };
    $('buckets').innerHTML =
      tile('b-current', 'current', 'in the brain · current', 'The brain holds exactly the commit (or gist revision) that is live upstream.') +
      tile('b-behind', 'behind', 'in the brain · behind', 'rUv changed it after the brain last read it. The gap is shown per row.') +
      tile('b-unverified', 'unverified', 'in the brain · unverified', 'Installed here, but no source commit was recorded, so currency cannot be proven either way.') +
      tile('b-notin', 'notInBrain', 'not in the brain', 'Eligible upstream, no store on this machine.');
    var inel = (r.ineligible || 0) + (g.ineligible || 0);
    var foot = [];
    if (inel) foot.push(inel + ' upstream item' + (inel === 1 ? '' : 's') + ' excluded by policy (forks, archived, empty) — not counted above');
    if (d.installedOutsideCoverage && d.installedOutsideCoverage.length) {
      foot.push(d.installedOutsideCoverage.length + ' store' + (d.installedOutsideCoverage.length === 1 ? '' : 's') + ' installed locally, outside release coverage: <code>' + d.installedOutsideCoverage.map(esc).join('</code>, <code>') + '</code>');
    }
    $('bucket-foot').innerHTML = foot.join(' · ');
  }

  function renderAsOf(d) {
    var el = $('asof');
    var age = d.ageDays == null ? null : Math.round(d.ageDays);
    el.className = 'asof' + (d.stale ? ' is-old' : '');
    el.innerHTML = '<span class="dot"></span>as of <strong>' + esc(day(d.observedAt) || 'unknown') + '</strong>' +
      (age == null ? '' : ' · ' + age + ' day' + (age === 1 ? '' : 's') + ' ago') +
      (d.releaseTag ? ' · brain ' + esc(d.releaseTag) : '') +
      ' · ' + (d.installedStoreCount != null ? d.installedStoreCount + ' stores installed' : '');
    $('asof-note').textContent = d.stale
      ? 'This is the coverage record that shipped with the installed brain, not a live probe. Repos rUv changed since this date are not reflected until the brain updates.'
      : 'This is the coverage record that shipped with the installed brain.';
  }

  function render() {
    var d = state.data;
    renderAsOf(d); renderBuckets(d); renderTable('repos'); renderTable('gists');
    $('foot-root').textContent = d.root || '';
  }

  function setView(view) {
    state.view = view;
    var buttons = document.querySelectorAll('.scope-views .view');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].getAttribute('data-view') === view ? 'true' : 'false');
    }
    if (VIEW_SORT[view]) { state.sort.repos = VIEW_SORT[view].slice(); state.sort.gists = VIEW_SORT[view].slice(); }
    renderTable('repos'); renderTable('gists');
  }

  function wire() {
    $('search').addEventListener('input', function (e) { state.q = e.target.value; renderTable('repos'); renderTable('gists'); });
    var buttons = document.querySelectorAll('.scope-views .view');
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].addEventListener('click', function (ev) { setView(ev.currentTarget.getAttribute('data-view')); });
    }
    ['repos', 'gists'].forEach(function (kind) {
      var ths = $(kind + '-table').querySelectorAll('thead th[data-key]');
      for (var i = 0; i < ths.length; i++) {
        ths[i].addEventListener('click', function (ev) {
          var k = ev.currentTarget.getAttribute('data-key');
          var s = state.sort[kind];
          state.sort[kind] = [k, s[0] === k && s[1] === 'desc' ? 'asc' : 'desc'];
          state.view = 'custom'; // a column click is a per-table sort; no view button is pressed
          var vb = document.querySelectorAll('.scope-views .view');
          for (var j = 0; j < vb.length; j++) vb[j].setAttribute('aria-pressed', 'false');
          renderTable(kind);
        });
      }
    });
  }

  fetch('/api/scope', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    var st = $('state');
    if (!d || d.available === false) {
      st.className = 'state error';
      st.textContent = 'The installed brain has no coverage record on this machine' + (d && d.reason ? ' — ' + d.reason : '') + '. Nothing to list; nothing is being guessed.';
      return;
    }
    st.hidden = true;
    $('content').hidden = false;
    state.data = d;
    wire();
    render();
  }).catch(function (e) {
    var st = $('state');
    st.className = 'state error';
    st.textContent = 'Could not reach /api/scope on the console server: ' + (e && e.message ? e.message : e);
  });
})();
