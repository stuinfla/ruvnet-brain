// host-cli.test.mjs — 2026-09-30, owner's Mac: Claude Code self-updated during `--update`,
// ~/.npm-global/bin/claude was briefly absent, and the installer printed raw "No such file or
// directory" errors. A CLI that was here and vanished is retried (bounded backoff) and, if it never
// returns, reported as ONE line; a CLI that was never installed still fails at once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHostCli, waitForHostCli, resetSeenHostClis, HOST_CLI_RETRY_DELAYS_MS } from '../../scripts/host-cli.mjs';

const posix = process.platform !== 'win32';
let dir; let bin;
beforeEach(() => {
  resetSeenHostClis();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-cli-'));
  bin = path.join(dir, 'fakeclaude');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const install = (body = 'echo ran "$@"; exit 0') => fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const env = () => ({ ...process.env, PATH: `${dir}:${process.env.PATH}` });
const resolve = () => (fs.existsSync(bin) ? bin : null);
const sleeps = [];
const recordSleep = (onSleep = () => {}) => (ms) => { sleeps.push(ms); onSleep(sleeps.length); };
beforeEach(() => { sleeps.length = 0; });

describe.skipIf(!posix)('runHostCli — a host CLI that vanishes mid self-update', () => {
  it('a CLI seen earlier that vanishes is retried and succeeds when it returns; no raw error reaches the user', () => {
    install();
    const echoed = [];
    expect(runHostCli('fakeclaude', ['--v'], { env: env(), resolve, stdio: 'pipe' }).status).toBe(0); // seen
    fs.rmSync(bin);
    const r = runHostCli('fakeclaude', ['plugin', 'update'], { env: env(), resolve, onPath: () => false,
      sleep: recordSleep(() => install()), echoStderr: (t) => echoed.push(t) });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
    expect(r.missingBinary).toBeUndefined();
    expect(sleeps).toEqual([HOST_CLI_RETRY_DELAYS_MS[0]]);
    expect(echoed.join('')).not.toMatch(/No such file|not found|ENOENT/);
  });

  it('bounded: 3 tries over ~20s, then ONE clear line', () => {
    install();
    runHostCli('fakeclaude', [], { env: env(), resolve, stdio: 'pipe' }); // seen
    fs.rmSync(bin);
    const echoed = [];
    const r = runHostCli('fakeclaude', ['plugin', 'install', 'x'], { env: env(), resolve, onPath: () => false,
      sleep: recordSleep(), echoStderr: (t) => echoed.push(t) });
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([5_000, 15_000]);
    expect(r.missingBinary).toBe(true);
    expect(r.message).toBe('the `fakeclaude` command was not available (tried 3 times over 20s — it may be updating itself); skipped `fakeclaude plugin install x`');
    expect(echoed).toEqual([]);
  });

  it('a CLI that was never installed fails at once — no 20s wait for VS Code / desktop-app users', () => {
    const r = runHostCli('fakeclaude', ['x'], { env: env(), resolve, onPath: () => false, sleep: recordSleep() });
    expect(r.attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(r.error?.code).toBe('ENOENT');
  });

  it('a PATH link that points at nothing counts as mid-update even if never seen', () => {
    const r = runHostCli('fakeclaude', ['x'], { env: env(), resolve, onPath: () => true, sleep: recordSleep() });
    expect(r.attempts).toBe(3);
    expect(sleeps).toEqual([5_000, 15_000]);
    expect(r.missingBinary).toBe(true);
  });

  it('a CLI that RAN and failed is not retried, and its own stderr is passed through', () => {
    install('echo "real failure: marketplace not found" >&2; exit 1');
    const echoed = [];
    const r = runHostCli('fakeclaude', ['x'], { env: env(), resolve, sleep: recordSleep(), echoStderr: (t) => echoed.push(t) });
    expect(r.status).toBe(1);
    expect(r.attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(echoed.join('')).toContain('real failure: marketplace not found');
  });

  it('a wrapper that exits 127 because its target vanished is retried', () => {
    install();
    runHostCli('fakeclaude', [], { env: env(), resolve, stdio: 'pipe' }); // seen
    install('echo "/Users/x/.npm-global/bin/claude: No such file or directory" >&2; exit 127');
    let targetGone = true; // the wrapper's real target is gone until the self-update lands
    const r = runHostCli('fakeclaude', ['x'], { env: env(), resolve: () => (targetGone ? null : bin),
      sleep: recordSleep(() => { install(); targetGone = false; }), echoStderr: () => {} });
    expect(r.status).toBe(0);
    expect(r.attempts).toBe(2);
  });

  it('a CLI that resolves and itself exits 127 ran — no retry, its own error is shown', () => {
    install();
    runHostCli('fakeclaude', [], { env: env(), resolve, stdio: 'pipe' }); // seen: a missing attempt WOULD be retried
    install('echo "plugin helper: command not found" >&2; exit 127');
    const echoed = [];
    const r = runHostCli('fakeclaude', ['x'], { env: env(), resolve, sleep: recordSleep(), echoStderr: (t) => echoed.push(t) });
    expect(r.status).toBe(127);
    expect(r.attempts).toBe(1);
    expect(r.missingBinary).toBeUndefined();
    expect(sleeps).toEqual([]);
    expect(echoed.join('')).toContain('plugin helper: command not found');
  });

  it('a permanently dangling link costs ONE bounded wait per process, not one per call', () => {
    const first = runHostCli('fakeclaude', ['a'], { env: env(), resolve, onPath: () => true, sleep: recordSleep() });
    expect(first).toMatchObject({ attempts: 3, missingBinary: true });
    expect(sleeps).toEqual([5_000, 15_000]);
    for (const arg of ['b', 'c']) {
      const later = runHostCli('fakeclaude', [arg], { env: env(), resolve, onPath: () => true, sleep: recordSleep() });
      expect(later).toMatchObject({ attempts: 1, missingBinary: true });
      expect(later.message).toMatch(/still not available/);
    }
    expect(sleeps).toEqual([5_000, 15_000]); // no further waiting
    expect(waitForHostCli('fakeclaude', { resolve, onPath: () => true, sleep: recordSleep() })).toMatchObject({ present: false, waited: false });
    expect(sleeps).toEqual([5_000, 15_000]);
    install(); // it came back: the next call runs normally
    expect(runHostCli('fakeclaude', ['d'], { env: env(), resolve, stdio: 'pipe', sleep: recordSleep() })).toMatchObject({ status: 0, attempts: 1 });
  });
});

describe('waitForHostCli — the installer\'s presence check', () => {
  it('waits for a dangling link to come back, and does not wait for a CLI that is not installed', () => {
    let calls = 0;
    expect(waitForHostCli('claude', { resolve: () => (++calls > 1 ? '/x/claude' : null), onPath: () => true, sleep: recordSleep() }))
      .toEqual({ present: true, waited: true });
    expect(sleeps).toEqual([5_000]);
    sleeps.length = 0;
    expect(waitForHostCli('claude', { resolve: () => null, onPath: () => false, sleep: recordSleep() }))
      .toEqual({ present: false, waited: false });
    expect(sleeps).toEqual([]);
    const gone = waitForHostCli('claude', { resolve: () => null, onPath: () => true, sleep: recordSleep() });
    expect(gone.present).toBe(false);
    expect(gone.message).toMatch(/points at nothing \(checked for 20s/);
  });
});
