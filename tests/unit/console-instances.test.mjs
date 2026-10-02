// console-instances.test.mjs — the installer's automatic Console replacement must (a) start the new
// Console as a user process, not with the installer's own flags (RUVNET_NIGHTLY=1 under the scheduler),
// and (b) recognise a receipt whose pid was REUSED by an unrelated process at once, instead of waiting
// 20s for a Console that no longer exists and reporting a false failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { consoleEnv, pidReused, processStartMs, readConsoleReceipts, replaceStaleConsoles } from '../../scripts/console-instances.mjs';

const temps = [];
const temp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

function receiptFixture(over = {}) {
  const receiptDir = temp('console-instances-receipts-');
  const scope = temp('console-instances-scope-');
  const entry = path.join(temp('console-instances-runtime-'), 'onboarding-console.mjs');
  fs.writeFileSync(entry, '// current runtime\n');
  const receipt = { product: 'ruvnet-brain-console', schema: 1, apiContract: 1, pid: process.pid, port: 7499,
    startedAt: new Date().toISOString(), scope, scriptRealpath: '/old/onboarding-console.mjs', runtimeVersion: '4.3.39',
    sourceSha256: 'a'.repeat(64), controlToken: 'b'.repeat(48), ...over };
  const file = path.join(receiptDir, 'scope.json');
  fs.writeFileSync(file, JSON.stringify(receipt));
  const { controlToken: _secret, ...publicIdentity } = receipt;
  return { receiptDir, entry, file, receipt, publicIdentity, identity: { sourceSha256: 'c'.repeat(64) } };
}

describe('consoleEnv — the replacement Console is a user process', () => {
  it('keeps the user\'s keys, proxy and locale; drops installer, scheduler and test flags', () => {
    const user = { HOME: '/h', PATH: '/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C', RUVNET_BRAIN_HOME: '/b',
      ANTHROPIC_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-o', OPENROUTER_API_KEY: 'sk-r', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'g2',
      XAI_API_KEY: 'x', HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem' };
    const run = { RUVNET_NIGHTLY: '1', RUVNET_NIGHTLY_IDENTITY: 'n', RUVNET_BRAIN_TEST: '1', RUVNET_REFRESH_RUN_TOKEN: 't',
      RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1', NODE_OPTIONS: '--inspect', npm_lifecycle_event: 'x', npm_config_cache: '/c',
      VITEST_WORKER_ID: '1', CONSOLE_PORT: '9999' };
    expect(consoleEnv({ ...user, ...run }, 7411)).toEqual({ ...user, CONSOLE_PORT: '7411' });
  });

  it('replaceStaleConsoles launches the current Console with that env, never the run\'s flags', () => {
    const f = receiptFixture();
    const launched = [];
    replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir, timeoutMs: 300,
      env: { HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-a', HTTPS_PROXY: 'http://p:1', RUVNET_NIGHTLY: '1' },
      probe: () => f.publicIdentity,
      spawnFn: (cmd, args, opts) => { launched.push(opts); return { on() {}, unref() {} }; } });
    expect(launched).toHaveLength(1);
    expect(launched[0].env).toEqual({ HOME: '/h', PATH: '/bin', ANTHROPIC_API_KEY: 'sk-a', HTTPS_PROXY: 'http://p:1', CONSOLE_PORT: '7499' });
    expect(launched[0].cwd).toBe(f.receipt.scope);
  });
});

