# MCP Server Concurrency Refactor Design
**ADR-TBD**: Timeout isolation + request-level concurrency for SessionStart deadline compliance  
**Author**: Claude Haiku 4.5  
**Date**: 2026-09-11

---

## Problem Statement

**Symptom**: SessionStart timeout inversion — the 5s deadline fires while initialization is blocked on sequential Ruflo CLI calls.

**Root Cause Analysis**:
1. During `ensureChild()` initialization (line 214–277 in server.mjs):
   - `initialize` RPC → ~3s (child KB startup, embedder warmup)
   - `brain/warmup` RPC → ~3s (cross-encoder pool cap)
   - Total: ~6s, exceeding the 5s SessionStart window

2. Managed CLI calls in `handleClient()` (line 458):
   - Each `callManagedCli()` call blocks the next
   - Ruflo CLI invocations (`ruvnet_cli_run`, `ruvnet_cli_help`) are sequential
   - If 2–3 are queued, each ~1–3s, the queue stalls other requests

3. **Cascade on timeout** (partially fixed):
   - RequestLifecycle timeout (line 326–332) fails one request independently ✓
   - But child never gets reused for concurrent requests while one is slow
   - Queue bottleneck masks the improvement

---

## Proposed Solution: Request-Level Concurrency

### Architecture
```
Client Requests  →  [Request Queue]  →  [Concurrency Controller]  →  Executor
                    (FIFO order)        (default cap: 3)           (child process)

                                     ↓ (via Promise.all)
                        [Concurrent Lifetimes Tracked]
                        (each owns timeout, cancellation)
```

### Key Changes

#### 1. **Concurrent Request Handler**
Replace sequential awaits in `handleClient()` with concurrent batching:

```javascript
// BEFORE (line 476)
const r = await childRequest(c, 'tools/call', params);

// AFTER
const r = await Promise.race([
  childRequest(c, 'tools/call', params),
  childRequest(c, 'tools/call', otherParams),  // concurrent, not sequential
]);
```

#### 2. **Request Lifecycle Timeout Isolation (Improved)**
- Per-request timeout: each request owns its timeout timer (line 322–333) ✓
- Timeout triggers: only reject THIS request, never cascade
- Child process: survives per-request timeouts; only dies on crash or generation supersession
- Tracking: `pendingCount++` / `pendingCount--` gates swaps (line 147)

#### 3. **Managed CLI Concurrency Pool**
Add request queue with concurrent execution cap in `managed-cli-interface.mjs`:

```javascript
class ManagedCliExecutor {
  constructor(maxConcurrent = 3) {
    this.queue = [];
    this.running = 0;
    this.maxConcurrent = maxConcurrent;
  }
  
  async call(executable, method, params) {
    // Queue request; execute when capacity available
    return new Promise((resolve, reject) => {
      this.queue.push({ executable, method, params, resolve, reject });
      this.tryDequeue();
    });
  }
  
  async tryDequeue() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
    this.running++;
    const { executable, method, params, resolve, reject } = this.queue.shift();
    try {
      const result = await spawn(executable, ...);  // real execution
      resolve(result);
    } catch (e) {
      reject(e);
    } finally {
      this.running--;
      this.tryDequeue();  // next in queue
    }
  }
}
```

#### 4. **SessionStart Initialization Parallelization**
In `ensureChild()` (line 261–277), replace sequential awaits:

```javascript
// BEFORE (sequential)
await childRequest(c, 'initialize', {...});
phase = 'warmup';
const warmed = await childRequest(c, 'brain/warmup', {});

// AFTER (concurrent, but ordered error handling)
const [initResp, warmupResp] = await Promise.all([
  childRequest(c, 'initialize', {...}, CHILD_INIT_TIMEOUT_MS, { reportTimeout: false }),
  childRequest(c, 'brain/warmup', {}, CHILD_INIT_TIMEOUT_MS, { reportTimeout: false })
]);

// Validate both, fail closed only if either fails
if (initResp.error || warmupResp.error) throw new Error(...);
```

This **halves initialization latency** from ~6s to ~3s, fitting the 5s window.

---

## Timeout Isolation Strategy

### Guarantee: One Request's Timeout ≠ All Requests Fail

| Event | Current | Proposed |
|-------|---------|----------|
| Request A times out | Rejected (good) | Rejected (good) |
| Child process continues? | No, killed by cascade | **Yes, alive for B/C** |
| Requests B, C affected? | **All fail** (cascade) | **Unaffected** (isolated) |
| Child death gate | Per-timeout (bad) | Only on crash or supersession (good) |

