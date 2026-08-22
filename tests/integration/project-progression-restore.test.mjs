import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot, digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';

const NAMESPACE = 'project-progression';
const temporaryRoots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-restore-')));
  temporaryRoots.push(root);
  return root;
}

function state(overrides = {}) {
  return {
    currentGoal: 'Restore perennial project state',
    acceptanceContract: { required: ['structural enumeration', 'exact readback'] },
    plan: [{ id: 'restore', status: 'in-progress' }],
    activeProcess: 'ProjectContinuity',
    activeStep: 'restore',
    completed: [],
    inProgress: ['restore'],
    blockers: [],
    failures: [],
    decisions: [],
    changedFiles: [],
    commands: [],
    proofArtifacts: [],
    untested: ['packed cross-host crash'],
    nextAction: 'Inject the bounded resume payload',
    resumeConflicts: [],
    ...overrides,
  };
}

function snapshot(project, {
  session = 'session-a', sequence = 1, dedupId = `event-${sequence}`, parents = [], stateOverrides = {},
} = {}) {
  const resolution = resolveProjectStore({ projectDir: project });
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
    hostIdentity: { host: session.startsWith('claude') ? 'claude' : 'codex', adapterVersion: '4.2.3-dev' },
    sessionIdentity: session,
    sequence,
    occurredAt: new Date(Date.parse('2026-08-22T18:00:00.000Z') + sequence).toISOString(),
    trigger: 'PostToolUse',
    parentEventKeys: parents,
    dedupId,
    completeProjectState: state(stateOverrides),
  });
}

function flag(args, name) {
  return args[args.indexOf(name) + 1];
}

