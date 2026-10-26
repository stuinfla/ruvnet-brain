/**
 * The refresh lock must heal itself after a crash, and say exactly how to clear it when it cannot.
 *
 * Before 4.7.21 two shapes wedged every later --update and nightly for good (audit C, both readers):
 *   - an unreadable or incomplete owner.json threw "refusing stale takeover" forever, at any age;
 *   - an owner recorded under a different hostname read as "ambiguous" forever. On macOS os.hostname()
 *     follows the network, so a crash on one Wi-Fi and a retry on another is enough.
 * Liveness cannot be proven across hosts, but a refresh run cannot outlive the updater's own deadlines, so
 * a remote owner older than 3 h is dead; an unreadable owner older than 1 h is debris. Younger ones still
 * refuse, now naming the lock path and the removal command.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireRefreshLock, refreshLockPath, releaseRefreshLock } from '../../kb/refresh-run.mjs';

const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-stale-'));
  roots.push(root);
  const kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir);
  return { root, kbDir, lockPath: refreshLockPath(kbDir) };
};
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000);
const owner = (kbDir, { hostname, startedAt, pid = 4242 }) => acquireRefreshLock({ kbDir, pid, processStart: 'Mon Oct 26 03:30:00 2026',
  executable: process.execPath, hostname, now: () => startedAt.toISOString() });
const contender = (kbDir, extra = {}) => acquireRefreshLock({ kbDir, pid: 5151, processStart: 'Mon Oct 26 07:00:00 2026',
  executable: process.execPath, hostname: 'new-host', inspectProcess: () => ({ state: 'dead' }), ...extra });

describe('refresh lock owned under another hostname', () => {
  it('older than 3 h with its pid unprovable here: reclaimed, and the old run is recorded ABANDONED', () => {
    const { root, kbDir } = fixture();
    const old = owner(kbDir, { hostname: 'old-host', startedAt: hoursAgo(4) });
    const lock = contender(kbDir);
    expect(lock).toMatchObject({ owned: true });
    expect(lock.runId).not.toBe(old.runId);
    const abandoned = JSON.parse(fs.readFileSync(path.join(root, 'refresh-runs', `${old.runId}.json`), 'utf8'));
    expect(abandoned).toMatchObject({ status: 'ABANDONED', terminalVerdict: 'abandoned',
      detail: { reason: 'stale-remote-owner', abandonedOwner: { host: 'old-host', pid: 4242 } } });
    expect(releaseRefreshLock(lock)).toBe(true);
  });

  it('younger than 3 h: still refused, and the error names the lock and the exact removal command', () => {
    const { kbDir, lockPath } = fixture();
    owner(kbDir, { hostname: 'old-host', startedAt: hoursAgo(2.5) });
    let message = '';
    try { contender(kbDir); } catch (error) { message = error.message; }
    expect(message).toMatch(/ambiguous/);
    expect(message).toContain(lockPath);
    expect(message).toMatch(/old-host/);
    expect(message).toContain(process.platform === 'win32' ? `Remove-Item -Recurse -Force "${lockPath}"` : `rm -rf "${lockPath}"`);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});

describe('refresh lock whose owner.json is unreadable or incomplete', () => {
  const plant = (lockPath, content, ageHours) => {
    fs.mkdirSync(lockPath);
    if (content !== null) fs.writeFileSync(path.join(lockPath, 'owner.json'), content);
    const t = hoursAgo(ageHours);
    if (content !== null) fs.utimesSync(path.join(lockPath, 'owner.json'), t, t);
    fs.utimesSync(lockPath, t, t);
  };

  it.each([
    ['an empty owner.json', ''],
    ['a truncated owner.json', '{"schemaVersion":3,"runId":"17'],
    ['an owner.json missing its identity fields', '{}'],
    ['no owner.json at all', null],
  ])('%s older than 1 h is reclaimed', (_label, content) => {
    const { kbDir, lockPath } = fixture();
    plant(lockPath, content, 1.5);
    const lock = contender(kbDir);
    expect(lock).toMatchObject({ owned: true });
    expect(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token).toBe(lock.token);
    expect(releaseRefreshLock(lock)).toBe(true);
  });

  it('a fresh unreadable owner is still refused, naming the path and the removal command', () => {
    const { kbDir, lockPath } = fixture();
    plant(lockPath, '', 0.2);
    let message = '';
    try { contender(kbDir); } catch (error) { message = error.message; }
    expect(message).toMatch(/incomplete or unreadable/);
    expect(message).toContain(lockPath);
    expect(message).toContain(process.platform === 'win32' ? `Remove-Item -Recurse -Force "${lockPath}"` : `rm -rf "${lockPath}"`);
    expect(fs.existsSync(lockPath)).toBe(true);
  });
});
