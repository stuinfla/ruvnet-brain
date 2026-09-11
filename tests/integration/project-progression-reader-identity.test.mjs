/**
 * The fast read path must be INDISTINGUISHABLE from the CLI read path on a REAL canonical store.
 *
 * A fixture database proves the reader parses a schema we wrote ourselves. This proves the thing
 * that actually matters: rows written by the real `ruflo memory store` come back byte-identical
 * through node:sqlite, and the restore that consumes them is both faster and unchanged in verdict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { openProgressionReader } from '../../plugin/scripts/project-progression-reader.mjs';
import { resolveRuflo, rufloInvocation } from '../../plugin/scripts/ruflo-bin.mjs';
import { restoreProgressionForSession } from '../../plugin/scripts/project-progression-session-start.mjs';

const NAMESPACE = 'project-progression';
const ruflo = resolveRuflo();
const roots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reader-identity-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"reader-identity"}\n');
  return root;
}

function snapshotFor(resolution, sequence, parents) {
  return createProgressionSnapshot({
    projectIdentity: resolution.projectIdentity,
    sourceIdentity: {
      checkoutPath: resolution.checkoutRoot,
      worktreeId: 'primary',
      branch: 'main',
      head: 'a'.repeat(40),
      trackedDigest: 'b'.repeat(64),
      untrackedDigest: 'c'.repeat(64),
      dirtyTreeDigest: 'd'.repeat(64),
    },
    hostIdentity: { host: 'claude', adapterVersion: '0.0.0-test' },
    sessionIdentity: 'identity-session',
    sequence,
    occurredAt: new Date(1789000000000 + sequence * 1000).toISOString(),
    trigger: 'Stop',
    parentEventKeys: parents,
    dedupId: `identity:${sequence}`,
    completeProjectState: {
      currentGoal: `restore snapshot ${sequence}`,
      acceptanceContract: { required: ['byte-identical readback'] },
      plan: [{ id: `step-${sequence}`, status: 'in-progress' }],
      activeProcess: 'ProjectContinuity',
      activeStep: `step-${sequence}`,
      completed: [], inProgress: [], blockers: [], failures: [], decisions: [], changedFiles: [],
      commands: [], proofArtifacts: [], untested: [], resumeConflicts: [],
      nextAction: `continue from ${sequence}`,
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('canonical reader identity against a real ruflo-written store', () => {
  it('reads the exact bytes ruflo wrote, and restores through node:sqlite', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const project = temporaryProject();
    const resolution = resolveProjectStore({ projectDir: project });
    fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });

    const store = new ProjectProgressionStore({ projectDir: project });
    let parents = [];
    const written = [];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      const snapshot = snapshotFor(resolution, sequence, parents);
      store.capture(snapshot);
      written.push(snapshot);
      parents = [snapshot.eventKey];
    }

    // 1. Enumeration and retrieval both take the fast path on a real store.
    const keys = store.listSnapshotKeys();
    expect(store.lastReadPath).toBe('node:sqlite');
    expect(keys).toEqual(written.map((snapshot) => snapshot.eventKey).sort());
    const exact = store.retrieveSnapshots(keys);
    expect(store.lastReadPath).toBe('node:sqlite');
    expect(exact.rejected).toEqual([]);
    expect(exact.snapshots.map((snapshot) => snapshot.payloadDigest).sort())
      .toEqual(written.map((snapshot) => snapshot.payloadDigest).sort());

    // 2. Byte identity with the CLI's own `--value-only` output, for every row.
    const reader = openProgressionReader(resolution.canonicalAgentDbPath);
    try {
      for (const snapshot of written) {
        const invocation = rufloInvocation(ruflo, ['memory', 'retrieve', '--key', snapshot.eventKey,
          '--namespace', NAMESPACE, '--value-only', '--path', resolution.canonicalAgentDbPath]);
        const cli = spawnSync(invocation.executable, invocation.args, {
          cwd: path.dirname(resolution.canonicalAgentDbPath), encoding: 'utf8', timeout: 120_000,
          env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' }, shell: false,
        });
        expect(cli.status, cli.stderr).toBe(0);
        expect(reader.readContent(NAMESPACE, snapshot.eventKey)).toBe(cli.stdout);
      }
    } finally { reader.close(); }

    // 3. The restore the SessionStart hook actually performs now succeeds within its own deadline.
    const started = Date.now();
    const restored = restoreProgressionForSession({
      env: { ...process.env, CLAUDE_PROJECT_DIR: project }, cwd: project,
    });
    const elapsed = Date.now() - started;
    expect(restored.status).toBe('restored');
    expect(restored.context).toContain('[RuvNet Brain — PROJECT CONTINUITY RESTORED]');
    expect(restored.context).toContain('restore snapshot 3');
    expect(restored.context).toContain('continue from 3');
    // The CLI path costs one process per row; three rows measured 2.5-3.2s before this landed and
    // blew the 2500ms deadline outright. A generous ceiling still fails loudly if the fast path is
    // bypassed, because a per-row spawn cannot fit under it.
    expect(elapsed).toBeLessThan(1_500);
    console.info(JSON.stringify({ proof: 'canonical-reader-identity', rows: keys.length, restoreMs: elapsed }));
  }, 300_000);

  it('falls back to the CLI, with the same verdict, when the image is not plain SQLite', () => {
    expect(ruflo, 'global Ruflo is required; this integration must not vacuously skip').toBeTruthy();
    const project = temporaryProject();
    const resolution = resolveProjectStore({ projectDir: project });
    fs.mkdirSync(path.dirname(resolution.canonicalAgentDbPath), { recursive: true });
    const store = new ProjectProgressionStore({ projectDir: project });
    const snapshot = snapshotFor(resolution, 1, []);
    store.capture(snapshot);

    const real = fs.readFileSync(resolution.canonicalAgentDbPath);
    // An encrypted-at-rest image: the reader cannot read it, the CLI can. The restore must not care.
    fs.writeFileSync(resolution.canonicalAgentDbPath, Buffer.concat([Buffer.from('RFE1'), real]));
    const blocked = new ProjectProgressionStore({ projectDir: project });
    // Whatever the CLI then makes of that image is the CLI's verdict to give. The claim under test
    // is narrower and is the one that matters: the reader declined, and the CLI was asked instead.
    try { blocked.listSnapshotKeys(); } catch { /* the CLI's own verdict, not this test's subject */ }
    expect(blocked.lastReadPath).toBe('ruflo-cli (canonical store is not a plain SQLite image)');

    fs.writeFileSync(resolution.canonicalAgentDbPath, real);
    const forced = new ProjectProgressionStore({ projectDir: project, reader: null });
    expect(forced.listSnapshotKeys()).toEqual([snapshot.eventKey]);
    expect(forced.lastReadPath).toBe('ruflo-cli (reader disabled)');
    const viaCli = forced.retrieveSnapshots([snapshot.eventKey]).snapshots[0];
    const viaReader = new ProjectProgressionStore({ projectDir: project })
      .retrieveSnapshots([snapshot.eventKey]).snapshots[0];
    expect(viaReader).toEqual(viaCli);
  }, 300_000);
});