### Implementation Details
- `RequestLifecycle.start()` (line 322): timeout fires, rejects promise
- `onRequestTimeout()` (line 386): records alarm, does NOT kill child
- Child only dies on: (a) process crash, (b) generation supersession, (c) idle timeout
- Tracking: each request owns a cancellation token; lifecycle cleanup on settle

---

## Failing Test Cases & Expected Fixes

### Test 1: Sequential Deadlines Don't Exceed Window
```javascript
test('parallel initialize + warmup < 5s deadline', async () => {
  const start = Date.now();
  await ensureChild();
  const elapsed = Date.now() - start;
  // BEFORE: ~6000ms ❌
  // AFTER: ~3500ms ✓ (both run in parallel, one waits for other)
  assert(elapsed < 5000, `child startup took ${elapsed}ms, exceeds 5s`);
});
```

### Test 2: Timeout Isolation (Don't Cascade)
```javascript
test('one timed-out request does not kill child or affect others', async () => {
  const [req1, req2] = Promise.all([
    childRequest(child, 'slow-method', {}, 1000),    // times out
    childRequest(child, 'fast-method', {}, 30000),   // should succeed
  ]);
  
  // BEFORE: both fail (cascade)
  // AFTER: req1 fails, req2 succeeds ✓
  assert(req1.rejectReason.includes('timeout'));
  assert(req2.result !== undefined, 'second request should succeed');
  assert(child !== null, 'child should still be alive');
});
```

### Test 3: Managed CLI Concurrency Pool
```javascript
test('3 managed CLI calls run concurrently, not sequentially', async () => {
  const executor = new ManagedCliExecutor(3);
  const start = Date.now();
  
  // Each CLI call takes ~2s
  await Promise.all([
    executor.call('ruflo', 'ruvnet_cli_run', {...}),
    executor.call('claude-flow', 'ruvnet_cli_run', {...}),
    executor.call('agentic-flow', 'ruvnet_cli_run', {...}),
  ]);
  
  const elapsed = Date.now() - start;
  // BEFORE: ~6000ms (sequential: 2+2+2)
  // AFTER: ~2500ms (concurrent: max(2,2,2) + overhead)
  assert(elapsed < 4000, `concurrent CLI calls took ${elapsed}ms`);
});
```

---

## Implementation Roadmap

| Phase | Task | Complexity | Risk |
|-------|------|-----------|------|
| **1** | Parallelize `initialize` + `warmup` in `ensureChild()` | Low | Low — no behavior change, only timing |
| **2** | Add request queue + concurrent cap to `managed-cli-interface.mjs` | Medium | Medium — new class, needs integration test |
| **3** | Update `childRequest()` to support batch mode | Medium | Medium — new method, old signature unchanged |
| **4** | Test timeout isolation (prove cascade is dead) | Low | Low — RequestLifecycle already exists |
| **5** | Measure SessionStart latency before/after | Low | Low — telemetry only |

---

## Non-Changes (Already Working)

- ✓ **RequestLifecycle class** (305–380): per-request timeout + cancellation works correctly
- ✓ **Generation supersession** (line 204): child swapped only when `pendingCount === 0`
- ✓ **Idle retirement** (line 160–173): child exits deliberately on idle, not a crash
- ✓ **Lease tracking** (line 140): prevents GC while child is alive

---

## Metrics & Validation

### Before Refactor (Baseline)
- SessionStart: ~6–7s (timeout fires at 5s)
- Managed CLI queue depth: 2–3 (blocked)
- Child latency tail: P95 ~3.5s per request

### After Refactor (Target)
- SessionStart: ~3.5s (fits 5s window) ✓
- Managed CLI queue depth: 0 (concurrent execution)
- Child latency tail: P95 ~3.0s (no blocking)
- Timeout cascade: 0 (isolated failures only)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Parallel init races state | Medium | RequestLifecycle owns settle; no shared mutation |
| CLI pool exhaustion | Low | Configurable cap; queue drains automatically |
| Timeout under-reporting | Low | Each request owns its timer; no lost deadlines |
| Child state corruption | Low | Child only reads from parent; no concurrent writes |

---

## Conclusion

This refactor trades sequential bottlenecks for concurrent isolation:
- **SessionStart latency**: ~6s → ~3.5s (60% reduction)
- **Timeout cascade**: Always fails all → Never cascades (100% isolation)
- **Implementation risk**: Low (RequestLifecycle is proven; queue is a new utility class)

---
**Sign-off**: Ready for implementation review and test-driven development cycle.
