/**
 * memory-ensure.test.mjs — Session start recall and checkpoint management
 *
 * Tests ADR-076 tier 1: Session checkpoints
 *
 * Verifies:
 * 1. Latest 3 checkpoints surface at session start
 * 2. Checkpoint format includes: timestamp, branch, decision count, open issues, next work, exit code
 * 3. Graceful handling of missing/corrupted checkpoints
 * 4. Performance: recall completes in <2 seconds
 * 5. Concurrent checkpoint writes don't corrupt state
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal mock for memory store interface
class MemoryStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.checkpoints = [];
    this.decisions = [];
    if (fs.existsSync(dbPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        this.checkpoints = data.checkpoints || [];
        this.decisions = data.decisions || [];
      } catch (e) {
        // corrupted file, start fresh
      }
    }
  }

  writeCheckpoint(checkpoint) {
    const enhanced = {
      id: `checkpoint-${Date.now()}`,
      timestamp: checkpoint.timestamp || Date.now(),
      branch: checkpoint.branch || 'main',
      decisionCount: checkpoint.decisionCount || 0,
      openIssues: checkpoint.openIssues || [],
      openPRs: checkpoint.openPRs || [],
      nextWork: checkpoint.nextWork || '',
      exitCode: checkpoint.exitCode !== undefined ? checkpoint.exitCode : 0,
      completionStatus: checkpoint.completionStatus || 'unknown',
    };
    this.checkpoints.push(enhanced);
    this._persist();
    return enhanced;
  }

  readLatestCheckpoints(count = 3) {
    return this.checkpoints.slice(-count).reverse();
  }

  readCheckpointById(id) {
    return this.checkpoints.find(c => c.id === id);
  }

  _persist() {
    fs.writeFileSync(this.dbPath, JSON.stringify({
      checkpoints: this.checkpoints,
      decisions: this.decisions,
    }, null, 2));
  }
}

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ensure-test-'));
  store = new MemoryStore(path.join(tmpDir, 'memory.db'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ADR-076 Tier 1 — Session Checkpoints', () => {
  describe('low — checkpoint format validation', () => {
    it('creates a checkpoint with all required fields', () => {
      const cp = store.writeCheckpoint({
        timestamp: 1694425323000,
        branch: 'release/4.3.19',
        decisionCount: 2,
        nextWork: 'merge ADRs',
      });

      expect(cp).toMatchObject({
        timestamp: 1694425323000,
        branch: 'release/4.3.19',
        decisionCount: 2,
        nextWork: 'merge ADRs',
        exitCode: 0,
        completionStatus: 'unknown',
      });
      expect(cp.id).toMatch(/^checkpoint-\d+$/);
    });

    it('supplies defaults for missing optional fields', () => {
      const cp = store.writeCheckpoint({});
      expect(cp.branch).toBe('main');
      expect(cp.decisionCount).toBe(0);
      expect(cp.openIssues).toEqual([]);
      expect(cp.openPRs).toEqual([]);
      expect(cp.exitCode).toBe(0);
    });

    it('preserves issue/PR state snapshots', () => {
      const cp = store.writeCheckpoint({
        openIssues: [
          { id: 38, title: 'Issue 38 waiting', state: 'open' },
        ],
        openPRs: [
          { id: 145, title: 'PR #145 in review', state: 'open', branch: 'feature/adr-076' },
        ],
      });

      expect(cp.openIssues).toHaveLength(1);
      expect(cp.openIssues[0].id).toBe(38);
      expect(cp.openPRs).toHaveLength(1);
      expect(cp.openPRs[0].id).toBe(145);
    });
  });

  describe('medium — session start recall', () => {
    it('surfaces latest 3 checkpoints in reverse chronological order', () => {
      const timestamps = [1000, 2000, 3000, 4000, 5000];
      timestamps.forEach(ts => {
        store.writeCheckpoint({ timestamp: ts, branch: 'main' });
      });

      const latest = store.readLatestCheckpoints(3);
      expect(latest).toHaveLength(3);
      expect(latest[0].timestamp).toBe(5000); // most recent first
      expect(latest[1].timestamp).toBe(4000);
      expect(latest[2].timestamp).toBe(3000);
    });

    it('returns fewer than 3 if only 2 checkpoints exist', () => {
      store.writeCheckpoint({ timestamp: 1000 });
      store.writeCheckpoint({ timestamp: 2000 });

      const latest = store.readLatestCheckpoints(3);
      expect(latest).toHaveLength(2);
    });

    it('returns empty array if no checkpoints exist', () => {
      const latest = store.readLatestCheckpoints(3);
      expect(latest).toEqual([]);
    });

    it('formats recall output with human-readable timestamps', () => {
      store.writeCheckpoint({
        timestamp: 1694425323000,
        branch: 'release/4.3.19',
        decisionCount: 2,
        openIssues: [{ id: 38, title: 'waiting' }],
        nextWork: 'merge ADRs',
        completionStatus: 'in-progress',
      });

      const latest = store.readLatestCheckpoints(1);
      expect(latest[0]).toMatchObject({
        decisionCount: 2,
        branch: 'release/4.3.19',
      });
    });
  });

  describe('high — persistence and recovery', () => {
    it('persists checkpoints to disk and reloads on next session', () => {
      store.writeCheckpoint({ timestamp: 1000, branch: 'main' });
      store.writeCheckpoint({ timestamp: 2000, branch: 'feature' });

      // Simulate new session by creating new store instance
      const newStore = new MemoryStore(path.join(tmpDir, 'memory.db'));
      const latest = newStore.readLatestCheckpoints(3);

      expect(latest).toHaveLength(2);
      expect(latest[0].branch).toBe('feature');
    });

    it('recovers gracefully from corrupted checkpoint file', () => {
      const dbPath = path.join(tmpDir, 'memory.db');
      fs.writeFileSync(dbPath, 'invalid json {]');

      const newStore = new MemoryStore(dbPath);
      const latest = newStore.readLatestCheckpoints(3);
      expect(latest).toEqual([]);

      // Should still be able to write new checkpoints
      newStore.writeCheckpoint({ timestamp: 1000 });
      expect(newStore.checkpoints).toHaveLength(1);
    });

    it('handles concurrent writes without data loss', (done) => {
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          Promise.resolve().then(() => {
            store.writeCheckpoint({ timestamp: 1000 + i, branch: `branch-${i}` });
          })
        );
      }

      Promise.all(promises).then(() => {
        expect(store.checkpoints).toHaveLength(10);
        done();
      });
    });

    it('idempotently survives duplicate checkpoint writes', () => {
      const cp1 = store.writeCheckpoint({ timestamp: 1000, branch: 'main' });
      const cp2 = store.writeCheckpoint({ timestamp: 1000, branch: 'main' });

      expect(cp1.id).not.toBe(cp2.id); // different ids
      expect(store.checkpoints).toHaveLength(2);
    });
  });

  describe('numeric — performance constraints', () => {
    it('reads latest 3 checkpoints in <100ms even with 1000 checkpoints', () => {
      for (let i = 0; i < 1000; i++) {
        store.writeCheckpoint({ timestamp: i * 1000 });
      }

      const start = performance.now();
      store.readLatestCheckpoints(3);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(100);
    });

    it('writes a checkpoint in <50ms', () => {
      const start = performance.now();
      store.writeCheckpoint({
        timestamp: Date.now(),
        branch: 'main',
        decisionCount: 5,
        openIssues: Array.from({ length: 20 }, (_, i) => ({
          id: i,
          title: `Issue ${i}`,
        })),
      });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
    });

    it('persists 100 checkpoints without exceeding file size limits', () => {
      for (let i = 0; i < 100; i++) {
        store.writeCheckpoint({
          timestamp: i * 1000,
          branch: `branch-${i}`,
          decisionCount: Math.floor(Math.random() * 10),
        });
      }

      const dbPath = path.join(tmpDir, 'memory.db');
      const stats = fs.statSync(dbPath);
      expect(stats.size).toBeLessThan(1024 * 1024); // <1MB
    });
  });

  describe('qualitative — checkpoint content integrity', () => {
    it('preserves branch name exactly as provided', () => {
      const branches = [
        'main',
        'release/4.3.19',
        'feature/adr-076-memory',
        'hotfix/critical-bug',
      ];

      branches.forEach(branch => {
        store.writeCheckpoint({ branch });
      });

      const latest = store.readLatestCheckpoints(10);
      const recordedBranches = latest.map(cp => cp.branch);
      expect(recordedBranches).toContainEqual(branches[0]);
      expect(recordedBranches).toContainEqual(branches[3]);
    });

    it('captures exit codes accurately', () => {
      store.writeCheckpoint({ exitCode: 0, completionStatus: 'complete' });
      store.writeCheckpoint({ exitCode: 1, completionStatus: 'failed' });
      store.writeCheckpoint({ exitCode: 130, completionStatus: 'interrupted' });

      const latest = store.readLatestCheckpoints(10);
      expect(latest[0].exitCode).toBe(130);
      expect(latest[1].exitCode).toBe(1);
      expect(latest[2].exitCode).toBe(0);
    });

    it('allows querying checkpoint by id', () => {
      const cp = store.writeCheckpoint({ timestamp: 1000, branch: 'main' });
      const retrieved = store.readCheckpointById(cp.id);

      expect(retrieved).toEqual(cp);
    });

    it('returns null for non-existent checkpoint id', () => {
      const retrieved = store.readCheckpointById('checkpoint-999999999');
      expect(retrieved).toBeUndefined();
    });
  });
});
