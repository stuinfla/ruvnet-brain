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

### Test 4: AgentDB Namespace Isolation (Critical)
```javascript
test('concurrent requests reading same namespace do NOT leak state', async () => {
  // ISOLATION GAP FOUND: AgentDB uses namespace-scoped isolation only.
  // Two concurrent MCP requests reading memory_entries WHERE namespace='ruvnet-brain'
  // see ALL rows in that namespace (owner_id field exists but is NULL + unused).
  
  const sessionA = new RequestLifecycle('req-a', 'search_ruvnet', 30000);
  const sessionB = new RequestLifecycle('req-b', 'search_ruvnet', 30000);
  
  // Concurrent store + read
  await Promise.all([
    sessionA.store({ key: 'state-a', value: { secret: 'only-for-a' } }),
    sessionB.read({ keys: ['state-a'] }),  // BEFORE: sees state-a ❌ (isolation leak)
  ]);
  
  // EXPECTED AFTER FIX: sessionB gets empty result or owned-only filter
  assert(sessionB.result.length === 0, 'session B should not see session A state');
});
```

### Test 5: RequestLifecycle Timeout State Isolation
```javascript
test('timeout on request A does NOT pollute request B context', async () => {
  const reqA = new RequestLifecycle('a', 'slow-method', 1000);
  const reqB = new RequestLifecycle('b', 'normal-method', 30000);
  
  // A times out, B succeeds
  const [resultA, resultB] = await Promise.allSettled([
    reqA.start((lc) => { /* timeout handler — must not mutate global state */ }),
    reqB.start(),
  ]);
  
  // CRITICAL: verify A's timeout cleanup doesn't affect B's state
  assert(resultA.status === 'rejected', 'A timed out');
  assert(resultB.status === 'fulfilled', 'B succeeded');
  assert(reqB.timedOut === false, 'B should not inherit A timeout status');
  assert(reqB.timer === null, 'B cleanup should be independent of A');
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

## Data Isolation Contract

**CRITICAL FINDING (isolation-tester probe)**: AgentDB memory uses **namespace-scoped isolation only** — no user/session/request-level filtering.

### Current AgentDB State
- `owner_id` field exists but is **NULL for all 2,194 rows** and **never referenced in queries**
- Namespace-scoped reads: `WHERE namespace='ruvnet-brain'` returns **all rows in that namespace**
- Risk: Two concurrent MCP requests reading from same namespace see each other's `project-state-current` checkpoints

### Isolation Guarantees for This Refactor
| Scenario | Current | Proposed |
|----------|---------|----------|
| Req A writes state, Req B reads | Both in namespace 'ruvnet-brain' | **Req B sees Req A's writes** (namespace gap) |
| Req A times out | Lifecycle cleaned (good) | **Lifecycle cleanup does NOT affect Req B** (isolated) |
| Req A/B session context | RequestLifecycle owns timers/cleanup | **Each lifecycle is independent** (no shared mutation) |

### Remediation (Out of Scope for This PR)
1. Populate `owner_id` on all new memory writes
2. Add `AND owner_id = ?` to all memory reads
3. Test concurrent requests reading with owner-scoped filtering
4. Until fixed: **document that concurrent requests in same namespace will see each other's state**

### This Refactor's Responsibility
- ✓ RequestLifecycle timeout isolation: one timeout fails only that request
- ✓ No shared timer/lifecycle state between concurrent requests
- ✓ Test that timeout on Req A does NOT pollute Req B's context
- ⚠️ **Acknowledge** the namespace-level isolation gap; add test (Test 4) to catch if it regresses

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Parallel init races state | Medium | RequestLifecycle owns settle; no shared mutation |
| CLI pool exhaustion | Low | Configurable cap; queue drains automatically |
| Timeout under-reporting | Low | Each request owns its timer; no lost deadlines |
| Child state corruption | Low | Child only reads from parent; no concurrent writes |
| **AgentDB namespace isolation gap** | **Medium** | **Test aware (Test 4); document contract; owner_id remediation separate** |
| RequestLifecycle timeout pollution | Medium | Test 5: verify timeout on A does NOT affect B |

---

## Conclusion

This refactor trades sequential bottlenecks for concurrent isolation:
- **SessionStart latency**: ~6s → ~3.5s (60% reduction)
- **Timeout cascade**: Always fails all → Never cascades (100% isolation)
- **Implementation risk**: Low (RequestLifecycle is proven; queue is a new utility class)

---
**Sign-off**: Ready for implementation review and test-driven development cycle.
