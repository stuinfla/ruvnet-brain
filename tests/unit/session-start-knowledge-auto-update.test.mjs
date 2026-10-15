// session-start-knowledge-auto-update.test.mjs — the owner invariant (2026-09-30): no installed
// brain may ever be more than 48h old. SessionStart launches ONE detached, throttled, locked
// `npx ruvnet-brain@latest --update` when nothing proves the knowledge current inside 24h, and the
// next session speaks the real outcome. Every guard below has a paired case where it must NOT hold.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knowledgeAutoUpdate, AUTO_UPDATE_POLICY } from '../../plugin/scripts/session-start-update-plane.mjs';
import { knowledgeCurrency, KNOWLEDGE_LINE_PREFIX } from '../../plugin/scripts/session-start-health.mjs';
import { runSessionStart } from '../../plugin/scripts/session-start-core.mjs';

const HOOK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts');
const NOW = Date.parse('2026-09-30T12:00:00Z');
const H = 3_600_000;
let home; let brain; let kb;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-autoupdate-'));
  brain = path.join(home, '.cache', 'ruvnet-brain');
  kb = path.join(brain, 'kb');
  fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
  fs.writeFileSync(path.join(kb, 'store.rvf'), 'x');
  fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// updater present\n');
  for (const f of ['.console-offered', '.router-profile-nudged']) fs.writeFileSync(path.join(brain, f), '');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const built = (msAgo, extra = {}) => fs.writeFileSync(path.join(kb, 'SOURCE.json'),
  JSON.stringify({ builtUtc: new Date(NOW - msAgo).toISOString(), releaseTag: 'v4.0.1', ...extra }));
const attemptFile = () => path.join(brain, 'auto-update.json');
const lockFile = () => path.join(brain, 'auto-update.lock');
const checkFile = () => path.join(brain, 'corpus-check.json');
const writeAttempt = (value) => fs.writeFileSync(attemptFile(), JSON.stringify(value));
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  return { calls, fn };
}
const run = (env = {}, spawnFn = fakeSpawn().fn, now = NOW) => {
  const emitted = [];
  const result = knowledgeAutoUpdate({ env: { HOME: home, ...env }, home, now, hookDir: HOOK_DIR,
    emit: (l) => emitted.push(l), spawnFn });
  return { ...result, emitted };
};
const line = (env = {}, now = NOW) => knowledgeCurrency({ env, home, now });
const claimAgenticKit = () => {
  fs.mkdirSync(path.join(home, '.config', 'agentic-kit'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'agentic-kit', 'kit.json'), JSON.stringify({ ruvnetBrain: true }));
};
let receiptN = 0;
const successReceipt = (msAgo) => {
  const dir = path.join(brain, 'refresh-runs');
  fs.mkdirSync(dir, { recursive: true });
  receiptN += 1;
  const at = iso(msAgo);
  fs.writeFileSync(path.join(dir, `r${receiptN}.json`), JSON.stringify({ schemaVersion: 3, kind: 'ruvnet-brain-refresh-run',
    action: 'update', runId: `r${receiptN}`, status: 'SUCCEEDED', terminalVerdict: 'noop', startedAt: at, finishedAt: at,
    requiredPhaseOrder: ['source-enumeration', 'apply'],
    phases: [{ phase: 'source-enumeration', status: 'PASS' }, { phase: 'apply', status: 'PASS' }] }));
};

