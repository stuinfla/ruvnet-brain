import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { getVersion } from '../../scripts/version.mjs';
import { adoptedProject, cleanup, fakeRuflo } from '../helpers/continuity-fixture.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { buildProjectProgression } from '../../plugin/scripts/project-progression-producer.mjs';
import { createProgressionSnapshot, restoreProjectProgression } from '../../plugin/scripts/project-progression-contract.mjs';
import { runSessionSnapshotHook, runOutboxReplay, queueCapture, queuedWork } from '../../plugin/scripts/session-snapshot-hook.mjs';
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


describe('customer managed actions and immutable frozen recovery', () => {
  function boundary(f, payload) {
    return runSessionSnapshotHook(f.dir, payload.hook_event_name, {
      rawInput: JSON.stringify(payload), host: 'codex', env: f.env,
      makeStoreFactory: () => () => f.store, spawnReplay: () => false,
      captureTurn: () => ({}), captureEvents: () => ({}),
    });
  }
  function settle(f) {
    const payload = { session_id: 'settled', hook_event_name: 'SessionEnd' };
    for (let i = 0; i < 4; i++) boundary(f, payload);
    expect(boundary(f, payload).skipped).toMatch(/no-op/);
  }
  it.each([
    ['pending', 'PreToolUse', undefined],
    ['failure', 'PostToolUse', { exit_code: 7, stderr: 'failed' }],
    ['interrupted', 'PostToolUse', { interrupted: true }],
    ['unknown', 'PostToolUse', 'unstructured success-looking prose'],
  ])('captures a new %s action on a settled unchanged project exactly once', (outcome, trigger, response) => {
    const f = fixture(); settle(f);
    const payload = { session_id: 'managed', hook_event_name: trigger, tool_name: 'Bash',
      tool_input: { command: 'ruflo status password=hunter2' }, tool_response: response };
    const produced = buildProjectProgression({ resolution: f.resolution, env: f.env, host: 'codex', payload });
    expect(produced.skipped).toBeUndefined();
    expect(produced.projectProgression.completeProjectState.commands).toHaveLength(0);
    const result = boundary(f, payload);
    expect(result.progressionCaptured).toBe(true);
    const recorded = f.store.retrieveSnapshots([result.receipt.eventKey]).snapshots[0];
    expect(recorded.completeProjectState.commands).toHaveLength(1);
    expect(recorded.completeProjectState.commands[0].outcome).toBe(outcome);
    expect(JSON.stringify(recorded)).not.toContain('hunter2');
    expect(recorded.completeProjectState.failures).toHaveLength(['failure', 'interrupted'].includes(outcome) ? 1 : 0);
    expect(boundary(f, { session_id: 'settled', hook_event_name: 'SessionEnd' }).skipped).toMatch(/no-op/);
  });

  it('freezes a bounded redacted tool result before queue minimization and writes it only once', () => {
    const f = fixture(); settle(f);
    queueCapture({ projectDir: f.dir, event: 'PostToolUse', host: 'codex', env: f.env,
      payload: { session_id: 'queued-tool', tool_name: 'Bash', tool_input: { command: 'check password=hunter2' },
        tool_response: { exit_code: 2, stderr: 'failure' } } });
    const captured = [];
    drain(f, { onCaptured: (result) => captured.push(result) });
    expect(queuedWork(f.dir)).toBe(0);
    const recorded = f.store.retrieveSnapshots([captured[0].receipt.eventKey]).snapshots[0];
    expect(recorded.completeProjectState.commands).toHaveLength(1);
    expect(recorded.completeProjectState.commands[0].outcome).toBe('failure');
    expect(recorded.completeProjectState.failures).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain('hunter2');
  });

  it('binds future frozen identity to exact content despite the same committed sequence', () => {
    const f = fixture(); settle(f);
    const options = { resolution: f.resolution, host: 'codex', env: f.env,
      payload: { session_id: 'deferred', hook_event_name: 'SessionEnd' }, now: () => '2026-10-04T00:00:00.000Z' };
    const first = buildProjectProgression(options).projectProgression;
    fs.writeFileSync(`${f.dir}/dirty.txt`, 'changed between boundaries');
    const second = buildProjectProgression(options).projectProgression;
    expect(first.sequence).toBe(second.sequence);
    expect(first.dedupId).not.toBe(second.dedupId);
    expect(buildProjectProgression(options).projectProgression.dedupId).toBe(second.dedupId);
  });

  function extension(row, f) {
    return { canonicalAgentDbPath: f.resolution.canonicalAgentDbPath, sourceIdentity: row.sourceIdentity,
      sequence: row.sequence, occurredAt: row.occurredAt, parentEventKeys: row.parentEventKeys,
      dedupId: row.dedupId, completeProjectState: row.completeProjectState };
  }
  function collidingQueue(f, { canonicalOnly = false } = {}) {
    // Same event identity and distinct content, the actual pre-fix frozen SessionEnd shape.
    const first = createProgressionSnapshot({ ...snapshot(f, 'codex'), trigger: 'SessionEnd',
      sourceIdentity: { ...snapshot(f, 'codex').sourceIdentity, capturePath: f.dir },
      hostIdentity: { host: 'codex', adapterVersion: getVersion() }, sequence: 20, dedupId: 'codex:deferred:SessionEnd:20' });
    const second = createProgressionSnapshot({ ...first,
      sourceIdentity: { ...first.sourceIdentity, dirtyTreeDigest: 'e'.repeat(64) },
      completeProjectState: { ...first.completeProjectState, nextAction: 'Original frozen unfinished action' } });
    expect(second.eventKey).toBe(first.eventKey);
    expect(second.payloadDigest).not.toBe(first.payloadDigest);
    if (canonicalOnly) f.store.appendExact(first);
    else f.store.capture(first);
    queueCapture({ projectDir: f.dir, event: 'SessionEnd', host: 'codex', env: f.env,
      payload: { session_id: second.sessionIdentity, projectProgression: extension(second, f) } });
    const later = createProgressionSnapshot({ ...second, sequence: 21, dedupId: 'later',
      completeProjectState: { ...second.completeProjectState, nextAction: 'Later frozen action' } });
    queueCapture({ projectDir: f.dir, event: 'SessionEnd', host: 'codex', env: f.env,
      payload: { session_id: later.sessionIdentity, projectProgression: extension(later, f) } });
    expect(queuedWork(f.dir)).toBe(2);
    return { first, second, later };
  }
  function drain(f, extra = {}) {
    return runOutboxReplay({ projectDir: f.dir, makeStoreFactory: () => () => f.store, ...extra });
  }

  it('preserves the immutable row and frozen content, verifies recovery before advancing later work', () => {
    const f = fixture(); const { first, second, later } = collidingQueue(f);
    const before = f.store.retrieveSnapshots([first.eventKey]).snapshots[0];
    const captured = [];
    drain(f, { onCaptured: (result) => captured.push(result) });
    expect(queuedWork(f.dir)).toBe(0);
    expect(captured).toHaveLength(2);
    const recovered = f.store.retrieveSnapshots([captured[0].receipt.eventKey]).snapshots[0];
    expect(f.store.retrieveSnapshots([first.eventKey]).snapshots[0]).toEqual(before);
    expect(recovered.eventKey).not.toBe(first.eventKey);
    for (const field of ['sourceIdentity', 'completeProjectState', 'sequence', 'occurredAt', 'parentEventKeys']) {
      expect(recovered[field], field).toEqual(second[field]);
    }
    expect(recovered.recoveryDiagnostics).toEqual({ kind: 'immutable-event-key-collision', authoritative: false,
      originalEventKey: first.eventKey, existingPayloadDigest: first.payloadDigest, frozenPayloadDigest: second.payloadDigest });
    expect(captured[0].receipt.readbackDigest).toBe(recovered.payloadDigest);
    expect(f.store.retrieveSnapshots([later.eventKey]).snapshots).toHaveLength(1);
    expect(f.store.outbox.quarantinedKeys()).toEqual([expect.objectContaining({ eventKey: first.eventKey })]);
    // Exact deterministic retry verifies the same recovered event; it creates no new identity.
    expect(f.store.captureFrozen(second, { canCommit: () => true }).snapshot).toEqual(recovered);
  });

  it('settles recovered debt when the immutable original exists only in the canonical store', () => {
    const f = fixture(); const { first, second } = collidingQueue(f, { canonicalOnly: true });
    const captured = [];
    drain(f, { onCaptured: (result) => captured.push(result) });
    expect(queuedWork(f.dir)).toBe(0);
    expect(captured).toHaveLength(2);
    expect(f.store.outbox.pendingSnapshots()).toEqual([]);
    const records = f.store.outbox.records();
    expect(records).toContainEqual(expect.objectContaining({ type: 'recovery',
      eventKey: second.eventKey, payloadDigest: second.payloadDigest,
      recoveryEventKey: captured[0].receipt.eventKey }));
    expect(records.filter((row) => row.type === 'commit' && row.eventKey === first.eventKey)).toEqual([]);
    const before = records.length;
    expect(drain(f)).toBe(0);
    expect(f.store.outbox.records()).toHaveLength(before);
    expect(f.store.retrieveSnapshots([first.eventKey]).snapshots[0]).toEqual(first);
  });

  it('retries an interruption after recovery readback before the append-only disposition', () => {
    const f = fixture(); collidingQueue(f, { canonicalOnly: true });
    const record = f.store.outbox.markRecovered.bind(f.store.outbox);
    f.store.outbox.markRecovered = () => { throw new Error('interrupted disposition fsync'); };
    drain(f);
    expect(queuedWork(f.dir)).toBe(2);
    expect(f.store.outbox.pendingSnapshots()).toHaveLength(1);
    const keys = f.store.listSnapshotKeys();
    f.store.outbox.markRecovered = record;
    drain(f);
    expect(queuedWork(f.dir)).toBe(0);
    expect(f.store.outbox.pendingSnapshots()).toEqual([]);
    expect(f.store.listSnapshotKeys()).toHaveLength(keys.length + 1); // only later work adds a row
  });

  it('retains frozen queue work on failed recovery and retries the deterministic key', () => {
    const f = fixture(); const { first } = collidingQueue(f);
    fs.writeFileSync(f.cli.counter, '10');
    drain(f);
    expect(queuedWork(f.dir)).toBe(2);
    const pending = f.store.outbox.pendingSnapshots();
    expect(pending).toHaveLength(1);
    const recoveryKey = pending[0].eventKey;
    expect(recoveryKey).not.toBe(first.eventKey);
    fs.writeFileSync(f.cli.counter, '0');
    drain(f);
    expect(queuedWork(f.dir)).toBe(0);
    expect(f.store.retrieveSnapshots([recoveryKey]).snapshots).toHaveLength(1);
  });

  it('retains the queue when the recovery write lacks exact readback, then verifies the same key', () => {
    const f = fixture(); const { first } = collidingQueue(f);
    const read = f.store.readFast.bind(f.store);
    f.store.readFast = (work) => {
      const result = read(work);
      if (result.ok && typeof result.value === 'string') {
        const row = JSON.parse(result.value);
        if (row.recoveryDiagnostics) return { ok: true, value: JSON.stringify({ ...row, payloadDigest: 'wrong-readback' }) };
      }
      return result;
    };
    drain(f);
    expect(queuedWork(f.dir)).toBe(2);
    const pending = f.store.outbox.pendingSnapshots();
    expect(pending).toHaveLength(1);
    expect(pending[0].eventKey).not.toBe(first.eventKey);
    f.store.readFast = read;
    drain(f);
    expect(queuedWork(f.dir)).toBe(0);
    expect(f.store.retrieveSnapshots([pending[0].eventKey]).snapshots[0]).toEqual(pending[0]);
  });

  it('suspends frozen recovery after opt-out and requires an explicit replay fence', () => {
    const f = fixture(); const { second } = collidingQueue(f);
    expect(() => f.store.captureFrozen(second)).toThrow(/requires replay fencing/);
    const brainHome = `${f.home}/.cache/ruvnet-brain`;
    fs.mkdirSync(`${brainHome}/turn-capture`, { recursive: true });
    fs.writeFileSync(`${brainHome}/turn-capture/policy.json`, JSON.stringify({
      schemaVersion: 1, projects: { [f.dir]: 'off' }, paths: {},
    }));
    expect(() => f.store.captureFrozen(second, { canCommit: () => true })).toThrow(/opt-out/);
    expect(queuedWork(f.dir)).toBe(2);
  });

  it('refuses recovery for unavailable exact reads, invalid canonical content and lost fencing', () => {
    const f = fixture(); const { first, second } = collidingQueue(f);
    const originalRetrieve = f.store.retrieveSnapshots.bind(f.store);
    f.store.retrieveSnapshots = () => { throw new Error('canonical read unavailable'); };
    expect(() => f.store.captureFrozen(second, { canCommit: () => true })).toThrow(/unavailable/);
    expect(queuedWork(f.dir)).toBe(2);
    f.store.retrieveSnapshots = () => ({ rejected: [], snapshots: [{ ...first, payloadDigest: 'invalid' }] });
    expect(() => f.store.captureFrozen(second, { canCommit: () => true })).toThrow(/invalid progression snapshot/);
    f.store.retrieveSnapshots = originalRetrieve;
    let calls = 0;
    expect(() => f.store.captureFrozen(second, { canCommit: () => ++calls === 1 })).toThrow(/fencing/);
    expect(f.store.listSnapshotKeys()).toEqual([first.eventKey]);
  });
});