describe('replaceStaleConsoles — a live pid whose port does not answer', () => {
  it('is reported at once, never pruned: it may be a busy live Console (or a reused pid)', () => {
    const f = receiptFixture(); // pid = this test process: alive, and no Console answers on 7499
    const launched = [];
    const started = Date.now();
    const results = replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir,
      probe: () => null, spawnFn: () => { launched.push(1); return { on() {}, unref() {} }; } });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results).toEqual([expect.objectContaining({ replaced: false, pid: process.pid,
      reason: expect.stringMatching(/is alive but port 7499 does not answer with that Console's identity.*receipt was kept/) })]);
    expect(results[0].pruned).toBeUndefined();
    expect(launched).toEqual([]);
    expect(fs.existsSync(f.file)).toBe(true); // the receipt of a possibly-live Console is never deleted
  });

  it('a port answering a DIFFERENT identity is the same: reported, receipt kept', () => {
    const f = receiptFixture();
    const results = replaceStaleConsoles({ entry: f.entry, identity: f.identity, receiptDir: f.receiptDir,
      probe: () => ({ ...f.publicIdentity, pid: 1 }), spawnFn: () => { throw new Error('must not launch'); } });
    expect(results).toEqual([expect.objectContaining({ replaced: false })]);
    expect(fs.existsSync(f.file)).toBe(true);
  });
});

// 4.4.1: a receipt whose pid was REUSED by an unrelated process used to be kept forever, so every update
// said "restart Console" until that process exited. The process start time tells them apart.
describe('a reused pid is recognised by process start time', () => {
  it.skipIf(process.platform === 'win32')('processStartMs reads this process\'s real start time', () => {
    const started = processStartMs(process.pid);
    expect(Number.isFinite(started)).toBe(true);
    expect(started).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(Date.now() - started).toBeLessThan(24 * 3_600_000);
  });

  it.skipIf(process.platform === 'win32')('drops a receipt whose live pid started AFTER the receipt was written; keeps the same busy Console', () => {
    const reused = receiptFixture({ startedAt: '2020-01-01T00:00:00.000Z' }); // this pid's process did not exist then
    const { live, pruned } = readConsoleReceipts(reused.receiptDir, { probe: () => null });
    expect(live).toEqual([]);
    expect(pruned).toEqual([expect.objectContaining({ pid: process.pid, reason: 'pid reused by a process started after the receipt' })]);
    expect(fs.existsSync(reused.file)).toBe(false);
    // The receipt's own process (started before it wrote startedAt), busy and silent: never dropped.
    const busy = receiptFixture({ startedAt: new Date().toISOString() });
    expect(readConsoleReceipts(busy.receiptDir, { probe: () => null }).live).toHaveLength(1);
    expect(fs.existsSync(busy.file)).toBe(true);
    // An unreadable start time is not proof of reuse.
    const unknown = receiptFixture({ startedAt: '2020-01-01T00:00:00.000Z' });
    expect(readConsoleReceipts(unknown.receiptDir, { probe: () => null, startMs: () => null }).live).toHaveLength(1);
  });

  it('on Linux, start time is boot-relative (/proc/<pid>/stat starttime + /proc/stat btime), not ps lstart', () => {
    // comm with spaces and parentheses must not shift the fields; starttime is field 22.
    const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i)), '123456']; // fields 3..22
    const files = { '/proc/4242/stat': `4242 (node (worker) x) ${fields.join(' ')} 0 0\n`, '/proc/stat': 'cpu 1 2 3\nbtime 1790000000\nprocesses 9\n' };
    const readFile = (file) => { if (!(file in files)) throw new Error(`ENOENT ${file}`); return files[file]; };
    const spawn = (cmd) => (cmd === 'getconf' ? { status: 0, stdout: '100\n' } : (() => { throw new Error('ps must not be used on Linux'); })());
    expect(processStartMs(4242, { platform: 'linux', readFile, spawn })).toBe(1790000000 * 1000 + 1_234_560);
  });

  it('pidReused needs the process to start more than 2s after startedAt', () => {
    const at = Date.parse('2026-10-01T06:00:00.000Z');
    const receipt = { pid: 4242, startedAt: new Date(at).toISOString() };
    expect(pidReused(receipt, { startMs: () => at - 5_000 })).toBe(false);
    expect(pidReused(receipt, { startMs: () => at + 2_000 })).toBe(false);
    expect(pidReused(receipt, { startMs: () => at + 2_001 })).toBe(true);
  });
});

describe('consoleEnv — host-session identity is not carried into a long-lived Console', () => {
  it('drops RUVNET_BRAIN_ACTIVE_VERSION, RUVNET_HOOK_HOST, RUVNET_NODE_BIN and CLAUDE* (keeps CLAUDE_CONFIG_DIR)', () => {
    const env = consoleEnv({ HOME: '/h', RUVNET_BRAIN_ACTIVE_VERSION: '0.0.0-session', RUVNET_HOOK_HOST: 'claude', RUVNET_NODE_BIN: '/n',
      CLAUDECODE: '1', CLAUDE_PROJECT_DIR: '/p', CLAUDE_PLUGIN_ROOT: '/r', CLAUDE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CONFIG_DIR: '/cfg', ANTHROPIC_API_KEY: 'sk-a' }, 7411);
    expect(env).toEqual({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg', ANTHROPIC_API_KEY: 'sk-a', CONSOLE_PORT: '7411' });
  });
});
