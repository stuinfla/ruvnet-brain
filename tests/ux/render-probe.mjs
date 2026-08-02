// render-probe.mjs — MEASURED time-to-visible for the console and the tips page.
//
// What it measures (the owner's ask, verbatim intent): "How long it takes for the console and the
// tips page to show up on the computer." We start the REAL console server, drive a REAL browser
// (Playwright chromium, already installed), and time server-ready → the key content actually PAINTED
// (not merely "response received"): the console's #card-capabilities and the tips page's hero + first
// section. Every number is captured on THIS run — none is asserted from memory.
//
// MODEL-FREE: this probe drives a browser and an HTTP server. It calls no LLM, uses no API key, and
// touches no account. It is deterministic timing, which is the cleanest possible satisfaction of the
// owner's "no API keys" rule for the QE suite.
//
// It runs the console WARM (against a pre-warmed temp HOME cache) so the number is the common-case
// "open the console" experience, not a one-time cold scan. Cold-start behaviour (the "it's live"
// completion signal) is a SEPARATE probe — command-probe.mjs — because it measures a different thing.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Playwright is resolved via createRequire (CJS resolution), NOT a bare ESM `import`. Reason, verified
// live 2026-07-24: on this Mac playwright is a GLOBAL install (~/.npm-global/lib/node_modules), and
// Node's ESM bare-specifier resolver does not consult the global folder — only CJS require does. In CI
// playwright is a node_modules devDependency, which createRequire also finds. So this one line makes
// the probe portable across "global on the dev box" and "local in CI" without a machine-specific path.
const require = createRequire(import.meta.url);
let chromium = null, playwrightLoadError = null;
try { ({ chromium } = require('playwright')); }
catch (e) { try { ({ chromium } = require('@playwright/test')); } catch (e2) { playwrightLoadError = e.message; } }

async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    // Local contributors often have system Chrome but not Playwright's matching downloaded Chromium.
    // CI still installs the pinned browser. Exercising the real DOM through system Chrome is stronger
    // than silently skipping the browser gate on a developer machine.
    const candidates = process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!executablePath) throw bundledError;
    return chromium.launch({ headless: true, executablePath });
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CONSOLE_MJS = path.join(REPO, 'scripts', 'onboarding-console.mjs');

/** Poll GET / until the server answers 200 with the console HTML, or time out. Returns ms-to-ready. */
function waitForReady(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const tick = () => {
      if (settled) return;
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
        let b = '';
        res.on('data', (c) => {
          if (settled) return;
          b += c;
          if (res.statusCode === 200 && /RuvNet Brain/.test(b)) {
            finish(resolve, Date.now() - start);
            res.destroy();
          } else if (b.length > 65536) {
            b = b.slice(-65536);
          }
        });
        res.on('end', () => {
          if (settled) return;
          if (res.statusCode === 200 && /RuvNet Brain/.test(b)) finish(resolve, Date.now() - start);
          else retry();
        });
        res.on('error', () => { if (!settled) retry(); });
      });
      req.on('error', () => { if (!settled) retry(); });
      req.on('timeout', () => { req.destroy(); if (!settled) retry(); });
    };
    const retry = () => {
      if (settled) return;
      if (Date.now() - start > timeoutMs) finish(reject, new Error('server never became ready'));
      else setTimeout(tick, 150);
    };
    tick();
  });
}

/** Start the console server on `port` with an isolated HOME, and pre-warm its cache if requested. */
function startConsole(port, home, cwd = REPO) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CONSOLE_PORT: String(port),
    RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1',
  };
  const child = spawn(process.execPath, [CONSOLE_MJS, '--serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd });
  // Drain and mirror the isolated fixture's startup output to stderr. The parent UX runner captures
  // only the last stages on failure, so a bind/import crash is diagnosable without polluting JSON.
  child.stdout.on('data', (chunk) => process.stderr.write(`[render-console:stdout] ${String(chunk)}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[render-console:stderr] ${String(chunk)}`));
  child.on('exit', (code, signal) => process.stderr.write(`[render-console:exit] code=${code} signal=${signal}\n`));
  return child;
}

/** Pre-warm the cache in the temp HOME by running --refresh-cache once, so the render is warm-path. */
function prewarm(home, cwd = REPO) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const child = spawn(process.execPath, [CONSOLE_MJS, '--refresh-cache'], { env, stdio: 'ignore', cwd });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve();
    };
    child.on('exit', finish);
    child.on('error', finish);
    // State is the only cache this browser control gate needs. It is written first; waiting for the
    // later machine-wide fleet scan made a nominal 30s browser gate depend on a permitted 60s setup
    // operation. Stop the disposable fixture child as soon as state is ready.
    const stateCache = path.join(home, '.claude', 'ruvnet-brain', 'state-cache.json');
    const poll = setInterval(() => {
      if (!fs.existsSync(stateCache)) return;
      try { child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
      finish();
    }, 50);
    const timer = setTimeout(() => {
      try { child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
      finish();
    }, 10_000);
  });
}

