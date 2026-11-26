import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { recordHookFailure, failureLine, REPEAT_WINDOW_MS } from '../../plugin/scripts/hook-failures.mjs';
import { rufloMemory, restore, checkpoint } from '../../plugin/scripts/ruflo-memory-hooks.mjs';
import {
  withCaptureGate,
  captureLearning,
  detachLearning,
  markCaptured,
  markInFlight,
  acquireObserveSlot,
  releaseObserveSlot,
  SLOT_STALE_MS,
} from '../../plugin/scripts/learn-capture.mjs';
import { observationKey } from '../../plugin/scripts/learning-store.mjs';
import {
  captureTurnOutcome,
  runSteps,
  turnRecordingStatus,
  readBoundedReceipts,
  buildTurnRecord,
  RECEIPTS_READ_BYTES,
} from '../../plugin/scripts/turn-outcome-capture.mjs';
import {
  STAGE_BUDGETS_MS,
  MEASURED_NODE_BOOT_MS,
  sumBudgetsMs,
  sessionStartTimeoutMs,
  sessionStartRestoreBudgetMs,
} from '../../plugin/scripts/session-start-budget.mjs';
import { runSessionStart } from '../../plugin/scripts/session-start-core.mjs';
import { ledgerRows, until } from '../helpers/slow-ruflo.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const READER = path.join(ROOT, 'plugin/scripts/agentdb-recall-reader.mjs');
const LEARN = path.join(ROOT, 'plugin/scripts/learn-capture.mjs');
const OUTCOME = 'Implemented all lifecycle continuity safeguards, verified single-child write/readback and concurrent capture gates across temporary workspaces, and confirmed no secrets leaked into receipts or ledgers.';
const dirs = [];
const spawnChildren = [];

afterEach(() => {
  for (const child of spawnChildren.splice(0)) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* exited */ }
  }
  for (const d of dirs.splice(0)) {
    try { fs.chmodSync(d, 0o700); } catch { /* ok */ }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function tmp(prefix) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function projectFixture(prefix = 'g3-proj-') {
  const root = tmp(prefix);
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const brainHome = path.join(root, 'brain');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
  const db = path.join(project, '.swarm', 'memory.db');
  fs.writeFileSync(db, '');
  const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome, RUFLO_BIN: process.execPath, RUVNET_TURN_CAPTURE: 'force' };
  return { root, home, project, db, brainHome, env };
}

describe('#518 failure correlation, stderr capture, and duplicate readback distinction', () => {
  it('keeps uncorrelated sig unchanged while isolating correlated stores and preserving store on repeat rows', () => {
    const bh = tmp('hf-corr-');
    const t0 = Date.parse('2026-11-26T00:00:00Z');
    recordHookFailure({ hook: 'checkpoint', event: 'SessionEnd', error: 'store failed: exited 1', store: 'store_aaaa1111', project: 'proj_1' }, { brainHome: bh, now: t0 });
    recordHookFailure({ hook: 'checkpoint', event: 'SessionEnd', error: 'store failed: exited 1', store: 'store_bbbb2222', project: 'proj_2' }, { brainHome: bh, now: t0 + 100 });
    recordHookFailure({ hook: 'checkpoint', event: 'SessionEnd', error: 'store failed: exited 1', store: 'store_aaaa1111', project: 'proj_1' }, { brainHome: bh, now: t0 + 200 });

    const initial = ledgerRows(bh);
    expect(initial.map((r) => r.store)).toEqual(['store_aaaa1111', 'store_bbbb2222']);
    const line = failureLine(bh, { now: t0 + 500 });
    expect(line).toContain('checkpoint ×3');
    const afterClose = ledgerRows(bh);
    const repeatRow = afterClose.find((r) => /repeated/.test(r.error));
    expect(repeatRow).toMatchObject({ store: 'store_aaaa1111', project: 'proj_1', count: 1 });
  });

  it('rufloMemory extracts redacted stderr instead of bare exit code and keeps abort/timeout precedence', async () => {
    const token = `ghp_${'SECRET'.repeat(6)}`;
    const db = '/private/var/project/.swarm/memory.db';
    const rErr = await rufloMemory(['store'], {
      db,
      bin: '/fake/ruflo',
      invoke: () => ({ executable: 'node', args: [] }),
      run: (_exe, _args, _opts, cb) => {
        cb(Object.assign(new Error('exited 1'), { code: 1 }), '', `[ERROR] Native memory writer required for ${db} token=${token}; refusing whole-image sql.js fallback\n`);
        return {};
      },
    });
    expect(rErr.ok).toBe(false);
    expect(rErr.error).toContain('[ERROR] Native memory writer required');
    expect(rErr.error).not.toContain(db);
    expect(rErr.error).not.toContain(token);

    const ac = new AbortController();
    const rCancel = await rufloMemory(['store'], {
      db,
      bin: '/fake/ruflo',
      signal: ac.signal,
      invoke: () => ({ executable: 'node', args: [] }),
      run: (_exe, _args, _opts, cb) => {
        ac.abort();
        cb(Object.assign(new Error('exited 1'), { code: 1 }), '', '[ERROR] should not win over cancel');
        return {};
      },
    });
    expect(rCancel.error).toBe('cancelled');

    const rTimeout = await rufloMemory(['store'], {
      db,
      bin: '/fake/ruflo',
      invoke: () => ({ executable: 'node', args: [] }),
      run: (_exe, _args, _opts, cb) => {
        cb(Object.assign(new Error('exited null'), { code: null, killed: true }), '', '[ERROR] should not win over timeout');
        return {};
      },
    });
    expect(rTimeout.error).toBe('timed out');
  });

  it('checkpoint() exposes db/project and runSteps distinguishes unavailable duplicate readback from mismatch', async () => {
    const f = projectFixture('g3-dup-null-');
    const rufloBad = path.join(f.root, 'fake-ruflo');
    fs.writeFileSync(rufloBad, '#!/usr/bin/env node\nprocess.stderr.write("[ERROR] refused\\n"); process.exit(1);\n', { mode: 0o755 });
    const cp = await checkpoint({ projectDir: f.project, event: 'SessionEnd', payload: { session_id: 's1' }, env: f.env, bin: rufloBad });
    expect(cp).toMatchObject({ stored: false, db: f.db, project: f.project });

    const binding = { projectRoot: f.project, projectDir: f.project, brainHome: f.brainHome };
    const step = { ...binding, kind: 'store', ruflo: '/fake/ruflo', args: ['memory', 'store', '--key', 'turn-k1', '--value', OUTCOME, '--namespace', 'turns', '--path', f.db] };
    const receipts = path.join(f.brainHome, 'turn-capture', 'receipts.jsonl');
    const [rowNull] = runSteps({ receipts, steps: [step], event: 'Stop' }, {
      env: f.env, projectDir: f.project, brainHome: f.brainHome,
      run: () => ({ status: 1, stderr: '[ERROR] immutable append rejected: logical key already exists' }),
      read: () => null,
    });
    expect(rowNull).toMatchObject({ status: 1, verified: false, error: 'duplicate turn key readback unavailable' });

    const [rowDiff] = runSteps({ receipts, steps: [step], event: 'Stop' }, {
      env: f.env, projectDir: f.project, brainHome: f.brainHome,
      run: () => ({ status: 1, stderr: '[ERROR] immutable append rejected: logical key already exists' }),
      read: () => 'totally different bytes',
    });
    expect(rowDiff).toMatchObject({ status: 1, verified: false, error: 'duplicate turn key holds different content' });
  });
});

