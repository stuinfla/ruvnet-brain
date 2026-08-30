/* ============================================================================
   RuvNet Brain — Onboarding Console (frontend)
   ----------------------------------------------------------------------------
   Vanilla ES module. No frameworks, no build step, no network beyond the
   local API. Renders real machine state per console/CONTRACT.md:

     Mirror → Explain → Recommend → (consent) Apply → Undo

   Data flow: GET /api/state (fast) renders sections 2–6 immediately;
   GET /api/stack (slow network audit) fills section 1 + late suggestions.
   POSTs (/api/apply, /api/save-config, /api/undo) echo the launch token.
   ============================================================================ */

'use strict';

/* ------------------------------------------------------------------ setup */

const TOKEN = (typeof window !== 'undefined' && typeof window.__CONSOLE_TOKEN__ === 'string')
  ? window.__CONSOLE_TOKEN__
  : null; // tolerated: static preview has no token; GETs still work read-only

const MOCK = new URLSearchParams(location.search).has('mock'); // dev only, never default

let preStateHash = null;          // echoed on /api/apply so the server can refuse a moved world
let lastMemory = null;            // last rendered memory card, so the late fleet scan can merge into it
const renderedRecIds = new Set();
const renderedRecommendations = new Map();
let stateRecsSettled = false;
let stackRecsSettled = false;
// Health advocacy (ADR-027) hydrates from /api/memory, the slowest source. Until it has answered,
// the chip must NOT claim "none needed" — that would tell the user their machine is clean while the
// one check that actually looks at their learning state is still running. Silence read as an
// all-clear is the exact failure this ADR exists to end.
let healthRecsSettled = false;
const found = {};                 // pieces of the "we looked at your computer" ribbon

/* --------------------------------------------------------------- helpers */

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/* Parse a trusted (hand-authored, no interpolated data) SVG/HTML snippet. */
function frag(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function chip(text, tone, title) {
  return el('span', { class: `chip tone-${tone || 'grey'}`, title: title || null }, text);
}

function setChips(id, chips) {
  const c = document.getElementById(id);
  if (c) c.replaceChildren(...chips);
}

function announce(msg) {
  const r = $('#live-region');
  if (r) { r.textContent = ''; r.textContent = msg; }
}

function illoBox(name) {
  const tpl = document.getElementById('illo-' + name);
  if (!tpl) return null;
  return el('div', { class: 'illo-box', 'aria-hidden': 'true' }, tpl.content.firstElementChild.cloneNode(true));
}

/* Wrap section content beside its spot illustration.
   The illo comes FIRST in DOM order so its mobile float lands beside the
   opening text; the desktop grid re-places it via `order`. */
function withIllo(name, ...content) {
  return el('div', { class: 'sect-body with-illo' },
    illoBox(name),
    el('div', { class: 'sect-main' }, ...content));
}

const fmtUsd = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  if (v > 0 && v < 0.01) return '<$0.01';
  return '$' + v.toFixed(2);
};

const fmtMs = (ms) => {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const v = Number(ms);
  if (v < 1000) return `${Math.round(v)} ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} m ${Math.round(s % 60)} s`;
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return String(iso); }
};

const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString());

/* ----------------------------------------------------------------- fetch */

async function getJSON(url) {
  if (MOCK) return mockGet(url);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  if (MOCK) return mockPost(url, body);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, ...body }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, ok: res.ok, data };
}

const TOKEN_MSG = 'The security token didn’t match — this page belongs to an older console launch. Restart the console and reload.';

/* ----------------------------------------------------------------- theme */

const THEME_KEY = 'rbc-theme';

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $('#theme-toggle');
  if (btn) btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

function initTheme() {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  $('#theme-toggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
    applyTheme(next);
  });
  try {
    matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      let stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
      if (stored !== 'light' && stored !== 'dark') applyTheme(e.matches ? 'light' : 'dark');
    });
  } catch { /* older engines */ }
}

/* ---------------------------------------------------------------- errors */

function inlineError(bodyId, msg, retry) {
  const body = document.getElementById(bodyId);
  if (!body) return;
  body.replaceChildren(
    el('div', { class: 'inline-error', role: 'alert' },
      el('p', { class: 'ie-title' }, 'Couldn’t read this section.'),
      el('p', { class: 'ie-msg' }, msg),
      retry ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: retry }, 'Try again') : null,
    ),
  );
}

function showGlobalError(err) {
  const b = $('#global-error');
  if (!b) return;
  b.hidden = false;
  b.replaceChildren(
    el('p', {},
      'Couldn’t reach the console server (', el('code', {}, String(err.message || err)), '). ',
      'The page stays read-only either way — nothing was touched.'),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { b.hidden = true; loadState(); } }, 'Try again'),
  );
}

/* ---------------------------------------------------- the "found" ribbon */

/* One-time count-up for the found-strip numbers: each figure rolls in the first time it
   appears, then stays static across the ribbon's later re-renders. Real values only — the
   animation is a reveal, never an estimate — and prefers-reduced-motion gets the final
   number immediately. */
const REDUCED_MOTION = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; } })();
const countedKeys = new Set();
function countUpNum(key, value, render = fmtInt) {
  const target = Number(value);
  const b = el('b', {}, render(target));
  if (REDUCED_MOTION || countedKeys.has(key) || !Number.isFinite(target) || target <= 0) {
    countedKeys.add(key);
    return b;
  }
  countedKeys.add(key);
  const dur = 700;
  let t0 = null;
  const tick = (t) => {
    if (t0 == null) t0 = t;
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    b.textContent = render(Math.round(target * eased));
    if (p < 1) requestAnimationFrame(tick);
    else b.textContent = render(target);
  };
  requestAnimationFrame(tick);
  return b;
}

function updateFoundStrip() {
  const strip = $('#found-strip');
  if (!strip || !found.host) return;
  const bits = [];
  if (found.pkgTotal != null) {
    bits.push(el('span', {}, countUpNum('pkgTotal', found.pkgTotal), ' packages on your global stack',
      found.pkgCurrent != null ? el('span', {}, ' (', countUpNum('pkgCurrent', found.pkgCurrent), ' current)') : ''));
  }
  if (found.npx != null) {
    // THE SENTENCE USED TO CONTRADICT ITSELF IN THE SPACE OF SIX WORDS:
    //   "0 npx call sites across 0 projects — AI Retirement Analyzer, AMBULANCE_INVENTORY +63 more"
    // `projectNames` is the list of projects we SCANNED, not the projects with npx call sites, and it
    // was appended unconditionally to a count of npx sites. So the first data sentence on the page —
    // the one immediately above "every number below traces to something we actually observed" —
    // named 65 projects while asserting there were none. Nothing was miscounted; the two halves were
    // about different things and were joined anyway. Found by Fable 5, 2026-07-24.
    //
    // Zero is the good outcome here (no npx drift), so it gets a sentence that reads as good news
    // and credits the scan, instead of a contradiction that makes the reader distrust the number.
    const scanned = found.projectNames?.length ?? 0;
    if (found.npx === 0) {
      bits.push(el('span', {}, 'no npx call sites',
        scanned ? el('span', {}, ' in the ', countUpNum('projects', scanned), ' projects we scanned') : ''));
    } else {
      bits.push(el('span', {}, countUpNum('npx', found.npx), ' npx call sites across ',
        countUpNum('projects', found.projects ?? 0), ' projects',
        found.projectNames?.length
          ? el('span', {}, ' — ', el('span', { class: 'fs-path' }, found.projectNames.slice(0, 2).join(', ')),
              found.projectNames.length > 2 ? ` +${found.projectNames.length - 2} more` : '')
          : ''));
    }
  }
  if (found.memScore != null) {
    // The qualifier travels WITH the number. A score whose asterisk lives in another card is an
    // unqualified score to everyone who reads only this line — which is everyone, it is the ribbon.
    bits.push(el('span', {}, 'memory quality ',
      countUpNum('memScore', found.memScore, (v) => `${v}/100`),
      found.memNotTested
        ? el('span', { class: 'muted' },
            ` (${found.memProbed} of ${found.memDims} dimensions checked)`)
        : ''));
  }
  strip.replaceChildren(
    el('span', {}, 'We looked around ', el('b', {}, found.host), '’s machine: '),
    ...bits.flatMap((b, i) => (i ? [' · ', b] : [b])),
    el('span', {}, '. Every number below traces to something we actually observed.'),
  );
  strip.hidden = false;
  updateVerdict();
}

/**
 * THE VERDICT LINE — the one sentence the page never said.
 *
 * Fable 5, 2026-07-24: "8,100px and the page never once says the one sentence the owner's success
 * criterion demands: 'You're in good shape. One package needs a look; three suggestions below.'
 * Every card makes you derive the verdict from chips." That is the whole gap between a dashboard and
 * an answer, and it is why a careful reader can finish this page without ever learning how they are
 * doing.
 *
 * THREE RULES IT OBEYS, all of them the product's existing rules applied to one sentence:
 *
 *  1. DERIVED, NEVER ASSERTED. Every number here is handed over by the card that measured it. This
 *     function computes nothing about the machine; it only decides which sentence the measurements
 *     support. That is also why it renders nothing until the counts arrive — an empty verdict is
 *     honest, an early one is a guess.
 *  2. UNKNOWN IS NOT GOOD NEWS. Capabilities we could not check are stated separately and never
 *     folded into the good column, because "we could not tell" reported as "fine" is the exact lie
 *     the four-state model exists to prevent.
 *  3. GOOD NEWS IS ALLOWED TO SOUND LIKE GOOD NEWS. The owner's criterion is that someone smiles and
 *     thinks "I have more tools than I realised." A page that can only ever hedge cannot deliver
 *     that. When the evidence says things are in good shape, this says so plainly — and names the
 *     exceptions in the same breath, which is what makes it believable rather than cheerful.
 */
function updateVerdict() {
  const v = $('#verdict');
  if (!v || found.capsTotal == null) return;      // nothing measured yet — say nothing

  const behind = (found.pkgTotal != null && found.pkgCurrent != null)
    ? found.pkgTotal - found.pkgCurrent : null;

  // What actually wants the reader's attention, in blast-radius order.
  const needsLook = [];
  if (found.capsOff) needsLook.push(`${found.capsOff} capabilit${found.capsOff === 1 ? 'y is' : 'ies are'} off`);
  if (behind) needsLook.push(`${behind} package${behind === 1 ? '' : 's'} behind`);

  const caveats = [];
  if (found.capsUnknown) caveats.push(`${found.capsUnknown} capabilit${found.capsUnknown === 1 ? "y" : "ies"} we could not check`);
  if (found.memNotTested) caveats.push(`${found.memNotTested} memory dimension${found.memNotTested === 1 ? '' : 's'} not probed this session`);

  const good = !needsLook.length;
  const headline = good
    ? 'You’re in good shape.'
    : `Mostly good — ${needsLook.join(' and ')}.`;

  const detail = `${found.capsOn} of ${found.capsTotal} capabilities are on`
    + (found.capsAbsent ? `, ${found.capsAbsent} not installed` : '')
    + (behind === 0 ? ', and every package on your stack is current' : '')
    + '.';

  v.replaceChildren(
    el('span', { class: `verdict-mark ${good ? 'vm-good' : 'vm-look'}` }, good ? '✓' : '!'),
    el('span', {},
      el('b', {}, headline), ' ', detail,
      // Caveats read as their own clause, not as a subordinate one. "We're not counting X, or Y as
      // either" parsed badly out loud, and a sentence about honesty that the reader has to re-read
      // is not doing its job.
      caveats.length ? el('span', { class: 'muted' }, ` Not counted either way: ${caveats.join(' · ')}.`) : '',
      !good ? el('span', { class: 'muted' }, ' Each one is named below, with its evidence and its undo.') : ''),
  );
  v.hidden = false;
}

/* ------------------------------------------------------------- section 0: host */

// Node reports the OS by its kernel codename — 'darwin' is the Unix core inside macOS. That is the
// machine's word for itself, not a person's, and this page is meant to read in plain English.
function osName(platform) {
  return { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[platform] || platform || '—';
}
function renderHost(host, generatedAt) {
  if (host && host.user) {
    found.host = `${host.user}@${osName(host.platform)}`;
    const hc = $('#host-chip');
    if (hc) { hc.textContent = found.host; hc.hidden = false; }
    // Header version chip (owner, 2026-07-24): the version is worn openly, next to the wordmark.
    if (host.brainVersion) {
      BRAIN_INSTALLED_VERSION = String(host.brainVersion);
      const vc = $('#brain-ver');
      if (vc) { vc.textContent = `v${BRAIN_INSTALLED_VERSION}`; vc.hidden = false; }
    }
    const meta = $('#host-meta');
    if (meta) {
      meta.replaceChildren(
        el('span', {}, 'user ', el('b', {}, host.user)),
        el('span', {}, 'platform ', el('b', {}, osName(host.platform))),
        el('span', {}, 'node ', el('b', {}, host.node || '—')),
        el('span', {}, 'npm prefix ', el('b', {}, host.npmPrefix || '—')),
      );
      meta.hidden = false;
    }
  }
  const fg = $('#foot-generated');
  if (fg && generatedAt) fg.textContent = `machine state read ${fmtDate(generatedAt)}`;
  updateFoundStrip();
}

/* ------------------------------------------------------------ section 1: stack */

const STATE_ORDER = { BROKEN: 0, BEHIND: 1, UNRESOLVED: 2, AHEAD: 3, CURRENT: 4 };
const STATE_TONE = { CURRENT: 'green', BEHIND: 'warn', AHEAD: 'cyan', BROKEN: 'red', UNRESOLVED: 'grey' };
const STATE_TITLE = {
  AHEAD: 'Newer than the target — a legal state, not an error.',
  UNRESOLVED: 'We couldn’t check this one — reported honestly, not guessed.',
  BROKEN: 'Present on disk but no readable version.',
};

function stackSkeleton() {
  $('#body-stack').replaceChildren(
    frag(`<div class="skeleton" aria-hidden="true">
      <div class="sk-bar w35"></div><div class="sk-bar w90"></div>
      <div class="sk-bar w85"></div><div class="sk-bar w88"></div><div class="sk-bar w60"></div></div>`),
    el('p', { class: 'loading-note' },
      'Checking every global package against the npm registry, one by one — read-only, nothing changes. ',
      'Private by design: the registry only sees ordinary version lookups; nothing about you or your projects leaves this machine. ',
      'On a full stack the first look honestly takes 30–60 seconds; after that it’s instant from cache. ',
      el('span', { class: 'elapsed', id: 'stack-elapsed' }, '')),
  );
  setChips('chips-stack', [chip('checking registry…', 'wait')]);
  if (stackTicker) clearInterval(stackTicker);
  const t0 = Date.now();
  stackTicker = setInterval(() => {
    const target = document.getElementById('stack-elapsed');
    if (!target) { clearInterval(stackTicker); stackTicker = null; return; }
    const s = Math.round((Date.now() - t0) / 1000);
    target.textContent = `— ${s}s in, still working (the registry answers one package at a time)`;
  }, 1000);
}

function pkgRow(p) {
  const st = STATE_ORDER[p.state] != null ? p.state : 'UNRESOLVED';
  // ISSUE #22 — a tool installed via the Claude Code plugin marketplace is first-class here; mark it
  // so its "plugin" tag column isn't the only tell that it tracks a marketplace cadence, not npm.
  const plugin = p.source === 'plugin';
  return el('tr', {},
    el('td', { class: 'cell-name' }, p.name || '—',
      plugin ? el('span', { class: 'src-tag', title: `installed via the ${p.marketplace || 'Claude Code'} plugin marketplace` }, ' plugin') : null),
    el('td', { class: 'cell-mono' },
      p.installed != null ? p.installed : el('span', { style: 'color:var(--red-text)' }, 'unreadable')),
    el('td', { class: 'cell-mono' }, p.target ?? '—'),
    el('td', { class: 'cell-mono cell-dim' }, p.tag ?? '—'),
    el('td', {}, chip(st, STATE_TONE[st], STATE_TITLE[st]),
      p.state === 'BEHIND' ? el('button', {
        class: 'btn-fix', type: 'button',
        title: `Update ${p.name} to ${p.target ?? 'latest'} — one click below, undo recorded first`,
        onclick: () => jumpToRec(`sync:${p.name}`),
      }, `update → ${p.target ?? 'latest'}`) : null,
      p.state === 'BROKEN' ? el('button', {
        class: 'btn-fix', type: 'button', title: `Repair ${p.name} — one click below`,
        onclick: () => jumpToRec(`repair:${p.name}`),
      }, 'repair') : null),
  );
}

/* ---- family grouping: roll sub-packages up under the tool people recognize ---- */
const STACK_FAMILIES = [
  { name: 'ruflo',            what: 'orchestration brain',           test: (n) => n === 'ruflo' || n === '@claude-flow/cli' },
  { name: 'AgentDB',          what: 'memory that learns',            test: (n) => n === '@claude-flow/memory' },
  { name: 'AI Defence',       what: 'prompt-injection / PII shield', test: (n) => n === '@claude-flow/aidefence' },
  { name: 'RuVector',         what: 'vector search + RVF storage',   test: (n) => n.startsWith('@ruvector/') || n === 'ruvector' || n === 'ruvector-extensions' || n === 'ruvbot' },
  { name: 'Agentic-Flow',     what: 'multi-model / cheap routing',   test: (n) => n === 'agentic-flow' },
  { name: 'Agentic-QE',       what: 'testing & quality fleet',       test: (n) => n === 'agentic-qe' },
  { name: 'MetaHarness',      what: 'harness scoring & routing',     test: (n) => n.startsWith('@metaharness/') },
  { name: 'Agent-Browser',    what: 'browser automation',            test: (n) => n.startsWith('agent-browser') },
  { name: 'Agentic Robotics', what: 'robot / agent control',         test: (n) => n.startsWith('@agentic-robotics/') || n === 'agentic-robotics' },
];
const STACK_MORE = { name: 'More RuvNet tools', what: 'flow-nexus, qudag, ruv-swarm, ruvi…' };

function familyOf(name) {
  const f = STACK_FAMILIES.find((fam) => { try { return fam.test(String(name)); } catch { return false; } });
  return f ? f.name : STACK_MORE.name;
}

function groupFamilies(pkgs) {
  const map = new Map();
  for (const p of pkgs) {
    const fam = familyOf(p.name || '');
    if (!map.has(fam)) map.set(fam, []);
    map.get(fam).push(p);
  }
  const order = [...STACK_FAMILIES.map((f) => f.name), STACK_MORE.name];
  return order.filter((n) => map.has(n)).map((n) => {
    const meta = STACK_FAMILIES.find((f) => f.name === n) || STACK_MORE;
    const items = map.get(n).slice().sort((a, b) =>
      (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(a.name).localeCompare(String(b.name)));
    const attention = items.filter((p) => ['BROKEN', 'BEHIND', 'UNRESOLVED'].includes(p.state)).length;
    return { name: n, what: meta.what, items, attention };
  });
}

/* No status without a remedy: every "behind/broken" indicator carries a jump to its
   one-click fix card (the consent-gated recommendation that already exists below). */
let stackTicker = null;
function jumpToRec(recId) {
  const card = document.getElementById('card-recs');
  if (card) card.open = true;
  const rec = document.getElementById(`rec-${recId}`);
  if (!rec) return;
  rec.scrollIntoView({ behavior: 'smooth', block: 'center' });
  rec.classList.add('rec-flash');
  setTimeout(() => rec.classList.remove('rec-flash'), 2600);
  // Land ready to act: the Apply button gets focus so the fix is one keystroke away —
  // the jump must never feel like it WAS the fix.
  setTimeout(() => rec.querySelector('.btn-apply')?.focus(), 650);
}

/* Re-mirror the machine — the header ↻ button, and auto-run after every apply/undo so the page shows
   the AFTER state instead of a stale before.
 *
 * IT USED TO BE A PLACEBO (retired 2026-07-26, RVBC-INSTANT-SPEC #8). The old body re-fetched three
 * endpoints and announced "Re-check complete." Every one of those endpoints is cache-first: it
 * re-read the SAME cache it had just read, painted the same bytes, and declared the machine
 * re-checked. Nothing was measured. Worse, it said so right after an apply — the one moment the user
 * most needs to know whether the change actually took.
 *
 * There is now ONE refresh: expire the caches server-side, force a real measurement in the detached
 * child, and report "done" only when a strictly newer measurement has actually landed. Both entry
 * points (this button and the freshness pill) are the same function, because two controls that
 * disagree about what "refreshed" means is how the placebo got written in the first place. */
const recheckMachine = doManualRefresh;

/* Jump-and-flash for a Settings row (provider chips land here) — same pattern as jumpToRec. */
function jumpToSetting(key) {
  const card = document.getElementById('card-settings');
  if (card) card.open = true;
  const row = document.getElementById(`field-${key}`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('rec-flash');
  setTimeout(() => row.classList.remove('rec-flash'), 2600);
}

/* WP5 — the page-level "stand by, this is private" line fades once the first card hydrates. */
function dismissStandby() {
  const n = document.getElementById('standby-note');
  if (!n || n.hidden) return;
  n.classList.add('gone');
  setTimeout(() => { n.hidden = true; }, 650);
}

/* ---------------------------------------- click-to-learn: ONE shared popover
   Used by the Dev/Prod headers (WP3), every Settings row (WP4), and the wiring
   lead (WP6). Anchored near its trigger, closes on Escape / click-outside /
   scroll, never shifts the layout (position: fixed). */

let infoPopEl = null;
let infoPopOwner = null;

function closeInfoPop() {
  if (!infoPopEl) return;
  const owner = infoPopOwner;
  infoPopEl.remove();
  infoPopEl = null;
  infoPopOwner = null;
  document.removeEventListener('pointerdown', onInfoDocDown, true);
  document.removeEventListener('keydown', onInfoKey, true);
  window.removeEventListener('scroll', closeInfoPop, true);
  window.removeEventListener('resize', closeInfoPop);
  if (owner && document.contains(owner)) owner.focus({ preventScroll: true });
}

function onInfoDocDown(e) {
  if (!infoPopEl) return;
  if (infoPopEl.contains(e.target)) return;
  if (infoPopOwner && (e.target === infoPopOwner || infoPopOwner.contains(e.target))) return;
  closeInfoPop();
}

function onInfoKey(e) { if (e.key === 'Escape') closeInfoPop(); }

function openInfoPop(trigger, title, beats) {
  if (infoPopEl && infoPopOwner === trigger) { closeInfoPop(); return; } // second click toggles off
  closeInfoPop();
  const pop = el('div', { class: 'info-pop', role: 'dialog', 'aria-label': title, tabindex: '-1' },
    el('button', { class: 'ip-close', type: 'button', 'aria-label': 'Close', onclick: closeInfoPop }, '×'),
    el('p', { class: 'ip-title' }, title),
    (Array.isArray(beats) ? beats : [beats]).map((b) => (typeof b === 'string'
      ? el('p', { class: 'ip-beat' }, b)
      : el('p', { class: 'ip-beat' }, el('span', { class: 'ip-k' }, b.k), b.t))));
  document.body.append(pop);
  const r = trigger.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - pw - 12));
  let top = r.bottom + 8;
  if (top + ph > window.innerHeight - 12) top = Math.max(12, r.top - ph - 8);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  infoPopEl = pop;
  infoPopOwner = trigger;
  document.addEventListener('pointerdown', onInfoDocDown, true);
  document.addEventListener('keydown', onInfoKey, true);
  window.addEventListener('scroll', closeInfoPop, true);
  window.addEventListener('resize', closeInfoPop);
  pop.focus({ preventScroll: true });
}

function infoBtn(title, beats) {
  return el('button', {
    class: 'info-btn', type: 'button',
    'aria-label': `About “${title}” — what it is and why it matters`,
    title: 'What is this — and why it matters',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); openInfoPop(e.currentTarget, title, beats); },
  }, 'i');
}

/* ── SECTION-LEVEL EXPLAINERS (2026-07-24) ───────────────────────────────────────────────────────
 * The owner could not place several cards — "brain activity vs memory", "how it's wired", "trust &
 * provenance", "what caught Claude". Every card now carries a one-click "i" that says, in the page's
 * own quiet voice, what it shows and why it matters. One author wrote all of these so they read as
 * one voice; each is attached via infoBtn() to a title node the render function already rebuilds. */
const STACK_INFO = ['Every rUv package installed globally on this computer, checked against the npm '
  + 'registry and grouped by family (ruflo, AgentDB, RuVector, and so on). This is what’s on disk and '
  + 'at what version — not whether it’s actually running; that’s the wiring card, further down.'];
const CAPABILITIES_INFO = ['Every capability this stack can offer — routing, learning, guardrails, and '
  + 'the rest — with the state we actually observed on this machine: on, off, set up but idle, not '
  + 'installed, or not checked. This card mostly reads. A few rows carry a tickable box, and even there '
  + 'ticking only opens the consent-gated proposal in “What we’d suggest” below — nothing runs until '
  + 'you confirm it there, with its evidence, its cost, and its undo.'];
const LEARNINGS_INFO = ['A separate, smaller stream from the memory below it: not what your projects '
  + 'contain, but patterns in how you work — noticed across every project and reused everywhere. Your '
  + 'project facts stay isolated; this strip is the one thing that deliberately crosses that boundary.'];
const MEMORY_INFO = [
  { k: 'What is this?', t: 'A quality score for the memory system itself, not a feed of events. '
      + '“What is happening in this project” shows individual things your AI did; this card asks whether '
      + 'the memory behind every project is actually reliable — does it survive a compaction, does '
      + 'recall really work, is it current.' },
  { k: 'Why does it matter?', t: 'A memory store can be running and full of entries and still be '
      + 'useless — the score is graded on real checks, never on whether the lights are on.' },
  { k: 'How does it help me?', t: 'A dimension we couldn’t verify this session is shown grey and '
      + 'excluded from the score, never guessed at — so a perfect number is never quietly covering for '
      + 'something nobody tested.' },
];
const ROUTER_ENGINE_INFO = ['The routing engine itself, opened up: which package is actually deciding '
  + '(rUv’s @metaharness/router, not a lookalike), whether it’s still learning your patterns or routing '
  + 'on real history, and its most recent real decisions straight from its own log — never a simulation.'];
const DISTRIBUTION_INFO = ['How your routed tasks split across mechanical/cheap/mid/frontier bands, '
  + 'with the money saved for each stripe of the bar — from real receipts, matched one-for-one against '
  + 'what running everything on the frontier model would have cost.'];
const PROVIDERS_INFO = ['Two separate choices, not one: “Your plan” is which subscription the router '
  + 'treats as free (the biggest cost lever you have); “OpenRouter” is an optional second lane for '
  + 'offloading plain-text tasks to even cheaper models. Turning one on never changes the other.'];
const SAVINGS_INFO = ['MetaHarness is explained just above; this card is its report card — real receipts '
  + 'from tasks it has actually routed, never a projected or modelled number. Nothing here counts until '
  + 'it’s actually happened.'];
const TRUST_CARD_INFO = [
  { k: 'What is this?', t: '“Provenance” means: can you check that what’s running on your machine is '
      + 'really what rUv published, instead of taking it on faith? Each row below is one such check — the '
      + 'release fingerprint, the parts list, how you get updates, and how cautious the console is allowed to be.' },
  { k: 'Why does it matter?', t: 'Software you can’t verify is software you can only trust — verified '
      + 'beats trusted, and this card is where that gets proven, row by row.' },
  { k: 'How does it help me?', t: 'Every row says plainly whether it’s live today or still coming — '
      + 'nothing here is dressed up as measured when it wasn’t.' },
];
const GATES_INFO = [
  { k: 'What is this?', t: 'Gates are checks that run before your AI touches your machine — most just '
      + 'add context, but some can refuse the action outright. This card is the ledger: what got refused, '
      + 'by which gate, and why.' },
  { k: 'Why does it matter?', t: '“Nothing caught yet” and “nothing is being checked” look identical '
      + 'unless the count of armed gates is shown alongside it — this card gives you both, so silence '
      + 'reads as silence, never as an all-clear.' },
  { k: 'How does it help me?', t: 'Every catch names the gate, what it stopped, and when — recorded '
      + 'since it was first armed, never guessed at for anything before that.' },
];
const LESSONS_INFO = ['Rules your AI now follows on this machine — not memory (facts it recalls) and '
  + 'not activity (things it did): specific behavioral corrections, most of them in your own words, that '
  + 'it applies from now on. Every one has a switch, and turning one off never deletes the record of '
  + 'where you taught it.'];

