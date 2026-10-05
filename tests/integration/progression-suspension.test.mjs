import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adoptedProject, cleanup, fakeRuflo, rows } from '../helpers/continuity-fixture.mjs';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { runSessionSnapshotHook, runOutboxReplay, queueCapture, queuedWork, replayOutboxDetached, drainCaptureQueue } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { runProjectTransitionHook, captureNormalizedTransition } from '../../plugin/scripts/project-transition-hook.mjs';
import { restoreProgressionForSession } from '../../plugin/scripts/project-progression-session-start.mjs';
import { runCheckpoint } from '../../plugin/scripts/project-progression-checkpoint.mjs';
import { callManagedCli } from '../../plugin/mcp/managed-cli-interface.mjs';
import { operatorProgressionSuspension, automaticProgressionSuspensionResult, isAutomaticProgressionSuspension,
  setOperatorProgressionSuspension, progressionSuspensionFile } from '../../plugin/scripts/project-progression-suspension.mjs';

afterEach(cleanup);
function fixture() {
  const f = adoptedProject(); const cli = fakeRuflo();
  const env = { ...f.env, RUVNET_BRAIN_STATE_DIR: path.join(f.home, 'state'), RUVNET_BRAIN_HOME: path.join(f.home, 'brain'),
    RUVNET_HOOK_HOST: 'codex', RUVNET_BRAIN_PROJECT_DIR: f.dir };
  const store = new ProjectProgressionStore({ projectDir: f.dir, env, rufloBinary: cli.bin });
  return { ...f, env, cli, store };
}
function snapshot(f, id = 'one') {
  return createProgressionSnapshot({ projectIdentity: f.store.resolution.projectIdentity,
    sourceIdentity: { checkoutPath: f.dir, capturePath: f.dir, worktreeId: 'primary', branch: 'main', head: 'a', trackedDigest: 'b', untrackedDigest: 'c', dirtyTreeDigest: 'd' },
    hostIdentity: { host: 'codex', adapterVersion: 'fixture' }, sessionIdentity: id, sequence: 1,
    occurredAt: '2026-10-04T20:00:00.000Z', trigger: 'Stop', dedupId: id, parentEventKeys: [],
    completeProjectState: { currentGoal: 'Preserve evidence', acceptanceContract: null, activeProcess: 'repair', activeStep: 'test', plan: [],
      completed: [], inProgress: [], blockers: [], failures: [], decisions: [], changedFiles: [], commands: [], proofArtifacts: [], untested: [], resumeConflicts: [], nextAction: 'Verify exact row' } });
}
const swarmBytes = (f) => Object.fromEntries(fs.readdirSync(path.join(f.dir, '.swarm')).sort().map((file) => [file, fs.readFileSync(path.join(f.dir, '.swarm', file)).toString('base64')]));

