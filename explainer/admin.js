// explainer/admin.js — the owner dashboard's whole brain. Split out of admin.html on 2026-07-22
// so `node --check` can actually validate it; inline <script> is invisible to every gate we run.
//
// REBUILT after the owner's verdict on v1: "a lot of dead data ... things that are static that
// aren't moving don't tell me a whole lot ... I'm getting lots of positive feedback and I don't see
// any of that showing up here." Both halves were true and both had the same root cause: the page
// rendered LIFETIME TOTALS. Lifetime totals are the one shape of number that cannot answer either
// "what changed?" or "who said something nice?" — stars/forks/watchers/openIssues moved perhaps
// once a week, so four of the biggest tiles on the page were, functionally, a static image.
//
// The rebuild's single organising rule: EVERY panel answers "what changed, and what do I do?"
// Totals survive only where they anchor a delta.
//
// ── Three correctness rules this file is built around, each earned the hard way ────────────────
//
// 1. UNKNOWN IS NOT ZERO. Every metric passes through metric() and comes out either {known:true}
//    or {known:false, why}. Unknown renders as "—" plus the reason, never as 0 and never as
//    "no change". This is the same class of bug as the detector that read a CLI's human-readable
//    table, failed to parse it, and reported "26 hooks off" while the learner held 457
//    trajectories. Here it is a live hazard, not a hypothetical: A failed stargazer request
//    can omit the list, so people.stargazers may arrive as []. An
//    empty list rendered as "0 people starred this" would be a flat lie — the metadata can still report stars.
//
// 2. NEVER DIFF A ROLLING WINDOW. The payload mixes two incompatible kinds of counter:
//      cumulative  — repo.stars, repo.forks, totalAssetDownloads, telemetry.totals.*  (monotonic;
//                    the difference between two readings is a real "since you last looked")
//      rolling     — traffic.clones/views (GitHub keeps 14 days), npm.lastWeek/lastMonth (a
//                    trailing 7/30-day window)
//    Subtracting two readings of a ROLLING counter yields a number with no meaning at all — it is
//    the difference between two different time windows, so it can fall while the project grows.
//    Rolling sources are therefore excluded from the "since your last visit" strip entirely, and
//    get momentum() instead: last 7 days vs the prior 7, computed inside the source's own daily
//    series, where both halves are equal-length windows and the comparison is honest.
//
// 3. NO CONTROL WITHOUT AN EXECUTOR AND AN UNDO. "Mark all reviewed" moves the baseline, so it
//    stashes the previous one and reveals a real "Undo mark reviewed" that restores it. A dead
//    button shipped on this project once already.