/* What/Why/How copy — three beats, every Settings row (WP4). */
const SETTING_INFO = {
  qeFleet: [
    { k: 'What is this?', t: 'A squad of test agents that spins up only when you ask — it can write tests for your code, measure what your tests miss, scan for security holes, and check accessibility.' },
    { k: 'Why does it matter?', t: 'Untested code breaks in front of users.' },
    { k: 'How does it help me?', t: 'Say “QE this” and the fleet does a quality pass no human has patience for.' },
  ],
  routing: [
    { k: 'What is this?', t: 'Sends small mechanical tasks to small cheap models and saves the big model for hard work.' },
    { k: 'Why does it matter?', t: 'Most AI work doesn’t need the expensive model.' },
    { k: 'How does it help me?', t: 'Same quality where it counts, at a fraction of the spend — every routing decision is receipted.' },
  ],
  nightly: [
    { k: 'What is this?', t: 'Rebuilds the knowledge base overnight so answers track the newest source.' },
    { k: 'Why does it matter?', t: 'This ecosystem ships fast — stale knowledge means wrong answers.' },
    { k: 'How does it help me?', t: 'You wake up current without doing anything.' },
  ],
  provider: [
    { k: 'What is this?', t: 'Which AI stack is yours — sets your frontier model and what “savings” are measured against.' },
    { k: 'Why does it matter?', t: 'The router should ride licenses you already pay for.' },
    { k: 'How does it help me?', t: 'Click your house and routing adapts to your subscriptions automatically.' },
  ],
  openrouterKey: [
    { k: 'What is this?', t: 'One key that unlocks many cheap models from many providers.' },
    { k: 'Why does it matter?', t: 'The biggest savings come from models outside your main subscription.' },
    { k: 'How does it help me?', t: 'Paste it once, the cheap lane lights up — stored only in your user folder.' },
  ],
};

/* Dev-vs-Prod economics, in the owner's words (WP3). */
const PROFILE_INFO = {
  Development: ['Development is you, building your app. You already pay for a subscription (Claude Max, Codex) — dev work rides it at no extra cost, so this table optimizes for speed on your license.'],
  Production: ['Production is your app, serving other people. Your users can’t ride your personal subscription — production runs on metered API calls you pay per token, so this table optimizes for cost-per-quality on every call. Different economics — that’s why there are two tables.'],
};

/* The wiring card's click-to-learn (WP6). */
const WIRING_INFO = [
  { k: 'What is this?', t: 'A live map of how each project launches the RuvNet tools — a fresh npx download on every call, or your one global install.' },
  { k: 'Why does it matter?', t: 'npx keeps hidden private copies that can go stale — old code quietly answers while every command still “works”.' },
  { k: 'How does it help me?', t: 'You see exactly where each style is in use, and every fix below is one click with the undo recorded first.' },
];

function familyRow(fam) {
  const tone = fam.attention ? 'warn' : 'green';
  const statusText = fam.attention ? `${fam.attention} need${fam.attention === 1 ? 's' : ''} a look` : 'current';
  const count = fam.items.length;
  // Version on the row (Stuart 2026-07-17: "show the version numbers"). Healthy family → the
  // flagship's version. Attention family → the problem AND its resolution on the same line:
  // "installed → target" right beside the fix button.
  // Exception (issue #23): "More RuvNet tools" is an explicit heterogeneous catch-all — its members
  // are unrelated packages on independent version lines, so items[0]'s version does NOT represent the
  // group yet reads as if it did. Suppress the flagship-version shorthand there (each package's real
  // version is still shown in the expanded table below). A specific "installed → target" for ONE
  // flagged package stays — it sits beside THAT package's fix button and is about it, not the group.
  const isCatchAll = fam.name === STACK_MORE.name;
  const first = fam.attention ? fam.items.find((i) => i.state === 'BEHIND' || i.state === 'BROKEN') : null;
  const verText = first
    ? `${first.installed ?? '?'} → ${first.target ?? 'latest'}`
    : (!isCatchAll && fam.items[0]?.installed ? `v${fam.items[0].installed}` : '');
  return el('details', { class: 'fam' },
    el('summary', { class: 'fam-sum' },
      el('span', { class: 'fam-name' }, fam.name),
      el('span', { class: 'fam-what' }, fam.what),
      el('span', { class: 'fam-status' },
        verText ? el('span', { class: 'fam-ver' + (first ? ' is-behind' : '') }, verText) : null,
        chip(statusText, tone),
        fam.attention ? el('button', {
          class: 'btn-fix', type: 'button', title: 'Jump to the one-click fix below (evidence, cost, and undo included)',
          onclick: (e) => {
            e.preventDefault(); e.stopPropagation();
            if (first) jumpToRec(`${first.state === 'BROKEN' ? 'repair' : 'sync'}:${first.name}`);
          },
        }, 'fix ↓') : null,
        el('span', { class: 'fam-count' }, count > 1 ? `${count} parts` : '1 pkg')),
      el('span', { class: 'fam-chev', 'aria-hidden': 'true' }, '›')),
    el('div', { class: 'fam-body' },
      el('div', { class: 'scroll-x' },
        el('table', { class: 'tb' },
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, 'Package'), el('th', { scope: 'col' }, 'Installed'),
            el('th', { scope: 'col' }, 'Target'), el('th', { scope: 'col' }, 'Tag'),
            el('th', { scope: 'col' }, 'State'))),
          el('tbody', {}, fam.items.map(pkgRow))))));
}

function renderStack(data) {
  if (stackTicker) { clearInterval(stackTicker); stackTicker = null; }
  const body = $('#body-stack');
  const sum = data.summary || {};
  const pkgs = Array.isArray(data.packages) ? [...data.packages] : [];
  const shadows = Array.isArray(data.shadows) ? data.shadows : [];

  const total = sum.total ?? pkgs.length;
  const current = sum.current ?? pkgs.filter((p) => p.state === 'CURRENT').length;
  const behind = sum.behind ?? pkgs.filter((p) => p.state === 'BEHIND').length;
  const ahead = sum.ahead ?? pkgs.filter((p) => p.state === 'AHEAD').length;
  const broken = sum.broken ?? pkgs.filter((p) => p.state === 'BROKEN').length;
  const stale = sum.stale ?? shadows.filter((s) => s.stale).length;

  const chips = [chip(`${fmtInt(current)} current`, 'green')];
  if (behind) chips.push(chip(`${fmtInt(behind)} behind`, 'warn'));
  if (ahead) chips.push(chip(`${fmtInt(ahead)} ahead`, 'cyan', STATE_TITLE.AHEAD));
  if (broken) chips.push(chip(`${fmtInt(broken)} broken`, 'red'));
  if (stale) chips.push(chip(`${fmtInt(stale)} stale shadows`, 'warn'));
  setChips('chips-stack', chips);

  // The stack card leads the page but only EXPANDS when it has something to say (Stuart,
  // 2026-07-16): an action to take (behind/broken/stale), or the user's first visit ever.
  // A clean stack on a repeat visit stays collapsed — the green chip is the whole story.
  const stackCard = $('#card-stack');
  if (stackCard && !stackCard.dataset.userToggled) {
    const firstVisit = !localStorage.getItem('rvbc-seen');
    if (behind || broken || stale || firstVisit) stackCard.open = true;
  }
  try { localStorage.setItem('rvbc-seen', '1'); } catch { /* private mode */ }

  found.pkgTotal = total;
  found.pkgCurrent = current;
  updateFoundStrip();

  pkgs.sort((a, b) =>
    (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) || String(a.name).localeCompare(String(b.name)));
  const attention = pkgs.filter((p) => ['BROKEN', 'BEHIND', 'UNRESOLVED'].includes(p.state));

  const main = [];
  main.push(el('p', { class: 'lead-stat' },
    'We read ', el('b', {}, fmtInt(total)), ' packages on your global stack — ',
    el('b', {}, fmtInt(current)), ' current',
    ahead ? el('span', {}, ', ', el('b', {}, fmtInt(ahead)), ' ahead of the registry (which is legal)') : '',
    broken ? el('span', {}, ', ', el('b', {}, fmtInt(broken)), ' broken') : '',
    behind ? el('span', {}, ', ', el('b', {}, fmtInt(behind)), ' behind') : '',
    '.', infoBtn('Your stack', STACK_INFO)));

  if (pkgs.length) {
    main.push(el('p', { class: 'impact-note' },
      attention.length
        ? el('span', {},
            `${fmtInt(attention.length)} package${attention.length === 1 ? '' : 's'} need${attention.length === 1 ? 's' : ''} a look — every one has a one-click fix with evidence, cost, and undo. `,
            el('button', {
              class: 'btn-fix', type: 'button',
              onclick: () => jumpToRec(attention[0].state === 'BROKEN' ? `repair:${attention[0].name}` : `sync:${attention[0].name}`),
            }, 'take me to the fix ↓'))
        : 'Nothing needs attention — every package matches its target, one copy each.'));
    // Attention families bubble to the top (Stuart 2026-07-17); the healthy remainder keeps the
    // curated blast-radius order (never alphabetical). Stable sort preserves it within each group.
    main.push(el('div', { class: 'fam-list' },
      groupFamilies(pkgs).sort((a, b) => (b.attention || 0) - (a.attention || 0)).map(familyRow)));
  } else {
    main.push(el('p', { class: 'muted' }, 'No stack packages detected on this machine yet.'));
  }

  if (shadows.length) {
    // Problems only (Stuart 2026-07-17: "just tell me the ones I need to deal with — never an
    // issue without its resolution on the same line"). Stale rows carry their one-click fix
    // (the purge:shadows recommendation — evidence, cost, undo); the in-sync majority collapses
    // to a single verified line with a peel-back for whoever wants the full inventory.
    const staleRows = shadows.filter((s) => s.stale);
    const syncCount = shadows.length - staleRows.length;
    main.push(el('aside', { class: 'shadows' },
      el('p', { class: 'shadows-title' }, 'Shadow copies in the npx cache',
        staleRows.length ? chip(`${staleRows.length} stale`, 'warn') : chip('all in sync', 'green')),
      staleRows.length ? el('p', { class: 'shadows-sub' },
        'npx keeps private copies in ', el('code', {}, '~/.npm/_npx'),
        '. A stale one quietly answers instead of your newer install — every command still “works”, which is exactly why it’s invisible. These need dealing with:') : null,
      ...staleRows.map((s) => el('div', { class: 'shadow-row' },
        el('span', { class: 'shadow-name' }, s.name || '—'),
        el('span', { class: 'shadow-vers' }, `cache ${s.version ?? '?'} · global `, el('b', {}, s.global ?? '?')),
        chip('stale', 'warn'),
        el('button', {
          class: 'btn-fix', type: 'button',
          title: 'Jump to the one-click removal below — evidence, cost, and undo included',
          onclick: () => jumpToRec('purge:shadows'),
        }, 'remove it ↓'),
        el('span', { class: 'shadow-dir' }, s.dir || ''),
      )),
      el('p', { class: 'shadows-ok' },
        staleRows.length
          ? `The other ${fmtInt(syncCount)} cached ${syncCount === 1 ? 'copy matches' : 'copies match'} your installs — re-checked on every audit.`
          : shadows.length === 1
            ? 'The 1 cached copy matches your install — re-checked on every audit; nothing is hiding stale.'
            : `All ${fmtInt(shadows.length)} cached copies match your installs — re-checked on every audit; nothing is hiding stale.`),
      el('details', { class: 'sub' },
        el('summary', {}, `Peel it back — ${shadows.length === 1 ? 'the 1 cached copy' : `all ${fmtInt(shadows.length)} cached copies`}`),
        el('div', { class: 'sub-body' },
          shadows.map((s) => el('div', { class: 'shadow-row' },
            el('span', { class: 'shadow-name' }, s.name || '—'),
            el('span', { class: 'shadow-vers' }, `cache ${s.version ?? '?'} · global `, el('b', {}, s.global ?? '?')),
            s.stale ? chip('stale', 'warn') : chip('in sync', 'green'),
            el('span', { class: 'shadow-dir' }, s.dir || ''),
          ))))));
  }

  body.replaceChildren(withIllo('stack', ...main));
}

/* ------------------------------------------- section 1b: what's on, what's off
   THE MURK, ADDRESSED. Owner, 2026-07-22: "a ton of people don't know what is or isn't turned on
   because it's very much a black box."

   The console already knew plenty — capability-audit.mjs has had three working detectors since
   2026-07-22 and they report real, observed state — but every one of them surfaced only as a
   RECOMMENDATION, i.e. only when something was wrong. There was no surface anywhere that answered
   the plain question "what is on right now", so a machine with nothing wrong looked identical to a
   machine nobody had checked. That is the black box: not missing data, missing a place to read it.

   FOUR STATES, AND THE ONES THAT ARE NOT "OFF" ARE THE WHOLE POINT.
   ON (green) · OFF (amber) · UNKNOWN (grey, dashed, "not checked") · ABSENT (grey, "not installed").
   Rendering an unchecked capability as OFF would be the console telling the user a fact it does not
   have — the precise lie this project bans (a detector that didn't answer is not a detector that
   answered "no"). ABSENT is the second half of that: "you do not have this" and "you have it and it
   is switched off" are different sentences with different actions behind them, and collapsing them
   sends people to turn on software they never installed. So both are carried end-to-end and drawn in
   a different visual CHANNEL from OFF, not just a different hue: dashed rail + dashed chip for
   unknown, solid-but-muted for absent, so they survive greyscale, colour-blindness, and a squint from
   six feet. (This header said THREE for one commit after ABSENT shipped — a comment claiming the code
   below it was simpler than it is.)

   DATA-DRIVEN, NO EXCEPTIONS. Not one capability name appears in this file or in index.html. Rows
   come from /api/capabilities and only from there; a capability added server-side shows up here with
   zero client change. The alternative — a hardcoded list — rots the week rUv ships again, which is
   the same rot capability-audit.mjs explicitly refuses in its own header. */

const CAP_STATE = {
  ON: {
    tone: 'green', klass: 'is-on', label: 'on',
    hint: 'Observed on this machine — the evidence beside it is what we saw.',
  },
  OFF: {
    tone: 'amber', klass: 'is-off', label: 'off',
    hint: 'We looked and it is not running. This is a measured "off", not an assumption.',
  },
  /* IDLE — the state this whole product exists to surface, and the card could not say it until now.
     Owner, 2026-07-24: "people think something is 'On' only to find out it is not really running the
     way they thought — that is exactly what this tool is for."

     Its label is deliberately NOT "off". Off sends you to turn a thing on; this thing IS on, and
     something that should be calling it stopped. Sending someone to re-enable an already-enabled
     capability is how a true finding becomes a wasted afternoon. The distinct wording — "set up, not
     running" — is the whole value of separating them. */
  IDLE: {
    tone: 'amber', klass: 'is-off', label: 'set up, not running',
    hint: 'Configured and proven — it has worked here before — but nothing has invoked it recently. '
        + 'This is usually a wiring gap, not a switch: something that should call it is missing or was never installed.',
  },
  UNKNOWN: {
    tone: 'nt', klass: 'is-unknown', label: 'not checked',
    hint: 'Nothing established this one either way, so nothing is claimed. Not checked is not off.',
  },
  /* ABSENT is a MEASURED ANSWER, and leaving it out was this card's own version of the lie it exists
     to kill — inverted. The registry has emitted four states since it was written; this console knew
     three, so every "we looked and it is not installed here" landed in the unknown bucket wearing the
     hint "the server reported a state this console doesn't recognise". Hard facts, filed under
     "we couldn't tell, and won't guess."

     It bites hardest on precisely the machine the bar names: a brand-new install, where most rows are
     legitimately `absent`. The newcomer whose console must be most trustworthy got the most rows
     mislabelled as unanswered. "Not installed" is not ignorance — it is the answer, and it is the one
     that tells them what to do next. */
  ABSENT: {
    tone: 'grey', klass: 'is-absent', label: 'not installed',
    hint: 'We looked and this piece is not on this machine — a measured answer, not a guess. Installing it is what changes this row.',
  },
};

/* ON / OFF / UNKNOWN / ABSENT, or null for a token this console has never heard of. A future
   capability reporting some richer state must NOT be quietly folded into OFF — it lands in the
   unknown bucket and shows its own raw word, which is honest about both the state and our ignorance
   of it. Adding ABSENT here does not weaken that rule; it retires one specific known state from the
   "we've never heard of it" pile, where it never belonged. */
function capState(raw) {
  const t = String(raw ?? '').trim().toUpperCase();
  // 'IDLE' added 2026-07-24. This whitelist is exactly where the ABSENT bug lived (see CAP_STATE):
  // the registry gains a state, this line does not, and every row carrying it lands in UNKNOWN
  // wearing a label that says we never looked — when in fact we looked and found something specific.
  // Any future state must be added HERE, in the tally, in the chips, and in RANK — all four.
  return (t === 'ON' || t === 'OFF' || t === 'IDLE' || t === 'UNKNOWN' || t === 'ABSENT') ? t : null;
}
const capBucket = (row) => capState(row && row.state) || 'UNKNOWN';

/* THE ONE GATE THAT DECIDES WHETHER A ROW EARNS A CHECKBOX AT ALL.
 *
 * A checkbox is a STRONGER promise than the plain-text turn-on line above it: a button says "you
 * could run this"; a checkbox says "this is a switch, and I am telling you its current position." So
 * the bar is at least as strict as the bar for text, and in one respect stricter — the server only
 * ever stamps `row.recId` once it built a full, schema-gated Recommendation (evidence, cost, change,
 * undo all present — see console-engine.mjs's makeRecommendation()) AND capability-registry.mjs's own
 * proven-undo map accepted the row (buildCapabilityRecommendations() there — currently exactly
 * memory-distillation, and only while OFF). See that file's header for the full "why".
 *
 * This is intentionally REDUNDANT with what the server already guarantees. A client-side check that
 * merely trusted `row.recId` being truthy would work today and silently stop meaning anything the
 * moment a future edit stamped it for the wrong reason — exactly the shape of "a field-name typo made
 * one repo permanently unverified" (fix(3.9.69)). Re-derive every gate here; never just trust the flag. */
function capCheckboxEligible(row, known) {
  if (known !== 'OFF') return false;                                  // never ON / IDLE / UNKNOWN / ABSENT
  if (String(row.scope || '').toLowerCase() === 'machine') return false; // machine-wide: full rec-card path only, never an inline tick
  const cmd = row.turnOn && typeof row.turnOn === 'object' && typeof row.turnOn.cmd === 'string' ? row.turnOn.cmd : '';
  if (!cmd || /<[^>]+>/.test(cmd)) return false;                       // no verified command, or one with a blank to fill in
  if (typeof row.recId !== 'string' || !row.recId) return false;       // the server never vouched for this one
  return true;
}

/* Evidence arrives in whichever shape the detector that produced it already uses: a plain string,
   a list of strings, or capability-audit.mjs's own [{ observed }] records. Accept all three rather
   than force one, and silently drop nothing-shaped entries — an empty bullet is noise, not evidence. */
function capEvidence(ev) {
  const src = Array.isArray(ev) ? ev : (ev == null ? [] : [ev]);
  const out = [];
  for (const e of src) {
    const t = (typeof e === 'string') ? e
      : (e && typeof e === 'object') ? (e.observed ?? e.text ?? e.detail ?? e.note) : null;
    if (typeof t === 'string' && t.trim()) out.push(t.trim());
  }
  return out;
}

/* THE CAPABILITIES CARD'S ONLY INTERACTIVE CONTROL, and it does not itself apply anything — it points
 * at the one place that does. The console already has exactly one tested state machine for "show
 * evidence/cost/undo, get consent, apply, confirm, offer undo": the rec cards in "What we'd suggest"
 * (buildRecCard/doApply/showConfirm/applied/doUndo above), fed by makeRecommendation()'s schema gate,
 * which cannot construct a Recommendation missing evidence, cost, change, or undo. A checkbox that
 * POSTed to /api/apply on its own, carrying its own payload, would be a SECOND, unaudited way to
 * trigger a machine mutation — precisely the "two answers to one question" failure this project has
 * already shipped more than once (capability-registry.mjs's learningEnable story, the hooks-list
 * story). So this rides jumpToRec(recId) unchanged, the exact pattern the stack card's "attention" rows
 * already use.
 *
 * The box must never visually move on its own click. It only ever shows checked once recheckMachine()
 * has re-run the real detector and the row re-renders with state 'on' — at which point capRow() stops
 * calling capCheckboxEligible entirely (known !== 'OFF') and this function is never called again for
 * that row. There is no code path that sets `.checked = true` directly; clicking this box always
 * preventDefault()s and only ever opens the real card. */
function capCheckbox(row) {
  const id = `capbox-${row.key}`;
  const humanAction = (row.turnOn && row.turnOn.human) || `Turn on ${row.label || row.key}`;

  // GUARD FOR "the rec hasn't loaded yet". /api/state, /api/stack, and /api/memory settle at
  // different times (see stateRecsSettled/stackRecsSettled/healthRecsSettled), and jumpToRec()
  // silently no-ops if `#rec-<id>` isn't in the DOM yet. Rather than let a click do nothing with no
  // explanation, an eligible row whose card has not rendered yet gets an honest, disabled placeholder
  // instead of a clickable box that might fail silently.
  const recNode = document.getElementById(`rec-${row.recId}`);
  if (!recNode) {
    return el('div', { class: 'cap-toggle-wrap cap-toggle-pending' },
      el('span', { class: 'cap-toggle-text muted' }, `${humanAction} — still loading the full proposal…`));
  }

  const cb = el('input', {
    type: 'checkbox', id, class: 'cap-toggle', checked: false, disabled: false,
    'aria-describedby': `${id}-note`,
    onclick: (ev) => {
      // preventDefault() keeps it unchecked; jumpToRec is what actually moves the world.
      ev.preventDefault();
      jumpToRec(row.recId);
      announce(`Opening the one-click control for ${row.label || row.key} — nothing has changed yet.`);
    },
  });
  return el('div', { class: 'cap-toggle-wrap' },
    el('label', { class: 'cap-toggle-label', for: id }, cb,
      el('span', { class: 'cap-toggle-text' }, humanAction)),
    el('p', { class: 'cap-toggle-note', id: `${id}-note` },
      'Ticking this opens the full proposal below — evidence, cost, and the undo — and applies ',
      'nothing until you confirm it there.'));
}

/* IDLE — never a checkbox (see capCheckboxEligible: known !== 'OFF' rules it out outright). Says so,
   once, so the absence of a control here reads as a decision rather than an oversight — the same
   "state one MORE fact" principle capLegend() already applies to the five state chips. */
function capIdleNote() {
  return el('p', { class: 'cap-honest-mark is-idle' },
    el('span', { class: 'mark-glyph', 'aria-hidden': 'true' }, '◐'),
    'Not a switch to flip — this ran before and something that should call it stopped. ',
    'Fixing it means re-wiring the hook or gate named in the evidence above, not running a command.');
}

/* UNKNOWN (and its ABSENT sibling handled inline in capRow) — never a checkbox; we do not know the
   current position, so there is nothing honest to show a box toggling from. Terse and low-weight on
   purpose: this is the least actionable of the five states and should take the least space. */
function capUnknownNote() {
  return el('p', { class: 'cap-honest-mark is-unknown' },
    el('span', { class: 'mark-glyph', 'aria-hidden': 'true' }, '?'),
    'Not checked — nothing to tick here until this can be read.');
}

function capRow(row) {
  const known = capState(row.state);
  const st = CAP_STATE[known || 'UNKNOWN'];
  const raw = String(row.state ?? '').trim();
  // An unrecognised state shows its own word, not ours — relabelling it "not checked" would hide
  // that the server did answer, and calling it "off" would invent an answer it never gave.
  const label = known ? st.label : (raw ? raw.toLowerCase().slice(0, 24) : st.label);
  const hint = known ? st.hint
    : `The server reported the state “${raw}”, which this console doesn’t recognise — so it is grouped with the unchecked rather than guessed either way.`;

  const buys = (typeof row.whatItBuysYou === 'string' && row.whatItBuysYou.trim())
    ? row.whatItBuysYou.trim() : null;
  const evidence = capEvidence(row.evidence);

  /* THE RECOMMENDATION HALF OF THE QUESTION. The brief is "SHOULD it be on for this user, and IS it
     on" — the state chip answers IS, and until now nothing answered SHOULD. The registry has shipped
     a `turnOn: {human, cmd}` on every row it can verify one for, and this renderer dropped it on the
     floor, so the console displayed exactly half of what the server already knew.

     Rendered as TEXT, never a button. There is no executor and no undo behind these commands here,
     and this project has already shipped one dead button; a control that looks live and does nothing
     is worse than a command you can read and decide about yourself.

     A null turnOn is SAID OUT LOUD rather than omitted, because the registry's own header rule is
     that four capabilities have no verified enable command and silence would read as "nothing can be
     done about this" — which is a different, quieter falsehood. */
  const turnOn = (row.turnOn && typeof row.turnOn === 'object'
    && typeof row.turnOn.cmd === 'string' && row.turnOn.cmd.trim()) ? row.turnOn : null;
  const wantsAdvice = known === 'OFF' || known === 'ABSENT';
  // THE ONE ROW-LEVEL DECISION THAT CAN PROMOTE PLAIN TEXT TO A REAL CONTROL. See
  // capCheckboxEligible()'s own header for the full gate list; checked FIRST and narrowly, so a row
  // that fails even one gate falls straight through to the exact same honest text this card already
  // rendered before checkboxes existed — nothing about the non-eligible path changes.
  const checkboxEligible = capCheckboxEligible(row, known);

  return el('div', { class: `cap-row ${st.klass}` },
    el('span', { class: 'cap-name' },
      String(row.label || row.key || 'unnamed capability'),
      row.scope ? el('span', { class: 'cap-scope', title: `where this applies: ${row.scope}` }, String(row.scope)) : null),
    el('div', { class: 'cap-val' },
      buys
        ? el('p', { class: 'cap-buys' }, buys)
        : el('p', { class: 'cap-buys cell-dim' },
            'No plain-words description came with this one — inventing a benefit for it would be worse than leaving the line empty.'),
      /* EVIDENCE IS OPEN WHEN IT ASKS SOMETHING OF YOU, FOLDED WHEN IT ONLY REASSURES.
       *
       * Graded 88/100 on 2026-07-24 with the largest single deduction (-4) being that every row
       * carried a maintainer-altitude evidence paragraph inline. On this machine that is TEN rows of
       * proof-of-health expanded by default — the capabilities card became the longest thing on the
       * page, and the 12-to-4 restructure could not fix it because the weight was per-row, not
       * per-section.
       *
       * The wrong fix is hiding evidence. Evidence is what separates this page from a dashboard that
       * asserts, and the rule is that every claim carries what we observed. So nothing is removed —
       * it is RANKED. A row that wants something from you (off, idle, or unknown) keeps its evidence
       * open, because that is the row you are being asked to act on and the reasoning has to be right
       * there. A row that is simply working folds its proof behind one line you can open any time.
       *
       * Attention-first, the same law the row ORDER already follows. Rendering confirmation at the
       * same visual weight as a finding is how a page with ten healthy rows buries its one real one. */
      evidence.length
        ? (known === 'ON' || known === 'ABSENT'
          ? el('details', { class: 'cap-why' },
              el('summary', null, `Show the evidence (${evidence.length === 1 ? '1 observation' : `${evidence.length} observations`})`),
              el('ul', { class: 'cap-ev' }, ...evidence.map((e) => el('li', {}, e))))
          : el('ul', { class: 'cap-ev' }, ...evidence.map((e) => el('li', {}, e))))
        : el('p', { class: 'cap-ev-none cell-dim' }, 'No evidence was recorded for this row.'),
      checkboxEligible
        ? capCheckbox(row)
        : wantsAdvice
          ? (turnOn
            ? el('p', { class: 'cap-turnon' },
                el('span', { class: 'cap-turnon-lb' }, 'to turn it on'),
                String(turnOn.human || 'run'), ' — ', el('code', {}, String(turnOn.cmd)))
            : el('p', { class: 'cap-turnon cap-turnon-none' },
                el('span', { class: 'cap-turnon-lb' }, 'to turn it on'),
                'No verified one-line command exists for this one, so none is offered — a command that ',
                'sends you to a terminal to be told “unknown subcommand” would cost you trust in every ',
                'other row on this page.'))
          // Neither "wants advice" nor eligible for a checkbox: IDLE and UNKNOWN still get an honest,
          // non-interactive mark rather than silence — the same "state one more fact" principle the
          // legend below already applies to the five state chips. ON says nothing further; its chip
          // already is the whole answer.
          : known === 'IDLE'
            ? capIdleNote()
            : known === 'UNKNOWN'
              ? capUnknownNote()
              : null),
    el('span', { class: 'cap-status' }, chip(label, st.tone, hint)));
}

