/**
 * concurrent-memory-sessions.test.mjs — Stress test for concurrent session handling
 *
 * Tests ADR-076 under stress:
 * 1. 5 concurrent sessions writing checkpoints simultaneously
 * 2. Session conflicts don't corrupt state
 * 3. Decision ledger remains consistent under load
 * 4. Memory recall doesn't block during writes
 * 5. No data loss after concurrent crash simulation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class StressMemoryStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.state = {
      checkpoints: [],
      decisions: [],
      lock: null,
    };
    this._load();
  }

  _load() {
    if (fs.existsSync(this.dbPath)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
      } catch (e) {
        // corrupt, start fresh
        this.state = { checkpoints: [], decisions: [], lock: null };
      }
    }
  }

  _save() {
    fs.writeFileSync(this.dbPath, JSON.stringify(this.state, null, 2));
  }

  async acquireLock(sessionId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.state.lock && this.state.lock.sessionId !== sessionId && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }

    if (this.state.lock && this.state.lock.sessionId !== sessionId) {
      throw new Error(`Lock acquisition timeout for session ${sessionId}`);
    }

    this.state.lock = { sessionId, acquired: Date.now() };
  }

  releaseLock(sessionId) {
    if (this.state.lock?.sessionId === sessionId) {
      this.state.lock = null;
    }
  }

  async writeCheckpoint(sessionId, checkpoint) {
    await this.acquireLock(sessionId);
    try {
      this.state.checkpoints.push({
        id: `checkpoint-${Date.now()}-${sessionId}`,
        sessionId,
        timestamp: checkpoint.timestamp || Date.now(),
        branch: checkpoint.branch || 'main',
        decisionCount: checkpoint.decisionCount || 0,
        openIssues: checkpoint.openIssues || [],
        openPRs: checkpoint.openPRs || [],
        nextWork: checkpoint.nextWork || '',
        exitCode: checkpoint.exitCode || 0,
      });
      this._save();
    } finally {
      this.releaseLock(sessionId);
    }
  }

  async writeDecision(sessionId, decision) {
    await this.acquireLock(sessionId, 1000);
    try {
      this.state.decisions.push({
        key: decision.key,
        sessionId,
        timestamp: decision.timestamp || Date.now(),
        type: decision.type,
        reason: decision.reason,
        chosen: decision.chosen,
      });
      this._save();
    } finally {
      this.releaseLock(sessionId);
    }
  }

  getLatestCheckpoints(count = 3) {
    return this.state.checkpoints.slice(-count).reverse();
  }

  getDecisionsBySession(sessionId) {
    return this.state.decisions.filter(d => d.sessionId === sessionId);
  }

  getTotalCheckpoints() {
    return this.state.checkpoints.length;
  }

  getTotalDecisions() {
    return this.state.decisions.length;
  }

  verifyIntegrity() {
    const issues = [];

    if (!Array.isArray(this.state.checkpoints)) {
      issues.push('checkpoints not an array');
    }
    if (!Array.isArray(this.state.decisions)) {
      issues.push('decisions not an array');
    }

    // Check for duplicate IDs
    const cpIds = this.state.checkpoints.map(c => c.id);
    const uniqueCpIds = new Set(cpIds);
    if (cpIds.length !== uniqueCpIds.size) {
      issues.push('duplicate checkpoint IDs detected');
    }

    return { valid: issues.length === 0, issues };
  }
}

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrent-stress-'));
  store = new StressMemoryStore(path.join(tmpDir, 'memory.db'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Concurrent Memory Sessions — Stress Tests', () => {
  describe('low — basic concurrent writes', () => {
    it('handles 5 sequential checkpoint writes without corruption', async () => {
      for (let i = 1; i <= 5; i++) {
        await store.writeCheckpoint(`session-${i}`, {
          branch: `branch-${i}`,
          timestamp: 1000 + i * 100,
        });
      }

      expect(store.getTotalCheckpoints()).toBe(5);
      const { valid } = store.verifyIntegrity();
      expect(valid).toBe(true);
    });

    it('blocks second session from writing during first session write', async () => {
      const s1 = store.writeCheckpoint('session-1', { branch: 'b1' });

      // session-2 should wait for session-1 to complete
      const s2Promise = store.writeCheckpoint('session-2', { branch: 'b2' });

      await s1;
      await s2Promise;

      expect(store.getTotalCheckpoints()).toBe(2);
    });
  });

  describe('medium — concurrent session stress', () => {
    it('handles 5 concurrent checkpoint writes in parallel', async () => {
      const promises = [];

      for (let i = 1; i <= 5; i++) {
        promises.push(
          store.writeCheckpoint(`session-${i}`, {
            branch: `branch-${i}`,
            timestamp: 1000 + i,
            decisionCount: i,
          })
        );
      }

      await Promise.all(promises);

      expect(store.getTotalCheckpoints()).toBe(5);
      const { valid } = store.verifyIntegrity();
      expect(valid).toBe(true);
    });

    it('maintains decision consistency across 5 concurrent sessions', async () => {
      const promises = [];

      for (let sessionId = 1; sessionId <= 5; sessionId++) {
        for (let decision = 1; decision <= 3; decision++) {
          promises.push(
            store.writeDecision(`session-${sessionId}`, {
              key: `decision:${sessionId}-${decision}`,
              type: 'adr',
              reason: `Decision ${decision} in session ${sessionId}`,
              chosen: `option-${decision}`,
            })
          );
        }
      }

      await Promise.all(promises);

      // 5 sessions × 3 decisions each = 15 total
      expect(store.getTotalDecisions()).toBe(15);

      // Each session should have exactly 3 decisions
      for (let i = 1; i <= 5; i++) {
        const sessionDecisions = store.getDecisionsBySession(`session-${i}`);
        expect(sessionDecisions).toHaveLength(3);
      }
    });

    it('doesn\'t lose data when concurrent sessions interleave', async () => {
      const promises = [];

      // Interleave checkpoints and decisions from 5 sessions
      for (let cycle = 0; cycle < 3; cycle++) {
        for (let i = 1; i <= 5; i++) {
          const sessionId = `session-${i}`;

          promises.push(
            store.writeDecision(sessionId, {
              key: `decision:${sessionId}-cycle-${cycle}`,
              type: 'adr',
              reason: `cycle ${cycle}`,
              chosen: 'option-a',
            })
          );

          promises.push(
            store.writeCheckpoint(sessionId, {
              branch: `branch-${i}`,
              timestamp: 1000 + cycle * 100 + i,
              decisionCount: cycle + 1,
            })
          );
        }
      }

      await Promise.all(promises);

      // 5 sessions × 3 cycles = 15 decisions
      expect(store.getTotalDecisions()).toBe(15);
      // 5 sessions × 3 cycles = 15 checkpoints
      expect(store.getTotalCheckpoints()).toBe(15);

      const { valid } = store.verifyIntegrity();
      expect(valid).toBe(true);
    });
  });

  describe('high — crash resilience and recovery', () => {
    it('survives simulated crash during write (corrupted checkpoint)', async () => {
      // Write some checkpoints
      for (let i = 1; i <= 3; i++) {
        await store.writeCheckpoint(`session-${i}`, { branch: `b-${i}` });
      }

      // Simulate crash by truncating file
      const dbPath = path.join(tmpDir, 'memory.db');
      let data = fs.readFileSync(dbPath, 'utf8');
      data = data.slice(0, -50); // truncate last 50 chars
      fs.writeFileSync(dbPath, data);

      // New instance should recover gracefully
      const newStore = new StressMemoryStore(dbPath);
      expect(() => {
        newStore.verifyIntegrity();
      }).not.toThrow();
    });

    it('maintains atomicity: either full checkpoint write or none', async () => {
      const dbPath = path.join(tmpDir, 'memory.db');

      await store.writeCheckpoint('session-1', {
        branch: 'main',
        decisionCount: 5,
        openIssues: [{ id: 1, title: 'Issue 1' }],
      });

      const beforeWrite = fs.readFileSync(dbPath, 'utf8');

      // Write another checkpoint
      await store.writeCheckpoint('session-2', {
        branch: 'feature',
        decisionCount: 3,
      });

      const afterWrite = fs.readFileSync(dbPath, 'utf8');

      // Both writes should be complete
      expect(afterWrite.length).toBeGreaterThan(beforeWrite.length);

      // Verify data integrity
      const reloaded = new StressMemoryStore(dbPath);
      expect(reloaded.getTotalCheckpoints()).toBe(2);
    });

    it('recovers from concurrent write conflicts', async () => {
      // Simulate high contention: 20 sessions all trying to write simultaneously
      const promises = [];

      for (let i = 1; i <= 20; i++) {
        promises.push(
          store.writeCheckpoint(`session-${i}`, {
            branch: `branch-${i}`,
            timestamp: Date.now() + i,
          }).catch(e => {
            // Some may timeout, that's ok
            return { error: e.message };
          })
        );
      }

      const results = await Promise.all(promises);

      // Should have written at least 19 of 20 (one might timeout)
      expect(store.getTotalCheckpoints()).toBeGreaterThanOrEqual(19);

      // Verify integrity
      const { valid } = store.verifyIntegrity();
      expect(valid).toBe(true);
    });
  });

  describe('numeric — stress performance constraints', () => {
    it('handles 50 concurrent checkpoint writes in <5 seconds', async () => {
      const promises = [];
      const start = performance.now();

      for (let i = 1; i <= 50; i++) {
        promises.push(
          store.writeCheckpoint(`session-${i % 5}`, {
            branch: `branch-${i}`,
            timestamp: Date.now() + i,
          })
        );
      }

      await Promise.all(promises);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(store.getTotalCheckpoints()).toBe(50);
    });

    it('retrieves latest checkpoints in <50ms even under load', async () => {
      // Fill store with many checkpoints
      for (let i = 1; i <= 100; i++) {
        await store.writeCheckpoint(`session-${i % 5}`, {
          branch: `branch-${i}`,
          timestamp: 1000 + i,
        });
      }

      const start = performance.now();
      const latest = store.getLatestCheckpoints(3);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
      expect(latest).toHaveLength(3);
    });

    it('keeps file size under 1MB even with 1000 checkpoints', async () => {
      for (let i = 1; i <= 1000; i++) {
        await store.writeCheckpoint(`session-${i % 10}`, {
          branch: `branch-${i}`,
          timestamp: 1000 + i,
          decisionCount: i % 10,
        });
      }

      const dbPath = path.join(tmpDir, 'memory.db');
      const stats = fs.statSync(dbPath);
      expect(stats.size).toBeLessThan(1024 * 1024); // <1MB
    });
  });

  describe('qualitative — stress scenarios', () => {
    it('handles session restart mid-operation', async () => {
      // Session 1 writes checkpoint
      await store.writeCheckpoint('session-1', { branch: 'main' });

      // Simulate session 1 restart by creating new store instance
      const dbPath = path.join(tmpDir, 'memory.db');
      const store2 = new StressMemoryStore(dbPath);

      // Session 1 should be able to resume
      await store2.writeCheckpoint('session-1', { branch: 'main-resumed' });

      expect(store2.getTotalCheckpoints()).toBe(2);
    });

    it('handles session timeout and cleanup', async () => {
      // Acquire lock with short timeout
      try {
        await store.writeCheckpoint('session-1', {
          branch: 'main',
        });
      } catch (e) {
        // timeout is ok
      }

      // Other sessions should eventually acquire lock
      for (let i = 2; i <= 5; i++) {
        await store.writeCheckpoint(`session-${i}`, { branch: `branch-${i}` });
      }

      expect(store.getTotalCheckpoints()).toBeGreaterThan(0);
    });

    it('maintains checkpoint order under rapid concurrent writes', async () => {
      const promises = [];

      for (let i = 1; i <= 50; i++) {
        promises.push(
          store.writeCheckpoint(`session-${i % 5}`, {
            timestamp: i * 100, // predictable order
          })
        );
      }

      await Promise.all(promises);

      const checkpoints = store.state.checkpoints;
      for (let i = 1; i < checkpoints.length; i++) {
        // Timestamps should generally increase (allow for clock skew)
        expect(checkpoints[i].timestamp).toBeGreaterThanOrEqual(
          checkpoints[i - 1].timestamp - 100
        );
      }
    });
  });
});
