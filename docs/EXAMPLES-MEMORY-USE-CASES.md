# Examples: Real Memory & Continuity Use Cases

**Version**: 1.0.0 · **Updated**: 2026-09-11 · **Format**: 5 real use cases with full code examples

---

## Table of Contents

1. [Use Case 1: Add a Feature (Multi-Session)](#use-case-1-add-a-feature-multi-session)
2. [Use Case 2: Fix a Bug & Store the Lesson](#use-case-2-fix-a-bug--store-the-lesson)
3. [Use Case 3: Performance Optimization & ADR](#use-case-3-performance-optimization--adr)
4. [Use Case 4: Rollback a Decision (Supersede ADR)](#use-case-4-rollback-a-decision-supersede-adr)
5. [Use Case 5: Cross-Host Resume (Laptop → Workstation)](#use-case-5-cross-host-resume-laptop--workstation)

---

## Use Case 1: Add a Feature (Multi-Session)

**Scenario:** You're building a new feature ("Hierarchical Coordinator") across three sessions (research, implementation, testing). Between sessions, you rely on memory to pick up where you left off.

### Session 1: Research & Architecture Decision

**Inputs:** Project state: incomplete feature list, 2 blockers unresolved

**What happens:**

```javascript
// 1. SessionStart recalls prior state
const prior = await memoryStore.read({ key: 'project-state-current' });
console.log('Prior session was on:', prior?.value?.nextAction);
// Output: "Research hierarchical vs mesh topology"

// 2. Do research, measure both approaches
const meshMetrics = { gossipOverhead: '73%', latency: 'high' };
const hierarchicalMetrics = { gossipOverhead: '8%', latency: 'low' };

// 3. Make a decision and write to memory (ADR candidate)
await memoryStore.write({
  key: 'decision-topology-hierarchical-chosen',
  value: {
    decision: 'Use hierarchical topology (not mesh)',
    rationale: 'Gossip overhead 73% → 8%; latency halved',
    evidence: {
      meshBench: 'scripts/bench-mesh.mjs (73% gossip)',
      hierarchicalBench: 'scripts/bench-hierarchical.mjs (8% gossip)',
      timestamp: new Date().toISOString()
    },
    proof: 'Benchmarks run, results committed to branch/research-topology',
    nextStep: 'Draft ADR-0XYZ and get review'
  }
});

// 4. Write checkpoint for next session
const checkpoint = {
  version: '4.3.21',
  branch: 'feature/hierarchical-coordinator',
  goal: 'Build hierarchical coordinator for 50+ concurrent agents',
  completed: [
    'Researched mesh vs hierarchical topology',
    'Ran benchmarks (hierarchical wins 73% improvement)',
    'Decision: adopt hierarchical (ADR pending)'
  ],
  inProgress: 'Drafting ADR-0XYZ with evidence',
  blockers: [],
  nextAction: 'Get ADR review from peer, then start implementation',
  timestamp: new Date().toISOString()
};

// This will be called by PreCompact hook automatically
// But you can also write it manually for safety
await memoryStore.write({
  key: `project-state-current-${Date.now()}`,
  value: checkpoint,
  metadata: { source: 'session-1-research' }
});
```

**SessionStart hook execution** (automatic, at session end):
```bash
# PreCompact hook runs and saves the checkpoint to memory.db
sqlite3 .swarm/memory.db "INSERT INTO memory_entries (key, namespace, value) ..."
```

### Session 2: ADR Review & Implementation Start

**Inputs:** SessionStart recalls: "Get ADR review from peer, then start implementation"

```javascript
// 1. SessionStart automatically recalls checkpoint
const checkpoint = await memoryStore.read({ key: 'project-state-current' });

// 2. Resume from next action
console.log('Resuming:', checkpoint.value.nextAction);
// Output: "Get ADR review from peer, then start implementation"

// 3. Get review (bifocal: Fable 5.1 + GPT-6 Astra)
// After review, update decision in memory
await memoryStore.write({
  key: 'decision-topology-hierarchical-chosen',
  value: {
    decision: 'Use hierarchical topology (not mesh)',
    rationale: '...',  // previous content
    reviewScore: 70,  // Average: (72 + 68) / 2
    reviewers: [
      { model: 'fable-5.1', score: 72, verdict: 'approved' },
      { model: 'gpt-6-astra', score: 68, verdict: 'approved' }
    ],
    approved: true
  }
});

// 4. Write ADR file
fs.writeFileSync('docs/adr/0XYZ-hierarchical-coordinator.md', `
---
id: ADR-0XYZ
title: Adopt hierarchical coordinator for 50+ concurrent agents
status: Accepted
date: 2026-09-10
...
---

# ADR-0XYZ ...
`);

// 5. Update memory with ADR info
await memoryStore.write({
  key: 'adrstatus-0XYZ',
  value: {
    adrId: '0XYZ',
    status: 'accepted',
    dateAccepted: '2026-09-10',
    file: 'docs/adr/0XYZ-hierarchical-coordinator.md',
    governs: [
      'plugin/coordinator.mjs',
      'plugin/coordinator-types.ts',
      'tests/integration/coordinator-50-agents.test.mjs'
    ],
    reviewScore: 70
  }
});

// 6. Start implementation: create coordinator class
// ... write code to plugin/coordinator.mjs ...

// 7. Checkpoint for next session
await memoryStore.write({
  key: `project-state-current-${Date.now()}`,
  value: {
    version: '4.3.21',
    branch: 'feature/hierarchical-coordinator',
    goal: 'Build hierarchical coordinator for 50+ concurrent agents',
    completed: [
      'Researched mesh vs hierarchical topology',
      'Ran benchmarks (hierarchical wins 73% improvement)',
      'ADR-0XYZ drafted, reviewed (F5.1:72, GPT6:68), accepted',
      'Created hierarchical coordinator class (50% complete)'
    ],
    inProgress: 'Implement coordinator message routing and leader election',
    blockers: [],
    nextAction: 'Finish coordinator implementation; write integration tests for 50 concurrent agents',
    uncommittedFiles: ['plugin/coordinator.mjs'],
    timestamp: new Date().toISOString()
  }
});
```

### Session 3: Complete Implementation & Tests

**Inputs:** SessionStart recalls: "Finish coordinator implementation; write integration tests"

```javascript
// 1. SessionStart recalls
const checkpoint = await memoryStore.read({ key: 'project-state-current' });

// 2. Finish implementation based on checkpoint guidance
// ... continue from plugin/coordinator.mjs, uncommitted state ...

// 3. Write tests
fs.writeFileSync('tests/integration/coordinator-50-agents.test.mjs', `
test('hierarchical coordinator handles 50 concurrent agents', async () => {
  // Test proves ADR-0XYZ's design works at scale
});
`);

// 4. Run full test suite
// npm test (all pass)

// 5. Commit
// git commit -m "Feature: hierarchical coordinator for 50+ agents (ADR-0XYZ)"

// 6. Final checkpoint
await memoryStore.write({
  key: `project-state-current-${Date.now()}`,
  value: {
    version: '4.3.21',
    branch: 'feature/hierarchical-coordinator',
    goal: 'Build hierarchical coordinator for 50+ concurrent agents',
    status: 'COMPLETED',
    completed: [
      'Researched mesh vs hierarchical topology',
      'Ran benchmarks (hierarchical wins 73% improvement)',
      'ADR-0XYZ drafted, reviewed (F5.1:72, GPT6:68), accepted',
      'Implemented hierarchical coordinator class',
      'Wrote integration tests for 50 concurrent agents',
      'All tests pass (41/41)',
      'Merged to main (commit abc123def)'
    ],
    metrics: {
      throughput: '2000 tasks/sec',
      latency_p99: '150ms',
      gossipOverhead: '8% (vs 73% mesh)'
    },
    nextAction: 'Feature complete; PR ready for review'
  }
});
```

---

## Use Case 2: Fix a Bug & Store the Lesson

**Scenario:** You discover that SessionStart hangs 60% of the time. You debug, find the root cause, fix it, and store the lesson for the team.

### Initial Session: Diagnosis

```javascript
// Symptom: SessionStart takes 30s instead of 2s

// Diagnosis via logs
const logs = fs.readFileSync('/Users/stuartkerr/.claude/logs/session-*.log', 'utf8');
// Find: "memory_search" hanging for 8s

// Root cause analysis
// HNSW checkpoint not being flushed atomically
// When multiple sessions query simultaneously, lock waits cascade

// Store the problem in memory
await memoryStore.write({
  key: 'bug-investigation-session-start-hang',
  value: {
    symptom: 'SessionStart hangs (30s), happens 60% of the time',
    reproduced: true,
    rootCause: 'HNSW index checkpoint not atomic; WAL not flushed before session-start',
    evidence: {
      sessionLogs: 'see /Users/stuartkerr/.claude/logs/session-*.log 2026-09-11T12:*',
      timing: 'memory_search hangs for 8s when multiple sessions start simultaneously',
      pattern: 'Intermittent (60%); happens during parallel test runs'
    },
    solutionAttempt: 'Add PRAGMA wal_checkpoint(RESTART) before memory_search query'
  }
});
```

### Implementation & Measurement

```javascript
// In ~/.claude/hooks/agentdb-ensure.sh, add before memory query:

// Fix: Force checkpoint before reading
// sqlite3 .swarm/memory.db "PRAGMA wal_checkpoint(RESTART);"
// SELECT value FROM memory_entries WHERE key LIKE 'project-state-current%' ...

// Measure before/after
const before = {
  p50: 2100,   // 2.1s
  p95: 8300,   // 8.3s (hangs)
  p99: 30000   // 30s (timeout)
};

// After fix
const after = {
  p50: 800,    // 0.8s (62% improvement)
  p95: 1200,   // 1.2s
  p99: 1800    // 1.8s
};

// Store the lesson
await memoryStore.write({
  key: 'lesson-hnsw-checkpoint-atomicity',
  value: {
    problem: 'SessionStart hangs 60% of the time when multiple sessions start in parallel',
    rootCause: 'WAL checkpoint not atomic; HNSW queries race with writes',
    solution: 'Add PRAGMA wal_checkpoint(RESTART) before any memory_search query',
    implementation: {
      file: '~/.claude/hooks/agentdb-ensure.sh',
      change: 'Insert PRAGMA wal_checkpoint(RESTART) at line 42',
      commit: 'abc123def456'
    },
    evidence: {
      beforeMetrics: before,
      afterMetrics: after,
      improvement: '62% (P50: 2.1s → 0.8s)',
      test: 'tests/integration/session-start-concurrent.test.mjs',
      reproduced: true,
      fixVerified: true
    },
    learned: '2026-09-11T14:30:00Z',
    keywords: ['checkpoint', 'WAL', 'atomicity', 'concurrency', 'session-start']
  }
});
```

### Test to Prove It Works

```javascript
// tests/integration/session-start-concurrent.test.mjs
test('SessionStart handles 10 concurrent agents without hang', async () => {
  // Spawn 10 sessions simultaneously
  const promises = Array.from({ length: 10 }, (_, i) =>
    spawnSession({ id: `session-${i}` })
  );

  // All should complete in < 2s
  const startTime = Date.now();
  await Promise.all(promises);
  const duration = Date.now() - startTime;

  expect(duration).toBeLessThan(2000);  // P50 target
});
```

### Commit & Document

```bash
# Commit the fix
git commit -m "Fix: WAL checkpoint atomicity before HNSW search (62% SessionStart improvement)

Before: P50 2.1s, P95 8.3s, hangs 60% of the time
After: P50 0.8s, P95 1.2s, no hangs

Measured over 50 concurrent sessions. Lesson stored in memory:
  lesson-hnsw-checkpoint-atomicity

Fixes #42 (SessionStart timeout)"

# Push and it's live
git push origin main
```

---

## Use Case 3: Performance Optimization & ADR

**Scenario:** You notice the memory.db query for recall is slow. You optimize it, measure the improvement, and write an ADR to ensure the optimization persists.

### Identify the Problem

```javascript
// Profile SessionStart recall
const start = performance.now();
const checkpoint = await memoryStore.read({ key: 'project-state-current' });
const duration = performance.now() - start;

console.log(`Recall took ${duration}ms`);
// Output: "Recall took 1247ms" (should be < 500ms)

// Query plan shows: full table scan (memory_entries has 50K rows)
// SELECT ... WHERE key LIKE 'project-state-current%' ... (no index)
```

### Optimize: Add Index

```javascript
// Solution: Add index on (key, updated_at DESC)
// Before: full table scan = 1247ms
// After: index seek = 42ms (96.6% improvement)

// Implement in database schema upgrade
await memoryStore.execute(`
  CREATE INDEX IF NOT EXISTS idx_memory_key_pattern 
    ON memory_entries(key, updated_at DESC);
  PRAGMA optimize;
`);

// Measure after optimization
const afterStart = performance.now();
const checkpointAfter = await memoryStore.read({ key: 'project-state-current' });
const afterDuration = performance.now() - afterStart;

console.log(`Recall now takes ${afterDuration}ms (was ${duration}ms)`);
// Output: "Recall now takes 42ms (was 1247ms)"
```

### Write an ADR

```bash
# Create ADR to document and lock in this decision
cat > docs/adr/0YYY-index-memory-recall-performance.md << 'EOF'
---
id: ADR-0YYY
title: Index memory_entries for fast project-state recall
status: Accepted
date: 2026-09-11
authors: [Claude Code]
tags: [performance, database, indexing]
governs:
  - .swarm/memory.db (schema)
  - ~/.claude/hooks/agentdb-ensure.sh
relates: [ADR-073]
---

# ADR-0YYY — Index memory_entries for Fast Recall

## Context

SessionStart recall query (SELECT ... WHERE key LIKE 'project-state-current%') performs a full
table scan when memory_entries grows beyond ~1000 rows. This causes SessionStart latency to
increase from 42ms (cold HNSW) to 1247ms (slow query).

## Decision

Add a composite index on (key, updated_at DESC) to enable index-seek instead of full scan.

```sql
CREATE INDEX idx_memory_key_pattern 
  ON memory_entries(key, updated_at DESC);
```

## Consequences

- SessionStart recall: 1247ms → 42ms (96.6% improvement)
- Index size: ~2MB (negligible vs 150MB table)
- Index maintenance: < 1ms per insert (write-once-per-session)
- Database size: +2MB permanent

## Measurement

Before (commit abc123):
- P50: 1247ms
- P95: 3100ms
- P99: 8200ms (outlier: table lock contention)

After (commit def456):
- P50: 42ms
- P95: 180ms
- P99: 600ms (outlier: HNSW index cold)

Improvement: 96.6% faster recall (1247ms → 42ms).
EOF

# Store ADR in memory
sqlite3 .swarm/memory.db << 'EOF'
INSERT INTO memory_entries (key, namespace, value)
VALUES (
  'adrstatus-0YYY',
  'default',
  json_object(
    'adrId', '0YYY',
    'status', 'accepted',
    'dateAccepted', '2026-09-11',
    'title', 'Index memory_entries for fast project-state recall',
    'file', 'docs/adr/0YYY-index-memory-recall-performance.md',
    'governs', json_array('.swarm/memory.db', '~/.claude/hooks/agentdb-ensure.sh'),
    'reviewScore', 95,
    'improvement', '96.6% (1247ms → 42ms)'
  )
);
EOF

# Commit the index creation
git commit -m "Performance: Index memory_entries.key for 96.6% faster SessionStart recall (ADR-0YYY)

Before: P50 1247ms (full table scan)
After: P50 42ms (index seek)

Improvement measured over 50 runs. Index size 2MB. Wired to ADR-0YYY."
```

---

## Use Case 4: Rollback a Decision (Supersede ADR)

**Scenario:** ADR-0XXX decided to use "mesh topology." After 2 weeks in production, you measure 73% gossip overhead. You decide to roll back to hierarchical (ADR-0YYY supersedes ADR-0XXX).

### Measure the Problem

```javascript
// Production metrics show mesh topology is inefficient
const metrics = {
  gossipOverhead: '73%',
  latency_p99: '450ms',
  cpuUsage: '85% (routing gossip)',
  issue: 'High resource usage under 50+ concurrent agents'
};

// Store the problem finding
await memoryStore.write({
  key: 'observation-mesh-topology-overhead',
  value: {
    observation: 'Mesh topology has unexpected 73% gossip overhead',
    context: 'Measured in production with 50+ concurrent agents',
    metrics: metrics,
    references: {
      issue: '#123 (High CPU usage)',
      pr: '#456 (Mesh topology implementation)',
      adr: 'ADR-0XXX'
    },
    nextStep: 'Evaluate hierarchical topology as alternative'
  }
});
```

### Make the Rollback Decision

```javascript
// Write hierarchical as new ADR (supersedes mesh)
const newAdr = {
  adrId: '0YYY',
  title: 'Switch to hierarchical coordinator (supersedes mesh)',
  status: 'Accepted',
  supersedes: ['ADR-0XXX'],
  rationale: 'Mesh topology measured 73% gossip overhead; hierarchical achieves 8% in testing',
  evidence: {
    meshMetrics: metrics,
    hierarchicalBench: 'scripts/bench-hierarchical.mjs',
    comparison: 'Gossip: 73% → 8% (91% reduction)'
  },
  rollback: 'Took 2 weeks to identify problem; recommend measuring this before next topology change'
};

// Store decision
await memoryStore.write({
  key: 'adrstatus-0YYY',
  value: newAdr
});

// Mark old decision as superseded
await memoryStore.write({
  key: 'adrstatus-0XXX',
  value: {
    status: 'superseded',
    supersededBy: 'ADR-0YYY',
    dateSuperseeded: new Date().toISOString(),
    reason: 'Mesh topology measured 73% gossip overhead; hierarchical is more efficient',
    lesson: 'Measure performance impact before deciding architecture; dont wait 2 weeks'
  }
});

// Store lesson for future decisions
await memoryStore.write({
  key: 'lesson-measure-before-architecture',
  value: {
    lesson: 'Measure performance of architectural decision before committing code',
    context: 'ADR-0XXX (mesh) was implemented before measuring; took 2 weeks to discover 73% overhead',
    alternative: 'Prototype and measure both options (mesh vs hierarchical) in parallel before decision',
    improvement: 'Would have saved 2 weeks of wasted work and 50+ hours of high-CPU production time'
  }
});
```

### Implement Rollback

```bash
# Write new ADR file
cat > docs/adr/0YYY-hierarchical-coordinator.md << 'EOF'
---
id: ADR-0YYY
title: Switch to hierarchical coordinator (replaces mesh topology)
status: Accepted
date: 2026-09-11
supersedes: [ADR-0XXX]
relates: [ADR-0XXX]
---

# ADR-0YYY

## Context

ADR-0XXX chose mesh topology. After 2 weeks in production, we measured 73% gossip overhead
under 50+ concurrent agents. This is unsustainable.

## Decision

Switch to hierarchical coordinator topology.

Measured improvement: gossip overhead 73% → 8% (91% reduction).
EOF

# Implement hierarchical topology (revert mesh code, apply hierarchical)
# git checkout plugin/coordinator.mjs  (revert mesh changes)
# vim plugin/coordinator.mjs  (apply hierarchical changes)

# Run tests (must pass at new topology)
npm test

# Commit with full context
git commit -m "Rollback: Mesh topology → hierarchical coordinator (ADR-0XXX → ADR-0YYY)

Reason: Mesh measured 73% gossip overhead; hierarchical achieves 8% in testing

Before (mesh): 73% overhead, P99 450ms, CPU 85%
After (hierarchical): 8% overhead, P99 8ms, CPU 12%

Measured over 50 concurrent agents. Incident: #123. Lesson stored: lesson-measure-before-architecture.

Supersedes ADR-0XXX. Wired to ADR-0YYY."

git push origin main
```

---

## Use Case 5: Cross-Host Resume (Laptop → Workstation)

**Scenario:** You were working on your laptop but need to switch to your workstation. Memory recall gets you back in 30 seconds.

### On Laptop: Export State

```bash
# Before you leave (or after session ends, automatic)
cd /Users/stuartkerr/Code/ruvnet-brain

# Verify latest checkpoint exists
sqlite3 .swarm/memory.db \
  "SELECT key, updated_at FROM memory_entries WHERE key LIKE 'project-state-current%' ORDER BY updated_at DESC LIMIT 1;"

# Export full memory
ruflo memory export --path .swarm/memory.db > memory-laptop-2026-09-11-afternoon.json

# Verify export
wc -l memory-laptop-2026-09-11-afternoon.json
# Output: 4521 entries

# Transfer to workstation
scp memory-laptop-2026-09-11-afternoon.json stuartkerr@workstation:/tmp/
```

### On Workstation: Resume

```bash
# Step 1: Import memory from laptop
cd /Users/stuartkerr/Code/ruvnet-brain
ruflo memory import \
  --source /tmp/memory-laptop-2026-09-11-afternoon.json \
  --target .swarm/memory.db

# Step 2: Verify import
sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries;"
# Output: 4521 (same as laptop)

# Step 3: Start Claude Code on workstation
# SessionStart automatically recalls...
```

### SessionStart on Workstation

```javascript
// SessionStart runs...

// 1. Recall memory
const checkpoint = await memoryStore.read({ key: 'project-state-current' });

console.log('Recalled from laptop session:');
console.log('  Branch:', checkpoint.value.branch);
console.log('  Goal:', checkpoint.value.goal);
console.log('  Next action:', checkpoint.value.nextAction);
console.log('  Completed work:', checkpoint.value.completed.length, 'items');

// Output:
// Recalled from laptop session:
//   Branch: feature/hierarchical-coordinator
//   Goal: Build hierarchical coordinator for 50+ concurrent agents
//   Next action: Finish coordinator implementation; write integration tests
//   Completed work: 4 items
```

### Continue Work

```bash
# Workstation has exact same state as laptop
# - Same branch checked out
# - Same uncommitted changes visible to git
# - Same project goal and next action recalled from memory

# Continue where you left off
npm test
# (Run tests from where you paused)

# Finish implementation...
# Commit...

# Workstation will capture checkpoint at session end
# If you switch back to laptop, memory will be fresh there too
```

---

## Summary: What These Examples Show

| Use Case | Key Lesson |
|----------|-----------|
| **Use Case 1** | Checkpoints span multiple sessions; no manual context switching needed |
| **Use Case 2** | Lessons learned in one session are available to the team immediately |
| **Use Case 3** | ADRs lock in decisions and prevent regression (if you optimize something, the ADR keeps it optimized) |
| **Use Case 4** | ADRs are never deleted, only superseded; full history is preserved for audit |
| **Use Case 5** | Memory is portable; switch hosts, and your work continues without loss |

All examples use the same underlying mechanism: **append-only memory snapshots** that are automatically captured at session end and automatically recalled at session start.

---

## See Also

- [Developer Guide: Memory API](DEVELOPER-GUIDE-MEMORY-API.md) — Detailed API reference
- [Runbook: Memory Procedures](RUNBOOK-MEMORY-PROCEDURES.md) — Step-by-step for each operation
- [ADR-073: Perennial Project Continuity](docs/adr/0073-agentdb-perennial-project-continuity.md) — The binary contract these examples rely on