/* The colour key, stated once at the top of the card. The page already teaches its rail colours in
   the same shape (.stage-legend) — this borrows the grammar, not the class, because the two legends
   answer different questions and must be free to move apart. */
function capLegend() {
  return el('p', { class: 'cap-legend mono' },
    // FIVE, not four. Caught by an independent grader on 2026-07-24, and it is the sharpest possible
    // defect for this particular card: the legend said "the four states" while renderCapabilities()
    // below already emitted a fifth chip ("set up, not running") for STATE.IDLE. A machine with an
    // idle capability displayed a state its own legend never defined — on the one card whose entire
    // job is "the black box, opened." The product told a small lie about itself, which is the exact
    // failure IDLE was added to expose in everything else. Adding the state without its legend row
    // was my omission, not a pre-existing gap.
    el('span', { class: 'cl-cap' }, 'the five states'),
    el('span', { class: 'cl' }, el('span', { class: 'cl-key k-on' }), 'on — observed here'),
    el('span', { class: 'cl' }, el('span', { class: 'cl-key k-idle' }), 'set up, not running — nothing is calling it'),
    el('span', { class: 'cl' }, el('span', { class: 'cl-key k-off' }), 'off — present, not running'),
    el('span', { class: 'cl' }, el('span', { class: 'cl-key k-absent' }), 'not installed — we looked, it isn’t here'),
    el('span', { class: 'cl' }, el('span', { class: 'cl-key k-unknown' }), 'not checked — we couldn’t tell, and won’t guess'),
    // NEW — states one MORE fact: a checkbox appearing at all is itself informative (state off, a
    // verified command, a proven undo), so say what its absence means too. Same principle as adding
    // IDLE to this legend in the first place: the reader should never have to infer "nothing to tick
    // here" from silence alone.
    el('span', { class: 'cl cl-checkbox-note' },
      '☐ a tickable box only appears where flipping it is single-step, reversible, and proven — everything else explains itself in words, on purpose'));
}

function advocacyPrecisionSummary(advocacy) {
  const p = advocacy && advocacy.precision;
  if (!p || typeof p !== 'object') return null;
  const n = Number(p.offered) || 0;
  const applied = Number(p.applied) || 0;
  const interval = Array.isArray(p.interval) && p.interval.length === 2
    ? `${Math.round(Number(p.interval[0]) * 100)}–${Math.round(Number(p.interval[1]) * 100)}%`
    : null;
  if (!n || p.precision == null) {
    return el('section', { class: 'cap-precision', 'aria-label': 'Advocacy precision' },
      el('h3', {}, 'Advocacy precision · accruing'),
      el('p', {}, 'Not judgeable yet — no resolved offers have accumulated. This is a ',
        el('b', {}, 'post-launch metric'), ', never a fabricated launch score.'));
  }
  return el('section', { class: 'cap-precision', 'aria-label': 'Advocacy precision' },
    el('h3', {}, 'Advocacy precision · accruing'),
    el('p', {},
      el('b', {}, `${applied} of ${n}`), ' resolved offers were applied',
      interval ? ` · honest 95% interval ${interval}` : '',
      '. This remains a ', el('b', {}, 'post-launch metric'), ' while evidence accumulates.'));
}

let lastCapabilities = null;   // kept so the card can re-render once the rec cards its checkboxes point at have mounted
function renderCapabilities(data) {
  lastCapabilities = data;
  const body = $('#body-capabilities');
  const rows = Array.isArray(data && data.rows)
    ? data.rows.filter((r) => r && typeof r === 'object')
    : null;

  // 200 with a body we can't read is NOT an empty machine. Say which of the two happened.
  if (!rows) {
    setChips('chips-capabilities', [chip('not checked', 'nt')]);
    body.replaceChildren(withIllo('capabilities',
      el('p', { class: 'lead-stat' }, 'Not checked — the answer arrived in a shape this page can’t read.'),
      el('p', {}, 'The console asked for your capability states and got a reply without a readable ',
        el('code', {}, 'rows'), ' list. Rather than show you something invented from a malformed answer, ',
        'this card shows nothing and says so.'),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { capsSkeleton(); loadCapabilities(); } }, 'Try again')));
    return;
  }

  if (!rows.length) {
    // Empty-first: a fresh machine with nothing installed must read honestly and sensibly.
    setChips('chips-capabilities', [chip('nothing to report', 'grey')]);
    body.replaceChildren(withIllo('capabilities',
      el('p', { class: 'lead-stat' }, 'Nothing to report yet.'),
      el('p', {}, 'The audit ran and found no capabilities to describe on this machine — that is a real ',
        'answer, not a blank card. As you install more of the stack, each piece appears here with its ',
        'state and the evidence behind it.')));
    return;
  }

  const on = rows.filter((r) => capBucket(r) === 'ON').length;
  const off = rows.filter((r) => capBucket(r) === 'OFF').length;
  const absent = rows.filter((r) => capBucket(r) === 'ABSENT').length;
  // Counted explicitly, and SUBTRACTED from unknown below. `unknown` is computed as the remainder, so
  // any state the tally forgets is silently reported as "we never checked" — the same shape of lie in
  // the summary line that CAP_STATE fixed in the rows.
  const idle = rows.filter((r) => capBucket(r) === 'IDLE').length;
  const unknown = rows.length - on - off - absent - idle;

  const chips = [];
  if (on) chips.push(chip(`${fmtInt(on)} on`, 'green'));
  if (off) chips.push(chip(`${fmtInt(off)} off`, 'amber', CAP_STATE.OFF.hint));
  if (idle) chips.push(chip(`${fmtInt(idle)} set up, not running`, 'amber', CAP_STATE.IDLE.hint));
  if (absent) chips.push(chip(`${fmtInt(absent)} not installed`, 'grey', CAP_STATE.ABSENT.hint));
  if (unknown) chips.push(chip(`${fmtInt(unknown)} not checked`, 'nt', CAP_STATE.UNKNOWN.hint));
  setChips('chips-capabilities', chips);
  // Feed the verdict line. It needs the same counts this card just derived, and deriving them a
  // second time somewhere else is how two surfaces start disagreeing about one machine.
  found.capsOn = on; found.capsOff = off; found.capsAbsent = absent; found.capsUnknown = unknown;
  found.capsTotal = rows.length;
  updateFoundStrip();

  // Attention first, same law as every other list on this page (never alphabetical, never arrival
  // order): what you own but aren't getting, then what we couldn't answer, then what isn't here at
  // all, then what's already working. ABSENT sits below UNKNOWN because an unanswered question is
  // more actionable than a piece of software the user has simply not installed — and above ON
  // because "not here" is still a gap. Array#sort is stable, so the server's own ordering survives
  // inside each bucket.
  const RANK = { OFF: 0, IDLE: 1, UNKNOWN: 2, ABSENT: 3, ON: 4 };
  const sorted = rows.slice().sort((a, b) => RANK[capBucket(a)] - RANK[capBucket(b)]);

  // Built as clauses so a fresh machine — where `on` and `off` are both 0 and everything is absent —
  // reads as a sentence rather than as "0 on, 0 off". Empty-first is a rendering requirement, not
  // only a data one: the honest numbers still have to make sense out loud.
  const counts = [
    on ? el('span', {}, el('b', {}, fmtInt(on)), ' on') : null,
    off ? el('span', {}, el('b', {}, fmtInt(off)), ' off') : null,
    absent ? el('span', {}, el('b', {}, fmtInt(absent)), ' not installed') : null,
    unknown ? el('span', {}, el('b', {}, fmtInt(unknown)), ' we could not check') : null,
  ].filter(Boolean);
  const joined = [];
  counts.forEach((c, i) => {
    if (i) joined.push(i === counts.length - 1 ? ', and ' : ', ');
    joined.push(c);
  });

  const main = [];
  main.push(el('p', { class: 'lead-stat' },
    'We looked at ', el('b', {}, fmtInt(rows.length)),
    ` capabilit${rows.length === 1 ? 'y' : 'ies'} on this machine: `,
    ...joined, '.',
    unknown
      ? ' “Not checked” is its own answer here — no detector established those either way, so this card claims nothing about them.'
      : ' Every row below was established by something we observed, not assumed.'));

  main.push(capLegend());
  const precisionSummary = advocacyPrecisionSummary(data && data.advocacy);
  if (precisionSummary) main.push(precisionSummary);

  /* GROUPED BY SCOPE, not flat. `scope` has been in the registry since it was written
     (capability-registry.mjs — SCOPE.MACHINE / PROJECT / USER) and was rendered as a small grey
     badge nobody reads. As a badge it is trivia; as the GROUPING it answers the question the owner
     actually asks on opening this page: "what is switched on FOR THIS PROJECT, versus everywhere?"
     Order is most-specific-first — the project you are standing in is the one you can act on now,
     and the machine-wide rows are the ones you touch least often.

     A scope with no rows renders nothing at all. An empty "In this project" heading would imply we
     looked and found none, when the truth is there was nothing of that scope to look at. */
  const SCOPE_GROUPS = [
    { key: 'project', title: 'In this project', blurb: 'Applies only where you are right now. Changing these affects this project and nothing else.' },
    { key: 'user',    title: 'For you, in every project', blurb: 'Follows your user account across every project on this machine.' },
    { key: 'machine', title: 'On this machine', blurb: 'Machine-wide. These affect anyone using this computer, so they are the ones to read twice.' },
  ];
  const seen = new Set();
  const groups = [];
  for (const g of SCOPE_GROUPS) {
    const inGroup = sorted.filter((r) => String(r.scope || '').toLowerCase() === g.key);
    inGroup.forEach((r) => seen.add(r));
    if (!inGroup.length) continue;
    groups.push(el('section', { class: 'cap-group' },
      el('h3', { class: 'cap-group-h' }, g.title,
        el('span', { class: 'cap-group-n mono' }, `${inGroup.length}`)),
      el('p', { class: 'cap-group-blurb muted' }, g.blurb),
      el('div', { class: 'cap-list' }, ...inGroup.map(capRow))));
  }
  // Anything whose scope we do not recognise still gets shown — silently dropping a capability
  // because its scope string was unexpected would be the console lying by omission.
  const ungrouped = sorted.filter((r) => !seen.has(r));
  if (ungrouped.length) {
    groups.push(el('section', { class: 'cap-group' },
      el('h3', { class: 'cap-group-h' }, 'Everything else',
        el('span', { class: 'cap-group-n mono' }, `${ungrouped.length}`)),
      el('div', { class: 'cap-list' }, ...ungrouped.map(capRow))));
  }
  main.push(...groups);

  // Almost no control that can't act: this card mostly reads. The one exception — a row whose
  // checkbox cleared capCheckboxEligible()'s full gate list — still never applies anything itself; it
  // only opens the real, consent-gated card below. Say where the acting happens either way, instead of
  // growing a button (or a checkbox) with no executor and no undo behind it.
  main.push(el('p', { class: 'fineprint' },
    'This card mostly reads. A few rows carry a tickable box — even there, ticking only opens the ',
    'consent-gated proposal below; nothing runs until you confirm it ', el('b', {}, 'there'),
    ', with its evidence, its cost, and its undo.',
    infoBtn('What’s on, what’s off', CAPABILITIES_INFO)));

  body.replaceChildren(withIllo('capabilities', ...main));
}

function capsSkeleton() {
  $('#body-capabilities').replaceChildren(
    frag('<div class="skeleton" aria-hidden="true"><div class="sk-bar w40"></div><div class="sk-bar w80"></div><div class="sk-bar w65"></div></div>'),
    el('p', { class: 'loading-note' },
      'Checking each capability against this machine — local and read-only. ',
      'Anything we can’t establish is reported as “not checked”, never as “off”.'));
  setChips('chips-capabilities', [chip('checking…', 'wait')]);
}

/* The endpoint is NEW. A console binary older than this panel — or a plugin mid-update — simply has
   no /api/capabilities route, and the server's static handler answers 404 for it. That is a known,
   expected, non-broken condition and must not be dressed as a crash, so the status code is read
   directly here instead of being recovered from an error string. */
async function fetchCapabilities() {
  if (MOCK) return { ok: true, status: 200, data: structuredClone(MOCK_CAPABILITIES) };
  const res = await fetch('/api/capabilities', { headers: { Accept: 'application/json' } });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  return { ok: true, status: res.status, data: await res.json() };
}

function capsMissingEndpoint() {
  setChips('chips-capabilities', [chip('not checked yet', 'nt')]);
  $('#body-capabilities').replaceChildren(withIllo('capabilities',
    el('p', { class: 'lead-stat' }, 'Not checked yet — this console can’t ask the question.'),
    el('p', {}, 'The page asks ', el('code', {}, '/api/capabilities'),
      ' for the state of each capability, and the server answering right now doesn’t have that ',
      'endpoint — it was built before this panel existed. Nothing is inferred from that silence: ',
      'an unanswered question is not an ', el('b', {}, 'off'), ', so no rows are shown at all.'),
    el('p', {}, 'Update the Brain and restart the console, and this card fills itself in.'),
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { capsSkeleton(); loadCapabilities(); } }, 'Try again')));
}

async function loadCapabilities(attempt = 0) {
  try {
    const r = await fetchCapabilities();
    if (r.status === 404) { capsMissingEndpoint(); return; }
    if (!r.ok) throw new Error(`/api/capabilities answered HTTP ${r.status}`);
    if (r.data && r.data.warming) {
      // "Not measured yet" is NOT "off" — this card's entire reason for existing. Rendering a
      // warming answer would produce an empty row list, which on this surface says "you own
      // nothing", the single most damaging thing this page could get wrong.
      capsSkeleton();
      setChips('chips-capabilities', [chip('checking each capability…', 'wait')]);
      if (attempt < WARM_RETRY_MAX) setTimeout(() => { void loadCapabilities(attempt + 1); }, WARM_RETRY_MS);
      else setChips('chips-capabilities', [chip('check is taking unusually long', 'warn')]);
      return;
    }
    renderCapabilities(r.data);
  } catch (err) {
    // A real failure (server down, unparseable JSON) gets the page's real failure treatment —
    // deliberately different from the 404 above, so "not built yet" never reads as "broken".
    setChips('chips-capabilities', [chip('unavailable', 'grey')]);
    inlineError('body-capabilities', String(err.message || err), () => { capsSkeleton(); loadCapabilities(); });
  }
}

/* ----------------------------------------------------------- section 2: wiring */

const MECH_LABEL = { NPX: 'npx', GLOBAL_BINARY: 'global', PLUGIN: 'plugin', MCP: 'mcp' };

/* Verdict icons — same 2px round-cap stroke language as the page's other spot icons. */
const WV_ICON_CLEAN = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="8.6"/>
    <path d="M8.3 12.4l2.5 2.5 4.9-5.4"/>
  </svg>`;
const WV_ICON_DRIFT = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4.2 2.9 19.3h18.2z"/>
    <path d="M12 10.2v4.2"/>
    <path d="M12 17.1v.02"/>
  </svg>`;

function renderWiring(w) {
  const body = $('#body-wiring');
  // Attach the "how it's wired" explainer to the card's static <h2> UNCONDITIONALLY. It used to live
  // only inside the verdict banner, which mounts only when `total > 0` — so on a machine with zero
  // wiring sites the whole explainer vanished, which is almost certainly why this card was the one the
  // owner could never place. Idempotent because <h2> is a static node, not one rebuilt each render.
  const wh2 = document.querySelector('#card-wiring h2');
  if (wh2 && !wh2.querySelector('.info-btn')) wh2.append(infoBtn('How it’s wired', WIRING_INFO));
  if (!w) {
    setChips('chips-wiring', [chip('no data', 'grey')]);
    body.replaceChildren(el('p', { class: 'muted' }, 'No wiring data received.'));
    return;
  }
  const s = w.summary || {};
  const sites = Array.isArray(w.sites) ? w.sites : [];

  // The verdict this card exists for (Stuart 2026-07-17: "facts without purpose" — a census
  // is not an answer). One question, answered up top: when a rUv tool launches here, does the
  // version you installed actually run? Unpinned npx is the only lane that can lie — it keeps
  // a private copy in ~/.npm/_npx that quietly ages while every command still "works" (the
  // 3.25.6-vs-3.28.0 failure). Pinned npx (rUv's own style per his ruvector ADR, e.g.
  // `npx -y ruvector@0.2.25`) cannot drift — the villain is UNPINNED npx, not npx.
  // (renderGates answers "what stopped Claude"; this card answers "can what runs go stale".)
  const npxSites = sites.filter((x) => x.mechanism === 'NPX');
  const isPinned = (x) => /@\d+(\.\d+){0,2}([^\d.]|$)/.test(String(x.spec || ''));
  const driftSites = npxSites.filter((x) => !isPinned(x));
  // Summary counts npx but no rows arrived to inspect? Assume the worst, never the best.
  const driftN = (!npxSites.length && (s.npx ?? 0) > 0) ? (s.npx ?? 0) : driftSites.length;
  const pinnedN = npxSites.length - driftSites.length;
  const total = (s.npx ?? 0) + (s.global ?? 0) + (s.mcp ?? 0) + (s.plugin ?? 0);
  const projCount = new Set(sites.filter((x) => x.scope === 'project' && x.project).map((x) => x.project)).size;

  setChips('chips-wiring', total
    ? (driftN
        ? [chip(`${fmtInt(driftN)} can drift stale`, 'warn'), chip(`${fmtInt(total - driftN)} pinned down`, 'green')]
        // "can" claimed the FUTURE from present-tense evidence: we observed that 0 of N launch sites
        // currently resolve via npx, which establishes that nothing IS drifting, not that nothing
        // COULD. One npx line added tomorrow falsifies the stronger claim, and this project's whole
        // trust position rests on never making a claim its evidence cannot carry. Fable 5, 2026-07-24.
        : [chip('nothing is drifting', 'green'), chip(`${fmtInt(total)} launch sites`, 'grey')])
    : [chip('nothing wired yet', 'grey')]);

  found.npx = s.npx ?? 0;
  found.projects = s.projectsWithNpx ?? 0;
  found.projectNames = [...new Set(sites.filter((x) => x.scope === 'project' && x.project).map((x) => x.project))];
  updateFoundStrip();

  const main = [];
  if (total) {
    // ---- the verdict banner: the answer first, evidence below it ----
    const title = driftN
      ? `${fmtInt(driftN)} launch site${driftN === 1 ? '' : 's'} can silently run a stale copy`
      : 'Every rUv tool here resolves to one known version';
    const sub = [];
    if (driftN) {
      sub.push('Unpinned npx keeps a private copy in ', el('code', {}, '~/.npm/_npx'),
        ' and runs that — every command still “works” while old code answers. Rewire ',
        driftN === 1 ? 'it' : 'each one', ' to the global binary, or pin the exact version the way rUv does.');
    } else {
      const bits = [];
      if (s.global) bits.push(el('span', {}, el('b', {}, fmtInt(s.global)), ' through your one global binary'));
      if (s.mcp) bits.push(el('span', {}, el('b', {}, fmtInt(s.mcp)), ' through a running MCP server'));
      if (s.plugin) bits.push(el('span', {}, el('b', {}, fmtInt(s.plugin)), ' inside Claude Code itself'));
      if (pinnedN) bits.push(el('span', {}, el('b', {}, fmtInt(pinnedN)), ' via npx pinned to an exact version, which cannot age'));
      const joined = [];
      bits.forEach((b, i) => { if (i) joined.push(i === bits.length - 1 ? ' and ' : ', '); joined.push(b); });
      sub.push('All ', el('b', {}, fmtInt(total)), ' launch sites',
        projCount ? el('span', {}, ' across ', el('b', {}, fmtInt(projCount)), ` project${projCount === 1 ? '' : 's'}`) : '',
        ' are accounted for: ', ...joined,
        '. Zero unpinned npx — nothing can silently drift stale.');
    }
    main.push(el('div', { class: 'wire-verdict' + (driftN ? ' is-drift' : ' is-clean') },
      el('span', { class: 'wv-icon', 'aria-hidden': 'true' }, frag(driftN ? WV_ICON_DRIFT : WV_ICON_CLEAN)),
      el('div', { class: 'wv-text' },
        el('p', { class: 'wv-title' }, title),
        el('p', { class: 'wv-sub' }, ...sub),
        driftN && driftSites.length ? el('ul', { class: 'wv-sites' },
          ...driftSites.slice(0, 8).map((x) => el('li', {},
            el('span', { class: 'site-where' }, x.scope === 'project' ? (x.project || 'unknown project') : 'machine-wide'),
            el('span', { class: 'cell-dim' }, x.file || '—'),
            el('span', { class: 'site-spec' }, x.spec || ''))),
          driftSites.length > 8 ? el('li', { class: 'cell-dim' },
            `+ ${fmtInt(driftSites.length - 8)} more — the full map is in the peel-back below`) : null) : null)));

    // ---- lane legend, subordinate to the verdict: one quiet line per lane in use.
    // A lane at zero is omitted, not excused — a "0 plugin" row answers nothing.
    const npxMeaning = driftN === 0
      ? 'pinned to exact versions — deliberate, reproducible, cannot age'
      : pinnedN > 0
        ? `${fmtInt(driftN)} unpinned can drift stale · ${fmtInt(pinnedN)} pinned are safe`
        : 'downloads a private copy per call — can silently drift stale';
    const lanes = [
      { n: s.global ?? 0, label: 'global binary', tone: 'w-global', meaning: 'one path, one version — what runs is what you installed' },
      { n: s.mcp ?? 0, label: 'MCP server', tone: 'w-mcp', meaning: 'a running tool the AI calls directly — alive, not re-downloaded' },
      { n: s.npx ?? 0, label: 'npx', tone: 'w-npx', meaning: npxMeaning },
      { n: s.plugin ?? 0, label: 'plugin', tone: 'w-plugin', meaning: 'ships inside Claude Code itself' },
    ].filter((l) => l.n > 0);
    if (driftN) lanes.sort((a, b) => Number(b.label === 'npx') - Number(a.label === 'npx')); // risk leads
    main.push(el('div', { class: 'wire-legend' },
      ...lanes.map((l) => el('div', { class: 'wire-leg-row' },
        el('span', { class: 'wire-dot ' + l.tone, 'aria-hidden': 'true' }),
        el('b', { class: 'wire-leg-n' }, fmtInt(l.n)),
        el('span', { class: 'wire-leg-lab' }, l.label),
        el('span', { class: 'wire-leg-meaning cell-dim' }, l.meaning)))));
  }

  if (sites.length) {
    const groups = new Map();
    for (const site of sites) {
      const key = site.scope === 'project' ? (site.project || 'unknown project') : 'global (your user settings)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(site);
    }
    const outer = el('details', { class: 'sub' },
      el('summary', {}, `Peel it back — all ${fmtInt(sites.length)} resolution sites, project by project`),
      el('div', { class: 'sub-body' },
        [...groups.entries()].map(([proj, list]) => el('details', { class: 'sub' },
          el('summary', {}, `${proj} — ${list.length} site${list.length === 1 ? '' : 's'}`),
          el('div', { class: 'sub-body' },
            el('div', { class: 'scroll-x' },
              el('table', { class: 'tb' },
                el('thead', {}, el('tr', {},
                  el('th', { scope: 'col' }, 'File'), el('th', { scope: 'col' }, 'Event · matcher'),
                  el('th', { scope: 'col' }, 'Via'), el('th', { scope: 'col' }, 'Spec'))),
                el('tbody', {}, list.map((site) => el('tr', {},
                  el('td', { class: 'cell-mono' }, site.file || '—'),
                  el('td', { class: 'cell-mono cell-dim' }, [site.event, site.matcher].filter(Boolean).join(' · ') || '—'),
                  el('td', {}, chip(MECH_LABEL[site.mechanism] || String(site.mechanism || '?').toLowerCase(), 'grey')),
                  el('td', { class: 'cell-mono cell-dim' }, site.spec || '—'),
                ))))))))));
    main.push(outer);
  } else {
    main.push(el('p', { class: 'muted' }, total
      ? 'The site-by-site list didn’t arrive with this audit — the counts above are from the summary.'
      : 'No resolution sites found — nothing is wired through hooks yet.'));
  }

  body.replaceChildren(withIllo('wiring', ...main));
}

/* -------------------------------------------------- section 3: recommendations */

const SEV_TONE = { INFO: 'grey', SUGGESTED: 'cyan', IMPORTANT: 'amber' };

const ICON_MACHINE = `
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="5" width="16" height="11" rx="2"/>
    <path d="M2 19h20"/>
  </svg>`;

const BADGE_OK = `
  <svg class="applied-badge" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="14"/>
    <path d="M10 16.8l4.1 4L22 12.2"/>
  </svg>`;

function updateRecsChip() {
  const n = renderedRecIds.size;
  if (!stateRecsSettled && !stackRecsSettled && !healthRecsSettled) { setChips('chips-recs', [chip('…', 'wait')]); return; }
  if (n === 0 && stateRecsSettled && stackRecsSettled && healthRecsSettled) {
    setChips('chips-recs', [chip('none needed', 'green')]);
  } else {
    setChips('chips-recs', [chip(`${n} proposal${n === 1 ? '' : 's'}`, n ? 'amber' : 'wait')]);
  }
  renderFixAll();
}

function fixAllEligible() {
  return [...renderedRecommendations.values()].filter((rec) =>
    rec && Array.isArray(rec.evidence) && rec.evidence.length && rec.cost && rec.undo);
}

function renderFixAll() {
  const slot = $('#recs-batch');
  if (!slot) return;
  const eligible = fixAllEligible();
  if (!eligible.length) { slot.replaceChildren(); return; }

  const openConfirm = () => {
    const list = el('ul', { class: 'evidence-list' },
      eligible.map((rec) => el('li', {},
        el('b', {}, rec.title || rec.id),
        ` — ${rec.change?.human || 'apply the verified recommendation'}`,
        rec.undo?.human ? `; undo: ${rec.undo.human}` : '')));
    slot.replaceChildren(el('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm every verified recommendation' },
      el('p', { class: 'confirm-q' }, `Apply all ${eligible.length} verified fixes?`),
      el('p', { class: 'confirm-detail' },
        'Each item is re-checked immediately before it runs. Resolved or changed items are skipped. ',
        'Every successful item records its own undo before mutation.'),
      list,
      el('div', { class: 'confirm-btns' },
        el('button', { class: 'btn btn-apply', type: 'button', onclick: () => void applyAllVerified(eligible) }, 'Yes, fix all verified items'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: renderFixAll }, 'Cancel'))));
  };

  slot.replaceChildren(el('div', { class: 'save-row' },
    el('button', { class: 'btn btn-apply', type: 'button', onclick: openConfirm },
      `Fix all (${eligible.length})`),
    el('p', { class: 'save-note' },
      'Only the evidence-backed, reversible proposals listed below. Unsupported settings and secrets are never included.')));
}

async function undoBatchResult(result, btn) {
  if (!result.undoToken) return;
  btn.disabled = true;
  const response = await postJSON('/api/undo', { undoToken: result.undoToken });
  if (response.ok && response.data?.ok) {
    btn.replaceWith(el('span', { class: 'reverted' }, 'Reverted'));
    recheckMachine();
  } else {
    btn.disabled = false;
    announce(response.status === 403 ? TOKEN_MSG : 'Undo did not complete; the backup remains available.');
  }
}

async function applyAllVerified(recs) {
  const slot = $('#recs-batch');
  slot.replaceChildren(el('p', { class: 'pending-note', role: 'status' }, `Applying ${recs.length} verified fixes…`));
  try {
    const response = await postJSON('/api/apply', { ids: recs.map((rec) => rec.id), preStateHash });
    if (response.status === 403) {
      slot.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' }, TOKEN_MSG));
      return;
    }
    const results = Array.isArray(response.data?.results) ? response.data.results : [];
    const ok = results.filter((result) => result.ok);
    const skipped = results.filter((result) => !result.ok);
    slot.replaceChildren(el('div', { class: `form-note ${skipped.length ? 'n-err' : 'n-ok'}`, role: 'status' },
      el('div', { class: 'fn-body' },
        el('b', {}, `${ok.length} applied; ${skipped.length} skipped or failed.`),
        ' Every applied item has its own undo below.')));
    for (const result of results) {
      const card = document.getElementById(`rec-${result.id}`);
      const actions = card?.querySelector('.rec-actions');
      if (!actions) continue;
      if (result.ok) {
        card.classList.add('is-applied');
        const undoButton = el('button', {
          class: 'btn btn-undo',
          type: 'button',
          disabled: !result.undoToken,
          onclick: (event) => void undoBatchResult(result, event.currentTarget),
        }, 'Undo this change');
        actions.replaceChildren(el('div', { class: 'applied' },
          el('p', { class: 'applied-title' }, 'Applied by Fix all — and reversible.'),
          result.log ? el('pre', { class: 'log' }, String(result.log)) : null,
          undoButton));
      } else {
        actions.replaceChildren(el('div', { class: 'world-moved', role: 'alert' },
          el('p', {}, result.log || 'Skipped because the machine changed or the fix no longer applies.')));
      }
    }
    announce(`${ok.length} verified fixes applied; ${skipped.length} skipped or failed.`);
    recheckMachine();
  } catch (error) {
    slot.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
      `Fix all could not reach the console server: ${error.message || error}.`));
  }
}

