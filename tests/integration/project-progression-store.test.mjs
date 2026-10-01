import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createProgressionSnapshot, digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';
import { resolveProjectStore } from '../../plugin/scripts/project-store-resolver.mjs';
import {
  ProjectProgressionStore,
  projectResumePayloadToBound,
  ensurePrivateDir,
  rufloCwdFor,
  rufloScratchRoot,
} from '../../plugin/scripts/project-progression-store.mjs';
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

describe('bounded resume context projection', () => {
  const fullPayload = () => ({
    schema: 'ruvnet-brain.project-resume',
    schemaVersion: 1,
    projectIdentity: { id: 'projection-test', canonicalAgentDbPath: '/project/.swarm/memory.db' },
    heads: ['head-a', 'head-b'],
    state: {
      currentGoal: 'Finish the verified task.',
      nextAction: 'Run the exact remaining check.',
      activeProcess: 'verification',
      activeStep: null,
      acceptanceContract: { required: ['primary goal and next action remain exact'] },
      blockers: [], failures: [], inProgress: [], plan: [], completed: [], decisions: [],
      changedFiles: [], commands: [], proofArtifacts: [], untested: [],
      journalHeads: ['head-a', 'head-b'],
      sourceIdentity: null,
      resumeConflicts: [{
        field: 'sourceIdentity',
        values: [
          { head: 'head-a', value: { checkoutPath: '/project/a', detail: 'A'.repeat(900) } },
          { head: 'head-b', value: { checkoutPath: '/project/b', detail: 'B'.repeat(900) } },
        ],
      }],
    },
    evidence: { structurallyEnumerated: 2, exactRetrieved: 2, causallyStale: 0, rejectedCandidates: [], readPath: 'node:sqlite', pendingReplay: 0 },
  });

  it('keeps the exact goal/action and exposes digested omissions with deterministic head references', () => {
    const input = fullPayload();
    const first = projectResumePayloadToBound(input, 1800);
    const second = projectResumePayloadToBound(input, 1800);

    expect(first).not.toBeNull();
    expect(first).toEqual(second);
    expect(Buffer.byteLength(first.rendered)).toBeLessThanOrEqual(1800);
    expect(first.payload.state.currentGoal).toBe(input.state.currentGoal);
    expect(first.payload.state.nextAction).toBe(input.state.nextAction);
    expect(first.payload.heads).toEqual(['head-a', 'head-b']);
    expect(first.payload.projection.mode).toBe('bounded-summary');
    expect(first.payload.state.resumeConflicts[0]).toEqual({
      field: 'sourceIdentity',
      valueCount: 2,
      valuesDigest: digestCanonical(input.state.resumeConflicts[0].values),
    });
    expect(first.payload.projection.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'state.resumeConflicts[].values',
        count: 2,
        sha256: digestCanonical(input.state.resumeConflicts[0].values.map((row) => row.value)),
      }),
    ]));
  });

  it('returns no projection when required goal/action and identity cannot fit', () => {
    const input = fullPayload();
    input.state.currentGoal = 'G'.repeat(4_000);
    input.state.nextAction = 'N'.repeat(4_000);
    expect(projectResumePayloadToBound(input, 1_000)).toBeNull();
  });
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
    // ruflo never runs inside the customer's project: one per-user scratch cwd outside it (rufloCwdFor).
    expect(fake.calls.every((call) => call.options.cwd === rufloCwdFor(bridge.resolution.canonicalAgentDbPath))).toBe(true);
    expect(fake.calls.every((call) => path.relative(projectRoot, call.options.cwd).startsWith('..'))).toBe(true);
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
    ], { cwd: rufloCwdFor(resolution.canonicalAgentDbPath), env, encoding: 'utf8', timeout: 120_000 });
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
    // Independent proof that the GLOBAL ruflo CLI sees what the product wrote. The product's own reads
    // above may take the node:sqlite fast path, so this reads back through the CLI, bound to the exact
    // canonical store with --path (the flag Ruflo wires on init/store/retrieve/list/search/delete/stats:
    // ruflo/scripts/smoke-memory-db-path.mjs, #2105), and compares every value by canonical digest.
    //
    // Why not `ruflo memory export` (this probe until 2026-10-01): export has no --path, and on ruflo
    // 3.49.0 it ignores CLAUDE_FLOW_DB_PATH/CLAUDE_FLOW_MEMORY_PATH. Measured on a disposable store
    // holding these two product rows: export from the project root -> count 0 (with or without those
    // env overrides), from <root>/.swarm -> count 1, while `memory list --path` and exact
    // `memory retrieve --path` return both rows byte-identical. Export reads a cwd-derived store,
    // not the canonical one, so it cannot prove anything about this store.
    const started = Date.now();
    const cli = (args) => spawnSync(ruflo, args, { cwd: rufloCwdFor(resolution.canonicalAgentDbPath), encoding: 'utf8', timeout: 120_000, env });
    const listed = cli(['memory', 'list', '--namespace', NAMESPACE, '--path', resolution.canonicalAgentDbPath, '--format', 'json']);
    expect(listed.status, listed.stderr || listed.stdout).toBe(0);
    for (const expected of [snapshot, successor]) {
      expect(listed.stdout).toContain(expected.eventKey);
      const read = cli(['memory', 'retrieve', '--key', expected.eventKey, '--namespace', NAMESPACE, '--value-only',
        '--path', resolution.canonicalAgentDbPath]);
      expect(read.status, read.stderr || read.stdout).toBe(0);
      expect(digestCanonical(JSON.parse(read.stdout))).toBe(digestCanonical(expected));
    }
    console.info(JSON.stringify({ proof: 'global-ruflo-cli-exact-readback', path: 'canonical --path', elapsedMs: Date.now() - started,
      exactValues: 2 }));
    // ruflo creates `<cwd>/.swarm/` on every call; run from inside `.swarm` it left an unused nested
    // store in every customer project (measured 2026-10-01, ruflo 3.49.0).
    expect(fs.existsSync(path.join(projectRoot, '.swarm', '.swarm'))).toBe(false);
    // ruflo writes .claude/, .claude-flow/, ruvector.db and .swarm/ into its cwd. None of it may land in
    // the customer's project (it changed the working tree and broke no-op capture detection): the project
    // holds only the store directory, and the store directory only the store and the product's outbox.
    expect(fs.readdirSync(projectRoot).sort()).toEqual(['.swarm']);
    const storeFiles = fs.readdirSync(path.join(projectRoot, '.swarm')).sort();
    expect(storeFiles.filter((name) => !/^memory\.db(?:-wal|-shm|-journal)?$/.test(name)
      && name !== 'schema.sql' // written beside the store by `ruflo memory init --path` (measured, 3.49.0)
      && name !== 'project-progression-outbox.jsonl'), storeFiles.join(', ')).toEqual([]);
  }, 180_000);

  // ruflo writes snapshot content (hnsw.metadata.json) into <cwd>/.swarm and LOADS any it finds there,
  // so the cwd is per project, private, ours, and never in the project tree or a shared /tmp name.
  it('gives each project its own private scratch cwd under the Brain home, outside the project', () => {
    const projectRoot = temporaryProject();
    const otherRoot = temporaryProject();
    const brainHome = temporaryProject();
    const root = path.join(brainHome, 'ruflo-cwd');
    const mine = rufloCwdFor(path.join(projectRoot, '.swarm', 'memory.db'), { root });
    const theirs = rufloCwdFor(path.join(otherRoot, '.swarm', 'memory.db'), { root });
    expect(mine).not.toBe(theirs); // never pooled across projects
    expect(rufloCwdFor(path.join(projectRoot, '.swarm', 'memory.db'), { root })).toBe(mine); // stable per project
    for (const dir of [root, mine, theirs]) {
      const stat = fs.lstatSync(dir);
      expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o700);
        expect(stat.uid).toBe(process.getuid());
      }
    }
    expect(path.dirname(mine)).toBe(root);
    expect(path.relative(projectRoot, mine).startsWith('..')).toBe(true);
    expect(rufloScratchRoot({ RUVNET_BRAIN_HOME: brainHome })).toBe(root);
    expect(rufloScratchRoot({ HOME: '/h' }).startsWith(path.join(os.homedir(), '.cache', 'ruvnet-brain'))).toBe(true);
    expect(() => resolveProjectStore({ projectDir: projectRoot, requestedStorePath: path.join(projectRoot, 'stores', 'memory.db') }))
      .toThrow(/foreign store root rejected/);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked scratch dir, repairs a 0755 one, refuses one owned by someone else', () => {
    const brainHome = temporaryProject();
    const root = path.join(brainHome, 'ruflo-cwd');
    const store = path.join(temporaryProject(), '.swarm', 'memory.db');
    // A planted symlink for the ROOT, and separately for a project's LEAF: both refused, the target untouched.
    const elsewhere = temporaryProject();
    fs.symlinkSync(elsewhere, root);
    expect(() => rufloCwdFor(store, { root })).toThrow(/not a real directory/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.unlinkSync(root);
    const leaf = rufloCwdFor(store, { root });
    fs.rmdirSync(leaf);
    fs.symlinkSync(elsewhere, leaf);
    expect(() => rufloCwdFor(store, { root })).toThrow(/not a real directory/);
    fs.unlinkSync(leaf);
    // A pre-existing world-readable dir is made private.
    fs.mkdirSync(leaf, { mode: 0o755 });
    fs.chmodSync(leaf, 0o755);
    expect(rufloCwdFor(store, { root })).toBe(leaf);
    expect(fs.lstatSync(leaf).mode & 0o777).toBe(0o700);
    // A directory owned by another uid (root-owned /usr stands in; a test cannot chown) is refused.
    expect(() => ensurePrivateDir('/usr')).toThrow(/owned by uid 0/);
  });

  realRufloIt('real ruflo with a non-default --path leaves no .swarm next to the store or in the project', () => {
    const projectRoot = temporaryProject();
    const storeDir = path.join(projectRoot, 'stores');
    fs.mkdirSync(storeDir);
    const store = path.join(storeDir, 'memory.db');
    const cwd = rufloCwdFor(store, { root: path.join(temporaryProject(), 'ruflo-cwd') });
    const env = { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' };
    const call = (args) => spawnSync(ruflo, args, { cwd, env, encoding: 'utf8', timeout: 120_000 });
    const init = call(['memory', 'init', '--backend', 'agentdb', '--path', store]);
    expect(init.status, init.stderr || init.stdout).toBe(0);
    const stored = call(['memory', 'store', '--key', 'n3-probe', '--value', '{"ok":true}', '--namespace', 'n3', '--path', store]);
    expect(stored.status, stored.stderr || stored.stdout).toBe(0);
    const read = call(['memory', 'retrieve', '--key', 'n3-probe', '--namespace', 'n3', '--value-only', '--path', store]);
    expect(read.status, read.stderr || read.stdout).toBe(0);
    expect(JSON.parse(read.stdout)).toEqual({ ok: true });
    expect(fs.existsSync(path.join(storeDir, '.swarm'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.swarm'))).toBe(false);
  }, 180_000);
});
