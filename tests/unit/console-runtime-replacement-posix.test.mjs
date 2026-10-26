// Split from tests/unit/console-runtime-transaction.test.mjs (4.7.21 review round 2): this one case starts a real
// orphaned Console through /bin/sh and stops it with SIGTERM, so it is POSIX-only. It lives in its own file, listed in
// scripts/release-qualification-contract.mjs for linux and macos only, so the remaining transaction cases stay in the
// Windows gate (which allows no skipped case) instead of the whole file leaving it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONSOLE_RUNTIME_SURFACE, consoleRuntimeDigest } from '../../scripts/console-runtime-identity.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');
const temps = [];
let install;
let isolatedHome;
const priorEnv = {};

function temporary(prefix) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(value);
  return value;
}

// The candidate is built from the shipped surface, not a list of this fixture's own (see the transaction test).
function candidate(marker) {
  const root = temporary('brain-console-candidate-');
  for (const relative of CONSOLE_RUNTIME_SURFACE) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(ROOT, relative), target, { recursive: true });
  }
  fs.appendFileSync(path.join(root, 'scripts', 'onboarding-console.mjs'), `\n// ${marker}\n`);
  return root;
}

beforeAll(async () => {
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'console-runtime-host-home-'));
  const isolated = { HOME: isolatedHome, USERPROFILE: isolatedHome,
    CODEX_HOME: path.join(isolatedHome, '.codex'), RUVNET_BRAIN_HOME: path.join(isolatedHome, '.cache/ruvnet-brain'),
    RUVNET_BRAIN_IMPORT_ONLY: '1' };
  for (const [key, value] of Object.entries(isolated)) { priorEnv[key] = process.env[key]; process.env[key] = value; }
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  install = await import(`${pathToFileURL(INSTALLER).href}?replacement=${Date.now()}`);
});

afterAll(() => {
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (isolatedHome) fs.rmSync(isolatedHome, { recursive: true, force: true });
});
afterEach(() => {
  for (const value of temps.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('Console instances — owned stale replacement (POSIX)', () => {
  const freePort = async () => {
    const net = await import('node:net');
    return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  };

  it('--update replaces a running owned stale Console itself; convergence is healthy', async () => {
    const cache = temporary('brain-console-cache-');
    const brainHome = path.join(isolatedHome, '.cache', 'ruvnet-brain');
    const receiptDir = path.join(brainHome, 'console-instances');
    const scope = temporary('brain-console-scope-');
    install.installConsoleRuntime(cache, candidate('GENERATION-A'));
    const port = await freePort();
    // Started ORPHANED, like a real user's Console: not a child of this test process. (As our own
    // child, its exit would leave a zombie that kill(pid, 0) still sees until this process reaps it.)
    const entry = path.join(cache, '.console-runtime', 'scripts', 'onboarding-console.mjs');
    spawnSync('/bin/sh', ['-c', '(cd "$1" && exec "$2" "$3" --serve </dev/null >/dev/null 2>&1) &', 'sh', scope, process.execPath, entry],
      { stdio: 'ignore', env: { ...process.env, CONSOLE_PORT: String(port), RUVNET_CONSOLE_DISABLE_BACKGROUND_REFRESH: '1' } });
    const started = [];
    const old = { pid: null };
    try {
      const deadline = Date.now() + 30_000;
      let receipt = null;
      while (Date.now() < deadline) {
        const names = fs.existsSync(receiptDir) ? fs.readdirSync(receiptDir).filter((n) => n.endsWith('.json')) : [];
        receipt = names.map((n) => JSON.parse(fs.readFileSync(path.join(receiptDir, n), 'utf8'))).find((r) => r.port === port);
        if (receipt) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(receipt, 'the generation-A Console never wrote its receipt').toBeTruthy();
      old.pid = receipt.pid;
      const generationB = candidate('GENERATION-B');
      const result = install.syncHostsAfterUpdate(cache, {
        sourceRoot: generationB, brainHome, consoleReceiptDir: receiptDir,
        hostLockPath: path.join(temporary('brain-console-lock-'), 'host.lock'),
        wireClaude: () => ({ host: false, wired: false }),
        wireCodexHost: () => ({ host: false, action: 'no-host' }),
        runStableSpine: () => ({ status: 0 }),
      });
      for (const item of result.results.consoleReplacement || []) if (item.newPid) started.push(item.newPid);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.results.consoleReplacement).toEqual([expect.objectContaining({ replaced: true, port, pid: old.pid })]);
      expect(result.convergence).toEqual({ healthy: true, state: 'channels-converged' });
      expect(() => process.kill(old.pid, 0)).toThrow(); // the generation-A Console is gone
      const live = JSON.parse(spawnSync(process.execPath, ['-e',
        `require('node:http').get('http://127.0.0.1:${port}/api/runtime',(s)=>{let b='';s.on('data',(c)=>b+=c);s.on('end',()=>process.stdout.write(b));})`],
      { encoding: 'utf8', timeout: 5000 }).stdout);
      expect(live.sourceSha256).toBe(consoleRuntimeDigest(generationB));
      expect(live.pid).toBe(started[0]);
    } finally {
      for (const pid of [old.pid, ...started]) { try { if (pid) process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      fs.rmSync(receiptDir, { recursive: true, force: true });
    }
  }, 90_000);
});