describe('independent operator progression suspension (#390 B, containment only)', () => {
  it.each(['claude', 'codex'])('keeps %s turn/material capture active while suspending automatic snapshots and normalized transitions', (host) => {
    const f = fixture(); setOperatorProgressionSuspension(true, { env: f.env });
    const calls = []; const untouched = () => { throw new Error('heavy progression path must not run'); };
    const result = runSessionSnapshotHook(f.dir, 'Stop', { env: f.env, host, writeMetadata: false,
      rawInput: JSON.stringify({ session_id: 'suspended', hook_event_name: 'Stop' }),
      captureTurn: () => { calls.push('turn'); return { recorded: true }; }, captureEvents: () => { calls.push('events'); return { recorded: 1 }; },
      produce: untouched, captureProgression: untouched, makeStoreFactory: untouched, spawnReplay: untouched });
    expect(isAutomaticProgressionSuspension(result)).toBe(true); expect(result.receipt).toBeNull(); expect(calls).toEqual(['turn', 'events']);
    expect(runProjectTransitionHook(f.dir, 'UserPromptSubmit', { env: f.env, host, readHistory: untouched }).state).toBe('suspended');
    expect(isAutomaticProgressionSuspension(captureNormalizedTransition({}, { env: f.env, readHistory: untouched }))).toBe(true);
    expect(queueCapture({ projectDir: f.dir, env: f.env, event: 'Stop', payload: {}, host })).toBeNull();
    expect(rows(f.store.resolution.canonicalAgentDbPath, 'project-progression')).toEqual([]);
  });

  it('retains pre-existing snapshot and queue bytes, does not spawn a replayer, and reports restore unavailable', () => {
    const f = fixture(); f.store.outbox.appendSnapshot(snapshot(f));
    queueCapture({ projectDir: f.dir, env: f.env, event: 'Stop', host: 'codex', payload: { session_id: 'debt', projectProgression: snapshot(f, 'queue') } });
    const before = swarmBytes(f); setOperatorProgressionSuspension(true, { env: f.env });
    const untouched = () => { throw new Error('progression must not run'); };
    expect(runOutboxReplay({ projectDir: f.dir, env: f.env, makeStoreFactory: untouched })).toBe(0);
    expect(replayOutboxDetached({ projectDir: f.dir, env: f.env, spawnFn: untouched })).toBe(false);
    expect(drainCaptureQueue({ projectDir: f.dir, env: f.env })).toEqual({ state: 'suspended', replayed: 0, pending: null });
    const result = restoreProgressionForSession({ env: f.env, cwd: f.dir, storeFactory: untouched });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'operator-suspended' }); expect(result.context).toContain('no project progression was restored');
    expect(queuedWork(f.dir)).toBe(1); expect(swarmBytes(f)).toEqual(before); expect(f.cli.calls()).toEqual([]);
  });

  it('reverses suspension and exact-replays the preserved outbox', () => {
    const f = fixture(); const row = snapshot(f); f.store.outbox.appendSnapshot(row);
    setOperatorProgressionSuspension(true, { env: f.env }); expect(runOutboxReplay({ projectDir: f.dir, env: f.env })).toBe(0);
    setOperatorProgressionSuspension(false, { env: f.env });
    expect(runOutboxReplay({ projectDir: f.dir, env: f.env, makeStoreFactory: () => () => f.store })).toBe(1);
    expect(f.store.retrieveSnapshots([row.eventKey]).snapshots).toEqual([row]);
    expect(f.store.outbox.records()[0].snapshot).toEqual(row); expect(f.store.outbox.pendingSnapshots()).toEqual([]);
  });

  it('stops before the next replay commit when the operator suspends a running worker', () => {
    const f = fixture(); const originals = ['a', 'b', 'c'].map((id) => snapshot(f, id)); originals.forEach((s) => f.store.outbox.appendSnapshot(s));
    const capture = f.store.captureFrozen.bind(f.store);
    f.store.captureFrozen = (...args) => { const result = capture(...args); setOperatorProgressionSuspension(true, { env: f.env }); return result; };
    expect(runOutboxReplay({ projectDir: f.dir, env: f.env, makeStoreFactory: () => () => f.store })).toBe(1);
    expect(rows(f.store.resolution.canonicalAgentDbPath, 'project-progression')).toHaveLength(1);
    expect(f.store.outbox.pendingSnapshots()).toHaveLength(2);
    expect(f.store.outbox.records().filter((r) => r.type === 'snapshot').slice(0, originals.length).map((r) => r.snapshot)).toEqual(originals);
  });

  it('returns an unstarted claimed queue item when suspension arrives after the claim', () => {
    const f = fixture(); queueCapture({ projectDir: f.dir, env: f.env, event: 'Stop', host: 'codex', payload: { session_id: 'debt', projectProgression: snapshot(f) } });
    const before = swarmBytes(f);
    expect(runOutboxReplay({ projectDir: f.dir, env: f.env, makeStoreFactory: () => () => f.store,
      onClaim: () => setOperatorProgressionSuspension(true, { env: f.env }), runCapture: () => { throw new Error('must not execute'); } })).toBe(0);
    expect(swarmBytes(f)).toEqual(before); expect(f.cli.calls()).toEqual([]);
  });

  it('allows a real explicit checkpoint and exact canonical row while automatic capture is suspended', () => {
    const f = fixture(); setOperatorProgressionSuspension(true, { env: f.env });
    const result = runCheckpoint({ projectDir: f.dir, host: 'codex', state: { currentGoal: 'Explicit owner checkpoint' }, storeFactory: () => f.store });
    expect(result.receipt.readbackDigest).toBe(result.receipt.payloadDigest);
    expect(f.store.retrieveSnapshots([result.receipt.eventKey]).snapshots[0].completeProjectState.currentGoal).toBe('Explicit owner checkpoint');
  });

  it('requires operator control for the brand and treats invalid control as failure', () => {
    const f = fixture(); expect(automaticProgressionSuspensionResult(f.env)).toBeNull();
    expect(isAutomaticProgressionSuspension({ progressionSuspended: true, receipt: null })).toBe(false);
    fs.mkdirSync(path.dirname(progressionSuspensionFile(f.env)), { recursive: true }); fs.writeFileSync(progressionSuspensionFile(f.env), '{broken');
    expect(() => operatorProgressionSuspension(f.env)).toThrow(/unreadable or invalid/);
    expect(restoreProgressionForSession({ env: f.env, cwd: f.dir }).status).toBe('unknown');
  });

  it.skipIf(process.platform === 'win32')('keeps CLI outcomes/policy intact, reports suspension, and refuses look-alike capture failures', async () => {
    const f = fixture(); const bin = path.join(f.home, '.npm-global/bin'); fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'ruflo'), '#!/bin/sh\nif [ "$1" = "fail" ] && [ "$2" != "--help" ]; then exit 7; fi\nprintf "ok\\n"\n', { mode: 0o755 });
    setOperatorProgressionSuspension(true, { env: f.env });
    for (const command of ['status', 'fail']) {
      expect((await callManagedCli('ruvnet_cli_help', { executable: 'ruflo', argv: [command] }, f.env)).isError).toBe(false);
      const result = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: [command] }, f.env);
      expect(result.isError).toBe(command === 'fail'); expect(result.structuredContent.continuity).toBe('operator-suspended');
      expect(result.content.at(-1).text).toContain('suspended captures produced no progression receipt');
    }
    const branded = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, f.env, undefined,
      { capture: () => automaticProgressionSuspensionResult(f.env, { adopted: true }) });
    expect(branded.isError).toBe(false); expect(branded.structuredContent.continuity).toBe('operator-suspended');
    const unexpected = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, f.env, undefined,
      { capture: () => automaticProgressionSuspensionResult(f.env, { adopted: true, error: 'unexpected capture error' }) });
    expect(unexpected.isError).toBe(true); expect(unexpected.content[0].text).toContain('unexpected capture error');
    const forged = await callManagedCli('ruvnet_cli_run', { executable: 'ruflo', argv: ['status'] }, f.env, undefined,
      { capture: () => ({ adopted: true, progressionCaptured: false, progressionSuspended: true, skipped: 'unexpected failure' }) });
    expect(forged.isError).toBe(true); expect(forged.content[0].text).toContain('unexpected failure');
    expect(rows(f.store.resolution.canonicalAgentDbPath, 'project-progression')).toEqual([]);
  });

  it('exposes reversible native operator controls without mutating any project evidence', () => {
    const f = fixture(); const before = swarmBytes(f); const script = new URL('../../plugin/scripts/project-progression-suspension.mjs', import.meta.url);
    for (const [flag, state] of [['--suspend', 'operator-suspended'], ['--status', 'operator-suspended'], ['--resume', 'enabled']]) {
      const result = spawnSync(process.execPath, [fileURLToPath(script), flag], { env: f.env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).automaticProgression).toBe(state);
    }
    expect(swarmBytes(f)).toEqual(before);
    setOperatorProgressionSuspension(false, { env: { ...f.env, RUVNET_BRAIN_PROGRESSION_SUSPENDED: '1' } });
    expect(operatorProgressionSuspension({ ...f.env, RUVNET_BRAIN_PROGRESSION_SUSPENDED: '1' })).toEqual({ source: 'environment' });
  });
});
