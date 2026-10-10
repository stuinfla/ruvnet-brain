// rnbc-every-element.acceptance.test.mjs — click EVERY element of EVERY page the RuvNet Brain Console
// serves, on an ISOLATED console, and prove each one does what the page says (RNBC QA 2026-10-01).
//
// THE BAR (owner): every page, every element, every component of every element; clicking it makes the
// right thing happen; nothing is called "works" without a ledger row and its evidence. So:
//   1. Every page is inventoried with a deliberately wide net (focusable OR cursor:pointer) and every
//      element gets a semantic key. An element no rule can name is UNCLASSIFIED — a failure.
//   2. Every element gets a ledger row: the claim, the action, what was observed, a verdict. Elements
//      found == rows. A key with no row fails the test.
//   3. Mutating controls are proved end to end: the POST, the persisted file, the CONSUMER that reads
//      it behaving differently, and the undo putting it back.
// The ledger is written to $RNBC_LEDGER_OUT when set (docs/qa/rnbc-ledger.md is generated this way).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRnbcFixture, startRnbc, cleanupRnbc, REPO, schedulerEntry, schedulerState, registeredRunner } from './helpers/rnbc-fixture.mjs';
import { isolateDeveloperUpdateOwners, coordinatorExecutionFiles } from './helpers/rnbc-updater-fixture.mjs';
import { inventoryInPage, writeLedger } from './helpers/rnbc-inventory.mjs';
import { chromeExecutable } from './helpers/packed-console-fixture.mjs';

// Bound for waiting on a page STATE (a repaint, a saved note, a card rendering). A pass returns the moment
// the state appears, so this costs nothing when healthy; it only has to outlast a starved runner — RNBC
// rows failed at 60s on a machine at load ~400 with the state arriving later, never on a wrong state.
const STATE_WAIT_MS = 180_000;
const PAGES = ['index.html', 'scope.html', 'tips.html', 'architecture.html', 'install-architecture.html', 'install-mockup.html'];
const rows = new Map();          // `${page}|${key}` -> row
const found = new Map();         // `${page}|${key}` -> inventory entry
let fx; let srv; let browser; let ctx;
const posts = [];
const pageErrors = [];
const failedRequests = [];

function record(page, key, { claim = '', action, observed, ok, verdict }) {
  const v = verdict || (ok ? 'PASS' : 'FAIL');
  const id = `${page}|${key}`;
  const prev = rows.get(id);
  // A later, failing observation of the same element must never be overwritten by a pass.
  if (prev && prev.verdict === 'FAIL' && v !== 'FAIL') return;
  rows.set(id, { page, key, claim: claim || found.get(id)?.text || '', action, observed, verdict: v });
}