describe('#519 + #521 learn-capture atomic gate, spawn cleanup, .pending guard, and reader EOF drain', () => {
  it('withCaptureGate never displaces a live holder by age, throws on timeout, and reclaims ESRCH', () => {
    const bh = tmp('gate-bh-');
    const gateDir = path.join(bh, 'learn-capture', 'capture.gate');
    fs.mkdirSync(gateDir, { recursive: true });
    // Live holder (this pid) with ancient birth time must NOT be displaced.
    fs.writeFileSync(path.join(gateDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'live-tok', birth: Date.now() - 3_600_000 }));
    expect(() => withCaptureGate(bh, () => 'never', { timeoutMs: 25 })).toThrow(/gate timeout/);

    // Dead PID (ESRCH) and invalid owner JSON missing integer pid are reclaimed cleanly.
    fs.writeFileSync(path.join(gateDir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, token: 'dead-tok', birth: Date.now() }));
    expect(withCaptureGate(bh, () => 'ok', { timeoutMs: 50 })).toBe('ok');

    fs.mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(path.join(gateDir, 'owner.json'), '{}');
    expect(withCaptureGate(bh, () => 'reclaimed-empty-owner', { timeoutMs: 50 })).toBe('reclaimed-empty-owner');
  });

  it('concurrent same-key captureLearning processes spawn at most one detached child', async () => {
    const home = tmp('conc-home-');
    fs.mkdirSync(path.join(home, '.claude', 'global-memory', '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'), '');
    fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
    const bh = tmp('conc-bh-');
    const log = path.join(home, 'store.log');
    const stub = path.join(home, 'ruflo');
    fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a[1] + '\\n');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
if (a[1] === 'retrieve') process.stdout.write(${JSON.stringify(JSON.stringify({ schemaVersion: 1, tool: 'Bash', action: 'npm test', scope: 'user', authoritative: false, provenance: 'system-observation', outcome: 'host-reported-success' }))});
`, { mode: 0o755 });
    const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUVNET_LEARNING_SCOPE: 'user', RUVNET_BRAIN_HOME: bh, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain') };
    const code = `import { captureLearning } from ${JSON.stringify(pathToFileURL(LEARN).href)};
      process.stdout.write(String(captureLearning({ hook_event_name: 'PostToolUse', session_id: 'same', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'ok' } }, { env: process.env, binary: ${JSON.stringify(stub)}, brainHome: ${JSON.stringify(bh)}, detach: true })));`;
    const workers = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => { out += d; });
      c.on('close', (status) => resolve({ status, out }));
    }));
    const results = await Promise.all(workers);
    expect(results.every((r) => r.status === 0 && r.out === 'true')).toBe(true);
    expect(await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('retrieve'), 15_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const storeCalls = fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => l === 'store');
    expect(storeCalls).toHaveLength(1);
  }, 25_000);

  it('markCaptured pruning keeps fresh .pending markers younger than SLOT_STALE_MS and releaseObserveSlot checks token', () => {
    const bh = tmp('prune-bh-');
    const dir = path.join(bh, 'learn-capture', 'recent');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 270; i += 1) fs.writeFileSync(path.join(dir, `k-${i}`), '');
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);
    markInFlight(bh, 'active-key', 'tok-active');
    markCaptured(bh, 'new-key', now);
    expect(fs.existsSync(path.join(dir, 'active-key.pending'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'new-key'))).toBe(true);

    // releaseObserveSlot verifies token when supplied
    const slot = acquireObserveSlot(bh, now, 'tok-slot');
    expect(slot).toBeTruthy();
    expect(releaseObserveSlot(slot, { pid: process.pid, token: 'wrong-tok' })).toBe(false);
    expect(fs.existsSync(slot)).toBe(true);
    expect(releaseObserveSlot(slot, { pid: process.pid, token: 'tok-slot' })).toBe(true);
    expect(fs.existsSync(slot)).toBe(false);

    // detachLearning cleans ONLY token-owned slot/pending when spawn fails without clobbering another token
    const slot2 = acquireObserveSlot(bh, now, 'tok-spawn-fail');
    markInFlight(bh, 'fail-key', 'tok-spawn-fail');
    const spawnFailCode = `
      import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
      import { detachLearning } from ${JSON.stringify(pathToFileURL(LEARN).href)};
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'doomed-cwd-'));
      process.chdir(d); fs.rmdirSync(d);
      detachLearning('--observe', { env: { RUVNET_BRAIN_HOME: ${JSON.stringify(bh)} }, brainHome: ${JSON.stringify(bh)}, key: 'fail-key', token: 'tok-spawn-fail', slot: ${JSON.stringify(slot2)} });
    `;
    const sr = spawnSync(process.execPath, ['--input-type=module', '-e', spawnFailCode], { encoding: 'utf8', timeout: 10_000 });
    expect(sr.status, sr.stderr).toBe(0);
    expect(fs.existsSync(slot2)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'fail-key.pending'))).toBe(false);
    expect(ledgerRows(bh).length).toBeGreaterThan(0);
  });

  it('agentdb-recall-reader --session drains pending async getEntry/listEntries before exiting on stdin EOF', () => {
    const dir = tmp('reader-eof-');
    const db = path.join(dir, 'memory.db');
    fs.writeFileSync(db, '');
    const mod = path.join(dir, 'slow-mem.mjs');
    fs.writeFileSync(mod, `
