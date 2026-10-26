/**
 * The Stable Spine lock (plugin/scripts/update-apply.mjs) judges its owner by process identity, and a busy
 * lock is NOT a success.
 *
 * Before 4.7.21 (audit C-opus, reproduced): the owner was checked by pid only, so any unrelated live process
 * that reused the pid held the spine forever; and a held lock exited 0 ("another update is in progress"), so
 * host convergence read "nothing applied" as "applied". Now: the owner records its process start time, a live
 * pid whose start time differs is a reused pid (reclaimed), a genuinely live owner exits 75 (busy), and an
 * owner.json that is still being published (empty, young) is respected rather than deleted.
 *
 * Every case runs the real engine as a subprocess against a temp RUVNET_BRAIN_HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'scripts', 'update-apply.mjs');
const posix = process.platform !== 'win32';
const PAYLOAD_VERSION = ['9', '9', '1-test'].join('.'); // a synthetic payload version, never the product's
let HOME_DIR;
let holder;
const payloads = [];

function makePayload(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spine-lock-payload-${version}-`));
  payloads.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'ok.mjs'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ruvnet-brain', version }));
  return dir;
}
const run = (...args) => spawnSync(process.execPath, [ENGINE, ...args], {
  encoding: 'utf8', env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: '' }, timeout: 60_000,
});
const active = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'active.json'), 'utf8')); } catch { return null; } };
const lstart = (pid) => spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
  encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C' } }).stdout.trim();
const plantOwner = (owner, { ageMs = 0 } = {}) => {
  const lock = path.join(HOME_DIR, '.update.lock');
  fs.mkdirSync(lock, { recursive: true });
  const file = path.join(lock, 'owner.json');
  fs.writeFileSync(file, typeof owner === 'string' ? owner : JSON.stringify(owner));
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); fs.utimesSync(lock, t, t); }
};

beforeEach(() => {
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-lock-home-'));
  // A real, unrelated live process: its pid is what a reused pid looks like.
  holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
});
afterEach(() => {
  try { holder.kill('SIGKILL'); } catch { /* gone */ }
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  payloads.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe.skipIf(!posix)('update-apply lock: process identity, not pid alone', () => {
  it('a live pid whose start time differs from the recorded one is a reused pid: reclaimed, the apply proceeds', () => {
    plantOwner({ pid: holder.pid, host: os.hostname(), processStart: 'Thu Jan  1 00:00:00 1970', startedAt: new Date().toISOString() });
    const r = run('--from-dir', makePayload(PAYLOAD_VERSION));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(active()?.version).toBe(PAYLOAD_VERSION); // before: exit 0 but nothing applied (pid alive -> "in progress")
  });

  it('a legacy owner (no start time) written BEFORE that live pid started is a reused pid: reclaimed', () => {
    plantOwner({ pid: holder.pid, host: os.hostname(), startedAt: new Date(Date.now() - 86_400_000).toISOString() });
    const r = run('--from-dir', makePayload(PAYLOAD_VERSION));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(active()?.version).toBe(PAYLOAD_VERSION);
  });

  it('a genuinely live owner (matching start time) exits 75 busy and applies nothing', () => {
    const started = lstart(holder.pid);
    expect(started).toMatch(/\d{4}$/);
    plantOwner({ pid: holder.pid, host: os.hostname(), processStart: started, startedAt: new Date().toISOString() });
    const r = run('--from-dir', makePayload(PAYLOAD_VERSION));
    expect(r.status).toBe(75); // before: 0, which host convergence counted as "applied"
    expect(r.stdout + r.stderr).toMatch(/another update is in progress/);
    expect(active()).toBe(null);
    expect(fs.existsSync(path.join(HOME_DIR, '.update.lock', 'owner.json'))).toBe(true); // the live owner keeps its lock
  });

  it('an owner.json still being published (empty, seconds old) is respected: busy, not deleted', () => {
    plantOwner('');
    const r = run('--from-dir', makePayload(PAYLOAD_VERSION));
    expect(r.status).toBe(75); // before: the lock was deleted and the apply raced a live writer
    expect(active()).toBe(null);
  });

  it('an empty owner.json older than the publication grace is debris: reclaimed', () => {
    plantOwner('', { ageMs: 5 * 60_000 });
    const r = run('--from-dir', makePayload(PAYLOAD_VERSION));
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(active()?.version).toBe(PAYLOAD_VERSION);
  });

  it('the owner a run writes records its own process start time', () => {
    // A slow gate keeps the lock held long enough to read it: --from-dir on a payload with many scripts.
    const payload = makePayload('9.9.2-test');
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(payload, 'scripts', `s${i}.mjs`), 'export {};\n');
    const child = spawn(process.execPath, [ENGINE, '--from-dir', payload], {
      env: { ...process.env, RUVNET_BRAIN_HOME: HOME_DIR, CLAUDE_PLUGIN_ROOT: '' }, stdio: 'ignore' });
    const ownerFile = path.join(HOME_DIR, '.update.lock', 'owner.json');
    let owner = null;
    const deadline = Date.now() + 20_000;
    while (!owner && Date.now() < deadline) {
      try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { spawnSync('sleep', ['0.02']); }
    }
    expect(owner, 'never observed the held lock').not.toBe(null);
    expect(owner.pid).toBe(child.pid);
    expect(owner.processStart).toBe(lstart(child.pid));
    return new Promise((resolve) => child.on('exit', resolve));
  }, 30_000);
});
