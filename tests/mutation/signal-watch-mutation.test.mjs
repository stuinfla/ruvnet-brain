// tests/mutation/signal-watch-mutation.test.mjs — ADR-058 §D3 "the external-signal watch plane".
// The falsifiability proof: "a test that cannot fail on broken code is not a test" (house rule).
// Each mutant below takes the REAL file, applies ONE targeted, named mutation (the exact break named
// in the ADR), and asserts the SAME assertion that passes on the real file now FAILS on the mutant —
// same idiom as tests/mutation/proactivity-detector-mutation.test.mjs's withMutant().
//
//   M-W1 (headline) — delete the SessionStart core consumer call -> the CI-red line vanishes.
//   M-W2            — break the SessionStart core's transition-dedupe guard -> green speaks.
//   M-W3            — treat a poller API error as green -> the rate-limited debt resolves 'success'.
//   M-W4            — stop reading tool_response in the observer -> a recorded vercel exit-1 envelope
//                      is silently ignored.
//
// Mutants are written as SIBLING files (same directory as the original, so relative imports/`dirname
// "$0"` lookups keep resolving) and removed in a finally + afterEach, never left behind on a crash.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmHome } from '../helpers/reap-detached.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pollOnce } from '../../scripts/signal-watch.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SESSION_HOOK = path.join(REPO_ROOT, 'plugin/scripts/session-start-core.mjs');
const POLLER = path.join(REPO_ROOT, 'scripts/signal-watch.mjs');
const OBSERVER = path.join(REPO_ROOT, 'plugin/scripts/signal-watch.mjs');

const MUTANT_SESSION_HOOK = path.join(REPO_ROOT, 'plugin/scripts/_mutant-session-start-core.mjs');
const MUTANT_POLLER = path.join(REPO_ROOT, 'scripts', '_mutant-signal-watch.mjs');
const MUTANT_OBSERVER = path.join(REPO_ROOT, 'plugin/scripts', '_mutant-signal-watch.mjs');

function writeMutant(realPath, mutantPath, mutate) {
  const src = fs.readFileSync(realPath, 'utf8');
  const mutated = mutate(src);
  if (mutated === src) {
    throw new Error(`mutation changed nothing in ${realPath} — the target string moved; this would run an UNMUTATED copy and pass for the wrong reason.`);
  }
  fs.writeFileSync(mutantPath, mutated);
}

const cleanupMutants = () => {
  for (const p of [MUTANT_SESSION_HOOK, MUTANT_POLLER, MUTANT_OBSERVER]) fs.rmSync(p, { force: true });
};
afterEach(cleanupMutants);

let tmp;
let tmpHome;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-mutation-')));
  tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'signal-mutation-home-')));
  const cacheDir = path.join(tmpHome, '.cache', 'ruvnet-brain');
  fs.mkdirSync(cacheDir, { recursive: true });
  const now = String(Math.floor(Date.now() / 1000));
  fs.writeFileSync(path.join(cacheDir, '.stack-versions-checked'), now);
  fs.writeFileSync(path.join(cacheDir, '.last-update-check'), now);
});
afterEach(() => {
  rmHome(tmpHome, tmp);
});

function signalDir() { return path.join(tmpHome, '.cache', 'ruvnet-brain', 'external-signals'); }

function seedPushDebt(repo, ref) {
  fs.mkdirSync(signalDir(), { recursive: true });
  fs.writeFileSync(path.join(signalDir(), 'pending.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), kind: 'git-push', repo, ref, toolUseId: 't1', sessionId: 's1',
  }) + '\n');
}

function writeGhFixture(name, content) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(content));
  return p;
}

function runSignalSurface(hookFile, { fixturePath } = {}) {
  const statusFile = path.join(signalDir(), 'ci-status.json');
  const surfacedFile = path.join(signalDir(), 'surfaced.json');
  pollOnce({
    pendingFile: path.join(signalDir(), 'pending.jsonl'),
    statusFile,
    fixturePath,
  });
  const r = spawnSync(process.execPath, [hookFile], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      RUVNET_SIGNAL_DIR: signalDir(),
      RUVNET_BRAIN_METER: '0',
      CLAUDE_PLUGIN_ROOT: path.join(REPO_ROOT, 'plugin'),
    },
  });
  const signalLines = String(r.stdout || '').split('\n').filter((line) =>
    /external signal/i.test(line) || line.startsWith('Workflow '));
  return {
    status: r.status,
    stdout: signalLines.length ? `${signalLines.join('\n')}\n` : '',
    stderr: r.stderr ?? '',
  };
}

describe('M-W1 (headline) — delete the SessionStart core consumer call', () => {
  it('BASELINE: real SessionStart core surfaces the CI-red line with ZERO user input', () => {
    seedPushDebt('stuinfla/ruvnet-brain', 'a'.repeat(40));
    const fixturePath = writeGhFixture('gh-failure.json', [{ status: 'completed', conclusion: 'failure', workflowName: 'ci' }]);
    const out = runSignalSurface(SESSION_HOOK, { fixturePath });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('EXTERNAL SIGNAL: CI is RED');
  });

  it('MUTANT: deleting the consumer block -> the red line VANISHES (this repo\'s own 2026-07-27 incident, replayed)', () => {
    writeMutant(SESSION_HOOK, MUTANT_SESSION_HOOK, (src) => {
      const call = 'surfaceSignals({ env, cwd, stateDir, hookDir, emit, now });';
      if (!src.includes(call)) throw new Error('SessionStart signal consumer call moved');
      return src.replace(call, 'void 0; // MUTANT: signal consumer deleted');
    });
    seedPushDebt('stuinfla/ruvnet-brain', 'a'.repeat(40));
    const fixturePath = writeGhFixture('gh-failure.json', [{ status: 'completed', conclusion: 'failure', workflowName: 'ci' }]);
    const out = runSignalSurface(MUTANT_SESSION_HOOK, { fixturePath });
    expect(out.status).toBe(0); // still never blocks a session — the mutant only silences the alarm
    expect(out.stdout).not.toContain('EXTERNAL SIGNAL');
  });
});

