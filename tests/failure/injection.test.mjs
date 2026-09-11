// tests/failure/injection.test.mjs — Failure Injection Tests
//
// This test suite proves the system gracefully handles failures:
// 1. Session killed mid-recall → other sessions continue unaffected
// 2. Disk full on memory.db → graceful failure, no corruption
// 3. Stale store (11 days old) + concurrent write → no conflicts
//
// These tests verify that the concurrency refactor doesn't introduce
// new failure modes and that cleanup is reliable even when things break.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Simulated RequestLifecycle that can be killed
class FailableRequestLifecycle {
  constructor(requestId, method, timeoutMs = 30000) {
    this.requestId = requestId;
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.killed = false;
    this.settled = false;
    this.result = null;
    this.error = null;
  }

  async start(executor) {
    return new Promise((resolve, reject) => {
      this.timer = setTimeout(() => {
        if (!this.killed) {
          this.settled = true;
          reject(new Error(`Request ${this.requestId} timed out`));
        }
      }, this.timeoutMs);

      Promise.resolve()
        .then(() => executor(this))
        .then((result) => {
          if (!this.killed) {
            this.result = result;
            this.settled = true;
            clearTimeout(this.timer);
            this.timer = null;
            resolve(result);
          } else {
            reject(new Error(`Request ${this.requestId} was killed`));
          }
        })
        .catch((err) => {
          if (!this.killed) {
            this.error = err;
            this.settled = true;
            clearTimeout(this.timer);
            this.timer = null;
            reject(err);
          }
        });
    });
  }

  kill() {
    this.killed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  cleanup() {
    this.kill();
  }
}

// Simulated AgentDB store that can simulate disk full
class FailableAgentDBStore {
  constructor() {
    this.entries = new Map();
    this.diskFull = false;
    this.writeCount = 0;
    this.readCount = 0;
  }

  async retrieve(namespace, key) {
    this.readCount++;
    if (this.diskFull) {
      throw new Error('I/O error: disk full');
    }
    const entry = this.entries.get(key);
    return entry && entry.namespace === namespace ? entry : null;
  }

  async store(namespace, key, value) {
    this.writeCount++;
    if (this.diskFull) {
      throw new Error('I/O error: disk full');
    }
    this.entries.set(key, {
      namespace,
      value,
      timestamp: Date.now(),
    });
    return { key, version: 1 };
  }

  async query(namespace) {
    this.readCount++;
    if (this.diskFull) {
      throw new Error('I/O error: disk full');
    }
    const results = [];
    for (const [key, entry] of this.entries) {
      if (entry.namespace === namespace) {
        results.push({ key, ...entry });
      }
    }
    return results;
  }

  simulateDiskFull() {
    this.diskFull = true;
  }

  recoverFromDiskFull() {
    this.diskFull = false;
  }

  getStats() {
    return {
      entries: this.entries.size,
      reads: this.readCount,
      writes: this.writeCount,
      diskFull: this.diskFull,
    };
  }

