import { describe, expect, it } from 'vitest';
import {
  PROJECT_PROGRESSION_SCHEMA,
  PROJECT_PROGRESSION_VERSION,
  createProgressionSnapshot,
  digestCanonical,
  redactProgression,
  restoreProjectProgression,
  validateProgressionSnapshot,
} from '../../plugin/scripts/project-progression-contract.mjs';

const PROJECT = Object.freeze({
  id: 'stuinfla/ruvnet-brain',
  canonicalAgentDbPath: '/repo/.swarm/memory.db',
});

const SOURCE = Object.freeze({
  checkoutPath: '/repo',
  worktreeId: 'primary',
  branch: 'main',
  head: 'a'.repeat(40),
  trackedDigest: 'b'.repeat(64),
  untrackedDigest: 'c'.repeat(64),
  dirtyTreeDigest: 'd'.repeat(64),
});

const STATE = Object.freeze({
  currentGoal: 'Complete perennial project continuity',
  acceptanceContract: { required: ['crash resume', 'cross-host resume'] },
  plan: [{ id: 'contract', status: 'in-progress' }],
  activeProcess: 'ProjectContinuity',
  activeStep: 'contract',
  completed: [],
  inProgress: ['contract'],
  blockers: [],
  failures: [],
  decisions: [],
  changedFiles: [],
  commands: [],
  proofArtifacts: [],
  untested: ['cross-host acceptance'],
  nextAction: 'Implement the pure domain contract',
  resumeConflicts: [],
});

function input(overrides = {}) {
  return {
    projectIdentity: PROJECT,
    sourceIdentity: SOURCE,
    hostIdentity: { host: 'codex', adapterVersion: '4.2.2-dev' },
    sessionIdentity: 'session-a',
    sequence: 7,
    occurredAt: '2026-08-22T17:00:00.000Z',
    trigger: 'PostToolUse',
    parentEventKeys: [],
    dedupId: 'turn-a:tool-a:post',
    completeProjectState: STATE,
    ...overrides,
  };
}