function maybeRecsEmpty() {
  const emptyBox = $('#recs-empty');
  if (!emptyBox) return;
  if (stateRecsSettled && stackRecsSettled && healthRecsSettled && renderedRecIds.size === 0) {
    emptyBox.hidden = false;
    emptyBox.replaceChildren(el('div', { class: 'recs-empty' },
      withIllo('recs',
        el('p', { class: 'lead' }, 'Nothing to suggest.'),
        el('p', {}, 'Your setup looks the way you meant it to — and an advisor with nothing to say should say exactly that. If your machine changes, reload and we’ll look again.'))));
  } else {
    emptyBox.hidden = true;
  }
}

function recsSettled(source, ok) {
  if (source === 'state') stateRecsSettled = true;
  if (source === 'health') healthRecsSettled = true;
  // A capability checkbox only renders once the rec card it opens (`#rec-enable:<key>`) is in the
  // DOM — before that it shows an honest "still loading" placeholder (see capCheckbox). Those rec
  // cards arrive with the recommendations, AFTER capabilities have already rendered once. Without
  // this, the placeholder never upgrades and the checkbox never appears. Re-render capabilities once
  // the recs that back them have settled, but ONLY if a pending placeholder is actually waiting —
  // no cards waiting means no reason to repaint.
  if ((source === 'state' || source === 'health') && lastCapabilities
      && document.querySelector('#card-capabilities .cap-toggle-pending')) {
    renderCapabilities(lastCapabilities);
  }
  if (source === 'stack') {
    stackRecsSettled = true;
    const pending = $('#recs-pending');
    if (pending) {
      if (ok) pending.remove();
      else {
        pending.textContent = 'The stack audit failed, so suggestions from it can’t appear this session.';
        pending.style.color = 'var(--warn-text)';
      }
    }
  }
  updateRecsChip();
  maybeRecsEmpty();
}

function addRecommendations(recs, source) {
  const list = $('#recs-list');
  // Ordering explains itself (shown once): machine-wide first, then your active projects.
  if (!document.getElementById('recs-order-note')) {
    list.before(el('p', { class: 'impact-note', id: 'recs-order-note' },
      'Ordered by what you’re working on — machine-wide updates first (they affect every project), then your most recently active projects.'));
  }
  let dropped = 0;
  const nodes = [];
  for (const rec of Array.isArray(recs) ? recs : []) {
    if (!rec || rec.id == null || renderedRecIds.has(rec.id)) continue;
    // The DDD invariant, honored in the UI too: no evidence/cost/undo → not rendered.
    if (!Array.isArray(rec.evidence) || !rec.evidence.length || !rec.cost || !rec.undo) { dropped += 1; continue; }
    renderedRecIds.add(rec.id);
    renderedRecommendations.set(rec.id, rec);
    nodes.push(buildRecCard(rec));
  }
  // Ordering is by BLAST RADIUS, not arrival time — the slow sources arrive last and matter most.
  //
  // 'health' outranks even stack updates. A store holding thousands of memories that teach your AI
  // nothing, or a corrupt memory index, is a bigger deal than a version being one behind — and it is
  // the one thing the user cannot discover for themselves, because nothing else on the machine says
  // it out loud. That is the entire premise of ADR-027: knowing which question to ask is the scarce
  // resource, so the answer nobody knew to ask for goes first.
  if ((source === 'health' || source === 'stack') && list.firstChild) list.prepend(...nodes);
  else list.append(...nodes);
  if (dropped) {
    list.append(el('p', { class: 'fineprint' },
      `${dropped} proposal${dropped === 1 ? '' : 's'} arrived without evidence, cost, or an undo and ${dropped === 1 ? 'was' : 'were'} not rendered — the contract requires all three.`));
  }
  updateRecsChip();
}

/* The owner's "user-level vs per-project" question, answered per card: the blast radius of applying
 * this suggestion. `null` scope shows a muted "scope not stated" pill rather than being silently
 * folded into either side — the same honesty the rest of the console holds to (never guess a state).
 * A full grouped-sections layout is a deliberate follow-up: its group order and whether user/machine
 * split into two visible groups are product decisions the owner reserved. */
const REC_SCOPE_LABEL = {
  project: { text: 'Just this project', tone: 'cyan', title: 'Applying this changes only the project you are in right now.' },
  user: { text: 'Every project · your account', tone: 'amber', title: 'Applying this changes behaviour for every project under your user account.' },
  machine: { text: 'Every project · this machine', tone: 'amber', title: 'Applying this changes behaviour for every project on this computer.' },
};
function recScopePill(scope) {
  const s = REC_SCOPE_LABEL[scope];
  if (!s) return chip('scope not stated', 'grey', 'We did not establish whether this is project-only or machine-wide — it is not guessed.');
  return chip(s.text, s.tone, s.title);
}

function buildRecCard(rec) {
  const status = el('p', { class: 'rec-status', 'aria-live': 'polite' });
  const actions = el('div', { class: 'rec-actions' });
  const card = el('article', { class: 'rec', id: `rec-${rec.id}` });

  /* impact surface — the load-bearing safety UX */
  let impact;
  if (rec.touchesMachine === true) {
    impact = el('div', { class: 'impact-banner', role: 'note' },
      el('span', { class: 'impact-icon' }, frag(ICON_MACHINE)),
      el('div', { class: 'impact-text' },
        el('p', { class: 'impact-title' }, 'This one touches your computer'),
        el('p', { class: 'impact-plain' }, rec.plainImpact ||
          'It changes something the rest of your system uses. We’ll ask you to confirm before anything runs, and the exact reversal is recorded first.'),
        el('span', { class: 'impact-rev' }, 'reversible — undo recorded before it runs')));
  } else {
    impact = el('p', { class: 'impact-note' },
      'Only writes RuvNet Brain’s own settings file in your user folder — nothing else on your computer changes.');
  }

  /* evidence · cost · change · undo — all four, always */
  const facts = el('div', { class: 'rec-facts' },
    el('div', { class: 'fact' },
      el('span', { class: 'k k-evidence' }, 'Evidence'),
      el('div', { class: 'v' }, el('ul', { class: 'evidence-list' },
        rec.evidence.map((ev) => el('li', {},
          ev.observed || String(ev),
          ev.source ? el('span', { class: 'src' }, ` — ${ev.source}`) : null))))),
    el('div', { class: 'fact' },
      el('span', { class: 'k k-cost' }, 'Cost'),
      el('div', { class: 'v' }, el('div', { class: 'cost-row' },
        rec.cost.time != null ? el('span', { class: 'cost-item' }, el('span', { class: 'ck' }, 'time'), rec.cost.time) : null,
        rec.cost.latency != null ? el('span', { class: 'cost-item' }, el('span', { class: 'ck' }, 'latency'), rec.cost.latency) : null,
        rec.cost.usd != null ? el('span', { class: 'cost-item' }, el('span', { class: 'ck' }, 'cost'), fmtUsd(rec.cost.usd)) : null,
        rec.cost.risk != null ? el('span', { class: `cost-item risk-${rec.cost.risk}` }, el('span', { class: 'ck' }, 'risk'), rec.cost.risk) : null))),
    rec.change ? el('div', { class: 'fact' },
      el('span', { class: 'k k-change' }, 'Change'),
      el('div', { class: 'v' },
        rec.change.human || '',
        rec.change.cmd ? el('span', {}, ' — ', el('code', {}, rec.change.cmd)) : null)) : null,
    el('div', { class: 'fact' },
      el('span', { class: 'k k-undo' }, 'Undo'),
      el('div', { class: 'v' }, rec.undo.human || rec.undo.kind || 'recorded before the change runs')),
  );

  function setIdleActions() {
    actions.replaceChildren(
      el('button', { class: 'btn btn-apply', type: 'button', onclick: onApply },
        rec.touchesMachine ? 'Apply…' : 'Apply'),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: onSkip }, 'Skip'),
    );
  }

  function onApply() {
    if (rec.touchesMachine === true) showConfirm();
    else doApply();
  }

  function showConfirm() {
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', onclick: setIdleActions }, 'Cancel');
    actions.replaceChildren(
      el('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm a change to your computer' },
        el('p', { class: 'confirm-q' }, 'Change your computer now?'),
        el('p', { class: 'confirm-detail' },
          rec.change?.human ? `It will ${rec.change.human}. ` : '',
          rec.undo?.human ? `If you change your mind: ${rec.undo.human}.` : 'The reversal is recorded before anything runs.'),
        el('div', { class: 'confirm-btns' },
          el('button', { class: 'btn btn-apply', type: 'button', onclick: doApply }, 'Yes, change my computer'),
          cancel)));
    cancel.focus();
  }

  async function doApply() {
    actions.replaceChildren(el('button', { class: 'btn btn-apply', type: 'button', disabled: true }, 'Applying…'));
    status.textContent = '';
    status.dataset.tone = '';
    try {
      const { status: code, data } = await postJSON('/api/apply', { ids: [rec.id], preStateHash });
      if (code === 403) return fail(TOKEN_MSG);
      if (data && data.worldMoved) return worldMoved();
      const result = (data.results || []).find((r) => r.id === rec.id) || (data.results || [])[0];
      if (!result) return fail('The server returned no result for this change — nothing was assumed applied.');
      if (result.worldMoved || result.error === 'worldMoved') return worldMoved();
      if (result.ok) applied(result);
      else fail('The change didn’t complete. Nothing runs without its backup recorded first.', result.log);
    } catch (err) {
      fail(`Couldn’t reach the console server: ${err.message || err}`);
    }
  }

  function applied(result) {
    card.classList.add('is-applied');
    const undoBtn = el('button', {
      class: 'btn btn-undo', type: 'button',
      onclick: () => doUndo(result.undoToken, undoBtn),
    }, 'Undo this change');
    actions.replaceChildren(
      el('div', { class: 'applied' },
        el('div', { class: 'applied-head' },
          frag(BADGE_OK),
          el('div', {},
            el('p', { class: 'applied-title' }, 'Applied — and reversible.'),
            el('p', { class: 'applied-sub' }, 'A backup was written before anything ran. The undo below restores it exactly.'))),
        result.log ? el('pre', { class: 'log' }, String(result.log)) : null,
        el('div', { class: 'applied-btns' }, undoBtn)));
    announce(`${rec.title} applied.`);
    undoBtn.focus();
    // Close the loop: re-mirror the machine so every card shows the AFTER state.
    recheckMachine();
  }

  async function doUndo(undoToken, btn) {
    if (!undoToken) return fail('No undo token was returned for this change — undo it from the backup file noted in the log.');
    btn.disabled = true;
    btn.textContent = 'Undoing…';
    try {
      const { status: code, data } = await postJSON('/api/undo', { undoToken });
      if (code === 403) return fail(TOKEN_MSG);
      if (data && data.ok) {
        card.classList.remove('is-applied');
        actions.replaceChildren(el('p', { class: 'reverted' }, 'Reverted — your machine is back exactly the way it was.'));
        actions.append(el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: setIdleActions }, 'Offer it again'));
        announce(`${rec.title} reverted.`);
        recheckMachine(); // show the restored state everywhere, not just on this card
      } else {
        fail('Undo didn’t complete. The backup file still exists — nothing is lost.');
      }
    } catch (err) {
      fail(`Couldn’t reach the console server: ${err.message || err}`);
    }
  }

  function worldMoved() {
    actions.replaceChildren(
      el('div', { class: 'world-moved', role: 'alert' },
        el('p', {}, 'Your machine changed since this page loaded — another session or a scheduled job got there first. Nothing was touched: we re-read the world before writing, and it had moved.'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => location.reload() }, 'Reload and look again')));
    announce('Apply aborted: the machine changed since the page loaded.');
  }

  function fail(msg, log) {
    status.dataset.tone = 'error';
    status.textContent = msg;
    setIdleActions();
    if (log) actions.before(el('pre', { class: 'log' }, String(log)));
    announce(msg);
  }

  function onSkip() {
    card.classList.add('is-skipped');
    if (!card.querySelector('.skipped-row')) {
      card.append(el('div', { class: 'skipped-row' },
        el('span', { class: 'sk-title' }, `skipped · ${rec.title}`),
        el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => card.classList.remove('is-skipped'),
        }, 'Show again')));
    }
  }

  card.append(
    el('div', { class: 'rec-top' },
      el('h3', {}, rec.title || rec.id),
      recScopePill(rec.scope),
      chip(rec.severity || 'INFO', SEV_TONE[rec.severity] || 'grey')),
    rec.rationale ? el('p', { class: 'rationale' }, rec.rationale) : null,
    impact,
    facts,
    actions,
    status,
  );
  setIdleActions();
  return card;
}

/* ----------------------------------------------------------- section 4: memory */

const DIM_TONE = { ok: 'green', warn: 'warn', fail: 'red', notTested: 'nt' };
const DIM_LABEL = { ok: 'ok', warn: 'warn', fail: 'fail', notTested: 'not checked this session' };
const DIAL_ARC = 235.62; /* 270° arc, r=50 */

/* Constant markup only — the score is injected via textContent/attributes below,
   never interpolated into HTML. */
const DIAL_SVG = `
  <svg class="dial" viewBox="0 0 120 108" role="img">
    <defs>
      <linearGradient id="dial-grad" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" stop-color="#f0a830"/><stop offset="0.32" stop-color="#ffce6a"/>
        <stop offset="0.68" stop-color="#5ad6ff"/><stop offset="1" stop-color="#5fd38a"/>
      </linearGradient>
    </defs>
    <path class="dial-track" d="M 24.64 95.36 A 50 50 0 1 1 95.36 95.36"/>
    <path class="dial-value" d="M 24.64 95.36 A 50 50 0 1 1 95.36 95.36"
          stroke="url(#dial-grad)" stroke-dasharray="0 235.62"/>
    <text class="dial-num" x="60" y="66" text-anchor="middle"></text>
    <text class="dial-sub" x="60" y="82" text-anchor="middle">of 100</text>
  </svg>`;

function dial(score) {
  const s = Math.max(0, Math.min(100, Math.round(Number(score) || 0)));
  const box = el('div', { class: 'dial-wrap' }, frag(DIAL_SVG));
  const svg = box.querySelector('.dial');
  svg.setAttribute('aria-label', `Memory quality score ${s} out of 100`);
  svg.querySelector('.dial-num').textContent = String(s);
  /* let the arc sweep in after first paint */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const v = box.querySelector('.dial-value');
    if (v) v.setAttribute('stroke-dasharray', `${((s / 100) * DIAL_ARC).toFixed(2)} ${DIAL_ARC.toFixed(2)}`);
  }));
  return box;
}

// Compact, delightful "it's learning how you work" strip — the visible face of the recursive learning
// loop (ADR-0017). Deliberately small; shows the win without dominating the card.
function renderLearnings(l) {
  if (!l || !l.active) return null;
  const recent = (l.recentWorkflow || []).slice(0, 6);
  const when = l.daysSinceLastAdaptation === 0 ? 'updated today'
    : (l.daysSinceLastAdaptation != null ? `last updated ${l.daysSinceLastAdaptation}d ago` : '');
  return el('div', { class: 'learn-strip' },
    el('div', { class: 'learn-head' },
      el('span', { class: 'learn-spark', 'aria-hidden': 'true' }, '✦'),
      el('div', { class: 'learn-headtext' },
        el('div', { class: 'learn-title' }, 'Learning how you work', infoBtn('Learning how you work', LEARNINGS_INFO)),
        el('div', { class: 'learn-sub' },
          el('b', {}, fmtInt(l.patterns) + ' patterns'), ' from ', el('b', {}, fmtInt(l.trajectories) + ' workflows'),
          when ? ' · ' + when : ''))),
    recent.length ? el('div', { class: 'learn-recent' },
      el('span', { class: 'learn-recent-lab' }, 'recently observed'),
      ...recent.map((a) => el('span', { class: 'learn-chip' }, a.length > 30 ? a.slice(0, 28) + '…' : a))) : null,
    el('p', { class: 'learn-foot fineprint' },
      'Shared across all your projects and getting smarter over time — but only ', el('b', {}, 'how you work'), '. Your project facts stay isolated; nothing here is project data.'));
}

function renderMemory(mem) {
  const body = $('#body-memory');
  if (!mem || !mem.health) {
    setChips('chips-memory', [chip('no data', 'grey')]);
    body.replaceChildren(el('p', { class: 'muted' }, 'No memory-health data received.'));
    return;
  }
  const h = mem.health;
  const score = Math.max(0, Math.min(100, Math.round(Number(h.score) || 0)));
  const tone = score >= 85 ? 'green' : score >= 60 ? 'warn' : 'red';

  // COUNT THE UNTESTED DIMENSIONS BEFORE ANYTHING PRINTS THE SCORE.
  //
  // These two lines used to sit BELOW the chip and the found-strip assignment, so both surfaces
  // published a bare "100/100" while a dimension of the five had never been probed — an untested
  // dimension silently contributing zero deduction inside a perfect-looking score. The server's own
  // summary string carries the qualifier ("across N probed dimensions; 1 not checked"); both
  // rendered surfaces dropped it. A perfect score is exactly the number that most needs its
  // asterisk, and this project's standing rule bans an unqualified score with an untested input.
  // Found by Fable 5, 2026-07-24.
  const dims = Array.isArray(h.dimensions) ? h.dimensions : [];
  const notTested = dims.filter((d) => d.status === 'notTested').length;
  const probed = dims.length - notTested;
  const qualifier = notTested
    ? `${probed} of ${dims.length} dimensions checked; ${notTested} not checked this session`
    : null;

  setChips('chips-memory', [
    chip(notTested ? `${score}/100*` : `${score}/100`, tone, qualifier || undefined),
  ]);
  found.memScore = score;
  found.memNotTested = notTested;
  found.memProbed = probed;
  found.memDims = dims.length;
  updateFoundStrip();

  const main = [];
  main.push(el('div', { class: 'memory-top' },
    dial(score),
    el('div', { class: 'mem-summary' },
      el('h3', {}, h.project ? `${h.project} — memory quality` : 'Memory quality', infoBtn('Memory quality', MEMORY_INFO)),
      el('p', { class: 'mem-line' }, h.summary ||
        'A quality score, not a liveness light: a store can be up, populated, and still never surface the thing you need.'),
      el('p', { class: 'fineprint' },
        'Dimensions we didn’t probe this session are excluded from the score — shown grey below, never assumed. A known-broken dimension caps the score.'))));

  const learn = renderLearnings(mem.learnings);
  if (learn) main.push(learn);

  if (dims.length) {
    main.push(el('div', { class: 'dims' }, dims.map((d) => {
      const st = DIM_TONE[d.status] ? d.status : 'notTested';
      const ded = Number(d.deduction) || 0;
      return el('div', { class: `dim${st === 'notTested' ? ' dim-nt' : ''}` },
        chip(DIM_LABEL[st], DIM_TONE[st]),
        el('span', { class: 'dim-name' }, d.label || d.key || '—'),
        el('span', { class: `dim-ded${ded > 0 ? ' has-ded' : ''}`,
          title: st === 'notTested' ? 'Not probed — contributes nothing to the score' : 'Deduction from the score' },
          st === 'notTested' ? '—' : (ded > 0 ? `−${ded}` : '0')),
        el('span', { class: 'dim-detail' }, d.detail || ''));
    })));
    if (notTested) {
      main.push(el('p', { class: 'fineprint', style: 'margin-top:10px' },
        `${notTested} dimension${notTested === 1 ? ' was' : 's were'} not probed this session — reported honestly rather than scored from an assumption.`));
    }
  }

  const fleet = Array.isArray(mem.fleet) ? mem.fleet : [];
  if (fleet.length) {
    main.push(el('details', { class: 'sub' },
      el('summary', {}, `Across your ${fleet.length} project${fleet.length === 1 ? '' : 's'} — every memory store we found`),
      el('div', { class: 'sub-body' },
        el('div', { class: 'scroll-x' },
          el('table', { class: 'tb' },
            el('thead', {}, el('tr', {},
              el('th', { scope: 'col' }, 'Project'), el('th', { scope: 'col' }, 'Entries'),
              el('th', { scope: 'col' }, 'Embedded'), el('th', { scope: 'col' }, 'Patterns'),
              el('th', { scope: 'col' }, 'Learns'), el('th', { scope: 'col' }, 'Findings'))),
            el('tbody', {}, fleet.map((f) => el('tr', {},
              el('td', { class: 'cell-name' }, f.name || '—'),
              el('td', { class: 'cell-mono num' }, fmtInt(f.total)),
              el('td', { class: 'cell-mono num' }, f.coverPct != null ? `${f.coverPct}%` : '—'),
              el('td', { class: 'cell-mono num' }, fmtInt(f.patterns)),
              el('td', {}, f.learns ? chip('yes', 'green') : chip('no', 'grey')),
              el('td', { class: 'cell-dim' },
                Array.isArray(f.findings) && f.findings.length ? f.findings.join('; ') : '—'),
            ))))))));
  }

  body.replaceChildren(withIllo('memory', ...main));
}

/* ---------------------------------------------------------- section 5: savings */

/* Router panel (rebuilt 2026-07-16). The old panel displayed router-optimizer.mjs — a parallel,
   subscription-blind re-derivation of routing strategy that bypassed the real engine and told a
   Max subscriber to PAY for a worse model than the Sonnet 5 their plan covers. The replica is
   deleted. This panel renders only the ENGINE'S OWN truth: who decides (@metaharness/router —
   rUv's learned cost-optimal router — or a loudly-announced cold-start), the real candidate pool
   with THIS user's marginal prices ($0 where the subscription covers it), and the engine's own
   recent decisions from its append-only log. Nothing shown here can disagree with what routes. */
function renderRouterEngine(re) {
  if (!re || !re.engine) return null;
  const money = (v) => (v == null ? '—' : v === 0 ? '$0' : '$' + v + '/Mtok');
  const eng = re.engine;

  const modeChip =
    eng.mode === 'LEARNED' ? chip(`learned · ${eng.labels} real outcomes`, 'green')
    : eng.mode === 'COLD-START' ? chip(`cold-start · ${eng.labels} of ${eng.needed} labels`, 'warn')
    : chip('router package missing', 'red');

  const engineLine = el('div', { class: 'rp-house' },
    el('span', { class: 'rp-house-tag' }, 'Who decides'),
    el('b', { class: 'rp-house-name' }, '@metaharness/router'),
    el('span', { class: 'rp-house-src' }, 'rUv’s learned cost-optimal router — the Brain adds only your constraints'),
    modeChip);

  const modeNote =
    eng.mode === 'COLD-START' ? el('p', { class: 'rp-split' },
      'It routes by learning from ', el('b', {}, 'your real outcomes'), ' — it has ',
      el('b', {}, String(eng.labels)), ' of the ', el('b', {}, String(eng.needed)),
      ' labelled examples it needs before its predictions count. Until then it says so and falls back — every routed task teaches it. This stops being a fallback with use.')
    : eng.mode === 'UNAVAILABLE' ? el('p', { class: 'rp-split' },
      'The router package isn’t installed here — nothing is silently substituted in its place. ',
      el('span', { class: 'cell-mono' }, 'npm i @metaharness/router'), ' restores it.')
    : null;

  // Dev/Prod are LENSES over the engine's one pool — a filter and a price column, never a second
  // strategy (Stuart 2026-07-16: "not sure I'm seeing dev vs production"). Development = you, in
  // Claude Code, where covered models are $0 marginal. Production = your deployed app on metered
  // APIs, where a personal subscription cannot apply and list price is the real cost.
  const pool = Array.isArray(re.pool) ? re.pool : [];
  const TIER_ORDER = { mechanical: 0, cheap: 1, mid: 2, frontier: 3 };
  const byTier = (a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9);
  const recommended = (Array.isArray(re.decisions) ? re.decisions : []).find((decision) => decision && decision.model);
  const lensTable = (rows, costOf, costHead, { showRouting = false } = {}) => el('div', { class: 'scroll-x' },
    el('table', { class: 'tb rp-tb' },
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Bucket'), el('th', { scope: 'col' }, 'Model'),
        el('th', { scope: 'col' }, costHead),
        showRouting ? el('th', { scope: 'col' }, 'Routing') : null)),
      el('tbody', {}, rows.map((p) => el('tr', {},
        el('td', { class: 'rp-band' }, p.tier || '—'),
        el('td', {}, el('div', { class: 'rp-model' }, prettyModel(p.id))),
        el('td', { class: 'cell-mono num' }, costOf(p)),
        showRouting ? el('td', {}, recommended?.model === p.id
          ? chip('last selected', 'green', recommended.reason || 'The latest router receipt selected this model.')
          : 'available') : null,
      )))));
  // Development is an inventory, not a recommendation filter. The previous one-row-per-tier
  // projection hid equal-cost Fable behind Opus based solely on array order. Every launchable row
  // remains visible; the latest actual routing receipt is a separate marker.
  const bestPerTier = (rows, price) => {
    const seen = {};
    for (const p of rows) {
      const k = p.tier || '?';
      if (!seen[k] || price(p) < price(seen[k])) seen[k] = p;
    }
    return Object.values(seen).sort(byTier);
  };
  const devRows = pool
    .filter((p) => (p.harness || []).includes('claude-code'))
    .sort((a, b) => byTier(a, b) || String(a.id).localeCompare(String(b.id)));
  const prodRows = bestPerTier(
    pool.filter((p) => p.listPerMTok != null && p.provider !== 'local'),
    (p) => p.listPerMTok ?? Infinity);
  const devBlock = el('div', { class: 'rp-profile' },
    el('div', { class: 'rp-head' },
      el('span', { class: 'rp-name' }, 'Development'),
      el('span', { class: 'rp-obj' }, 'you, in Claude Code — models your plan covers win at $0 marginal')),
    lensTable(devRows,
      (p) => (p.subscriptionCovered ? el('b', { title: 'covered by your subscription — zero marginal cost' }, '$0 · yours') : money(p.marginalPerMTok)),
      'Your cost', { showRouting: true }));
  const prodBlock = el('div', { class: 'rp-profile' },
    el('div', { class: 'rp-head' },
      el('span', { class: 'rp-name' }, 'Production'),
      el('span', { class: 'rp-obj' }, 'your deployed app on metered APIs — a personal plan can’t apply there')),
    lensTable(prodRows, (p) => money(p.listPerMTok), 'API price'));
  const lensGrid = el('div', { class: 'rp-grid' }, devBlock, prodBlock);
  const poolFoot = el('p', { class: 'fineprint' },
    re.catalogSource === 'built-in-fallback'
      ? `No personal catalog found — showing a minimal built-in set of ${pool.length}. Run \`node scripts/model-router-setup.mjs\` to build your real catalog, then the engine weighs yours on every call.`
      : `All ${devRows.length} launchable Claude Code models are shown. The engine weighs all ${pool.length} candidates; the routing marker comes from its latest receipt, never catalog order.`);

  // Decisions: dedupe consecutive identical picks, keep 3, humanize the reason head. The full
  // append-only log stays on disk — this is a pulse, not a table of record.
  const decisionsRaw = Array.isArray(re.decisions) ? re.decisions : [];
  const decisions = [];
  for (const d of decisionsRaw) {
    const prev = decisions[decisions.length - 1];
    if (prev && prev.model === d.model && prev.routedBy === d.routedBy) continue;
    decisions.push(d);
    if (decisions.length >= 3) break;
  }
  const humanReason = (r) => {
    const s = String(r || '');
    if (s.includes('predicted quality')) return s.match(/predicted quality [\d.]+/)?.[0] + (s.includes('clears') ? ' — clears the bar' : '');
    if (s.includes('NOT a tuned heuristic')) return 'starter policy while the router learns — prefers your covered models';
    return s.split('—')[0].split(';')[0].slice(0, 90);
  };
  const decRow = (d) => el('div', { class: 'dec-row' },
    el('div', { class: 'dec-top' },
      el('b', { class: 'dec-model' }, prettyModel(d.model)),
      (String(d.routedBy || '').startsWith('@metaharness/router')
        ? chip('rUv’s router', 'green') : chip('learning fallback', 'warn')),
      el('span', { class: 'dec-when cell-mono cell-dim' }, d.ts ? String(d.ts).slice(5, 16).replace('T', ' ') : '—')),
    el('div', { class: 'dec-why cell-dim' }, humanReason(d.reason)));
  const lastTs = decisionsRaw[0] && decisionsRaw[0].ts ? new Date(decisionsRaw[0].ts) : null;
  const daysQuiet = lastTs ? Math.floor((Date.now() - lastTs.getTime()) / 86400000) : null;
  const decisionsBlock = decisions.length ? el('div', { class: 'mh-dist' },
    el('p', { class: 'dist-ladder' }, 'Latest real decisions — from the engine’s own log, not simulated',
      daysQuiet > 1 ? el('span', { class: 'cell-dim' }, ` · quiet for ${daysQuiet} days — turn on smart routing above to feed it daily`) : null),
    ...decisions.map(decRow)) : null;

  const keyLine = re.keys && re.keys.openrouter
    ? el('span', {}, 'OpenRouter key detected — metered cross-provider candidates are reachable.')
    : el('span', {}, 'No OpenRouter key — only subscription and local candidates are reachable. ',
        el('a', { class: 'rp-getkey', href: 'https://openrouter.ai/keys', target: '_blank', rel: 'noopener' }, 'Create one →'));

  const constraintLine = re.profile && re.profile.present
    ? el('p', { class: 'rp-split' }, el('b', {}, 'Your constraints, applied as data: '),
        'models your subscription covers enter the pool at ', el('b', {}, '$0 marginal'),
        ' — so the cost-optimal math prefers what you already pay for. Cheapest real cost first; frontier only when the work earns it.')
    : el('p', { class: 'rp-split' }, 'No personal profile yet — run ',
        el('span', { class: 'cell-mono' }, 'node scripts/model-router-setup.mjs'),
        ' so the router knows which models your plan already covers.');

  return el('details', { class: 'mh-profiles' },
    el('summary', { class: 'rp-summary' },
      el('span', { class: 'rp-sum-t' }, 'Who routes your work — and with what', infoBtn('Who routes your work', ROUTER_ENGINE_INFO)),
      el('span', { class: 'rp-sum-s' }, `rUv’s learned router · your prices · ${eng.mode.toLowerCase().replace('-', ' ')}`),
      el('span', { class: 'rp-chev', 'aria-hidden': 'true' }, '›')),
    el('div', { class: 'rp-body' },
      engineLine,
      modeNote,
      constraintLine,
      lensGrid,
      poolFoot,
      decisionsBlock,
      el('p', { class: 'rp-foot fineprint' },
        'Candidate pool = the engine’s own catalog × your profile (', re.profile ? re.profile.path : '', '). ',
        keyLine)));
}

