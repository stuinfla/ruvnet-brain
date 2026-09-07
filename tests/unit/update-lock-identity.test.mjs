import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let root, kbDir, updater;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-lock-identity-'));
  kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir);
  for (const file of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs',
    'refresh-run.mjs', 'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs']) {
    fs.copyFileSync(path.resolve(import.meta.dirname, '../../kb', file), path.join(kbDir, file));
  }
  fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({
    stores: [], canonicalManifestUrl: 'http://127.0.0.1:1/not-requested',
  }));
  updater = await import(pathToFileURL(path.join(kbDir, 'forge-update.mjs')).href);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('updater production refresh owner identity', () => {
  it('records the observed process incarnation by default', () => {
    const lock = updater.acquireUpdateLock({ kbDir });
    try {
      expect(lock.owner.pid).toBe(process.pid);
      expect(lock.owner.processStart).toBeTruthy();
      expect(lock.owner.processStart).not.toMatch(/^injected:/);
      expect(lock.owner.executable).toBeTruthy();
      expect(() => updater.acquireUpdateLock({ kbDir })).toThrow(/active/);
    } finally { updater.releaseUpdateLock(lock); }
  });

  it('does not mistake a reused PID for the previous owner incarnation', () => {
    const previous = updater.acquireUpdateLock({ kbDir });
    const ownerPath = path.join(previous.path, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    owner.processStart = 'prior process incarnation';
    fs.writeFileSync(ownerPath, JSON.stringify(owner));
    const next = updater.acquireUpdateLock({ kbDir });
    try {
      expect(next.token).not.toBe(previous.token);
      expect(next.owner.processStart).not.toBe(owner.processStart);
      const receipt = JSON.parse(fs.readFileSync(previous.owner.receiptPath, 'utf8'));
      expect(receipt.status).toBe('ABANDONED');
      expect(receipt.detail.reason).toBe('exact-dead-owner');
    } finally { updater.releaseUpdateLock(next); }
  });

  it('keeps the liveness seam only for explicitly injected callers', () => {
    const lock = updater.acquireUpdateLock({ kbDir, pid: 123456, isAlive: () => false });
    try { expect(lock.owner.processStart).toBe('injected:123456'); }
    finally { updater.releaseUpdateLock(lock); }
  });
});