export const resolveDbPath = (p) => p;
export async function listEntries({ namespace }) {
  await new Promise((r) => setTimeout(r, 80));
  return { success: true, entries: [{ key: namespace + '-k1', createdAt: 10 }] };
}
export async function getEntry({ key }) {
  await new Promise((r) => setTimeout(r, 120));
  return { success: true, found: true, entry: { content: 'async-value-' + key } };
}
`);
    const requests = [
      'null',
      JSON.stringify({ id: 1, op: 'list', namespace: 'proj', limit: 10 }),
      JSON.stringify({ id: 2, op: 'get', namespace: 'proj', key: 'k1' }),
    ].join('\n') + '\n';
    const r = spawnSync(process.execPath, [READER, '--session', db, pathToFileURL(mod).href], {
      input: requests, encoding: 'utf8', timeout: 10_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.find((l) => l.ready === true)).toBeTruthy();
    expect(lines.find((l) => l.id === 1)).toMatchObject({ state: 'ok', rows: [{ key: 'proj-k1', createdAt: 10 }] });
    expect(lines.find((l) => l.id === 2)).toMatchObject({ state: 'ok', value: 'async-value-k1' });
  });
});

describe('#520 immutable turn retry timestamp change + whitespace readback preservation', () => {
  it('accepts identical turn rebuilt under an earlier timestamp, rejects mismatched content, preserves spaces, and never leaks turnInput', () => {
    const f = projectFixture('g3-520-');
    const tOriginal = new Date('2026-11-20T10:00:00.123Z');
    const tRetry = new Date('2026-11-20T10:05:00.456Z');
    const payload = { session_id: 's520', last_assistant_message: OUTCOME };
    const receipts = path.join(f.brainHome, 'turn-capture', 'receipts.jsonl');

    // First capture writes the record at tOriginal; second retries same turn at tRetry against duplicate refusal
    let firstValue = '';
    const r1 = captureTurnOutcome({
      projectDir: f.project, event: 'Stop', payload, home: f.home, env: f.env, brainHome: f.brainHome, ruflo: '/fake/ruflo',
      now: () => tOriginal,
      run: (_bin, args) => {
        if (args[1] === 'store') { firstValue = args[args.indexOf('--value') + 1]; return { status: 0 }; }
        return { status: 0, stdout: `${firstValue}\n` };
      },
    });
    expect(r1.recorded).toBe(true);

    // Trailing space check in readBack when running custom run seam (mock CLI printing raw line ending)
    const spaceStep = {
      projectRoot: f.project, projectDir: f.project, brainHome: f.brainHome, kind: 'store', ruflo: '/fake/ruflo',
      args: ['memory', 'store', '--key', 'k-space', '--value', 'abc   ', '--namespace', 'turns', '--path', f.db],
    };
    const [spaceRow] = runSteps({ receipts, steps: [spaceStep], event: 'Stop' }, {
      env: f.env, projectDir: f.project, brainHome: f.brainHome,
      run: (_bin, args) => (args[1] === 'retrieve' ? { status: 0, stdout: 'abc   \n' } : { status: 0 }),
    });
    expect(spaceRow).toMatchObject({ status: 0, verified: true });

    // Remove receipts + last-turn.json to trigger a real duplicate write under tRetry
    fs.rmSync(receipts, { force: true });
    fs.rmSync(path.join(f.brainHome, 'turn-capture', 'last-turn.json'), { force: true });

    const r2 = captureTurnOutcome({
      projectDir: f.project, event: 'SessionEnd', payload, home: f.home, env: f.env, brainHome: f.brainHome, ruflo: '/fake/ruflo',
      now: () => tRetry,
      run: (_bin, args) => (args[1] === 'store'
        ? { status: 1, stderr: '[ERROR] immutable append rejected: logical key already exists' }
        : { status: 0, stdout: `${firstValue}\n` }),
    });
    expect(r2.recorded).toBe(true);
    expect(r2.alreadyRecorded).toBe(true);
    expect(r2.committedAt).toBe(tOriginal.toISOString());
    expect(r2.committedValueSha256).toBe(crypto.createHash('sha256').update(firstValue).digest('hex'));
    expect(r2.receipt).toMatchObject({ status: 0, verified: true, alreadyRecorded: true, committedAt: tOriginal.toISOString() });
    const receiptRaw = fs.readFileSync(receipts, 'utf8');
    expect(receiptRaw).not.toContain('turnInput');
    expect(receiptRaw).not.toContain(OUTCOME);
    expect(ledgerRows(f.brainHome)).toEqual([]);

    // Tampered stored bytes must still be refused even with a valid timestamp header
    fs.rmSync(receipts, { force: true });
    fs.rmSync(path.join(f.brainHome, 'turn-capture', 'last-turn.json'), { force: true });
    const rTamper = captureTurnOutcome({
      projectDir: f.project, event: 'SessionEnd', payload, home: f.home, env: f.env, brainHome: f.brainHome, ruflo: '/fake/ruflo',
      now: () => tRetry,
      run: (_bin, args) => (args[1] === 'store'
        ? { status: 1, stderr: '[ERROR] immutable append rejected: logical key already exists' }
        : { status: 0, stdout: firstValue.replace('safeguards', 'DIFFERENT') }),
    });
    expect(rTamper.recorded).toBe(false);
    expect(rTamper.receipt.error).toBe('duplicate turn key holds different content');
    expect(fs.existsSync(path.join(f.brainHome, 'hook-failures.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(f.brainHome, 'hook-failures.jsonl'), 'utf8')).not.toContain('turnInput');
  });
});

describe('#513 Part 2 single-child store+readback and bounded detached SessionEnd handoff', () => {
  function rufloPackageFixture(root) {
    const pkg = path.join(root, 'lib', 'node_modules', 'ruflo');
    const cli = path.join(pkg, 'node_modules', '@claude-flow', 'cli');
    const memDir = path.join(cli, 'dist', 'src', 'memory');
    const storeFile = path.join(root, 'single-store.json');
    const callLog = path.join(root, 'calls.log');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.mkdirSync(memDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ruflo', version: '0.0.0', type: 'module', bin: { ruflo: 'bin/ruflo.js' } }));
    fs.writeFileSync(path.join(pkg, 'bin', 'ruflo.js'), `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, 'cli ' + a[1] + '\\n');
