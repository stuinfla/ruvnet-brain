import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { createProgressionSnapshot } from '../../plugin/scripts/project-progression-contract.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { getVersion } from '../../scripts/version.mjs';

let root, previousScratch;
beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-durability-')));
  previousScratch = process.env.RUVNET_RUFLO_CWD_ROOT;
  process.env.RUVNET_RUFLO_CWD_ROOT = path.join(root, 'scratch');
});
afterEach(() => {
  if (previousScratch === undefined) delete process.env.RUVNET_RUFLO_CWD_ROOT;
  else process.env.RUVNET_RUFLO_CWD_ROOT = previousScratch;
  fs.rmSync(root, { recursive: true, force: true });
});

function progression(projectRoot, overrides = {}) {
  const resolution = resolveProjectStore({ projectDir: projectRoot });
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
    hostIdentity: { host: 'codex', adapterVersion: getVersion() },
    sessionIdentity: 'session-a',
    sequence: 1,
    occurredAt: '2026-08-22T17:30:00.000Z',
    trigger: 'PostToolUse',
    parentEventKeys: [],
    dedupId: 'turn-a:tool-a:post',
    completeProjectState: {
      currentGoal: 'Persist every observable transition',
      acceptanceContract: { required: ['exact readback'] },
      plan: [{ id: 'store', status: 'in-progress' }],
      activeProcess: 'ProjectContinuity',
      activeStep: 'store',
      completed: [],
      inProgress: ['store'],
      blockers: [],
      failures: [],
      decisions: [],
      changedFiles: [],
      commands: [],
      proofArtifacts: [],
      untested: ['real host hooks'],
      nextAction: 'append and read back',
      resumeConflicts: [],
    },
    ...overrides,
  });
}

// Real product store/outbox and filesystem; explicit exact-content fake managed CLI, no native CLI claim.
function fixture() {
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  // The fake CLI has no on-disk DB: explicit isolated consent authorizes initial replay.
  const brainHome = path.join(root, 'brain');
  fs.mkdirSync(path.join(brainHome, 'turn-capture'), { recursive: true });
  fs.writeFileSync(path.join(brainHome, 'turn-capture', 'policy.json'), JSON.stringify({
    schemaVersion: 1, projects: { [project]: 'on' }, paths: {},
  }));
  const rows = new Map(), calls = [];
  const runner = (_binary, args) => {
    calls.push(args[1]);
    const key = args[args.indexOf('--key') + 1];
    if (args[1] === 'store') {
      if (rows.has(key)) return { status: 1, stderr: 'already exists' };
      rows.set(key, args[args.indexOf('--value') + 1]);
      return { status: 0 };
    }
    if (args[1] === 'retrieve') return { status: rows.has(key) ? 0 : 1, stdout: rows.get(key) || '' };
    throw new Error('unexpected fake managed CLI call');
  };
  const open = () => new ProjectProgressionStore({ projectDir: project, brainHome, reader: null, rufloBinary: '/fake-managed-ruflo', runner });
  return { open, rows, calls, snapshot: progression(project) };
}

it('the product replays a complete unterminated snapshot once and appends a separate exact-readback commit', () => {
  const f = fixture();
  const first = f.open();
  first.outbox.appendSnapshot(f.snapshot);
  fs.truncateSync(first.outbox.path, fs.statSync(first.outbox.path).size - 1);
  const reopened = f.open();
  expect(reopened.replay()).toEqual([expect.objectContaining({ eventKey: f.snapshot.eventKey, readbackDigest: f.snapshot.payloadDigest })]);
  expect(JSON.parse(f.rows.get(f.snapshot.eventKey))).toEqual(f.snapshot);
  expect(reopened.outbox.records().map((r) => r.type)).toEqual(['snapshot', 'commit']);
  expect(reopened.outbox.pendingSnapshots()).toEqual([]);
  const count = f.calls.length;
  expect(f.open().replay()).toEqual([]);
  expect(f.calls.length).toBe(count);
});

it('a torn suffix cannot corrupt the accepted prefix when product replay tries to append its commit', () => {
  const f = fixture();
  const first = f.open();
  first.outbox.appendSnapshot(f.snapshot);
  fs.appendFileSync(first.outbox.path, '{"type":"snapshot"');
  const original = fs.readFileSync(first.outbox.path);
  const reopened = f.open();
  expect(() => reopened.replay()).toThrow(/recover the torn tail/);
  expect(JSON.parse(f.rows.get(f.snapshot.eventKey))).toEqual(f.snapshot);
  expect(fs.readFileSync(first.outbox.path)).toEqual(original);
  expect(f.open().outbox.pendingSnapshots()).toEqual([f.snapshot]);
});
