import { describe, expect, it } from 'vitest';
import { createProgressionSnapshot, restoreProjectProgression, digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';
import { prepareFrontier, readFrontier, FRONTIER_NAMESPACE } from '../../plugin/scripts/project-progression-frontier.mjs';
const projectIdentity = { id: 'frontier-test', canonicalAgentDbPath: '/fixture/.swarm/memory.db' };
const sourceIdentity = { checkoutPath: '/fixture', worktreeId: 'fixture', branch: 'main', head: 'a'.repeat(40),
  trackedDigest: 'b'.repeat(64), untrackedDigest: 'c'.repeat(64), dirtyTreeDigest: 'd'.repeat(64) };
const empty = Object.fromEntries(['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions',
  'changedFiles', 'commands', 'proofArtifacts', 'untested', 'resumeConflicts'].map(field => [field, []]));
function snapshot(sequence, parents, state) {
  return createProgressionSnapshot({ projectIdentity, sourceIdentity, sequence, parentEventKeys: parents,
    hostIdentity: { host: 'codex', adapterVersion: 'fixture' }, sessionIdentity: 'fixture',
    occurredAt: '2026-10-05T00:00:00.000Z', trigger: 'PostToolUse', dedupId: `fixture-${sequence}`,
    completeProjectState: state });
}
function fixture(count = 64) {
  const rows = new Map();
  const reads = [];
  const reader = { listKeys: namespace => [...rows.keys()].filter(key => key.startsWith(`${namespace}:`)).map(key => key.slice(namespace.length + 1)).sort(),
    readContent: (namespace, key) => { reads.push({ namespace, key }); return rows.get(`${namespace}:${key}`) ?? null; } };
  const put = (namespace, row) => rows.set(`${namespace}:${row.eventKey}`, JSON.stringify(row));
  const history = [];
  let head = null;
  for (let index = 1; index <= count; index++) {
    history.push({ id: index, outcome: 'success', authoritative: false });
    head = snapshot(index, head ? [head.eventKey] : [], { ...empty, currentGoal: 'Preserve every field', nextAction: 'Verify',
      acceptanceContract: { exact: true }, activeProcess: null, activeStep: 'PostToolUse', observations: [...history], commands: [...history],
      futureUnknownField: { exact: ['retain', 'order'] } });
    put('project-progression', head);
  }
  return { rows, reads, reader, put, head, history };
}
function migrate(f) {
  const next = snapshot(f.history.length + 1, [f.head.eventKey], { ...f.head.completeProjectState,
    observations: [...f.history, { id: 'migration', authoritative: false }],
    commands: [...f.history, { id: 'migration', authoritative: false }] });
  const plan = prepareFrontier(f.reader, next, projectIdentity);
  f.put(FRONTIER_NAMESPACE, plan.candidate);
  return { next, ...plan };
}

describe('versioned current frontier with immutable full history', () => {
  it('does not promote an orphan candidate and explicitly defers old content audit after publication', () => {
    const f = fixture(); const plan = migrate(f);
    expect(readFrontier(f.reader, projectIdentity)).toBeNull();
    f.put(FRONTIER_NAMESPACE, plan.publication);
    f.reads.length = 0;
    const current = readFrontier(f.reader, projectIdentity);
    expect(current.historicalContentAudit).toBe('deferred');
    expect(f.reads.some(row => row.namespace === 'project-progression')).toBe(false);
    expect(readFrontier(f.reader, projectIdentity, { fullAudit: true }).state).toEqual(plan.next.completeProjectState);
  });
  it('retains exact historical command/observation order and unknown fields through a long delta chain', () => {
    const f = fixture(); const first = migrate(f); f.put(FRONTIER_NAMESPACE, first.publication);
    const expectedCommands = [...first.next.completeProjectState.commands];
    for (let index = 66; index <= 250; index++) {
      const prior = readFrontier(f.reader, projectIdentity);
      const observation = { id: index, outcome: 'unknown', authoritative: false };
      const next = snapshot(index, prior.heads, { ...prior.state, commands: [observation], observations: [observation] });
      const plan = prepareFrontier(f.reader, next, projectIdentity);
      f.put(FRONTIER_NAMESPACE, plan.candidate); f.put(FRONTIER_NAMESPACE, plan.publication);
      expectedCommands.push(observation);
    }
    const audited = readFrontier(f.reader, projectIdentity, { fullAudit: true });
    expect(audited.state.commands).toEqual(expectedCommands);
    expect(audited.state.observations).toEqual(expectedCommands);
    expect(audited.state.futureUnknownField).toEqual({ exact: ['retain', 'order'] });
    const candidateBodies = [...f.rows].filter(([key]) => key.startsWith(`${FRONTIER_NAMESPACE}:frontier`)).map(([, value]) => value);
    expect(Math.max(...candidateBodies.map(value => Buffer.byteLength(value)))).toBeLessThan(5000);
  });
  it('detects historical mutation on full audit without claiming it audited deferred content', () => {
    const f = fixture(); const first = migrate(f); f.put(FRONTIER_NAMESPACE, first.publication);
    const key = f.reader.listKeys('project-progression')[0]; const row = JSON.parse(f.rows.get(`project-progression:${key}`));
    row.completeProjectState.currentGoal = 'tampered';
    f.rows.set(`project-progression:${key}`, JSON.stringify(row));
    expect(readFrontier(f.reader, projectIdentity).historicalContentAudit).toBe('deferred');
    expect(() => readFrontier(f.reader, projectIdentity, { fullAudit: true })).toThrow(/invalid historical/);
    const { payloadDigest: _digest, ...body } = row; row.payloadDigest = digestCanonical(body);
    f.rows.set(`project-progression:${key}`, JSON.stringify(row));
    expect(() => readFrontier(f.reader, projectIdentity, { fullAudit: true })).toThrow(/coverage digest changed/);
  });
  it('rejects a publication under an alternate migration slot even with a recomputed digest', () => {
    const f = fixture(); const first = migrate(f);
    const { payloadDigest: _digest, ...body } = first.publication;
    body.eventKey += `-${'a'.repeat(64)}`;
    f.put(FRONTIER_NAMESPACE, { ...body, payloadDigest: digestCanonical(body) });
    expect(() => readFrontier(f.reader, projectIdentity)).toThrow(/unique sequence slot/);
  });
  it('refuses missing/extra legacy membership, missing publication ancestry, and mutated current state', () => {
    const f = fixture(); const first = migrate(f); f.put(FRONTIER_NAMESPACE, first.publication);
    f.rows.set('project-progression:external', '{}');
    expect(() => readFrontier(f.reader, projectIdentity)).toThrow(/membership changed/);
    f.rows.delete('project-progression:external');
    const row = structuredClone(first.candidate); row.liveState.currentGoal = 'tampered'; f.put(FRONTIER_NAMESPACE, row);
    expect(() => readFrontier(f.reader, projectIdentity)).toThrow(/body digest mismatch/);
  });
  it('matches multi-head restore semantics rather than concatenating conflicting extra fields', () => {
    const f = fixture();
    const branchState = { ...f.head.completeProjectState, observations: [{ branch: 'other' }],
      futureUnknownField: { competing: true } };
    const branch = snapshot(65, [f.head.eventKey], branchState); f.put('project-progression', branch);
    const sibling = snapshot(66, [f.head.eventKey], f.head.completeProjectState); f.put('project-progression', sibling);
    const snapshots = f.reader.listKeys('project-progression').map(key => JSON.parse(f.reader.readContent('project-progression', key)));
    const baseline = restoreProjectProgression(snapshots, { expectedProjectIdentity: projectIdentity });
    expect(baseline.state.observations).toBeNull();
    expect(baseline.state.futureUnknownField).toBeNull();
    const nextState = { ...baseline.state, observations: [{ afterMerge: true }], commands: baseline.state.commands };
    delete nextState.sourceIdentity; delete nextState.journalHeads;
    const next = snapshot(67, baseline.heads, nextState);
    const plan = prepareFrontier(f.reader, next, projectIdentity);
    f.put(FRONTIER_NAMESPACE, plan.candidate); f.put(FRONTIER_NAMESPACE, plan.publication);
    expect(readFrontier(f.reader, projectIdentity, { fullAudit: true }).state).toEqual(next.completeProjectState);
  });
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';
import { captureFrontierCandidate } from '../../plugin/scripts/project-progression-frontier-store.mjs';
const temporaryRoots = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function crashStore(f) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-crash-fixture-')); temporaryRoots.push(root);
  const store = { resolution: { projectIdentity }, outbox: new ProgressionOutbox({ projectRoot: root }),
    clock: () => '2026-10-05T00:00:00.000Z', frontierAuthority: { namespace: 'authority-fixture', key: 'epoch-0001',
      sha256: 'a'.repeat(64), latestPrefix: 'epoch-' }, requireCaptureConsent: () => {},
    readFast: work => ({ ok: true, value: work(f.reader) }),
    run: args => {
      if (args.includes('--help')) return { status: 0, stdout: '--append-conditions --require-native --append-only --embedding' };
      expect(args).toEqual(expect.arrayContaining(['--require-native', '--append-only', '--no-embedding']));
      const value = flag => args[args.indexOf(flag) + 1];
      const key = value('--key'); const namespace = value('--namespace');
      // Provider transaction semantics have separate actual native/source-CLI tests. Here the
      // deterministic runner isolates transport/crash ordering, not installed-provider proof.
      if (args.includes('--append-conditions')) {
        expect(JSON.parse(value('--append-conditions'))).toHaveLength(4);
        if (store.withdrawBeforePublication) return { status: 1, stderr: 'newer authority slot' };
      }
      const full = `${namespace}:${key}`;
      if (f.rows.has(full)) return { status: 1 };
      f.rows.set(full, value('--value')); return { status: 0 };
    } };
  return store;
}
describe('unpromoted frontier transport crash boundaries', () => {
  for (const phase of ['candidate-outbox-fsynced', 'candidate-stored', 'candidate-readback-verified',
    'publication-authority-verified', 'publication-stored', 'publication-readback-verified']) {
    it(`recovers a crash at ${phase} without acknowledging an unpublished candidate`, () => {
      const f = fixture(); const first = migrate(f);
      f.rows.delete(`${FRONTIER_NAMESPACE}:${first.candidate.eventKey}`);
      const store = crashStore(f);
      expect(() => captureFrontierCandidate(store, first.candidate, { canCommit: () => true,
        onPhase: observed => { if (observed === phase) throw new Error('simulated crash'); } })).toThrow('simulated crash');
      expect(store.outbox.pendingSnapshots()).toHaveLength(1);
      const current = readFrontier(f.reader, projectIdentity);
      expect(Boolean(current)).toBe(phase.startsWith('publication-stored') || phase === 'publication-readback-verified');
      const receipt = captureFrontierCandidate(store, first.candidate, { canCommit: () => true });
      expect(receipt.receipt.readbackDigest).toBe(first.candidate.payloadDigest);
      expect(store.outbox.pendingSnapshots()).toHaveLength(0);
      expect(readFrontier(f.reader, projectIdentity, { fullAudit: true }).state).toEqual(first.next.completeProjectState);
    });
  }
  it('retains evidence without publication or acknowledgement when authority is withdrawn before native commit', () => {
    const f = fixture(); const first = migrate(f); f.rows.delete(`${FRONTIER_NAMESPACE}:${first.candidate.eventKey}`);
    const store = crashStore(f); store.withdrawBeforePublication = true;
    expect(() => captureFrontierCandidate(store, first.candidate, { canCommit: () => true })).toThrow(/exact canonical read unavailable/);
    expect(readFrontier(f.reader, projectIdentity)).toBeNull();
    expect(store.outbox.pendingSnapshots()).toHaveLength(1);
  });
  it('refuses unsupported provider capability before any v2 write', () => {
    const f = fixture(); const first = migrate(f); f.rows.delete(`${FRONTIER_NAMESPACE}:${first.candidate.eventKey}`);
    const store = crashStore(f); store.run = () => ({ status: 0, stdout: 'legacy memory store' });
    expect(() => captureFrontierCandidate(store, first.candidate, { canCommit: () => true })).toThrow(/supported native conditional-append/);
    expect(f.reader.listKeys(FRONTIER_NAMESPACE)).toEqual([]);
  });
});