const db = JSON.parse(fs.existsSync(${JSON.stringify(storeFile)}) ? fs.readFileSync(${JSON.stringify(storeFile)}, 'utf8') : '{}');
if (a[1] === 'store') {
  const k = a[a.indexOf('--key') + 1]; const v = a[a.indexOf('--value') + 1];
  db[k] = v; fs.writeFileSync(${JSON.stringify(storeFile)}, JSON.stringify(db));
} else if (a[1] === 'retrieve') {
  const k = a[a.indexOf('--key') + 1];
  process.stdout.write(db[k] || '');
}
`, { mode: 0o755 });
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@claude-flow/cli', version: '0.0.0', type: 'module', exports: { './memory': { import: './dist/src/memory/memory-initializer.js' } } }));
    fs.writeFileSync(path.join(memDir, 'memory-initializer.js'), `import fs from 'node:fs';
export const resolveDbPath = (p) => p;
export async function storeEntry(opts) {
  fs.appendFileSync(${JSON.stringify(callLog)}, 'single-store ' + JSON.stringify(opts) + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_DELAY_MS || 0));
  const db = JSON.parse(fs.existsSync(${JSON.stringify(storeFile)}) ? fs.readFileSync(${JSON.stringify(storeFile)}, 'utf8') : '{}');
  if (opts.appendOnly && Object.hasOwn(db, opts.key)) return { success: false, error: 'immutable append rejected: logical key already exists' };
  db[opts.key] = opts.value;
  fs.writeFileSync(${JSON.stringify(storeFile)}, JSON.stringify(db));
  return { success: true, id: 'id-1' };
}
export async function getEntry({ key }) {
  fs.appendFileSync(${JSON.stringify(callLog)}, 'single-get ' + key + '\\n');
  const db = JSON.parse(fs.existsSync(${JSON.stringify(storeFile)}) ? fs.readFileSync(${JSON.stringify(storeFile)}, 'utf8') : '{}');
  return Object.hasOwn(db, key) ? { success: true, found: true, entry: { content: db[key] } } : { success: true, found: false };
}
`);
    const bin = path.join(root, 'bin', 'ruflo');
    fs.symlinkSync(path.join(pkg, 'bin', 'ruflo.js'), bin);
    return { bin, callLog, storeFile };
  }

  it('uses ONE owned child calling storeEntry + getEntry and falls back when RUFLO_MEMORY_SCAN_ON_WRITE is set', () => {
    const f = projectFixture('g3-single-');
    const rpkg = rufloPackageFixture(f.root);
    const r = captureTurnOutcome({
      projectDir: f.project, event: 'Stop', host: 'claude', home: f.home, brainHome: f.brainHome,
      ruflo: rpkg.bin, env: { ...f.env, RUFLO_BIN: rpkg.bin },
      payload: { session_id: 'single-1', last_assistant_message: OUTCOME },
    });
    expect(r.recorded).toBe(true);
    const lines = fs.readFileSync(rpkg.callLog, 'utf8').trim().split('\n');
    expect(lines.filter((l) => l.startsWith('cli '))).toEqual([]);
    const storeOpts = JSON.parse(lines.find((l) => l.startsWith('single-store ')).slice('single-store '.length));
    expect(storeOpts).toMatchObject({
      namespace: 'turns',
      generateEmbeddingFlag: true,
      requireNative: true,
      appendOnly: true,
      tags: [],
      upsert: false,
      provenanceType: 'agent_output',
      dbPath: f.db,
    });
    expect(lines.some((l) => l.startsWith('single-get '))).toBe(true);

    // Scan flag triggers CLI two-step path
    captureTurnOutcome({
      projectDir: f.project, event: 'Stop', host: 'claude', home: f.home, brainHome: f.brainHome,
      ruflo: rpkg.bin, env: { ...f.env, RUFLO_BIN: rpkg.bin, RUFLO_MEMORY_SCAN_ON_WRITE: '1' },
      payload: { session_id: 'single-scan', last_assistant_message: OUTCOME },
    });
    const lines2 = fs.readFileSync(rpkg.callLog, 'utf8').trim().split('\n');
    expect(lines2.filter((l) => l.startsWith('cli '))).toEqual(['cli store', 'cli retrieve']);
  });

  it('SessionEnd with <2600ms budget detaches over stdin, writes live pending receipt, completes asynchronously, and enforces wait cap', async () => {
    const f = projectFixture('g3-detach-end-');
    const rpkg = rufloPackageFixture(f.root);
    const started = Date.now();
    const res = captureTurnOutcome({
      projectDir: f.project, event: 'SessionEnd', host: 'claude', home: f.home, brainHome: f.brainHome,
      ruflo: rpkg.bin, env: { ...f.env, RUFLO_BIN: rpkg.bin, FAKE_DELAY_MS: '400' },
      deadlineAt: started + 1200,
      payload: { session_id: 'end-1', last_assistant_message: OUTCOME },
      launch: () => ({ launched: true }),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.recorded).toBe(false);
    expect(res.detached).toBe(true);
    expect(Number.isInteger(res.pid)).toBe(true);
    expect(res.receipt).toMatchObject({ pending: true, key: res.key, pid: res.pid });

    // Status sees live pending work before completion (unknown, never ok and never failing)
    const pendingStatus = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env });
    expect(pendingStatus.state).toBe('unknown');
    expect(pendingStatus.line).not.toMatch(/✓|failing/);

    // Wait for detached child to finish write+readback
    const receipts = path.join(f.brainHome, 'turn-capture', 'receipts.jsonl');
    const finished = await until(() => {
      const rows = readBoundedReceipts(receipts).rows.map((x) => x.row);
      return rows.some((r) => r.key === res.key && r.status === 0 && r.verified === true);
    }, 15_000);
    expect(finished).toBe(true);
    expect(turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env }).state).toBe('ok');

    // Bounded capacity: fill all 8 waiting leases with live pids -> sheds cleanly without spawning
    const leaseDir = path.join(f.brainHome, 'turn-capture', 'leases');
    for (let i = 0; i < 8; i += 1) {
      const slot = path.join(leaseDir, `wait-${i}`);
      fs.mkdirSync(slot, { recursive: true });
      fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ pid: process.pid, birth: Date.now(), token: `busy-${i}` }));
    }
    const capped = captureTurnOutcome({
      projectDir: f.project, event: 'SessionEnd', host: 'claude', home: f.home, brainHome: f.brainHome,
      ruflo: rpkg.bin, env: { ...f.env, RUFLO_BIN: rpkg.bin },
      deadlineAt: Date.now() + 1200,
      payload: { session_id: 'end-capped', last_assistant_message: OUTCOME },
      launch: () => ({ launched: true }),
    });
    expect(capped.recorded).toBe(false);
    expect(capped.detached).toBe(false);
    expect(capped.skipped).toBe('detached turn capture capacity reached');
    expect(ledgerRows(f.brainHome).some((r) => r.error === 'detached turn capture capacity reached')).toBe(true);
  }, 25_000);

  it('keeps Stop synchronous under <2600ms budget and sanitizes single-child non-[ERROR] messages and throwing duplicate storeEntry', () => {
    const f = projectFixture('g3-audit-513-');
    const rpkg = rufloPackageFixture(f.root);
    // Stop must stay synchronous even when remaining deadline < 2600ms
    const stopRes = captureTurnOutcome({
      projectDir: f.project, event: 'Stop', host: 'claude', home: f.home, brainHome: f.brainHome,
      ruflo: rpkg.bin, env: { ...f.env, RUFLO_BIN: rpkg.bin },
      deadlineAt: Date.now() + 1200,
      payload: { session_id: 'stop-tight', last_assistant_message: OUTCOME },
    });
    expect(stopRes.detached).toBeUndefined();
    expect(stopRes.recorded).toBe(true);

    // Non-[ERROR] failure message from storeEntry is reported cleanly without raw JSON stdout wrapper
    const memInit = path.join(f.root, 'lib', 'node_modules', 'ruflo', 'node_modules', '@claude-flow', 'cli', 'dist', 'src', 'memory', 'memory-initializer.js');
    fs.writeFileSync(memInit, `
