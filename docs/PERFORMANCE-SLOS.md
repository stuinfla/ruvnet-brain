# Performance SLOs & Regression Gates (W5-B Baseline Lead)

**Mission**: Establish and prove performance SLOs for ruvnet-brain. Define regression gates that fail if we regress beyond SLO thresholds.

**Date Established**: 2026-09-11  
**Lead**: Performance Baseline (W5-B)  
**Current Status**: Baseline infrastructure established

---

## SLO Targets

| Metric | p50 | p95 (SLO) | p99 | Hard Limit | Notes |
|--------|-----|-----------|-----|------------|-------|
| **Session-Start Recall** | <300ms | **500ms** | <800ms | <750ms | Time to load and parse session snapshots on session start |
| **Memory Store Write** | <50ms | **100ms** | <200ms | <150ms | Latency for storing entries to `.swarm/memory.db` |
| **ADR Enforcement Check** | <30ms | **50ms** | <100ms | <75ms | Time to validate ADR policy compliance |

**Regression Threshold**: 10% margin above SLO (e.g., session-start fails if p95 > 550ms)

---

## Baseline Benchmarks

### Establishing Baselines

Run the performance baseline benchmark to measure current system performance:

```bash
# Measure baseline performance
npm run bench -- memory-baseline

# With 100-user stress test (60 seconds)
npm run bench -- memory-baseline --stress 100 --duration 60000

# Custom samples
npm run bench -- memory-baseline --session-samples 20 --write-samples 30 --adr-samples 40
```

**Output**: Baseline data saved to `.release-evidence/performance-baseline.json`

### Regression Gates

After establishing baselines, regression gates ensure future changes don't degrade performance:

```bash
# Run regression gates
npm run bench:gates

# These tests fail if:
# - Session-start recall p95 > 550ms
# - Memory store write p95 > 110ms
# - ADR enforcement p95 > 55ms
```

---

## Usage in CI/CD

Add to your release pipeline to catch performance regressions early:

```bash
# In CI after every significant change
npm run bench:gates || (echo "Performance regressed" && exit 1)

# Optionally re-baseline if regression is justified
npm run bench -- memory-baseline
npm run bench:gates
```

---

## Architecture

### Files

| File | Purpose |
|------|---------|
| `scripts/performance-baseline.mjs` | Main benchmark runner |
| `tests/performance/memory-baseline.test.mjs` | Vitest performance measurements |
| `tests/performance/regression-gates.test.mjs` | Regression gate assertions |
| `.release-evidence/performance-baseline.json` | Baseline measurements (saved) |
| `.release-evidence/regression-gates.json` | Regression gate definitions |
| `.release-evidence/live-metrics.jsonl` | Historical live metrics (JSONL format) |

### Benchmark Components

#### 1. Session-Start Recall (Cold)
- **What**: Time to load and parse session snapshots on fresh start
- **Why**: Critical for session continuity UX
- **Measurement**: Remove cache, load snapshot contract, parse sessions
- **Samples**: 10 runs minimum

#### 2. Session-Start Recall (Warm)
- **What**: Time with cached snapshots present
- **Why**: Typical production case
- **Measurement**: Repeated calls with warm cache
- **Samples**: 15 runs minimum

#### 3. Memory Store Write
- **What**: Latency to write key-value entries to memory storage
- **Why**: Core operation for learning and continuity
- **Measurement**: JSON write to filesystem
- **Samples**: 20 runs minimum

#### 4. Memory Store Batch Write
- **What**: Batch write latency (5 entries)
- **Why**: Typical multi-entry update pattern
- **Measurement**: 5 sequential writes
- **Samples**: 10 runs minimum

#### 5. ADR Enforcement Check
- **What**: Time to validate ADR policy compliance
- **Why**: Governance must not block user experience
- **Measurement**: Read and parse ADR files
- **Samples**: 25 runs minimum

#### 6. Stress Test (100 Users)
- **What**: Latency under 100 concurrent operations
- **Why**: Production load simulation
- **Duration**: 30-60 seconds
- **Workers**: Simulated concurrent operations
- **Measurement**: p95/p99 latency during load

---

## Interpreting Results

### Example Output

