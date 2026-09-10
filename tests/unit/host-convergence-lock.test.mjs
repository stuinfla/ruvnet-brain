import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots = [];
let acquireHostConvergenceLock;

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
  ({ acquireHostConvergenceLock } = await import('../../bin/install.mjs'));
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('host-convergence.lock publication and ownership', () => {
  it('creates a missing parent and publishes owner metadata atomically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-lock-'));
    roots.push(root);
    const lockPath = path.join(root, 'nested', 'brain', 'host-convergence.lock');
    const lock = acquireHostConvergenceLock(lockPath);
    expect(lock.acquired).toBe(true);
    const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    expect(owner).toMatchObject({ pid: process.pid, host: os.hostname() });
    expect(owner.token).toMatch(/^[a-f0-9]{32}$/);
    expect(lock.release()).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not reclaim an incomplete lock during the publication window', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-lock-'));
    roots.push(root);
    const lockPath = path.join(root, 'host-convergence.lock');
    fs.mkdirSync(lockPath);
    const contender = acquireHostConvergenceLock(lockPath, { staleMs: Number.MAX_SAFE_INTEGER });
    expect(contender.acquired).toBe(false);
    expect(contender.error).toMatch(/publishing its lock/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('reclaims an owner whose process is dead', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-lock-'));
    roots.push(root);
    const lockPath = path.join(root, 'host-convergence.lock');
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 99999999, host: os.hostname() }));
    const lock = acquireHostConvergenceLock(lockPath, { processAlive: () => false });
    expect(lock.acquired).toBe(true);
    expect(lock.release()).toBe(true);
  });

  it('refuses to release a lock after ownership changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-lock-'));
    roots.push(root);
    const lockPath = path.join(root, 'host-convergence.lock');
    const lock = acquireHostConvergenceLock(lockPath);
    expect(lock.acquired).toBe(true);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'replacement' }));
    expect(lock.release()).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('allows only one live owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-lock-'));
    roots.push(root);
    const lockPath = path.join(root, 'host-convergence.lock');
    const first = acquireHostConvergenceLock(lockPath);
    const second = acquireHostConvergenceLock(lockPath);
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.error).toMatch(/is running/);
    first.release();
  });
});