describe('ADR-073 ProjectProgression snapshot identity', () => {
  it('creates the canonical versioned snapshot and preserves supplied source identity', () => {
    const snapshot = createProgressionSnapshot(input());

    expect(snapshot).toMatchObject({
      schema: PROJECT_PROGRESSION_SCHEMA,
      schemaVersion: PROJECT_PROGRESSION_VERSION,
      projectIdentity: PROJECT,
      sourceIdentity: SOURCE,
      sequence: 7,
    });
    expect(snapshot.eventKey).toMatch(/^project-progress-v1-[a-z0-9._-]+-[a-z0-9._-]+-[a-z0-9._-]+-000000000007-[a-f0-9]{64}$/);
    expect(snapshot.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('canonicalizes object-key order before hashing', () => {
    expect(digestCanonical({ b: 2, nested: { y: 2, x: 1 }, a: 1 }))
      .toBe(digestCanonical({ a: 1, nested: { x: 1, y: 2 }, b: 2 }));
  });

  it('is reproducible for one observation and sortable by monotonic sequence', () => {
    expect(createProgressionSnapshot(input())).toEqual(createProgressionSnapshot(input()));

    const earlier = createProgressionSnapshot(input({ sequence: 6, dedupId: 'turn-a:tool-a:pre' }));
    const later = createProgressionSnapshot(input());
    expect(earlier.eventKey.localeCompare(later.eventKey)).toBeLessThan(0);
  });
});

describe('secret redaction', () => {
  it('removes secret values while preserving their type, location, and operational outcome', () => {
    const apiKey = 'sk-live-super-secret-value';
    const bearer = 'bearer-secret-token-value';
    const password = 'database-password-value';
    const state = {
      ...STATE,
      decisions: [{ outcome: 'deployment failed with HTTP 401', apiKey }],
      commands: [`curl -H "Authorization: Bearer ${bearer}" https://example.invalid`],
      failures: [`database rejected password=${password}; retry remains open`],
    };

    const snapshot = createProgressionSnapshot(input({ completeProjectState: state }));
    const serialized = JSON.stringify(snapshot);

    for (const secret of [apiKey, bearer, password]) expect(serialized).not.toContain(secret);
    expect(snapshot.completeProjectState.decisions[0].outcome).toBe('deployment failed with HTTP 401');
    expect(snapshot.redactions).toEqual(expect.arrayContaining([
      { path: '$.completeProjectState.commands[0]', kind: 'bearer-token' },
      { path: '$.completeProjectState.decisions[0].apiKey', kind: 'api-key' },
      { path: '$.completeProjectState.failures[0]', kind: 'password' },
    ]));
    expect(JSON.stringify(snapshot.redactions)).not.toContain(apiKey);
  });

  it('redacts deterministically without mutating the supplied value', () => {
    const original = { z: { clientSecret: 'secret-value-123456' }, a: 'safe outcome' };
    const first = redactProgression(original);
    const second = redactProgression(original);

    expect(first).toEqual(second);
    expect(original.z.clientSecret).toBe('secret-value-123456');
    expect(first.value).toEqual({ a: 'safe outcome', z: { clientSecret: '[REDACTED:secret]' } });
    expect(first.redactions).toEqual([{ path: '$.z.clientSecret', kind: 'secret' }]);
  });
});

describe('snapshot verification', () => {
  it('accepts an exact snapshot for the expected project identity', () => {
    expect(validateProgressionSnapshot(createProgressionSnapshot(input()), {
      expectedProjectIdentity: PROJECT,
    })).toEqual({ ok: true, errors: [] });
  });

  it('rejects malformed, unverifiable, and foreign-project candidates', () => {
    const valid = createProgressionSnapshot(input());
    const tampered = structuredClone(valid);
    tampered.completeProjectState.nextAction = 'silently replaced';
    const foreign = createProgressionSnapshot(input({
      projectIdentity: { id: 'someone/else', canonicalAgentDbPath: '/else/.swarm/memory.db' },
    }));

    expect(validateProgressionSnapshot(null, { expectedProjectIdentity: PROJECT }).errors)
      .toContain('snapshot must be an object');
    expect(validateProgressionSnapshot(tampered, { expectedProjectIdentity: PROJECT }).errors)
      .toContain('payload digest mismatch');
    expect(validateProgressionSnapshot(foreign, { expectedProjectIdentity: PROJECT }).errors)
      .toEqual(expect.arrayContaining(['foreign project id', 'foreign canonical AgentDB path']));
  });

  it('rejects a forged event key even when the attacker recomputes the payload digest', () => {
    const forged = structuredClone(createProgressionSnapshot(input()));
    forged.eventKey = `${forged.eventKey}-forged`;
    const body = structuredClone(forged);
    delete body.payloadDigest;
    forged.payloadDigest = digestCanonical(body);

    expect(validateProgressionSnapshot(forged, { expectedProjectIdentity: PROJECT }).errors)
      .toContain('event key mismatch');
  });

  it('requires the supplied exact source and dirty-tree identities', () => {
    const { dirtyTreeDigest: _removed, ...incomplete } = SOURCE;
    expect(() => createProgressionSnapshot(input({ sourceIdentity: incomplete })))
      .toThrow(/sourceIdentity\.dirtyTreeDigest/);
  });

  it('rejects unredacted secret material and redaction markers that carry a value', () => {
    const secret = structuredClone(createProgressionSnapshot(input()));
    secret.completeProjectState.decisions = [{ apiKey: 'sk-unredacted-secret-value' }];
    delete secret.payloadDigest;
    secret.payloadDigest = digestCanonical(secret);

    const leakingMarker = structuredClone(createProgressionSnapshot(input()));
    leakingMarker.redactions = [{ path: '$.x', kind: 'token', value: 'raw-secret-value' }];
    delete leakingMarker.payloadDigest;
    leakingMarker.payloadDigest = digestCanonical(leakingMarker);

    expect(validateProgressionSnapshot(secret, { expectedProjectIdentity: PROJECT }).errors)
      .toContain('unredacted secret material');
    expect(validateProgressionSnapshot(leakingMarker, { expectedProjectIdentity: PROJECT }).errors)
      .toContain('invalid redaction marker');
  });
});

function withDigest(snapshot, changes) {
  const changed = { ...structuredClone(snapshot), ...changes };
  delete changed.payloadDigest;
  return { ...changed, payloadDigest: digestCanonical(changed) };
}

describe('causal restoration', () => {
  it('selects only maximal heads and excludes causally stale ancestors from injected state', () => {
    const first = createProgressionSnapshot(input({ sequence: 1, dedupId: 'one' }));
    const second = createProgressionSnapshot(input({
      sequence: 2,
      dedupId: 'two',
      parentEventKeys: [first.eventKey],
      completeProjectState: { ...STATE, completed: ['contract'], inProgress: [], nextAction: 'Wire the bridge' },
    }));

    const restored = restoreProjectProgression([first, second], { expectedProjectIdentity: PROJECT });

    expect(restored.ok).toBe(true);
    expect(restored.heads).toEqual([second.eventKey]);
    expect(restored.causallyStale).toEqual([first.eventKey]);
    expect(restored.rejected).toEqual([{ eventKey: first.eventKey, reasons: ['causally stale'] }]);
    expect(restored.state).toMatchObject({
      completed: ['contract'],
      inProgress: [],
      nextAction: 'Wire the bridge',
      journalHeads: [second.eventKey],
      resumeConflicts: [],
    });
  });

  it('rejects malformed, foreign, missing-parent, and non-monotonic candidates without hiding a valid head', () => {
    const valid = createProgressionSnapshot(input({ sequence: 1, dedupId: 'valid' }));
    const foreign = createProgressionSnapshot(input({
      projectIdentity: { id: 'foreign/project', canonicalAgentDbPath: '/foreign/.swarm/memory.db' },
      sequence: 1,
      dedupId: 'foreign',
    }));
    const missingParent = createProgressionSnapshot(input({
      sequence: 2, dedupId: 'missing', parentEventKeys: ['project-progress-v1-does-not-exist'],
    }));
    const nonMonotonic = createProgressionSnapshot(input({
      sequence: 0, dedupId: 'backwards', parentEventKeys: [valid.eventKey],
    }));
    const tampered = structuredClone(valid);
    tampered.completeProjectState.nextAction = 'forged';

    const restored = restoreProjectProgression(
      [tampered, missingParent, foreign, nonMonotonic, valid],
      { expectedProjectIdentity: PROJECT },
    );
    const reasons = restored.rejected.flatMap((row) => row.reasons);

    expect(restored.heads).toEqual([valid.eventKey]);
    expect(reasons).toEqual(expect.arrayContaining([
      'payload digest mismatch', 'foreign project id', 'missing parent', 'non-monotonic session sequence',
    ]));
  });

  it('rejects every member of a causal cycle', () => {
    const left = createProgressionSnapshot(input({ sequence: 1, dedupId: 'left' }));
    const right = createProgressionSnapshot(input({ sequence: 1, dedupId: 'right', sessionIdentity: 'session-b' }));
    const cyclicLeft = withDigest(left, { parentEventKeys: [right.eventKey] });
    const cyclicRight = withDigest(right, { parentEventKeys: [left.eventKey] });

    const restored = restoreProjectProgression([cyclicRight, cyclicLeft], { expectedProjectIdentity: PROJECT });

    expect(restored.ok).toBe(false);
    expect(restored.heads).toEqual([]);
    expect(restored.rejected).toEqual([
      { eventKey: left.eventKey, reasons: ['causal cycle'] },
      { eventKey: right.eventKey, reasons: ['causal cycle'] },
    ]);
  });

  it('poisons an event key after divergent payloads even when identical copies follow', () => {
    const original = createProgressionSnapshot(input({ sequence: 1, dedupId: 'collision' }));
    const divergent = withDigest(original, {
      completeProjectState: { ...STATE, nextAction: 'divergent but internally valid' },
    });

    const restored = restoreProjectProgression(
      [original, divergent, structuredClone(original), structuredClone(divergent)],
      { expectedProjectIdentity: PROJECT },
    );

    expect(restored.ok).toBe(false);
    expect(restored.heads).toEqual([]);
    expect(restored.rejected).toHaveLength(4);
    expect(restored.rejected.every((row) => row.reasons.includes('event key collision'))).toBe(true);
  });

  it('reports a plan item removed by one concurrent full snapshot as a resume conflict', () => {
    const root = createProgressionSnapshot(input({ sequence: 1, dedupId: 'plan-root' }));
    const retained = createProgressionSnapshot(input({
      sequence: 2,
      dedupId: 'plan-retained',
      parentEventKeys: [root.eventKey],
      completeProjectState: { ...STATE, plan: [{ id: 'contract', status: 'complete' }] },
    }));
    const removed = createProgressionSnapshot(input({
      hostIdentity: { host: 'claude', adapterVersion: '4.2.2-dev' },
      sessionIdentity: 'session-b',
      sequence: 1,
      dedupId: 'plan-removed',
      parentEventKeys: [root.eventKey],
      completeProjectState: { ...STATE, plan: [] },
    }));

    const restored = restoreProjectProgression([removed, retained, root], {
      expectedProjectIdentity: PROJECT,
    });
    const planConflict = restored.state.resumeConflicts.find((row) => row.field === 'plan.contract');

    expect(restored.state.plan).toEqual([{ id: 'contract', status: 'complete' }]);
    expect(planConflict.values).toEqual([
      { head: removed.eventKey, value: null },
      { head: retained.eventKey, value: { id: 'contract', status: 'complete' } },
    ].sort((left, right) => left.head.localeCompare(right.head)));
  });

  it('deterministically merges concurrent heads and makes scalar and plan conflicts explicit', () => {
    const root = createProgressionSnapshot(input({ sequence: 1, dedupId: 'root' }));
    const codex = createProgressionSnapshot(input({
      sequence: 2,
      dedupId: 'codex-head',
      parentEventKeys: [root.eventKey],
      completeProjectState: {
        ...STATE,
        plan: [{ id: 'contract', status: 'complete' }],
        completed: ['contract'],
        inProgress: [],
        nextAction: 'Wire Codex',
      },
    }));
    const claude = createProgressionSnapshot(input({
      hostIdentity: { host: 'claude', adapterVersion: '4.2.2-dev' },
      sessionIdentity: 'session-b',
      sequence: 1,
      dedupId: 'claude-head',
      parentEventKeys: [root.eventKey],
      completeProjectState: {
        ...STATE,
        plan: [{ id: 'contract', status: 'in-progress' }],
        completed: ['redaction'],
        inProgress: ['contract'],
        nextAction: 'Wire Claude',
      },
    }));

    const forward = restoreProjectProgression([root, codex, claude], { expectedProjectIdentity: PROJECT });
    const reversed = restoreProjectProgression([claude, codex, root], { expectedProjectIdentity: PROJECT });

    expect(forward).toEqual(reversed);
    expect(forward.heads).toEqual([claude.eventKey, codex.eventKey].sort());
    expect(forward.state.completed).toEqual(['contract', 'redaction']);
    expect(forward.state.nextAction).toBeNull();
    expect(forward.state.resumeConflicts.map((row) => row.field))
      .toEqual(expect.arrayContaining(['nextAction', 'plan.contract']));
    expect(forward.state.resumeConflicts.find((row) => row.field === 'nextAction').values)
      .toEqual([
        { head: claude.eventKey, value: 'Wire Claude' },
        { head: codex.eventKey, value: 'Wire Codex' },
      ].sort((a, b) => a.head.localeCompare(b.head)));
  });
});