const MODEL_PRETTY = {
  'claude-fable-5': 'Fable 5', 'claude-opus-4.8': 'Opus 4.8', 'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4.5': 'Haiku 4.5', 'agent-booster': 'Agent Booster',
  'inclusionai/ling-2.6-flash': 'Ling 2.6 Flash', 'openai/gpt-4.1': 'GPT-4.1',
  'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B', 'x-ai/grok-4.5': 'Grok 4.5', 'x-ai/grok-4.3': 'Grok 4.3',
  'deepseek/deepseek-chat': 'DeepSeek Chat', 'deepseek/deepseek-v4-flash': 'DeepSeek v4 Flash',
  'z-ai/glm-4.6': 'GLM 4.6', 'z-ai/glm-5': 'GLM 5',
  // house frontiers / ladders (per-provider personalization)
  'openai/gpt-5.6-sol': 'GPT-5.6 Sol', 'openai/gpt-5.6-terra': 'GPT-5.6 Terra', 'openai/gpt-5.6-luna': 'GPT-5.6 Luna',
  'google/gemini-3.1-pro-preview': 'Gemini 3.1 Pro', 'google/gemini-3.5-flash': 'Gemini 3.5 Flash', 'google/gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
};
const HOUSE_SOURCE_NOTE = {
  config: 'you set this',
  env: 'detected from your API keys',
  default: 'you’re running Claude Code, so this is your dev house — set your production house in Settings',
};
// Friendly labels for the model-house selector — the stored value stays the id (anthropic/openai/…).
const SEG_LABEL = {
  provider: { auto: 'Auto', anthropic: 'Claude', openai: 'ChatGPT', codex: 'Codex', google: 'Gemini', xai: 'Grok' },
  advocacy: { off: 'Off', 'important-only': 'Important only', all: 'All' },
};
const segLabel = (key, opt) => (SEG_LABEL[key] && SEG_LABEL[key][opt]) || opt;
const prettyModel = (id) => {
  if (!id) return '—';
  if (MODEL_PRETTY[id]) return MODEL_PRETTY[id];
  // Fallback prettifier: drop provider prefix + date-pinned suffixes ("claude-haiku-4-5-20251001"
  // must never render raw — Stuart called the wall of ids a mess), title-case the words.
  const base = String(id).split('/').pop().replace(/-\d{8}$/, '');
  return base.split('-').map((w) => (/^\d/.test(w) ? w.replace(/-/g, '.') : w[0].toUpperCase() + w.slice(1)))
    .join(' ').replace(/(\d) (\d)/g, '$1.$2');
};

// The ONGOING view: once real tasks have been routed, how many landed in each band and what that
// saved vs sending them all to the frontier model. Driven entirely by measured receipts.
function renderDistribution(u) {
  if (!u || !u.tasks) return null;
  const frontierName = prettyModel(u.frontierModel);
  const tone = { mechanical: 'b-mech', cheap: 'b-cheap', mid: 'b-mid', frontier: 'b-front' };
  const dist = Array.isArray(u.distribution) ? u.distribution : [];
  const active = dist.filter((d) => d.tasks > 0);
  const frontierBand = dist.find((d) => d.band === 'frontier');
  const frontierIdle = !!frontierBand && !frontierBand.tasks;
  const saved = (u.frontierUsd != null && u.realizedUsd != null) ? u.frontierUsd - u.realizedUsd : null;

  // Verdict first: the money saved is the headline, everything else supports it.
  const hero = el('div', { class: 'dv-hero' },
    saved != null
      ? el('div', { class: 'dv-hero-num' }, fmtUsd(saved), el('span', { class: 'dv-hero-word' }, ' saved'))
      : null,
    el('p', { class: 'dv-hero-sub' },
      'across ', el('b', {}, u.tasks + ' routed ' + (u.tasks === 1 ? 'task' : 'tasks')),
      frontierIdle ? el('span', {}, ' · frontier never fired') : null,
      (frontierBand && frontierBand.tasks > 0)
        ? el('span', {}, ' · ' + frontierBand.tasks + ' escalated to ' + frontierName) : null),
    (u.frontierUsd != null && u.realizedUsd != null)
      ? el('p', { class: 'dv-hero-math' },
          frontierName + ' for everything would have cost ' + fmtUsd(u.frontierUsd) +
          ' — you actually spent ' + fmtUsd(u.realizedUsd) + '.')
      : null);

  // ONE continuous stacked bar — the mix in a single glance. Widths exactly
  // proportional to task counts (flex-grow), band colours carried by tone class.
  const bar = active.length
    ? el('div', {
        class: 'dv-bar', role: 'img',
        'aria-label': 'Task mix: ' + active.map((d) => `${d.label} ${d.pctOfTasks}%`).join(', '),
      },
      ...active.map((d) => el('div', {
        class: 'dv-seg ' + tone[d.band],
        style: 'flex:' + d.tasks + ' 1 0%',
        title: `${d.label} — ${d.tasks} ${d.tasks === 1 ? 'task' : 'tasks'} (${d.pctOfTasks}%)` +
          (d.savedUsd > 0 ? ` · saved ${fmtUsd(d.savedUsd)}` : ''),
      },
        d.pctOfTasks >= 15 ? el('span', { class: 'dv-seg-lab' }, `${d.label} ${d.pctOfTasks}%`) : null)))
    : null;

  // Compact legend: only bands that fired, each with its models + what it saved.
  const legendRows = active.map((d) => {
    const models = d.models.length
      ? d.models.map((m) => prettyModel(m.model) + (m.tasks > 1 ? ' ×' + m.tasks : '')).join(', ')
      : null;
    return el('div', { class: 'dv-leg-row' },
      el('span', { class: 'dv-dot ' + tone[d.band], 'aria-hidden': 'true' }),
      el('span', { class: 'dv-leg-band ' + tone[d.band] }, d.label),
      el('span', { class: 'dv-leg-meta cell-dim' },
        `${d.tasks} ${d.tasks === 1 ? 'task' : 'tasks'} · ${d.pctOfTasks}%` + (models ? ' — ' + models : '')),
      el('span', { class: 'dv-leg-saved num' }, d.savedUsd > 0 ? 'saved ' + fmtUsd(d.savedUsd) : ''));
  });
  // Frontier at zero is the punchline, not missing data — say so where its row would be.
  if (frontierIdle) {
    legendRows.push(el('div', { class: 'dv-leg-row dv-leg-punch' },
      el('span', { class: 'dv-check', 'aria-hidden': 'true' }, '✓'),
      el('span', { class: 'dv-leg-band b-front' }, frontierBand.label),
      el('span', { class: 'dv-leg-meta cell-dim' },
        el('b', {}, 'never fired'), ' — escalation is last resort by design'),
      el('span', { class: 'dv-leg-saved num' }, '')));
  }

  return el('div', { class: 'mh-dist dv-wrap' },
    hero, bar,
    el('div', { class: 'dv-legend' }, ...legendRows),
    el('p', { class: 'fineprint' }, u.note));
}

// One provider's key chip. THREE states, never two: found, not found, and NOT CHECKED. The third
// exists because an instrument that could not run has found nothing — it has not found "no key"
// (issue #86). Pure and total, so the not-checked branch cannot be reached by accident.
function providerKeyChip(id, keys, keysVerified, names) {
  const name = names[id] || id;
  if (!keysVerified) {
    return el('span', {
      class: 'plan-key unknown',
      title: `Not checked: Brain could not load its provider catalog, so it cannot tell whether an API key for ${name} is set on this machine`,
    }, el('span', { class: 'plan-key-mark', 'aria-hidden': 'true' }, '?'), ` ${name}`);
  }
  const found = !!keys[id];
  return el('span', {
    class: `plan-key ${found ? 'yes' : 'no'}`,
    title: found ? `An API key for ${name} is set on this machine`
                 : `No API key for ${name} found on this machine`,
  }, el('span', { class: 'plan-key-mark', 'aria-hidden': 'true' }, found ? '✓' : '✗'), ` ${name}`);
}

// Plan block (issue #24, applying sparkling's #21 redesign) — three genuinely different questions
// used to render as one flat row of identical "chips": which subscription this runs on ("house" — a
// word nobody outside the source knows), whether cheap-task routing is on, and which OTHER API keys
// merely exist. Now two plainly-labelled boxes: YOUR PLAN (the one choice that changes cost, with a
// real per-provider key checklist) and OPENROUTER (a separate switch, not another house).
function renderProviders(sv) {
  const re = sv && sv.routerEngine;
  if (!re) return null;
  // House = the user's Settings choice (config.json `provider`), the single source of truth (issue
  // #21). re.house + re.keys come from onboarding-console.mjs's gatherRouterEngine(); re.keys now
  // carries a real per-provider credential check (issue #24), not a hardcoded false.
  const HOUSE_NAME = { anthropic: 'Claude Max', openai: 'ChatGPT', codex: 'Codex', google: 'Gemini', xai: 'Grok' };
  const KEY_NAME = { anthropic: 'Claude', openai: 'OpenAI', google: 'Gemini', xai: 'Grok' };
  const house = { provider: re.house && re.house.provider };
  const houseName = HOUSE_NAME[house.provider] || 'Your stack';
  const keys = re.keys || {};

  const action = (label, target) => el('button', {
    class: 'plan-action', type: 'button', onclick: () => jumpToSetting(target),
  }, label);
  const head = (dotClass, name, actionBtn) => el('div', { class: 'plan-head' },
    el('span', { class: `plan-dot ${dotClass}`, 'aria-hidden': 'true' }),
    el('span', { class: 'plan-name' }, name), actionBtn);

  // BOX 1 — YOUR PLAN. The one choice here that changes cost: which subscription MetaHarness treats
  // as $0. Footer checklist: which OTHER providers have a real API key on this machine — honest now.
  //
  // Issue #86: `keys` is only a MEASUREMENT while the verified provider catalog actually loaded. When
  // that asset was missing from the packaged runtime, the server fell back to native detections and
  // said so in providerCatalog — and this checklist ignored it, printing a confident "✗ … No API key
  // for Gemini found on this machine" straight off `keys`. That turned an internal packaging failure
  // into a stated fact about the user's credentials. Not-checked is now its own third state.
  const catalogHealth = re.providerCatalog || null;
  const keysVerified = !catalogHealth
    || (catalogHealth.keysVerified !== false && catalogHealth.status !== 'degraded');
  const others = ['anthropic', 'openai', 'google', 'xai'].filter((id) => id !== house.provider);
  const checklist = el('div', { class: 'plan-keys' },
    el('span', { class: 'plan-keys-lab' }, keysVerified ? 'Other keys found:' : 'Other keys:'),
    ...others.map((id) => providerKeyChip(id, keys, keysVerified, KEY_NAME)),
    ...(keysVerified ? [] : [el('span', { class: 'plan-keys-note' },
      `Not checked — Brain could not load its provider catalog${catalogHealth && catalogHealth.detail ? ` (${catalogHealth.detail})` : ''}.`)]));
  const planBox = el('div', { class: 'plan-box' },
    el('span', { class: 'plan-label' }, 'Your plan', infoBtn('Your plan and OpenRouter', PROVIDERS_INFO)),
    head('is-house', houseName, action('Change', 'provider')),
    el('p', { class: 'plan-sub' }, `MetaHarness's main work runs here at no extra cost.`),
    checklist);

  // BOX 2 — OPENROUTER. A separate switch, not another house: Claude Code itself never leaves your
  // plan; this only offloads read-only text tasks (summarize, classify) to cheaper models.
  const routerOn = !!keys.openrouter;
  const laneBox = el('div', { class: 'plan-box' },
    el('span', { class: 'plan-label' }, 'OpenRouter'),
    head(`is-lane ${routerOn ? 'on' : 'off'}`, routerOn ? 'Active' : 'No key added',
      action(routerOn ? 'Manage' : 'Add a key', 'openrouterKey')),
    el('p', { class: 'plan-sub' }, routerOn
      ? `Text-only tasks like summarizing or classifying can go to cheaper models instead of using ${houseName}.`
      : `Add one so text-only tasks can skip ${houseName} and use cheaper models instead.`));

  return el('div', { class: 'plan-group' }, planBox, laneBox);
}

function renderSavings(sv) {
  const body = $('#body-savings');
  const totals = sv && sv.totals;
  const util = sv && sv.utilization && sv.utilization.tasks ? sv.utilization : null;
  const receipts = sv && Array.isArray(sv.receipts) ? sv.receipts : [];

  // The pitch is the action — always shown, whether or not routing is on yet. issue #20: the CTA
  // must reflect the SAVED config (sv.routing), not a fresh pristine "Turn on" pitch on every render
  // — otherwise a successful click reads as a lie the moment the page reloads. ctaSlot is a stable
  // container; paintCta(on) repaints it for the current state and is called again after a successful
  // save, so the toggle is visibly live, not just correct after a reload.
  const ctaSlot = el('div', { class: 'mh-cta' });
  // A PREFERENCE IS NOT A CAPABILITY, and this chip claimed one while the Capabilities card measured
  // the other. On a fresh machine the page said "✓ Smart routing: ON" here, "cheap-model-routing:
  // absent — agentic-flow is not installed" there, and "Off by default" in the subtitle between them.
  // The server now sends whether the tool is actually installed, so the chip can only ever say what
  // is simultaneously true of the preference AND the machine.
  const installed = !!(sv && sv.routingInstalled);

  // A failed save must never read as a success. postJSON does NOT throw on a non-2xx — a 403 from a
  // stale token (a known live case, handled explicitly elsewhere in this file) or an {ok:false} body
  // both landed in the `else` branch, which wrote "Saved." into an aria-live region and announced it
  // to screen readers while nothing had changed and the button re-enabled itself.
  const failed = (btn, note) => ({ status, data }) => {
    btn.disabled = false;
    note.textContent = status === 403
      ? 'The console was restarted — reload this page and try again.'
      : `Couldn’t save${data && data.log ? ` — ${data.log}` : ' — change it under Settings.'}`;
  };

  function paintCta(state) {
    const note = el('span', { class: 'mh-enable-note', 'aria-live': 'polite' }, '');
    const save = (btn, values, onOk) => async () => {
      btn.disabled = true; note.textContent = 'saving…';
      try {
        const r = await postJSON('/api/save-config', values);
        if (r.ok && r.data && r.data.ok) onOk();
        else failed(btn, note)(r);
      } catch { btn.disabled = false; note.textContent = 'Couldn’t save — change it under Settings.'; }
    };

    if (state === 'auto') {
      const offBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Turn off');
      offBtn.addEventListener('click', save(offBtn, { values: { routing: 'off' } }, () => paintCta('off')));
      ctaSlot.replaceChildren(
        installed
          ? chip('✓ Smart routing: ON', 'green', 'You chose smart routing, and agentic-flow is installed to carry it out')
          : chip('Smart routing: chosen, not installed', 'wait', 'You chose smart routing, but agentic-flow is not installed on this machine, so nothing is being routed yet'),
        offBtn, note);
      return;
    }

    const enableBtn = el('button', { class: 'mh-enable', type: 'button' }, 'Turn on smart routing');
    enableBtn.addEventListener('click', save(enableBtn, { values: { routing: 'auto' } }, () => paintCta('auto')));
    ctaSlot.replaceChildren(
      // "not chosen" and "chosen off" are different facts, and only one of them is a decision.
      state === 'off'
        ? chip('Smart routing: off', 'grey', 'You turned smart routing off')
        : chip('Smart routing: not chosen yet', 'wait', 'Nobody has answered this yet — it is neither on nor off'),
      enableBtn, note);
  }
  paintCta(sv && (sv.routing === 'auto' ? 'auto' : sv.routing === 'off' ? 'off' : null));
  // Stuart: "If you haven't ever seen MetaHarness, you have no idea what the word means, and you have
  // no idea what you should expect it to do. Saying 'do you want to use it or not' without any visual
  // explaining what it does is a little challenging." He is right — this card asked for a decision
  // before it earned understanding, and seven lines of prose is not how anyone learns a new word.
  // rUv called this exact risk in ADR-076: define the term in the first screen or it reads as jargon;
  // mitigation = the one-line gloss + the four-pillar framing. The diagram IS that mitigation, so the
  // paragraph it replaces is gone rather than sitting above it saying the same thing more slowly.
  const pitch = el('div', { class: 'mh-pitch' },
    el('p', { class: 'mh-lead' },
      el('b', {}, 'MetaHarness'), ' tunes everything wrapped around your model — the planning, the ',
      'context, the retries, which model each task goes to — and keeps only the changes that ',
      el('b', {}, 'measurably win'), '. The model itself never changes. rUv leaves it ',
      el('b', {}, 'off by default'), ' on purpose: he’d rather you choose it than have it forced on you.',
      infoBtn('Smart model routing', SAVINGS_INFO)),
    el('figure', { class: 'mh-diagram' },
      el('img', {
        // NOT lazy: at 6.5KB this saves nothing, and the card sits far enough down the page that the
        // lazy threshold never fires — the diagram simply never appeared. Verified: no network
        // request at all with loading="lazy", even after scrolling the card into view.
        src: 'assets/metaharness.svg', width: '900', height: '470',
        alt: 'MetaHarness: the model sits frozen at the centre while seven policy surfaces around it — '
           + 'planner, contextBuilder, reviewer, retryPolicy, toolPolicy, memoryPolicy and scorePolicy — '
           + 'are each mutated and measured. Four pillars run underneath: route, evolve, orchestrate, '
           + 'verify. Per agentic-flow ADR-076: 28.5% cheaper at 98.1% bar-compliance.',
      })),
    ctaSlot);

  const blocks = [];
  const prov = renderProviders(sv);
  if (prov) blocks.push(prov);
  blocks.push(pitch);

  if (!util && !receipts.length) {
    setChips('chips-savings', [chip('nothing routed yet', 'wait')]);
    // WP2b — the first-run state is a confident promise, not an apology.
    blocks.push(el('div', { class: 'mh-empty' },
      el('p', { class: 'mh-empty-title' }, 'Nothing routed yet — that’s expected.'),
      el('p', { class: 'mh-empty-body' },
        'Turn it on, work normally for a week, then come back. You’ll see exactly what you saved by not sending everything to the most expensive frontier model — every number here will be a ',
        el('b', {}, 'real receipt'), ', never a projection.')));
    // Even before any task runs, show what the router WOULD choose per bucket — the plan is real.
    const rp0 = renderRouterEngine(sv && sv.routerEngine);
    if (rp0) blocks.push(rp0);
    body.replaceChildren(withIllo('savings', ...blocks));
    return;
  }

  // Headline numbers come from the measured utilization (recomputed vs the current frontier, Fable 5).
  const frontierName = util ? prettyModel(util.frontierModel) : 'the frontier';
  const pct = util ? util.pctSaved
    : (totals && totals.pctSaved != null ? totals.pctSaved
      : (totals && totals.baselineUsd ? Math.round((totals.usdSaved / totals.baselineUsd) * 100) : null));
  const savedUsd = util ? util.costOptimalitySaved : (totals ? totals.usdSaved : 0);
  const taskCount = util ? util.tasks : (totals ? totals.count : 0);

  setChips('chips-savings', [
    pct != null ? chip(`${pct}% saved`, 'green') : chip(`${fmtUsd(savedUsd)} saved`, 'green'),
    chip(`${fmtInt(taskCount)} routed`, 'grey'),
  ]);

  // The distribution hero states the same four numbers ($ saved, tasks, frontier-if-all, actual
  // spend) at a size you can read across the room, and the chip carries the %. Rendering the tiles
  // above it too would say $15.17 twice on one card — the "everything at the same weight" problem
  // this card was just rebuilt to fix, wearing a different hat. So the strip is now the FALLBACK:
  // it only appears when there are no receipts yet and the hero has nothing to say.
  const dist = renderDistribution(util);
  if (!dist) {
    blocks.push(el('div', { class: 'totals-strip' },
      el('div', { class: 'total-tile t-green' },
        el('div', { class: 'total-num' }, pct != null ? `${pct}%` : fmtUsd(savedUsd)),
        el('div', { class: 'total-lab' }, `saved vs ${frontierName}`)),
      el('div', { class: 'total-tile' },
        el('div', { class: 'total-num' }, fmtUsd(savedUsd)),
        el('div', { class: 'total-lab' }, '$ kept')),
      el('div', { class: 'total-tile' },
        el('div', { class: 'total-num' }, fmtInt(taskCount)),
        el('div', { class: 'total-lab' }, 'tasks routed')),
      el('div', { class: 'total-tile' },
        el('div', { class: 'total-num' }, util ? fmtUsd(util.frontierUsd) : (totals && totals.msSaved >= 0 ? fmtMs(totals.msSaved) : '—')),
        el('div', { class: 'total-lab' }, util ? `if all on ${frontierName}` : 'time saved'))));
  }

  // WP2a — provenance, worn openly: these numbers are receipts, not projections.
  const receiptCount = util ? util.tasks : (totals && totals.count != null ? totals.count : receipts.length);
  blocks.push(el('p', { class: 'prov-badge' },
    el('span', { class: 'prov-dot', 'aria-hidden': 'true' }),
    el('span', {}, 'real numbers — recomputed from your ',
      el('b', {}, `${fmtInt(receiptCount)} receipt${receiptCount === 1 ? '' : 's'}`),
      ', never projected')));

  // The distribution — how many tasks went to each bucket, and the saved-vs-frontier math.
  // (computed above, so the totals-strip can stand down when this hero is doing the talking)
  if (dist) blocks.push(dist);

  // Full receipt detail, collapsed so the summary stays clean for a first-time reader.
  if (receipts.length) {
    blocks.push(el('details', { class: 'mh-receipts' },
      el('summary', { class: 'rp-summary' },
        el('span', { class: 'rp-sum-t' }, 'Every routed task'),
        el('span', { class: 'rp-sum-s' },
          totals && totals.count > receipts.length
            ? `${fmtInt(totals.count)} measured receipts — showing the ${fmtInt(receipts.length)} newest`
            : `${fmtInt(receipts.length)} measured receipt${receipts.length === 1 ? '' : 's'} · newest first`),
        el('span', { class: 'rp-chev', 'aria-hidden': 'true' }, '›')),
      el('div', { class: 'scroll-x scroll-y' },
        el('table', { class: 'tb' },
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, 'When'), el('th', { scope: 'col' }, 'Routed to'),
            el('th', { scope: 'col' }, 'Instead of'), el('th', { scope: 'col' }, 'Task'),
            el('th', { scope: 'col' }, 'Saved'))),
          el('tbody', {}, receipts.map((r) => el('tr', {},
            el('td', { class: 'cell-mono cell-dim' }, fmtDate(r.at)),
            el('td', { class: 'cell-mono' }, r.chosenTier || '—'),
            el('td', { class: 'cell-mono cell-dim' }, r.baselineTier || '—'),
            el('td', { class: 'cell-dim' }, (r.task && r.task.length > 60) ? r.task.slice(0, 58) + '…' : (r.task || '—')),
            el('td', { class: 'cell-mono num' }, fmtUsd(r.measuredUsd)),
          )))))));
  }

  // (sv.note used to render here as 11px fineprint — the provenance badge above replaced it.)

  const rp = renderRouterEngine(sv.routerEngine);
  if (rp) blocks.push(rp);

  body.replaceChildren(withIllo('savings', ...blocks));
}

/* --------------------------------------------------------- section 6: settings */

// Shown wherever a control is sitting on a recommendation rather than on a stored answer.
const notChosenField = (rec) => el('span', { class: 'field-unset' },
  'Not chosen yet — this shows the recommended setting (', el('b', {}, String(rec)), '), not your machine’s.');

/**
 * WP4 — every row answers What / Why / How on click. Fields with hand-written copy in SETTING_INFO
 * use it verbatim; everything else builds its beats from what the SERVER actually sent — `help`,
 * and, where the schema carries them (user-settings.mjs entries do), `whyItMatters`/`downside` —
 * rather than inventing new copy here. That is how the advocacy dial gets its info bubble without
 * this file duplicating a single sentence user-settings.mjs already owns.
 */
function fieldBeats(f) {
  if (SETTING_INFO[f.key]) return SETTING_INFO[f.key];
  const beats = [{ k: 'What is this?', t: f.help || 'A RuvNet Brain option, stored in your settings file.' }];
  if (f.whyItMatters) beats.push({ k: 'Why does it matter?', t: f.whyItMatters });
  if (f.downside) beats.push({ k: 'What’s the downside?', t: f.downside });
  return beats;
}

/**
 * Build ONE field's control + its label/info/help row. Factored out of renderSettings so the
 * advocacy dial (backed by user-settings.mjs, a different file, a different endpoint) gets the exact
 * same widget — same markup, same "not chosen" honesty rule, same info-bubble mechanics — as every
 * config.json field, rather than a bespoke control invented for one setting.
 */
