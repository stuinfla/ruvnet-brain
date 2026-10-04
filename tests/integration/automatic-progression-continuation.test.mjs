import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, fakeRuflo } from '../helpers/continuity-fixture.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { buildProjectProgression } from '../../plugin/scripts/project-progression-producer.mjs';
import { createProgressionSnapshot, restoreProjectProgression } from '../../plugin/scripts/project-progression-contract.mjs';
import { queueCapture, queuedWork } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { restoreProgressionForSession } from '../../plugin/scripts/project-progression-session-start.mjs';

function fixture() {
  const f = adoptedProject();
  const cli = fakeRuflo();
  const store = new ProjectProgressionStore({ projectDir: f.dir, rufloBinary: cli.bin, env: f.env });
  return { ...f, cli, store, resolution: store.resolution };
}
function snapshot(f, host, changes = {}, parents = []) {
  return createProgressionSnapshot({
    projectIdentity: f.resolution.projectIdentity,
    sourceIdentity: { checkoutPath: f.dir, worktreeId: 'primary', branch: 'main', head: 'a'.repeat(40),
      trackedDigest: 'b'.repeat(64), untrackedDigest: 'c'.repeat(64), dirtyTreeDigest: 'd'.repeat(64) },
    hostIdentity: { host, adapterVersion: 'test' }, sessionIdentity: `${host}-fixture`, sequence: parents.length ? 2 : 1,
    occurredAt: '2026-10-03T20:00:00.000Z', trigger: 'Stop', dedupId: `${host}:${parents.length}`,
    parentEventKeys: parents, completeProjectState: {
      currentGoal: 'Keep all unfinished work', acceptanceContract: { required: ['exact restoration'] },
      activeProcess: 'Repair', activeStep: 'validate', plan: [{ id: 'repair', status: 'in-progress' }],
      completed: ['diagnosis'], inProgress: ['repair'], blockers: ['owner-held credential'],
      failures: [{ command: 'check', exitCode: 1 }], decisions: ['retain source account'],
      changedFiles: ['src/repair.mjs'], commands: [{ command: 'check', outcome: 'failure' }],
      proofArtifacts: ['check-receipt'], untested: ['native session'], nextAction: 'Validate repair',
      resumeConflicts: [], ...changes,
    },
  });
}
function automatic(f) {
  return buildProjectProgression({ resolution: f.resolution, env: { ...f.env, RUVNET_CONFIG_ROOT: `${f.home}/config` },
    host: 'codex', payload: { session_id: 'automatic-fixture', hook_event_name: 'Stop' } }).projectProgression;
}
function captureProduced(f, produced) {
  const row = createProgressionSnapshot({ ...produced, projectIdentity: f.resolution.projectIdentity,
    hostIdentity: { host: 'codex', adapterVersion: 'test' }, sessionIdentity: 'automatic-fixture', trigger: 'Stop' });
  f.store.capture(row);
  return f.store.restoreLatest().payload.state;
}
afterEach(cleanup);

