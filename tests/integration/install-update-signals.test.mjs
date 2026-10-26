/**
 * A SIGTERM'd `install.mjs --update` settles its refresh run and releases the lock (4.7.21).
 *
 * The SessionStart self-heal runs `--update` under a TTL and kills the whole process group when it expires
 * (detach.mjs). Node's default SIGTERM ends the process with no 'exit' event, so the refresh receipt stayed
 * RUNNING and `.kb.refresh-run.lock` stayed on disk until a later run could prove the owner dead — and before the
 * refresh-lock fix in the same release, a hostname change made that proof impossible forever (audit C).
 *
 * The real installer runs in a throwaway HOME against a temp brain whose manifest URL points at a local server
 * that accepts the request and never answers, so the real updater is blocked mid-run exactly like a slow
 * download. The test then kills the process group, as detach.mjs does. Nothing touches the network or the real
 * HOME (RUVNET_BRAIN_TEST=1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const temps = [];
afterAll(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe.skipIf(process.platform === 'win32')('install.mjs --update under SIGTERM', () => {
  it('records the run FAILED with the signal, releases the refresh lock, and exits 143 promptly', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-signal-')));
    temps.push(root);
    const home = path.join(root, 'home');
    const brainHome = path.join(root, 'brain');
    const kb = path.join(brainHome, 'kb');
    const tmpdir = path.join(root, 'tmp'); // the installer's own temp dirs land here, so leaks are countable
    fs.mkdirSync(home);
    fs.mkdirSync(tmpdir);
    fs.mkdirSync(kb, { recursive: true });

    const pending = [];
    let requested;
    const asked = new Promise((resolve) => { requested = resolve; });
    const server = http.createServer((req, res) => { pending.push(res); requested(req.url); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// replaced by the installer preflight\n');
    fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ canonicalManifestUrl: `http://127.0.0.1:${port}/manifest.json`, stores: [] }));

    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--update', '--no-nightly-prompt'], {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir, RUVNET_BRAIN_TEST: '1',
        RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: kb, RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1' },
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      const winner = await Promise.race([asked, exited.then(() => 'exited'),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 90_000))]);
      expect(winner, output).toBe('/manifest.json'); // the real updater is now blocked mid-run
      // The installer made its result dir before starting the updater; it must not outlive the interrupted run.
      expect(fs.readdirSync(tmpdir).filter((name) => name.startsWith('ruvnet-update-result-'))).toHaveLength(1);
      const lockPath = path.join(brainHome, '.kb.refresh-run.lock');
      expect(fs.existsSync(lockPath)).toBe(true);

      const killedAt = Date.now();
      process.kill(-child.pid, 'SIGTERM'); // the whole group, as detach.mjs does at its TTL
      const { code, signal } = await exited;
      const settleMs = Date.now() - killedAt;

      expect({ code, signal }, output).toEqual({ code: 143, signal: null }); // before: { code: null, signal: 'SIGTERM' }
      expect(settleMs).toBeLessThan(2000);
      expect(fs.existsSync(lockPath)).toBe(false); // before: the lock stayed
      // Fable review #6: settleIfSignalled exited before the result dir was removed, leaking one per interrupted run.
      expect(fs.readdirSync(tmpdir).filter((name) => name.startsWith('ruvnet-update-result-'))).toEqual([]);
      const runs = fs.readdirSync(path.join(brainHome, 'refresh-runs')).filter((name) => name.endsWith('.json'));
      expect(runs).toHaveLength(1);
      const receipt = JSON.parse(fs.readFileSync(path.join(brainHome, 'refresh-runs', runs[0]), 'utf8'));
      expect(receipt).toMatchObject({ status: 'FAILED', terminalVerdict: 'failed', // before: status RUNNING
        detail: { reason: 'signal', signal: 'SIGTERM' } });
    } finally {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      pending.forEach((res) => res.destroy());
      server.close();
    }
  }, 150_000);
});