```
SESSION-START RECALL
  SLO (p95): 500ms
  Measured (p95): 425.34ms
  Mean: 380.21ms
  p99: 687.42ms
  Range: 320.12ms - 750.89ms
  Samples: 10
  ✓ Meets SLO (margin: 14.9%)

MEMORY STORE WRITE
  SLO (p95): 100ms
  Measured (p95): 78.23ms
  Mean: 65.10ms
  p99: 125.67ms
  Range: 52.34ms - 145.23ms
  Samples: 20
  ✓ Meets SLO (margin: 21.8%)
```

### Acceptable States

1. **GREEN** ✓ — Measured p95 ≤ SLO
2. **YELLOW** ⚠️ — SLO < p95 ≤ (SLO × 1.10)
3. **RED** ✗ — Measured p95 > (SLO × 1.10) → **Regression gates FAIL**

---

## Responding to Regressions

### If Regression Gates Fail

1. **Verify**: Run benchmark 2-3 more times to confirm (not a fluke)
   ```bash
   npm run bench -- memory-baseline --session-samples 20
   ```

2. **Investigate**: What changed?
   - Recent code changes?
   - System load?
   - Memory pressure?

3. **Debug**: Profile the regressed component
   ```bash
   # Enable verbose timing in session-snapshot-contract.mjs
   node -e "..." --trace-time
   ```

4. **Decide**:
   - **If acceptable**: Update baseline after investigation
   - **If bug**: Fix regression and re-run gates
   - **If hardware limit**: Adjust SLO with justification in ADR

5. **Document**: Record decision in ADR or PROGRESS.md

---

## Historical Metrics

Live metrics are appended to `.release-evidence/live-metrics.jsonl` on each benchmark run.

### Analyzing Trends

```bash
# Extract p95 values for session-start over time
jq '.benchmarks[] | select(.metric == "session_start_recall_cold") | .measured.p95' \
  .release-evidence/live-metrics.jsonl | sort -n

# Find worst-case p99
jq '.benchmarks[] | select(.metric == "session_start_recall_cold") | .measured.p99' \
  .release-evidence/live-metrics.jsonl | sort -rn | head -1
```

---

## SLO Rationale

### Session-Start Recall: 500ms p95
- **Context**: Runs once per session when Claude Code starts
- **User Impact**: Every 500ms+ delay feels like startup lag
- **Feasibility**: Current implementations target 300-400ms; 500ms allows for disk I/O variance
- **Trade-off**: Larger session snapshots may push closer to 500ms; optimization needed

### Memory Store Write: 100ms p95
- **Context**: Runs on every learning event, ADR check, continuity snapshot
- **User Impact**: Accumulates if batched; must stay sub-100ms per entry
- **Feasibility**: JSON serialization + filesystem write; 50-80ms typical
- **Trade-off**: Compression could reduce size; async batching could amortize cost

### ADR Enforcement Check: 50ms p95
- **Context**: Runs before consequential actions (release, deployment, major decision)
- **User Impact**: Cannot block interactive flow; should be sub-100ms absolute
- **Feasibility**: Reading 2-3 ADR files from disk; 30-40ms typical
- **Trade-off**: Caching ADR validation could reduce to <10ms; requires invalidation logic

---

## Future Improvements

### Phase 1 (Current): Baseline + Regression Gates
- [x] Establish SLO targets
- [x] Implement baseline measurements
- [x] Build regression gate tests
- [ ] First baseline run and approval

### Phase 2: Live Dashboard
- [ ] Publish metrics to metrics dashboard
- [ ] Automated alerts on SLO breach
- [ ] Historical trend visualization
- [ ] Percentile SLA reporting

### Phase 3: Optimization
- [ ] Profile top regressions
- [ ] Implement targeted optimizations
- [ ] Re-baseline after each optimization
- [ ] Document trade-offs (speed vs. completeness)

### Phase 4: Stress Testing
- [ ] 1000-user load test
- [ ] Memory pressure scenarios
- [ ] Concurrent session start
- [ ] Network latency injection

---

## References

- [W5-B Performance Baseline Lead](#) — This campaign
- [Session Snapshot Contract](../plugin/scripts/session-snapshot-contract.mjs) — Implementation
- [Performance Regression Gates](./tests/performance/regression-gates.test.mjs) — Test assertions
- [PROGRESS.md](../PROGRESS.md) — Campaign history and decisions

---

**Last Updated**: 2026-09-11  
**Status**: Baseline infrastructure established, awaiting first measurement run  
**Next**: Run `npm run bench -- memory-baseline` to establish live baseline data