describe('M-W2 — break transition-dedupe so green speaks', () => {
  it('BASELINE: a fresh all-green fixture (never surfaced red before) emits ZERO bytes', () => {
    seedPushDebt('stuinfla/ruvnet-brain', 'b'.repeat(40));
    const fixturePath = writeGhFixture('gh-success.json', [{ status: 'completed', conclusion: 'success', workflowName: 'ci' }]);
    const out = runSignalSurface(SESSION_HOOK, { fixturePath });
    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain('EXTERNAL SIGNAL');
    expect(out.stdout).not.toContain('external signal');
  });

  it('MUTANT: forcing the CLOSE guard to always-true makes an un-surfaced green speak anyway', () => {
    writeMutant(SESSION_HOOK, MUTANT_SESSION_HOOK, (src) => {
      const needle = 'if (surfaced.redRepo[debt.repo]) {';
      if (!src.includes(needle)) throw new Error('transition-dedupe guard text moved');
      return src.replace(needle, 'if (true) {');
    });
    seedPushDebt('stuinfla/ruvnet-brain', 'b'.repeat(40));
    const fixturePath = writeGhFixture('gh-success.json', [{ status: 'completed', conclusion: 'success', workflowName: 'ci' }]);
    const out = runSignalSurface(MUTANT_SESSION_HOOK, { fixturePath });
    expect(out.status).toBe(0);
    // The broken guard now prints a CLOSE line for a debt that was NEVER surfaced red — exactly the
    // "green speaks" defect the anti-nag law exists to forbid.
    expect(out.stdout).toContain('external signal: CI is GREEN again');
  });
});

describe('M-W3 — treat an API error as green', () => {
  it('BASELINE: resolveVerdict keeps a rate-limited debt state=pending, never resolved-success', async () => {
    const { resolveVerdict } = await import(POLLER);
    const fixturePath = writeGhFixture('gh-ratelimit.json', { apiError: true });
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('pending');
  });

  it('MUTANT: an API error resolved as success -> the rate-limit fixture now reports state=resolved/success (the exact bug named in ADR-058)', async () => {
    writeMutant(POLLER, MUTANT_POLLER, (src) => {
      const needle = "if (!Array.isArray(runs)) return { state: 'pending', reason: 'gh API error or unreachable — verdict UNKNOWN, debt stays open' };";
      if (!src.includes(needle)) throw new Error('API-error branch text moved');
      return src.replace(needle, "if (!Array.isArray(runs)) return { state: 'resolved', conclusion: 'success' };");
    });
    const mutantUrl = pathToFileURL(MUTANT_POLLER);
    mutantUrl.search = `v=${Date.now()}`; // cache-bust the dynamic import — a distinct URL per run
    const { resolveVerdict } = await import(mutantUrl.href);
    const fixturePath = writeGhFixture('gh-ratelimit.json', { apiError: true });
    const v = resolveVerdict({ repo: 'stuinfla/ruvnet-brain', ref: 'deadbeef' }, { fixturePath });
    expect(v.state).toBe('resolved');
    expect(v.conclusion).toBe('success'); // a rate-limited API call is NOT proof CI passed — this is the defect
  });
});

describe('M-W4 — remove tool_response parsing from the observer', () => {
  function runObserver(hookFile, envelope) {
    const r = spawnSync(process.execPath, [hookFile], {
      cwd: tmp,
      input: JSON.stringify(envelope),
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, RUVNET_SIGNAL_DIR: path.join(tmp, 'signals') },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  const VERCEL_FAIL_ENVELOPE = {
    session_id: 'constructed-fixture', tool_name: 'Bash',
    tool_input: { command: 'vercel deploy --prod', description: 'Deploy to production' },
    tool_response: { stdout: 'Deploying...\n', stderr: 'Error: build step failed with exit code 1\n', interrupted: false, isImage: false, noOutputExpected: false },
    tool_use_id: 'toolu_constructed_vercel_exit1',
  };

  it('BASELINE: the real observer classifies the recorded vercel exit-1 envelope as a failure', () => {
    const out = runObserver(OBSERVER, VERCEL_FAIL_ENVELOPE);
    expect(out.stdout).toContain('vercel command failed');
  });

  it('MUTANT: no longer reading tool_response -> the SAME recorded envelope is silently ignored', () => {
    writeMutant(OBSERVER, MUTANT_OBSERVER, (src) => {
      const needle = 'const outcome = cliOutcome(rawToolResponse(ev));';
      if (!src.includes(needle)) throw new Error('tool_response read line moved');
      return src.replace(needle, 'const outcome = cliOutcome(null); // MUTANT: tool_response never read');
    });
    const out = runObserver(MUTANT_OBSERVER, VERCEL_FAIL_ENVELOPE);
    expect(out.status).toBe(0); // still advisory, still never crashes — just blind
    expect(out.stdout.trim()).toBe(''); // the failure that actually happened produces NOTHING
  });
});
