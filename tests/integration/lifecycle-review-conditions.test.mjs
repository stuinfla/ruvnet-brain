// The 4.7.0 review conditions on the lifecycle memory path (owner ruling 2026-10-12: hooks only CALL
// ruflo; a failed or skipped write is a hook-failures row, never silence). Each test below fails on
// db1c5a2f and passes with the fix:
//   M1  a capture that cannot happen (no ruflo) writes a ledger row, and the status cannot show ✓
//   M2  checkpoint + restore in a linked git worktree target the MAIN project's store and namespace
//   M3  PostToolUse learning returns at once under a slow ruflo; the detached child still stores + reads back
//   M4  a Codex-sized SessionEnd budget hands the checkpoint to a detached child instead of a ~1 ms timeout
//   M5a receipts.jsonl rotates at 256 KiB
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptedProject, cleanup, tmp } from '../helpers/continuity-fixture.mjs';
import { slowRuflo, ledgerRows, until } from '../helpers/slow-ruflo.mjs';
import { captureTurnOutcome, resolveTurnDb, runSteps, turnRecordingStatus, RECEIPTS_MAX_BYTES } from '../../plugin/scripts/turn-outcome-capture.mjs';
import { checkpoint, restore } from '../../plugin/scripts/ruflo-memory-hooks.mjs';
import { runLifecycleBoundary } from '../../plugin/scripts/session-snapshot-hook.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HOOK = path.join(ROOT, 'plugin/scripts/session-snapshot-hook.mjs');
const posix = process.platform !== 'win32';
const OUTCOME = 'Fixed the parser so quoted cookie values keep their equals signs; added a regression test that '
  + 'round-trips three real headers and confirmed the full unit suite passes on this branch before handing back.';
afterEach(() => cleanup());

describe('M1: a skipped capture is loud, and the status cannot show a stale ✓', () => {
  it('no ruflo on a non-trivial Stop writes one turn-capture ledger row; the status then is not ✓', () => {
    const p = adoptedProject(); const brainHome = tmp('m1-bh-');
    const db = resolveTurnDb({ projectDir: p.dir, brainHome }).db;
    // A fresh, verified receipt from an earlier turn: on db1c5a2f this alone kept "turn recording ✓".
    const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
    fs.mkdirSync(path.dirname(receipts), { recursive: true });
    fs.writeFileSync(receipts, `${JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), kind: 'store', storeIdentity: crypto.createHash('sha256').update(db).digest('hex'), key: 'turn-x', status: 0, verified: true })}\n`);
    const env = { ...p.env, RUVNET_TURN_CAPTURE: 'on', RUVNET_BRAIN_HOME: brainHome };
    expect(turnRecordingStatus({ projectDir: p.dir, env }).line).toMatch(/✓/);
    const r = captureTurnOutcome({ projectDir: p.dir, event: 'Stop', env, brainHome, ruflo: null,
      payload: { session_id: 'm1', last_assistant_message: OUTCOME, cwd: p.dir } });
    expect(r.skipped).toBe('ruflo not found');
    const rows = ledgerRows(brainHome);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hook: 'turn-capture', event: 'Stop', error: 'ruflo not found' });
    expect(JSON.stringify(rows[0])).not.toContain('equals signs'); // no turn text in the ledger
    const status = turnRecordingStatus({ projectDir: p.dir, env });
    expect(status.line).not.toMatch(/✓/);
    expect(status.state).toBe('warn');
  });
  it('a trivial turn with no ruflo stays quiet (nothing to write is not a failure)', () => {
    const p = adoptedProject(); const brainHome = tmp('m1-bh-');
    captureTurnOutcome({ projectDir: p.dir, event: 'Stop', env: { ...p.env, RUVNET_TURN_CAPTURE: 'on', RUVNET_BRAIN_HOME: brainHome }, brainHome, ruflo: null,
      payload: { session_id: 'm1', last_assistant_message: 'ok', cwd: p.dir } });
    expect(ledgerRows(brainHome)).toEqual([]);
  });
  it('the newest verified receipt older than 24 h is "not proven recently", not ✓', () => {
    const p = adoptedProject(); const brainHome = tmp('m1-bh-');
    const db = resolveTurnDb({ projectDir: p.dir, brainHome }).db;
    const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
    fs.mkdirSync(path.dirname(receipts), { recursive: true });
    fs.writeFileSync(receipts, `${JSON.stringify({ at: new Date(Date.now() - 25 * 3_600_000).toISOString(), kind: 'store', storeIdentity: crypto.createHash('sha256').update(db).digest('hex'), key: 'turn-y', status: 0, verified: true })}\n`);
    const status = turnRecordingStatus({ projectDir: p.dir, env: { ...p.env, RUVNET_TURN_CAPTURE: 'on', RUVNET_BRAIN_HOME: brainHome } });
    expect(status.line).not.toMatch(/✓/);
    expect(status.line).toMatch(/not proven recently/);
  });
});

