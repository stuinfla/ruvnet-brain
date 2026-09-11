/**
 * ADR-073 §5/§6 — what SessionStart is allowed to DO, and how honestly it reports what happened.
 *
 * §5  SessionStart restores COMMITTED rows only. Replay is a write; a write is a `ruflo memory store`
 *     process; one of those costs more than the whole SessionStart budget. A restore that replayed
 *     would time out and report UNKNOWN exactly when durable evidence existed — the failure this
 *     lane was built to remove. Pending snapshots are reported and replayed at a capture boundary.
 * §6  Three outcomes, three meanings: UNAVAILABLE (no question to ask), EMPTY (asked, nothing there),
 *     UNKNOWN (asked, missed). An UNKNOWN over a store that demonstrably HOLDS rows is a failure and
 *     must say so; rendering it as neutral is how a lost project memory looks like a new project.
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
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-semantics-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"restore-semantics"}\n');
  return root;
}

function snapshotFor(resolution, sequence, parents = []) {
  return createProgressionSnapshot({
    projectIdentity: resolution.projectIdentity,
    sourceIdentity: {
      checkoutPath: resolution.checkoutRoot, worktreeId: 'primary', branch: 'main',
      head: 'a'.repeat(40), trackedDigest: 'b'.repeat(64),
      untrackedDigest: 'c'.repeat(64), dirtyTreeDigest: 'd'.repeat(64),
    },
    hostIdentity: { host: 'claude', adapterVersion: '0.0.0-test' },
    sessionIdentity: 'semantics-session',
    sequence,
    occurredAt: new Date(1789000000000 + sequence * 1000).toISOString(),
    trigger: 'Stop',
    parentEventKeys: parents,
    dedupId: `semantics:${sequence}`,
    completeProjectState: {
      currentGoal: `goal ${sequence}`, acceptanceContract: { required: ['committed rows only'] },
      plan: [], activeProcess: 'ProjectContinuity', activeStep: `step-${sequence}`,
      completed: [], inProgress: [], blockers: [], failures: [], decisions: [], changedFiles: [],
      commands: [], proofArtifacts: [], untested: [], resumeConflicts: [],
      nextAction: `next ${sequence}`,
    },
  });
}

const restore = (project) => restoreProgressionForSession({
  env: { ...process.env, CLAUDE_PROJECT_DIR: project }, cwd: project,
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('SessionStart restore semantics', () => {
  it('never replays the outbox, reports the pending count, and leaves the snapshots pending', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const project = temporaryProject();
    const resolution = resolveProjectStore({ projectDir: project });
    fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });
    const store = new ProjectProgressionStore({ projectDir: project });

    const committed = snapshotFor(resolution, 1);
    store.capture(committed);

    // A snapshot that reached the durable outbox but was killed before it reached the store — the
    // exact state an interrupted session leaves behind.
    const pending = snapshotFor(resolution, 2, [committed.eventKey]);
    store.outbox.appendSnapshot(pending);
    expect(store.outbox.pendingSnapshots().map((row) => row.eventKey)).toEqual([pending.eventKey]);

    const result = restore(project);
    expect(result.status).toBe('restored');
    expect(result.pendingReplay).toBe(1);
    expect(result.context).toContain('1 uncommitted snapshot(s) pending replay');
    // The restored head is the COMMITTED one; the pending row was neither written nor read.
    expect(result.context).toContain('goal 1');
    expect(result.context).not.toContain('goal 2');
    // And it is still pending: reported, not consumed, not dropped.
    expect(store.outbox.pendingSnapshots().map((row) => row.eventKey)).toEqual([pending.eventKey]);
    expect(new ProjectProgressionStore({ projectDir: project }).listSnapshotKeys())
      .toEqual([committed.eventKey]);

    // A capture boundary owns the write budget, so replay belongs there — and works.
    expect(store.replay().map((receipt) => receipt.eventKey)).toEqual([pending.eventKey]);
    expect(store.outbox.pendingSnapshots()).toEqual([]);
    const after = restore(project);
    expect(after.pendingReplay).toBe(0);
    expect(after.context).not.toContain('pending replay');
    expect(after.context).toContain('goal 2');
  }, 300_000);

  it('renders a miss over a populated store as a failure, not a neutral unknown', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const project = temporaryProject();
    const resolution = resolveProjectStore({ projectDir: project });
    fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });
    const store = new ProjectProgressionStore({ projectDir: project });
    store.capture(snapshotFor(resolution, 1));

    // An output bound too small for any payload: the rows are verifiably there and unrestorable.
    const missed = restoreProgressionForSession({
      env: { ...process.env, CLAUDE_PROJECT_DIR: project }, cwd: project, maxOutputBytes: 64,
    });
    expect(missed.status).toBe('unknown');
    expect(missed.severity).toBe('error');
    expect(missed.rowCount).toBe(1);
    expect(missed.context).toContain('RESTORE FAILED');
    expect(missed.context).toContain('1 verified progression row(s)');

    // The identical call against a project with no rows must NOT claim a failure: there was nothing
    // to lose. Same bound, same code path, different verdict — which is the whole discrimination.
    const empty = temporaryProject();
    const emptyResolution = resolveProjectStore({ projectDir: empty });
    fs.mkdirSync(path.dirname(emptyResolution.canonicalAgentDbPath), { recursive: true });
    const quiet = restoreProgressionForSession({
      env: { ...process.env, CLAUDE_PROJECT_DIR: empty }, cwd: empty, maxOutputBytes: 64,
    });
    expect(quiet.severity).not.toBe('error');
    expect(quiet.context).not.toContain('RESTORE FAILED');

    // And an unreadable-path miss with a genuinely empty store stays a warning, never an error.
    expect(restoreProgressionForSession({
      env: { ...process.env, CLAUDE_PROJECT_DIR: empty }, cwd: empty, maxOutputBytes: 1,
    })).toMatchObject({ status: 'unknown', severity: 'warning', reason: 'output-bound' });
  }, 300_000);

  it('reports UNAVAILABLE — not UNKNOWN — where there is no continuity question to ask', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-nonproject-')));
    roots.push(root);
    const result = restore(root);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'non-project', severity: 'info' });
    expect(result.context).toContain('PROJECT CONTINUITY UNAVAILABLE');
    expect(fs.existsSync(path.join(root, '.swarm'))).toBe(false);
  });
});