(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var TOKEN_STORE = 'rb-admin-token';
  var BASE_STORE = 'rb-admin-baseline';
  var BASE_PREV = 'rb-admin-baseline-prev';
  var DAY_MS = 86400000;

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  };
  var num = function (v) { return Number(v).toLocaleString(); };

  // Every href on this page is built from third-party data: issue titles and URLs are authored by
  // whoever opened the thread. esc() alone protects the attribute (it kills the quote), but it
  // would happily pass through `javascript:` — which still fires on click. So schemes are
  // allow-listed, not escaped. Today these URLs all come from GitHub's html_url and are safe by
  // construction; this is here so that stays true if the payload ever widens.
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    return /^https?:\/\//i.test(s) ? esc(s) : '#';
  }

  // Rule 1's enforcement point. Anything that is not a finite number is UNKNOWN with a reason the
  // UI is obliged to show — there is deliberately no path that turns absence into 0.
  function metric(raw, why) {
    // ABSENCE IS REJECTED BEFORE COERCION, not after. Number(null) === 0 and Number('') === 0,
    // and both sail straight through Number.isFinite — so the obvious `Number.isFinite(Number(x))`
    // shape reports a confident hard ZERO for a source that is merely absent. Caught live
    // 2026-07-22: with no KV store linked, `telemetry.totals` is null, `totals && totals.install`
    // evaluates to null, and the "opted-in installs" tile rendered "0" — a measurement claim about
    // an instrument that does not exist. undefined and NaN already fail isFinite; null and '' are
    // the two that need naming.
    if (raw === null || raw === undefined || raw === '') {
      return { known: false, why: why || 'no configured source provides this' };
    }
    var n = Number(raw);
    if (Number.isFinite(n)) return { known: true, v: n };
    return { known: false, why: why || 'no configured source provides this' };
  }

  // Bot authors are noise in a "how many humans care" count, and the server can't strip them —
  // admin-stats.mjs only excludes the owner. dependabot[bot] and github-actions[bot] have both
  // filed items on this repo, so without this the human count reads 2 too high.
  var BOT_RE = /\[bot\]$|^(dependabot|renovate|github-actions|codecov|greenkeeper|snyk-bot)$/i;
  var isBot = function (login) { return BOT_RE.test(String(login || '')); };

  var dayStr = function (d) { return new Date(d).toISOString().slice(0, 10); };
  var daysAgo = function (iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
  };
  function agoLabel(iso) {
    var d = daysAgo(iso);
    if (d == null) return 'undated';
    if (d === 0) return 'today';
    if (d === 1) return 'yesterday';
    if (d < 31) return d + 'd ago';
    return Math.floor(d / 30) + 'mo ago';
  }

  // Normalise any daily series to ASCENDING by date. The payload is inconsistent on purpose —
  // GitHub traffic and npm arrive oldest-first, telemetry.daily arrives newest-first — and trusting
  // the incoming order would silently invert every momentum arrow on one of the three.
  function ascend(rows, dateKey, valueKey) {
    if (!Array.isArray(rows)) return null;
    return rows
      .map(function (r) { return { t: Date.parse(r[dateKey]), v: Number(r[valueKey]) || 0 }; })
      .filter(function (r) { return Number.isFinite(r.t); })
      .sort(function (a, b) { return a.t - b.t; })
      .map(function (r) { return r.v; });
  }
  var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };

  // Rule 2's enforcement point: equal-length windows or nothing.
  function momentum(series) {
    if (!Array.isArray(series) || series.length < 4) return null;
    var recent = series.slice(-7);
    var prior = series.slice(-14, -7);
    if (!prior.length) return null;
    var r = sum(recent);
    var p = sum(prior);
    // Both windows must be the same length or the ratio is meaningless; scale the shorter one.
    var pScaled = prior.length === recent.length ? p : (p / prior.length) * recent.length;
    var dir = r > pScaled * 1.05 ? 'up' : r < pScaled * 0.95 ? 'down' : 'flat';
    var pct = pScaled > 0 ? Math.round(((r - pScaled) / pScaled) * 100) : null;
    return { recent: r, prior: Math.round(pScaled), dir: dir, pct: pct, series: series };
  }

  function sparkline(series, stroke) {
    if (!Array.isArray(series) || series.length < 2) return '';
    var max = Math.max.apply(null, series.concat([1]));
    var w = 120, h = 30;
    var pts = series.map(function (v, i) {
      return (i * (w / (series.length - 1))).toFixed(1) + ',' + (h - 2 - (v / max) * (h - 6)).toFixed(1);
    }).join(' ');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<polyline points="' + pts + '" fill="none" stroke="' + stroke + '" stroke-width="1.5" /></svg>';
  }

  // ── shaping the payload into humans + events ──────────────────────────────────────────────────

  // One stable id per thread so "have I seen this?" survives edits to the title or state.
  var itemId = function (it) { return (it.isPR ? 'p' : 'i') + it.number; };

  function shape(d) {
    var p = d.people || {};
    var contributors = (p.contributors || []).filter(function (c) { return !isBot(c.login); });
    var botItems = (p.contributors || []).filter(function (c) { return isBot(c.login); })
      .reduce(function (n, c) { return n + (c.items || []).length; }, 0);

    var forks = (p.forks || []).filter(function (f) { return !isBot(f.login); });

    // The feed: every DATED human event. Stars are deliberately absent — admin-stats.mjs maps
    // stargazers to bare logins, and the underlying call omits the star+json Accept header that
    // would carry starred_at, so a star has no date to place it on. Inventing one is not an option.
    var events = [];
    contributors.forEach(function (c) {
      (c.items || []).forEach(function (it) {
        events.push({
          id: itemId(it), kind: it.isPR ? 'PR' : 'issue', login: c.login,
          title: it.title, url: it.url, at: it.at, state: it.state
        });
      });
    });
    forks.forEach(function (f) {
      events.push({ id: 'f:' + f.login, kind: 'fork', login: f.login, title: 'forked the repo', url: 'https://github.com/' + f.login, at: f.at, state: null });
    });
    events.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });

    // Per-person roll-up, ranked by RECENCY. Someone who wrote yesterday outranks someone with more
    // lifetime issues who vanished three weeks ago — that ordering is the whole point of the panel.
    var people = contributors.map(function (c) {
      var dates = (c.items || []).map(function (i) { return i.at; }).filter(Boolean).sort();
      var forked = forks.filter(function (f) { return f.login === c.login; })[0];
      if (forked) dates = dates.concat([forked.at]).sort();
      return {
        login: c.login, issues: c.issues || 0, prs: c.prs || 0,
        open: (c.items || []).filter(function (i) { return i.state === 'open'; }).length,
        first: dates[0] || null, last: dates[dates.length - 1] || null,
        forked: Boolean(forked), association: c.association
      };
    });
    // Forkers who never filed anything are still humans who engaged — include them.
    forks.forEach(function (f) {
      if (!people.some(function (x) { return x.login === f.login; })) {
        people.push({ login: f.login, issues: 0, prs: 0, open: 0, first: f.at, last: f.at, forked: true, association: 'NONE' });
      }
    });
    people.sort(function (a, b) { return String(b.last || '').localeCompare(String(a.last || '')); });

    var queue = d.openWork || { available: false, note: 'Open-work source unavailable.' };
    var openItems = queue.available && Array.isArray(queue.items) ? queue.items : [];

    return { people: people, events: events, openItems: openItems, queue: queue, botItems: botItems, forks: forks };
  }

  // ── baseline (the "since you last looked" memory) ─────────────────────────────────────────────

  function readBaseline() {
    try { return JSON.parse(localStorage.getItem(BASE_STORE) || 'null'); } catch (e) { return null; }
  }
  // Only CUMULATIVE counters go in. See rule 2 at the top — rolling windows are excluded on purpose.
  function snapshot(d, s) {
    return {
      at: new Date().toISOString(),
      ids: s.events.map(function (e) { return e.id; }),
      people: s.people.map(function (p) { return p.login; }),
      stars: d.repo ? d.repo.stars : null,
      forks: d.repo ? d.repo.forks : null,
      downloads: d.totalAssetDownloads == null ? null : d.totalAssetDownloads,
      tel: (d.telemetry && d.telemetry.configured && d.telemetry.totals) || null
    };
  }

  // ── rendering ─────────────────────────────────────────────────────────────────────────────────

  function dcell(label, delta, footnote) {
    if (!delta.known) {
      return '<div class="dcell unknown"><b>—</b><span>' + esc(label) + '</span><em>' + esc(delta.why) + '</em></div>';
    }
    var cls = delta.v > 0 ? 'up' : delta.v < 0 ? 'down' : '';
    var txt = delta.v > 0 ? '+' + num(delta.v) : delta.v < 0 ? '−' + num(Math.abs(delta.v)) : 'no change';
    return '<div class="dcell ' + cls + '"><b>' + txt + '</b><span>' + esc(label) + '</span>'
      + (footnote ? '<em>' + esc(footnote) + '</em>' : '') + '</div>';
  }

  // A cumulative delta, or an explicit "no baseline yet" — never a fabricated zero.
  // A known current value with no stored baseline arises two different ways, and the copy has to
  // match which one: a genuine first visit (no snapshot at all), versus a source that came online
  // AFTER the snapshot was taken — telemetry, typically, once the KV store gets linked. Saying
  // "first visit" in the second case would be false, and it is the case the owner will actually
  // hit, since the counter store is not linked yet.
  function cumDelta(cur, baseVal, why, firstVisit) {
    var m = metric(cur, why);
    if (!m.known) return m;
    if (baseVal == null || !Number.isFinite(Number(baseVal))) {
      return { known: false, why: firstVisit ? 'first visit — baseline captured now' : 'counter appeared after your last visit — no baseline for it yet' };
    }
    return { known: true, v: m.v - Number(baseVal) };
  }

  function renderSince(d, s, base) {
    var box = $('[data-since]');
    var firstVisit = !base;

    var newIds = firstVisit ? [] : s.events.filter(function (e) { return base.ids.indexOf(e.id) === -1; });
    var newPeople = firstVisit ? [] : s.people.filter(function (p) { return base.people.indexOf(p.login) === -1; });

    var headline, when;
    if (firstVisit) {
      headline = '<span class="flat">First visit — baseline captured just now.</span> Deltas start from your next visit; everything below is live regardless.';
      when = 'no prior snapshot on this browser';
    } else if (newIds.length || newPeople.length) {
      var bits = [];
      if (newPeople.length) bits.push('<b>' + newPeople.length + ' new ' + (newPeople.length === 1 ? 'person' : 'people') + '</b>');
      if (newIds.length) bits.push('<b>' + newIds.length + ' new ' + (newIds.length === 1 ? 'thread' : 'threads') + '</b>');
      headline = bits.join(' and ') + ' since you last looked'
        + (newPeople.length ? ' — ' + newPeople.slice(0, 4).map(function (p) { return '@' + esc(p.login); }).join(', ') + '.' : '.');
      when = 'baseline: ' + esc(base.at.slice(0, 16).replace('T', ' ')) + ' UTC · ' + agoLabel(base.at);
    } else {
      headline = '<span class="flat">No new people or threads since you last looked.</span> Counter movement, if any, is below.';
      when = 'baseline: ' + esc(base.at.slice(0, 16).replace('T', ' ')) + ' UTC · ' + agoLabel(base.at);
    }

    var telTotals = (d.telemetry && d.telemetry.configured && d.telemetry.totals) || null;
    var telWhy = d.telemetry && !d.telemetry.configured
      ? 'opt-in counter store not linked'
      : 'no opt-in pings recorded';

    var cells = [
      dcell('new threads (issues + PRs)',
        firstVisit ? { known: false, why: 'first visit — baseline captured now' } : { known: true, v: newIds.length }),
      dcell('GitHub stars', cumDelta(d.repo && d.repo.stars, base && base.stars, 'repo metadata unavailable', firstVisit),
        d.repo ? num(d.repo.stars) + ' total' : ''),
      dcell('forks', cumDelta(d.repo && d.repo.forks, base && base.forks, 'repo metadata unavailable', firstVisit),
        d.repo ? num(d.repo.forks) + ' total' : ''),
      dcell('release bundle downloads', cumDelta(d.totalAssetDownloads, base && base.downloads, 'no release data returned', firstVisit),
        d.totalAssetDownloads == null ? '' : num(d.totalAssetDownloads) + ' lifetime'),
      dcell('opted-in installs', cumDelta(telTotals && telTotals.install, base && base.tel && base.tel.install, telWhy, firstVisit)),
      dcell('opted-in searches', cumDelta(telTotals && telTotals.search, base && base.tel && base.tel.search, telWhy, firstVisit)),
      dcell('opted-in sessions', cumDelta(telTotals && telTotals.session, base && base.tel && base.tel.session, telWhy, firstVisit)),
      dcell('new humans engaged',
        firstVisit ? { known: false, why: 'first visit — baseline captured now' } : { known: true, v: newPeople.length })
    ];

    box.innerHTML = '<p class="headline">' + headline + '</p>'
      + '<p class="since-when">' + when + '</p>'
      + '<div class="dstrip">' + cells.join('') + '</div>'
      + '<p class="since-foot">Only cumulative counters appear above. Rolling 14-day and 7-day windows (clones, views, npm) are in Momentum instead — '
      + 'subtracting two readings of a rolling window compares two different time spans, so it can fall while the project grows.</p>';

    return { newIds: newIds.map(function (e) { return e.id; }), firstVisit: firstVisit };
  }

  function renderTodo(s) {
    var host = $('[data-todo]');
    if (!s.queue.available) {
      host.innerHTML = '<div class="inbox-zero">' + esc(s.queue.note) + '</div>';
      return;
    }
    if (!s.openItems.length) {
      host.innerHTML = '<div class="inbox-zero">No open engineering issues or PRs in the current GitHub inventory.</div>';
      return;
    }
    host.innerHTML = '<div class="todo">' + s.openItems.map(function (it) {
      var age = daysAgo(it.at);
      var cls = age != null && age > 3 ? '' : 'fresh';
      return '<div class="todo-row"><span class="age ' + cls + '">' + esc(age == null ? '—' : age + 'd open') + '</span>'
        + '<span class="body"><a href="' + safeUrl(it.url) + '" target="_blank" rel="noopener">'
        + (it.isPR ? 'PR ' : '#') + esc(it.number) + ' — ' + esc(it.title) + '</a>'
        + '<span class="by">@' + esc(it.login) + ' · opened ' + esc(it.at) + '</span></span></div>';
    }).join('') + '</div>';
  }

  function renderPeople(d, s, base) {
    var host = $('[data-people]');
    var qual = $('[data-people-qual]');
    var known = s.people.length;

    // The 401 hazard, handled explicitly: stars exist but the stargazer LIST may be empty because
    // GET /stargazers requires auth. "0 named" must never read as "nobody starred".
    var stars = d.repo ? d.repo.stars : null;
    var namedStars = (d.people && d.people.stargazers) || [];
    var starNote = '';
    if (Number.isFinite(Number(stars)) && Number(stars) > 0 && namedStars.length === 0) {
      starNote = num(stars) + ' stars exist, but GitHub returns the stargazer list only to an authenticated caller — '
        + 'set GITHUB_TOKEN to see who they are. Their absence here is a missing credential, not a missing person.';
    } else if (namedStars.length) {
      starNote = 'Plus ' + namedStars.length + ' stargazer' + (namedStars.length === 1 ? '' : 's') + ' with no dated activity: '
        + namedStars.slice(0, 20).map(function (l) { return '@' + l; }).join(', ') + '.';
    }

    qual.textContent = known + ' named · bots excluded' + (s.botItems ? ' (' + s.botItems + ' bot items hidden)' : '');

    if (!known) {
      host.innerHTML = '<div class="inbox-zero" style="border-color:var(--ridge)">No external humans have filed an issue, opened a PR, or forked yet.'
        + (starNote ? ' ' + esc(starNote) : '') + '</div>';
      return;
    }

    host.innerHTML = '<div class="ppl">' + s.people.map(function (p) {
      var recent = p.last && daysAgo(p.last) != null && daysAgo(p.last) <= 7;
      var isNew = base && base.people.indexOf(p.login) === -1;
      var badges = '';
      if (isNew) badges += '<span class="badge new">new</span>';
      if (recent) badges += '<span class="badge live">active this week</span>';
      if (p.open) badges += '<span class="badge open">' + p.open + ' open</span>';
      if (p.association && p.association !== 'NONE') badges += '<span class="badge">' + esc(String(p.association).toLowerCase()) + '</span>';

      var counts = [];
      if (p.issues) counts.push(p.issues + ' issue' + (p.issues === 1 ? '' : 's'));
      if (p.prs) counts.push(p.prs + ' PR' + (p.prs === 1 ? '' : 's'));
      if (p.forked) counts.push('forked');

      return '<div class="pcard' + (recent ? ' active' : '') + '">'
        + '<div class="who"><a href="https://github.com/' + esc(p.login) + '" target="_blank" rel="noopener">@' + esc(p.login) + '</a>' + badges + '</div>'
        + '<p class="span">' + esc(counts.join(' · ') || 'engaged') + '<br>'
        + 'last seen ' + esc(agoLabel(p.last)) + ' · first seen ' + esc(agoLabel(p.first)) + '</p></div>';
    }).join('') + '</div>'
      + (starNote ? '<p class="note">' + esc(starNote) + '</p>' : '');
  }

  var FEED_STEP = 25;
  var feedShown = FEED_STEP;

  function renderFeed(s, newIds) {
    var host = $('[data-feed]');
    var qual = $('[data-feed-qual]');
    qual.textContent = s.events.length + ' dated events';
    if (!s.events.length) {
      host.innerHTML = '<div class="inbox-zero" style="border-color:var(--ridge)">No dated human events yet.</div>';
      return;
    }
    var slice = s.events.slice(0, feedShown);
    var rows = slice.map(function (e) {
      var fresh = newIds.indexOf(e.id) !== -1;
      var link = e.kind === 'fork'
        ? '<a href="' + safeUrl(e.url) + '" target="_blank" rel="noopener">@' + esc(e.login) + '</a> forked the repo'
        : '<a href="' + safeUrl(e.url) + '" target="_blank" rel="noopener">' + esc(e.title) + '</a> <span class="who">@' + esc(e.login)
          + (e.state ? ' · ' + esc(e.state) : '') + '</span>';
      return '<div class="tl-row' + (fresh ? ' is-new' : '') + '">'
        + '<span class="when">' + esc(e.at || '—') + '</span>'
        + '<span class="kind">' + esc(e.kind) + '</span>'
        + '<span class="what">' + (fresh ? '<span class="badge new">new</span> ' : '') + link + '</span></div>';
    }).join('');
    var more = s.events.length > feedShown
      ? '<button class="more-btn" data-feed-more>Show ' + Math.min(FEED_STEP, s.events.length - feedShown) + ' older →</button>'
      : (feedShown > FEED_STEP ? '<button class="more-btn" data-feed-less>← Collapse back to ' + FEED_STEP + '</button>' : '');
    host.innerHTML = '<div class="tl">' + rows + more + '</div>';
  }

  // ── reach: the four headline counters, each carrying its own limitation ───────────────────────
  //
  // The owner's question is "how many people use this?" — and NO single counter answers it, because
  // the three cheap ones each count a different non-person: a browser session, a file fetch, a
  // consenting machine. The tile therefore renders the caveat as structure, not as fine print: a
  // number without its limitation is how "2,207 npm downloads" got read as 2,207 users when it is
  // mostly mirrors and this project's own nightly refresh.
  function rcell(opts) {
    if (!opts.value.known) {
      return '<div class="rcell unknown"><b>—</b><span class="lbl">' + esc(opts.label) + '</span>'
        + '<span class="win">' + esc(opts.value.why) + '</span>'
        + '<span class="caveat">' + esc(opts.caveat) + '</span></div>';
    }
    return '<div class="rcell' + (opts.hero ? ' hero' : '') + '"><b>' + num(opts.value.v) + '</b>'
      + '<span class="lbl">' + esc(opts.label) + '</span>'
      + '<span class="win">' + esc(opts.window) + '</span>'
      + '<span class="caveat">' + esc(opts.caveat) + '</span></div>';
  }

  function renderReach(d) {
    var t = d.traffic || {};
    var trafficWhy = t.configured ? 'no data in the current 14-day window' : 'GITHUB_TOKEN not set — traffic API needs push access';
    var telCfg = d.telemetry && d.telemetry.configured;
    var telTotals = (telCfg && d.telemetry.totals) || null;
    var telWhy = telCfg ? 'no opt-in install pings recorded yet' : 'opt-in counter store not linked';

    // GitHub releases/latest is authoritative; release list ordering is not publication order.
    // Download counts cannot identify active installations.
    var newest = d.latestRelease || null;
    var newestDl = newest ? newest.assets.reduce(function (n, a) { return n + (a.downloads || 0); }, 0) : null;

    $('[data-reach]').innerHTML = [
      rcell({
        hero: true,
        label: 'unique repo visitors',
        window: 'rolling 14 days · github.com',
        value: metric(t.views && t.views.uniques, trafficWhy),
        caveat: 'The only tile here that counts PEOPLE. GitHub de-duplicates by visitor, so this is humans who opened the repo page — not machines, not CI.'
      }),
      rcell({
        label: 'bundle downloads',
        window: 'lifetime, all releases',
        value: metric(d.totalAssetDownloads, 'no release data returned'),
        caveat: 'Downloads, NOT people — GitHub exposes no unique-downloader field for release assets. Each nightly refresh re-downloads, so one machine counts many times.'
      }),
      rcell({
        label: newest ? 'pulled ' + newest.tag : 'newest release pulls',
        window: newest ? 'since ' + String(newest.publishedAt || '').slice(0, 10) : 'no published release found',
        value: metric(newestDl, 'no assets on the newest release'),
        caveat: 'Asset downloads on GitHub’s current latest release. Includes repeated downloads and verification assets; this does not measure active machines or users.'
      }),
      rcell({
        label: 'opted-in installs',
        window: 'lifetime · consenting machines only',
        value: metric(telTotals && telTotals.install, telWhy),
        caveat: 'A FLOOR, never a total. Fires once per machine on first install, and only if that person said yes. Everyone who declined is real and invisible here.'
      })
    ].join('');

    var stars = d.repo ? d.repo.stars : null;
    $('[data-reach-qual]').textContent = Number.isFinite(Number(stars))
      ? '★ ' + num(stars) + ' stars · ' + num((d.repo && d.repo.forks) || 0) + ' forks'
      : 'repo metadata unavailable';

    $('[data-reach-note]').textContent = 'No counter here is a headcount, and the gap between them is the point: '
      + 'visitors are GitHub uniques, bundle pulls are downloads, opted-in installs are consenting machines. '
      + 'npm downloads are deliberately excluded from this row — mirrors and the nightly refresh dominate them, '
      + 'so they measure traffic volume and never population. They remain in Momentum below, as shape only.';
  }

  function mcell(label, mom, stroke, unknownWhy) {
    if (!mom) {
      return '<div class="mcell unknown"><div class="top"><b>—</b></div><span>' + esc(label) + '</span>'
        + '<span style="color:var(--faint)">' + esc(unknownWhy || 'not enough daily history to compare') + '</span></div>';
    }
    var arrow = mom.dir === 'up' ? '▲' : mom.dir === 'down' ? '▼' : '▬';
    var pct = mom.pct == null ? '' : (mom.pct > 0 ? '+' : '') + mom.pct + '%';
    return '<div class="mcell"><div class="top"><b>' + num(mom.recent) + '</b>'
      + '<span class="arrow ' + mom.dir + '">' + arrow + ' ' + esc(pct) + '</span></div>'
      + '<span>' + esc(label) + '<br>' + num(mom.prior) + ' in the prior 7d</span>'
      + sparkline(mom.series, stroke) + '</div>';
  }

  function renderMomentum(d) {
    var t = d.traffic || {};
    var trafficWhy = t.configured ? 'no data in the current 14-day window' : 'GITHUB_TOKEN not set — traffic API needs push access';
    var npmSeries = d.npm ? ascend(d.npm.daily, 'day', 'downloads') : null;
    var cloneSeries = t.clones ? ascend(t.clones.daily, 'timestamp', 'uniques') : null;
    var viewSeries = t.views ? ascend(t.views.daily, 'timestamp', 'uniques') : null;
    var telSeries = d.telemetry && d.telemetry.configured ? ascend(d.telemetry.daily, 'date', 'search') : null;
    var telWhy = d.telemetry && !d.telemetry.configured ? 'opt-in counter store not linked' : 'no opt-in pings recorded yet';

    // Ordered by how close each one sits to a real person: visitors (people) → cloners (machines)
    // → opted-in searches (consenting machines actually USING it) → npm (mostly mirrors). npm is
    // last on purpose; it was leading this row and reading as an adoption number, which it is not.
    $('[data-momentum]').innerHTML = [
      mcell('unique repo visitors, last 7d', momentum(viewSeries), 'var(--accent)', trafficWhy),
      mcell('unique cloners, last 7d', momentum(cloneSeries), 'var(--accent)', trafficWhy),
      mcell('opted-in searches, last 7d', momentum(telSeries), 'var(--accent-3)', telWhy),
      mcell('npm downloads, last 7d', momentum(npmSeries), 'var(--accent-2)', 'npm range unavailable')
    ].join('');

    $('[data-momentum-note]').textContent = 'Read left to right: the tiles get further from a human as you go. '
      + 'Unique visitors are people. Unique cloners are machines, and this project\'s own plugin auto-update is among them. '
      + 'npm downloads are dominated by registry mirrors — the 7d figure moves with release cadence, not with adoption, '
      + 'which is why it no longer leads this row. npm\'s most recent day is also partial, so the last sparkline point can dip for no real reason.';
  }

  function renderReferrers(d) {
    var t = d.traffic || {};
    if (Array.isArray(t.referrers) && t.referrers.length) {
      $('[data-referrers]').innerHTML = '<tr><th>referrer</th><th>views, 14d</th><th>uniques</th></tr>'
        + t.referrers.map(function (x) {
          return '<tr><td>' + esc(x.referrer) + '</td><td class="num">' + num(x.count) + '</td><td class="num">' + num(x.uniques) + '</td></tr>';
        }).join('');
      $('[data-referrers-note]').textContent = 'GitHub "popular referrers" — where repo visitors arrived from.';
    } else {
      $('[data-referrers]').innerHTML = '<tr><td>' + esc(t.configured ? 'No referrer data in the current 14-day window.' : (t.note || 'GITHUB_TOKEN not set — referrers need push access.')) + '</td></tr>';
      $('[data-referrers-note]').textContent = '';
    }
  }

  // The honesty section. THREE kinds of entry, and the distinction matters more than it looks:
  //   config — a credential or a linked store fixes it today, no code required
  //   code   — nobody has built it yet; it needs a change to admin-stats.mjs or new instrumentation
  //   design — a deliberate choice we intend to keep
  // The first draft of this page collapsed `code` into `design`, which quietly relabelled seven
  // unbuilt features as intentional product decisions. That is the same species of lie as printing
  // a fabricated number: it tells the owner a gap is closed-by-choice when it is really just open.
  // Only ONE row here is genuinely by design — the one about never seeing search queries.
  function renderGaps(d) {
    var out = [];
    var t = d.traffic || {};
    var tel = d.telemetry || {};

    if (!t.configured) {
      out.push(['config', 'Clones, views, and referrers are dark.',
        'GITHUB_TOKEN (push access to the repo) is not set in Vercel env. Every traffic panel above says so rather than showing 0.']);
    }
    if (!tel.configured) {
      out.push(['config', 'Opt-in install / search / session counters are dark.',
        (tel.note || 'No KV/Upstash store is linked to the Vercel project.') + ' The counters read "—", never 0.']);
    }

    out.push(['code', 'The actual words people wrote — the positive feedback you are hearing about.',
      'This is the big one, and it is the direct answer to "why can\'t I see any of it here?". The threads linked above carry real conversations, but api/admin-stats.mjs maps each item to {number, title, state, isPR, url, at} and drops comments, reactions, closed_at, and the body. So this page can prove a conversation happened and take you straight to it — it cannot quote or score the sentiment, and deliberately does not try. Adding comments + reactions to that one items.push() call would light this up.']);
    out.push(['code', 'GitHub Discussions activity.',
      'The payload links to Discussions but never reads it — the Discussions API is GraphQL-only, and admin-stats.mjs speaks REST.']);
    out.push(['code', 'People who only commented, and never opened an issue or PR.',
      'Contributors are grouped from the issues endpoint by AUTHOR, so a person whose entire contribution is a helpful comment on someone else\'s thread is invisible here. Comment-only participants are outside this inventory.']);
    out.push(['code', 'When each star happened.',
      'Stars have no date in the payload (the stargazers call omits the star+json Accept header that carries starred_at), so they cannot be placed on the timeline. Forks can, and are.']);
    out.push(['code', 'Explainer page traffic — visitors to this site, as opposed to the repo.',
      'No analytics of any kind is wired to the explainer. Every traffic number on this page describes github.com, not this domain.']);
    out.push(['code', 'npm downloads split by version.',
      'api.npmjs.org\'s range endpoint returns a single total per day for the package. The opt-in counter does record a version per install, which is the closest available substitute.']);
    out.push(['design', 'What people actually search for. Deliberate, and staying that way.',
      'search_ruvnet runs entirely on the user\'s machine and never phones home. The opt-in counter records that a search happened, never what it was. This gap is the product working as designed — not a hole to plug.']);

    var TAG = { config: 'engineering setup', code: 'engineering backlog', design: 'by design' };
    $('[data-gaps]').innerHTML = out.map(function (g) {
      return '<li><span class="tag ' + g[0] + '">' + TAG[g[0]] + '</span>'
        + '<b>' + esc(g[1]) + '</b><span class="fix">' + esc(g[2]) + '</span></li>';
    }).join('');
  }

  var lastPayload = null;

  function render(d) {
    lastPayload = d;
    $('[data-gate]').hidden = true;
    $('[data-dash]').hidden = false;
    $('[data-stamp]').textContent = 'live read ' + String(d.generatedAt || '').slice(0, 19).replace('T', ' ') + ' UTC';

    var s = shape(d);
    var base = readBaseline();

    renderReach(d);
    var since = renderSince(d, s, base);
    renderTodo(s);
    renderPeople(d, s, base);
    renderFeed(s, since.newIds);
    renderMomentum(d);
    renderReferrers(d);
    renderGaps(d);

    // First visit only: seed the baseline so the NEXT visit has something honest to diff against.
    // Deliberately NOT done on every render — auto-advancing the baseline each load would silently
    // consume the very deltas the page exists to show.
    if (!base) localStorage.setItem(BASE_STORE, JSON.stringify(snapshot(d, s)));

    $('[data-undo-review]').hidden = !localStorage.getItem(BASE_PREV);
  }

  async function load(token, opts) {
    var silent = opts && opts.silent;
    $('[data-err]').textContent = '';
    var r, j;
    try {
      // Relative URL on purpose — works on the canonical domain AND behind isovision.ai/ruvnet-brain.
      r = await fetch('api/admin-stats', { headers: { 'x-admin-token': token } });
      j = await r.json().catch(function () { return {}; });
    } catch (e) {
      if (!silent) $('[data-err]').textContent = 'Network error: ' + e.message;
      return;
    }
    if (!r.ok) {
      if (!silent) {
        $('[data-err]').textContent = j.error || ('HTTP ' + r.status);
        localStorage.removeItem(TOKEN_STORE);
      }
      return;
    }
    localStorage.setItem(TOKEN_STORE, token);
    render(j);
  }

  var savedToken = function () { return localStorage.getItem(TOKEN_STORE) || ''; };

  $('[data-token-go]').addEventListener('click', function () { load($('[data-token-input]').value.trim()); });
  $('[data-token-input]').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') load($('[data-token-input]').value.trim());
  });
  $('[data-refresh]').addEventListener('click', function () { load(savedToken(), { silent: true }); });
  $('[data-logout]').addEventListener('click', function () { localStorage.removeItem(TOKEN_STORE); location.reload(); });

  // Executor + inverse, per rule 3 at the top. Marking reviewed stashes the outgoing baseline so
  // "Undo" can put it back exactly — the button is never decorative.
  $('[data-mark-review]').addEventListener('click', function () {
    if (!lastPayload) return;
    var prev = localStorage.getItem(BASE_STORE);
    if (prev) localStorage.setItem(BASE_PREV, prev);
    localStorage.setItem(BASE_STORE, JSON.stringify(snapshot(lastPayload, shape(lastPayload))));
    render(lastPayload);
  });
  $('[data-undo-review]').addEventListener('click', function () {
    var prev = localStorage.getItem(BASE_PREV);
    if (!prev) return;
    localStorage.setItem(BASE_STORE, prev);
    localStorage.removeItem(BASE_PREV);
    if (lastPayload) render(lastPayload);
  });

  // Feed paging is its own undo (show more ⇄ collapse), so it needs no separate inverse.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-feed-more')) { feedShown += FEED_STEP; if (lastPayload) render(lastPayload); }
    if (t.hasAttribute('data-feed-less')) { feedShown = FEED_STEP; if (lastPayload) render(lastPayload); }
  });

  var autoTimer = null;
  $('[data-auto]').addEventListener('change', function (e) {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (e.target.checked) autoTimer = setInterval(function () { load(savedToken(), { silent: true }); }, 60000);
  });

  if (savedToken()) load(savedToken());
})();
