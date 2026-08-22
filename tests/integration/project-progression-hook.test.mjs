import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureProjectTransition } from '../../plugin/scripts/project-progression-hook.mjs';
import { runSessionSnapshotHook } from '../../plugin/scripts/session-snapshot-hook.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { getVersion } from '../../scripts/version.mjs';

const temporaryRoots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-hook-')));
  fs.mkdirSync(path.join(root, '.swarm'));
  temporaryRoots.push(root);
  return root;
}

function completeState(overrides = {}) {
  return {
    currentGoal: 'Make project continuity perennial',
    acceptanceContract: { required: ['cross-host exact resume'] },
    plan: [{ id: 'capture', status: 'in-progress' }],
    activeProcess: 'ProjectContinuity',
    activeStep: 'capture',
    completed: ['contract', 'resolver', 'outbox'],
    inProgress: ['capture'],
    blockers: [],
    failures: [],
    decisions: [],
    changedFiles: ['plugin/scripts/project-progression-hook.mjs'],
    commands: [],
    proofArtifacts: [],
    untested: ['packed host crash resume'],
    nextAction: 'Wire SessionStart restore',
    resumeConflicts: [],
    ...overrides,
  };
}

function sourceIdentity(project, overrides = {}) {
  return {
    checkoutPath: project,
    worktreeId: 'primary',
    branch: 'main',
    head: 'a'.repeat(40),
    trackedDigest: 'b'.repeat(64),
    untrackedDigest: 'c'.repeat(64),
    dirtyTreeDigest: 'd'.repeat(64),
    ...overrides,
  };
}

function envelope(project, host, progressionOverrides = {}, envelopeOverrides = {}) {
  const resolution = resolveProjectStore({ projectDir: project });
  const common = {
    sequence: 4,
    occurredAt: '2026-08-22T18:00:00.000Z',
    dedupId: 'turn-4:tool-2:post',
    parentEventKeys: [],
    sourceIdentity: sourceIdentity(project),
    completeProjectState: completeState(),
    canonicalAgentDbPath: resolution.canonicalAgentDbPath,
    ...progressionOverrides,
  };
  const native = {
    session_id: `${host}-session`,
    hook_event_name: 'PostToolUse',
    cwd: project,
    ...envelopeOverrides,
  };
  if (host === 'claude') {
    native.project_progression = {
      sequence: common.sequence,
      occurred_at: common.occurredAt,
      dedup_id: common.dedupId,
      parent_event_keys: common.parentEventKeys,
      source_identity: common.sourceIdentity,
      complete_project_state: common.completeProjectState,
      canonical_agent_db_path: common.canonicalAgentDbPath,
    };
  } else {
    native.projectProgression = common;
  }
  return native;
}

