// console-apply-timings.test.mjs — a real console apply must disclose where its time went.
//
// This starts the actual console server against an explicit, isolated console root and applies the same one-item
// npx-hook reconciliation used by the UX probe. The response may expose durations only: no paths,
// command output, undo token, or user configuration is accepted as timing telemetry.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleFixtureEnvironment } from '../helpers/console-fixture-environment.mjs';
import { runRenderProbe } from '../ux/render-probe.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONSOLE = path.join(REPO, 'scripts', 'onboarding-console.mjs');
const RENDER_PROBE = path.join(REPO, 'tests', 'ux', 'render-probe.mjs');
const FIXTURE_ENVIRONMENT = path.join(REPO, 'tests', 'helpers', 'console-fixture-environment.mjs');

let fixtureRoot;
let project;
let server;
let port;
let token;

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = http.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const reserved = listener.address().port;
      listener.close((error) => error ? reject(error) : resolve(reserved));
    });
  });
}

function request({ method, pathname, body = null }) {
  return new Promise((resolve, reject) => {
    const encoded = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: encoded == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.once('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${pathname} timed out`)));
    if (encoded != null) req.write(encoded);
    req.end();
  });
}

async function waitForConsole() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const page = await request({ method: 'GET', pathname: '/' });
      if (page.status === 200) return page.text;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error('console did not become ready');
}

beforeAll(async () => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'console-apply-timings-root-'));
  project = path.join(fixtureRoot, 'Code', 'dirty-console-fixture');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: 'npx ruflo@latest hooks pre-task' }],
      }],
    },
  }, null, 2)}\n`);
  port = await reservePort();
  server = spawn(process.execPath, [CONSOLE, '--serve'], {
    cwd: project,
    env: consoleFixtureEnvironment(fixtureRoot, { extras: {
      CONSOLE_PORT: String(port),
      RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1',
    } }),
    stdio: 'ignore',
  });
  const page = await waitForConsole();
  const match = page.match(/window\.__CONSOLE_TOKEN__=("[0-9a-f]{48}")/);
  expect(match, 'the real console page must carry this server instance token').toBeTruthy();
  token = JSON.parse(match[1]);
}, 45_000);

afterAll(() => {
  try { if (server && !server.killed) server.kill('SIGKILL'); } catch {}
  try { if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true }); } catch {}
});

describe('/api/apply timing receipt', () => {
  it('returns numeric phase timings for the real revalidation, undo journal, and remedy', async () => {
    const response = await request({
      method: 'POST',
      pathname: '/api/apply',
      body: { token, ids: ['reconcile:dirty-console-fixture'] },
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.text);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({ id: 'reconcile:dirty-console-fixture', ok: true });
    expect(body.timings).toEqual({
      revalidationMs: expect.any(Number),
      undoJournalMs: expect.any(Number),
      childRemedyMs: expect.any(Number),
      totalMs: expect.any(Number),
    });
    for (const value of Object.values(body.timings)) expect(value).toBeGreaterThanOrEqual(0);
    expect(body.timings.totalMs).toBeGreaterThanOrEqual(body.timings.revalidationMs);
    expect(body.timings.totalMs).toBeGreaterThanOrEqual(body.timings.undoJournalMs);
    expect(body.timings.totalMs).toBeGreaterThanOrEqual(body.timings.childRemedyMs);
  }, 45_000);

  it('reports the real browser click-to-response and response-to-render phases', async () => {
    const probe = await runRenderProbe();
    expect(probe.notes).toEqual([]);
    const row = probe.acceptance.find((candidate) => candidate.label === 'Fix all executes the real batch endpoint and returns per-item undo');
    expect(row, 'the real browser flow must reach Fix all').toBeTruthy();
    expect(row.timings).toEqual({
      serverReadyMs: expect.any(Number),
      initialState: {
        responseMs: expect.any(Number),
        readyMs: expect.any(Number),
      },
      recommendation: {
        stateResponseMs: expect.any(Number),
        fetchAndRenderMs: expect.any(Number),
      },
      preClick: {
        visibilityMs: expect.any(Number),
        readinessMs: expect.any(Number),
        readinessScrollDeltaPx: 0,
        visible: true,
        enabled: true,
      },
      fixAll: {
        openConfirmationMs: expect.any(Number),
        actualClickScrollDeltaPx: expect.any(Number),
        confirmationClickToResponseMs: expect.any(Number),
        responseToRenderMs: expect.any(Number),
        resultVerificationMs: expect.any(Number),
        unattributedMs: expect.any(Number),
        totalMs: expect.any(Number),
      },
      endpoint: {
        revalidationMs: expect.any(Number),
        undoJournalMs: expect.any(Number),
        childRemedyMs: expect.any(Number),
        totalMs: expect.any(Number),
      },
    });
    for (const value of [
      row.timings.serverReadyMs,
      row.timings.initialState.responseMs,
      row.timings.initialState.readyMs,
      row.timings.recommendation.stateResponseMs,
      row.timings.recommendation.fetchAndRenderMs,
      row.timings.preClick.visibilityMs,
      row.timings.preClick.readinessMs,
      ...Object.values(row.timings.fixAll),
    ].filter((value) => typeof value === 'number')) expect(value).toBeGreaterThanOrEqual(0);
    const accounted = row.timings.fixAll.openConfirmationMs
      + row.timings.fixAll.confirmationClickToResponseMs
      + row.timings.fixAll.responseToRenderMs
      + row.timings.fixAll.resultVerificationMs
      + row.timings.fixAll.unattributedMs;
    expect(row.timings.fixAll.totalMs).toBe(accounted);
  }, 60_000);

  it('forbids trial clicks, which create a second harness-only auto-scroll', () => {
    const source = fs.readFileSync(RENDER_PROBE, 'utf8');
    expect(source).not.toMatch(/\.click\(\s*\{\s*trial\s*:\s*true\s*\}\s*\)/);
    expect(source.match(/fixAllButton\.click\(/g)).toHaveLength(1);
  });

  it('uses the explicit console-root fixture contract instead of redefining process home', () => {
    const sources = [
      fs.readFileSync(RENDER_PROBE, 'utf8'),
      fs.readFileSync(CONSOLE, 'utf8'),
      fs.readFileSync(FIXTURE_ENVIRONMENT, 'utf8'),
    ];
    expect(sources[0]).toContain("from '../helpers/console-fixture-environment.mjs'");
    expect(sources[0].match(/consoleFixtureEnvironment\(fixtureRoot\)/g)).toHaveLength(2);
    expect(sources[1]).toContain('RUVNET_CONSOLE_ROOT');
    expect(sources[2]).toContain('RUVNET_CONSOLE_ROOT');
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:HOME|USERPROFILE|CODEX_HOME)\s*:/);
    }
  });
});