export const resolveDbPath = (p) => p;
export async function storeEntry(opts) {
  if (opts.key === '${stopRes.key}') throw new Error('immutable append rejected: logical key already exists');
  return { success: false, error: 'database is locked' };
}
export async function getEntry() { return { success: true, found: false }; }
`);
    const lockFail = captureTurnOutcome({
      projectDir: f.project, event: 'Stop', host: 'claude', home: f.home, brainHome: f.brainHome,
      ruflo: rpkg.bin, env: { ...f.env, RUFLO_BIN: rpkg.bin },
      payload: { session_id: 'stop-lock', last_assistant_message: OUTCOME },
    });
    expect(lockFail.recorded).toBe(false);
    expect(lockFail.receipt.error).toContain('database is locked');
    expect(lockFail.receipt.error).not.toMatch(/^\{"fallback":/);

    // Throwing storeEntry with "already exists" still proceeds to getEntry readback (#520 retry)
    const receipts = path.join(f.brainHome, 'turn-capture', 'receipts.jsonl');
    const step = {
      projectRoot: f.project, projectDir: f.project, brainHome: f.brainHome, kind: 'store', ruflo: rpkg.bin,
      args: ['memory', 'store', '--key', stopRes.key, '--value', 'retry-val', '--namespace', 'turns', '--path', f.db],
    };
    const origContent = JSON.parse(fs.readFileSync(rpkg.storeFile, 'utf8'))[stopRes.key];
    fs.writeFileSync(memInit, `