function recordingStore(project, capture = (snapshot) => ({
  eventKey: snapshot.eventKey,
  payloadDigest: snapshot.payloadDigest,
  readbackDigest: snapshot.payloadDigest,
  alreadyStored: false,
})) {
  const resolution = resolveProjectStore({ projectDir: project });
  const snapshots = [];
  const options = [];
  return {
    snapshots,
    options,
    factory(input) {
      options.push(input);
      return {
        resolution,
        capture(snapshot) {
          snapshots.push(snapshot);
          return capture(snapshot);
        },
      };
    },
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ADR-073 host-neutral progression capture', () => {
  it.each(['claude', 'codex'])('normalizes a complete %s envelope and captures it through one store', (host) => {
    const project = temporaryProject();
    const store = recordingStore(project);

    const result = captureProjectTransition({
      host,
      payload: envelope(project, host),
      projectDir: project,
      adapterVersion: getVersion(),
      storeFactory: store.factory,
    });

    expect(result.snapshot).toMatchObject({
      hostIdentity: { host, adapterVersion: getVersion() },
      sessionIdentity: `${host}-session`,
      sequence: 4,
      trigger: 'PostToolUse',
      projectIdentity: resolveProjectStore({ projectDir: project }).projectIdentity,
      completeProjectState: { nextAction: 'Wire SessionStart restore' },
    });
    expect(result.receipt.readbackDigest).toBe(result.snapshot.payloadDigest);
    expect(store.snapshots).toEqual([result.snapshot]);
    expect(store.options).toEqual([{
      projectDir: project,
      requestedStorePath: resolveProjectStore({ projectDir: project }).canonicalAgentDbPath,
    }]);
  });

  it('redacts secret-bearing operational input before the store or outbox can see it', () => {
    const project = temporaryProject();
    const store = recordingStore(project);
    const apiKey = 'sk-live-secret-value-123456';
    const bearer = 'bearer-secret-value-123456';
    const payload = envelope(project, 'codex', {
      completeProjectState: completeState({
        decisions: [{ apiKey, outcome: 'publish failed with HTTP 401' }],
        commands: [`curl -H "Authorization: Bearer ${bearer}" https://example.invalid`],
      }),
    });

    const { snapshot } = captureProjectTransition({
      host: 'codex', payload, projectDir: project, adapterVersion: getVersion(), storeFactory: store.factory,
    });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(bearer);
    expect(snapshot.completeProjectState.decisions[0].outcome).toBe('publish failed with HTTP 401');
    expect(snapshot.redactions).toEqual(expect.arrayContaining([
      { path: '$.completeProjectState.decisions[0].apiKey', kind: 'api-key' },
      { path: '$.completeProjectState.commands[0]', kind: 'bearer-token' },
    ]));
    expect(store.snapshots).toEqual([snapshot]);
  });

  it.each([
    ['unknown host', { host: 'grok' }, /unsupported progression host/i],
    ['unsupported boundary', { envelopeOverrides: { hook_event_name: 'Notification' } }, /unsupported progression trigger/i],
    ['missing session', { envelopeOverrides: { session_id: '' } }, /session/i],
    ['foreign canonical path', { progressionOverrides: { canonicalAgentDbPath: '/tmp/foreign/.swarm/memory.db' } }, /foreign store root/i],
    ['foreign checkout', { progressionOverrides: { sourceIdentity: sourceIdentity('/tmp/foreign') } }, /checkout path/i],
  ])('rejects %s before persistence', (_label, changes, expected) => {
    const project = temporaryProject();
    const store = recordingStore(project);
    const payload = envelope(
      project,
      'codex',
      changes.progressionOverrides,
      changes.envelopeOverrides,
    );

    expect(() => captureProjectTransition({
      host: changes.host ?? 'codex',
      payload,
      projectDir: project,
      adapterVersion: getVersion(),
      storeFactory: store.factory,
    })).toThrow(expected);
    expect(store.snapshots).toEqual([]);
  });

  it('rejects ambiguous or incomplete progression extensions instead of guessing', () => {
    const project = temporaryProject();
    const store = recordingStore(project);
    const ambiguous = envelope(project, 'codex');
    ambiguous.project_progression = ambiguous.projectProgression;
    const incomplete = envelope(project, 'codex');
    delete incomplete.projectProgression.completeProjectState;

    for (const payload of [ambiguous, incomplete]) {
      expect(() => captureProjectTransition({
        host: 'codex', payload, projectDir: project, adapterVersion: getVersion(), storeFactory: store.factory,
      })).toThrow();
    }
    expect(store.snapshots).toEqual([]);
  });

  it('propagates persistence failure and returns no success-shaped receipt', () => {
    const project = temporaryProject();
    const store = recordingStore(project, () => { throw new Error('exact readback failed'); });

    expect(() => captureProjectTransition({
      host: 'claude',
      payload: envelope(project, 'claude'),
      projectDir: project,
      adapterVersion: getVersion(),
      storeFactory: store.factory,
    })).toThrow('exact readback failed');
    expect(store.snapshots).toHaveLength(1);
  });

  it('derives one stable event identity so the strict store can deduplicate a host retry exactly once', () => {
    const project = temporaryProject();
    const rows = new Map();
    const store = recordingStore(project, (snapshot) => {
      const prior = rows.get(snapshot.eventKey);
      if (prior && prior !== snapshot.payloadDigest) throw new Error('event collision');
      rows.set(snapshot.eventKey, snapshot.payloadDigest);
      return {
        eventKey: snapshot.eventKey,
        payloadDigest: snapshot.payloadDigest,
        readbackDigest: snapshot.payloadDigest,
        alreadyStored: Boolean(prior),
      };
    });
    const payload = envelope(project, 'codex');

    const first = captureProjectTransition({
      host: 'codex', payload, projectDir: project, adapterVersion: getVersion(), storeFactory: store.factory,
    });
    const retry = captureProjectTransition({
      host: 'codex', payload, projectDir: project, adapterVersion: getVersion(), storeFactory: store.factory,
    });

    expect(retry.snapshot).toEqual(first.snapshot);
    expect(rows.size).toBe(1);
    expect(first.receipt.alreadyStored).toBe(false);
    expect(retry.receipt.alreadyStored).toBe(true);
  });
});

describe('the existing dual-host session snapshot hook is the production caller', () => {
  it('preserves the metadata receipt and forwards an explicit progression envelope', () => {
    const project = temporaryProject();
    const calls = [];

    const result = runSessionSnapshotHook(project, 'PreCompact', {
      rawInput: JSON.stringify(envelope(project, 'claude', {}, { hook_event_name: 'PreCompact' })),
      host: 'claude',
      captureProgression(input) { calls.push(input); return { receipt: { eventKey: 'captured' } }; },
    });

    expect(result).toEqual({ metadataWritten: true, progressionCaptured: true, receipt: { eventKey: 'captured' } });
    expect(calls).toEqual([expect.objectContaining({ host: 'claude', projectDir: project })]);
    expect(fs.readFileSync(path.join(project, '.swarm', 'agentdb-sessions.jsonl'), 'utf8'))
      .toContain('"event":"PreCompact"');
  });

  it('does not invent progression when the native host supplied no complete extension', () => {
    const project = temporaryProject();
    let called = false;

    const result = runSessionSnapshotHook(project, 'SessionEnd', {
      rawInput: JSON.stringify({ session_id: 'native-only', hook_event_name: 'SessionEnd', cwd: project }),
      host: 'codex',
      captureProgression() { called = true; },
    });

    expect(result).toEqual({ metadataWritten: true, progressionCaptured: false, receipt: null });
    expect(called).toBe(false);
  });
});
