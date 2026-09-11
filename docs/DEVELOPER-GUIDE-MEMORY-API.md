# Developer Guide: Memory API & ADR Workflow

**Version**: 1.0.0 · **Updated**: 2026-09-11 · **Audience**: Application developers, Claude Code agents, solution architects

---

## Table of Contents

1. [Memory API Reference](#memory-api-reference)
2. [Session Recall Pattern](#session-recall-pattern)
3. [Storing Decisions & Lessons](#storing-decisions--lessons)
4. [ADR Workflow & Lifecycle](#adr-workflow--lifecycle)
5. [Common Patterns](#common-patterns)
6. [Testing Memory Operations](#testing-memory-operations)

---

## Memory API Reference

### Write: Store Project State or Decision

**Canonical method:** `ruflo memory store` CLI

```bash
# Store a new checkpoint or decision
ruflo memory store \
  -k "lesson-avoid-semaphore-routing" \
  -n "default" \
  --value '{"learned": "semaphore-based load balancing deadlocked under 50+ concurrent agents; FIFO queue with backpressure works", "date": "2026-09-10", "references": ["commit:abc123", "test:parallel-load"]}'

# Verify it was written (read-back probe)
ruflo memory search -q "avoid-semaphore" --limit 1
```

**In application code** (Node.js / TypeScript):

```typescript
import { createMemoryStore } from '@claude-flow/memory';

const store = createMemoryStore({
  path: '.swarm/memory.db',
  namespace: 'default'
});

// Append a decision
await store.write({
  key: 'decision-router-topology-2026-09-11',
  value: {
    decision: 'Switch from mesh to hierarchical coordinator',
    rationale: 'Mesh topology causes excessive gossip; hierarchical reduces by 73%',
    adopted: true,
    proof: { commit: 'abc123', benchmark: 'scripts/bench-topology.mjs' },
    nextReview: '2026-10-11'
  },
  metadata: {
    source: 'performance-optimization-session',
    severity: 'architecture'
  }
});
```

**Direct SQL** (for batch writes or special cases):

```sql
INSERT INTO memory_entries (key, namespace, value, metadata)
VALUES (
  'decision-feature-xyz',
  'default',
  '{"decision": "...", "status": "pending"}',
  '{"source": "manual", "captureMs": 42}'
);
```

---

### Read: Recall Project State at Session Start

**Pattern in SessionStart hook** (`.claude/hooks/agentdb-ensure.sh`):

```bash
# Query the latest project state checkpoint
latest=$(sqlite3 .swarm/memory.db \
  "SELECT value FROM memory_entries 
   WHERE key LIKE 'project-state-current%' 
   ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)

if [ -n "$latest" ]; then
  echo "Auto-recalled: $latest" | head -c 200
fi
```

**In application code** (Node.js):

```typescript
// Recall the latest project checkpoint
const latest = await store.read({
  key: 'project-state-current'  // Actual query: SELECT max(key LIKE 'project-state-current%')
});

if (latest) {
  console.log('Resuming from:', latest.value.nextAction);
  // Restore session state
  restoreSession(latest.value);
}
```

**Search pattern** (for retrieving by semantic meaning, not exact key):

```bash
# Search for lessons about "semaphore routing"
ruflo memory search -q "semaphore routing deadlock" --limit 3 --namespace default
```

---

### Query: Find Decisions by Pattern

**Exact key lookup** (fastest):

```sql
SELECT value FROM memory_entries 
WHERE key = 'decision-xyz' AND namespace = 'default';
```

**Prefix search** (e.g., all decisions from a session):

```sql
SELECT key, updated_at, value FROM memory_entries 
WHERE key LIKE 'decision-%' 
  AND namespace = 'default'
  AND updated_at > datetime('now', '-7 days')
ORDER BY updated_at DESC;
```

**Vector search** (HNSW-based semantic search, if index is warm):

```bash
# Search embedding space for "how do I handle failures"
ruflo memory search -q "circuit breaker patterns failure recovery" --limit 5
```

---

### Delete: Revoke or Archive

**Soft delete** (mark as superseded, keep for audit):

```sql
UPDATE memory_entries 
SET value = json_set(value, '$.status', 'superseded')
WHERE key = 'decision-old-approach';
```

**Hard delete** (only for duplicates or errors):

```sql
DELETE FROM memory_entries 
WHERE key = 'decision-xyz' 
  AND namespace = 'default';

-- Then verify
PRAGMA wal_checkpoint(RESTART);
```

---

## Session Recall Pattern

Every session start **must** attempt to recall the latest project state before making any decisions. This is the sole mechanism for perennial continuity.

### Recall Sequence (ADR-073)

```
SessionStart
  ├─> Acquire session lock (INSERT session-lock-<sessionId>)
  ├─> Query memory.db for latest project-state-current-*
  ├─> If found:
  │    ├─> Deserialize JSON
  │    ├─> Verify checksums & integrity
  │    └─> Restore session state (plan, completed work, blockers, next action)
  ├─> If not found:
  │    └─> Log WARN, but DO NOT FAIL — start fresh
  └─> Release session lock (DELETE session-lock-<sessionId>)
```

### Example: Manual Recall in Claude Code

```javascript
// At session start, before defining any globals

async function recallProjectState() {
  const store = createMemoryStore({ path: '.swarm/memory.db' });
  
  try {
    // Query the exact checkpoint
    const checkpoint = await store.read({
      key: 'project-state-current'  // Implicitly: LIMIT 1 DESC on keys matching pattern
    });

    if (!checkpoint) {
      console.log('No prior checkpoint found; starting fresh');
      return null;
    }

    // Validate checkpoint integrity
    const digest = checkpoint.metadata?.digestAfter;
    const content = JSON.stringify(checkpoint.value);
    const computed = crypto.createHash('sha256').update(content).digest('hex');

    if (digest && digest !== computed) {
      console.warn('Checkpoint digest mismatch; starting fresh');
      return null;
    }

    console.log('Recalled project state:', {
      nextAction: checkpoint.value.nextAction,
      branch: checkpoint.value.branch,
      completedWork: checkpoint.value.completed?.length || 0
    });

    return checkpoint.value;
  } catch (err) {
    console.error('Recall failed:', err.message);
    return null;
  }
}

// Use at top of script
const prior = await recallProjectState();
```

---

## Storing Decisions & Lessons

### When to Store

**ALWAYS store after:**
- A decision is made (ADR, routing, architecture choice)
- A lesson is learned (fixed a bug, pattern works, approach doesn't)
- A session closes successfully (project checkpoint)
- A significant failure occurs (incident postmortem)

### Storing an ADR

After writing an ADR file and running it through review:

```bash
# 1. Compute the ADR's digest (what was decided, not the markdown details)
export ADR_DIGEST=$(cat docs/adr/0XYZ-title.md | sha256sum | cut -d' ' -f1)

# 2. Store the decision in memory (for fast recall by agents)
ruflo memory store \
  -k "adrstatus-0XYZ" \
  -n "default" \
  --value "{
    \"adrId\": \"0XYZ\",
    \"title\": \"Decision title\",
    \"status\": \"accepted\",
    \"digest\": \"$ADR_DIGEST\",
    \"date\": \"$(date -u +%Y-%m-%d)\",
    \"references\": {
      \"file\": \"docs/adr/0XYZ-title.md\",
      \"proof\": \"commit:abc123def456\"
    }
  }"

# 3. For quick agent lookup (semantic)
ruflo memory store \
  -k "lesson-adr-0XYZ-summary" \
  -n "default" \
  --value "$(cat docs/adr/0XYZ-title.md | head -100)"  # Store decision context
```

### Storing a Lesson (Cross-Project Learning)

When the same pattern is learned independently in multiple projects, promote it to global memory:

```bash
# Project-specific lesson (stays in this project)
ruflo memory store \
  -k "lesson-semaphore-routing-deadlock" \
  -n "ruvnet-brain" \
  --value "{
    \"pattern\": \"load-balancing\",
    \"lesson\": \"Semaphore-based routing deadlocks under concurrent load\",
    \"solution\": \"Use FIFO queue with backpressure instead\",
    \"evidence\": {
      \"commit\": \"2eef2024\",
      \"test\": \"tests/integration/mesh-semaphore-deadlock.test.mjs\",
      \"improvement\": \"50+ concurrent agents now work without deadlock\"
    },
    \"learned_at\": \"2026-09-10T15:30:00Z\"
  }"

# Promote to global (if learned in 2+ independent projects per ADR-G008)
ruflo memory store \
  -k "lesson-semaphore-routing-deadlock" \
  -n "global" \
  --value "... same content ..."
```

This global lesson will auto-surface in every session (see [Lessons Tier 0-2](docs/LESSONS-PROMOTIO.md)).

---

## ADR Workflow & Lifecycle

### 1. Drafting (Pre-Acceptance)

```bash
# Create a new ADR file
cat > docs/adr/0XYZ-title.md << 'EOF'
---
id: ADR-0XYZ
title: My decision title
status: Draft
date: 2026-09-11
authors: [Your Name]
tags: [tag1, tag2]
governs: []  # Leave empty until accepted
supersedes: []
relates: [ADR-0ABC]
---

# ADR-0XYZ — My Decision

## Context
[Problem statement]

## Decision
[What we decided and why]

## Consequences
[Trade-offs and impact]
EOF

# Store as draft (not yet a lesson or decision)
ruflo memory store \
  -k "adrdraft-0XYZ" \
  -n "default" \
  --value "{\"status\": \"draft\", \"file\": \"docs/adr/0XYZ-title.md\", \"reviewers\": []}"
```

### 2. Review (Acceptance Waiting)

```bash
# Update ADR status and collect reviewer feedback
# Reviewers use: bifocal review (Fable 5.1 + GPT-6 Astra, per project protocol)

ruflo memory store \
  -k "adrdraft-0XYZ" \
  -n "default" \
  --value "{
    \"status\": \"under-review\",
    \"file\": \"docs/adr/0XYZ-title.md\",
    \"reviewers\": [
      {\"model\": \"fable-5.1\", \"score\": 72, \"verdict\": \"approved\"},
      {\"model\": \"gpt-6-astra\", \"score\": 68, \"verdict\": \"approved\"}
    ],
    \"decision_due\": \"2026-09-12\",
    \"feedback\": [
      {\"reviewer\": \"fable-5.1\", \"issue\": \"Consider fallback for scenario X\"}
    ]
  }"
```

### 3. Acceptance (Approved & Binding)

```bash
# ADR is approved and becomes a binding decision

# Step 1: Update ADR file to status: Accepted
sed -i '' 's/status: Draft/status: Accepted/' docs/adr/0XYZ-title.md

# Step 2: Add governs: [list of files this ADR controls]
# (This must be done manually; the ADR author knows what code implements it)

# Step 3: Store as accepted decision (binding)
ruflo memory store \
  -k "adrstatus-0XYZ" \
  -n "default" \
  --value "{
    \"adrId\": \"0XYZ\",
    \"title\": \"My decision title\",
    \"status\": \"accepted\",
    \"dateAccepted\": \"2026-09-11\",
    \"reviewScore\": 70,  # Average of reviewers
    \"file\": \"docs/adr/0XYZ-title.md\",
    \"governs\": [\"src/router.ts\", \"plugin/coordinator.mjs\"],
    \"supersedes\": [],
    \"relates\": [\"ADR-0ABC\"]
  }"

# Step 4: Commit (with evidence of review)
git add docs/adr/0XYZ-title.md
git commit -m "ADR-0XYZ: My decision (accepted, reviewed: F5.1:72, GPT6:68)"
```

### 4. Implementation (Code Wired to ADR)

Files listed in ADR's `governs:` field are now bound to that ADR. Their changes must respect the decision.

```bash
# Before merging a change to a governed file, verify it aligns with the ADR

# Example: You want to change src/router.ts, which is governed by ADR-0XYZ
# Query the ADR to understand the constraints

ruflo memory search -q "ADR-0XYZ router topology" --limit 1 | head -c 500
# Output shows: "Must use hierarchical coordinator, not mesh"

# Now implement the change respecting that constraint
# Add a test to prove the change still honors the ADR
```

### 5. Supersession (ADR Replaced)

When a new ADR replaces an old one:

```bash
# Old ADR file (ADR-0ABC)
# Status: Superseded (change in file)

# New ADR file (ADR-0XYZ)
# supersedes: [ADR-0ABC]

# Update memory
ruflo memory store \
  -k "adrstatus-0ABC" \
  -n "default" \
  --value "{
    \"status\": \"superseded\",
    \"supersededBy\": \"ADR-0XYZ\",
    \"dateSuperseeded\": \"2026-09-11\"
  }"

# Files previously governed by ADR-0ABC are now governed by ADR-0XYZ
```

---

## Common Patterns

### Pattern 1: Add a Feature (Store Decision)

```javascript
// After architecture is decided and approved

// Store: "We decided to build feature X as a swarm coordinator"
await store.write({
  key: 'decision-feature-xyz-architecture',
  value: {
    feature: 'Feature XYZ',
    decision: 'Implement as swarm coordinator, not single agent',
    rationale: 'Enables 50+ concurrent tasks without congestion',
    status: 'approved',
    approval: { adr: 'ADR-0XXX', reviewer: 'Stuart Kerr', date: '2026-09-11' },
    nextMilestone: 'Write tests for 50+ concurrent tasks'
  }
});

// After implementation, store: "Feature XYZ is working"
await store.write({
  key: 'decision-feature-xyz-shipped',
  value: {
    feature: 'Feature XYZ',
    status: 'shipped',
    version: '4.4.0',
    proofCommit: '2eef2024',
    metrics: { throughput: '2000 tasks/sec', latency_p99: '150ms' }
  }
});
```

### Pattern 2: Fix a Bug (Store Lesson)

```javascript
// After debugging a real issue

// Symptom: SessionStart hangs 60% of the time
// Root cause: HNSW index checkpoint not atomic
// Solution: WAL checkpoint forced before session-start

// Store this as a lesson so next developer avoids it
await store.write({
  key: 'lesson-hnsw-checkpoint-atomicity',
  value: {
    problem: 'SessionStart hangs when HNSW index checkpoint stalls',
    rootCause: 'WAL not flushed before session-start attempt',
    solution: 'Insert PRAGMA wal_checkpoint(RESTART) before session-start',
    evidence: {
      issue: '#42 (SessionStart timeout)',
      commit: '2eef2024',
      test: 'tests/integration/session-start-timeout.test.mjs',
      improvement: 'P50 session-start time: 2.1s → 0.8s (62% improvement)'
    },
    learned: '2026-09-11'
  }
});
```

### Pattern 3: Rollback a Decision (Supersede ADR)

```javascript
// ADR-0XXX decided "use mesh topology"
// After measuring, mesh has too much gossip (73% overhead)
// Decide to switch to hierarchical (new ADR-0YYY)

// 1. Write new ADR (ADR-0YYY) with supersedes: [ADR-0XXX]
// 2. Update old ADR in memory
await store.update('adrstatus-0XXX', {
  status: 'superseded',
  supersededBy: 'ADR-0YYY',
  reason: 'Mesh topology caused excessive gossip; hierarchical reduces overhead by 73%',
  dateSuperseeded: new Date().toISOString()
});

// 3. Implement new topology per ADR-0YYY
// 4. Store metrics
await store.write({
  key: 'decision-topology-switch-results',
  value: {
    from: 'mesh (ADR-0XXX)',
    to: 'hierarchical (ADR-0YYY)',
    improvement: { gossipOverhead: '73% reduction', latency: '15ms → 8ms' },
    rollback: 'Did not need rollback; hierarchical proved stable immediately'
  }
});
```

---

## Testing Memory Operations

### Unit Test: Write & Read

```javascript
// tests/memory-store.test.mjs
import { createMemoryStore } from '@claude-flow/memory';
import { test, expect } from 'vitest';
import fs from 'fs';

test('memory store: write and read-back', async () => {
  const dbPath = '.swarm/memory.test.db';
  fs.rmSync(dbPath, { force: true });

  const store = createMemoryStore({ path: dbPath });

  // Write
  const key = 'lesson-test-' + Date.now();
  await store.write({
    key,
    value: { message: 'Hello, memory' }
  });

  // Read back
  const result = await store.read({ key });
  expect(result?.value?.message).toBe('Hello, memory');

  // Cleanup
  fs.rmSync(dbPath, { force: true });
});
```

### Integration Test: Session Recall

```javascript
// tests/session-recall.test.mjs
test('session recall: finds latest checkpoint', async () => {
  const store = createMemoryStore({ path: '.swarm/memory.db' });

  // Simulate a session storing a checkpoint
  const checkpoint = {
    sessionId: 'test-session-' + Date.now(),
    nextAction: 'Run tests',
    completedWork: ['Wrote operator guide', 'Fixed WAL checkpoint']
  };

  await store.write({
    key: `project-state-current-${Date.now()}`,
    value: checkpoint
  });

  // Next session recalls it
  const recalled = await store.read({
    key: 'project-state-current'
  });

  expect(recalled?.value?.nextAction).toBe('Run tests');
  expect(recalled?.value?.completedWork?.length).toBe(2);
});
```

### Load Test: Concurrent Writes

```javascript
// tests/concurrent-writes.test.mjs
test('memory store: handles 100 concurrent writes', async () => {
  const store = createMemoryStore({ path: '.swarm/memory.db' });

  const promises = Array.from({ length: 100 }, (_, i) =>
    store.write({
      key: `lesson-concurrent-${i}`,
      value: { index: i }
    })
  );

  // All writes should succeed
  const results = await Promise.all(promises);
  expect(results).toHaveLength(100);
  expect(results.every(r => r.success)).toBe(true);
});
```

---

## See Also

- [Operator Guide: Memory Health](OPERATOR-GUIDE-MEMORY-HEALTH.md) — For monitoring and diagnostics
- [Runbooks: Common Procedures](RUNBOOK-MEMORY-PROCEDURES.md) — Export, import, recovery
- [ADR-073: Perennial Project Continuity](docs/adr/0073-agentdb-perennial-project-continuity.md) — Binary contract
- [ADR-019: Project Progression Contract](docs/ddd/0019-project-continuity-context.md) — Data model
