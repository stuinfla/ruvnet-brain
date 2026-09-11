/**
 * TWO LIVE SESSIONS, ONE PROJECT (ADR-073 §4).
 *
 * This is the failure mode the owner already lived through one layer up: two concurrent Claude Code
 * sessions on the same project, one silently clobbering the other's checkpoint via a plain UPDATE,
 * zero errors, only a changed row id as evidence. The progression journal must not be able to repeat
 * it. Both sessions capture at their own Stop; neither overwrites the other; and the restore reports
 * TWO heads with the disagreement itemised in resumeConflicts[] rather than picking a winner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { restoreProgressionForSession } from '../../plugin/scripts/project-progression-session-start.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';

const ruflo = resolveRuflo();
const roots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"concurrent"}\n');
  const resolution = resolveProjectStore({ projectDir: root });
  fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });
  return { root, resolution };
}

function snapshotFor(resolution, { session, sequence, parents = [], goal, nextAction }) {
  return createProgressionSnapshot({
    projectIdentity: resolution.projectIdentity,
    sourceIdentity: {
      checkoutPath: resolution.checkoutRoot, worktreeId: 'primary', branch: 'main',
      head: 'a'.repeat(40), trackedDigest: 'b'.repeat(64),
      untrackedDigest: 'c'.repeat(64), dirtyTreeDigest: 'd'.repeat(64),
    },
    hostIdentity: { host: 'claude', adapterVersion: '0.0.0-test' },
    sessionIdentity: session,
    sequence,
    occurredAt: new Date(1789000000000 + sequence * 1000).toISOString(),
    trigger: 'Stop',
    parentEventKeys: parents,
    dedupId: `${session}:${sequence}`,
    completeProjectState: {
      currentGoal: goal, acceptanceContract: { required: ['no silent clobber'] },
      plan: [], activeProcess: 'ProjectContinuity', activeStep: 'stop',
      completed: [], inProgress: [], blockers: [], failures: [], decisions: [], changedFiles: [],
      commands: [], proofArtifacts: [], untested: [], resumeConflicts: [], nextAction,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('two concurrent sessions on one project', () => {
  it('both capture, neither is lost, and the restore surfaces the disagreement', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const { root, resolution } = temporaryProject();

    // A shared starting point both sessions descend from — the checkpoint they each resumed.
    const shared = new ProjectProgressionStore({ projectDir: root });
    const base = snapshotFor(resolution, {
      session: 'session-base', sequence: 1, goal: 'the shared starting point', nextAction: 'split',
    });
    shared.capture(base);

    // Two independent session objects, interleaved: A writes, B writes, A writes again. Each has its
    // own store handle, as two real Claude Code processes would.
    const sessionA = new ProjectProgressionStore({ projectDir: root });
    const sessionB = new ProjectProgressionStore({ projectDir: root });
    const a1 = snapshotFor(resolution, {
      session: 'session-a', sequence: 2, parents: [base.eventKey],
      goal: 'session A goal', nextAction: 'A next',
    });
    sessionA.capture(a1);
    const b1 = snapshotFor(resolution, {
      session: 'session-b', sequence: 2, parents: [base.eventKey],
      goal: 'session B goal', nextAction: 'B next',
    });
    sessionB.capture(b1);
    const a2 = snapshotFor(resolution, {
      session: 'session-a', sequence: 3, parents: [a1.eventKey],
      goal: 'session A goal', nextAction: 'A next, revised',
    });
    sessionA.capture(a2);

    // NOTHING WAS OVERWRITTEN. Four distinct rows, each readable by its exact key.
    const keys = new ProjectProgressionStore({ projectDir: root }).listSnapshotKeys();
    expect(keys.sort()).toEqual([base.eventKey, a1.eventKey, b1.eventKey, a2.eventKey].sort());
    const exact = new ProjectProgressionStore({ projectDir: root }).retrieveSnapshots(keys);
    expect(exact.rejected).toEqual([]);
    expect(exact.snapshots.map((s) => s.payloadDigest).sort())
      .toEqual([base, a1, b1, a2].map((s) => s.payloadDigest).sort());

    // TWO HEADS, and the restore says so instead of picking one.
    const restored = restoreProgressionForSession({
      env: { ...process.env, CLAUDE_PROJECT_DIR: root }, cwd: root,
    });
    expect(restored.status).toBe('restored');
    const resume = JSON.parse(restored.context.split('\n').find((line) => line.startsWith('{"schema"')));
    expect(resume.heads.sort()).toEqual([a2.eventKey, b1.eventKey].sort());
    expect(resume.evidence.structurallyEnumerated).toBe(4);

    // The fields the two sessions disagree about are NULL and itemised — never silently merged into
    // one plausible-looking answer, which is the shape a lost checkpoint takes.
    expect(resume.state.currentGoal).toBeNull();
    expect(resume.state.nextAction).toBeNull();
    const conflicted = resume.state.resumeConflicts.map((row) => row.field).sort();
    expect(conflicted).toContain('currentGoal');
    expect(conflicted).toContain('nextAction');
    const goalConflict = resume.state.resumeConflicts.find((row) => row.field === 'currentGoal');
    expect(goalConflict.values.map((entry) => entry.value).sort()).toEqual(['session A goal', 'session B goal']);
    // Each conflicting value names the head it came from, so a human can go read that exact row.
    expect(goalConflict.values.map((entry) => entry.head).sort()).toEqual([a2.eventKey, b1.eventKey].sort());
  }, 300_000);

  it('rejects a second row that claims an existing event key with different content', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const { root, resolution } = temporaryProject();
    const store = new ProjectProgressionStore({ projectDir: root });
    const first = snapshotFor(resolution, { session: 's', sequence: 1, goal: 'first', nextAction: 'one' });
    store.capture(first);

    // `--no-upsert` is what makes the journal append-only: a second store under the same key does not
    // replace the first, and the readback is still the ORIGINAL row.
    const collide = { ...first, completeProjectState: { ...first.completeProjectState, currentGoal: 'clobbered' } };
    const receipt = store.appendExact(first);
    expect(receipt.alreadyStored).toBe(true);
    expect(receipt.readbackDigest).toBe(first.payloadDigest);
    expect(() => store.appendExact(collide)).toThrow(/invalid progression snapshot|digest/i);
    const [row] = store.retrieveSnapshots([first.eventKey]).snapshots;
    expect(row.completeProjectState.currentGoal).toBe('first');
  }, 300_000);
});
