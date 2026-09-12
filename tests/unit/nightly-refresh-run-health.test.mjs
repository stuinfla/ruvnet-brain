// tests/unit/nightly-refresh-run-health.test.mjs — an aborted nightly is a FAILED run with a reason,
// not an invalid receipt.
//
// THE INCIDENT THIS ENCODES (2026-09-12). com.ruvnet.brain-update fired at 03:47 and died in its first
// phase. Its receipt was exactly this shape: schemaVersion 3, requiredPhaseOrder of nine, `phases` of
// ONE (`source-enumeration`, FAIL) whose evidence carried the whole cause — "unresolved rollback state
// exists; refusing to create another full-KB copy. …". `refreshRunHealth` handed that receipt to
// `validateRefreshReceiptEnvelope`, whose contract (rightly, for the two-run PROOF) demands the full
// ledger, and reported: "Nightly refresh … is invalid: phase ledger differs from its declared
// contract." The run was not invalid. It failed, early, for a stated reason — and the reader threw the
// reason away. ADR-064's lesson, one layer up: an escalation must carry its cause.
//
// The receipt WRITER (kb/refresh-run.mjs) appends phases as they complete and stops at the first
// required failure, so a strict prefix of the declared order is the designed shape of every aborted
// run. `validateRefreshReceiptEnvelope` is NOT weakened here — the proof still requires a full,
// successful ledger; only the health READER learns to tell "aborted, here is why" from "malformed".
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NIGHTLY_LABEL,
  describeFailedRefreshRun,
  installNightlyRunner,
  installScheduler,
  refreshRunHealth,
  schedulerStatus,
  validateRefreshReceiptEnvelope,
} from '../../plugin/scripts/nightly-scheduler.mjs';
import { REQUIRED_REFRESH_PHASES } from '../../kb/refresh-run.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvb-refresh-health-'));
  roots.push(root);
  const home = path.join(root, 'home');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  const kbDir = path.join(root, 'custom-kb');
  const source = path.join(root, 'nightly-refresh.mjs');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(source, '#!/usr/bin/env node\nprocess.exitCode = 0;\n');
  const record = installNightlyRunner({ brainHome, source, nodePath: '/absolute/node' });
  const identity = { schedulerIdentity: NIGHTLY_LABEL, registrationPath: record.recordPath,
    nodePath: record.nodePath, runnerPath: record.runnerPath, runnerSha256: record.runnerSha256, argv: [] };
  const write = (receipt) => {
    const dir = path.join(brainHome, 'refresh-runs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${receipt.runId}.json`), JSON.stringify(receipt));
  };
  return { root, home, brainHome, kbDir, record, identity, write, env: { HOME: home } };
}

const NOW = Date.parse('2026-09-12T10:45:00Z');
const REASON = 'unresolved rollback state exists; refusing to create another full-KB copy.\n'
  + '  /Users/x/.cache/ruvnet-brain/kb.bak-2026-09-04T14-00-01-691Z: it holds 4 store(s) the new copy does NOT have: agentic-flows.big.rvf…\n'
  + '  Restore or reconcile that copy first, then re-run.';

/** Today's receipt, field for field (owner token and seed omitted — the reader does not use them). */
function abortedReceipt(f, { reason = REASON, phases } = {}) {
  return {
    schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', runId: '1789208177087-d51ad2c7e6b004b2',
    action: 'nightly', desiredVersion: '4.3.21', schedulerIdentity: NIGHTLY_LABEL, executableIdentity: f.identity,
    startedAt: '2026-09-12T10:16:17.090Z', finishedAt: '2026-09-12T10:16:30.571Z',
    status: 'FAILED', terminalVerdict: 'failed', requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES],
    phases: phases ?? [{ phase: 'source-enumeration', required: true, status: 'FAIL', at: '2026-09-12T10:16:30.561Z',
      evidence: { updaterExit: 1, finalExit: 1, fallback: true, verdict: 'failed',
        updateResult: { schemaVersion: 1, kind: 'ruvnet-brain-update-result', terminalVerdict: 'failed', exitCode: 1, reason } } }],
    advisories: [], settlingAt: '2026-09-12T10:16:30.566Z', detail: { phase: 'source-enumeration', terminalVerdict: 'failed' },
  };
}