function buildSettingsField(f, values, defaults, refreshDirty) {
  const labId = `lab-${f.key}`;
  const helpId = `help-${f.key}`;
  const ctl = el('div', { class: 'field-ctl' });
  let collector;
  let initialValue;

  if (f.type === 'secret' || f.secret) {
    const isSet = values[f.key] === true;
    let input = null;
    const buildInput = () => {
      input = el('input', {
        type: 'password', class: 'text-input', autocomplete: 'off',
        spellcheck: 'false', placeholder: isSet ? 'Enter a new key to replace it' : 'Enter key',
        'aria-labelledby': labId, 'aria-describedby': helpId,
        oninput: refreshDirty,
      });
      const showBtn = el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: () => {
          const showing = input.type === 'text';
          input.type = showing ? 'password' : 'text';
          showBtn.textContent = showing ? 'Show' : 'Hide';
        },
      }, 'Show');
      const row = el('div', { class: 'secret-input-row' }, input, showBtn);
      if (isSet) {
        row.append(el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => { row.replaceWith(buildSetRow()); input = null; refreshDirty(); },
        }, 'Keep existing'));
      }
      return row;
    };
    const buildSetRow = () => el('div', { class: 'secret-set-row' },
      el('span', { class: 'chip tone-green secret-set', title: 'A value is stored; it is never sent to this page.' }, '•••• set'),
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', 'aria-describedby': helpId,
        onclick: (e) => { const r = buildInput(); e.currentTarget.parentElement.replaceWith(r); input.focus(); refreshDirty(); },
      }, 'Replace…'));
    ctl.append(isSet ? buildSetRow() : buildInput());
    collector = () => ({ secret: true, include: !!(input && input.value.trim()), value: input ? input.value.trim() : undefined });
  } else if (f.type === 'bool') {
    // NOT CHOSEN IS NOT OFF. The server sends null when the user has never answered this question,
    // and a bare unchecked switch states "off" — a claim about their machine that nobody made. The
    // control still has to sit somewhere, so it sits on the RECOMMENDED value and says, in words,
    // that this is a recommendation and not their current setting.
    const chosen = values[f.key] === true || values[f.key] === false;
    const rec = defaults[f.key] === true;
    const input = el('input', { type: 'checkbox', 'aria-labelledby': labId, 'aria-describedby': helpId, onchange: refreshDirty });
    input.checked = chosen ? values[f.key] === true : rec;
    initialValue = input.checked;
    ctl.append(el('label', { class: 'switch' }, input, el('span', { class: 'track', 'aria-hidden': 'true' })));
    if (!chosen) ctl.append(notChosenField(rec ? 'on' : 'off'));
    collector = () => ({ include: true, value: input.checked });
  } else if (f.type === 'enum' && Array.isArray(f.options)) {
    const name = `seg-${f.key}`;
    const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': labId, 'aria-describedby': helpId });
    const inputs = [];
    const chosen = f.options.some((opt) => Object.is(values[f.key], opt));
    const rec = f.options.includes(defaults[f.key]) ? defaults[f.key] : f.options[0];
    for (const opt of f.options) {
      const input = el('input', { type: 'radio', name, value: String(opt), onchange: refreshDirty });
      input.optionValue = opt;
      input.checked = chosen ? Object.is(values[f.key], opt) : Object.is(opt, rec);
      inputs.push(input);
      seg.append(el('label', {}, input, el('span', { class: 'seg-lab' }, segLabel(f.key, opt))));
    }
    // Falling back to options[0] and saying nothing is how "routing: auto" appeared to be the
    // user's setting on a machine whose config file did not exist.
    if (!inputs.some((i) => i.checked) && inputs[0]) inputs[0].checked = true;
    initialValue = inputs.find((i) => i.checked)?.optionValue;
    if (f.key === 'advocacy' && !chosen) {
      ctl.append(el('p', { class: 'field-consult', role: 'note' },
        'First-time choice: how much should RuvNet Brain jump in unprompted? Choose 1–5. ',
        el('b', {}, '3 · Balanced is recommended'), ' and you can change it any time.'));
    }
    ctl.append(seg);
    if (!chosen) ctl.append(notChosenField(segLabel(f.key, rec)));
    collector = () => ({ include: true, value: inputs.find((i) => i.checked)?.optionValue });
  } else {
    const input = el('input', {
      type: 'text', class: 'text-input', 'aria-labelledby': labId, 'aria-describedby': helpId, oninput: refreshDirty,
    });
    input.value = values[f.key] != null && values[f.key] !== true ? String(values[f.key]) : '';
    initialValue = input.value;
    ctl.append(input);
    collector = () => ({ include: true, value: input.value });
  }

  const row = el('div', { class: 'field', id: `field-${f.key}` },
    el('div', {},
      el('span', { class: 'field-label', id: labId }, f.label || f.key, infoBtn(f.label || f.key, fieldBeats(f))),
      f.help ? el('p', { class: 'field-help', id: helpId }, f.help) : el('span', { id: helpId })),
    ctl);

  return { row, collector, initialValue };
}

/**
 * Build one COMPLETE settings form — every field in `cfg.schema`, a Save button, and a submit
 * handler that POSTs to `endpoint`. Used twice: once for config.json's five fields, once for the
 * single advocacy field backed by user-settings.mjs — same widget, same save/undo/error handling,
 * only the endpoint and the file it names in its own copy differ.
 */
function buildSettingsForm(cfg, { endpoint }) {
  const values = cfg.values || {};
  // What the project would pick FOR you, kept strictly apart from what you actually picked. The
  // server sends these separately for exactly that reason — see gatherConfig / gatherAdvocacy.
  const defaults = cfg.defaults || {};

  const form = el('form', { class: 'settings-form', novalidate: true });
  const collectors = {}; // key → () => ({ include, value })
  const initial = {};
  let saveBtn;
  const resultSlot = el('div');

  function isDirty() {
    for (const [key, get] of Object.entries(collectors)) {
      const g = get();
      if (g.secret) { if (g.include) return true; continue; }
      if (g.value !== initial[key]) return true;
    }
    return false;
  }
  function refreshDirty() { if (saveBtn) saveBtn.disabled = !isDirty(); }

  for (const f of cfg.schema) {
    const { row, collector, initialValue } = buildSettingsField(f, values, defaults, refreshDirty);
    collectors[f.key] = collector;
    if (f.type !== 'secret' && !f.secret) initial[f.key] = initialValue;
    form.append(row);
  }

  saveBtn = el('button', { class: 'btn btn-apply', type: 'submit', disabled: true }, 'Save settings');
  form.append(el('div', { class: 'save-row' },
    saveBtn,
    el('p', { class: 'save-note' },
      'Saves to ', el('code', {}, cfg.path || '~/.claude/ruvnet-brain/config.json'),
      ' in your user folder. Each choice is enforced by its named runtime; encrypted secrets and scheduler state never live in this browser response.')),
    resultSlot);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const [key, get] of Object.entries(collectors)) {
      const g = get();
      if (g.include) out[key] = g.value; // untouched secrets are simply absent
    }
    saveBtn.disabled = true;
    const prev = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    resultSlot.replaceChildren();
    try {
      const { status: code, data } = await postJSON(endpoint, { values: out });
      if (code === 403) {
        resultSlot.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' }, TOKEN_MSG));
      } else if (data && data.ok) {
        // Not every store behind this form has an undo token — saveAdvocacy() (user-settings.mjs)
        // returns a real backup path but no journalled undoToken the way saveConfig() does, so this
        // button simply does not appear for that form rather than pretending a capability exists.
        const undoBtn = data.undoToken ? el('button', {
          class: 'btn btn-undo btn-sm', type: 'button',
          // try/catch, because this is an async onclick with a network call in it. Without one, a
          // dropped connection rejected the promise, left the button permanently disabled and printed
          // NOTHING — the user is looking at a dead undo button with no idea whether it ran. The
          // server's own explanation is shown verbatim on failure: "this undo has already been used"
          // and "your settings were saved again after this point" are the two cases people will
          // actually hit, and both are worth reading.
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            try {
              const r = await postJSON('/api/undo', { undoToken: data.undoToken });
              const ok = r.ok && r.data?.ok;
              if (!ok) btn.disabled = false;
              resultSlot.replaceChildren(el('div', { class: `form-note ${ok ? 'n-ok' : 'n-err'}`, role: 'status' },
                ok
                  ? 'Settings restored from the backup. Reload to see the restored values.'
                  : (r.status === 403 ? TOKEN_MSG
                    : `Undo didn’t complete — ${r.data?.log || 'the backup file still exists, nothing is lost.'}`)));
            } catch (err) {
              btn.disabled = false;
              resultSlot.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
                `Undo couldn’t reach the console server: ${err.message || err}. Nothing was changed.`));
            }
          },
        }, 'Undo save') : null;
        resultSlot.replaceChildren(el('div', { class: 'form-note n-ok', role: 'status' },
          frag(BADGE_OK),
          el('div', { class: 'fn-body' },
            el('b', {}, 'Saved.'), ' Your choices are in ',
            el('span', { class: 'fn-path' }, cfg.path || 'your user folder'), '.',
            data.backup ? el('span', {}, ' Backup kept at ', el('span', { class: 'fn-path' }, data.backup), '.') : ''),
          undoBtn));
        for (const [key, get] of Object.entries(collectors)) {
          const g = get(); if (!g.secret) initial[key] = g.value;
        }
        announce('Settings saved.');
      } else {
        // The server says WHY — a rejected value names itself ("routing: expected one of auto, off").
        // Swallowing that left the user re-clicking a button that would fail identically every time.
        resultSlot.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
          data && data.log
            ? `Save didn’t complete — ${data.log}`
            : 'Save didn’t complete. Your file was not changed without its backup.'));
        refreshDirty();
      }
    } catch (err) {
      resultSlot.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
        `Couldn’t reach the console server: ${err.message || err}`));
      refreshDirty();
    }
    saveBtn.textContent = prev;
  });

  return form;
}

/**
 * `cfg` is config.json's fields (issue's original section); `us` is user-settings.mjs's fields — for
 * now just the advocacy dial (ADR-032 §DDD-0004 "the three channels": this control is the volume knob
 * on the speech channel). Two stores, two forms, one shared widget — see buildSettingsField/Form.
 */
function renderSettings(cfg, us, bp) {
  const body = $('#body-settings');
  // `bp` is NOT counted here any more: its field is rendered by #card-brain at the top of the page,
  // and counting a control this card does not show would make the "N options" chip a lie by one.
  const groups = [cfg, us].filter((c) => c && Array.isArray(c.schema) && c.schema.length);
  const unavailable = [cfg, us]
    .flatMap((c) => (c && Array.isArray(c.unavailable) ? c.unavailable : []));
  if (!groups.length) {
    setChips('chips-settings', [chip('no schema', 'grey')]);
    body.replaceChildren(el('p', { class: 'muted' }, 'No editable settings were received.'));
    return;
  }

  const totalOptions = groups.reduce((n, c) => n + c.schema.length, 0);
  const unsetCount = groups.reduce((n, c) => {
    const values = c.values || {};
    return n + c.schema.filter((f) => !f.secret && f.type !== 'secret'
      && (values[f.key] === null || values[f.key] === undefined)).length;
  }, 0);
  setChips('chips-settings', [chip(`${totalOptions} option${totalOptions === 1 ? '' : 's'}`, 'grey'),
    unavailable.length ? chip(`${unavailable.length} unavailable here`, 'wait') : null,
    unsetCount ? chip(`${unsetCount} not chosen yet`, 'wait') : null,
    groups.some((c) => c.exists === false) ? chip('not created yet', 'wait') : null].filter(Boolean));

  const main = [];
  // THE MASTER SWITCH MOVED OUT OF HERE (owner, 2026-07-27). It used to be rendered first in this
  // card, on the reasoning that "a volume knob below a power switch reads as more important than the
  // power switch". The reasoning was right and the placement was still wrong: this whole card sits
  // several sections down the page, behind a chevron, so the owner opened the console looking for
  // "a big on/off switch" and could not find it at all.
  //
  // It is now its own always-open card at the TOP of the page (#card-brain, renderBrainPower). This
  // card keeps ONE line — a pointer — because the second-worst outcome after "can't find it" is
  // "found two of them and they disagree".
  if (bp && typeof bp.off === 'boolean') {
    main.push(el('p', { class: 'fineprint' },
      'The brain’s on/off switch is at the top of this page — it is ',
      el('b', {}, bp.off ? 'off' : 'on'), ' right now. ',
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: () => { document.getElementById('card-brain')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
      }, 'Take me to it')));
  }
  if (cfg && Array.isArray(cfg.schema) && cfg.schema.length) main.push(buildSettingsForm(cfg, { endpoint: '/api/save-config' }));
  if (us && Array.isArray(us.schema) && us.schema.length) main.push(buildSettingsForm(us, { endpoint: '/api/save-advocacy' }));
  if (unavailable.length) {
    main.push(el('section', { class: 'settings-unavailable', 'aria-labelledby': 'settings-unavailable-h' },
      el('h3', { id: 'settings-unavailable-h' }, 'Unavailable on this machine'),
      el('p', { class: 'fineprint' },
        'These choices have runtime enforcement, but that runtime is not supported or reachable on this machine. ',
        'They stay visible with the measured reason instead of becoming a dead switch.'),
      el('ul', { class: 'settings-unavailable-list' },
        unavailable.map((item) => el('li', {},
          el('b', {}, item.label || item.key),
          el('span', {}, ` — ${item.reason || 'No runtime consumer is implemented.'}`))))));
  }

  body.replaceChildren(withIllo('settings', ...main));
}

/* ═══════════════════════════════════════════════════════════ BRAIN POWER — the master switch
   Owner, 2026-07-27, after opening the console to look for it: "if it didn't show up in the console,
   how can it be implemented?" ADR-054's switch was real, saved correctly, and rendered — as one
   checkbox inside the Settings card, several sections below the things it governs, behind a chevron.
   From where the user stands that is indistinguishable from not existing.

   FOUR RULES THIS RENDERER KEEPS:
     1. ONE SWITCH ON THE PAGE. Settings no longer renders the field; it points here. Two controls for
        one machine state is how they end up disagreeing.
     2. THE STATE IS READ, NEVER ASSUMED. Every paint comes from the server's resolved answer (the
        SENTINEL, not the settings mirror). A click does not flip the visual — it posts, waits, and
        re-reads. A switch that moves before the machine does is a lie with an animation on it.
     3. THE COPY COMES FROM THE SCHEMA. whyItMatters/downside are rendered from the served field, never
        re-typed here, so this card cannot drift from what user-settings.mjs actually says.
     4. CONSENT FOR THE DESTRUCTIVE DIRECTION ONLY. Turning it OFF opens a confirm step carrying the
        real consequences; turning it back ON is immediate, because there is nothing to warn about. */

let bpBusy = false;

function bpField(bp) {
  return (bp && Array.isArray(bp.schema) && bp.schema[0]) || null;
}

function renderBrainPower(bp) {
  const body = $('#body-brain');
  if (!body) return;
  if (!bp || typeof bp.off !== 'boolean') {
    // NOT "on". An unreadable switch is reported as unreadable — the same rule the capabilities card
    // lives by, applied to the one control that governs it.
    setChips('chips-brain', [chip('can’t read the switch', 'nt')]);
    body.replaceChildren(el('p', { class: 'muted' },
      'The console could not read the on/off state from this machine, so it is not showing one. ',
      'Nothing has changed; the switch file is the authority and it is untouched.'));
    return;
  }
  const on = !bp.off;
  const f = bpField(bp);
  setChips('chips-brain', [chip(on ? 'ON' : 'OFF', on ? 'green' : 'amber')]);

  const knob = el('span', { class: 'bp-track' }, el('span', { class: 'bp-knob' }));
  const switchBtn = el('button', {
    class: 'bp-switch', type: 'button', role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    'aria-labelledby': 'card-brain-h',
    disabled: bpBusy || null,
    onclick: () => { if (on) bpAskToTurnOff(bp); else void bpFlip(true); },
  }, knob, el('span', { class: 'bp-switch-label' }, on ? 'Turn it off' : 'Turn it back on'));

  // The description is the SCHEMA's own `help` line (rule 3), so this card cannot say something
  // different from what the settings store says about the same key.
  const state = el('div', { class: 'bp-state' },
    el('div', { class: 'bp-word' }, el('span', { class: 'bp-dot' }), on ? 'Your brain is ON' : 'Your brain is OFF'),
    el('p', { class: 'bp-sub' }, f && f.help ? f.help : 'Whether the brain is working at all.'),
    bp.off && bp.since
      ? el('p', { class: 'bp-sub' }, `Off since ${String(bp.since).slice(0, 10)}${bp.reason ? ` — ${bp.reason}` : ''}.`)
      : null);

  const main = [
    el('div', { class: `bp-row ${on ? 'bp-on' : 'bp-off'}`, id: 'bp-row' }, state, switchBtn),
    el('div', { id: 'bp-confirm-slot' }),
    el('div', { id: 'bp-result-slot' }),
  ];

  // What keeps running and what stops — from the SERVER's own list, so it can never drift from what
  // session-start.sh actually does.
  if (Array.isArray(bp.notes) && bp.notes.length) {
    main.push(el('ul', { class: 'bp-notes' }, bp.notes.map((n) => el('li', {}, n))));
  }
  if (bp.disagreement) main.push(el('p', { class: 'fineprint bp-warn' }, bp.disagreement.note));
  if (bp.switchPath) {
    // .fn-path, not <code>: an absolute path is reference detail, and a full-width monospace block
    // two lines tall out-shouts the switch it is a footnote to.
    main.push(el('p', { class: 'fineprint' },
      'The switch is a file — ', el('span', { class: 'fn-path' }, bp.switchPath),
      ' — so it survives updates, and every part of the product reads the same one.'));
  }
  if (bp.profile) main.push(bpProfileControl(bp.profile));
  main.push(bpParts(bp));
  body.replaceChildren(...main);
}

let bpProfileBusy = false;
const bpSize = (bytes) => {
  if (!Number.isFinite(bytes)) return 'size measured after install';
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
};

function bpProfileControl(profile) {
  const current = profile.values?.brainProfile;
  const result = el('div', { class: 'bp-profile-result' });
  const apply = el('button', { class: 'btn btn-apply', type: 'button', disabled: true }, 'Apply selection');
  const options = [
    {
      value: 'complete',
      title: 'Complete Brain',
      copy: 'Every public rUv repository in the release. Best for cross-repository answers and supporting evidence.',
    },
    {
      value: 'ruvector',
      title: 'RuVector Only',
      copy: 'Keeps the shared reader and RuVector RVF only. Smallest footprint, but no evidence from Ruflo, AgentDB, RuView, or the other repositories.',
    },
  ];
  const radios = [];
  const cards = options.map((option) => {
    const choice = profile.choices?.[option.value] || {};
    const input = el('input', {
      type: 'radio',
      name: 'brain-profile',
      value: option.value,
      disabled: choice.available === false || null,
      onchange: () => { apply.disabled = bpProfileBusy || input.value === current; },
    });
    input.checked = option.value === current;
    radios.push(input);
    return el('label', { class: `bp-profile-choice${input.disabled ? ' unavailable' : ''}` },
      input,
      el('span', { class: 'bp-profile-copy' },
        el('span', { class: 'bp-profile-title' }, option.title,
          option.value === current ? chip('active', 'green') : null),
        el('span', { class: 'bp-profile-meta' },
          `${choice.storeCount || (option.value === 'ruvector' ? 1 : '—')} ${choice.storeCount === 1 ? 'store' : 'stores'} · ${bpSize(choice.bytes)}`),
        el('span', { class: 'bp-profile-desc' }, option.copy),
        choice.available === false
          ? el('span', { class: 'bp-profile-desc bp-warn' }, 'The complete release bundle is not available on this machine; run the Brain update first.')
          : null));
  });

  apply.onclick = async () => {
    const selected = radios.find((radio) => radio.checked)?.value;
    if (!selected || selected === current || bpProfileBusy) return;
    if (selected === 'ruvector' && !window.confirm(
      'Switch to RuVector Only? This removes the other public repository RVFs from this machine. You can restore them from the complete signed bundle later.',
    )) return;
    bpProfileBusy = true;
    apply.disabled = true;
    apply.textContent = selected === 'complete' ? 'Restoring…' : 'Removing unselected stores…';
    result.replaceChildren();
    try {
      const response = await postJSON('/api/save-brain-profile', { values: { brainProfile: selected } });
      const data = response?.data || {};
      if (!response.ok || !data.ok) {
        result.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
          response?.status === 403 ? TOKEN_MSG : `The profile did not change — ${data.log || 'the console could not apply it.'}`));
      } else {
        result.replaceChildren(el('div', { class: 'form-note n-ok', role: 'status' },
          el('div', { class: 'fn-body' }, el('b', {}, data.profile === 'ruvector' ? 'RuVector Only is active.' : 'Complete Brain is active.'),
            ` ${data.log}.`,
            data.bytesFreed ? ` ${bpSize(data.bytesFreed)} released.` : '')));
        announce(data.log || 'Brain profile changed.');
      }
    } catch (error) {
      result.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
        `Couldn’t reach the console server: ${error.message || error}. Nothing was changed.`));
    } finally {
      bpProfileBusy = false;
      await loadState();
    }
  };

  return el('section', { class: 'bp-profile', 'aria-labelledby': 'bp-profile-h' },
    el('div', { class: 'bp-profile-head' },
      el('h3', { id: 'bp-profile-h' }, 'How much of the brain is installed'),
      el('span', { class: 'bp-parts-hint' }, profile.path || 'installed brain')),
    el('p', { class: 'bp-profile-lead' },
      'This changes the RVF files on disk, not just a preference. Nightly updates preserve the selection.'),
    el('div', { class: 'bp-profile-grid', role: 'radiogroup', 'aria-labelledby': 'bp-profile-h' }, ...cards),
    profile.disagreement
      ? el('p', { class: 'fineprint bp-warn' }, 'The stored preference did not match the RVFs on disk. The console is showing the files that actually exist.')
      : null,
    el('div', { class: 'bp-profile-actions' }, apply),
    result);
}

/* The consent step, shown only for OFF. The downside text is the schema's own. */
function bpAskToTurnOff(bp) {
  const slot = $('#bp-confirm-slot');
  if (!slot) return;
  const f = bpField(bp);
  slot.replaceChildren(el('div', { class: 'bp-confirm', role: 'group', 'aria-label': 'Confirm turning the brain off' },
    el('p', {}, f && f.downside
      ? f.downside
      : 'Turning it off stops retrieval, the grounding gate, everything it volunteers, and learning.'),
    el('div', { class: 'bp-actions' },
      el('button', { class: 'btn btn-apply', type: 'button', onclick: () => { void bpFlip(false); } }, 'Turn the brain off'),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => slot.replaceChildren() }, 'Keep it on'))));
  slot.querySelector('button')?.focus();
}

/* POST, then RE-READ. The new state is whatever the server says after the write — never what we just
   asked for. loadState() repaints this card from the same measured payload every other card uses. */
async function bpFlip(next) {
  if (bpBusy) return;
  bpBusy = true;
  const slot = $('#bp-result-slot');
  $('#bp-confirm-slot')?.replaceChildren();
  setChips('chips-brain', [chip(next ? 'switching on…' : 'switching off…', 'wait')]);
  announce(next ? 'Switching the brain on.' : 'Switching the brain off.');
  try {
    const r = await postJSON('/api/save-brain-power', { values: { brainEnabled: next } });
    const data = (r && r.data) || {};
    if (!r.ok || !data.ok) {
      slot?.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
        r.status === 403 ? TOKEN_MSG : `The switch did not move — ${data.log || `the console returned ${r.status}`}.`));
    } else {
      slot?.replaceChildren(el('div', { class: 'form-note n-ok', role: 'status' },
        el('div', { class: 'fn-body' }, el('b', {}, data.off ? 'The brain is off.' : 'The brain is on.'), ' ', data.log)));
      announce(data.log || 'Done.');
    }
  } catch (err) {
    slot?.replaceChildren(el('div', { class: 'form-note n-err', role: 'alert' },
      `Couldn’t reach the console server: ${err.message || err}. Nothing was changed.`));
  } finally {
    bpBusy = false;
    // Re-read rather than trusting the write's own echo: the sentinel on disk is the authority.
    await loadState();
  }
}

/* ── "Parts of the brain" — the honest state of per-piece control ───────────────────────────────────
   The owner's second question, and the one a row of fake checkboxes would answer wrongly: where are
   the sub-piece switches? The answer today is "one is real, one lives in Settings, one is still being
   measured", and this block says exactly that. Every entry states its OWN control surface, so nobody
   has to wonder again whether a piece is missing or merely elsewhere.

   THE RULE THAT KEEPS IT HONEST is user-settings.mjs's own: a switch is not shipped until something
   reads it. The ordinary schema keys (learningScope, advocacy, autoApply, newProjectDefaults) are
   rendered by the shared Settings form below and saved through the user-settings writer. Only
   controls with a real runtime consumer are included; a row that governs nothing would make every
   other switch on this page untrustworthy. */
function bpParts(bp) {
  const off = !!bp.off;
  const part = (title, chipText, tone, ...text) => el('div', { class: 'bp-part' },
    el('div', { class: 'bp-part-h' }, el('b', {}, title), chip(chipText, tone)),
    el('div', { class: 'bp-part-t' }, ...text));

  // COLLAPSED, BUT NAMED. The owner's complaint was that he could not find the sub-piece controls —
  // which a visible heading fixes. Leaving the whole block expanded would push the page's actual
  // content a full screen down on every visit, so the answer to "where are they?" is on screen and
  // the detail behind it is one click. It is NOT the switch itself: nothing about the power switch is
  // ever behind a click.
  return el('details', { class: 'bp-parts' },
    el('summary', {}, el('h3', {}, 'Parts of the brain'), el('span', { class: 'bp-parts-hint' }, 'what is separately controllable, and what is not yet')),
    el('p', { class: 'bp-parts-lead' },
      'The switch above is all-or-nothing today. These are the pieces underneath it, and where each ',
      'one is actually controlled — including the ones that are not controllable yet, and why.'),

    part('Retrieval, grounding, learning', off ? 'off with the brain' : 'on with the brain', off ? 'grey' : 'green',
      'The three things the switch above governs together. They are not separately switchable yet ',
      'because each is enforced from the same sentinel file the switch writes.'),

    part('Maintenance while it is off', 'in Settings', 'cyan',
      'Version updates and the health alarm keep running even when the brain is off — an off machine ',
      'has to be able to receive the fix for an off-state bug. The nightly refresh is the part of that ',
      'you can pause: it is the ',
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => jumpToSetting('nightly') }, 'Nightly brain refresh'),
      ' switch in Settings.'),

    part('Installed knowledge',
      bp.profile?.values?.brainProfile === 'ruvector'
        ? 'RuVector Only'
        : bp.profile?.values?.brainProfile === 'complete' ? 'Complete Brain' : 'not measured',
      'cyan',
      'The two-box selector above physically keeps or restores repository RVFs. Complete Brain is ',
      'best for cross-repository reasoning; RuVector Only is the compact choice for people who only ',
      'need the RuVector source. Nightly updates preserve whichever profile is selected.'),

    el('p', { class: 'fineprint' },
      'There are three more switches in the settings file — what it learns from, whether it may act ',
      'on its own, and whether new projects inherit these choices. They are deliberately not shown ',
      'as controls here: nothing enforces them yet, and a switch that governs nothing would make ',
      'every real switch on this page worth less.'));
}

/* -------------------------------------------------- section 7: trust & provenance
   v3.3 preview (PROVE stage). One row is REAL today — the release bundle's published
   sha256, read live from the latest GitHub release — plus the install channel read from
   the plugin cache on disk. The SBOM and Advisor Mode rows are honest empty states: each
   says exactly what will fill it and when. Nothing here is placeholder data. */

const TRUST_INFO = {
  signature: [
    { k: 'What is this?', t: 'The sha256 fingerprint of the release bundle, published as its own asset on every GitHub release.' },
    { k: 'Why does it matter?', t: 'If your download’s fingerprint matches the published one, the bundle is byte-identical to what was released — nothing altered, nothing truncated.' },
    { k: 'How do I use it?', t: 'Run shasum -a 256 ruvnet-brain.zip on your download and compare. v3.3 adds a one-click local check right here.' },
  ],
  sbom: [
    { k: 'What is this?', t: 'A Software Bill of Materials — the complete, machine-readable list of every package inside the bundle.' },
    { k: 'Why does it matter?', t: 'You can see what’s in the box without unzipping it, and scanners can watch it for known vulnerabilities.' },
    { k: 'How does it help me?', t: 'v3.3 attaches a CycloneDX SBOM to every release; this row will then show its package count and digest, measured from the published asset.' },
  ],
  channel: [
    { k: 'What is this?', t: 'How your plugin updates: riding the latest release, or pinned to a version you chose.' },
    { k: 'Why does it matter?', t: 'This stack ships fast — latest keeps you current. Pinning holds a known-good release when you need repeatable builds.' },
    { k: 'How does it help me?', t: 'Read from your plugin cache on disk, never assumed. Version pinning is planned — both choices will live on this row.' },
  ],
  advisor: [
    { k: 'What is this?', t: 'A coming mode switch. Full lets the console apply consent-gated, undoable fixes; Advisor makes every Apply button read-only — it shows the exact command and steps aside.' },
    { k: 'Why does it matter?', t: 'Some machines want eyes-only — work laptops, shared rigs, cautious first weeks. The right choice should be easy in both directions.' },
    { k: 'How does it help me?', t: 'Planned. Today the switch is a preview — it changes nothing, and says so.' },
  ],
};