describe('M2: a linked git worktree checkpoints into and restores from the MAIN project store', () => {
  it.skipIf(!posix)('checkpoint and restore both call ruflo with the main checkout db and namespace', async () => {
    const p = adoptedProject();
    const git = (...args) => { const r = spawnSync('git', ['-C', p.dir, ...args], { env: p.env, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); };
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const wt = path.join(fs.realpathSync.native(tmp('m2-wt-parent-')), 'linked');
    git('worktree', 'add', '-q', '-b', 'wt-branch', wt);
    const stub = slowRuflo(tmp('m2-ruflo-'));
    const env = { ...p.env, RUVNET_TURN_CAPTURE: 'on', RUFLO_BIN: stub.bin };
    const mainDb = path.join(fs.realpathSync.native(p.dir), '.swarm', 'memory.db');
    const saved = await checkpoint({ projectDir: wt, event: 'PreCompact', payload: { session_id: 'm2' }, env });
    expect(saved).toMatchObject({ stored: true, verified: true, namespace: path.basename(p.dir) });
    const store = stub.calls().find((c) => c.argv[1] === 'store');
    expect(store.argv[store.argv.indexOf('--path') + 1]).toBe(mainDb);
    expect(store.argv, 'review m1: a same-millisecond collision is refused, never overwritten').toContain('--no-upsert');
    expect(store.argv[store.argv.indexOf('--key') + 1]).toMatch(/^project-state-auto-\d+-[0-9a-f]{8}$/);
    expect(fs.existsSync(path.join(wt, '.swarm'))).toBe(false); // no second store in the worktree
    const restored = await restore({ cwd: wt, env });
    expect(restored.status).not.toBe('unavailable');
    expect(stub.calls().filter((c) => c.argv[1] === 'list').every((c) => c.argv[c.argv.indexOf('--path') + 1] === mainDb)).toBe(true);
  });
});

describe('M4: a Codex-sized SessionEnd budget never starts a checkpoint it cannot finish', () => {
  it.skipIf(!posix)('with 2.2 s handed down and a 1.5 s store, the boundary returns in budget and a detached child stores + reads back', async () => {
    const p = adoptedProject(); const brainHome = tmp('m4-bh-');
    const stub = slowRuflo(tmp('m4-ruflo-'), { delayMs: 1500 });
    const env = { ...p.env, RUVNET_TURN_CAPTURE: 'on', RUFLO_BIN: stub.bin, RUVNET_BRAIN_HOME: brainHome, RUVNET_CODEX_BUDGET_MS: '2200', RUVNET_HOOK_HOST: 'codex' };
    const t = performance.now();
    const r = await runLifecycleBoundary('SessionEnd', { session_id: 'm4', cwd: p.dir }, { env });
    const ms = performance.now() - t;
    expect(ms, `SessionEnd took ${ms.toFixed(0)} ms`).toBeLessThan(1900);
    expect(r.checkpoint.detached).toBe(true);
    const autoKey = (c) => c.argv[1] === 'store' && /^project-state-auto-/.test(c.argv[c.argv.indexOf('--key') + 1]);
    expect(await until(() => stub.calls().some((c) => c.argv[1] === 'retrieve' && /^project-state-auto-/.test(c.argv[c.argv.indexOf('--key') + 1])))).toBe(true);
    expect(stub.calls().filter(autoKey)).toHaveLength(1);
    expect(ledgerRows(brainHome).filter((row) => row.hook === 'checkpoint')).toEqual([]);
  }, 30_000);
});

describe('M3: PostToolUse learning returns at once; the write is detached, exact and loud on failure', () => {
  const learner = (opts) => {
    const home = fs.realpathSync.native(tmp('m3-home-'));
    fs.mkdirSync(path.join(home, '.claude', 'global-memory', '.swarm'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'global-memory', '.swarm', 'memory.db'), '');
    fs.mkdirSync(path.join(home, '.config', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), '{"learningScope":"user"}');
    const stub = slowRuflo(tmp('m3-ruflo-'), opts);
    const brainHome = tmp('m3-bh-');
    const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUFLO_BIN: stub.bin,
      RUVNET_LEARNING_SCOPE: 'user', RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain') };
    const fire = () => {
      const t = performance.now();
      const r = spawnSync(process.execPath, [HOOK, 'PostToolUse'], { cwd: home, env, encoding: 'utf8', timeout: 20_000,
        input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'm3', tool_name: 'Bash', tool_input: { command: 'npm test -- --token=SECRETVALUE42' }, tool_response: { stdout: 'ok' } }) });
      return { ms: performance.now() - t, status: r.status };
    };
    return { stub, brainHome, fire };
  };
  it.skipIf(!posix)('a 3 s ruflo does not hold the tool call; the observation is then stored and read back by exact key', async () => {
    const l = learner({ delayMs: 3000 });
    const r = l.fire();
    expect(r.status).toBe(0);
    expect(r.ms, `PostToolUse took ${r.ms.toFixed(0)} ms`).toBeLessThan(1500); // per-call latency budget, magnitude bound
    expect(await until(() => l.stub.calls().some((c) => c.argv[1] === 'retrieve'))).toBe(true);
    const store = l.stub.calls().find((c) => c.argv[1] === 'store');
    expect(store.argv).toContain('learning-observations');
    expect(store.argv.join(' ')).not.toContain('SECRETVALUE42'); // fixed vocabulary only: the action is "npm test", never raw argv
    expect(ledgerRows(l.brainHome)).toEqual([]);
  }, 30_000);
  it.skipIf(!posix)('a refused detached write is a learn-capture ledger row', async () => {
    const l = learner({ refuse: true });
    expect(l.fire().status).toBe(0);
    expect(await until(() => ledgerRows(l.brainHome).some((row) => row.hook === 'learn-capture'))).toBe(true);
  }, 30_000);
  it('learning stays OFF without persisted consent: nothing is spawned or stored', () => {
    const home = fs.realpathSync.native(tmp('m3-off-'));
    const stub = slowRuflo(tmp('m3-off-ruflo-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_PROJECT_DIR: home, RUFLO_BIN: stub.bin, RUVNET_BRAIN_HOME: tmp('m3-off-bh-'),
      RUVNET_BRAIN_STATE_DIR: path.join(home, '.config', 'ruvnet-brain') };
    delete env.RUVNET_LEARNING_SCOPE;
    spawnSync(process.execPath, [HOOK, 'PostToolUse'], { cwd: home, env, encoding: 'utf8', timeout: 10_000,
      input: JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'm3', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} }) });
    expect(stub.calls()).toEqual([]);
  });
});

describe('M5a: receipts.jsonl is bounded', () => {
  it('rotates to .1 past 256 KiB instead of growing without limit', () => {
    const brainHome = tmp('m5-bh-');
    const receipts = path.join(brainHome, 'turn-capture', 'receipts.jsonl');
    fs.mkdirSync(path.dirname(receipts), { recursive: true });
    fs.writeFileSync(receipts, 'x'.repeat(RECEIPTS_MAX_BYTES + 1));
    runSteps({ steps: [{ kind: 'bogus' }], receipts, event: 'Stop' }, { env: { ...process.env, RUVNET_BRAIN_HOME: brainHome }, brainHome, projectDir: os.tmpdir() });
    expect(fs.statSync(`${receipts}.1`).size).toBe(RECEIPTS_MAX_BYTES + 1);
    expect(fs.statSync(receipts).size).toBeLessThan(4096);
  });
});