describe('refreshRunHealth — an aborted run reports WHERE it failed and WHY', () => {
  it('today\'s receipt: strict-prefix ledger + FAILED → failed at source-enumeration with the first line of the reason', () => {
    const f = fixture();
    const receipt = abortedReceipt(f);
    f.write(receipt);
    const health = refreshRunHealth({ brainHome: f.brainHome, now: NOW });
    expect(health.state).toBe('failed');
    expect(health.evidence).toMatch(/failed at source-enumeration: unresolved rollback state exists; refusing to create another full-KB copy\.$/);
    expect(health.evidence).not.toMatch(/invalid/);
    expect(health.evidence).not.toMatch(/Restore or reconcile/); // first line only
    // Derived from the fixture actually written to disk, not retyped — the assertion is "the reader
    // returns the receipt it was given," which a re-typed literal can't prove if the fixture changes.
    expect(health.receipt.runId).toBe(receipt.runId);
  });

  it('the reason is bounded to 200 characters', () => {
    const f = fixture();
    f.write(abortedReceipt(f, { reason: 'x'.repeat(500) }));
    const { evidence } = refreshRunHealth({ brainHome: f.brainHome, now: NOW });
    expect(evidence).toMatch(/failed at source-enumeration: x{200}\.?$/);
    expect(evidence).not.toMatch(/x{201}/);
  });

  it('no reason recorded → the phase name alone', () => {
    const f = fixture();
    const receipt = abortedReceipt(f);
    delete receipt.phases[0].evidence.updateResult;
    f.write(receipt);
    const { state, evidence } = refreshRunHealth({ brainHome: f.brainHome, now: NOW });
    expect(state).toBe('failed');
    expect(evidence).toMatch(/failed at source-enumeration\.?$/);
  });

  it('a FULL ledger that FAILED in its last phase is also "failed at <phase>: <reason>" — never "failed successfully"', () => {
    const f = fixture();
    const phases = REQUIRED_REFRESH_PHASES.map((phase) => ({ phase, required: true, status: 'PASS', evidence: {} }));
    phases[phases.length - 1] = { phase: REQUIRED_REFRESH_PHASES.at(-1), required: true, status: 'FAIL',
      evidence: { updateResult: { terminalVerdict: 'failed', exitCode: 1, reason: 'cleanup could not release the update lock' } } };
    f.write(abortedReceipt(f, { phases }));
    const { state, evidence } = refreshRunHealth({ brainHome: f.brainHome, now: NOW });
    expect(state).toBe('failed');
    expect(evidence).toMatch(new RegExp(`failed at ${REQUIRED_REFRESH_PHASES.at(-1)}: cleanup could not release the update lock`));
    expect(evidence).not.toMatch(/successfully/);
    expect(evidence).not.toMatch(/invalid/);
  });

  it('a FAILED receipt with NO phases (died before its first phase) is failed, stated as such', () => {
    const f = fixture();
    f.write(abortedReceipt(f, { phases: [] }));
    const { state, evidence } = refreshRunHealth({ brainHome: f.brainHome, now: NOW });
    expect(state).toBe('failed');
    expect(evidence).toMatch(/before its first phase/);
  });

  it('a truly malformed FAILED receipt (ledger is NOT a prefix of the declared order) keeps the envelope verdict', () => {
    const f = fixture();
    const receipt = abortedReceipt(f);
    receipt.phases[0].phase = 'ingestion'; // second declared phase without the first — out of contract
    f.write(receipt);
    const { state, evidence } = refreshRunHealth({ brainHome: f.brainHome, now: NOW });
    expect(state).toBe('failed');
    expect(evidence).toMatch(/invalid: phase ledger differs from its declared contract/);
  });

  it('a full, SUCCEEDED ledger is still ok, and the envelope validator is byte-for-byte as strict as before', () => {
    const f = fixture();
    const good = { ...abortedReceipt(f), status: 'SUCCEEDED', terminalVerdict: 'applied',
      phases: REQUIRED_REFRESH_PHASES.map((phase) => ({ phase, required: true, status: 'PASS' })) };
    f.write(good);
    expect(refreshRunHealth({ brainHome: f.brainHome, now: NOW }).state).toBe('ok');
    // The proof's contract is untouched: an aborted receipt is still NOT a valid envelope.
    expect(validateRefreshReceiptEnvelope(abortedReceipt(f)).ok).toBe(false);
    expect(validateRefreshReceiptEnvelope(good).ok).toBe(true);
  });

  it('describeFailedRefreshRun is null for anything that is not a FAILED prefix-shaped run', () => {
    const f = fixture();
    expect(describeFailedRefreshRun(null)).toBeNull();
    expect(describeFailedRefreshRun({ ...abortedReceipt(f), status: 'SUCCEEDED' })).toBeNull();
    expect(describeFailedRefreshRun({ ...abortedReceipt(f), status: 'RUNNING' })).toBeNull();
    const notPrefix = abortedReceipt(f); notPrefix.phases[0].phase = 'bogus';
    expect(describeFailedRefreshRun(notPrefix)).toBeNull();
  });
});

describe('schedulerStatus — a non-zero launchd last exit is reported as a number, not folded into "degraded"', () => {
  const launchctl = (exitCode) => () => ({ status: 0, stdout: `com.ruvnet.brain-update = {\n\tlast exit code = ${exitCode}\n}\n` });

  it.skipIf(process.platform !== 'darwin')('degraded-with-exit carries lastExitCode so a projector can tell "fired and failed" from "cannot fire"', () => {
    const f = fixture();
    expect(installScheduler(f.record, { platform: 'darwin', env: f.env, kbDir: f.kbDir, testMode: true, pathValue: '/bin' }).ok).toBe(true);
    const status = schedulerStatus({ platform: 'darwin', env: f.env, brainHome: f.brainHome, kbDir: f.kbDir, run: launchctl(1) });
    expect(status.state).toBe('degraded');
    expect(status.lastExitCode).toBe(1);
    expect(status.evidence).toMatch(/last exited 1/);
    const clean = schedulerStatus({ platform: 'darwin', env: f.env, brainHome: f.brainHome, kbDir: f.kbDir, run: launchctl(0) });
    expect(clean.state).toBe('on');
    expect(clean.lastExitCode).toBe(0);
  });
});
