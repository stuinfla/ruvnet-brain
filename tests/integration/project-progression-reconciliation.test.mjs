import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { inspectReconciliation } from '../../plugin/scripts/project-progression-reconciliation.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { runCheckpoint } from '../../plugin/scripts/project-progression-checkpoint.mjs';
import { captureProjectTransition } from '../../plugin/scripts/project-progression-hook.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

const roots = [];
const ruflo = resolveRuflo();
function project() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-')));
  roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"reconcile"}\n');
  const resolution = resolveProjectStore({ projectDir: root });
  fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });
  return { root, resolution, store: new ProjectProgressionStore({ projectDir: root, requestedStorePath: resolution.canonicalAgentDbPath }) };
}
const state = (goal, secret = null) => ({ currentGoal: goal, acceptanceContract: null, activeProcess: 'test', activeStep: 'test', nextAction: 'next', plan: [], completed: [], inProgress: [], blockers: [], failures: [], decisions: secret ? [{ text: secret }] : [], changedFiles: [], commands: [], proofArtifacts: [], untested: [], resumeConflicts: [], provenance: {}, evidence: {} });
function snapshot(ctx, goal, session, sequence = 1, source = ctx.resolution.projectIdentity, parents = []) {
  return createProgressionSnapshot({ projectIdentity: source, sourceIdentity: { checkoutPath: ctx.root, worktreeId: 'w', branch: 'main', head: 'h', trackedDigest: 't', untrackedDigest: 'u', dirtyTreeDigest: 'd' }, hostIdentity: { host: 'test', adapterVersion: '1' }, sessionIdentity: session, sequence, occurredAt: '2026-09-17T00:00:00.000Z', trigger: 'test', parentEventKeys: parents, dedupId: `${goal}-${session}-${sequence}`, completeProjectState: state(goal, secretFor(goal)) });
}
let secretFor = (goal) => goal.includes('secret') ? 'token=super-secret-value' : null;
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('real checkpoint reconciliation workflow', () => {
  it('applies two reviewed heads through the real store and preserves parents', async () => {
    expect(ruflo).toBeTruthy();
    const ctx = project();
    const first = runCheckpoint({ projectDir: ctx.root, state: { currentGoal: 'base' }, sessionId: 'base' });
    const base = ctx.store.retrieveSnapshots(ctx.store.listSnapshotKeys()).snapshots[0];
    const divergent = snapshot(ctx, 'divergent', 'divergent');
    ctx.store.capture(divergent);
    const before = new Map(ctx.store.retrieveSnapshots(ctx.store.listSnapshotKeys()).snapshots
      .map((row) => [row.eventKey, JSON.stringify(row)]));
    const inspected = inspectReconciliation({ store: ctx.store });
    const dispositions = Object.fromEntries(inspected.conflicts
      .filter((row) => !['sourceIdentity', 'provenance', 'evidence'].includes(row.field))
      .map((row) => [row.conflictDigest, { conflictDigest: row.conflictDigest, action: 'select', head: row.values[0].head }]));
    const outcome = runCheckpoint({ projectDir: ctx.root, state: {}, sessionId: 'reconcile', reconcile: {
      expectedHeads: inspected.expectedHeads,
      dispositions,
    } });
    expect(outcome.reconciliation.reconciled).toBe(true);
    const after = ctx.store.retrieveSnapshots(ctx.store.listSnapshotKeys()).snapshots;
    expect(after).toHaveLength(3);
    expect(after.find((row) => row.eventKey === base.eventKey)).toEqual(expect.objectContaining({ payloadDigest: base.payloadDigest, parentEventKeys: [] }));
    expect(after.filter((row) => row.eventKey !== base.eventKey && row.eventKey !== divergent.eventKey)).toHaveLength(1);
    const merged = after.find((row) => row.eventKey === outcome.receipt.eventKey);
    for (const [key, bytes] of before) expect(JSON.stringify(after.find((row) => row.eventKey === key))).toBe(bytes);
    expect(merged.parentEventKeys.sort()).toEqual(inspected.expectedHeads.map((head) => head.eventKey).sort());
    expect(merged.completeProjectState.evidence.reconciliation.parents).toEqual(inspected.expectedHeads);
    expect(merged.completeProjectState.provenance.currentGoal).toMatchObject({ source: 'prior-head', authoritative: false, selectedFrom: expect.any(String) });
    expect(merged.sourceIdentity).toBeTruthy();
    expect(first.receipt.readbackDigest).toBe(first.receipt.payloadDigest);
  }, 300_000);

  it('keeps a concurrent third head visible and never adopts it as a parent', async () => {
    const ctx = project();
    runCheckpoint({ projectDir: ctx.root, state: { currentGoal: 'base' }, sessionId: 'base' });
    const divergent = snapshot(ctx, 'divergent', 'divergent'); ctx.store.capture(divergent);
    const inspected = inspectReconciliation({ store: ctx.store });
    const dispositions = Object.fromEntries(inspected.conflicts
      .filter((row) => !['sourceIdentity', 'provenance', 'evidence'].includes(row.field))
      .map((row) => [row.conflictDigest, { conflictDigest: row.conflictDigest, action: 'select', head: row.values[0].head }]));
    const concurrent = snapshot(ctx, 'concurrent', 'concurrent');
    const outcome = runCheckpoint({ projectDir: ctx.root, state: {}, sessionId: 'race', reconcile: {
      expectedHeads: inspected.expectedHeads, dispositions,
    }, capture: (args) => {
      ctx.store.capture(concurrent);
      return captureProjectTransition(args);
    } });
    expect(outcome.reconciliation.reconciled).toBe(false);
    const merged = ctx.store.retrieveSnapshots(ctx.store.listSnapshotKeys()).snapshots.find((row) => row.eventKey === outcome.receipt.eventKey);
    expect(merged.parentEventKeys.sort()).toEqual(inspected.expectedHeads.map((head) => head.eventKey).sort());
    expect(outcome.reconciliation.headsAfterCommit.map((head) => head.eventKey)).toContain(concurrent.eventKey);
  }, 300_000);

  it('aborts when pending replay changes the reviewed head set', () => {
    const ctx = project();
    const a = snapshot(ctx, 'a', 'a'); ctx.store.capture(a);
    const b = snapshot(ctx, 'b', 'b'); ctx.store.capture(b);
    const inspected = inspectReconciliation({ store: ctx.store });
    const c = snapshot(ctx, 'c', 'c');
    ctx.store.outbox.appendSnapshot(c);
    expect(() => runCheckpoint({ projectDir: ctx.root, state: {}, reconcile: {
      expectedHeads: inspected.expectedHeads, dispositions: {},
    }, storeFactory: () => ctx.store, produce: () => { throw new Error('must not produce'); } })).toThrow(/heads changed/);
    expect(ctx.store.pendingReplayCount()).toBe(0);
    expect(ctx.store.retrieveSnapshots([c.eventKey]).snapshots).toHaveLength(1);
    expect(ctx.store.listSnapshotKeys()).toHaveLength(3);
  });

  it.each(['outbox-fsynced', 'stored', 'readback-verified'])('replays the real reconciliation after interruption at %s', (boundary) => {
    const ctx = project();
    const a = snapshot(ctx, 'a', 'a'); ctx.store.capture(a);
    const b = snapshot(ctx, 'b', 'b'); ctx.store.capture(b);
    const parentsBefore = ctx.store.retrieveSnapshots([a.eventKey, b.eventKey]).snapshots.map(JSON.stringify);
    const inspected = inspectReconciliation({ store: ctx.store });
    const dispositions = Object.fromEntries(inspected.conflicts
      .filter(row => !['sourceIdentity', 'provenance', 'evidence'].includes(row.field))
      .map(row => [row.conflictDigest, { conflictDigest: row.conflictDigest, action: 'select', head: row.values[0].head }]));
    const capture = ctx.store.capture.bind(ctx.store);
    ctx.store.capture = candidate => capture(candidate, { onPhase: phase => {
      if (phase === boundary) throw new Error('simulated crash');
    } });
    expect(() => runCheckpoint({ projectDir: ctx.root, sessionId: `crash-${boundary}`, state: {},
      reconcile: { expectedHeads: inspected.expectedHeads, dispositions }, storeFactory: () => ctx.store,
    })).toThrow(/simulated crash/);
    const pending = ctx.store.outbox.pendingSnapshots();
    expect(pending).toHaveLength(1);
    const proposal = pending[0];
    expect(proposal.completeProjectState.evidence.reconciliation.parents).toEqual(inspected.expectedHeads);
    expect(ctx.store.replay()).toHaveLength(1);
    expect(ctx.store.replay()).toEqual([]);
    const stored = ctx.store.retrieveSnapshots([proposal.eventKey]).snapshots[0];
    expect(stored.parentEventKeys.sort()).toEqual(inspected.expectedHeads.map(head => head.eventKey).sort());
    expect(stored.payloadDigest).toBe(proposal.payloadDigest);
    expect(ctx.store.retrieveSnapshots([a.eventKey, b.eventKey]).snapshots.map(JSON.stringify)).toEqual(parentsBefore);
    expect(inspectReconciliation({ store: ctx.store }).expectedHeads).toEqual([{ eventKey: stored.eventKey, payloadDigest: stored.payloadDigest }]);
  });

  it('rejects a tampered row and a stale expected head set before writing', () => {
    const ctx = project();
    const good = snapshot(ctx, 'good', 'good');
    const bad = { ...good, eventKey: `${good.eventKey}-tampered`, payloadDigest: good.payloadDigest };
    const store = { ...ctx.store, listSnapshotKeys: () => [bad.eventKey], retrieveSnapshots: () => ({ snapshots: [bad], rejected: [{ eventKey: bad.eventKey, reasons: ['exact key/payload identity mismatch'] }] }) };
    expect(() => inspectReconciliation({ store })).toThrow(/exact retrieval rejected/);
    expect(() => inspectReconciliation({ store: ctx.store })).toThrow(/no coherent/);
  });

  it('redacts proposal data before the managed snapshot is published', () => {
    const ctx = project();
    runCheckpoint({ projectDir: ctx.root, state: { currentGoal: 'base' }, sessionId: 'base' });
    ctx.store.capture(snapshot(ctx, 'divergent', 'divergent'));
    const inspected = inspectReconciliation({ store: ctx.store });
    const dispositions = Object.fromEntries(inspected.conflicts
      .filter((row) => !['sourceIdentity', 'provenance', 'evidence'].includes(row.field))
      .map((row) => [row.conflictDigest, { conflictDigest: row.conflictDigest, action: row.field === 'currentGoal' ? 'replace' : 'select',
        ...(row.field === 'currentGoal' ? { value: 'token=super-secret-value' } : { head: row.values[0].head }) }]));
    runCheckpoint({ projectDir: ctx.root, state: {}, sessionId: 'secret-reconcile', reconcile: { expectedHeads: inspected.expectedHeads, dispositions } });
    const rows = ctx.store.retrieveSnapshots(ctx.store.listSnapshotKeys()).snapshots;
    expect(rows.map((row) => JSON.stringify(row)).join('\n')).not.toContain('super-secret-value');
    expect(rows.map((row) => JSON.stringify(row)).join('\n')).toContain('[REDACTED:token]');
    const spool = path.join(ctx.root, '.swarm', 'project-progression-outbox.d');
    const spoolText = fs.readdirSync(spool).map((file) => fs.readFileSync(path.join(spool, file), 'utf8')).join('\n');
    expect(spoolText).not.toContain('super-secret-value');
    expect(JSON.stringify(inspectReconciliation({ store: ctx.store }))).not.toContain('super-secret-value');
  });
});