function nodeIn(env, src, cwd = fx.project) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { cwd, env: { ...fx.env, ...env }, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
const lessonsFor = (trigger) => JSON.parse(nodeIn({}, `const m = await import(${JSON.stringify(path.join(REPO, 'plugin/scripts/lesson-store.mjs'))}); process.stdout.write(JSON.stringify(m.lessonsFor(${JSON.stringify(trigger)}, m.loadLessons(), { limit: 50 }).map((l) => l.id)));`).out);
const routeCheap = () => spawnSync(process.execPath, [path.join(REPO, 'scripts/route-cheap.mjs'), '--task', 'summarise x'],
  { cwd: fx.project, env: { ...fx.env, OPENROUTER_API_KEY: '' }, encoding: 'utf8', timeout: 60_000 });
const readJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

async function openPage(name, base = srv.url) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`[${name}] console: ${m.text()}`); });
  page.on('requestfailed', (r) => failedRequests.push(`[${name}] ${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`[${name}] ${r.status()} ${r.url()}`); });
  page.on('request', (r) => { if (r.method() === 'POST') posts.push({ page: name, url: new URL(r.url()).pathname, body: r.postData() }); });
  await page.goto(new URL(name, base).toString(), { waitUntil: 'load' });
  return page;
}

async function settleIndex(page) {
  await page.waitForFunction(() => {
    const v = document.querySelector('#verdict');
    return v && !v.hidden && document.querySelector('#body-lessons .lesson-row')
      && document.querySelector('#body-inventory .inv-row') && document.querySelector('#ab-stat-memories')
      && document.querySelector('#body-settings form.settings-form') && document.querySelector('#body-trust [data-trust-ready]');
  }, null, { timeout: 120_000 });
  // Let any background re-measure the page kicked on load land first: a repaint mid-click moves
  // elements under the mouse. (Unsaved Settings edits survive a repaint — asserted separately.)
  await page.waitForFunction(() => /as of|measured just now/.test(document.querySelector('#freshness-pill')?.innerText || '')
    && !/measuring/.test(document.querySelector('#freshness-pill')?.innerText || ''), null, { timeout: 180_000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  await page.waitForTimeout(300);
}

async function inventory(page, name) {
  const inv = await page.evaluate(inventoryInPage, name);
  for (const e of inv) if (!found.has(`${name}|${e.key}`)) found.set(`${name}|${e.key}`, e);
  return inv;
}
// A PERSON'S CLICK: scroll the element to the middle of the viewport (clear of the sticky header),
// then press the mouse at its centre, so the browser's own hit-testing decides what receives it.
async function uc(page, loc) {
  // behavior:'instant' — the page sets scroll-behavior:smooth, so a default scroll is still moving
  // when the mouse lands, and the scroll itself closes any open info popover.
  // Then wait until the element stops MOVING: under CPU load a card above it can still be growing (a
  // measurement landing) after the scroll, and a click aimed at a stale box lands on whatever slid
  // under it — on a loaded Linux runner the Settings anchor click missed this way (dial 1770px away,
  // card still closed). Stable = the same box across two animation frames; re-centre if it drifted.
  let b = null;
  for (let i = 0; i < 40; i++) {
    await loc.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
    const before = await loc.boundingBox();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(80);
    b = await loc.boundingBox();
    if (!b) throw new Error('element has no box (not rendered)');
    const vh = page.viewportSize()?.height ?? Infinity;
    if (before && Math.abs(before.x - b.x) < 0.5 && Math.abs(before.y - b.y) < 0.5
      && (b.height >= vh || (b.y >= 0 && b.y + b.height <= vh))) break;
  }
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
const q = (page, key) => page.locator(`[data-qa-key="${key.replace(/"/g, '\\"')}"]`).first();
const postsSince = (n) => posts.slice(n);

// ── generic element checks (non-mutating) ─────────────────────────────────────────────────────────
async function checkSummary(page, name, key) {
  if (!(await q(page, key).count())) await inventory(page, name); // the card re-rendered since it was tagged
  const loc = q(page, key);
  // a disclosure nested in a closed fold is reached the way a person reaches it: open the fold first
  if (!(await loc.isVisible())) await loc.evaluate((s) => { for (let d = s.closest('details')?.parentElement?.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true; });
  if (!(await loc.isVisible())) return record(name, key, { action: 'click summary', observed: 'not visible in this state', verdict: 'NOT-RENDERED' });
  const before = await loc.evaluate((s) => s.closest('details').open);
  await uc(page, loc);
  const mid = await loc.evaluate((s) => s.closest('details').open);
  await uc(page, loc);
  const after = await loc.evaluate((s) => s.closest('details').open);
  record(name, key, { action: 'click ×2', observed: `details.open ${before} → ${mid} → ${after}`, ok: mid === !before && after === before });
}
async function checkInfo(page, name, key) {
  const loc = q(page, key);
  await loc.scrollIntoViewIfNeeded();
  await uc(page, loc);
  const pop = page.locator('.info-pop');
  const shown = await pop.isVisible();
  const title = shown ? (await pop.locator('.ip-title').innerText()) : '';
  const beats = shown ? await pop.locator('.ip-beat').count() : 0;
  await page.keyboard.press('Escape');
  const closed = !(await page.locator('.info-pop').count());
  record(name, key, { action: 'click, then Escape', observed: `popover "${title}" with ${beats} explanation line(s); closed on Escape: ${closed}`, ok: shown && !!title && beats > 0 && closed });
}
async function checkExtLink(page, name, key, entry) {
  const loc = q(page, key);
  const attrs = await loc.evaluate((a) => ({ href: a.href, target: a.target, rel: a.rel }));
  const ok = (key.startsWith('extlink:card-inventory') || name === 'scope.html' ? /^https:\/\/(github\.com|gist\.github\.com)\//.test(attrs.href) : /^https:\/\//.test(attrs.href)) && attrs.target === '_blank' && /noopener/.test(attrs.rel);
  record(name, key, { action: 'inspect (external — not navigated)', observed: `${attrs.href} target=${attrs.target} rel=${attrs.rel}`, ok });
}
async function checkLocalLink(page, name, key) {
  const loc = q(page, key);
  const href = await loc.evaluate((a) => a.href);
  const res = await page.request.get(href);
  const body = await res.text();
  record(name, key, { action: 'follow href', observed: `${new URL(href).pathname} → HTTP ${res.status()} ${/<title>([^<]*)/.exec(body)?.[1] || ''}`, ok: res.status() === 200 && /<title>/.test(body) });
}
async function checkJump(page, name, key, targetSel) {
  const loc = q(page, key);
  await loc.scrollIntoViewIfNeeded();
  await uc(page, loc);
  let inView = 'missing';
  for (let i = 0; i < 15 && inView !== 'in-view'; i++) {
    await page.waitForTimeout(200);
    inView = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    if (!t) return 'missing';
    const r = t.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight ? 'in-view' : `off-screen(${Math.round(r.top)})`;
    }, targetSel);
  }
  record(name, key, { action: 'click', observed: `${targetSel}: ${inView}`, ok: inView === 'in-view' });
}

beforeAll(async () => {
  fx = buildRnbcFixture();
  srv = await startRnbc(fx);
  browser = await chromium.launch({ executablePath: chromeExecutable(chromium) });
  ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  ctx.on('dialog', () => {});
}, 300_000);

afterAll(async () => {
  const out = process.env.RNBC_LEDGER_OUT || path.join(os.tmpdir(), `rnbc-ledger-${process.pid}.md`);
  // Every inventoried element must have a row; a missing one becomes a FAIL row (and fails below).
  for (const [id, e] of found) {
    if (!rows.has(id)) rows.set(id, { page: id.split('|')[0], key: e.key, claim: e.text, action: '—', observed: 'NO ROW: no check handled this element', verdict: 'FAIL' });
  }
  writeLedger(out, { rows: [...rows.values()], meta: { found: found.size, generatedAt: new Date().toISOString() } });
  await browser?.close();
  await srv?.stop();
  if (fx && !process.env.RNBC_KEEP_FIXTURE) cleanupRnbc(fx);
}, 120_000);

describe('RNBC — every element on every page, on an isolated console', () => {
  it('index.html: read-only elements (summaries, info, links, jumps, doors, filter, theme, previews)', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    const inv = await inventory(page, 'index.html');
    for (const e of inv) {
      const k = e.key;
      if (k.startsWith('summary:')) await checkSummary(page, 'index.html', k);
      else if (k.startsWith('info:')) await checkInfo(page, 'index.html', k);
      else if (k.startsWith('extlink:')) await checkExtLink(page, 'index.html', k, e);
      else if (k.startsWith('link:') && !k.startsWith('link:ab-')) await checkLocalLink(page, 'index.html', k);
      else if (k.startsWith('jump:plan:')) await checkJump(page, 'index.html', k, /add-a-key|manage/.test(k) ? '#field-openrouterKey' : '#field-provider');
      else if (k.startsWith('jump:bp-parts:')) await checkJump(page, 'index.html', k, /nightly/.test(k) ? '#field-nightly' : '#field-learningScope');
      else if (k.startsWith('jump:cap-setting:')) await checkJump(page, 'index.html', k, '#field-nightly');
      else if (k === 'jump:to-brain') await checkJump(page, 'index.html', k, '#card-brain');
    }

    // anchors
    await q(page, 'link:skip').focus();
    await page.keyboard.press('Enter');
    record('index.html', 'link:skip', { action: 'keyboard: focus + Enter', observed: `location.hash=${await page.evaluate(() => location.hash)}`, ok: (await page.evaluate(() => location.hash)) === '#main' });
    await page.evaluate(() => { document.querySelector('#card-settings').open = false; });
    await q(page, 'anchor:#field-advocacy').scrollIntoViewIfNeeded();
    await uc(page, q(page, 'anchor:#field-advocacy'));
    // wait on the STATE (card opened, dial scrolled into view), not a fixed sleep: under load the
    // fragment navigation and its smooth scroll take longer than any constant
    await page.waitForFunction(() => {
      const t = document.querySelector('#field-advocacy')?.getBoundingClientRect().top;
      return document.querySelector('#card-settings').open && t > -60 && t < 1000;
    }, null, { timeout: 10_000 }).catch(() => {});
    const adv = await page.evaluate(() => ({ open: document.querySelector('#card-settings').open, top: document.querySelector('#field-advocacy')?.getBoundingClientRect().top }));
    record('index.html', 'anchor:#field-advocacy', { action: 'click (Settings card closed first)', observed: `settings card open=${adv.open}, dial top=${Math.round(adv.top)}px`, ok: adv.open && adv.top > -60 && adv.top < 1000 });
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));

    // inventory filter
    const filter = q(page, 'input:inv-filter');
    await filter.fill('vector');
    const shown = await page.locator('#body-inventory .inv-row:not([hidden])').count();
    const countText = await page.locator('.inv-count').innerText();
    await filter.fill('');
    const all = await page.locator('#body-inventory .inv-row:not([hidden])').count();
    record('index.html', 'input:inv-filter', { action: 'type "vector", then clear', observed: `${shown} row(s) shown, "${countText}"; cleared → ${all} rows`, ok: shown === 1 && /1 of 2/.test(countText) && all === 2 });

    // activity doors
    for (const tile of ['door:ab-stat-memories', 'door:ab-stat-lessons', 'door:ab-stat-projects', 'door:ab-stat-machine']) {
      const loc = q(page, tile);
      await loc.scrollIntoViewIfNeeded();
      await uc(page, loc);
      await page.waitForTimeout(450);
      const open = await page.evaluate((id) => ({ doors: document.querySelector('#ab-doors').classList.contains('ab-open'), exp: document.getElementById(id).getAttribute('aria-expanded'), title: document.querySelector('#ab-doorTitle').textContent, view: document.querySelector('.ab-door-view.ab-active')?.id }), tile.slice(5));
      await uc(page, loc);
      await page.waitForTimeout(300);
      const closed = await page.evaluate(() => !document.querySelector('#ab-doors').classList.contains('ab-open'));
      record('index.html', tile, { action: 'click, click again', observed: `opened ${open.view} "${open.title}" (aria-expanded=${open.exp}); second click closed=${closed}`, ok: open.doors && open.exp === 'true' && !!open.title && closed });
    }
    for (const hit of inv.filter((x) => x.key.startsWith('door:ab-flowHit'))) {
      await q(page, hit.key).scrollIntoViewIfNeeded();
      await uc(page, q(page, hit.key));
      await page.waitForTimeout(450);
      const v = await page.evaluate(() => ({ open: document.querySelector('#ab-doors').classList.contains('ab-open'), view: document.querySelector('.ab-door-view.ab-active')?.id }));
      await uc(page, q(page, 'btn:door-close'));
      await page.waitForTimeout(300);
      const closed = await page.evaluate(() => !document.querySelector('#ab-doors').classList.contains('ab-open'));
      record('index.html', hit.key, { action: 'click', observed: `opened ${v.view}`, ok: v.open && /memories|lessons/.test(v.view || '') });
      record('index.html', 'btn:door-close', { action: 'click while a door is open', observed: `closed=${closed}`, ok: closed });
    }
    await uc(page, q(page, 'link:ab-openUniverse'));
    await page.waitForTimeout(450);
    const uni = await page.evaluate(() => document.querySelector('.ab-door-view.ab-active')?.id);
    record('index.html', 'link:ab-openUniverse', { action: 'click', observed: `active view ${uni}`, ok: uni === 'ab-view-universe' });
    await page.keyboard.press('Escape');

    // theme
    const t0 = await page.evaluate(() => document.documentElement.dataset.theme);
    await uc(page, q(page, 'btn:theme'));
    const t1 = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, stored: localStorage.getItem('rbc-theme') }));
    await uc(page, q(page, 'btn:theme'));
    const t2 = await page.evaluate(() => document.documentElement.dataset.theme);
    record('index.html', 'btn:theme', { action: 'click ×2', observed: `${t0} → ${t1.theme} (stored ${t1.stored}) → ${t2}`, ok: t1.theme !== t0 && t1.stored === t1.theme && t2 === t0 });

    // advisor preview: changes only its note, never posts
    const n0 = posts.length;
    await uc(page, q(page, 'btn:adv:full-recommended'));
    record('index.html', 'btn:adv:full-recommended', { action: 'click', observed: 'current-mode indicator; labelled "preview · planned"; no request sent', ok: postsSince(n0).length === 0, verdict: postsSince(n0).length === 0 ? 'INERT' : 'FAIL' });
    await uc(page, q(page, 'btn:adv:advisor-read-only'));
    const note = await page.locator('.adv-note').innerText();
    record('index.html', 'btn:adv:advisor-read-only', { action: 'click', observed: `note: "${note.slice(0, 60)}…"; requests sent: ${postsSince(n0).length}`, ok: /nothing changed/.test(note) && postsSince(n0).length === 0 });

    // update gong: hidden while the installed version is current, shown when a newer release exists.
    // Hermetic: the live latest release moves (4.4.1 shipped mid-QA), so both cases are served explicitly.
    const cur = await ctx.newPage();
    await cur.route('**/api/trust', async (route) => { const real = await (await route.fetch()).json(); await route.fulfill({ json: { ...real, release: { ...(real.release || {}), ok: true, tag: 'v0.0.1' } } }); });
    await cur.goto(srv.url);
    await cur.waitForFunction(() => document.querySelector('#body-trust [data-trust-ready]'), null, { timeout: STATE_WAIT_MS });
    const hiddenWhenCurrent = await cur.evaluate(() => document.querySelector('#brain-update').hidden);
    await cur.close();
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.url });
    const gp = await ctx.newPage();
    await gp.route('**/api/trust', async (route) => {
      const real = await (await route.fetch()).json();
      await route.fulfill({ json: { ...real, release: { ...(real.release || {}), ok: true, tag: 'v99.0.0' } } });
    });
    await gp.goto(srv.url);
    await gp.waitForFunction(() => !document.querySelector('#brain-update').hidden, null, { timeout: STATE_WAIT_MS });
    const label = await gp.locator('#brain-update').innerText();
    const urlBefore = gp.url();
    await gp.locator('#brain-update').click();
    await gp.waitForTimeout(300);
    const after = await gp.locator('#brain-update').innerText({ timeout: 5000 }).catch(() => `(gone; page now ${gp.url()} from ${urlBefore})`);
    const clip = await gp.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    const helpOk = spawnSync(process.execPath, [path.join(REPO, 'bin/install.mjs'), '--help'], { env: { ...fx.env, RUVNET_BRAIN_IMPORT_ONLY: '0' }, encoding: 'utf8', timeout: 60_000 }).stdout.includes('--update');
    await gp.close();
    record('index.html', 'btn:update-gong', { action: 'older latest release (v0.0.1): inspect; newer release (v99.0.0): click', observed: `hidden when current=${hiddenWhenCurrent}; shown "${label}"; after click "${after}"; clipboard "${clip}"; installer --help documents --update=${helpOk}`, ok: hiddenWhenCurrent && /v99\.0\.0/.test(label) && clip === 'npx ruvnet-brain --update' && helpOk });
    await page.close();
  }, 900_000);

  // The page loads /api/state and /api/trust in parallel; the gong needs both (installed version from
  // state, latest release from trust). Under load trust sometimes landed first, the gong was decided
  // with no installed version, hidden, and never reconsidered — the header test then timed out waiting
  // for it (RNBC load runs, 2026-10-01). Force that order: hold /api/state until trust has rendered.
  it('update gong appears even when the release read lands before the machine state', async () => {
    const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    let trustServed; const trustDone = new Promise((r) => { trustServed = r; });
    await p.route('**/api/trust', async (r) => { const j = await (await r.fetch()).json(); await r.fulfill({ json: { ...j, release: { ...(j.release || {}), ok: true, tag: 'v99.0.0' } } }); trustServed(); });
    await p.route('**/api/state', async (r) => { await trustDone; await p.waitForFunction(() => document.querySelector('#body-trust [data-trust-ready]'), null, { timeout: STATE_WAIT_MS }).catch(() => {}); await r.continue(); });
    await p.goto(srv.url);
    const shown = await p.waitForFunction(() => !document.querySelector('#brain-update').hidden && document.querySelector('#brain-ver') && !document.querySelector('#brain-ver').hidden, null, { timeout: 60_000 }).then(() => true, () => false);
    const label = await p.locator('#brain-update').innerText().catch(() => '');
    record('index.html', 'behaviour:update-gong-trust-before-state', { claim: 'a newer release shows the update gong whatever order the page data arrives in', action: 'serve /api/trust (v99.0.0) first, release /api/state only after the trust card rendered', observed: `gong shown=${shown} "${label}"`, ok: shown && /v99\.0\.0/.test(label) });
    await p.close();
    expect(rows.get('index.html|behaviour:update-gong-trust-before-state').verdict).toBe('PASS');
  }, 900_000);

  it('Header at desktop and phone widths, with and without the update gong: nothing covers anything', async () => {
    for (const [w, h] of [[1440, 1000], [390, 844]]) {
      for (const gong of [false, true]) {
        const p = await browser.newPage({ viewport: { width: w, height: h } });
        await p.route('**/api/trust', async (r) => { const j = await (await r.fetch()).json(); await r.fulfill({ json: { ...j, release: { ...(j.release || {}), ok: true, tag: gong ? 'v99.0.0' : 'v0.0.1' } } }); });
        await p.goto(srv.url);
        await p.waitForFunction((g) => document.querySelector('#body-trust [data-trust-ready]') && (!g || !document.querySelector('#brain-update').hidden), gong, { timeout: STATE_WAIT_MS });
        await p.waitForTimeout(800);
        const res = await p.evaluate(() => {
          const els = [...document.querySelectorAll('.head-inner a, .head-inner button, .head-inner .ver-chip')].filter((e) => e.getBoundingClientRect().width);
          const covered = [];
          for (const e of els) {
            const r = e.getBoundingClientRect();
            const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            if (!top || (!e.contains(top) && !top.contains(e))) covered.push(`${e.id || e.className} under ${top ? top.className || top.tagName : 'nothing (off-screen)'}`);
          }
          return { covered, hscroll: document.documentElement.scrollWidth > innerWidth + 1 };
        });
        await p.screenshot({ path: path.join(os.tmpdir(), `rnbc-header-${w}-${gong ? 'gong' : 'plain'}.png`), clip: { x: 0, y: 0, width: w, height: 120 } });
        record('index.html', `layout:header:${w}:${gong ? 'gong' : 'plain'}`, { claim: 'header controls are clickable where they are drawn', action: `render at ${w}px${gong ? ' with an update available' : ''}`, observed: `covered: ${JSON.stringify(res.covered)}; horizontal scroll: ${res.hscroll}`, ok: !res.covered.length && !res.hscroll });
        await p.close();
      }
    }
  }, 900_000);

  it('Brain power switch: off → sentinel written and the brain reads off; on → removed', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    await inventory(page, 'index.html');
    const sentinel = path.join(fx.home, '.config', 'ruvnet-brain', 'brain-off');
    const isOff = () => nodeIn({}, `const m = await import(${JSON.stringify(path.join(REPO, 'scripts/brain-state.mjs'))}); process.stdout.write(String(m.isBrainOff()));`).out;
    await uc(page, q(page, 'btn:bp-switch'));
    const confirm = page.locator('#bp-confirm-slot .bp-confirm');
    const keep = confirm.getByRole('button', { name: 'Keep it on' });
    await uc(page, keep);
    const keptOn = !(await page.locator('#bp-confirm-slot .bp-confirm').count()) && !fs.existsSync(sentinel);
    record('index.html', 'btn:bp-confirm:keep-it-on', { claim: 'Keep it on', action: 'open confirm, click Keep it on', observed: `confirm closed, sentinel absent: ${keptOn}`, ok: keptOn });
    await uc(page, q(page, 'btn:bp-switch'));
    const n0 = posts.length;
    await uc(page, page.locator('#bp-confirm-slot').getByRole('button', { name: 'Turn the brain off' }));
    await page.waitForFunction(() => /OFF/.test(document.querySelector('#chips-brain')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    const offNow = fs.existsSync(sentinel); const offRead = isOff();
    record('index.html', 'btn:bp-confirm:turn-the-brain-off', { claim: 'Turn the brain off', action: 'confirm off', observed: `POST ${postsSince(n0).map((p) => p.url).join(',')}; sentinel ${offNow}; brain-state.isBrainOff()=${offRead}; chip OFF`, ok: offNow && offRead === 'true' });
    await inventory(page, 'index.html');
    await uc(page, q(page, 'btn:bp-switch'));
    await page.waitForFunction(() => /ON/.test(document.querySelector('#chips-brain')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    const onRead = isOff();
    record('index.html', 'btn:bp-switch', { claim: 'Turn it off / Turn it back on', action: 'off (with consent) then on', observed: `off: sentinel written + isBrainOff true; on: sentinel removed=${!fs.existsSync(sentinel)}, isBrainOff=${onRead}`, ok: offNow && !fs.existsSync(sentinel) && onRead === 'false' });
    await page.close();
  }, 900_000);

  it('Brain profile: RuVector Only removes the other stores; Complete restores them; Cancel changes nothing', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    await inventory(page, 'index.html');
    const stores = () => fs.readdirSync(fx.kb).filter((f) => /\.big\.rvf$/.test(f)).sort().join(',');
    const before = stores();
    await uc(page, q(page, 'radio:profile:ruvector'));
    const enabled = await q(page, 'btn:profile-apply').isEnabled();
    page.once('dialog', (d) => d.dismiss());
    await uc(page, q(page, 'btn:profile-apply'));
    await page.waitForTimeout(500);
    const afterDismiss = stores();
    page.once('dialog', (d) => d.accept());
    await uc(page, q(page, 'btn:profile-apply'));
    await page.waitForFunction(() => /RuVector Only is active/.test(document.querySelector('.bp-profile-result')?.innerText || document.body.innerText), null, { timeout: STATE_WAIT_MS });
    const afterRv = stores();
    const mirror = readJSON(fx.settingsFile)?.settings?.brainProfile;
    record('index.html', 'radio:profile:ruvector', { action: 'select', observed: `Apply enabled=${enabled}`, ok: enabled });
    await page.waitForTimeout(800);
    await inventory(page, 'index.html');
    await uc(page, q(page, 'radio:profile:complete'));
    await uc(page, q(page, 'btn:profile-apply'));
    await page.waitForFunction(() => /Complete Brain is active/.test(document.body.innerText), null, { timeout: STATE_WAIT_MS });
    const afterComplete = stores();
    record('index.html', 'radio:profile:complete', { action: 'select + Apply', observed: `stores ${afterRv} → ${afterComplete}`, ok: afterComplete === before });
    record('index.html', 'btn:profile-apply', { claim: 'Apply selection', action: 'RuVector (dismiss confirm), RuVector (accept), Complete', observed: `before ${before}; dismissed → ${afterDismiss}; RuVector → ${afterRv} (settings mirror ${mirror}); Complete → ${afterComplete}`, ok: afterDismiss === before && afterRv === 'ruvector.big.rvf' && mirror === 'ruvector' && afterComplete === before });
    await page.close();
  }, 900_000);

  it('Settings (config.json): only touched fields save; each choice reaches its consumer; undo reverts the file AND the scheduler', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    const inv = await inventory(page, 'index.html');
    const form = page.locator('form.settings-form').nth(0);
    // every segment label selects its radio
    for (const e of inv.filter((x) => /^seglabel:(provider|routing):/.test(x.key))) {
      await uc(page, q(page, e.key));
      const radioKey = e.key.replace('seglabel:', 'radio:').replace(/#\d+$/, '');
      const checked = await q(page, radioKey).isChecked();
      record('index.html', e.key, { action: 'click label', observed: `${radioKey} checked=${checked}`, ok: checked });
      record('index.html', radioKey, { action: 'selected via its label', observed: `checked=${checked}`, ok: checked });
    }
    // reset to provider=Codex only: reload so nothing else is touched
    await page.reload(); await settleIndex(page); await inventory(page, 'index.html');
    await uc(page, q(page, 'seglabel:provider:codex'));
    let n0 = posts.length;
    await uc(page, q(page, 'btn:save:0'));
    await page.waitForSelector('form.settings-form >> nth=0 >> .form-note.n-ok', { timeout: STATE_WAIT_MS });
    const cfg1 = readJSON(fx.configFile);
    const house = (await (await page.request.get(new URL('/api/state', srv.url).toString())).json()).sections?.savings?.routerEngine?.house?.provider;
    const body1 = JSON.parse(postsSince(n0).find((p) => p.url === '/api/save-config')?.body || '{}');
    const entry1 = schedulerEntry(fx);
    record('index.html', 'btn:save:0', { claim: 'Save settings (config.json)', action: 'change ONLY Your model house → Codex, Save', observed: `posted ${JSON.stringify(body1.values)}; config.json ${JSON.stringify(cfg1)}; nightly ${entry1.kind} present=${!!entry1.text}; consumer (router house) = ${house}`, ok: JSON.stringify(cfg1) === '{"provider":"codex"}' && !entry1.text && house === 'codex' });
    await inventory(page, 'index.html');
    // undo of a first-ever save removes the file
    await uc(page, q(page, 'btn:save-undo:0'));
    await page.waitForFunction(() => /restored from the backup|Settings restored/.test(document.querySelector('form.settings-form')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    record('index.html', 'btn:save-undo:0', { claim: 'Undo save', action: 'click after the first save', observed: `config.json exists=${fs.existsSync(fx.configFile)}`, ok: !fs.existsSync(fx.configFile) });

    // explicit choices: nightly ON (touched), routing OFF, qeFleet ON
    await page.reload(); await settleIndex(page); await inventory(page, 'index.html');
    const nightly = q(page, 'checkbox:setting:nightly');
    await uc(page, nightly); await uc(page, nightly);        // touched, lands on "on"
    await uc(page, q(page, 'seglabel:routing:off'));
    await uc(page, q(page, 'checkbox:setting:qeFleet'));
    n0 = posts.length;
    await uc(page, q(page, 'btn:save:0'));
    // wait for the outcome, success or not: a refused save is a row with its reason, never a timeout
    const note2 = await page.waitForSelector('form.settings-form >> nth=0 >> .form-note', { timeout: 90_000 }).then((h) => h.innerText());
    const cfg2 = readJSON(fx.configFile);
    const rc = routeCheap();
    const qe = nodeIn({}, `const m = await import(${JSON.stringify(path.join(REPO, 'plugin/scripts/runtime-preferences.mjs'))}); process.stdout.write(String(m.loadRuntimePreferences().values.qeFleet));`).out;
    // Platform-honest: the scheduler entry THIS OS uses (plist / crontab row / task), bound to the registered
    // runner, and the installed console's own scheduler status. Real launchctl/crontab/schtasks never run.
    const runner = registeredRunner(fx);
    const entry2 = schedulerEntry(fx);
    const status2 = schedulerState(fx);
    record('index.html', 'checkbox:setting:nightly', { action: 'toggle off/on (touched), Save — on the console installed from npm pack (.console-runtime)', observed: `form: "${note2.slice(0, 70)}"; config nightly=${cfg2?.nightly}; ${process.platform} ${entry2.kind} under the fixture HOME present=${!!entry2.text}, bound to the registered runner ${path.basename(runner) || '(none)'}=${!!(entry2.text && runner && entry2.text.includes(runner))}; scheduler status=${status2.state}; served by ${path.relative(fx.home, fx.console)} (test mode: the OS scheduler is never called)`,
      ok: cfg2?.nightly === true && !!entry2.text && !!runner && entry2.text.includes(runner) && status2.state === 'on' });
    record('index.html', 'radio:routing:off', { action: 'choose off, Save', observed: `config routing=${cfg2?.routing}; consumer route-cheap exit ${rc.status}: ${rc.stderr.trim().slice(0, 80)}`, ok: cfg2?.routing === 'off' && rc.status === 1 && /routing is off/i.test(rc.stderr) });
    record('index.html', 'checkbox:setting:qeFleet', { action: 'switch on, Save', observed: `config qeFleet=${cfg2?.qeFleet}; consumer runtime-preferences qeFleet=${qe} (the managed-CLI gate starts QE fleets only when true)`, ok: cfg2?.qeFleet === true && qe === 'true' });
    await inventory(page, 'index.html');
    await uc(page, q(page, 'btn:save-undo:0'));
    await page.waitForFunction(() => /Settings restored|Undo didn/.test(document.querySelector('form.settings-form')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    const rc2 = routeCheap();
    const entry3 = schedulerEntry(fx); const status3 = schedulerState(fx);
    record('index.html', 'btn:save-undo:0', { claim: 'Undo save', action: 'undo the nightly/routing/qe save', observed: `config.json exists=${fs.existsSync(fx.configFile)}; ${entry3.kind} removed=${!entry3.text}; scheduler status=${status3.state}; route-cheap now: ${rc2.stderr.trim().slice(0, 60)}`, ok: !fs.existsSync(fx.configFile) && !entry3.text && status3.state === 'off' && /not been enabled/i.test(rc2.stderr) });
    await page.close();
  }, 900_000);

  // Once nightly is a saved choice the page sends it with EVERY later save of this form. Changing only
  // the model house must not re-run the installer or rewrite the scheduler entry (RNBC review 2026-10-01).
  it('Settings (config.json): with nightly already on, saving only the model house leaves the scheduler alone', async () => {
    const artifact = schedulerEntry(fx).file;   // this OS's scheduler entry file under the fixture HOME
    const registration = path.join(fx.brainHome, 'scheduler', 'registration.json');
    const calls = () => (fs.existsSync(fx.nightlyCallLog) ? fs.readFileSync(fx.nightlyCallLog, 'utf8').split('\n').filter(Boolean) : []);
    const page = await openPage('index.html');
    await settleIndex(page); await inventory(page, 'index.html');
    const nightly = q(page, 'checkbox:setting:nightly');
    await uc(page, nightly); await uc(page, nightly);        // touched, lands on "on"
    await uc(page, q(page, 'btn:save:0'));
    await page.waitForSelector('form.settings-form >> nth=0 >> .form-note.n-ok', { timeout: 90_000 });
    const onCalls = calls().length;
    const onEntry = schedulerEntry(fx).text;
    const artStat = onEntry && fs.existsSync(artifact) ? fs.statSync(artifact, { bigint: true }) : null;
    const artBytes = artStat ? fs.readFileSync(artifact, 'utf8') : null;
    const regStat = fs.existsSync(registration) ? fs.statSync(registration, { bigint: true }) : null;

    await page.reload(); await settleIndex(page); await inventory(page, 'index.html');
    await uc(page, q(page, 'seglabel:provider:openai'));
    const n0 = posts.length;
    await uc(page, q(page, 'btn:save:0'));
    await page.waitForSelector('form.settings-form >> nth=0 >> .form-note.n-ok', { timeout: 90_000 });
    const sent = JSON.parse(postsSince(n0).find((p) => p.url === '/api/save-config')?.body || '{}').values || {};
    const cfg = readJSON(fx.configFile) || {};
    const newCalls = calls().slice(onCalls);
    const artSame = !!artStat && fs.statSync(artifact, { bigint: true }).mtimeNs === artStat.mtimeNs && fs.readFileSync(artifact, 'utf8') === artBytes;
    const regSame = !!regStat && fs.statSync(registration, { bigint: true }).mtimeNs === regStat.mtimeNs;
    record('index.html', 'btn:save:0#nightly-unchanged', { claim: 'Save settings (config.json) — nightly already on', action: 'nightly on and saved; reload; change ONLY Your model house → ChatGPT; Save',
      observed: `posted ${JSON.stringify(sent)}; installer nightly calls since: ${newCalls.length ? newCalls.map((c) => c.split(fx.home).join('~')).join(' | ') : 'none'}; ${schedulerEntry(fx).kind} untouched (mtime+bytes)=${artSame}; registration untouched=${regSame}; config provider=${cfg.provider} nightly=${cfg.nightly}`,
      ok: sent.nightly === true && sent.provider === 'openai' && !newCalls.length && artSame && regSame && cfg.provider === 'openai' && cfg.nightly === true });

    // put the scheduler back the way a person would: switch it off and save (the installed disable path)
    await page.reload(); await settleIndex(page); await inventory(page, 'index.html');
    await uc(page, q(page, 'checkbox:setting:nightly'));
    await uc(page, q(page, 'btn:save:0'));
    await page.waitForSelector('form.settings-form >> nth=0 >> .form-note.n-ok', { timeout: 90_000 });
    const offCalls = calls().slice(onCalls);
    record('index.html', 'checkbox:setting:nightly#off', { claim: 'Nightly brain refresh — switch off', action: 'switch off, Save', observed: `config nightly=${readJSON(fx.configFile)?.nightly}; installer calls: ${offCalls.map((c) => c.split(fx.home).join('~')).join(' | ')}; ${schedulerEntry(fx).kind} removed=${!schedulerEntry(fx).text}; scheduler status=${schedulerState(fx).state}`,
      ok: readJSON(fx.configFile)?.nightly === false && offCalls.length === 1 && /--disable-nightly/.test(offCalls[0]) && !schedulerEntry(fx).text && schedulerState(fx).state === 'off' });
    fs.rmSync(fx.configFile, { force: true });   // later scenarios start from "never chosen", as before
    await page.close();
    expect(['btn:save:0#nightly-unchanged', 'checkbox:setting:nightly#off'].map((k) => rows.get(`index.html|${k}`))
      .filter((r) => r.verdict !== 'PASS').map((r) => `${r.key}: ${r.observed}`)).toEqual([]);
  }, 900_000);

  it('OpenRouter key: Show/Hide, Save encrypts it, both cards report it, undo removes it', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    await inventory(page, 'index.html');
    const input = q(page, 'input:secret');
    await input.fill('sk-or-fixture-0123456789abcdef');
    const show = q(page, 'btn:secret:show');
    await uc(page, show);
    const shownType = await input.getAttribute('type');
    await uc(page, show);
    const hiddenType = await input.getAttribute('type');
    record('index.html', 'btn:secret:show', { action: 'click ×2', observed: `input type ${shownType} → ${hiddenType}`, ok: shownType === 'text' && hiddenType === 'password' });
    await uc(page, q(page, 'btn:save:0'));
    await page.waitForSelector('form.settings-form >> nth=0 >> .form-note', { timeout: STATE_WAIT_MS });
    const secrets = path.join(fx.home, '.config', 'ruvnet-brain', 'secrets.enc.json');
    // The tools the CONSOLE can reach (its PATH, not this test process's): a machine without SOPS+age
    // (the Linux CI runner) must refuse the key, and then the box must keep offering "Add a key".
    const onPath = (name) => String(fx.env.PATH || '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));
    const hasSops = onPath('sops') && onPath('age-keygen');
    const enc = fs.existsSync(secrets) ? fs.readFileSync(secrets, 'utf8') : '';
    const state = await (await page.request.get(new URL('/api/state', srv.url).toString())).json();
    const plain = fs.existsSync(fx.configFile) ? fs.readFileSync(fx.configFile, 'utf8') : '';
    const ok = hasSops
      ? !!enc && !enc.includes('sk-or-fixture') && !plain.includes('sk-or-fixture') && state.sections.config.values.openrouterKey === true && state.sections.savings.routerEngine.keys.openrouter === true
      : /SOPS and age are required/.test(await page.locator('form.settings-form').nth(0).innerText());
    const formNote = await page.locator('form.settings-form').nth(0).locator('.form-note').innerText().catch(() => '');
    record('index.html', 'input:secret', { claim: 'OpenRouter API key', action: 'type a key, Save', observed: hasSops ? `form: "${formNote.slice(0, 60)}"; secrets.enc.json written=${!!enc} (plaintext inside=${enc.includes('sk-or-fixture')}); config.json plaintext=${plain.includes('sk-or-fixture')}; Settings key=${state.sections?.config?.values?.openrouterKey}; Savings OpenRouter key=${state.sections?.savings?.routerEngine?.keys?.openrouter}` : 'sops absent: refused with an explanation, nothing written', ok });
    // once a key exists the OpenRouter box offers "Manage" instead of "Add a key" — repaint and press it
    await page.evaluate(() => window.loadState && window.loadState());
    // wait on the repaint itself (the box's button label), never a fixed sleep
    const wantLabel = hasSops ? 'Manage' : 'Add a key';
    await page.waitForFunction((want) => [...document.querySelectorAll('.plan-action')].some((b) => b.textContent.trim() === want), wantLabel, { timeout: STATE_WAIT_MS }).catch(() => {});
    await inventory(page, 'index.html');
    if (hasSops && await q(page, 'jump:plan:manage').count()) await checkJump(page, 'index.html', 'jump:plan:manage', '#field-openrouterKey');
    await inventory(page, 'index.html');
    if (await q(page, 'btn:secret:replace').count()) {
      await uc(page, q(page, 'btn:secret:replace'));
      const inputShown = await page.locator('#field-openrouterKey input[type=password]').count();
      await inventory(page, 'index.html');
      await uc(page, q(page, 'btn:secret:keep-existing'));
      const setBack = await page.locator('#field-openrouterKey .secret-set').count();
      record('index.html', 'btn:secret:replace', { claim: 'Replace…', action: 'click while a key is stored', observed: `new-key input shown=${inputShown > 0}`, ok: inputShown > 0 });
      record('index.html', 'btn:secret:keep-existing', { claim: 'Keep existing', action: 'click', observed: `back to "•••• set" without saving=${setBack > 0}; secrets file untouched=${fs.existsSync(path.join(fx.home, '.config', 'ruvnet-brain', 'secrets.enc.json'))}`, ok: setBack > 0 });
    }
    else if (hasSops) record('index.html', 'jump:plan:manage', { action: 'look for Manage after saving a key', observed: 'the OpenRouter box still says "Add a key" after a key was saved', ok: false });
    else {
      const labels = await page.locator('.plan-action').allInnerTexts();
      record('index.html', 'jump:plan:add-a-key#no-sops', { claim: 'OpenRouter box after a refused key', action: 'save a key on a machine without SOPS+age, repaint', observed: `no key stored (secrets file present=${fs.existsSync(secrets)}); plan buttons: ${JSON.stringify(labels)}`, ok: !fs.existsSync(secrets) && labels.includes('Add a key') && !labels.includes('Manage') });
    }
    await inventory(page, 'index.html');
    if (hasSops) {
      await uc(page, q(page, 'btn:save-undo:0'));
      await page.waitForFunction(() => /Settings restored|Undo didn/.test(document.querySelector('form.settings-form')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
      record('index.html', 'btn:save-undo:0', { claim: 'Undo save', action: 'undo the key save', observed: `secrets file removed=${!fs.existsSync(secrets)}`, ok: !fs.existsSync(secrets) });
    }
    await page.reload(); await settleIndex(page); await inventory(page, 'index.html');
    await page.close();
  }, 900_000);

  it('Settings (user): every choice reaches its consumer; undo reverts', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    const inv = await inventory(page, 'index.html');
    for (const e of inv.filter((x) => /^seglabel:(learningScope|advocacy):/.test(x.key))) {
      await uc(page, q(page, e.key));
      const radioKey = e.key.replace('seglabel:', 'radio:').replace(/#\d+$/, '');
      const checked = await q(page, radioKey).isChecked();
      record('index.html', e.key, { action: 'click label', observed: `${radioKey} checked=${checked}`, ok: checked });
      record('index.html', radioKey, { action: 'selected via its label', observed: `checked=${checked}`, ok: checked });
    }
    await uc(page, q(page, 'seglabel:learningScope:user'));
    await uc(page, q(page, 'seglabel:advocacy:1'));
    await uc(page, q(page, 'checkbox:setting:autoApply'));
    await uc(page, q(page, 'checkbox:setting:newProjectDefaults'));
    // a background measurement landing now must not throw these unsaved choices away
    await page.evaluate(() => window.loadState && window.loadState());
    await page.waitForTimeout(1500);
    const kept = await page.evaluate(() => ({ scope: document.querySelector('input[name="seg-learningScope"][value="user"]')?.checked, adv: document.querySelector('input[name="seg-advocacy"][value="1"]')?.checked }));
    record('index.html', 'behaviour:unsaved-settings-survive-repaint', { claim: 'choices you have not saved yet stay on screen', action: 'choose user / 1 / act / inherit, then let the page repaint before saving', observed: `still selected after repaint: learningScope=user ${kept.scope}, advocacy=1 ${kept.adv}`, ok: kept.scope === true && kept.adv === true });
    await inventory(page, 'index.html');
    await uc(page, q(page, 'btn:save:1'));
    await page.waitForSelector('form.settings-form >> nth=1 >> .form-note.n-ok', { timeout: STATE_WAIT_MS });
    const s = readJSON(fx.settingsFile)?.settings || {};
    const scope = spawnSync(process.execPath, [path.join(REPO, 'plugin/scripts/runtime-preferences.mjs'), '--learning-scope'], { cwd: fx.project, env: fx.env, encoding: 'utf8' }).stdout.trim();
    // newProjectDefaults: the SessionStart seeder writes the choices into a never-set-up project.
    const fresh = path.join(fx.home, 'Code', 'fresh-project');
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, 'package.json'), '{}');
    spawnSync(process.execPath, [path.join(REPO, 'plugin/scripts/runtime-preferences.mjs'), '--seed-project'], { cwd: fresh, env: fx.env, encoding: 'utf8' });
    const seeded = readJSON(path.join(fresh, '.swarm', 'ruvnet-brain-settings.json'));
    // autoApply: the console's background measurement applies auto-eligible project fixes itself.
    const npxSettings = path.join(fx.npxProject, '.claude', 'settings.json');
    const npxBefore = fs.readFileSync(npxSettings, 'utf8');
    spawnSync(process.execPath, [fx.console, '--refresh-cache'], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 240_000 });
    const npxAfter = fs.readFileSync(npxSettings, 'utf8');
    const stateCache = readJSON(path.join(fx.home, '.claude', 'ruvnet-brain', 'state-cache.json'));
    record('index.html', 'radio:learningScope:user', { action: 'choose user, Save', observed: `settings learningScope=${s.learningScope}; consumer runtime-preferences --learning-scope → ${scope}`, ok: s.learningScope === 'user' && scope === 'user' });
    record('index.html', 'radio:advocacy:1', { action: 'choose 1, Save', observed: `settings advocacy=${s.advocacy}; consumer: unprompted-runtime level 1 drops advocacy; anticipate.sh level 1 is silent (tests/integration/anticipate-dial.test.mjs)`, ok: s.advocacy === 1 });
    record('index.html', 'checkbox:setting:newProjectDefaults', { action: 'switch on, Save', observed: `settings=${s.newProjectDefaults}; consumer --seed-project wrote ${JSON.stringify(seeded?.values)}`, ok: s.newProjectDefaults === true && seeded?.values?.learningScope === 'user' && seeded?.values?.advocacy === 1 });
    record('index.html', 'checkbox:setting:autoApply', { action: 'switch on, Save, run the background measurement', observed: `settings=${s.autoApply}; npx-project hook rewritten by the auto-apply loop=${npxBefore !== npxAfter && !npxAfter.includes('npx ruflo')}; state cache autoApply section=${!!JSON.stringify(stateCache || {}).includes('autoApply')}`, ok: s.autoApply === true && npxBefore !== npxAfter && !npxAfter.includes('npx ruflo') });
    // put npx-project back for the recommendation scenario (the auto-apply recorded its own undo)
    fs.writeFileSync(npxSettings, npxBefore);
    // The page repaints when a measurement lands; the Undo must survive that (it used to vanish).
    await page.evaluate(() => window.loadState && window.loadState());
    await page.waitForTimeout(1500);
    await inventory(page, 'index.html');
    const survived = await q(page, 'btn:save-undo:1').count();
    record('index.html', 'btn:save-undo:1#repaint', { claim: 'Undo save (after the page repaints)', action: 'save, let a re-measure repaint the page, look for Undo', observed: `Undo still offered after repaint: ${survived > 0}`, ok: survived > 0 });
    await uc(page, q(page, 'btn:save-undo:1'));
    await page.waitForFunction(() => /Settings restored|Undo didn/.test(document.querySelectorAll('form.settings-form')[1]?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    const scopeAfter = spawnSync(process.execPath, [path.join(REPO, 'plugin/scripts/runtime-preferences.mjs'), '--learning-scope'], { cwd: fx.project, env: fx.env, encoding: 'utf8' }).stdout.trim();
    record('index.html', 'btn:save-undo:1', { claim: 'Undo save', action: 'undo the user-settings save', observed: `settings.json exists=${fs.existsSync(fx.settingsFile) && !!readJSON(fx.settingsFile)?.settings?.autoApply}; --learning-scope now ${scopeAfter}`, ok: scopeAfter === 'project' && readJSON(fx.settingsFile)?.settings?.autoApply !== true });
    record('index.html', 'btn:save:1', { claim: 'Save settings (settings.json)', action: 'save learn/jumps-in/act/new-projects', observed: `wrote ${JSON.stringify(s)}`, ok: s.learningScope === 'user' && s.autoApply === true });
    // re-measure with autoApply off again, so later scenarios see the machine as it now is
    spawnSync(process.execPath, [fx.console, '--refresh-cache'], { cwd: fx.project, env: fx.env, encoding: 'utf8', timeout: 240_000 });
    await page.close();
  }, 900_000);

  it('Lessons: each switch changes what the gate delivers, and back', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    await inventory(page, 'index.html');
    const flip = async (id) => {
      // a person opens the fold the rule now lives in ("already in force" / "switched off") first
      await page.evaluate(() => document.querySelectorAll('#body-lessons details').forEach((d) => { d.open = true; }));
      await inventory(page, 'index.html');
      const box = q(page, `checkbox:lesson:${id}`);
      await box.scrollIntoViewIfNeeded();
      const was = await box.isChecked();
      await uc(page, box);
      await page.waitForTimeout(1200);
      await page.waitForFunction(() => document.querySelector('#body-lessons .lesson-row'), null, { timeout: 20_000 });
      return was;
    };
    const cases = [['QA-ASK', 'claim-done'], ['QA-ON', 'assert-fact'], ['QA-OFF', 'ship'], ['QA-IMP-ON', 'write-code']];
    for (const [id, trig] of cases) {
      const before = lessonsFor(trig).includes(id);
      await flip(id);
      const mid = lessonsFor(trig).includes(id);
      await flip(id);
      const after = lessonsFor(trig).includes(id);
      record('index.html', `checkbox:lesson:${id}`, { action: 'click, click again', observed: `lessonsFor('${trig}') includes ${id}: ${before} → ${mid} → ${after}`, ok: mid === !before && (after === mid ? false : true) });
    }
    // the folds this card grows as rules move between "needs you", "in force" and "switched off"
    for (const e of (await inventory(page, 'index.html')).filter((x) => x.key.startsWith('summary:card-lessons:'))) await checkSummary(page, 'index.html', e.key);
    await inventory(page, 'index.html');
    const cand = q(page, 'checkbox:lesson:QA-IMP-CAND');
    const disabled = await cand.isDisabled();
    record('index.html', 'checkbox:lesson:QA-IMP-CAND', { action: 'inspect', observed: `disabled=${disabled} (imported, never ratified: cannot become policy); gate delivers it: ${lessonsFor('write-code').includes('QA-IMP-CAND')}`, ok: disabled && !lessonsFor('write-code').includes('QA-IMP-CAND') });
    await page.close();
  }, 900_000);

  it('Recommendations: Skip/Show again, Apply/Cancel, Apply/Yes changes the project, Undo restores it, Fix all', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    await page.waitForSelector('article.rec', { timeout: STATE_WAIT_MS });
    let inv = await inventory(page, 'index.html');
    const rec = inv.find((x) => x.key.startsWith('btn:rec:') && x.key.endsWith(':skip')).key.split(':').slice(2, -1).join(':');
    const card = page.locator(`article#${rec.replace(/:/g, '\\:')}`);
    const npxSettings = path.join(fx.npxProject, '.claude', 'settings.json');
    const original = fs.readFileSync(npxSettings, 'utf8');

    await uc(page, q(page, `btn:rec:${rec}:skip`));
    const skipped = await card.evaluate((c) => c.classList.contains('is-skipped'));
    record('index.html', `btn:rec:${rec}:skip`, { action: 'click', observed: `card is-skipped=${skipped}`, ok: skipped });
    await uc(page, card.getByRole('button', { name: 'Show again' }));
    const back = !(await card.evaluate((c) => c.classList.contains('is-skipped')));
    record('index.html', `btn:rec:${rec}:show-again`, { claim: 'Show again', action: 'click', observed: `card restored=${back}`, ok: back });

    await uc(page, q(page, `btn:rec:${rec}:apply`));
    const confirmShown = await card.locator('.confirm').isVisible();
    await uc(page, card.getByRole('button', { name: 'Cancel' }));
    const idle = await card.getByRole('button', { name: /Apply/ }).isVisible();
    record('index.html', `btn:rec:${rec}:cancel`, { claim: 'Cancel', action: 'Apply… then Cancel', observed: `confirm shown=${confirmShown}; back to idle=${idle}; file unchanged=${fs.readFileSync(npxSettings, 'utf8') === original}`, ok: confirmShown && idle && fs.readFileSync(npxSettings, 'utf8') === original });

    await uc(page, card.getByRole('button', { name: /Apply/ }));
    const n0 = posts.length;
    await uc(page, card.getByRole('button', { name: 'Yes, change my computer' }));
    await card.locator('.applied, .world-moved, .rec-status').first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(500);
    const appliedText = await card.innerText();
    const changed = fs.readFileSync(npxSettings, 'utf8');
    const rewired = changed !== original && !changed.includes('npx ruflo');
    record('index.html', `btn:rec:${rec}:apply`, { claim: 'Apply… → Yes, change my computer', action: 'consent and apply', observed: `POST ${postsSince(n0).map((p) => p.url).join(',')}; npx-project hook rewired off npx=${rewired}; card: ${/Applied/.test(appliedText) ? 'Applied — and reversible' : appliedText.slice(0, 80)}`, ok: rewired && /Applied/.test(appliedText) });
    await uc(page, card.getByRole('button', { name: 'Undo this change' }));
    await card.locator('.reverted').waitFor({ timeout: STATE_WAIT_MS });
    const restored = fs.readFileSync(npxSettings, 'utf8') === original;
    record('index.html', `btn:rec:${rec}:undo-this-change`, { claim: 'Undo this change', action: 'click after apply', observed: `npx-project settings byte-identical to before=${restored}`, ok: restored });
    await uc(page, card.getByRole('button', { name: 'Offer it again' }));
    const reoffered = await card.getByRole('button', { name: /Apply/ }).isVisible();
    record('index.html', `btn:rec:${rec}:offer-it-again`, { claim: 'Offer it again', action: 'click', observed: `Apply button back=${reoffered}`, ok: reoffered });

    inv = await inventory(page, 'index.html');
    const fixKey = inv.find((x) => x.key.startsWith('btn:fixall:'))?.key;
    await uc(page, q(page, fixKey));
    const batch = page.locator('#recs-batch');
    const listed = await batch.locator('li').count();
    await uc(page, batch.getByRole('button', { name: 'Cancel' }));
    const unchanged = fs.readFileSync(npxSettings, 'utf8') === original;
    record('index.html', fixKey, { claim: 'Fix all', action: 'open confirm, Cancel', observed: `confirm listed ${listed} fix(es); Cancel left files unchanged=${unchanged}`, ok: listed >= 1 && unchanged });
    await page.reload(); await settleIndex(page); await page.waitForSelector('article.rec', { timeout: STATE_WAIT_MS }); await inventory(page, 'index.html');
    await uc(page, q(page, fixKey));
    await uc(page, page.locator('#recs-batch').getByRole('button', { name: 'Yes, fix all verified items' }));
    await page.locator('#recs-batch .form-note').waitFor({ timeout: 120_000 });
    const batchText = await page.locator('#recs-batch').innerText();
    const batchChanged = fs.readFileSync(npxSettings, 'utf8') !== original;
    await uc(page, page.getByRole('button', { name: 'Undo this change' }).first());
    await page.waitForTimeout(3000);
    const batchRestored = fs.readFileSync(npxSettings, 'utf8') === original;
    record('index.html', `btn:fixall:yes-fix-all-verified-items`, { claim: 'Yes, fix all verified items', action: 'Fix all → Yes, then the per-card undo', observed: `"${batchText.slice(0, 50)}"; file changed=${batchChanged}; undo restored=${batchRestored}`, ok: /1 applied/.test(batchText) && batchChanged && batchRestored });
    await page.close();
  }, 900_000);

  it('Savings: the smart-routing button saves routing and route-cheap obeys it', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    const inv = await inventory(page, 'index.html');
    const cta = inv.find((x) => x.key.startsWith('btn:routing-cta:'))?.key;
    await uc(page, q(page, cta));
    await page.waitForFunction(() => /Smart routing: (chosen|ON|off)/.test(document.querySelector('.mh-cta')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    const r1 = readJSON(fx.configFile)?.routing; const c1 = routeCheap();
    const off = page.locator('.mh-cta').getByRole('button', { name: 'Turn off' });
    await uc(page, off);
    await page.waitForFunction(() => /Smart routing: off/.test(document.querySelector('.mh-cta')?.innerText || ''), null, { timeout: STATE_WAIT_MS });
    const r2 = readJSON(fx.configFile)?.routing; const c2 = routeCheap();
    record('index.html', cta, { claim: 'Turn on smart routing', action: 'click', observed: `config routing=${r1}; route-cheap passes the routing gate and stops at the next one: "${c1.stderr.trim().slice(0, 70)}"`, ok: r1 === 'auto' && !/routing is off|not been enabled/i.test(c1.stderr) });
    record('index.html', 'btn:routing-cta:turn-off', { claim: 'Turn off', action: 'click', observed: `config routing=${r2}; route-cheap: "${c2.stderr.trim().slice(0, 60)}"`, ok: r2 === 'off' && /routing is off/i.test(c2.stderr) });
    await page.close();
  }, 900_000);

  it('Freshness: the ↻ button and the age chip start a real re-measure that lands', async () => {
    const page = await openPage('index.html');
    await settleIndex(page);
    await inventory(page, 'index.html');
    for (const key of ['btn:recheck', 'btn:freshness']) {
      const n0 = posts.length;
      await uc(page, q(page, key));
      let res = null;
      for (let i = 0; i < 20 && !res; i++) { await page.waitForTimeout(250); res = postsSince(n0).find((p) => p.url === '/api/refresh'); }
      let landed = false;
      try { await page.waitForFunction(() => /measured just now|as of seconds ago/.test(document.querySelector('#freshness-pill')?.innerText || ''), null, { timeout: 180_000 }); landed = true; } catch { /* reported */ }
      record('index.html', key, { action: 'click', observed: `POST /api/refresh sent=${!!res}; pill: "${await page.locator('#freshness-pill').innerText()}"`, ok: !!res && landed });
      await page.waitForTimeout(16_000); // past the server's 15s debounce
    }
    await page.close();
  }, 900_000);

  it('scope.html: view buttons, search, sortable headers, links, theme', async () => {
    const page = await openPage('scope.html');
    await page.waitForSelector('#repos-table tbody tr', { timeout: STATE_WAIT_MS });
    const inv = await inventory(page, 'scope.html');
    const firstRow = () => page.locator('#repos-table tbody tr').first().innerText();
    for (const e of inv) {
      const k = e.key;
      // a sort/search re-renders the tables; re-tag before touching an element that may have been replaced
      if (!(await q(page, k).count())) await inventory(page, 'scope.html');
      if (k.startsWith('btn:scope-view:')) {
        await uc(page, q(page, k));
        const pressed = await q(page, k).getAttribute('aria-pressed');
        record('scope.html', k, { action: 'click', observed: `aria-pressed=${pressed}; first repo row "${(await firstRow()).split('\n')[0]}"`, ok: pressed === 'true' });
      } else if (k.startsWith('th:scope-sort:')) {
        const before = await q(page, k).getAttribute('aria-sort');
        await uc(page, q(page, k));
        const after = await q(page, k).getAttribute('aria-sort');
        record('scope.html', k, { action: 'click', observed: `aria-sort ${before} → ${after}`, ok: after !== before && after !== 'none' });
      } else if (k === 'input:scope-search') {
        await q(page, k).fill('ruvector');
        const n = await page.locator('#repos-table tbody tr').count();
        const t = await firstRow();
        await q(page, k).fill('');
        record('scope.html', k, { action: 'type "ruvector", clear', observed: `${n} repo row(s), first "${t.split('\n')[0]}"`, ok: n === 1 && /ruvector/i.test(t) });
      } else if (k.startsWith('extlink:')) await checkExtLink(page, 'scope.html', k);
      else if (k.startsWith('link:skip')) { await q(page, k).focus(); await page.keyboard.press('Enter'); record('scope.html', k, { action: 'click', observed: `hash=${await page.evaluate(() => location.hash)}`, ok: (await page.evaluate(() => location.hash)) === '#main' }); }
      else if (k.startsWith('link:')) await checkLocalLink(page, 'scope.html', k);
      else if (k === 'btn:theme') {
        const a = await page.evaluate(() => document.documentElement.dataset.theme);
        await uc(page, q(page, k));
        const b = await page.evaluate(() => document.documentElement.dataset.theme);
        await uc(page, q(page, k));
        record('scope.html', k, { action: 'click ×2', observed: `${a} → ${b} → back`, ok: a !== b });
      }
    }
    // the verdict buckets are counted from the payload
    const body = await page.locator('body').innerText();
    record('scope.html', 'facts:buckets', { claim: 'current / behind / not in brain / unverified', action: 'compare with the fixture COVERAGE.json', observed: body.match(/current[\s\S]{0,40}/i)?.[0]?.replace(/\s+/g, ' ') || '', ok: /behind/i.test(body) && /ruvector/i.test(body) });
    await page.close();
  }, 900_000);

  it('tips.html, architecture.html, install pages: every control', async () => {
    for (const name of ['tips.html', 'architecture.html', 'install-architecture.html', 'install-mockup.html']) {
      const page = await openPage(name);
      await page.waitForTimeout(800);
      const inv = await inventory(page, name);
      if (!inv.length) record(name, 'page:no-controls', { claim: '(no interactive elements)', action: 'inventory', observed: 'page served HTTP 200 with zero interactive elements', ok: true });
      for (const e of inv) {
        const k = e.key;
        if (k.startsWith('summary:')) await checkSummary(page, name, k);
        else if (k === 'btn:theme') {
          const a = await page.evaluate(() => document.documentElement.dataset.theme);
          await uc(page, q(page, k));
          const b = await page.evaluate(() => document.documentElement.dataset.theme);
          await uc(page, q(page, k));
          record(name, k, { action: 'click ×2', observed: `${a} → ${b}`, ok: a !== b });
        } else if (k.startsWith('link:skip')) { await q(page, k).focus(); await page.keyboard.press('Enter'); record(name, k, { action: 'click', observed: `hash=${await page.evaluate(() => location.hash)}`, ok: (await page.evaluate(() => location.hash)) === '#main' }); }
        else if (k.startsWith('link:') || k.startsWith('anchor:')) await checkLocalLink(page, name, k);
        else if (k.startsWith('extlink:')) await checkExtLink(page, name, k);
        else if (k.startsWith('toggle:tips-depth:')) {
          // the header's visible affordance is its chevron; links/buttons inside a header stay links
          const chev = q(page, k).locator('.dc-chev');
          await page.waitForTimeout(500);
          const before = await q(page, k).getAttribute('aria-expanded');
          await uc(page, chev);
          const after = await q(page, k).getAttribute('aria-expanded');
          await uc(page, chev);
          await page.waitForTimeout(500); // the collapse animates its height; let it settle before the next header
          record(name, k, { action: 'click ×2', observed: `aria-expanded ${before} → ${after}`, ok: before !== after });
        } else if (k === 'btn:tips-expand-all') {
          const t1 = await q(page, k).innerText();
          await uc(page, q(page, k));
          const exp = await page.evaluate(() => [...document.querySelectorAll('.depth-head')].map((h) => h.getAttribute('aria-expanded')));
          const t2 = await q(page, k).innerText();
          await uc(page, q(page, k));
          record(name, k, { action: 'click ×2', observed: `"${t1}" → all ${[...new Set(exp)].join('/')} → "${t2}"`, ok: t1 !== t2 && new Set(exp).size === 1 });
        } else if (k.startsWith('checkbox:mockup:')) {
          const before = await q(page, k).isChecked();
          const count0 = await page.locator('#selCount').innerText();
          if (await q(page, k).isDisabled()) { record(name, k, { action: 'inspect', observed: 'required item, locked on by design (mockup)', verdict: 'INERT' }); continue; }
          await uc(page, q(page, k));
          const count1 = await page.locator('#selCount').innerText();
          await uc(page, q(page, k));
          record(name, k, { action: 'click ×2', observed: `checked ${before} → ${!before}; counter ${count0} → ${count1} (visual-only mockup)`, ok: count0 !== count1 });
        } else if (k.startsWith('btn:mockup:')) {
          const n0 = posts.length;
          await uc(page, q(page, k));
          record(name, k, { action: 'click', observed: `page is labelled "Mockup — nothing runs"; requests sent: ${postsSince(n0).length}`, verdict: postsSince(n0).length === 0 ? 'INERT' : 'FAIL' });
        }
      }
      await page.close();
    }
  }, 900_000);

  // A page can serve HTTP 200, have zero controls, and still be broken: on 2026-10-01 a truncated favicon
  // line on install-architecture.html left its href quote open, the parser swallowed the whole <style>
  // block into that attribute, and the page rendered unstyled while this file recorded it PASS
  // ("served HTTP 200 with zero interactive elements"). So EVERY page the console serves must (a) parse
  // its <head> to the same tags its source declares — a tag eaten by an unbalanced attribute is missing
  // from the parsed head — and (b) actually apply a stylesheet: at least one sheet with rules, and a
  // body whose computed font differs from an unstyled page's.
  it('every served page loads its stylesheet and parses its <head> intact', async () => {
    const served = fs.readdirSync(fx.consoleDir).filter((f) => f.endsWith('.html')).sort();
    expect(served, 'the pages this test clicks are exactly the pages the console serves').toEqual([...PAGES].sort());
    const blank = await ctx.newPage();
    await blank.setContent('<!doctype html><html><head></head><body>x</body></html>');
    const unstyledFont = await blank.evaluate(() => getComputedStyle(document.body).fontFamily);
    await blank.close();
    for (const name of served) {
      const page = await openPage(name);
      const raw = await (await page.request.get(new URL(name, srv.url).toString())).text();
      const res = await page.evaluate((src) => {
        // tags inside comments and inside script bodies are text, not markup
        const headSrc = src.split(/<body[\s>]/i)[0].replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');
        const parsed = new DOMParser().parseFromString(src, 'text/html');
        const lost = ['style', 'link', 'meta', 'title', 'script'].map((tag) => ({
          tag, declared: (headSrc.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length, parsed: parsed.head.querySelectorAll(tag).length,
        })).filter((t) => t.declared !== t.parsed);
        let rules = 0;
        for (const s of document.styleSheets) { try { rules += s.cssRules.length; } catch { rules += 1; } }
        return { lost, sheets: document.styleSheets.length, rules, font: getComputedStyle(document.body).fontFamily };
      }, raw);
      const ok = !res.lost.length && res.sheets > 0 && res.rules > 0 && res.font !== unstyledFont;
      record(name, 'page:stylesheet-and-head', { claim: 'the page is styled and its <head> is well formed', action: 'load; compare declared vs parsed <head> tags; inspect document.styleSheets and computed body font',
        observed: `${res.sheets} stylesheet(s), ${res.rules} rule(s); body font ${res.font} (unstyled: ${unstyledFont}); head tags lost to the parser: ${res.lost.length ? JSON.stringify(res.lost) : 'none'}`, ok });
      await page.close();
    }
    const broken = served.map((name) => rows.get(`${name}|page:stylesheet-and-head`)).filter((r) => r.verdict !== 'PASS');
    expect(broken.map((r) => `${r.page}: ${r.observed}`)).toEqual([]);
  }, 900_000);

  it('Coordinated updates: Latest/Alpha, Keep enrolls nightly, real receipt reaches Activity', async () => {
    const local = buildRnbcFixture();
    const owner = isolateDeveloperUpdateOwners(local);
    let server, page;
    try {
      server = await startRnbc(local);
      page = await openPage('index.html', server.url);
      await page.waitForSelector('#suite-update-run');
      await inventory(page, 'index.html');
      const channel = q(page, 'select:suite-update-channel');
      const initial = await channel.inputValue();
      const recommendation = await page.locator('#card-suite-update .chip').innerText();
      const absent = !fs.existsSync(owner.policy) && !schedulerEntry(local).text;
      await channel.selectOption('alpha');
      const alpha = await channel.inputValue();
      await channel.selectOption('latest');
      const latest = await channel.inputValue();
      await channel.selectOption('alpha');
      record('index.html', 'select:suite-update-channel', { claim: 'Latest (recommended) / Alpha release policy', action: 'select Alpha, Latest, Alpha',
        observed: `initial=${initial}; selected=${alpha},${latest}; recommended=${recommendation}; read/selection writes no policy or job=${absent && !fs.existsSync(owner.policy) && !schedulerEntry(local).text}`,
        ok: initial === 'latest' && alpha === 'alpha' && latest === 'latest' && /recommended/i.test(recommendation) && absent && !fs.existsSync(owner.policy) && !schedulerEntry(local).text });
      if (await q(page, 'label:suite-update-channel').count()) {
        await uc(page, q(page, 'label:suite-update-channel'));
        const focused = await channel.evaluate(element => document.activeElement === element);
        record('index.html', 'label:suite-update-channel', { action: 'click label', observed: `release-policy select focused=${focused}`, ok: focused });
      }
      const before = posts.length;
      await uc(page, q(page, 'btn:suite-update'));
      await page.waitForFunction(() => /Last update completed successfully|Last update failed/.test(document.querySelector('#suite-update-result')?.textContent || ''), null, { timeout: STATE_WAIT_MS });
      const policy = readJSON(owner.policy), receipt = readJSON(owner.receipt);
      expect(receipt?.ok, JSON.stringify({state:receipt?.state,error:receipt?.error})).toBe(true);
      if (owner.brew) {
        const brewCalls = fs.readFileSync(owner.brewLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(brewCalls.map(call => call.args)).toEqual([
          ['info', '--json=v2', '--installed'], ['update'], ['upgrade', '--formula'], ['info', '--json=v2', '--installed'],
        ]);
        const stage = receipt.maintenance.stages.find(stage => stage.owner === 'homebrew-formulas');
        expect(stage.verification.ok).toBe(true);
        expect(stage.commands).toHaveLength(4);
        expect(stage.commands.every(command => command.command === owner.brew && command.exitCode === 0 && !command.error)).toBe(true);
      }
      const registration = readJSON(path.join(local.brainHome, 'scheduler/registration.json'));
      const status = schedulerState(local);
      const activity = await page.locator('#suite-update-activity').innerText();
      const body = JSON.parse(postsSince(before).find(post => post.url === '/api/suite-update')?.body || '{}');
      const calls = fs.readFileSync(local.nightlyCallLog, 'utf8').split('\n').filter(line => /--enable-nightly/.test(line));
      const executionFiles = coordinatorExecutionFiles(local);
      expect(Object.keys(receipt.sourceSnapshot || {}).sort()).toEqual(executionFiles);
      const sameClosure = receipt?.sourceSnapshot && Object.entries(receipt.sourceSnapshot).every(([name, digest]) => registration.updateModules?.[name]?.sha256 === digest);
      record('index.html', 'btn:suite-update', { claim: 'Keep all tools updated (recommended)', action: 'click once; real authenticated POST, scheduler enrollment, coordinator completion',
        observed: `POST channel=${body.channel}; scope=${policy?.scope}; job=${registration?.identity}; mode=${registration?.mode}; enable calls=${calls.length}; scheduler=${status.state}; apply=${receipt?.mode}/${receipt?.state}; empty private prefix=${receipt?.npmIdentity?.prefix === owner.prefix}; ${executionFiles.length} module digests match=${sameClosure}; Activity=${activity.includes('completed successfully')}`,
        ok: body.channel === 'alpha' && policy?.channel === 'alpha' && policy?.scope === 'all' && registration?.identity === 'com.ruvnet.brain-update' && registration?.mode === 'developer-suite'
          && calls.length === 1 && status.state === 'on' && receipt?.ok === true && receipt?.mode === 'apply' && receipt?.finishedAt && receipt?.npmIdentity?.prefix === owner.prefix
          && Object.keys(receipt.sourceSnapshot || {}).length === executionFiles.length && sameClosure && activity.includes('completed successfully') });
      const inv = await inventory(page, 'index.html');
      for (const entry of inv.filter(entry => entry.key.startsWith('summary:card-activity:') && /update-receipt|tools-preserved/.test(entry.key))) await checkSummary(page, 'index.html', entry.key);
      expect(rows.get('index.html|select:suite-update-channel')?.verdict).toBe('PASS');
      expect(rows.get('index.html|btn:suite-update')?.verdict).toBe('PASS');
    } finally { await page?.close(); await server?.stop(); cleanupRnbc(local); }
  }, 300_000);

  it('every element found has a ledger row; nothing failed; no JS errors or failed requests', () => {
    const missing = [...found.keys()].filter((id) => !rows.has(id));
    const unclassified = [...found.keys()].filter((id) => id.includes('UNCLASSIFIED'));
    const failed = [...rows.values()].filter((r) => r.verdict === 'FAIL');
    expect(unclassified, 'elements no rule can name').toEqual([]);
    expect(missing, 'elements with no ledger row').toEqual([]);
    expect(failed.map((r) => `${r.page} ${r.key}: ${r.observed}`)).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(failedRequests.filter((f) => !/api\.github\.com|github\.com\/.*releases/.test(f))).toEqual([]);
  });
});