async function timeToSelector(browser, url, selector, label) {
  const page = await browser.newPage();
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
  const ms = Date.now() - t0;
  await page.close();
  return { label, selector, ms };
}

export async function runRenderProbe() {
  const stage = (name) => process.stderr.write(`[render-probe] ${name}\n`);
  if (!chromium) {
    return { results: [], notes: [`playwright not loadable (${playwrightLoadError}) — render probe NOT RUN, never faked as pass`] };
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uxqe-home-'));
  fs.mkdirSync(path.join(home, '.claude', 'ruvnet-brain'), { recursive: true });
  const fixtureProject = path.join(home, 'Code', 'dirty-console-fixture');
  fs.mkdirSync(path.join(fixtureProject, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fixtureProject, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: 'npx ruflo@latest hooks pre-task' }],
      }],
    },
  }, null, 2)}\n`);
  const port = 7500 + (process.pid % 400);   // avoid the user's live 7411; vary per run without Date/random
  let server, browser;
  const results = [];
  const notes = [];
  const acceptance = [];
  try {
    stage('prewarm:start');
    await prewarm(home, fixtureProject);   // make the render measure the WARM common case
    stage('prewarm:done');
    server = startConsole(port, home, fixtureProject);
    stage('server:spawned');
    const readyMs = await waitForReady(port);
    stage('server:ready');
    results.push({ label: 'server-ready', selector: 'GET / → 200', ms: readyMs });
    const base = `http://127.0.0.1:${port}`;

    browser = await launchChromium();
    stage('browser:launched');
    // Chromium's first renderer process is a browser-startup cost, not console render time. On a
    // loaded Windows runner it added 7.9s to one otherwise 376–1031ms page series. Prime one blank
    // renderer before starting the user-facing clock, matching the real "open this in my already
    // running browser" path this warm-console probe claims to measure.
    const warmPage = await browser.newPage();
    await warmPage.goto('about:blank');
    await warmPage.close();
    stage('browser:warmed');
    // 1a — console time-to-visible: #card-capabilities painted
    results.push(await timeToSelector(browser, `${base}/`, '#card-capabilities', 'console time-to-visible'));
    stage('console:visible');

    // The release contract is behavioral, not a source-string check: load the rendered console,
    // exercise both ordinary settings through their real HTTP handlers, reload, and prove the
    // chosen values survived. The HOME above is disposable, so this never touches user state.
    const consolePage = await browser.newPage();
    const initialStateStartedAt = Date.now();
    const initialStateResponsePromise = consolePage.waitForResponse((response) => (
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/state'
    ));
    await consolePage.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await initialStateResponsePromise;
    const initialStateResponseMs = Date.now() - initialStateStartedAt;
    await consolePage.waitForSelector('#field-provider', { state: 'attached' });
    const initialStateReadyMs = Date.now() - initialStateStartedAt;
    await consolePage.locator('#card-settings > summary').click();
    await consolePage.waitForSelector('#field-provider', { state: 'visible' });
    await consolePage.waitForSelector('#field-advocacy', { state: 'visible' });
    const surface = await consolePage.evaluate(() => ({
      fieldIds: [...document.querySelectorAll('.field[id^="field-"]')].map((node) => node.id).sort(),
      unavailable: [...document.querySelectorAll('.settings-unavailable-list li b')].map((node) => node.textContent.trim()),
      brainSwitches: document.querySelectorAll('.bp-switch[role="switch"]').length,
      profileChoices: [...document.querySelectorAll('input[name="brain-profile"]')].map((node) => node.value).sort(),
    }));
    const expectedFields = [
      'field-advocacy',
      'field-autoApply',
      'field-learningScope',
      'field-newProjectDefaults',
      'field-openrouterKey',
      'field-provider',
      'field-qeFleet',
      'field-routing',
    ];
    if (process.platform === 'darwin') expectedFields.push('field-nightly');
    expectedFields.sort();
    acceptance.push({
      label: 'only consumer-backed settings are actionable',
      pass: JSON.stringify(surface.fieldIds) === JSON.stringify(expectedFields),
      detail: surface.fieldIds.join(', '),
    });
    acceptance.push({
      label: 'all unsupported settings are visibly disclosed',
      pass: JSON.stringify(surface.unavailable)
        === JSON.stringify(process.platform === 'darwin' ? [] : ['Nightly brain refresh']),
      detail: `${surface.unavailable.length}: ${surface.unavailable.join(', ')}`,
    });
    acceptance.push({
      label: 'brain power and both RVF profiles are surfaced',
      pass: surface.brainSwitches === 1
        && JSON.stringify(surface.profileChoices) === JSON.stringify(['complete', 'ruvector']),
      detail: `${surface.brainSwitches} switch; profiles ${surface.profileChoices.join(', ')}`,
    });

    const settingsStarted = Date.now();
    await consolePage.locator('#field-provider input[value="codex"]').check();
    await consolePage.locator('form:has(#field-provider) button[type="submit"]').click();
    await consolePage.locator('form:has(#field-provider) .form-note.n-ok').waitFor();
    await consolePage.locator('#field-advocacy input[value="5"]').check();
    await consolePage.locator('form:has(#field-advocacy) button[type="submit"]').click();
    await consolePage.locator('form:has(#field-advocacy) .form-note.n-ok').waitFor();
    const recommendationReloadStartedAt = Date.now();
    const recommendationStateResponsePromise = consolePage.waitForResponse((response) => (
      response.request().method() === 'GET'
      && new URL(response.url()).pathname === '/api/state'
    ));
    await consolePage.reload({ waitUntil: 'domcontentloaded' });
    await recommendationStateResponsePromise;
    const recommendationStateResponseMs = Date.now() - recommendationReloadStartedAt;
    await consolePage.waitForSelector('#field-provider input[value="codex"]:checked', { state: 'attached' });
    await consolePage.waitForSelector('#field-advocacy input[value="5"]:checked', { state: 'attached' });
    acceptance.push({
      label: 'provider and advocacy choices persist through real handlers and reload',
      pass: Date.now() - settingsStarted < 4_000,
      detail: `codex + advocacy 5 saved and read back in ${Date.now() - settingsStarted}ms`,
    });
    stage('console:settings-accepted');

    // The isolated fixture carries one real npx-wiring defect on every OS. HOME and USERPROFILE
    // point to the same fixture root above, so a missing card is a product failure, not a platform
    // condition the oracle may silently accept.
    await consolePage.waitForSelector('article.rec', { state: 'attached' });
    const recommendationFetchAndRenderMs = Date.now() - recommendationReloadStartedAt;
    stage('console:recommendation-attached');
    const recommendations = await consolePage.locator('article.rec').count();
    const fixAllVisibilityStartedAt = Date.now();
    await consolePage.locator('#card-recs').evaluate((node) => { node.open = true; });
    const fixAllButton = consolePage.getByRole('button', { name: /^Fix all \(/ });
    if (recommendations > 0) await fixAllButton.waitFor({ state: 'visible' });
    const fixAllVisibilityMs = Date.now() - fixAllVisibilityStartedAt;
    stage('console:fix-all-visible');
    const fixAll = await fixAllButton.count();
    acceptance.push({
      label: 'Fix all is present whenever verified recommendations exist',
      pass: recommendations === 0 || fixAll === 1,
      detail: `${recommendations} recommendations; ${fixAll} Fix all button`,
    });
    if (recommendations > 0) {
      const fixAllClickabilityStartedAt = Date.now();
      await fixAllButton.click({ trial: true });
      const fixAllClickabilityMs = Date.now() - fixAllClickabilityStartedAt;
      const fixAllStarted = Date.now();
      const confirmationOpenedStartedAt = Date.now();
      await fixAllButton.click();
      const confirmButton = consolePage.getByRole('button', { name: 'Yes, fix all verified items' });
      await confirmButton.waitFor({ state: 'visible' });
      const openConfirmationMs = Date.now() - confirmationOpenedStartedAt;
      const applyResponsePromise = consolePage.waitForResponse((response) => (
        response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/apply'
      ));
      const applyClickStarted = Date.now();
      await confirmButton.click();
      const applyResponse = await applyResponsePromise;
      const confirmationClickToResponseMs = Date.now() - applyClickStarted;
      const endpoint = await applyResponse.json();
      const responseReceivedAt = Date.now();
      await consolePage.getByText(/applied; .* skipped or failed\./).waitFor();
      const responseToRenderMs = Date.now() - responseReceivedAt;
      const resultVerificationStartedAt = Date.now();
      const applied = await consolePage.getByText('Applied by Fix all — and reversible.').count();
      const undoButtons = await consolePage.getByRole('button', { name: 'Undo this change' }).count();
      const resultVerificationMs = Date.now() - resultVerificationStartedAt;
      const endpointTimings = endpoint?.timings;
      const timingKeys = ['revalidationMs', 'undoJournalMs', 'childRemedyMs', 'totalMs'];
      const hasEndpointTimings = timingKeys.every((key) => Number.isFinite(endpointTimings?.[key]) && endpointTimings[key] >= 0);
      const fixAllMs = Date.now() - fixAllStarted;
      const accountedFixAllMs = openConfirmationMs + confirmationClickToResponseMs + responseToRenderMs + resultVerificationMs;
      const unattributedMs = Math.max(0, fixAllMs - accountedFixAllMs);
      acceptance.push({
        label: 'Fix all executes the real batch endpoint and returns per-item undo',
        pass: applied > 0 && undoButtons === applied && hasEndpointTimings && fixAllMs < 4_000,
        detail: hasEndpointTimings
          ? `${applied} applied cards; ${undoButtons} undo buttons; ${fixAllMs}ms Fix all total (confirmation ${openConfirmationMs}ms, confirm click→response ${confirmationClickToResponseMs}ms, response→render ${responseToRenderMs}ms, verification ${resultVerificationMs}ms, unattributed ${unattributedMs}ms); server ready ${readyMs}ms; initial state response/ready ${initialStateResponseMs}/${initialStateReadyMs}ms; recommendation state/render ${recommendationStateResponseMs}/${recommendationFetchAndRenderMs}ms; Fix all visible/clickable ${fixAllVisibilityMs}/${fixAllClickabilityMs}ms; endpoint total ${endpointTimings.totalMs}ms (revalidation ${endpointTimings.revalidationMs}ms, undo journal ${endpointTimings.undoJournalMs}ms, child remedy ${endpointTimings.childRemedyMs}ms)`
          : `${applied} applied cards; ${undoButtons} undo buttons; ${fixAllMs}ms total; /api/apply timing receipt missing`,
        timings: {
          serverReadyMs: readyMs,
          initialState: {
            responseMs: initialStateResponseMs,
            readyMs: initialStateReadyMs,
          },
          recommendation: {
            stateResponseMs: recommendationStateResponseMs,
            fetchAndRenderMs: recommendationFetchAndRenderMs,
          },
          fixAll: {
            visibilityMs: fixAllVisibilityMs,
            clickabilityMs: fixAllClickabilityMs,
            openConfirmationMs,
            confirmationClickToResponseMs,
            responseToRenderMs,
            resultVerificationMs,
            unattributedMs,
            totalMs: fixAllMs,
          },
          endpoint: endpointTimings,
        },
      });
      if (undoButtons > 0) {
        await consolePage.getByRole('button', { name: 'Undo this change' }).first().click();
        await consolePage.getByText('Reverted').first().waitFor();
        acceptance.push({
          label: 'Fix all per-item undo restores the disposable fixture',
          pass: true,
          detail: 'first applied item reverted through /api/undo',
        });
      }
    }
    stage('console:fix-all-accepted');
    await consolePage.close();
    stage('console:controls-accepted');
    // 1b — tips time-to-visible: hero + first section painted (grounded selectors from console/tips.html)
    results.push(await timeToSelector(browser, `${base}/tips`, '.hero-scene', 'tips time-to-visible (hero)'));
    stage('tips-hero:visible');
    results.push(await timeToSelector(browser, `${base}/tips`, '#inventory', 'tips first-section'));
    stage('tips-inventory:visible');
  } catch (e) {
    notes.push(`render probe error: ${e.message}`);
  } finally {
    stage('cleanup:start');
    try { if (browser) await browser.close(); } catch {}
    try { if (server) server.kill(); } catch {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    stage('cleanup:done');
  }
  return { results, acceptance, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('render-probe.mjs')) {
  runRenderProbe().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.notes.length ? 1 : 0); });
}
