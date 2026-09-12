// derived-status.test.mjs — Layer 2 of the anti-faking gate (ADR-0024): text can lie, execution
// can't. The scanner (status-honesty.mjs) is lexical and gameable in principle; these fixtures run
// the REAL wrapper and the REAL scanner against known-good and KNOWN-BAD inputs on every CI run, so
// the gate is continuously self-proving — if the scanner ever stops failing known-bad, this suite
// goes red before a faking regression can hide behind it.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSource, scanRepo } from '../../scripts/status-honesty.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HB_SH = path.join(ROOT, 'scripts', 'job-heartbeat.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-status-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

// NTFY_TOPIC:'' = the wrapper's explicit alert opt-out — these deliberately-failing fixtures were
// paging Stuart's REAL phone on every test run (the wrapper fell through to the machine's topic file).
const runHb = (label, cmd) => spawnSync('/bin/sh', [HB_SH, label, '--', '/bin/sh', '-c', cmd], {
  encoding: 'utf8', env: { ...process.env, JOB_HEARTBEAT_DIR: TMP, NTFY_TOPIC: '' }, timeout: 15000,
});
const receipt = (label) => JSON.parse(fs.readFileSync(path.join(TMP, `${label}.json`), 'utf8'));

// The wrapper is a POSIX-sh launchd artifact — /bin/sh does not exist on a native Windows runner
// (spawnSync returns null status; the fixtures ENOENT). It only ever RUNS on macOS/Linux, so the
// honest scope for these execution fixtures is skipIf(win32); the scanner suite below is pure JS
// and runs everywhere.
describe.skipIf(process.platform === 'win32')('job-heartbeat.sh — the receipt can NEVER disagree with the real exit code', () => {
  it('a failing command (exit 7) is recorded state:"failed", exit_code:7 — and the wrapper exits 7', () => {
    const r = runHb('t-fail', 'exit 7');
    expect(r.status).toBe(7);
    expect(receipt('t-fail')).toMatchObject({ state: 'failed', exit_code: 7 });
  });

  it('a succeeding command is recorded state:"ok", exit_code:0', () => {
    const r = runHb('t-ok', 'true');
    expect(r.status).toBe(0);
    expect(receipt('t-ok')).toMatchObject({ state: 'ok', exit_code: 0 });
  });

  it('F3: a skip-fire (exit 75) RESTORES the prior receipt instead of stamping ok/0s over it', () => {
    runHb('t-skip', 'exit 3'); // a real prior run's evidence: failed/3
    const before = receipt('t-skip');
    expect(before).toMatchObject({ state: 'failed', exit_code: 3 });
    const r = runHb('t-skip', 'exit 75'); // lock-held skip fires next
    expect(r.status).toBe(0); // launchd sees success — a skip is not a failure
    expect(receipt('t-skip')).toMatchObject({ state: 'failed', exit_code: 3 }); // evidence SURVIVES
  });

  it('a skip with no prior receipt records honest state:"skipped" (never "ok")', () => {
    const r = runHb('t-skip-fresh', 'exit 75');
    expect(r.status).toBe(0);
    expect(receipt('t-skip-fresh').state).toBe('skipped');
  });
});

describe('status-honesty scanner — prove-FAIL on known-bad, pass on the honest set', () => {
  // The KNOWN-BAD fixture is a faithful replica of the historical sin (issue-fix.mjs pre-2026-07-17):
  // spawn something that fails, write status:'completed' anyway, exit 0. The scanner MUST flag it.
  const KNOWN_BAD = `
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const r = spawnSync('false');
const record = { issue: 16, status: 'completed', at: new Date().toISOString() };
fs.writeFileSync('state.json', JSON.stringify(record));
process.exit(0);
`;
  it('FLAGS the historical sin: hardcoded status:"completed" with no derivation', () => {
    const v = scanSource(KNOWN_BAD, 'known-bad.mjs');
    expect(v.length, 'the known-bad fixture MUST be flagged — if this passes, the gate is toothless').toBeGreaterThan(0);
    expect(v[0].text).toContain('completed');
  });

  it('FLAGS an asserted sh receipt: literal "state":"ok" in a heredoc with no exit-code condition', () => {
    const badSh = 'cat > "$HB" <<EOF\n{"label":"x","state":"ok","note":"totally fine"}\nEOF\nexit 0\n';
    expect(scanSource(badSh, 'bad.sh').length).toBeGreaterThan(0);
  });

  it('PASSES derivation-conditioned writes (the issue-fix / job-heartbeat standard)', () => {
    const good = [
      // the issue-fix standard: membership in an artifact-verified outcome set
      `const ok = SUCCESS_OUTCOMES.has(r.outcome);\nconst rec = { status: ok ? 'completed' : 'failed' };`,
      // the job-heartbeat standard: state derived from the captured exit code
      `if [ "$code" -eq 0 ]; then state="ok"; else state="failed"; fi\nprintf '{"state":"%s"}' "$state"`,
      // exit-code ternary
      `const status = r.status === 0 ? 'success' : 'failed';`,
    ];
    for (const src of good) expect(scanSource(src, 'good'), src).toEqual([]);
  });

  // 2026-09-12: the live sweep false-positived on plugin/scripts/nightly-scheduler.mjs:271 —
  // `state: 'ok'` there is genuinely gated by `if (!envelope.ok) return {...failed...}` many lines
  // above (one guard per precondition), not adjacent to the literal, so the old ±2-line window
  // couldn't see it. These two cases prove the fix (a) recognizes that real guard-clause shape and
  // (b) still flags a literal with no such guard, so the gate did not just get blanket-weakened.
  it('PASSES a validator-gated guard-clause return (the refreshRunHealth shape) even when the guard is far above the literal', () => {
    const guardClauseShape = `
function refreshLikeHealth(receipt) {
  if (!receipt) return { state: 'failed', evidence: 'missing' };
  const registration = readRegistration();
  if (!registration.ok) return { state: 'failed', evidence: 'bad registration' };
  const envelope = validateEnvelope(receipt);
  if (!envelope.ok) return { state: 'failed', evidence: 'bad envelope' };
  // several unrelated lines between the last guard and the terminal return
  const ageHours = 1;
  const label = 'nightly';
  return { state: 'ok', ageHours, evidence: 'derived from envelope.ok' };
}`;
    expect(scanSource(guardClauseShape, 'guard-clause.mjs')).toEqual([]);
  });

  it('STILL FLAGS a naked literal inside a function with no gating .ok guard (the fix did not blanket-whitelist functions)', () => {
    const nakedInFunction = `
function alwaysOk(receipt) {
  const unrelated = receipt.ok; // reads .ok but never gates a return on it
  return { state: 'ok', evidence: 'unearned' };
}`;
    const v = scanSource(nakedInFunction, 'naked-in-function.mjs');
    expect(v.length, 'a naked literal must still be flagged even inside a function').toBeGreaterThan(0);
    expect(v[0].text).toContain("state: 'ok'");
  });

  it('THE REPO IS CLEAN: no automation script asserts an underived terminal success (live sweep)', () => {
    const bad = scanRepo(ROOT);
    const detail = bad.flatMap((b) => b.violations.map((v) => `${b.file}:${v.line} ${v.text}`)).join('\n');
    expect(bad, `asserted success literals found:\n${detail}`).toEqual([]);
  });
});
