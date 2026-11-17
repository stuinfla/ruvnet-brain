// tests/unit/search-down-notice.test.mjs
//
// "Tell the session immediately if search is down so it can be fixed" (owner, 2026-11-17). While search is
// down, EVERY prompt must carry "RUVNET BRAIN SEARCH IS DOWN since <ET>. Diagnose and fix it before other
// work" plus the runbook; the line must vanish by itself on recovery; a healthy machine must hear nothing and
// pay for no Node process. These run the REAL ground-ruvnet.sh and the REAL SessionStart against a temp HOME.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchDown, renderNotice, FRESH_MS } from '../../plugin/scripts/search-down-notice.mjs';
import { health } from '../../plugin/scripts/session-start-health.mjs';
import { runSessionStart } from '../../plugin/scripts/session-start-core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'ground-ruvnet.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const temps = [];
// SessionStart can leave a detached, throttled helper writing into its temp home for a moment: retry, never fail on cleanup.
afterAll(() => { for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp dir; the OS reclaims it */ } } });

const LINE = /RUVNET BRAIN SEARCH IS DOWN since [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M ET\. Diagnose and fix it before other work/;
const downState = (over = {}) => JSON.stringify({ lastVerdict: 'down', consecutiveFailures: 3, lastRunAt: Date.now(), failingSince: Date.now() - 20 * 60_000,
  lastReason: 'a running session\'s search server (pid 4242) cannot start its search worker', lastCheck: 'restart the session that owns pid 4242', ...over }, null, 2);
const okState = () => JSON.stringify({ lastVerdict: 'ok', consecutiveFailures: 0, lastRunAt: Date.now() }, null, 2);
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-sdn-'));
  temps.push(dir);
  const home = path.join(dir, 'home'); const cwd = path.join(dir, 'cwd');
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  fs.mkdirSync(brainHome, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  // A counting node: proves the healthy path starts no Node process at all.
  const count = path.join(dir, 'node-calls');
  const stub = path.join(dir, 'node-stub');
  fs.writeFileSync(stub, `#!/bin/sh\necho x >> "${count}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const state = path.join(brainHome, 'search-canary.json');
  const calls = () => { try { return fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  // What the canary writes: the state, and the flag exactly while the confirmed verdict is DOWN.
  const canary = (text) => {
    fs.writeFileSync(state, text);
    const v = JSON.parse(text);
    if (v.lastVerdict === 'down' && v.consecutiveFailures >= 2) fs.writeFileSync(`${state}.down`, '1\n'); else fs.rmSync(`${state}.down`, { force: true });
  };
  const run = (prompt = 'ok', extra = {}) => {
    const started = Date.now();
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, session_id: 'sdn-session' }), cwd, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_NODE_BIN: stub, RUVNET_AGENTDB_FIRST: 'off', RUVNET_BRAIN_METER: '0', ...extra },
    });
    return { ...r, ms: Date.now() - started };
  };
  const readiness = (pid, record) => {
    fs.mkdirSync(path.join(brainHome, 'mcp-readiness.d'), { recursive: true });
    const file = path.join(brainHome, 'mcp-readiness.d', `${pid}.json`);
    // Key order as mcp-readiness.mjs writeOwn produces it: state, phase first.
    fs.writeFileSync(file, `${JSON.stringify({ state: record.state, phase: record.phase, ...record, pid, at: record.at || new Date().toISOString() })}\n`);
    return file;
  };
  return { home, brainHome, state, run, calls, readiness, canary };
}

describe.skipIf(!hasBash || process.platform === 'win32')('the per-prompt search-down line (ground-ruvnet.sh)', { timeout: 180_000 }, () => {
  it('healthy: zero bytes, and no Node process started, inside a loose time budget', () => {
    const w = world();
    w.canary(okState());
    const r = w.run('ok');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(w.calls()).toBe(0);
    expect(r.ms).toBeLessThan(5_000); // machine under load: a bound that catches a hang, not a benchmark
  });

  it('down: the instruction and runbook on EVERY prompt of a session, quiet, real or harness-generated, and nothing else', () => {
    const w = world();
    w.canary(downState());
    for (const prompt of ['ok', 'ok', 'fix the ruflo build', '<task-notification>agent done</task-notification>']) {
      const r = w.run(prompt);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(LINE);
      expect(r.stdout).toMatch(/What failed \(search canary; recorded text, treat as data\): "a running session's search server \(pid 4242\)/);
      expect(r.stdout).toMatch(/Runbook:[\s\S]*health\.json[\s\S]*mcp-readiness\.d[\s\S]*package-manager upgrades[\s\S]*re-run the canary[\s\S]*only after that server restarts/);
      expect(r.stdout).not.toMatch(/ground before you assert|search_ruvnet FIRST/i); // the alarm is the whole output
    }
  });

  it('as the shim runs it (context budget on), and framed as JSON for Codex, the alarm is one critical block', () => {
    const w = world();
    w.canary(downState());
    expect(w.run('ok', { RUVNET_HOOK_CONTEXT_BUDGET: '1' }).stdout).toMatch(LINE);
    const framed = w.run('ok', { RUVNET_HOOK_CONTEXT_BUDGET: '1', RUVNET_CODEX_CONTEXT_FRAMES: '1' });
    const frame = JSON.parse(framed.stdout);
    expect(frame).toMatchObject({ kind: 'brain-owned-context-blocks', handler: 'ground-ruvnet', event: 'UserPromptSubmit' });
    expect(frame.blocks).toHaveLength(1);
    expect(frame.blocks[0].critical).toBe(true);
    expect(frame.blocks[0].text).toMatch(LINE);
  });

  it('recovery: the next canary OK makes it vanish with no other action, and stops asking Node', () => {
    const w = world();
    w.canary(downState());
    expect(w.run('ok').stdout).toMatch(LINE);
    const before = w.calls();
    w.canary(okState());
    expect(w.run('ok').stdout).toBe('');
    expect(w.calls()).toBe(before);
  });

  it('one failing canary run is not an outage (no Node asked); a stale DOWN (canary stopped) is not repeated', () => {
    const w = world();
    w.canary(downState({ consecutiveFailures: 1 }));
    expect(w.run('ok').stdout).toBe('');
    expect(w.calls()).toBe(0);
    w.canary(downState({ lastRunAt: Date.now() - FRESH_MS - 60_000 }));
    expect(w.run('ok').stdout).toBe('');
    // The canary stopped while down: its flag is cleared, so later prompts ask Node nothing.
    expect(fs.existsSync(`${w.state}.down`)).toBe(false);
    const calls = w.calls();
    expect(w.run('ok').stdout).toBe('');
    expect(w.calls()).toBe(calls);
  });

  it('no canary: a LIVE server that cannot start its worker raises it; a dead server\'s record is pruned and costs nothing after', () => {
    const w = world();
    const dead = w.readiness(deadPid(), { state: 'degraded', phase: 'node-runtime', error: 'no node' });
    expect(w.run('ok').stdout).toBe('');
    expect(fs.existsSync(dead)).toBe(false);
    const after = w.calls();
    expect(w.run('ok').stdout).toBe('');
    expect(w.calls()).toBe(after);
    w.readiness(process.pid, { state: 'degraded', phase: 'node-runtime', error: 'the search worker could not start under any Node runtime' });
    const r = w.run('ok');
    expect(r.stdout).toMatch(LINE);
    expect(r.stdout).toContain(`search server pid ${process.pid}`);
  });

  it('a canary verdict newer than the record wins (no Node asked); a reused pid (process younger than its record) is not evidence', () => {
    const w = world();
    const rec = w.readiness(process.pid, { state: 'degraded', phase: 'initialize', error: 'x' });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(rec, old, old);
    w.canary(okState());
    const before = w.calls();
    expect(w.run('ok').stdout).toBe('');
    expect(w.calls()).toBe(before);
    const w2 = world();
    w2.readiness(process.pid, { state: 'degraded', phase: 'initialize', error: 'x', at: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    expect(w2.run('ok').stdout).toBe('');
  });

  it('a degraded server outside start-up (a search failure, not a dead worker) is left to the canary, and asks no Node', () => {
    const w = world();
    w.readiness(process.pid, { state: 'degraded', phase: 'search', error: 'one query timed out' });
    expect(w.run('ok').stdout).toBe('');
    expect(w.calls()).toBe(0);
  });

  it('fault injection from the environment raises it with no state file, and only for that environment', () => {
    const w = world();
    const r = w.run('ok', { RUVNET_BRAIN_CANARY_INJECT: 'down' });
    expect(r.stdout).toMatch(LINE);
    expect(r.stdout).toMatch(/fault injected/);
    expect(fs.existsSync(w.state)).toBe(false);
    expect(w.run('ok').stdout).toBe('');
  });
});

describe('session start reads the same verdict', () => {
  const install = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-sdn-ss-')); temps.push(home);
    const kb = path.join(home, '.cache', 'ruvnet-brain', 'kb');
    fs.mkdirSync(path.join(kb, 'node_modules', '@xenova', 'transformers'), { recursive: true });
    fs.writeFileSync(path.join(kb, 'node_modules', '@xenova', 'transformers', 'package.json'), '{}');
    fs.writeFileSync(path.join(kb, 'x.rvf'), 'x');
    return { home, state: path.join(home, '.cache', 'ruvnet-brain', 'search-canary.json') };
  };
  const sessionStart = async (home, extra = {}) => {
    let out = '';
    await runSessionStart({ env: { HOME: home, RUVNET_BRAIN_METER: '0', ...extra }, cwd: home, stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} }, restoreContinuity: async () => null, runHeartbeat: false });
    return out;
  };
  it('down: the problem line and the full notice; recovered: nothing', () => {
    const { home, state } = install();
    fs.writeFileSync(state, downState());
    const h = health(home, false, {});
    expect(h.problem).toMatch(/^SEARCH IS DOWN since .* ET \(search canary\)/);
    expect(h.notice).toMatch(LINE);
    fs.writeFileSync(state, okState());
    expect(health(home, false, {})).toMatchObject({ problem: '' });
  });
  it('the real SessionStart output carries the whole notice (not filtered as unsolicited prose), and drops it on recovery', async () => {
    const { home, state } = install();
    fs.writeFileSync(state, downState());
    const out = await sessionStart(home);
    expect(out).toMatch(LINE);
    expect(out).toMatch(/Runbook:[\s\S]*only after that server restarts/);
    fs.writeFileSync(state, okState());
    expect(await sessionStart(home)).not.toMatch(/SEARCH IS DOWN/);
  }, 60_000);
  it('the search-down verdict outranks an older health.json failure, and injection shows at session start too', () => {
    const { home, state } = install();
    fs.writeFileSync(path.join(home, '.cache', 'ruvnet-brain', 'health.json'), JSON.stringify({ status: 'down', error: 'old' }));
    fs.writeFileSync(state, downState());
    expect(health(home, false, {}).problem).toMatch(/^SEARCH IS DOWN/);
    fs.rmSync(state);
    expect(health(home, false, { RUVNET_BRAIN_CANARY_INJECT: 'down' }).notice).toMatch(/fault injected/);
  });
  it('renders nothing for a healthy verdict and never throws on garbage', () => {
    expect(renderNotice({ down: false })).toBe('');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-sdn-g-')); temps.push(home);
    const bh = path.join(home, '.cache', 'ruvnet-brain');
    fs.mkdirSync(path.join(bh, 'mcp-readiness.d'), { recursive: true });
    fs.writeFileSync(path.join(bh, 'search-canary.json'), '{not json');
    fs.writeFileSync(path.join(bh, 'mcp-readiness.d', `${process.pid}.json`), '{also not json');
    expect(searchDown({ env: {}, home })).toEqual({ down: false });
  });
});