describe('automatic progression preserves durable work', () => {
  it('carries complete prior state without a work ledger or private transcript', () => {
    const f = fixture();
    const prior = snapshot(f, 'claude');
    f.store.capture(prior);
    const produced = automatic(f);
    for (const field of ['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions', 'changedFiles',
      'commands', 'proofArtifacts', 'untested', 'acceptanceContract', 'activeProcess', 'activeStep']) {
      expect(produced.completeProjectState[field], field).toEqual(prior.completeProjectState[field]);
    }
    expect(captureProduced(f, produced).blockers).toEqual(prior.completeProjectState.blockers);
  });

  it('retains full work when a present ledger has no items', () => {
    const f = fixture(); const prior = snapshot(f, 'claude'); f.store.capture(prior);
    f.env.RUVNET_WORK_LEDGER = `${f.home}/ledger.json`;
    fs.writeFileSync(f.env.RUVNET_WORK_LEDGER, JSON.stringify({ items: [] }));
    const restored = captureProduced(f, automatic(f));
    for (const field of ['plan', 'completed', 'inProgress']) expect(restored[field]).toEqual(prior.completeProjectState[field]);
  });

  it('updates only ledger-owned matching work and retains unmentioned work', () => {
    const f = fixture(); f.store.capture(snapshot(f, 'claude', {
      plan: [{ id: 'owned', status: 'open', source: 'ledger' }, { id: 'unowned', status: 'in-progress' }],
      completed: ['older completion'], inProgress: ['owned', 'unowned'],
    }));
    f.env.RUVNET_WORK_LEDGER = `${f.home}/ledger.json`;
    fs.writeFileSync(f.env.RUVNET_WORK_LEDGER, JSON.stringify({ items: [{ text: 'owned', done: true }, { text: 'new', done: false }] }));
    const state = automatic(f).completeProjectState;
    expect(state.plan).toEqual([{ id: 'owned', status: 'done', source: 'ledger' }, { id: 'unowned', status: 'in-progress' }, { id: 'new', status: 'open', source: 'ledger' }]);
    expect(state.completed).toEqual(['older completion', 'owned']);
    expect(state.inProgress).toEqual(['unowned', 'new']);
    expect(state.provenance.plan.sources).toEqual(['prior-head', 'ledger']);
  });

  it('suspends an outbox snapshot when its original nested capture path opts out', () => {
    const f = fixture(); const origin = `${f.dir}/private`; fs.mkdirSync(origin);
    const pending = snapshot(f, 'claude'); pending.sourceIdentity.capturePath = origin;
    // Recreate to bind the additive origin to the payload digest.
    const row = createProgressionSnapshot({ ...pending, dedupId: 'nested-consent' });
    f.store.outbox.appendSnapshot(row);
    const brainHome = `${f.home}/.cache/ruvnet-brain`;
    fs.mkdirSync(`${brainHome}/turn-capture`, { recursive: true });
    fs.writeFileSync(`${brainHome}/turn-capture/policy.json`, JSON.stringify({ schemaVersion: 1, projects: { [f.dir]: 'on' }, paths: { [origin]: 'off' } }));
    expect(() => f.store.replay()).toThrow(/opt-out/);
    expect(f.cli.calls()).toEqual([]);
    expect(f.store.outbox.pendingSnapshots()).toEqual([row]);
    expect(() => f.store.restoreLatest()).toThrow(/opt-out/);
    const startup = restoreProgressionForSession({ env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir }, cwd: f.dir, storeFactory: () => f.store });
    expect(startup.status).toBe('unknown');
    expect(startup.context).not.toContain('Keep all unfinished work');
    expect(f.cli.calls()).toEqual([]);
    expect(f.store.outbox.pendingSnapshots()).toEqual([row]);
    fs.writeFileSync(`${brainHome}/turn-capture/policy.json`, JSON.stringify({ schemaVersion: 1, projects: { [f.dir]: 'on' }, paths: { [origin]: 'on' } }));
    expect(f.store.replay()).toHaveLength(1);
    expect(f.store.retrieveSnapshots([row.eventKey]).snapshots).toEqual([row]);
    expect(f.store.outbox.pendingSnapshots()).toEqual([]);
  });

  it('retains legacy outbox debt whose nested capture origin cannot be verified', () => {
    const f = fixture(); const origin = `${f.dir}/private`; fs.mkdirSync(origin);
    const row = snapshot(f, 'claude'); f.store.outbox.appendSnapshot(row);
    const brainHome = `${f.home}/.cache/ruvnet-brain`;
    fs.mkdirSync(`${brainHome}/turn-capture`, { recursive: true });
    fs.writeFileSync(`${brainHome}/turn-capture/policy.json`, JSON.stringify({ schemaVersion: 1, projects: { [f.dir]: 'on' }, paths: { [origin]: 'off' } }));
    expect(() => f.store.replay()).toThrow(/origin.*opt-out/);
    expect(f.cli.calls()).toEqual([]);
    expect(f.store.outbox.pendingSnapshots()).toEqual([row]);
  });

  it('preserves concurrent conflicts after an automatic capture joins their heads', () => {
    const f = fixture();
    const left = snapshot(f, 'claude');
    const right = snapshot(f, 'codex', { currentGoal: 'Conflicting goal', nextAction: 'Inspect failed check', plan: [{ id: 'repair', status: 'blocked' }] });
    f.store.capture(left); f.store.capture(right);
    const expected = restoreProjectProgression([left, right], { expectedProjectIdentity: f.resolution.projectIdentity }).state;
    const produced = automatic(f);
    expect(produced.parentEventKeys.sort()).toEqual([left.eventKey, right.eventKey].sort());
    expect(produced.completeProjectState.currentGoal).toBeNull();
    expect(produced.completeProjectState.nextAction).toBeNull();
    expect(produced.completeProjectState.resumeConflicts).toEqual(expected.resumeConflicts);
    expect(captureProduced(f, produced).resumeConflicts).toEqual(expected.resumeConflicts);
  });

  it('refuses to fabricate empty ancestry when the existing reader cannot verify prior state', () => {
    const f = fixture(); f.store.capture(snapshot(f, 'claude'));
    const db = new DatabaseSync(f.resolution.canonicalAgentDbPath);
    db.exec('ALTER TABLE memory_entries ADD COLUMN unknown_fixture_column TEXT'); db.close();
    expect(() => automatic(f)).toThrow(/prior progression read unavailable/);
  });

  it('replays a fsynced interrupted snapshot before the first SessionStart restore', () => {
    const f = fixture();
    const prior = snapshot(f, 'claude');
    f.store.capture(prior);
    const pending = snapshot(f, 'codex', { currentGoal: 'Newest interrupted goal', blockers: ['latest blocker'] }, [prior.eventKey]);
    f.store.outbox.appendSnapshot(pending);
    const result = restoreProgressionForSession({ env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir }, cwd: f.dir,
      storeFactory: () => f.store });
    expect(result.status).toBe('restored');
    expect(result.context).toContain('Newest interrupted goal');
    expect(result.context).toContain('latest blocker');
    expect(f.store.outbox.pendingSnapshots()).toEqual([]);
    expect(f.cli.calls().filter((c) => c.key === pending.eventKey && c.argv[1] === 'store')).toHaveLength(1);
    const receipt = f.store.outbox.records().find((row) => row.type === 'commit' && row.eventKey === pending.eventKey);
    expect(receipt.payloadDigest).toBe(pending.payloadDigest);
    expect(f.store.retrieveSnapshots([pending.eventKey]).snapshots).toEqual([pending]);
  });

  it('drains a frozen capture queue before restoring its first startup state', () => {
    const f = fixture(); f.store.capture(snapshot(f, 'claude'));
    const produced = automatic(f); produced.completeProjectState.blockers = ['queued failure evidence'];
    expect(queueCapture({ projectDir: f.dir, event: 'Stop', host: 'codex', payload: {
      session_id: 'queued-fixture', hook_event_name: 'Stop', projectProgression: produced,
    } })).toBeTruthy();
    const result = restoreProgressionForSession({ env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir }, cwd: f.dir,
      storeFactory: () => f.store });
    expect(result.status).toBe('restored');
    expect(result.context).toContain('queued failure evidence');
    expect(queuedWork(f.dir)).toBe(0);
    expect(f.cli.calls().filter((call) => call.argv[1] === 'store')).toHaveLength(2);
  });

  it('does not inject an older head when pending replay is refused', () => {
    const f = fixture();
    const prior = snapshot(f, 'claude'); f.store.capture(prior);
    const pending = snapshot(f, 'codex', { currentGoal: 'Newest interrupted goal' }, [prior.eventKey]);
    f.store.outbox.appendSnapshot(pending);
    // Refusal is a real child-process exit, not a stubbed restore result.
    fs.writeFileSync(f.cli.counter, '1');
    const result = restoreProgressionForSession({ env: { ...f.env, CLAUDE_PROJECT_DIR: f.dir }, cwd: f.dir,
      storeFactory: () => f.store });
    expect(result.status).toBe('unknown');
    expect(result.reason).toBe('outbox-replay');
    expect(result.context).not.toContain('Keep all unfinished work');
    expect(f.store.outbox.pendingSnapshots()).toHaveLength(1);
  });
});