describe('SessionStart knowledge auto-update — launch decision', () => {
  it('fresh knowledge base (2h) checked 10 min ago does not launch; 30h-old launches exactly once, detached, via host-update --knowledge', () => {
    built(2 * H);
    fs.writeFileSync(checkFile(), JSON.stringify({ schemaVersion: 1, launchedAt: iso(10 * 60_000), outcome: 'current' }));
    const fresh = fakeSpawn();
    expect(run({}, fresh.fn)).toMatchObject({ launched: false, why: 'fresh' });
    expect(fresh.calls).toHaveLength(0);

    built(30 * H);
    const stale = fakeSpawn();
    expect(run({}, stale.fn)).toMatchObject({ launched: true });
    expect(stale.calls).toHaveLength(1);
    const { args, opts } = stale.calls[0];
    expect(args[0]).toBe(path.join(HOOK_DIR, 'detach.mjs'));
    expect(args[1]).toBe(String(AUTO_UPDATE_POLICY.ttlSec));
    expect(args.slice(4)).toEqual([path.join(HOOK_DIR, 'host-update.mjs'), '--knowledge', attemptFile(), lockFile()]);
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(JSON.parse(fs.readFileSync(attemptFile(), 'utf8')).outcome).toBe('launched');
    expect(fs.existsSync(lockFile())).toBe(true);
    // Same session burst: lock held AND throttled → no second launch.
    const again = fakeSpawn();
    expect(run({}, again.fn).launched).toBe(false);
    expect(again.calls).toHaveLength(0);
  });

  it('a second session within 6h does not relaunch; after 6h it does', () => {
    built(30 * H);
    writeAttempt({ launchedAt: iso(5 * H), outcome: 'failed', code: 1, reason: 'x', finishedAt: iso(5 * H) });
    expect(run()).toMatchObject({ launched: false, why: 'throttled' });
    writeAttempt({ launchedAt: iso(7 * H), outcome: 'failed', code: 1, reason: 'x', finishedAt: iso(7 * H) });
    expect(run()).toMatchObject({ launched: true });
  });

  it('a live lock blocks the launch; a lock older than the TTL is reclaimed', () => {
    built(30 * H);
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, at: iso(10 * 60_000) }));
    expect(run()).toMatchObject({ launched: false, why: 'locked' });
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, at: iso(40 * 60_000) }));
    expect(run()).toMatchObject({ launched: true });
  });

  it('a running nightly/manual refresh (its lock dir) blocks the launch', () => {
    built(30 * H);
    fs.mkdirSync(path.join(brain, '.kb.refresh-run.lock'));
    expect(run()).toMatchObject({ launched: false, why: 'refresh running' });
    fs.rmSync(path.join(brain, '.kb.refresh-run.lock'), { recursive: true });
    expect(run()).toMatchObject({ launched: true });
  });

  it('opt-outs: RUVNET_AUTO_UPDATE=off, a recorded "no", agentic-kit ownership, and test mode never launch', () => {
    built(30 * H);
    const spy = fakeSpawn();
    expect(run({ RUVNET_AUTO_UPDATE: 'off' }, spy.fn).why).toBe('RUVNET_AUTO_UPDATE=off');
    expect(line({ RUVNET_AUTO_UPDATE: 'off' })).toBe(''); // under 48h the line itself stays silent
    built(50 * H);
    expect(line({ RUVNET_AUTO_UPDATE: 'off' })).toContain('automatic update is off (RUVNET_AUTO_UPDATE=off)');
    expect(line()).toContain('SessionStart retries the update automatically at most every 6h');
    expect(run({ RUVNET_BRAIN_TEST: '1' }, spy.fn).why).toBe('test mode');
    fs.writeFileSync(path.join(brain, '.auto-update-pref'), 'no\n');
    expect(run({}, spy.fn).why).toMatch(/answered no/);
    fs.writeFileSync(path.join(brain, '.auto-update-pref'), 'yes\n');
    claimAgenticKit();
    successReceipt(30 * H); // agentic-kit really delivered an update 30h ago → it owns this machine
    expect(run({}, spy.fn).why).toMatch(/agentic-kit owns updates and one is proven within 36h/);
    expect(spy.calls).toHaveLength(0);
    fs.rmSync(path.join(home, '.config'), { recursive: true });
    expect(run({}, spy.fn).launched).toBe(true); // the same fixture launches once every opt-out is gone
  });

  // 2026-09-30, owner's Mac: kit.json said ruvnetBrain:true, agentic-kit scheduled nothing, and the
  // self-heal stood down forever. A claim without a proven update must NOT suppress the self-heal.
  it('agentic-kit ownership with NO proven update does not suppress the self-heal (owner Mac regression)', () => {
    built(40 * 24 * H);
    claimAgenticKit();
    const spy = fakeSpawn();
    expect(run({}, spy.fn)).toMatchObject({ launched: true, why: 'stale' });
    expect(spy.calls).toHaveLength(1);
    const text = line();
    expect(text).toContain('agentic-kit claims updates (kit.json ruvnetBrain:true) but no update is proven in 36h');
    expect(text).toContain('Fix: npx ruvnet-brain@latest --update (');
    expect(text).not.toContain('Fix: ak sync');
    expect(text).not.toContain('--enable-nightly'); // one update owner per machine: never suggest both
    expect(text).toContain('an automatic update is running now'); // the self-heal it just launched
    expect(text).not.toContain('automatic update is off');
  });

  it('agentic-kit proof expires: a success 37h ago no longer suppresses; 35h ago still does', () => {
    built(40 * 24 * H);
    claimAgenticKit();
    successReceipt(37 * H);
    expect(run()).toMatchObject({ launched: true });
    fs.rmSync(attemptFile(), { force: true }); fs.rmSync(lockFile(), { force: true });
    successReceipt(35 * H);
    expect(run().why).toMatch(/agentic-kit owns updates/);
  });

  it('offline is silent and retries after 30 minutes, not 6 hours', () => {
    built(30 * H);
    writeAttempt({ launchedAt: iso(10 * 60_000), outcome: 'offline', code: null, reason: 'registry unreachable', finishedAt: iso(9 * 60_000) });
    expect(run()).toMatchObject({ launched: false, why: 'throttled' });
    expect(line()).not.toContain('FAILING');
    writeAttempt({ launchedAt: iso(40 * 60_000), outcome: 'offline', code: null, reason: 'registry unreachable', finishedAt: iso(39 * 60_000) });
    expect(run()).toMatchObject({ launched: true });
  });
});

