import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot, digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import { ProjectProgressionStore } from '../../plugin/scripts/project-progression-store.mjs';
import { resolveRuflo } from '../../plugin/scripts/ruflo-bin.mjs';
import { getVersion } from '../../scripts/version.mjs';

const NAMESPACE = 'project-progression';
let temporaryRoots = [];

function temporaryProject() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-store-')));
  temporaryRoots.push(root);
  return root;
}

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

function flag(args, name) {
  return args[args.indexOf(name) + 1];
}

function memoryRunner({ beforeStore } = {}) {
  const rows = new Map();
  const calls = [];
  const runner = (binary, args, options) => {
    calls.push({ binary, args, options });
    const command = `${args[0]} ${args[1]}`;
    const identity = `${flag(args, '--namespace')}/${flag(args, '--key')}`;
    if (command === 'memory store') {
      beforeStore?.();
      if (rows.has(identity)) return { status: 1, stdout: '', stderr: 'already exists' };
      rows.set(identity, flag(args, '--value'));
      return { status: 0, stdout: 'stored', stderr: '' };
    }
    if (command === 'memory retrieve') {
      if (!rows.has(identity)) return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: rows.get(identity), stderr: '' };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { calls, rows, runner };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('managed ProjectProgression append and readback', () => {
  it('accepts redacted state through capture, exact readback, and durable outbox commit', () => {
    const projectRoot = temporaryProject();
    const fake = memoryRunner();
    const bridge = new ProjectProgressionStore({
      projectDir: projectRoot,
      rufloBinary: '/managed/global/ruflo',
      runner: fake.runner,
    });
    const snapshot = progression(projectRoot, {
      completeProjectState: {
        ...progression(projectRoot).completeProjectState,
        decisions: [{ apiKey: 'fictional-key-material', outcome: 'authentication failed' }],
        failures: ['password=fictional-password; token=fictional-token'],
      },
    });

    const receipt = bridge.capture(snapshot);

    expect(receipt.readbackDigest).toBe(snapshot.payloadDigest);
    expect(JSON.parse(fake.rows.get(`${NAMESPACE}/${snapshot.eventKey}`))).toEqual(snapshot);
    expect(bridge.outbox.pendingSnapshots()).toEqual([]);
    const persisted = fs.readFileSync(bridge.outbox.path, 'utf8');
    expect(persisted).toContain('[REDACTED:api-key]');
    expect(persisted).not.toContain('fictional-key-material');
    expect(persisted).not.toContain('fictional-password');
    expect(persisted).not.toContain('fictional-token');
  });

  it('fsyncs the outbox, invokes literal managed Ruflo argv, exact-retrieves, then commits', () => {
    const projectRoot = temporaryProject();
    const outboxPath = path.join(projectRoot, '.swarm', 'project-progression-outbox.jsonl');
    const fake = memoryRunner({
      beforeStore() {
        expect(fs.readFileSync(outboxPath, 'utf8')).toContain('"type":"snapshot"');
      },
    });
    const bridge = new ProjectProgressionStore({
      projectDir: projectRoot,
      rufloBinary: '/managed/global/ruflo',
      runner: fake.runner,
      clock: () => '2026-08-22T17:30:01.000Z',
    });
    const snapshot = progression(projectRoot);

    const receipt = bridge.capture(snapshot);

    expect(receipt).toMatchObject({
      eventKey: snapshot.eventKey,
      payloadDigest: snapshot.payloadDigest,
      readbackDigest: snapshot.payloadDigest,
      alreadyStored: false,
    });
    expect(fake.calls.map(({ binary, args }) => ({ binary, args }))).toEqual([
      {
        binary: '/managed/global/ruflo',
        args: [
          'memory', 'store', '--key', snapshot.eventKey, '--value', JSON.stringify(snapshot),
          '--namespace', NAMESPACE, '--no-upsert', '--provenance', 'system_observation',
          '--path', bridge.resolution.canonicalAgentDbPath,
        ],
      },
      {
        binary: '/managed/global/ruflo',
        args: [
          'memory', 'retrieve', '--key', snapshot.eventKey, '--namespace', NAMESPACE,
          '--value-only', '--path', bridge.resolution.canonicalAgentDbPath,
        ],
      },
    ]);
    expect(fake.calls.every((call) => call.options.env.RUFLO_DAEMON_AUTOSTART === '0')).toBe(true);
    expect(bridge.outbox.pendingSnapshots()).toEqual([]);
  });

  it.each(['outbox-fsynced', 'stored', 'readback-verified'])(
    'replays exactly one durable row after a crash at %s',
    (crashPhase) => {
      const projectRoot = temporaryProject();
      const fake = memoryRunner();
      const bridge = new ProjectProgressionStore({
        projectDir: projectRoot,
        rufloBinary: '/managed/global/ruflo',
        runner: fake.runner,
        clock: () => '2026-08-22T17:30:01.000Z',
      });
      const snapshot = progression(projectRoot);

      expect(() => bridge.capture(snapshot, {
        onPhase(phase) {
          if (phase === crashPhase) throw new Error(`crash after ${phase}`);
        },
      })).toThrow(`crash after ${crashPhase}`);
      expect(bridge.outbox.pendingSnapshots()).toEqual([snapshot]);

      const receipts = bridge.replay();
      const callsAfterReplay = fake.calls.length;

      expect(receipts).toEqual([expect.objectContaining({
        eventKey: snapshot.eventKey,
        readbackDigest: snapshot.payloadDigest,
      })]);
      expect(fake.rows.size).toBe(1);
      expect(bridge.outbox.pendingSnapshots()).toEqual([]);
      expect(bridge.replay()).toEqual([]);
      expect(fake.calls).toHaveLength(callsAfterReplay);
    },
  );

  it('rejects an unredacted snapshot before writing it to the crash outbox', () => {
    const projectRoot = temporaryProject();
    const fake = memoryRunner();
    const bridge = new ProjectProgressionStore({
      projectDir: projectRoot,
      rufloBinary: '/managed/global/ruflo',
      runner: fake.runner,
    });
    const unsafe = structuredClone(progression(projectRoot));
    unsafe.completeProjectState.decisions = [{ apiKey: 'sk-unredacted-outbox-secret' }];
    delete unsafe.payloadDigest;
    unsafe.payloadDigest = digestCanonical(unsafe);

    expect(() => bridge.capture(unsafe)).toThrow(/invalid progression snapshot.*unredacted/i);
    expect(fs.existsSync(bridge.outbox.path)).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it('fails closed when strict insert finds a different payload under the same event key', () => {
    const projectRoot = temporaryProject();
    const fake = memoryRunner();
    const snapshot = progression(projectRoot);
    fake.rows.set(`${NAMESPACE}/${snapshot.eventKey}`, JSON.stringify({
      ...snapshot,
      payloadDigest: 'f'.repeat(64),
    }));
    const bridge = new ProjectProgressionStore({
      projectDir: projectRoot,
      rufloBinary: '/managed/global/ruflo',
      runner: fake.runner,
    });

    expect(() => bridge.capture(snapshot)).toThrow(/readback digest mismatch/i);
    expect(bridge.outbox.pendingSnapshots()).toEqual([snapshot]);
  });

  it('fails closed when a successful insert reads back a different payload', () => {
    const projectRoot = temporaryProject();
    const fake = memoryRunner();
    const snapshot = progression(projectRoot);
    const runner = (binary, args, options) => {
      const result = fake.runner(binary, args, options);
      if (`${args[0]} ${args[1]}` === 'memory retrieve' && result.status === 0) {
        return { ...result, stdout: JSON.stringify({ ...snapshot, payloadDigest: 'e'.repeat(64) }) };
      }
      return result;
    };
    const bridge = new ProjectProgressionStore({
      projectDir: projectRoot,
      rufloBinary: '/managed/global/ruflo',
      runner,
    });

    expect(() => bridge.capture(snapshot)).toThrow(/readback digest mismatch/i);
    expect(bridge.outbox.pendingSnapshots()).toEqual([snapshot]);
  });

  const ruflo = resolveRuflo();
  const realRufloIt = ruflo ? it : it.skip;
  realRufloIt('stores, exact-retrieves, and strictly deduplicates through a temp real AgentDB', () => {
    const projectRoot = temporaryProject();
    const resolution = resolveProjectStore({ projectDir: projectRoot });
    const env = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' };
    const initialized = spawnSync(ruflo, [
      'memory', 'init', '--backend', 'agentdb', '--path', resolution.canonicalAgentDbPath,
    ], { cwd: projectRoot, env, encoding: 'utf8', timeout: 120_000 });
    expect(initialized.status, initialized.stderr || initialized.stdout).toBe(0);
    const observed = [];
    const bridge = new ProjectProgressionStore({
      projectDir: projectRoot,
      rufloBinary: ruflo,
      runner(binary, args, options) {
        const started = Date.now();
        const result = spawnSync(binary, args, options);
        if (['list', 'retrieve'].includes(args[1])) {
          let parsed;
          try { parsed = JSON.parse(result.stdout); } catch { /* reported below, never stripped */ }
          observed.push({ command: args[1], ...(args.includes('--limit') ? { limit: flag(args, '--limit') } : {}), status: result.status,
            elapsedMs: Date.now() - started,
            stdoutShape: Array.isArray(parsed) ? 'array' : parsed && typeof parsed === 'object' ? 'object' : 'not-json',
            stderrFirstLine: String(result.stderr || '').split('\n')[0].slice(0, 160) });
        }
        return result;
      },
      clock: () => '2026-08-22T17:30:01.000Z',
    });
    const snapshot = progression(projectRoot);

    const receipt = bridge.capture(snapshot);
    const duplicate = bridge.appendExact(snapshot);

    expect(receipt).toMatchObject({
      eventKey: snapshot.eventKey,
      readbackDigest: snapshot.payloadDigest,
      alreadyStored: false,
    });
    expect(duplicate).toMatchObject({
      eventKey: snapshot.eventKey,
      readbackDigest: snapshot.payloadDigest,
      alreadyStored: true,
    });
    expect(bridge.replay()).toEqual([]);
    const successor = progression(projectRoot, { sequence: 2, dedupId: 'turn-b:tool-b:post',
      parentEventKeys: [snapshot.eventKey] });
    bridge.capture(successor);
    const restored = bridge.restoreLatest({ pageSize: 1 });
    expect(restored.payload.heads).toEqual([successor.eventKey]);
    expect(restored.payload.evidence).toMatchObject({ structurallyEnumerated: 2, exactRetrieved: 2 });
    expect(observed.every((row) => row.stdoutShape !== 'not-json')).toBe(true);
    console.info(JSON.stringify({ proof: 'global-ruflo-disposable-store', binary: ruflo, observations: observed }));
    // Capability probe only: runtime restoration still uses exact-key readback. Export has no
    // --path option, so bind both native resolver environment inputs to this disposable store.
    // The default bridge selects sibling agentdb-memory.db when export omits dbPath; explicitly
    // selecting Ruflo's supported fallback is required to read the canonical memory.db here.
    const output = path.join(projectRoot, 'progression-export.json');
    const started = Date.now();
    const exported = spawnSync(ruflo, ['memory', 'export', '--output', output,
      '--namespace', NAMESPACE, '--format', 'json'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 120_000,
      env: { ...env, CLAUDE_FLOW_DISABLE_BRIDGE: '1', CLAUDE_FLOW_DB_PATH: resolution.canonicalAgentDbPath,
        CLAUDE_FLOW_MEMORY_PATH: path.dirname(resolution.canonicalAgentDbPath) },
    });
    expect(exported.status, exported.stderr || exported.stdout).toBe(0);
    const data = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(data).toMatchObject({ schema: 'ruflo-memory-export/v1', count: 2, namespace: NAMESPACE });
    const values = new Map(data.entries.map((entry) => [entry.key, JSON.parse(entry.value)]));
    expect(digestCanonical(values.get(snapshot.eventKey))).toBe(digestCanonical(snapshot));
    expect(digestCanonical(values.get(successor.eventKey))).toBe(digestCanonical(successor));
    console.info(JSON.stringify({ proof: 'global-ruflo-export-capability-only', bridge: 'disabled', elapsedMs: Date.now() - started,
      exactValues: values.size, schema: data.schema, hasTotal: Object.hasOwn(data, 'total') }));
  }, 180_000);
});