function fakeCli(entries, { pageMutator, retrieveFailure } = {}) {
  const rows = new Map(entries);
  const order = entries.map(([key]) => key);
  const calls = [];
  const runner = (_binary, args) => {
    calls.push(args);
    const command = `${args[0]} ${args[1]}`;
    if (command === 'memory search') throw new Error('semantic search is forbidden for restoration');
    if (command === 'memory list') {
      const limit = Number(flag(args, '--limit'));
      const offset = Number(flag(args, '--offset'));
      const keys = order.slice(offset, offset + limit);
      const page = {
        entries: keys.map((key) => ({ key, namespace: NAMESPACE })),
        total: order.length,
        limit,
        offset,
        nextOffset: offset + keys.length < order.length ? offset + keys.length : null,
        hasMore: offset + keys.length < order.length,
      };
      return { status: 0, stdout: JSON.stringify(pageMutator?.(structuredClone(page), { offset, limit }) ?? page), stderr: '' };
    }
    if (command === 'memory retrieve') {
      const key = flag(args, '--key');
      if (retrieveFailure === key) return { status: 1, stdout: '', stderr: 'exact key unavailable' };
      const value = rows.get(key);
      return { status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { calls, runner };
}

function store(project, cli) {
  return new ProjectProgressionStore({ projectDir: project, rufloBinary: '/managed/global/ruflo', runner: cli.runner });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('ADR-073 structural SessionStart restoration', () => {
  it('pages beyond the default limit and exact-retrieves every candidate without semantic search', () => {
    const project = temporaryProject();
    const chain = [];
    for (let sequence = 1; sequence <= 45; sequence += 1) {
      chain.push(snapshot(project, {
        sequence,
        parents: chain.length ? [chain.at(-1).eventKey] : [],
        stateOverrides: { completed: Array.from({ length: sequence }, (_, index) => `step-${index + 1}`) },
      }));
    }
    const cli = fakeCli(chain.map((row) => [row.eventKey, row]));

    const restored = store(project, cli).restoreLatest({ pageSize: 7 });
    const listCalls = cli.calls.filter((args) => `${args[0]} ${args[1]}` === 'memory list');
    const retrieveCalls = cli.calls.filter((args) => `${args[0]} ${args[1]}` === 'memory retrieve');

    expect(listCalls.map((args) => Number(flag(args, '--offset')))).toEqual([0, 7, 14, 21, 28, 35, 42]);
    expect(listCalls.every((args) => args.includes('--page-info') && flag(args, '--format') === 'json')).toBe(true);
    expect(listCalls.every((args) => flag(args, '--path') === store(project, cli).resolution.canonicalAgentDbPath)).toBe(true);
    expect(retrieveCalls).toHaveLength(45);
    expect(cli.calls.some((args) => args[1] === 'search')).toBe(false);
    expect(restored.payload).toMatchObject({
      schema: 'ruvnet-brain.project-resume',
      schemaVersion: 1,
      heads: [chain.at(-1).eventKey],
      state: { completed: expect.arrayContaining(['step-1', 'step-45']) },
      evidence: { structurallyEnumerated: 45, exactRetrieved: 45, causallyStale: 44 },
    });
    expect(JSON.parse(restored.rendered)).toEqual(restored.payload);
  });

  it.each([
    ['non-advancing page', (page) => ({ ...page, nextOffset: page.offset, hasMore: true }), /non-advancing/i],
    ['malformed page shape', (page) => ({ entries: page.entries, total: 'many' }), /malformed pagination page/i],
    ['inconsistent total', (page, { offset }) => ({ ...page, total: offset ? page.total + 1 : page.total }), /total changed/i],
  ])('fails closed on a %s', (_label, pageMutator, expected) => {
    const project = temporaryProject();
    const rows = Array.from({ length: 3 }, (_, index) => snapshot(project, { sequence: index + 1, session: `session-${index}` }));
    const cli = fakeCli(rows.map((row) => [row.eventKey, row]), { pageMutator });

    expect(() => store(project, cli).restoreLatest({ pageSize: 2 })).toThrow(expected);
  });

  it('restores concurrent maximal heads deterministically without dropping conflicts', () => {
    const project = temporaryProject();
    const codex = snapshot(project, {
      session: 'codex-a', sequence: 1, dedupId: 'codex-head', stateOverrides: { nextAction: 'run Codex proof' },
    });
    const claude = snapshot(project, {
      session: 'claude-b', sequence: 1, dedupId: 'claude-head', stateOverrides: { nextAction: 'run Claude proof' },
    });
    const first = fakeCli([[codex.eventKey, codex], [claude.eventKey, claude]]);
    const reversed = fakeCli([[claude.eventKey, claude], [codex.eventKey, codex]]);

    const one = store(project, first).restoreLatest();
    const two = store(project, reversed).restoreLatest();

    expect(one.rendered).toBe(two.rendered);
    expect(one.payload.heads).toEqual([claude.eventKey, codex.eventKey].sort());
    expect(one.payload.state.nextAction).toBeNull();
    expect(one.payload.state.resumeConflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'nextAction' }),
    ]));
  });

  it('surfaces corrupted exact rows while restoring an independent valid head', () => {
    const project = temporaryProject();
    const valid = snapshot(project);
    const tampered = structuredClone(snapshot(project, { session: 'session-b', dedupId: 'tampered' }));
    tampered.completeProjectState.nextAction = 'forged without updating the digest';
    const cli = fakeCli([
      [valid.eventKey, valid],
      [tampered.eventKey, tampered],
      ['project-progress-v1-corrupt-json', '{not-json'],
    ]);

    const restored = store(project, cli).restoreLatest();

    expect(restored.payload.heads).toEqual([valid.eventKey]);
    expect(restored.payload.evidence.rejectedCandidates).toEqual(expect.arrayContaining([
      { eventKey: tampered.eventKey, reasons: ['payload digest mismatch'] },
      { eventKey: 'project-progress-v1-corrupt-json', reasons: ['readback is not JSON'] },
    ]));
  });

  it('rejects a missing-parent branch without shadowing a coherent independent head', () => {
    const project = temporaryProject();
    const valid = snapshot(project, { session: 'session-valid', dedupId: 'valid' });
    const orphan = snapshot(project, {
      session: 'session-orphan', dedupId: 'orphan', parents: ['project-progress-v1-absent-parent'],
    });
    const cli = fakeCli([[orphan.eventKey, orphan], [valid.eventKey, valid]]);

    const restored = store(project, cli).restoreLatest();

    expect(restored.payload.heads).toEqual([valid.eventKey]);
    expect(restored.payload.evidence.rejectedCandidates).toContainEqual({
      eventKey: orphan.eventKey,
      reasons: ['missing parent'],
    });
  });

  it('fails closed when an exact-listed candidate cannot be exact-retrieved', () => {
    const project = temporaryProject();
    const valid = snapshot(project);
    const cli = fakeCli([[valid.eventKey, valid]], { retrieveFailure: valid.eventKey });

    expect(() => store(project, cli).restoreLatest()).toThrow(/exact retrieval failed/i);
  });

  it('fails closed instead of truncating a resume payload past its byte bound', () => {
    const project = temporaryProject();
    const large = snapshot(project, { stateOverrides: { currentGoal: 'x'.repeat(8_000) } });
    const cli = fakeCli([[large.eventKey, large]]);

    expect(() => store(project, cli).restoreLatest({ maxOutputBytes: 512 })).toThrow(/resume payload.*bound/i);
  });

  it('rejects a key/payload identity mismatch even when the snapshot itself has a valid digest', () => {
    const project = temporaryProject();
    const valid = snapshot(project);
    const alias = `${valid.eventKey}-alias`;
    const cli = fakeCli([[alias, valid]]);

    expect(() => store(project, cli).restoreLatest()).toThrow(/no coherent progression state/i);
  });

  it('rejects recomputed but unredacted secret material before rendering', () => {
    const project = temporaryProject();
    const unsafe = structuredClone(snapshot(project));
    unsafe.completeProjectState.decisions = [{ apiKey: 'sk-unredacted-secret-value' }];
    delete unsafe.payloadDigest;
    unsafe.payloadDigest = digestCanonical(unsafe);
    const cli = fakeCli([[unsafe.eventKey, unsafe]]);

    expect(() => store(project, cli).restoreLatest()).toThrow(/no coherent progression state/i);
  });
});