export const resolveDbPath = (p) => p;
export async function storeEntry() { throw new Error('immutable append rejected: logical key already exists'); }
export async function getEntry() { return { success: true, found: true, entry: { content: ${JSON.stringify(origContent)} } }; }
`);
    const [dupThrowRow] = runSteps({ receipts, steps: [step], event: 'Stop' }, { env: { ...f.env, RUFLO_BIN: rpkg.bin }, projectDir: f.project, brainHome: f.brainHome });
    expect(dupThrowRow).toMatchObject({ status: 1, verified: false, error: 'duplicate turn key holds different content' });
  });
});

describe('#524 SessionStart turnRecordingStatus rotation, sorting/dedupe, pending owners, unscoped ledger, integrity', () => {
  it('handles .1 rotation + chronological sort/dedupe before slice(-20), live vs dead pending, unscoped ledger, and corrupt receipts', () => {
    const f = projectFixture('g3-524-');
    const storeIdentity = crypto.createHash('sha256').update(f.db).digest('hex');
    const receipts = path.join(f.brainHome, 'turn-capture', 'receipts.jsonl');
    fs.mkdirSync(path.dirname(receipts), { recursive: true });
    const now = Date.now();
    const mkRow = (over) => JSON.stringify({ at: new Date(now - 60_000).toISOString(), kind: 'store', db: f.db, storeIdentity, status: 0, verified: true, error: null, ...over });

    // Key 'k-flapped' failed in .1, succeeded in .jsonl, plus 25 later verified keys -> latest state wins, slice(-20) after dedupe -> ok!
    fs.writeFileSync(`${receipts}.1`, mkRow({ key: 'k-flapped', at: new Date(now - 120_000).toISOString(), status: 1, verified: false, error: 'transient' }) + '\n');
    const activeLines = [mkRow({ key: 'k-flapped', at: new Date(now - 10_000).toISOString(), status: 0, verified: true })];
    for (let i = 0; i < 25; i += 1) activeLines.push(mkRow({ key: `k-${i}`, at: new Date(now - 9_000 + i * 10).toISOString() }));
    fs.writeFileSync(receipts, activeLines.join('\n') + '\n');
    expect(turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now }).state).toBe('ok');

    // Live pending row -> unknown, not warn/ok
    fs.rmSync(`${receipts}.1`, { force: true });
    fs.writeFileSync(receipts, mkRow({ key: 'k-pend', pending: true, status: null, verified: false, pid: process.pid, deadlineAt: now + 30_000 }) + '\n');
    const livePend = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(livePend.state).toBe('unknown');
    expect(livePend.line).not.toMatch(/✓|failing/);

    // Dead PID pending row -> warn with bounded store/key attribution
    fs.writeFileSync(receipts, mkRow({ key: 'k-dead', pending: true, status: null, verified: false, pid: 2 ** 22 - 1, deadlineAt: now + 30_000 }) + '\n');
    const deadPend = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(deadPend.state).toBe('warn');
    expect(deadPend.line).toMatch(/^turn recording failing 1\/1 — /);
    expect(deadPend.line).toContain(`store:${storeIdentity.slice(0, 8)}`);

    // Unscoped hook-failures row (!r.store) surfaces applicability unknown rather than blaming this store
    fs.writeFileSync(receipts, mkRow({ key: 'k-ok', at: new Date(now - 5000).toISOString() }) + '\n');
    fs.writeFileSync(path.join(f.brainHome, 'hook-failures.jsonl'), JSON.stringify({ at: new Date(now - 1000).toISOString(), hook: 'turn-capture', event: 'Stop', error: 'other store failed' }) + '\n');
    const unscoped = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(unscoped.state).toBe('unknown');
    expect(unscoped.line).toContain('applicability unknown');
    expect(unscoped.line).not.toMatch(/✓/);

    // Malformed receipt lines + oversized receipts are surfaced explicitly instead of ok
    fs.rmSync(path.join(f.brainHome, 'hook-failures.jsonl'), { force: true });
    fs.writeFileSync(receipts, `${mkRow({ key: 'k-ok' })}\n{broken json\n`);
    const malformed = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(malformed.state).toBe('unknown');
    expect(malformed.line).toContain('malformed');
    expect(malformed.line).not.toMatch(/✓/);

    const padRow = mkRow({ key: 'k-big', extra: 'x'.repeat(250) }) + '\n';
    const bigContent = padRow.repeat(Math.ceil((RECEIPTS_READ_BYTES + 2048) / padRow.length));
    fs.writeFileSync(receipts, bigContent);
    const oversized = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(oversized.state).toBe('unknown');
    expect(oversized.line).toContain('oversized');
    expect(oversized.line).not.toMatch(/✓/);

    // Unreadable receipts directory -> unknown
    fs.rmSync(receipts, { force: true });
    fs.mkdirSync(receipts);
    const unreadable = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(unreadable.state).toBe('unknown');
    expect(unreadable.line).toContain('unreadable');
    expect(RECEIPTS_READ_BYTES).toBe(512 * 1024);

    // Keyless receipts with identical `at` stay distinct, invalid `r.at` on scoped failure warns, and corrupt hook-failures is surfaced
    fs.rmSync(receipts, { recursive: true, force: true });
    const sameIso = new Date(now - 2000).toISOString();
    fs.writeFileSync(receipts, [
      JSON.stringify({ at: sameIso, kind: 'store', db: f.db, storeIdentity, status: 0, verified: true, error: null }),
      JSON.stringify({ at: sameIso, kind: 'store', db: f.db, storeIdentity, status: 0, verified: true, error: null }),
    ].join('\n') + '\n');
    const twoKeyless = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(twoKeyless.state).toBe('ok');
    expect(twoKeyless.line).toContain('(2/2 exact readbacks)');

    const ledgerPath = path.join(f.brainHome, 'hook-failures.jsonl');
    fs.writeFileSync(ledgerPath, JSON.stringify({ at: 'not-a-date', hook: 'turn-capture', event: 'Stop', store: storeIdentity.slice(0, 16), error: 'bad timestamp failure' }) + '\n');
    const badTs = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(badTs.state).toBe('warn');
    expect(badTs.line).toContain('bad timestamp failure');

    fs.writeFileSync(ledgerPath, '{corrupt ledger line\n');
    const corruptLedger = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(corruptLedger.state).toBe('unknown');
    expect(corruptLedger.line).toContain('malformed hook-ledger');
    expect(corruptLedger.line).not.toMatch(/✓/);

    fs.rmSync(ledgerPath, { force: true });
    fs.mkdirSync(ledgerPath);
    const unreadableLedger = turnRecordingStatus({ projectDir: f.project, home: f.home, env: f.env, now });
    expect(unreadableLedger.state).toBe('unknown');
    expect(unreadableLedger.line).toContain('hook ledger unreadable');
    expect(unreadableLedger.line).not.toMatch(/✓/);
  });
});

describe('#523 + #522 SessionStart budget (10s restore / 16s cap), quiet-mode delivery, restoreProof, honest categories', () => {
  it('enforces 10000ms restore budget inside 16s timeout and clamps RUVNET_SESSION_START_RESTORE_MS', () => {
    expect(STAGE_BUDGETS_MS.restore).toBe(10000);
    expect(sessionStartTimeoutMs()).toBe(16000);
    expect(sumBudgetsMs()).toBeLessThan(sessionStartTimeoutMs() - MEASURED_NODE_BOOT_MS);
    expect(sessionStartRestoreBudgetMs({ RUVNET_SESSION_START_RESTORE_MS: '4000' })).toBe(4000);
    expect(sessionStartRestoreBudgetMs({ RUVNET_SESSION_START_RESTORE_MS: '99999' })).toBe(10000);
    expect(sessionStartRestoreBudgetMs({})).toBe(10000);
  });

  it('delivers restored/incomplete/single-line unknown continuity in quiet mode and records safe restoreProof fields', async () => {
    for (const [label, fn, expectSubstr, expectFailed, expectCat] of [
      ['restored', async () => ({ status: 'restored', route: 'fast', context: '[RuvNet Brain — PROJECT STATE · db]\nproj/k: restored' }), 'proj/k: restored', false, null],
      ['partial', async () => ({ status: 'partial', route: 'fallback', errorCategory: 'failed', context: '[RuvNet Brain — PROJECT CONTINUITY INCOMPLETE] partial read' }), 'PROJECT CONTINUITY INCOMPLETE', true, 'failed'],
      ['throw-non-deadline', async () => { throw new Error('secret /private/path boom'); }, 'The SessionStart restore boundary failed unexpectedly', true, 'failed'],
      ['throw-deadline', async () => { throw new Error('restore deadline exceeded'); }, 'The SessionStart restore deadline expired', true, 'timed-out'],
      ['throw-timeout', async () => { throw new Error('operation timeout'); }, 'The SessionStart restore deadline expired', true, 'timed-out'],
    ]) {
      const f = projectFixture(`g3-522-${label}-`);
      fs.chmodSync(f.root, 0o700);
      const proofDir = path.join(f.root, 'proof');
      fs.mkdirSync(proofDir, { mode: 0o700 });
      const proofFile = path.join(proofDir, 'proof.json');
      const nonce = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(proofFile, JSON.stringify({ schema: 1, state: 'pending', nonce }), { mode: 0o600 });
      let out = '';
      await runSessionStart({
        cwd: f.project,
        env: { HOME: f.home, RUVNET_BRAIN_HOME: f.brainHome, RUVNET_BRAIN_OFF: '1', RUVNET_BRAIN_METER: '0',
          RUVNET_BRAIN_HOST_PROOF_PATH: proofFile, RUVNET_BRAIN_HOST_PROOF_NONCE: nonce }, // default quiet (no RUVNET_VERBOSE_HOOKS)
        stdout: { write: (s) => { out += s; } },
        stderr: { write() {} },
        runHeartbeat: false,
        restoreContinuity: fn,
      });
      expect(out, label).toContain(expectSubstr);
      if (process.platform !== 'win32') {
        const proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
        expect(proof.restore.failed).toBe(expectFailed);
        expect(proof.restore.errorCategory).toBe(expectCat);
        expect(JSON.stringify(proof)).not.toContain('secret /private/path boom');
        if (label.startsWith('throw-')) expect(proof.restore.errorDigest).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  it('reserves "in time" strictly for timed-out failures in restore() across list, resolve, and retrieve boundaries', async () => {
    const f = projectFixture('g3-cat-');
    const unavailable = await restore({ cwd: f.project, bin: '/nonexistent/ruflo-xyz', env: { ...f.env, RUFLO_BIN: '/nonexistent/ruflo-xyz' }, deadlineAt: Date.now() + 5000 });
    expect(unavailable.status).toBe('unknown');
    expect(unavailable.errorCategory).not.toBe('timed-out');
    expect(unavailable.context).not.toContain('in time');

    const resolveTimeout = await restore({
      cwd: f.project, bin: '/fake/ruflo', env: f.env, deadlineAt: Date.now() + 500,
      resolve: () => { throw new Error('resolve deadline exceeded'); },
    });
    expect(resolveTimeout.status).toBe('unknown');
    expect(resolveTimeout.errorCategory).toBe('timed-out');
    expect(resolveTimeout.context).toContain('in time');

    const retrieveTimeout = await restore({
      cwd: f.project, bin: '/fake/ruflo', env: f.env, deadlineAt: Date.now() + 120,
      resolve: () => ({ projectRoot: f.project, canonicalAgentDbPath: f.db }),
      invoke: (_bin, args) => ({ executable: 'fake', args }),
      run: (_exe, args, _opts, cb) => {
        if (args[1] === 'list') {
          const ns = args[args.indexOf('-n') + 1];
          const rows = ns === 'project' ? [{ key: 'project-state-current-1790000000000', createdAt: 1790000000000 }] : [];
          setImmediate(() => cb(null, JSON.stringify(rows), ''));
          return { kill() {} };
        }
        return {
          kill() {
            cb(Object.assign(new Error('exited SIGKILL'), { code: null, signal: 'SIGKILL', killed: false }), '', '');
          },
        };
      },
    });
    expect(retrieveTimeout.status).toBe('unknown');
    expect(retrieveTimeout.errorCategory).toBe('timed-out');

    const slowRufloBin = path.join(f.root, 'slow-ruflo');
    fs.writeFileSync(slowRufloBin, `#!/usr/bin/env node\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);\n`, { mode: 0o755 });
    const timedOut = await restore({ cwd: f.project, bin: slowRufloBin, env: { ...f.env, RUFLO_BIN: slowRufloBin }, deadlineAt: Date.now() + 250 });
    expect(timedOut.status).toBe('unknown');
    expect(timedOut.errorCategory).toBe('timed-out');
    expect(timedOut.context).toContain('in time');
  }, 15_000);
});