function trustRow({ name, info, coming, status, value }) {
  return el('div', { class: `trust-row${coming ? ' is-coming' : ''}` },
    el('span', { class: 'trust-name' }, name, infoBtn(name, info)),
    el('div', { class: 'trust-val' }, ...value),
    el('span', { class: 'trust-status' }, status));
}

function renderTrust(t) {
  const body = $('#body-trust');
  const rel = t.release || {};
  const ch = t.channel || {};
  const sb = t.sbom || {};
  const liveCount = (rel.ok ? 1 : 0) + (sb.present ? 1 : 0);

  setChips('chips-trust', [
    rel.ok ? chip('sha256 published ✓', 'green', 'The release bundle’s fingerprint is published and was read live this session')
           : chip('digest unreachable', 'warn', 'Couldn’t read the published digest this session'),
    sb.present ? chip(`SBOM · ${sb.componentCount} component${sb.componentCount === 1 ? '' : 's'} ✓`, 'green', 'A local CycloneDX SBOM was found and read live this session')
                : chip('SBOM — v3.3', 'coming', 'A CycloneDX SBOM ships with every release from v3.3'),
    ch.installed ? chip(ch.channel === 'pinned' ? 'pinned' : 'latest channel', 'cyan') : chip('no plugin install', 'grey'),
  ]);

  const rows = [];

  /* 1 · bundle signature — the one REAL measurement today */
  rows.push(trustRow({
    name: 'Bundle signature', info: TRUST_INFO.signature,
    status: rel.ok ? chip('published ✓', 'green') : chip('unreachable', 'warn'),
    value: rel.ok ? [
      el('p', {}, 'Latest release ', el('b', {}, rel.tag || '—'),
        rel.asset ? el('span', {}, ' · ', el('span', { class: 'cell-mono' }, rel.asset)) : '',
        rel.publishedAt ? ` · published ${fmtDate(rel.publishedAt)}` : ''),
      el('code', { class: 'trust-hash', title: 'sha256 of the release bundle, as published' }, rel.sha256 || ''),
      el('p', {}, 'Check your download against it: ', el('code', {}, 'shasum -a 256 ruvnet-brain.zip'),
        ' — the 64 characters must match exactly.'),
      rel.sig ? el('p', {}, 'A detached signature (', el('span', { class: 'cell-mono' }, '.sig'),
        ') ships alongside — one-click signature verification is planned right here.') : null,
      el('span', { class: 'trust-src' }, 'read live · ', rel.source || 'github.com — latest release'),
    ] : [
      el('p', {}, 'Couldn’t reach GitHub this session', rel.error ? el('span', {}, ' (', el('span', { class: 'cell-mono' }, rel.error), ')') : '',
        ' — nothing is shown that wasn’t read. The digest is published on the latest release.'),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { trustSkeleton(); loadTrust(); } }, 'Try again'),
    ],
  }));

  /* 2 · SBOM — real once `npm run sbom` has been run locally; honest empty state until then */
  rows.push(trustRow({
    name: 'SBOM', info: TRUST_INFO.sbom, coming: !sb.present,
    status: sb.present ? chip(`${sb.componentCount} component${sb.componentCount === 1 ? '' : 's'}`, 'green') : chip('coming · v3.3', 'coming'),
    value: sb.present ? [
      el('p', {}, 'A ', el('b', {}, `CycloneDX ${sb.specVersion || ''}`.trim()), ' SBOM exists on this machine: ',
        el('b', {}, `${sb.componentCount} component${sb.componentCount === 1 ? '' : 's'}`),
        sb.mainComponent ? ` for ${sb.mainComponent}${sb.mainVersion ? `@${sb.mainVersion}` : ''}` : '',
        sb.generatedAt ? ` · generated ${fmtDate(sb.generatedAt)}` : ''),
      el('p', {}, 'This is the production dependency tree only (', el('code', {}, '--omit dev'),
        ') — the plugin and installer ship no other packages. Regenerate any time: ', el('code', {}, 'npm run sbom')),
      el('span', { class: 'trust-src' }, sb.path || 'sbom/ruvnet-brain.cdx.json'),
    ] : [
      el('p', {}, sb.error
        ? `Found sbom/ruvnet-brain.cdx.json but couldn’t read it (${sb.error}).`
        : 'Not generated yet on this machine — nothing to show, so nothing is shown.'),
      el('p', {}, 'Run ', el('code', {}, 'npm run sbom'),
        ' to produce a CycloneDX SBOM of the shipped dependency tree right now. From ', el('b', {}, 'v3.3'),
        ' every published release carries one too, measured from the release asset itself.'),
    ],
  }));

  /* 3 · install channel — read from the plugin cache on disk */
  rows.push(trustRow({
    name: 'Install channel', info: TRUST_INFO.channel,
    status: ch.installed ? chip(ch.channel === 'pinned' ? 'pinned' : 'latest', 'cyan') : chip('not found', 'grey'),
    value: ch.installed ? [
      el('p', {}, el('b', {}, ch.channel === 'pinned' ? 'Pinned' : 'Latest'),
        ch.channel === 'pinned'
          ? ' — held at a version you chose.'
          : ' — auto-updates from GitHub, so you ride each release as it ships.'),
      el('p', {}, 'On disk right now: ', el('b', {}, `v${ch.version || '?'}`),
        ch.lastUpdated ? ` · updated ${fmtDate(ch.lastUpdated)}` : ''),
      el('span', { class: 'trust-src' }, ch.cacheDir || ''),
      ch.channel !== 'pinned' ? el('p', { style: 'margin-top:6px' },
        'Prefer to hold a known-good release? ', el('b', {}, 'Version pinning is planned'),
        ' — you’ll choose it right here.') : null,
    ] : [
      el('p', {}, 'No plugin-cache install found on this machine — you may be running from a repo checkout. ',
        'This row reads ', el('span', { class: 'cell-mono' }, '~/.claude/plugins'), ', never guesses.'),
    ],
  }));

  /* 4 · advisor mode — display-only preview, clearly labeled */
  const advNote = el('p', { class: 'adv-note' },
    'Full is on: every change stays consent-gated, with its undo recorded first. The switch itself is planned — today it’s a preview and changes nothing.');
  const advisorBtn = el('button', {
    class: 'adv-opt', type: 'button',
    title: 'Preview — Advisor Mode is planned; clicking changes nothing today',
    onclick: () => {
      advNote.textContent = 'Advisor Mode is planned — nothing changed just now. When it lands, this switch makes every Apply button read-only: the console shows the exact command and steps aside.';
    },
  }, el('span', { class: 'pc-dot', 'aria-hidden': 'true' }), 'Advisor — read-only');
  rows.push(trustRow({
    name: 'Advisor Mode', info: TRUST_INFO.advisor,
    status: chip('preview', 'coming'),
    value: [
      el('div', { class: 'adv-seg' },
        el('button', { class: 'adv-opt on', type: 'button', title: 'Your current behavior — consent-gated changes with undo' },
          el('span', { class: 'pc-dot', 'aria-hidden': 'true' }), 'Full — recommended'),
        advisorBtn,
        el('span', { class: 'preview-tag' }, 'preview · v3.3')),
      advNote,
    ],
  }));

  body.replaceChildren(
    el('p', { class: 'lead-stat' },
      'Provenance you can check, not take on faith — ', el('b', {}, String(liveCount)),
      ` measurement${liveCount === 1 ? ' is' : 's are'} live today; the rest of this card names exactly what v3.3 will measure.`,
      infoBtn('Trust & provenance', TRUST_CARD_INFO)),
    el('div', { class: 'trust-list', 'data-trust-ready': '1' }, ...rows),
  );
}

function trustSkeleton() {
  $('#body-trust').replaceChildren(
    frag('<div class="skeleton" aria-hidden="true"><div class="sk-bar w45"></div><div class="sk-bar w70"></div></div>'),
    el('p', { class: 'loading-note' },
      'Reading the published release fingerprint from GitHub (read-only metadata — the one network touch this card makes) and your plugin cache on disk.'));
  setChips('chips-trust', [chip('checking…', 'wait')]);
}

/* ---------------------------------------------- header update gong (owner, 2026-07-24) */

let BRAIN_INSTALLED_VERSION = null; // set by renderHost from /api/state's host.brainVersion

// Numeric x.y.z only; -dev/-rc suffixes are deliberately ignored so a tie is NEVER "newer" —
// a false gong is the nag this page promises not to be. Latest unreachable (null) is UNKNOWN,
// never "update available" (same rule the trust section already lives by).
function cmpVer(a, b) {
  const num = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = num(a); const pb = num(b);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// An update has no verified undo, so per the intro contract the gong is INSTRUCTIONS, not a
// switch: one click copies the exact command and says so — nothing runs behind your back.
function renderUpdateGong(t) {
  const btn = $('#brain-update');
  if (!btn) return;
  const latest = t && t.release && t.release.tag ? String(t.release.tag).replace(/^v/, '') : null;
  if (!BRAIN_INSTALLED_VERSION || !latest || cmpVer(latest, BRAIN_INSTALLED_VERSION) <= 0) { btn.hidden = true; return; }
  const cmd = 'npx ruvnet-brain --update';
  btn.textContent = `⟳ update available · v${latest} — click to update`;
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(cmd); btn.textContent = `copied — paste in any terminal: ${cmd}`; }
    catch { btn.textContent = `run in any terminal: ${cmd}`; }
  };
  btn.hidden = false;
}

async function loadTrust() {
  try {
    const t = await getJSON('/api/trust');
    renderTrust(t);
    renderUpdateGong(t);
  } catch (err) {
    setChips('chips-trust', [chip('unavailable', 'grey')]);
    inlineError('body-trust', String(err.message || err), () => { trustSkeleton(); loadTrust(); });
  }
}

/* ═════════════════════════════════════════════════ freshness (owner directive 2026-07-26/27)
   THE PAGE CARRIES THE WAIT. The server never blocks: a cold or wrong-project read is answered
   instantly with `{warming:true}` while a detached child measures. That moves the whole burden of
   the wait here, to the only place that can carry it honestly — the visible page. So this block owns
   three promises, and each exists because its opposite was shipped and hurt someone:

     1. WARMING IS NARRATED, NEVER RENDERED AS EMPTY. A warming answer has no sections. Painting it
        would tell a first-time user "you have no hooks, no memory, nothing configured" about a
        machine nobody has looked at yet. Skeletons stay; the pill says what is happening.
     2. THE AGE IS ALWAYS ON SCREEN. "Is this current?" must be a label, not a feeling.
     3. ONE REFRESH STORY. One control (the header ↻ and this pill share one handler), one server
        job, one definition of done. The previous ↻ re-fetched three cache-first endpoints and
        announced "Re-check complete" — a placebo that measured nothing and said it had. */

let FRESH_BASE = null;      // measuredAt of what is currently painted; null until something lands
let freshPollTimer = null;
let freshPollsLeft = 0;

function freshnessPill() {
  let pill = document.getElementById('freshness-pill');
  if (!pill) {
    // A BUTTON, not a label: the age and the way to change it are the same affordance, so there is
    // no second refresh control to disagree with the first.
    pill = el('button', {
      id: 'freshness-pill', class: 'chip tone-grey', type: 'button',
      title: 'How old this picture of your machine is — click to measure it again now',
      onclick: () => { void doManualRefresh(); },
    }, '…');
    const anchor = $('#recheck-btn');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(pill, anchor);
  }
  return document.getElementById('freshness-pill');
}