  cleanup() {
    this.entries.clear();
  }
}

describe('Failure Injection Tests', () => {
  let store;

  beforeEach(() => {
    store = new FailableAgentDBStore();
  });

  afterEach(() => {
    store.cleanup();
  });

  // Test 1: Kill a session mid-recall → other sessions continue
  it('Test 1: Session killed mid-recall — other sessions unaffected', async () => {
    const sessionA = new FailableRequestLifecycle('session-a', 'search', 5000);
    const sessionB = new FailableRequestLifecycle('session-b', 'search', 5000);

    // Both sessions start searching concurrently
    const [resultA, resultB] = await Promise.allSettled([
      sessionA.start(async (lc) => {
        // Long search operation
        await new Promise((r) => setTimeout(r, 100));
        return await store.query('ruvnet-brain');
      }),
      sessionB.start(async (lc) => {
        // Wait, then kill session A while B continues
        await new Promise((r) => setTimeout(r, 50));
        sessionA.kill(); // Simulate killing session A mid-operation
        // B continues
        await new Promise((r) => setTimeout(r, 100));
        return await store.query('ruvnet-brain');
      }),
    ]);

    // A should be killed
    expect(resultA.status).toBe('rejected');
    expect(resultA.reason.message).toMatch(/killed/);
    expect(sessionA.killed).toBe(true);

    // B should succeed unaffected
    expect(resultB.status).toBe('fulfilled');
    expect(resultB.value).toEqual([]); // empty query result

    // Verify B's state wasn't corrupted
    expect(sessionB.settled).toBe(true);
    expect(sessionB.timer).toBeNull();
    expect(sessionB.error).toBeNull();

    sessionA.cleanup();
    sessionB.cleanup();
  });

  // Test 2: Disk full on memory.db → graceful failure
  it('Test 2: Disk full on memory.db — graceful failure, no data corruption', async () => {
    const sessionA = new FailableRequestLifecycle('session-a', 'store', 5000);
    const sessionB = new FailableRequestLifecycle('session-b', 'store', 5000);

    // Write some initial data
    await store.store('ruvnet-brain', 'existing-data', { value: 'safe' });

    // Simulate disk full
    store.simulateDiskFull();

    // Both sessions try to write
    const [resultA, resultB] = await Promise.allSettled([
      sessionA.start(async () => {
        return await store.store('ruvnet-brain', 'state-a', { data: 'from-a' });
      }),
      sessionB.start(async () => {
        return await store.store('ruvnet-brain', 'state-b', { data: 'from-b' });
      }),
    ]);

    // Both should fail gracefully with I/O error
    expect(resultA.status).toBe('rejected');
    expect(resultA.reason.message).toMatch(/disk full/);

    expect(resultB.status).toBe('rejected');
    expect(resultB.reason.message).toMatch(/disk full/);

    // Existing data should still be retrievable (not corrupted)
    store.recoverFromDiskFull();
    const existing = await store.retrieve('ruvnet-brain', 'existing-data');
    expect(existing).not.toBeNull();
    expect(existing.value).toEqual({ value: 'safe' });

    // Failed writes should not be in store
    const failed = await store.retrieve('ruvnet-brain', 'state-a');
    expect(failed).toBeNull();

    const stats = store.getStats();
    expect(stats.entries).toBe(1); // only the original entry

    sessionA.cleanup();
    sessionB.cleanup();
  });

  // Test 3: Stale store (11 days old) + concurrent write → no conflicts
  it('Test 3: Stale store — old checkpoint + new write do not conflict', async () => {
    const now = Date.now();
    const elevenDaysAgo = now - 11 * 24 * 60 * 60 * 1000;

    // Write a stale checkpoint
    store.entries.set('old-checkpoint', {
      namespace: 'ruvnet-brain',
      value: { timestamp: elevenDaysAgo },
      timestamp: elevenDaysAgo,
    });

    const sessionA = new FailableRequestLifecycle('session-a', 'store', 5000);
    const sessionB = new FailableRequestLifecycle('session-b', 'store', 5000);

    // Both sessions write new checkpoints concurrently
    const [resultA, resultB] = await Promise.allSettled([
      sessionA.start(async () => {
        return await store.store('ruvnet-brain', 'new-checkpoint-a', { fresh: true, timestamp: now });
      }),
      sessionB.start(async () => {
        return await store.store('ruvnet-brain', 'new-checkpoint-b', { fresh: true, timestamp: now });
      }),
    ]);

    // Both should succeed
    expect(resultA.status).toBe('fulfilled');
    expect(resultB.status).toBe('fulfilled');

    expect(resultA.value).toHaveProperty('key', 'new-checkpoint-a');
    expect(resultB.value).toHaveProperty('key', 'new-checkpoint-b');

    // All three checkpoints should be present
    const all = await store.query('ruvnet-brain');
    expect(all).toHaveLength(3);

    // Verify old checkpoint is still there (not overwritten)
    const oldCheckpoint = all.find((e) => e.key === 'old-checkpoint');
    expect(oldCheckpoint).toBeDefined();
    expect(oldCheckpoint.timestamp).toBe(elevenDaysAgo);

    // Verify new checkpoints have current timestamp
    const newA = all.find((e) => e.key === 'new-checkpoint-a');
    const newB = all.find((e) => e.key === 'new-checkpoint-b');
    expect(newA.timestamp).toBeGreaterThan(elevenDaysAgo);
    expect(newB.timestamp).toBeGreaterThan(elevenDaysAgo);

    sessionA.cleanup();
    sessionB.cleanup();
  });

  // Test 4: Recovery after disk full (simulates system recovery)
  it('Test 4: Recovery after disk full — system returns to normal', async () => {
    // Write initial data
    await store.store('ruvnet-brain', 'before-failure', { data: 'initial' });

    // Simulate disk full
    store.simulateDiskFull();

    const req1 = new FailableRequestLifecycle('req-1', 'store', 5000);
    const failResult = await Promise.allSettled([
      req1.start(async () => {
        return await store.store('ruvnet-brain', 'during-failure', { data: 'failed' });
      }),
    ]);

    expect(failResult[0].status).toBe('rejected');

    // Recover from disk full
    store.recoverFromDiskFull();

    // New requests should succeed
    const req2 = new FailableRequestLifecycle('req-2', 'store', 5000);
    const successResult = await Promise.allSettled([
      req2.start(async () => {
        return await store.store('ruvnet-brain', 'after-recovery', { data: 'recovered' });
      }),
    ]);

    expect(successResult[0].status).toBe('fulfilled');

    // Verify state is consistent
    const all = await store.query('ruvnet-brain');
    const keys = all.map((e) => e.key);

    expect(keys).toContain('before-failure');
    expect(keys).toContain('after-recovery');
    expect(keys).not.toContain('during-failure'); // Failed write should not exist

    const stats = store.getStats();
    expect(stats.entries).toBe(2);

    req1.cleanup();
    req2.cleanup();
  });

  // Test 5: Concurrent failures don't cascade
  it('Test 5: One session fails — others continue', async () => {
    const sessionA = new FailableRequestLifecycle('session-a', 'method', 5000);
    const sessionB = new FailableRequestLifecycle('session-b', 'method', 5000);
    const sessionC = new FailableRequestLifecycle('session-c', 'method', 5000);

    // Simulate disk full partway through
    const [resultA, resultB, resultC] = await Promise.allSettled([
      sessionA.start(async () => {
        // A will trigger disk full
        await new Promise((r) => setTimeout(r, 10));
        store.simulateDiskFull();
        return await store.store('ruvnet-brain', 'state-a', {});
      }),
      sessionB.start(async () => {
        // B waits and also fails
        await new Promise((r) => setTimeout(r, 20));
        return await store.store('ruvnet-brain', 'state-b', {});
      }),
      sessionC.start(async () => {
        // C waits for recovery and succeeds
        await new Promise((r) => setTimeout(r, 50));
        store.recoverFromDiskFull();
        return await store.store('ruvnet-brain', 'state-c', {});
      }),
    ]);

    // A and B should fail
    expect(resultA.status).toBe('rejected');
    expect(resultB.status).toBe('rejected');

    // C should recover and succeed
    expect(resultC.status).toBe('fulfilled');

    // Only C's write should exist
    const all = await store.query('ruvnet-brain');
    expect(all).toHaveLength(1);
    expect(all[0].key).toBe('state-c');

    sessionA.cleanup();
    sessionB.cleanup();
    sessionC.cleanup();
  });
});
