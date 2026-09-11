/**
 * advocacy-route-budget.test.mjs — the COLD-START budget, measured at the process boundary.
 *
 * WHY COLD, AND WHY NOT IN-PROCESS. A warm `classify()` call returns in microseconds and proves
 * nothing about the path that actually runs: on every real prompt this producer is a FRESH `node`
 * process spawned by unprompted-runtime.mjs. The cost that matters is node boot + ESM graph +
 * filesystem probes, and it is only visible from outside. Measuring the warm path here would be a
 * test that cannot fail on the thing it claims to guard.
 *
 * THE DERIVED HEADROOM, stated so it can be checked rather than assumed:
 *   hooks.json timeout          3000 ms   (continuity's registration)
 *   producer budget (BUDGET_MS) 1500 ms   (this file's assertion, p95)
 *   → 1500 ms of headroom for the runtime itself, the lesson producer, and anticipate.sh.
 *
 * The assertion is on p95 over 20 invocations, not on a single best case, because one fast run on an
 * idle machine is a fact about the machine.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROUTE = path.join(ROOT, 'plugin', 'scripts', 'advocacy-route.mjs');

const RUNS = 20;
const P95_CEILING_MS = 1500;
const HOOK_TIMEOUT_MS = 3000;   // what continuity registers in hooks.json

/** The REAL Claude Code UserPromptSubmit payload shape, not a trimmed fixture. */
const payload = (prompt, sessionId) => JSON.stringify({
  session_id: sessionId,
  transcript_path: '/tmp/does-not-exist.jsonl',
  cwd: ROOT,
  hook_event_name: 'UserPromptSubmit',
  prompt,
});

function coldRun(dir, prompt, i) {
  const started = Date.now();
  const r = spawnSync('node', [ROUTE], {
    input: payload(prompt, `budget-${i}`),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      RUVNET_EMIT_CANDIDATES: '1',
      RUVNET_ADVOCACY_ROUTE_STATE: path.join(dir, `state-${i}.json`),
      RUVNET_ADVOCACY_OUTCOMES: path.join(dir, `outcomes-${i}.jsonl`),
    },
  });
  return { ms: Date.now() - started, code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('cold-start budget: 20 fresh node invocations with the real hook payload', () => {
  it(`p95 ≤ ${P95_CEILING_MS} ms, and every run exits 0`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advocacy-budget-'));
    const prompt = 'tests are flaky and we don\'t know what\'s untested — trustworthy coverage and real quality gates';
    const times = [];
    try {
      for (let i = 0; i < RUNS; i++) {
        const r = coldRun(dir, prompt, i);
        expect(r.code, `run ${i} exited ${r.code}: ${r.stderr}`).toBe(0);
        // Each run has its own fresh state, so each must actually DO the work — a run that short-
        // circuits on "already offered" would measure nothing.
        expect(r.stdout, `run ${i} emitted no candidate`).toContain('"channel":"advocacy"');
        times.push(r.ms);
      }
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

    times.sort((a, b) => a - b);
    const p95 = times[Math.min(times.length - 1, Math.ceil(0.95 * times.length) - 1)];
    // Printed so the report can quote a measurement rather than a verdict.
    // eslint-disable-next-line no-console
    console.log(`advocacy-route cold start over ${RUNS} runs: min=${times[0]}ms median=${times[Math.floor(times.length / 2)]}ms p95=${p95}ms max=${times[times.length - 1]}ms`);
    expect(p95, `p95 ${p95}ms exceeds the ${P95_CEILING_MS}ms producer budget`).toBeLessThanOrEqual(P95_CEILING_MS);
    expect(p95).toBeLessThan(HOOK_TIMEOUT_MS);   // and strictly inside the hook timeout it lives under
  }, 120000);

  it('a negative-control prompt is silent AND fast — silence must not be a timeout in disguise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advocacy-budget-n-'));
    try {
      const r = coldRun(dir, 'rename getUsr to getUser everywhere', 'n');
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');       // byte-exact: nothing at all
      expect(r.ms).toBeLessThan(P95_CEILING_MS);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }, 60000);

  it('the kill switch is honoured and costs nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'advocacy-budget-k-'));
    try {
      const r = spawnSync('node', [ROUTE], {
        input: payload('tests are flaky and coverage is unknown and untested', 'k'),
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          RUVNET_ADVOCACY_ROUTE: '0',
          RUVNET_EMIT_CANDIDATES: '1',
          RUVNET_ADVOCACY_ROUTE_STATE: path.join(dir, 'state.json'),
          RUVNET_ADVOCACY_OUTCOMES: path.join(dir, 'outcomes.jsonl'),
        },
      });
      expect(r.status).toBe(0);
      expect(r.stdout ?? '').toBe('');
      expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);   // it wrote nothing at all
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }, 60000);
});