function fmtAge(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.round(ms / 60000);
  if (ms < 45000) return 'seconds ago';
  if (m < 60) return `${Math.max(1, m)}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/* A DELIBERATELY EXPIRED STAMP IS NOT AN AGE (found by looking at the rendered page, 2026-07-27).
   The server withdraws a claim by BACK-DATING it to the epoch — expire, never delete — and every
   write-path invalidation does it: /api/refresh on all four caches, setLesson on capabilities,
   publishBrainPowerToCache on the state cache. Flipping the brain switch and looking at the header
   produced, verbatim: "as of 495868h ago". That is a fabricated number on a user-facing surface,
   about the freshness of the very thing this pill exists to be honest about. An epoch stamp means
   "this reading was withdrawn on purpose"; a stamp we cannot parse means we do not know. Neither is
   a duration, and neither may be printed as one. Pure so the test can run the shipped rule. */
function stampWithdrawn(at) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return true;
  const age = Date.now() - t;
  // A couple of minutes of negative age is clock skew between the stamp and this tab, and fmtAge
  // renders it as "just now". A year old, or genuinely from the future, is not an age at all.
  return !(age >= -120_000 && age < 365 * 24 * 60 * 60 * 1000);
}

/* One pill, five honest states: warming (nothing measured yet), withdrawn (a reading was expired on
   purpose), re-measuring (one is on its way), just-landed, and plain age. `warming` never sets
   FRESH_BASE — there is no measurement to base anything on, and pretending otherwise would make the
   next real one look like a repeat. */
function renderFreshness(state, { polling = false, justLanded = false } = {}) {
  const pill = freshnessPill();
  if (!pill) return;
  if (state && state.warming) {
    pill.className = 'chip tone-wait';
    pill.textContent = 'measuring your machine… ~20s';
    return;
  }
  const at = state && (state.measuredAt || state.cachedAt || state.generatedAt);
  if (at) FRESH_BASE = at;
  if (justLanded) {
    pill.className = 'chip tone-green';
    pill.textContent = 'measured just now';
    return;
  }
  if (!at || stampWithdrawn(at)) {
    pill.className = polling ? 'chip tone-cyan' : 'chip tone-warn';
    pill.textContent = polling ? 're-measuring your machine…' : 'this reading was cleared — click to measure again';
    return;
  }
  pill.className = polling ? 'chip tone-cyan' : (state && state.stale ? 'chip tone-warn' : 'chip tone-grey');
  pill.textContent = `as of ${fmtAge(at)}${polling ? ' · re-measuring…' : ''}`;
}

/* THE POLLER'S ONE RULE — pure, and named so it can be tested without a browser (see
   tests/unit/console-freshness-poller.test.mjs, which lifts this exact source and runs it).

   Repaint only on a STRICTLY NEWER, SETTLED measurement. Every clause is a bug that shipped:
     • `!st.sections` — a warming answer has none; painting it empties the page.
     • `st.stale !== false` — /api/refresh back-dates the stamp to the epoch ON PURPOSE (expire, do
       not delete). The first poller compared `at !== FRESH_BASE`, so it read that withdrawal as an
       arrival: it would have painted the deliberately-withdrawn claim and then gone green.
     • strictly newer — a stamp that merely CHANGED can be older. Time only moves one way here. */
function freshLanded(st, base) {
  if (!st || st.warming || st.stale !== false || !st.sections) return false;
  const at = st.measuredAt || st.cachedAt || st.generatedAt;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  if (!base) return true;              // nothing painted yet — the first settled answer IS the news
  const b = Date.parse(base);
  return !Number.isFinite(b) || t > b;
}

function startFreshnessPolling() {
  if (freshPollTimer) return;         // one poller, ever
  freshPollsLeft = 60;                // 60 x 3s = 3 minutes, then give up ALOUD (never silently)
  renderFreshness({ warming: !FRESH_BASE, measuredAt: FRESH_BASE, stale: true }, { polling: !!FRESH_BASE });
  freshPollTimer = setInterval(async () => {
    if (--freshPollsLeft <= 0) {
      clearInterval(freshPollTimer); freshPollTimer = null;
      // A poller that quits in silence leaves a "measuring…" pill sitting there forever, which reads
      // as "still working" — the exact dead air this whole change exists to end.
      const p = freshnessPill();
      if (p) { p.className = 'chip tone-warn'; p.textContent = 'still measuring — click to try again'; }
      announce('The background measurement has not landed yet. Click the freshness chip to try again.');
      return;
    }
    try {
      const st = await getJSON('/api/state?fast=1');
      if (freshLanded(st, FRESH_BASE)) {
        clearInterval(freshPollTimer); freshPollTimer = null;
        FRESH_BASE = st.measuredAt || st.cachedAt || st.generatedAt;
        // ONE painter — the same loadState() the first paint uses, so a polled repaint can never
        // drift from an initial one. It also refreshes preStateHash and the recommendations, which a
        // sections-only repaint silently left pointing at the pre-measurement machine.
        await loadState({ landed: true });
        // The other cards measure on their own clocks (stack, capabilities, fleet). Re-ask them here
        // rather than letting the page claim page-wide freshness on the strength of state alone.
        void loadStack();
        void loadCapabilities();
        announce('Your machine has been re-measured — the cards now show the new reading.');
      } else {
        renderFreshness(st, { polling: true });
      }
    } catch { /* transient — the next tick tries again */ }
  }, 3000);
}

/* THE refresh. Expires all four caches server-side (scope-preservingly), force-kicks the measuring
   child past its debounce, then watches for the result. `started:false` is reported as such — a
   refresh that did not start must never render as one that did. */
async function doManualRefresh() {
  const pill = freshnessPill();
  if (pill) { pill.className = 'chip tone-cyan'; pill.textContent = 're-measuring…'; }
  setChips('chips-stack', [chip('re-measuring…', 'wait')]);
  setChips('chips-capabilities', [chip('re-measuring…', 'wait')]);
  announce('Re-measuring your machine. Each card updates as its own measurement lands.');
  const r = await postJSON('/api/refresh', {});
  const body = (r && r.data) || {};
  if (!r || !r.ok || !body.ok) {
    if (pill) { pill.className = 'chip tone-warn'; pill.textContent = 'refresh failed — click to try again'; }
    announce('The refresh could not be started.');
    return;
  }
  if (body.started === false && pill) {
    // Honest, and not an error: a measurement was already running, so this click joined it instead
    // of starting a second full scan of the same machine.
    pill.className = 'chip tone-cyan';
    pill.textContent = 'a measurement is already running…';
  }
  if (freshPollTimer) { clearInterval(freshPollTimer); freshPollTimer = null; }
  startFreshnessPolling();
}

/* ------------------------------------------------------------------ loaders */

/* ONE fetch, ONE painter (2026-07-26). This used to request /api/state TWICE — once with `?fast=1`
   for an instant cache paint, then again for "the live gather". The server strips the query string
   before routing, so both calls hit the identical cache-first handler: the second was a duplicate
   that painted the same bytes twice and cost a round-trip on every open. There is now one call, and
   the "live" reading arrives the only way it can without freezing the server — from the detached
   child, via the freshness poller. */
async function loadState({ landed = false } = {}) {
  try {
    const state = await getJSON('/api/state');
    $('#global-error').hidden = true;

    // WARMING: NOTHING HAS BEEN MEASURED FOR THIS PROJECT YET. Paint NOTHING. Every render* below
    // would turn a missing section into a positive claim — renderWiring(undefined) prints "No wiring
    // data received", renderGates(undefined) prints "No gate data received" — which is a page-wide
    // "your machine is empty" shown to someone whose machine simply has not been looked at yet. The
    // skeletons already on the page are the honest picture; the pill narrates the wait.
    if (state.warming) {
      renderFreshness(state);
      startFreshnessPolling();
      return;
    }

    preStateHash = state.preStateHash ?? state.generatedAt ?? null;
    renderHost(state.host, state.generatedAt);
    const s = state.sections || {};
    renderBrainPower(s.brainPower);
    renderWiring(s.wiring);
    lastMemory = s.memory;
    renderMemory(s.memory);
    renderSavings(s.savings);
    renderSettings(s.config, s.userSettings, s.brainPower);
    renderGates(s.gates);
    addRecommendations(s.recommendations, 'state');
    recsSettled('state', true);
    dismissStandby(); // first cards are hydrated — the standby line has done its job
    renderFreshness(state, { justLanded: landed });
    // Chase the next measurement only when this one is actually OLD. Chasing a fresh reading would
    // never terminate: every warm serve kicks a background refresh, whose result is strictly newer,
    // which would repaint and kick again, forever.
    if (state.stale && !landed) startFreshnessPolling();
    void loadMemoryFleet(); // 100+ stores at ~90ms each — lands after the page is already usable
  } catch (err) {
    dismissStandby(); // don't say "stand by" over an error banner
    showGlobalError(err);
    const retry = () => loadState();
    inlineError('body-wiring', String(err.message || err), retry);
    inlineError('body-memory', String(err.message || err), retry);
    inlineError('body-savings', String(err.message || err), retry);
    inlineError('body-settings', String(err.message || err), retry);
    for (const id of ['chips-wiring', 'chips-memory', 'chips-savings', 'chips-settings']) {
      setChips(id, [chip('unavailable', 'grey')]);
    }
    recsSettled('state', false);
  }
}

// The across-your-projects fleet list opens every memory store on the machine. It is the single
// slowest thing the console does, so it is fetched on its own and merged into the memory card once
// it lands — the health score and everything else are already on screen by then.
/* ------------------------------------------------- what caught Claude (the gates + their receipts) */

// The verdict is the headline, never the inventory. "21 hooks are configured" is a census; "6 of them
// can stop a tool call, and here is what they stopped" is the point. An empty ledger says so plainly —
// it is the one number on this page that must never be guessed, because the whole claim rests on it.
function renderGates(g) {
  const body = $('#body-gates');
  if (!g || !g.summary) {
    setChips('chips-gates', [chip('no data', 'grey')]);
    body.replaceChildren(el('p', { class: 'muted' }, 'No gate data received.'));
    return;
  }
  const s = g.summary;
  const caught = s.caughtTotal || 0;
  setChips('chips-gates', [
    chip(`${s.blocking} can block`, caught ? 'green' : 'cyan'),
    chip(caught ? `${caught} caught` : 'nothing caught yet', caught ? 'green' : 'grey'),
  ]);

  const main = [];
  // The three numbers are now in one unit (wired entries), so this sentence adds up. It previously
  // mixed a deduplicated count with a raw one and lost a gate per duplicate wiring — see the note in
  // scripts/gates.mjs. Duplicates are now STATED rather than absorbed: a gate wired twice really does
  // run twice, which is a thing the reader would want to know and fix, not a rounding detail.
  const dupes = Array.isArray(s.duplicated) ? s.duplicated : [];
  main.push(el('p', { class: 'lead-stat' },
    'Every move your AI makes here is read first. ', el('b', {}, String(s.armed)),
    ' gates are armed — ', el('b', {}, String(s.blocking)),
    ' of them can stop a tool call before it touches your machine. The other ',
    el('b', {}, String(s.advisory)), ' add context without ever blocking.',
    Number.isFinite(s.blockingDistinct) && s.blockingDistinct !== s.blocking
      ? ` Those ${s.blocking} blocking entries are ${s.blockingDistinct} distinct gates — some are wired more than once.`
      : '',
    dupes.length
      ? el('span', { class: 'muted' }, ` Wired twice, so it runs twice: ${dupes.join(', ')}.`)
      : '',
    infoBtn('What caught Claude', GATES_INFO)));

  if (caught) {
    // Deliberately NOT the .wire-lane grid: its fixed columns are sized for (count, label, meaning)
    // and fling a gate name and its subject to opposite sides of a dead gap. A catch is a sentence —
    // who stopped what, and why — so it reads as one.
    // COLLAPSE IDENTICAL CATCHES — collapse, never hide.
    //
    // Measured 2026-07-24: of twelve rows, SIX were the same sentence ("design-wall — deliberate
    // override, wall skipped"). The card meant to show that the guardrails work instead read as a
    // log of one guardrail being walked past, six times, because repetition is what the eye counts.
    // Twelve near-identical amber rows is also simply unreadable.
    //
    // Grouping by (gate, reason) keeps every catch represented and every count exact — "× 6" states
    // the repetition plainly rather than letting six rows imply six different events. The most recent
    // timestamp is kept because "when did this last happen" is the actionable half. Fable 5, 2026-07-24.
    const groups = new Map();
    for (const c of g.catches) {
      const key = `${c.gate || 'gate'} ${c.subject || ''} ${c.reason || ''}`;
      const prev = groups.get(key);
      if (prev) { prev.n += 1; if (c.at && (!prev.at || Date.parse(c.at) > Date.parse(prev.at))) prev.at = c.at; }
      else groups.set(key, { ...c, n: 1 });
    }
    main.push(el('ul', { class: 'gate-catches' },
      ...[...groups.values()].map((c) => el('li', {},
        el('b', {}, c.gate || 'gate'),
        ' stopped ', el('b', {}, c.subject || 'a call'),
        c.n > 1 ? el('b', { class: 'catch-n' }, ` × ${c.n}`) : '',
        ' — ', el('span', { class: 'cell-dim' }, c.reason || ''),
        c.at ? el('span', { class: 'cell-dim' },
          (c.n > 1 ? ' · most recent ' : ' · ') + new Date(c.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) : ''))));
  } else {
    // Honest empty state. The gates only started writing receipts on 2026-07-17; saying "0 blocks"
    // as though it were a measured safety record would be a lie of omission.
    main.push(el('p', { class: 'cell-dim' },
      'Nothing caught yet. The gates began recording every refusal on 17 Jul — from here on, each ',
      'time one stops your AI, the reason lands on this card. Silence here means silence, not proof.'));
  }

  if (Array.isArray(s.duplicated) && s.duplicated.length) {
    main.push(el('p', { class: 'cell-dim' },
      '⚠ ', el('b', {}, s.duplicated.join(', ')),
      s.duplicated.length > 1 ? ' are wired twice' : ' is wired twice',
      ' — once machine-wide and once by the plugin, so they run twice on every matching call. ',
      'Harmless, but it is duplicated work.'));
  }
  body.replaceChildren(...main);
}

/* Re-ask an endpoint that answered `warming`, on the same 3s cadence as the freshness poller and
   with the same 3-minute ceiling. Shared by the two cards that load independently of /api/state, so
   there is one retry cadence on this page rather than three that drift. */
const WARM_RETRY_MS = 3000;
const WARM_RETRY_MAX = 60;

async function loadMemoryFleet(attempt = 0) {
  try {
    const m = await getJSON('/api/memory');
    if (m && m.warming) {
      // The fleet scan is the slowest thing the console does. Until it lands, the memory card keeps
      // whatever /api/state already gave it and simply does not claim a fleet — it must never render
      // "0 projects", which on this card would read as "nothing on your machine learns anything".
      if (attempt < WARM_RETRY_MAX) setTimeout(() => { void loadMemoryFleet(attempt + 1); }, WARM_RETRY_MS);
      else recsSettled('health', false);   // gave up: say so, never let silence read as an all-clear
      return;
    }
    if (m && Array.isArray(m.fleet) && lastMemory) {
      lastMemory = { ...lastMemory, fleet: m.fleet };
      renderMemory(lastMemory);
    }
    // ADR-027: the brain advocates rather than waiting to be asked. These are the recommendations
    // derived from what the fleet scan just SAW — a corrupt index, a starving learner, stores full
    // of memories that have never been distilled into anything reusable. They were built and
    // schema-gated for a full day before anything rendered them.
    if (m && Array.isArray(m.recommendations)) addRecommendations(m.recommendations, 'health');
    recsSettled('health', true);
  } catch {
    // An advocacy failure must be VISIBLE as a failure, never as an all-clear.
    recsSettled('health', false);
  }
}

/* ONE fetch, same reason as loadState: `?fast=1` and the bare URL route to the identical cache-first
   handler (the server strips the query string), so the old two-call sequence painted the same bytes
   twice. The stack audit is the endpoint that answered COLD in 23.6 SECONDS on the request path
   before the instant-open fix; it is now measured only in the detached child. */
async function loadStack(attempt = 0) {
  try {
    const stack = await getJSON('/api/stack');
    if (stack && stack.warming) {
      setChips('chips-stack', [chip('auditing your stack…', 'wait')]);
      if (attempt < WARM_RETRY_MAX) setTimeout(() => { void loadStack(attempt + 1); }, WARM_RETRY_MS);
      else { setChips('chips-stack', [chip('audit is taking unusually long', 'warn')]); recsSettled('stack', false); }
      return;   // skeleton stays: an empty package list would read as "nothing is installed"
    }
    renderStack(stack);
    addRecommendations(stack.recommendations, 'stack');
    recsSettled('stack', true);
  } catch (err) {
    if (stackTicker) { clearInterval(stackTicker); stackTicker = null; }
    setChips('chips-stack', [chip('couldn’t audit', 'grey')]);
    inlineError('body-stack', String(err.message || err), () => { stackSkeleton(); loadStack(); });
    recsSettled('stack', false);
  }
}

/* ------------------------------------------------------------------- mock ---
   Development-only fixtures matching console/CONTRACT.md exactly.
   Active ONLY with ?mock=1 in the URL — never the default. */

const MOCK_STATE = {
  token: 'mock', generatedAt: new Date().toISOString(),
  preStateHash: 'mock-hash-1',
  host: { user: 'stuartkerr', platform: 'darwin', node: 'v22.14.0', npmPrefix: '~/.npm-global' },
  sections: {
    wiring: {
      summary: { npx: 190, global: 12, mcp: 6, plugin: 5, projectsWithNpx: 16 },
      sites: [
        { scope: 'project', project: 'ruvnet-brain', file: '.claude/settings.json', event: 'PreToolUse', matcher: 'Bash', spec: 'npx @claude-flow/cli@latest hooks pre-command', mechanism: 'NPX' },
        { scope: 'project', project: 'ruvnet-brain', file: '.claude/settings.json', event: 'PostToolUse', matcher: 'Write|Edit', spec: 'npx @claude-flow/cli@latest hooks post-edit', mechanism: 'NPX' },
        { scope: 'project', project: 'PowerPlatePulse', file: '.claude/settings.json', event: 'PreToolUse', matcher: 'Bash', spec: 'npx claude-flow@alpha hooks pre-command', mechanism: 'NPX' },
        { scope: 'global', file: '~/.claude/settings.json', event: 'SessionStart', matcher: '.*', spec: '~/.npm-global/bin/ruflo hooks session-start', mechanism: 'GLOBAL_BINARY' },
      ],
    },
    memory: {
      fleet: [
        { name: 'ruvnet-brain', total: 1023, embedded: 1021, coverPct: 99.8, patterns: 456, learns: true, findings: [] },
        { name: 'PowerPlatePulse', total: 214, embedded: 214, coverPct: 100, patterns: 88, learns: true, findings: ['no checkpoint yet'] },
      ],
      health: {
        project: 'ruvnet-brain', score: 92, summary: 'learns; recall-quality not probed',
        dimensions: [
          { key: 'liveness', label: 'Liveness', status: 'ok', detail: 'store→search round-trip works on the live path', deduction: 0 },
          { key: 'coverage', label: 'Coverage', status: 'ok', detail: 'checkpoint present, <1d old', deduction: 0 },
          { key: 'recallQuality', label: 'Recall quality', status: 'notTested', detail: 'no embedding round-trip run this session', deduction: 0 },
          { key: 'compactionSurvival', label: 'Compaction survival', status: 'warn', detail: 'last PreCompact snapshot is 9 days old', deduction: 8 },
          { key: 'sessionSurfacing', label: 'Session surfacing', status: 'ok', detail: 'SessionStart hook surfaces state', deduction: 0 },
        ],
        notTested: ['recallQuality'],
      },
    },
    savings: {
      totals: { count: 3, usdSaved: 0.42, msSaved: 18400 },
      note: 'receipts only — no modelled or projected savings',
      utilization: {
        frontierModel: 'claude-fable-5', tasks: 3, unpriced: 0,
        realizedUsd: 0.24, frontierUsd: 1.10, costOptimalitySaved: 0.86, pctSaved: 78,
        distribution: [
          { band: 'mechanical', label: 'Mechanical', tasks: 0, pctOfTasks: 0, realizedUsd: 0, frontierUsd: 0, savedUsd: 0, models: [] },
          { band: 'cheap', label: 'Cheap', tasks: 2, pctOfTasks: 67, realizedUsd: 0.05, frontierUsd: 0.50, savedUsd: 0.45, models: [{ model: 'claude-haiku-4.5', tasks: 2 }] },
          { band: 'mid', label: 'Mid', tasks: 1, pctOfTasks: 33, realizedUsd: 0.19, frontierUsd: 0.60, savedUsd: 0.41, models: [{ model: 'claude-sonnet-5', tasks: 1 }] },
          { band: 'frontier', label: 'Frontier', tasks: 0, pctOfTasks: 0, realizedUsd: 0, frontierUsd: 0, savedUsd: 0, models: [] },
        ],
        note: 'Offline demo — the live console recomputes this from your real receipts.',
      },
      receipts: [
        { at: '2026-07-13T14:20:00Z', capability: 'model-routing', task: 'changelog summarization', chosenTier: 'claude-haiku-4.5', baselineTier: 'claude-fable-5', measuredMs: 4200, measuredUsd: 0.14 },
        { at: '2026-07-13T15:02:00Z', capability: 'model-routing', task: 'commit message drafts', chosenTier: 'claude-haiku-4.5', baselineTier: 'claude-sonnet-5', measuredMs: 6100, measuredUsd: 0.09 },
        { at: '2026-07-14T09:41:00Z', capability: 'agentic-qe', task: 'regression triage', chosenTier: 'claude-sonnet-5', baselineTier: 'claude-fable-5', measuredMs: 8100, measuredUsd: 0.19 },
      ],
    },
    config: {
      path: '~/.claude/ruvnet-brain/config.json', exists: true,
      values: { openrouterKey: true, nightly: true, routing: 'auto', qeFleet: false },
      schema: [
        { key: 'openrouterKey', label: 'OpenRouter API key', type: 'secret', help: 'Unlocks cheap-model routing + the self-improvement loop', secret: true },
        { key: 'nightly', label: 'Nightly brain refresh', type: 'bool', help: 'Rebuild the KB from pinned SHAs overnight' },
        { key: 'routing', label: 'Token-smart routing', type: 'enum', options: ['auto', 'off'], help: 'Route cheap tasks to smaller models' },
        { key: 'qeFleet', label: 'On-demand QE fleet', type: 'bool', help: 'Agentic-QE test fleet, spun up on request' },
      ],
    },
    recommendations: [
      {
        id: 'save-preferences', title: 'Remember that you keep npx in helix-experiments on purpose',
        rationale: 'You told us this once — recording it stops us re-suggesting it forever.',
        severity: 'INFO', touchesMachine: false,
        evidence: [{ observed: '12 npx sites in helix-experiments marked "intentional" on 2026-07-10', source: 'operator-profile statedPreferences' }],
        cost: { time: '~0s', latency: 'none', usd: 0, risk: 'low' },
        change: { kind: 'write-config', human: 'record the preference in your RuvNet-Brain settings file' },
        undo: { kind: 'restore-file', human: 'the previous settings file is backed up and restorable' },
      },
    ],
  },
};

const MOCK_STACK = {
  packages: [
    { name: 'ruflo', installed: '3.30.2', target: '3.30.2', tag: 'alpha', state: 'CURRENT' },
    { name: '@ruvector/rvf', installed: '0.2.3', target: '0.2.3', tag: 'latest', state: 'CURRENT' },
    { name: 'agentic-flow', installed: '1.9.1', target: '1.8.4', tag: 'latest', state: 'AHEAD' },
    { name: '@ruvector/edge-net', installed: null, target: '0.4.0', tag: 'latest', state: 'BROKEN' },
    { name: 'agentdb', installed: '3.0.0-alpha.17', target: '3.0.0-alpha.19', tag: 'alpha', state: 'BEHIND' },
    { name: 'qudag-cli', installed: '0.7.2', target: null, tag: 'latest', state: 'UNRESOLVED' },
  ],
  shadows: [
    { name: '@ruvector/rvf', version: '0.1.9', global: '0.2.3', dir: '~/.npm/_npx/a1b2c3d4e5f6/node_modules/@ruvector/rvf', stale: true },
    { name: 'claude-flow', version: '2.7.0', global: '2.7.0', dir: '~/.npm/_npx/f6e5d4c3b2a1/node_modules/claude-flow', stale: false },
  ],
  summary: { total: 6, behind: 1, broken: 1, ahead: 1, current: 2, shadows: 2, stale: 1 },
  recommendations: [
    {
      id: 'sync-stack', title: 'Sync 1 stale shadow of @ruvector/rvf',
      rationale: 'A second copy in the npx cache preempts your global binary and quietly serves 0.1.9.',
      severity: 'IMPORTANT', touchesMachine: true,
      plainImpact: 'This removes an extra, out-of-date copy of a tool sitting in a temporary folder on your computer. Your main copy is newer and stays untouched. Nothing you use will stop working — the temporary copy rebuilds itself automatically the next time it’s needed. Fully reversible.',
      evidence: [{ observed: '@ruvector/rvf@0.1.9 in ~/.npm/_npx while global is 0.2.3', source: 'stack-sync findShadows' }],
      cost: { time: '~0s', latency: 'none', usd: 0, risk: 'low' },
      change: { kind: 'run-script', human: 'purge the stale npx shadow', cmd: 'node scripts/stack-sync.mjs --sync' },
      undo: { kind: 'restore-dir', human: 'npx re-resolves on next use; backup kept at <dir>.bak-<ts>' },
    },
  ],
};

/* Capability fixture — ?mock=1 ONLY, never a default. It exists so all FOUR states can be seen side
   by side while styling: the whole design claim is that "not checked" is visually unmistakable from
   "off" AND from "not installed", and that claim is unfalsifiable without every state on screen at
   once. Shapes match the contract exactly, including the [{ observed }] evidence records
   capability-audit.mjs emits and the {human, cmd} turnOn the registry ships.

   THE FIRST ROW USED TO CARRY A RETIRED LIE. Its evidence read "26 hooks are registered on this
   machine and 0 are enabled" — the exact false finding that was traced to a field-name bug in
   ruflo's table renderer and removed from every detector in this repo. Left in a fixture, it was
   still the reference image someone would style against, and the sentence a screenshot would show.
   A retired falsehood preserved as a design sample is how it gets reintroduced. */
const MOCK_CAPABILITIES = {
  rows: [
    {
      key: 'mock:cross-project-lessons', label: 'Cross-project lessons', state: 'OFF', scope: 'user',
      whatItBuysYou: 'A rule you have taught in three separate projects gets applied everywhere, instead of being re-taught project by project forever.',
      evidence: [{ observed: '4 processes you have taught in multiple separate projects are still trapped at project level' }],
      turnOn: { human: 'Promote the processes you have proven in several projects', cmd: 'node scripts/lesson-promote.mjs --apply' },
    },
    {
      key: 'mock:learning-hooks', label: 'Learning hooks', state: 'UNKNOWN', scope: 'machine',
      whatItBuysYou: 'Your AI writes down which approach actually worked and reuses it next time, instead of solving the same problem from scratch every session.',
      evidence: [{ observed: 'ruflo is installed, but whether its learning hooks are switched on cannot be read from it — its hook list is a static catalog, not a state readout' }],
      turnOn: null,
    },
    {
      key: 'mock:cheap-routing', label: 'Cheap-model routing', state: 'ABSENT', scope: 'machine',
      whatItBuysYou: 'Reading and summarising work runs on a model that costs a fraction of the top-tier one, and each run leaves a receipt showing what it saved.',
      evidence: [{ observed: 'agentic-flow is not installed and no routing receipts exist, so cheap routing has never been set up here' }],
      turnOn: { human: 'Route one read-only task through the cheap path', cmd: 'node scripts/route-cheap.mjs --task "<text>"' },
    },
    {
      key: 'mock:harness-champion', label: 'Harness champion policy', state: 'ON', scope: 'machine',
      whatItBuysYou: 'Runs your agents on the best-scoring policy found so far rather than the stock one.',
      evidence: [{ observed: 'a champion policy is active, applied 6 days ago' }],
      turnOn: null,
    },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* MOCK PARITY WITH THE FRESHNESS CONTRACT (RVBC-INSTANT-SPEC #7).
 *
 * The mock existed so the page could be styled without a server — and it silently stopped matching
 * the server the day cache-first serving landed: it answered `/api/state` with no `fromCache`, no
 * `measuredAt`, no `stale`, and it had no answer at all for `?fast=1` (the poller's URL) or for the
 * warming state. So the three states the freshness work exists to make visible — warming, stale,
 * just-landed — were the exact three a designer could not see. A fixture that cannot show the new
 * states is a fixture that guarantees they will be styled by guesswork.
 *
 * `?mock=1&state=warming|stale|fresh` picks the variant; the default is a stale warm serve, which is
 * what a real re-open looks like. The stamps are computed at call time so ages read believably. */
const MOCK_VARIANT = new URLSearchParams(location.search).get('state') || 'stale';

function mockState() {
  if (MOCK_VARIANT === 'warming') {
    return { warming: true, scope: '/Users/you/Code/your-project', kicked: true, fromCache: false, measuredAt: null, ageMs: null, stale: true };
  }
  const ageMs = MOCK_VARIANT === 'fresh' ? 4_000 : 46 * 60_000;   // fresh: seconds; stale: past the 15m ceiling
  const at = new Date(Date.now() - ageMs).toISOString();
  return { ...structuredClone(MOCK_STATE), generatedAt: at, fromCache: true, cachedAt: at, measuredAt: at, ageMs, stale: ageMs > 15 * 60_000 };
}

async function mockGet(url) {
  // The server routes on the path alone (it strips the query string), so the mock must too —
  // otherwise `?fast=1` throws "no mock" and the poller looks broken only in mock.
  const p = url.split('?')[0];
  if (p === '/api/state') { await sleep(250); return mockState(); }
  if (p === '/api/stack') { await sleep(2400); return structuredClone(MOCK_STACK); }
  if (p === '/api/memory') { await sleep(1200); return { fleet: MOCK_STATE.sections.memory.fleet, recommendations: [] }; }
  throw new Error(`no mock for ${url}`);
}

async function mockPost(url, body) {
  await sleep(850);
  if (url === '/api/refresh') return { status: 200, ok: true, data: { ok: true, refreshing: true, started: true } };
  if (url === '/api/save-brain-power') {
    return { status: 200, ok: true, data: { ok: true, off: !!(body.values || {}).off, log: 'mock: the switch moved and was read back from disk' } };
  }
  if (url === '/api/save-brain-profile') {
    return { status: 200, ok: true, data: { ok: true, profile: body.values?.brainProfile, bytesFreed: 640_000_000, log: 'mock: profile applied' } };
  }
  if (url === '/api/apply') {
    return { status: 200, ok: true, data: { results: (body.ids || []).map((id) => ({
      id, ok: true, undoToken: `undo-${id}`,
      log: `[stack-sync] backup: ~/.npm/_npx/a1b2c3d4e5f6 → ~/.npm/_npx/a1b2c3d4e5f6.bak-1752500000\n[stack-sync] purged stale shadow @ruvector/rvf@0.1.9\n[stack-sync] verified: global 0.2.3 now answers`,
    })) } };
  }
  if (url === '/api/save-config') {
    return { status: 200, ok: true, data: { ok: true, backup: '~/.claude/ruvnet-brain/config.json.bak-1752500000', undoToken: 'undo-config-1' } };
  }
  if (url === '/api/undo') return { status: 200, ok: true, data: { ok: true } };
  return { status: 404, ok: false, data: {} };
}

/* -------------------------------------------------------------------- init */

initTheme();
loadState();
loadStack();
loadTrust();
loadCapabilities();
$('#recheck-btn')?.addEventListener('click', () => recheckMachine());

// Stack card leads (Stuart 2026-07-16): expand immediately on a true first visit so newcomers
// watch it populate; afterwards only real drift opens it (renderStack). A manual toggle by the
// user wins over both — mark it so the auto-open never fights a deliberate collapse.
{
  const sc = $('#card-stack');
  if (sc) {
    sc.querySelector('summary')?.addEventListener('click', () => { sc.dataset.userToggled = '1'; });
    if (!localStorage.getItem('rvbc-seen')) sc.open = true;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   LESSONS — "what it's learned from you"

   THE GAP: sixteen lessons, thirteen of them the owner's own words, one enforcing at BLOCK level,
   all of them invisible on this page until now. Owner, 2026-07-24: "murky things in a .claude file
   nobody sees." A rule you cannot see is a rule you never consented to.

   ONE CONTROL, NOT TWO. The obvious design is a checkbox AND an ✕ ("turn off" vs "remove"). The
   store has exactly one off-switch — demote() — which is reversible and KEEPS the record of where
   the lesson was taught. Shipping two controls that call one function is the precise flavour of
   fake granularity that makes people close a settings page. So: one checkbox, and the row says
   plainly what off means.

   NOTHING IS ASSERTED. Every row's state is read from the store on load, and every write re-reads
   from disk and renders what actually changed. A toggle that reports success without re-reading is
   the failure user-settings.mjs exists to end.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const LESSON_ENF_TONE = { block: 'amber', checklist: 'cyan', review: 'grey' };

function lessonsSkeleton() {
  $('#body-lessons')?.replaceChildren(
    frag('<div class="skeleton" aria-hidden="true"><div class="sk-bar w45"></div><div class="sk-bar w85"></div></div>'));
  setChips('chips-lessons', [chip('checking…', 'wait')]);
}

/* Turn a lesson ON. Two store verbs can stand between a lesson and "in force": it may be demoted
   (user switched it off) and/or unratified (never agreed to). Clear whichever apply, in that order,
   and let each call verify itself — rather than inventing a compound verb the store does not have. */
/* postJSON returns {status, ok, data} where `ok` is the HTTP status — NOT the handler's verdict.
   Reading it directly meant a server-side refusal ({ok:false} sent with HTTP 200) rendered as
   success while the store never moved: the checkbox stays flipped, the note says it saved, and the
   rule is not actually off. That is the precise "every writer returned ok:true" failure this
   codebase already paid for once. This unwraps to the BODY and judges on the body's own verdict. */
async function setLessonCall(id, action) {
  const r = await postJSON('/api/set-lesson', { id, action });
  const body = (r && r.data) || {};
  if (!r || !r.ok) return { ok: false, log: r && r.status === 403 ? TOKEN_MSG : `the console returned ${r ? r.status : '?'}` };
  return body;
}

async function lessonOn(row) {
  let last = null;
  if (row.demoted) {
    last = await setLessonCall(row.id, 'restore');
    if (!last || !last.ok) return last;
  }
  if (!row.ratified) return setLessonCall(row.id, 'ratify');
  // Return the RESTORE's payload rather than a synthetic one. The first version discarded it and
  // fabricated `{ok, log}` with no `now`, so the row fell back to printing the raw lesson id —
  // internal jargon on the one line the user reads to find out what just happened.
  return last || { ok: true, now: { status: 'ratified', demoted: false } };
}

function renderLessons(data) {
  const body = $('#body-lessons');
  if (!body) return;

  if (!data || !data.ok) {
    setChips('chips-lessons', [chip('not checked', 'nt')]);
    body.replaceChildren(el('p', { class: 'loading-note' },
      data && data.error ? `Couldn't read the lesson store: ${data.error}` : 'Couldn’t read the lesson store.'));
    return;
  }

  const rows = data.lessons || [];
  const c = data.counts || {};

  if (!rows.length) {
    setChips('chips-lessons', [chip('nothing yet', 'grey')]);
    body.replaceChildren(el('p', { class: 'loading-note' },
      'No lessons recorded yet. When you correct me and that correction proves durable, it shows up here — ' +
      'with a switch, so you decide whether it stays.'));
    return;
  }

  const chips = [];
  if (c.awaitingYou) chips.push(chip(`${c.awaitingYou} awaiting you`, 'amber', 'Recorded, but not yet agreed to by you. Until you decide, it does not enforce at full strength.'));
  if (c.active) chips.push(chip(`${c.active} on`, 'green'));
  if (c.off) chips.push(chip(`${c.off} off`, 'grey', 'Switched off by you. The record of where you taught it is kept.'));
  if (c.quarantined) chips.push(chip(`${c.quarantined} imported`, 'nt', 'Maintainer or demonstration history. It is visible for audit but cannot become your personal policy.'));
  if (c.blocking) chips.push(chip(`${c.blocking} can stop me`, 'cyan', 'These interrupt me at their moment and I cannot continue until the check passes.'));
  setChips('chips-lessons', chips);

  const list = el('div', { class: 'cap-list' });

  for (const r of rows) {
    const isOn = r.ratified && !r.demoted;

    const box = el('input', {
      type: 'checkbox', class: 'lesson-switch', id: `lsw-${r.id}`,
      'aria-label': `${isOn ? 'Turn off' : 'Turn on'}: ${r.statement.slice(0, 60)}`,
      disabled: r.quarantined || null,
    });
    box.checked = isOn;

    const note = el('span', { class: 'form-note', role: 'status' });

    box.addEventListener('change', async () => {
      const want = box.checked;
      box.disabled = true;
      note.textContent = want ? 'turning on…' : 'turning off…';
      try {
        const res = want ? await lessonOn(r) : await setLessonCall(r.id, 'demote');
        if (!res || !res.ok) {
          box.checked = !want;                       // the store did not move; neither does the UI
          note.textContent = (res && res.log) || 'that didn’t save — nothing changed';
          note.className = 'form-note n-err';
          return;
        }
        note.className = 'form-note';
        // Report the state read back from DISK, not the state we asked for.
        // Plain words only. `res.now.status` is "ratified" — a word about our data model, not about
        // the user's day. It never reaches the page.
        note.textContent = res.now
          ? (res.now.demoted ? 'off — the record of where you taught it is kept' : 'on — in force from now on')
          : 'saved';
        announce(`${r.id} ${want ? 'turned on' : 'turned off'}.`);
        // RE-READ THE WHOLE CARD FROM THE SERVER.
        //
        // Before this, a successful toggle updated exactly two things — the checkbox and this note —
        // while the header counts ("13 on", "3 awaiting you"), the row's on/off styling, and above
        // all the PARTITION kept describing the previous world. Concretely: switch a rule off and it
        // stayed filed under "The N rules already in force". That is not a stale number; it is a
        // false sentence about the user's machine, printed by the card whose whole purpose is to
        // tell them the truth about it. Turning a candidate ON left it under "needs your decision" —
        // the decision they had just made.
        //
        // Re-fetching is deliberately unconditional and unclever: the server already computes every
        // derived field, so anything patched up here would be a second implementation of the same
        // logic, free to drift from it. Found by GPT-5.6-Sol, 2026-07-24.
        loadLessons();
      } catch (e) {
        box.checked = !want;
        note.textContent = `that didn’t save — ${String(e.message || e)}`;
        note.className = 'form-note n-err';
      } finally { box.disabled = false; }
    });

    const meta = [
      chip(r.enforcementLabel, LESSON_ENF_TONE[r.enforcement] || 'grey', r.enforcementDetail),
      chip(r.origin, r.userStated ? 'green' : 'nt',
        r.userStated
          ? 'You said this. Only lessons you stated yourself are allowed to reach the strongest level.'
          : r.quarantined
            ? 'This came from bundled maintainer or demonstration history. It is not your statement and cannot be turned into your personal policy.'
            : 'I inferred this from what happened. A lesson I inferred can never be raised to "Stops me", however often it fires — the model does not get to ratify its own rules.'),
      r.taughtCount ? chip(`taught ${r.taughtCount}×`, 'grey') : null,
      r.awaitingYou ? chip('awaiting your decision', 'amber', 'Recorded, but you have not agreed to it yet.') : null,
    ].filter(Boolean);

    const why = el('details', { class: 'cap-why' },
      el('summary', null, 'What is this, and why is it here?'),
      el('div', { class: 'cap-why-body' },
        el('p', null, r.statement),
        el('p', null, el('strong', null, 'When it fires: '), r.when, '.'),
        el('p', null, el('strong', null, `${r.enforcementLabel}: `), r.enforcementDetail),
        // `evidence` is an ARRAY of {observed} records, not a string. Rendering it directly printed
        // "[object Object]" — the exact defect that got ADR-045 rejected, caught here only because
        // the endpoint was hit with real data instead of being reasoned about.
        Array.isArray(r.evidence) && r.evidence.length
          ? el('div', null,
              el('p', null, el('strong', null, r.evidence.length > 1 ? 'What I observed: ' : 'What I observed: ')),
              el('ul', { class: 'cap-ev' }, ...r.evidence
                .map((e) => (e && typeof e === 'object' ? e.observed : e))
                .filter((t) => typeof t === 'string' && t.trim())
                .map((t) => el('li', null, t))))
          : null,
        r.projects && r.projects.length
          ? el('p', null, el('strong', null, 'Learned in: '), r.projects.join(', ')) : null,
        el('p', { class: 'muted' }, r.quarantined
          ? 'This imported record is quarantined for audit. It cannot be switched on or ratified as your policy.'
          : 'Turning this off hides the rule without deleting the record of where you taught it — you can switch it back on here at any time.')));

    list.append(el('div', { class: `cap-row lesson-row${r.demoted ? ' is-off' : ''}` },
      // NO `for=` here. The label WRAPS its checkbox, which is already an implicit association; a
      // `for` pointing at the contained input makes the browser activate it twice on one click, so
      // `change` fired an even number of times and the confirmation text was overwritten back to
      // empty. Caught by clicking it in a real browser — the DOM structure and the API were both
      // correct, and the endpoint returned a perfect payload the whole time.
      el('label', { class: 'cap-row-head' },
        box,
        el('span', { class: 'cap-row-title' }, r.statement),
      ),
      el('div', { class: 'chips' }, ...meta),
      el('p', { class: 'cap-row-when muted' }, r.when),
      why, note));
  }

  body.replaceChildren(
    el('p', { class: 'loading-note' },
      'These are the rules I now work by on this machine. You can switch any of them off — ',
      'nothing here is permanent, and off is reversible.',
      infoBtn('What it’s learned from you', LESSONS_INFO)),
    ...partitionLessons(list, rows));
}

/* Split the rows into "needs you" and "already settled", and fold the settled ones away.
 *
 * WHY: graded 78 on 2026-07-24 with the single largest deduction (-8) being that this card ran to
 * roughly 40% of the whole page — sixteen uncapped rows that a first-time visitor had to scroll past
 * before reaching anything else. The content was right and the SHAPE was wrong, which is a distinct
 * failure: a card that answers its question honestly can still bury the six cards beneath it.
 *
 * The split is not arbitrary trimming. Exactly one group is a question being put to the user
 * (candidates awaiting ratification); the rest is a reference list they may audit whenever they like.
 * Showing a question and a reference list at the same visual weight is what made it a wall. */
function partitionLessons(list, rows) {
  const kids = [...list.children];
  // THREE groups, not two. The first version split on `awaitingYou` alone and swept everything else
  // into "already in force" — so the moment a user switched a rule OFF, the page filed it under a
  // heading asserting it was ON. Not a stale count: a false sentence about their machine, printed by
  // the card whose job is to be the truth about it, and printed BECAUSE they used the control we
  // gave them. Found by GPT-5.6-Sol, 2026-07-24. A group's heading must be derivable from the state
  // of the rows inside it, which is why the counts below are computed from the split, never passed in.
  const asks = [], inForce = [], off = [], quarantined = [];
  rows.forEach((r, i) => {
    if (r.quarantined) quarantined.push(kids[i]);
    else if (r.demoted) off.push(kids[i]);
    else if (r.awaitingYou) asks.push(kids[i]);
    else inForce.push(kids[i]);
  });
  const out = [];
  if (asks.length) {
    out.push(el('p', { class: 'lessons-ask-h' },
      `${asks.length} ${asks.length === 1 ? 'rule needs' : 'rules need'} your decision`),
      el('p', { class: 'muted lessons-ask-b' },
        'I noticed these myself, so they are not in force and cannot stop me until you agree. ',
        'Leaving them off is a perfectly good answer.'),
      el('div', { class: 'cap-list' }, ...asks));
  }
  if (inForce.length) {
    out.push(el('details', { class: 'lessons-more' },
      el('summary', null,
        `The ${inForce.length} ${inForce.length === 1 ? 'rule' : 'rules'} already in force — open to review or switch any off`),
      el('div', { class: 'cap-list' }, ...inForce)));
  }
  if (off.length) {
    // Switched-off rules get their OWN fold rather than being hidden. Hiding them would make the
    // control feel like deletion, and the whole promise of the switch is that it is not.
    out.push(el('details', { class: 'lessons-more' },
      el('summary', null,
        `${off.length} ${off.length === 1 ? 'rule you switched off' : 'rules you switched off'} — not in force; switch back on any time`),
      el('div', { class: 'cap-list' }, ...off)));
  }
  if (quarantined.length) {
    out.push(el('details', { class: 'lessons-more' },
      el('summary', null,
        `${quarantined.length} imported maintainer or demonstration ${quarantined.length === 1 ? 'record' : 'records'} — quarantined, not your policy`),
      el('div', { class: 'cap-list' }, ...quarantined)));
  }
  return out;
}

async function loadLessons() {
  lessonsSkeleton();
  try {
    const res = await fetch('/api/lessons', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`the console returned ${res.status}`);
    renderLessons(await res.json());
  } catch (err) {
    setChips('chips-lessons', [chip('not checked', 'nt')]);
    inlineError('body-lessons', String(err.message || err), () => loadLessons());
  }
}

loadLessons();
