import { describe, expect, it } from 'vitest';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { conflictDigest, inspectReconciliation, prepareReconciliation } from '../../plugin/scripts/project-progression-reconciliation.mjs';

const identity = { id: 'fixture', canonicalAgentDbPath: '/fixture/.swarm/memory.db' };
const source = { checkoutPath: '/fixture', worktreeId: 'w', branch: 'main', head: 'h', trackedDigest: 't', untrackedDigest: 'u', dirtyTreeDigest: 'd' };
const state = (goal) => ({ currentGoal: goal, acceptanceContract: null, activeProcess: 'test', activeStep: 'test', nextAction: 'next', plan: [], completed: [], inProgress: [], blockers: [], failures: [], decisions: [], changedFiles: [], commands: [], proofArtifacts: [], untested: [], resumeConflicts: [], provenance: {}, evidence: {} });
function snap(goal, session) {
  return createProgressionSnapshot({ projectIdentity: identity, sourceIdentity: source,
    hostIdentity: { host: 'test', adapterVersion: '1' }, sessionIdentity: session, sequence: 1,
    occurredAt: '2026-09-17T00:00:00.000Z', trigger: 'test', parentEventKeys: [], dedupId: goal,
    completeProjectState: state(goal) });
}
function fakeStore(snapshots, pending = 0) {
  return { resolution: { projectIdentity: identity }, listSnapshotKeys: () => snapshots.map((s) => s.eventKey),
    retrieveSnapshots: () => ({ snapshots, rejected: [] }), pendingReplayCount: () => pending };
}
function fakeStoreWithRejected(snapshots) {
  return { resolution: { projectIdentity: identity }, listSnapshotKeys: () => snapshots.map((s) => s.eventKey),
    retrieveSnapshots: () => ({ snapshots, rejected: [{ eventKey: 'bad', reasons: ['readback is not JSON'] }] }), pendingReplayCount: () => 0 };
}

describe('explicit progression reconciliation', () => {
  it('inspects exact heads and exposes stable conflict digests without writing', () => {
    const store = fakeStore([snap('a', 'a'), snap('b', 'b')], 1);
    const result = inspectReconciliation({ store });
    expect(result.expectedHeads).toHaveLength(2);
    expect(result.pendingReplay).toBe(1);
    expect(result.conflicts[0].field).toBe('currentGoal');
    expect(result.conflicts[0].conflictDigest).toBe(conflictDigest(result.conflicts[0]));
  });

  it('requires exact reviewed heads and resolves only the named conflict', () => {
    const snapshots = [snap('a', 'a'), snap('b', 'b')];
    const store = fakeStore(snapshots);
    const inspected = inspectReconciliation({ store });
    const conflict = inspected.conflicts[0];
    const prepared = prepareReconciliation({ store, expectedHeads: inspected.expectedHeads,
      dispositions: { [conflict.conflictDigest]: { conflictDigest: conflict.conflictDigest, action: 'select', head: conflict.values[0].head } } });
    expect(prepared.state.currentGoal).toBe('a');
    expect(prepared.state.provenance.currentGoal).toMatchObject({ source: 'model-checkpoint', authoritative: false, selectedFrom: expect.any(String) });
    expect(() => prepareReconciliation({ store, expectedHeads: inspected.expectedHeads.slice(1), dispositions: {} }))
      .toThrow(/heads changed/);
  });

  it('rejects missing, stale, and unknown dispositions', () => {
    const snapshots = [snap('a', 'a'), snap('b', 'b')];
    const store = fakeStore(snapshots);
    const inspected = inspectReconciliation({ store });
    const conflict = inspected.conflicts[0];
    expect(() => prepareReconciliation({ store, expectedHeads: inspected.expectedHeads, dispositions: {} })).toThrow(/missing disposition/);
    expect(() => prepareReconciliation({ store, expectedHeads: inspected.expectedHeads,
      dispositions: { [conflict.conflictDigest]: { conflictDigest: 'stale', action: 'clear' } } })).toThrow(/stale/);
    expect(() => prepareReconciliation({ store, expectedHeads: inspected.expectedHeads,
      dispositions: { [conflict.conflictDigest]: { conflictDigest: conflict.conflictDigest, action: 'clear' }, dead: {} } })).toThrow(/unknown/);
  });

  it('fails closed on exact retrieval rejection and strips mechanical merge sentinels', () => {
    const snapshots = [snap('a', 'a'), snap('b', 'b')];
    expect(() => inspectReconciliation({ store: fakeStoreWithRejected(snapshots) })).toThrow(/exact retrieval rejected/);
    const inspected = inspectReconciliation({ store: fakeStore(snapshots) });
    const goal = inspected.conflicts.find((row) => row.field === 'currentGoal');
    const prepared = prepareReconciliation({ store: fakeStore(snapshots), expectedHeads: inspected.expectedHeads,
      dispositions: { [goal.conflictDigest]: { conflictDigest: goal.conflictDigest, action: 'clear' } } });
    expect(prepared.state.sourceIdentity).toBeUndefined();
    expect(prepared.state.journalHeads).toBeUndefined();
  });
  it('preserves canonical plan identity and rejects a replacement for another task', () => {
    const snapshots = ['a', 'b'].map((name) => {
      const original = snap('shared', name);
      return createProgressionSnapshot({ ...original, completeProjectState: { ...original.completeProjectState,
        plan: [{ id: 'task', text: name }] } });
    });
    const store = fakeStore(snapshots);
    const inspected = inspectReconciliation({ store });
    const conflict = inspected.conflicts.find(row => row.field === 'plan.task');
    const replace = value => prepareReconciliation({ store, expectedHeads: inspected.expectedHeads, dispositions: {
      [conflict.conflictDigest]: { conflictDigest: conflict.conflictDigest, action: 'replace', value },
    } });
    expect(() => replace({ id: 'other', text: 'replacement' })).toThrow(/preserve plan identity/);
    expect(replace({ id: 'task', text: 'reviewed replacement' }).state.plan).toEqual([{ id: 'task', text: 'reviewed replacement' }]);
    expect(replace(null).state.plan).toEqual([]);
  });

});