describe('SessionStart knowledge auto-update — the next session reports the real outcome', () => {
  it('a launch that throws is recorded and reported as UPDATE FAILING', () => {
    built(30 * H);
    const r = run({}, () => { throw new Error('EAGAIN'); });
    expect(r).toMatchObject({ launched: false, why: 'launch failed' });
    expect(fs.existsSync(lockFile())).toBe(false);
    const text = line();
    expect(text).toContain('KNOWLEDGE UPDATE FAILING');
    expect(text).toContain('could not launch: EAGAIN');
  });

  it('a worker that exited non-zero without a refresh receipt is reported with its reason', () => {
    built(30 * H);
    writeAttempt({ launchedAt: iso(2 * H), outcome: 'failed', code: 1, reason: 'npm ERR! 404 Not Found', finishedAt: iso(H) });
    expect(line()).toContain('automatic update launched 2h ago FAILED — exit 1: npm ERR! 404 Not Found');
  });

  it('a launch that never recorded an outcome (killed at TTL) is a failure, not "running"', () => {
    built(30 * H);
    writeAttempt({ launchedAt: iso(2 * H), outcome: 'launched' });
    expect(line()).toContain('never recorded an outcome');
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, at: iso(60_000) }));
    writeAttempt({ launchedAt: iso(60_000), outcome: 'launched' });
    built(50 * H); // the line speaks only past 48h
    const running = line();
    expect(running).not.toContain('FAILING');
    expect(running).toContain('an automatic update is running now');
  });

  it('a success is announced exactly once with corpus and age', () => {
    built(3 * H);
    writeAttempt({ launchedAt: iso(2 * H), outcome: 'succeeded', code: 0, reason: '', finishedAt: iso(H) });
    const first = run();
    expect(first.emitted).toEqual([`${KNOWLEDGE_LINE_PREFIX}UPDATED] automatic update finished 1h ago: corpus v4.0.1, knowledge base built 3h ago.`]);
    expect(run().emitted).toEqual([]);
  });
});

