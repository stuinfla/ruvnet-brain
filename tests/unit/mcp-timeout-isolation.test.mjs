import { describe, expect, it } from 'vitest';

// Test the RequestLifecycle class behavior directly
// (This is unit testing of the per-request lifecycle isolation pattern)

/**
 * RequestLifecycle: Per-request timeout, cancellation, and cleanup.
 * Verifies that each request has its own isolated lifecycle object.
 */
class RequestLifecycle {
  constructor(id, method, timeoutMs) {
    this.id = id;
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.resolve = null;
    this.reject = null;
    this.timedOut = false;
    this.startedAt = Date.now();
  }

  start(onTimeout) {
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.timedOut = true;
        reject(new Error(`brain worker timeout on ${this.method}`));
        if (onTimeout) onTimeout(this);
      }, this.timeoutMs);
    });
  }

  cancel(reason) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.timedOut && this.reject) {
      this.reject(new Error(reason));
    }
  }

  deliver(result, error) {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (error && this.reject) {
      this.reject(error);
    } else if (this.resolve) {
      this.resolve(result);
    }
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  cleanup() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

describe('MCP Request Lifecycle — Timeout Isolation (Track 3, Stage 1)', () => {
  it('RequestLifecycle: each request gets its own timeout and cancel', async () => {
    const timeoutCalls = [];
    const onTimeout = (lifecycle) => timeoutCalls.push(lifecycle.id);

    // Create two lifecycle objects for two concurrent requests
    const lifecycle1 = new RequestLifecycle(1, 'search', 5000); // Long timeout
    const lifecycle2 = new RequestLifecycle(2, 'search', 5000); // Long timeout

    // Start both timeouts
    const promise1 = lifecycle1.start(onTimeout);
    const promise2 = lifecycle2.start(onTimeout);

    // Verify both are pending initially
    expect(lifecycle1.timer).toBeTruthy();
    expect(lifecycle2.timer).toBeTruthy();

    // Deliver result on lifecycle1 — should not affect lifecycle2
    lifecycle1.deliver({ result: 'success' });

    // Wait a bit and verify only one resolved
    await new Promise((resolve) => setTimeout(resolve, 100));

    // lifecycle2 should still be pending (no timeout, no result)
    expect(lifecycle2.timer).toBeTruthy();

    // Cleanup lifecycle2 to avoid timeout
    lifecycle2.cancel('test cleanup');

    // Now wait for both to settle
    const results = await Promise.allSettled([promise1, promise2]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected'); // Cancelled
  });

  it('RequestLifecycle: timeout fires only for its request, not others', async () => {
    const timedOut = [];
    const onTimeout = (lifecycle) => timedOut.push(lifecycle.id);

    const lifecycle1 = new RequestLifecycle(1, 'search', 100);
    const lifecycle2 = new RequestLifecycle(2, 'search', 500);

    const promise1 = lifecycle1.start(onTimeout);
    const promise2 = lifecycle2.start(onTimeout);

    // Wait for lifecycle1 to timeout (100ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // lifecycle1 should have timed out
    expect(timedOut).toContain(1);
    expect(timedOut).not.toContain(2);

    // lifecycle2 should still be pending
    expect(lifecycle2.timer).toBeTruthy();

    // Deliver result on lifecycle2 — should resolve cleanly
    lifecycle2.deliver({ result: 'delayed success' });

    const results = await Promise.allSettled([promise1, promise2]);

    // Request 1 rejected due to timeout
    expect(results[0].status).toBe('rejected');
    expect(results[0].reason.message).toContain('timeout');

    // Request 2 resolved successfully (not affected by request 1's timeout)
    expect(results[1].status).toBe('fulfilled');
    expect(results[1].value.result).toBe('delayed success');
  });

  it('RequestLifecycle: cancel does not fire if already resolved', async () => {
    const onTimeout = () => {
      throw new Error('should not call onTimeout');
    };

    const lifecycle = new RequestLifecycle(1, 'search', 5000);
    const promise = lifecycle.start(onTimeout);

    // Deliver result immediately
    lifecycle.deliver({ result: 'fast response' });

    // Now try to cancel — should not cause double rejection
    lifecycle.cancel('cleanup');

    const result = await Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))]);

    expect(result.result).toBe('fast response');
  });

  it('RequestLifecycle: concurrent requests have independent state', async () => {
    // Simulate 3 concurrent requests, verify each has isolated state
    const lifecycles = [
      new RequestLifecycle(1, 'search', 200),
      new RequestLifecycle(2, 'search', 100),
      new RequestLifecycle(3, 'search', 300),
    ];

    const results = [];
    const promises = lifecycles.map((lc) =>
      lc.start(() => results.push({ id: lc.id, event: 'timeout', elapsed: lc.elapsedMs() }))
    );

    // After 150ms, only request 2 (100ms timeout) should have timed out
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(results.filter((r) => r.event === 'timeout')).toHaveLength(1);
    expect(results[0].id).toBe(2);

    // After 250ms, requests 1 (200ms) should timeout too
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(results.filter((r) => r.event === 'timeout')).toHaveLength(2);

    // Deliver result on request 3 before it times out (at 300ms)
    lifecycles[2].deliver({ result: 'success' });

    const settled = await Promise.allSettled(promises);

    // Request 1 and 2 timed out, request 3 succeeded
    expect(settled[0].status).toBe('rejected');
    expect(settled[1].status).toBe('rejected');
    expect(settled[2].status).toBe('fulfilled');
    expect(settled[2].value.result).toBe('success');
  });

  it('RequestLifecycle: cleanup clears timer without rejection', async () => {
    const lifecycle = new RequestLifecycle(1, 'search', 5000);
    const promise = lifecycle.start();

    // Cleanup should clear timer
    lifecycle.cleanup();

    // Timer should be cleared
    expect(lifecycle.timer).toBeNull();

    // Wait a bit to ensure no timeout fires
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Manually resolve since we cleaned up
    lifecycle.deliver({ result: 'manual' });

    const result = await Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('should have resolved by now')), 500)
      ),
    ]);

    expect(result.result).toBe('manual');
  });

  it('RequestLifecycle: cancel with reason properly rejects', async () => {
    const lifecycle = new RequestLifecycle(1, 'search', 5000);
    const promise = lifecycle.start();

    lifecycle.cancel('process crashed');

    const result = await Promise.allSettled([promise]);

    expect(result[0].status).toBe('rejected');
    expect(result[0].reason.message).toContain('process crashed');
  });

  it('RequestLifecycle: elapsedMs tracks time correctly', async () => {
    const lifecycle = new RequestLifecycle(1, 'search', 5000);

    const start = lifecycle.startedAt;
    expect(lifecycle.elapsedMs()).toBeLessThan(10); // Should be very small initially

    await new Promise((resolve) => setTimeout(resolve, 100));

    const elapsed = lifecycle.elapsedMs();
    expect(elapsed).toBeGreaterThan(90);
    expect(elapsed).toBeLessThan(150);
  });
});