describe('SessionStart knowledge auto-update — end to end through runSessionStart, real detach, stub updater', () => {
  let server; let url;
  beforeEach(async () => {
    server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"9.9.9"}'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/ruvnet-brain/latest`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const stubNpx = (exitCode) => {
    // automaticInvocation chooses the owner prefix before PATH; stub that actual door.
    const bin = path.join(home, '.npm-global', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\necho "$@" >> "$HOME/npx-called"\n${exitCode ? 'echo "✗ refresh transaction could not start: stub failure" >&2\n' : ''}exit ${exitCode}\n`, { mode: 0o755 });
    return bin;
  };
  const session = async (env) => {
    let out = '';
    await runSessionStart({ env, cwd: home, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} },
      restoreContinuity: async () => null, runHeartbeat: false });
    return out;
  };
  const waitFor = async (pred, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  };
  const realBuilt = (msAgo) => fs.writeFileSync(path.join(kb, 'SOURCE.json'),
    JSON.stringify({ builtUtc: new Date(Date.now() - msAgo).toISOString(), releaseTag: 'v4.0.1' }));
  const envFor = (bin, probe) => ({ HOME: home, XDG_CACHE_HOME: path.join(home, '.cache'), PATH: `${bin}:${process.env.PATH}`,
    RUVNET_AUTO_UPDATE_PROBE_URL: probe, RUVNET_BRAIN_METER: '0', CLAUDE_PLUGIN_ROOT: path.join(home, 'no-plugin') });

  it.skipIf(process.platform === 'win32')('stale 30h → one detached launch → stub updater runs → success reported once', async () => {
    realBuilt(30 * H);
    const env = envFor(stubNpx(0), url);
    const started = Date.now();
    const first = await session(env);
    expect(Date.now() - started).toBeLessThan(3000); // never waits on the update
    expect(first).not.toContain(KNOWLEDGE_LINE_PREFIX); // 30h: self-heal acts; the >48h line stays quiet
    expect(JSON.parse(fs.readFileSync(attemptFile(), 'utf8')).outcome).toMatch(/launched|succeeded/);
    expect(await waitFor(() => JSON.parse(fs.readFileSync(attemptFile(), 'utf8')).outcome === 'succeeded')).toBe(true);
    expect(fs.readFileSync(path.join(home, 'npx-called'), 'utf8').trim()).toBe('--yes ruvnet-brain@latest --update --no-nightly-prompt');
    expect(await waitFor(() => !fs.existsSync(lockFile()))).toBe(true);
    const second = await session(env);
    expect(second).toContain(`${KNOWLEDGE_LINE_PREFIX}UPDATED] automatic update finished`);
    expect(fs.readFileSync(path.join(home, 'npx-called'), 'utf8').trim().split('\n')).toHaveLength(1); // throttled
    expect(await session(env)).not.toContain('UPDATED]');
  }, 40_000);

  it.skipIf(process.platform === 'win32')('a failing updater is reported by the next session as UPDATE FAILING with its reason', async () => {
    realBuilt(30 * H);
    const env = envFor(stubNpx(1), url);
    await session(env);
    expect(await waitFor(() => JSON.parse(fs.readFileSync(attemptFile(), 'utf8')).outcome === 'failed')).toBe(true);
    const next = await session(env);
    expect(next).toContain('KNOWLEDGE UPDATE FAILING');
    expect(next).toContain('exit 1: ✗ refresh transaction could not start: stub failure');
  }, 40_000);

  it.skipIf(process.platform === 'win32')('offline: the updater is never invoked and nothing reports a failure', async () => {
    realBuilt(30 * H);
    const env = envFor(stubNpx(0), 'http://127.0.0.1:1/unreachable');
    await session(env);
    expect(await waitFor(() => JSON.parse(fs.readFileSync(attemptFile(), 'utf8')).outcome === 'offline')).toBe(true);
    expect(fs.existsSync(path.join(home, 'npx-called'))).toBe(false);
    expect(await session(env)).not.toContain('FAILING');
  }, 40_000);
});
