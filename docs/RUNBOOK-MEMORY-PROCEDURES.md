# Runbook: Memory Operations & Procedures

**Version**: 1.0.0 · **Updated**: 2026-09-11 · **Audience**: Operators, DevOps, release engineers, on-call

---

## Table of Contents

1. [Emergency: Restore from Backup](#emergency-restore-from-backup)
2. [Procedure: Fix Concurrent-Write Collision](#procedure-fix-concurrent-write-collision)
3. [Procedure: Diagnose Stale Checkpoints](#procedure-diagnose-stale-checkpoints)
4. [Procedure: Export/Import Memory](#procedure-exportimport-memory)
5. [Procedure: Migrate Memory Between Hosts](#procedure-migrate-memory-between-hosts)
6. [Procedure: ADR Currency Audit](#procedure-adr-currency-audit)
7. [Procedure: SessionStart Performance Tune](#procedure-sessionstart-performance-tune)

---

## Emergency: Restore from Backup

**When to use:** Database is corrupt, OR latest checkpoint was lost, OR need to restore to a prior state.

**Estimated time:** 2–5 minutes

**Risk level:** Low (memory.db is reconstructable; worst case is loss of last 1–2 hours of checkpoints)

### Step 1: Identify the Backup

```bash
cd /Users/stuartkerr/Code/ruvnet-brain

# List all backups (in order of recency)
ls -lt .swarm/memory.db* | grep -E "(bak|rescue)" | head -10

# Expected output:
# -rw------- memory.db.rescue-20260721-151135  15M  Jul 21 15:11
# -rw------- memory.db.bak-20260804-081212     23M  Aug  4 08:12
```

### Step 2: Verify Backup Is Clean

```bash
# Test the backup (do NOT use it yet)
sqlite3 .swarm/memory.db.rescue-20260721-151135 "PRAGMA integrity_check;" 

# Expected: ok
# If you get anything else, try the next backup in the list
```

### Step 3: Rotate the Corrupt DB

```bash
# Rename the current (broken) database
mv .swarm/memory.db .swarm/memory.db.CORRUPT-$(date +%s)

# Also move its WAL and shared memory
rm -f .swarm/memory.db-wal .swarm/memory.db-shm
```

### Step 4: Restore

```bash
# Copy the clean backup
cp .swarm/memory.db.rescue-20260721-151135 .swarm/memory.db

# Verify restoration
sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries;"

# Expected: a number > 0 (shows rows were restored)
```

### Step 5: Validate & Resume

```bash
# Ensure SessionStart can recall
bash ~/.claude/hooks/agentdb-ensure.sh

# Expected output: "Auto-surfaced: X keys found"
# If you see warnings but no errors, it's safe to proceed

# Resume operations
echo "Memory restored from backup. Monitor next session start closely."
```

---

## Procedure: Fix Concurrent-Write Collision

**When to use:** Two sessions wrote conflicting checkpoints (same or overlapping timestamps).

**Estimated time:** 3–8 minutes

**Risk level:** Minimal (design prevents data loss; manual intervention rare)

### Why It Happens

ADR-073 prevents actual collisions via append-only design. However, **if** two sessions somehow write `project-state-current-*` keys with identical timestamps, SessionStart will use the newer one and both are preserved (not lost).

This section covers the manual audit case where you want to verify no corruption occurred.

### Step 1: Identify Overlaps

```bash
# Query all project-state checkpoints (DESC by timestamp)
sqlite3 .swarm/memory.db << 'EOF'
SELECT 
  key, 
  updated_at, 
  json_extract(value, '$.sessionId') as session_id,
  json_extract(value, '$.nextAction') as next_action,
  LENGTH(value) as size_bytes
FROM memory_entries
WHERE key LIKE 'project-state-current%'
ORDER BY updated_at DESC
LIMIT 10;
EOF
```

**Expected output:**
```
project-state-current-1694432100000 | 2026-09-11 12:35:00 | session-abc123 | Commit and push | 2847
project-state-current-1694432095000 | 2026-09-11 12:34:55 | session-def456 | Run tests      | 2906
```

**If you see duplicate timestamps** (e.g., both showing `12:35:00`):

```bash
# Get the exact timestamps
sqlite3 .swarm/memory.db \
  "SELECT DISTINCT updated_at FROM memory_entries 
   WHERE key LIKE 'project-state-current%' 
   GROUP BY updated_at HAVING COUNT(*) > 1;"

# This should return empty (no duplicates expected)
```

### Step 2: Validate Integrity

```bash
# Check the most recent checkpoint is coherent
sqlite3 .swarm/memory.db << 'EOF'
SELECT 
  key,
  json_extract(value, '$.version') as version,
  json_extract(value, '$.committedWorkCount') as committed,
  json_extract(metadata, '$.digestAfter') as digest
FROM memory_entries
WHERE key LIKE 'project-state-current%'
ORDER BY updated_at DESC
LIMIT 1;
EOF
```

### Step 3: If Corruption Detected

If metadata shows mismatched digests (more likely in agentdb-memory.db, not memory.db):

```bash
# Trust memory.db as canonical; agentdb-memory.db is the cache
# No action needed — SessionStart will use memory.db

echo "✓ memory.db is authoritative; agentdb-memory.db is a cache. No action needed."
```

### Step 4: Cleanup (Optional)

If you want to archive very old checkpoints to reduce table size:

```sql
-- Move checkpoints older than 30 days to an archive table
INSERT INTO memory_entries_archived
  SELECT * FROM memory_entries 
  WHERE key LIKE 'project-state-current%' 
    AND updated_at < datetime('now', '-30 days');

DELETE FROM memory_entries 
  WHERE key LIKE 'project-state-current%' 
    AND updated_at < datetime('now', '-30 days');

VACUUM;
```

---

## Procedure: Diagnose Stale Checkpoints

**When to use:** Session-start is not recalling the latest project state, OR "Key not found" errors appear.

**Estimated time:** 2–5 minutes

**Risk level:** Safe (read-only diagnosis)

### Step 1: Check If Checkpoints Exist

```bash
# Count all project-state checkpoints
sqlite3 .swarm/memory.db \
  "SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'project-state-current%';"

# If result is 0: capture loop is broken (see Step 4)
# If result > 0: proceed to Step 2
```

### Step 2: Find the Latest Checkpoint

```bash
# Get the most recent checkpoint with full details
sqlite3 .swarm/memory.db << 'EOF'
SELECT 
  key, 
  updated_at,
  datetime('now') as now,
  CAST((julianday('now') - julianday(updated_at)) * 1440 AS INTEGER) as age_minutes,
  json_extract(value, '$.version') as version,
  json_extract(value, '$.nextAction') as next_action
FROM memory_entries
WHERE key LIKE 'project-state-current%'
ORDER BY updated_at DESC
LIMIT 1;
EOF
```

**Interpret the output:**
- `age_minutes <= 30`: Checkpoint is recent (healthy)
- `age_minutes > 120`: Checkpoint is stale; capture loop is slow or stalled
- `age_minutes > 240`: Checkpoint is very old; capture loop is likely broken

### Step 3: Trace the Capture Loop

If checkpoint is stale, the PreCompact/SessionEnd hook is not running or not writing.

```bash
# Check if hook is registered
grep -l "agentdb-ensure\|memory store" ~/.claude/hooks/*.json | head -5

# Check if hook fired in recent session (look in logs)
tail -50 /Users/stuartkerr/.claude/logs/session-*.log | grep -E "(memory|checkpoint|capture)"

# If no recent logs, check if hooks are disabled
grep "disableAllHooks" ~/.claude/settings.json ~/.claude/settings.local.json
# If true: hooks are temporarily disabled (recovery mode); re-enable when safe
```

### Step 4: If Capture Loop Is Broken

```bash
# Step 4a: Verify hook exists
ls -la ~/.claude/hooks/agentdb-ensure.sh

# Step 4b: Test hook manually
bash ~/.claude/hooks/agentdb-ensure.sh 2>&1

# Expected: "Auto-surfaced: X keys found" (no ERRORs)

# Step 4c: If hook doesn't exist, re-register it
# This is usually done by Claude Code on first run, but if missing:
mkdir -p ~/.claude/hooks

cat > ~/.claude/hooks/agentdb-ensure.sh << 'EOF'
#!/bin/bash
# Hook must call: ruflo memory search + read latest checkpoint
# See DEVELOPER-GUIDE-MEMORY-API.md for the full implementation
LATEST=$(sqlite3 .swarm/memory.db "SELECT value FROM memory_entries WHERE key LIKE 'project-state-current%' ORDER BY updated_at DESC LIMIT 1;" 2>/dev/null)
[ -n "$LATEST" ] && echo "Auto-surfaced: checkpoint found" || echo "No checkpoint found"
EOF

chmod +x ~/.claude/hooks/agentdb-ensure.sh
```

### Step 5: Force a New Checkpoint

If capture is stuck, you can manually trigger one:

```bash
# Simulate what PreCompact hook does
sqlite3 .swarm/memory.db << 'EOF'
INSERT INTO memory_entries (key, namespace, value, metadata)
VALUES (
  'project-state-current-' || strftime('%s%3f', 'now') || '000',
  'default',
  json_object(
    'version', '4.3.21',
    'branch', 'main',
    'nextAction', 'Run tests',
    'completed', json_array('Wrote docs'),
    'timestamp', datetime('now')
  ),
  json_object(
    'source', 'manual-force',
    'captureMs', 42
  )
);
EOF

# Verify write
sqlite3 .swarm/memory.db \
  "SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'project-state-current%';"

# Expected: count increased by 1
```

---

## Procedure: Export/Import Memory

**When to use:** Move memory between hosts, backup before risky changes, or migrate to new project.

**Estimated time:** 1–3 minutes

**Risk level:** Safe (read-only export)

### Export (Full Backup)

```bash
# Export entire memory.db to JSON (human-readable)
ruflo memory export --path .swarm/memory.db > memory-export-$(date +%Y%m%d-%H%M%S).json

# Verify export is valid JSON
python3 -m json.tool memory-export-*.json | head -20

# Typical export: 5–50KB depending on history
```

### Export (Selective)

```bash
# Export only project-state checkpoints
sqlite3 .swarm/memory.db << 'EOF'
.mode json
SELECT * FROM memory_entries 
WHERE key LIKE 'project-state-current%'
ORDER BY updated_at DESC;
EOF
> checkpoints-export.json
```

### Import to New Project

```bash
# 1. Ensure new project has .swarm directory
mkdir -p /path/to/new-project/.swarm

# 2. Import the export
ruflo memory import \
  --source memory-export-20260911-120000.json \
  --target /path/to/new-project/.swarm/memory.db

# 3. Verify import
sqlite3 /path/to/new-project/.swarm/memory.db \
  "SELECT COUNT(*) FROM memory_entries;"

# Expected: same count as original export
```

### Merge Exports (Combine Two Projects' Memories)

If you need to merge two separate project memories (rare):

```bash
# Export both projects
cd /project-a && ruflo memory export --path .swarm/memory.db > export-a.json
cd /project-b && ruflo memory export --path .swarm/memory.db > export-b.json

# Merge JSON (remove duplicates by key)
python3 << 'EOF'
import json

with open('export-a.json') as f:
  a = {entry['key']: entry for entry in json.load(f)}

with open('export-b.json') as f:
  b = {entry['key']: entry for entry in json.load(f)}

# Merge: b overwrites a if key exists
merged = {**a, **b}

with open('export-merged.json', 'w') as f:
  json.dump(list(merged.values()), f)

print(f"Merged {len(a)} + {len(b)} entries → {len(merged)} total")
EOF

# Import merged export
ruflo memory import \
  --source export-merged.json \
  --target /project-a/.swarm/memory.db
```

---

## Procedure: Migrate Memory Between Hosts

**When to use:** Moving project to new machine, switching from local to cloud, or multi-host sync.

**Estimated time:** 5–10 minutes

**Risk level:** Low if done sequentially; higher if simultaneous writes (not recommended)

### Single-Direction Migration (Host A → Host B)

**Host A (source):**

```bash
cd /Users/stuartkerr/Code/ruvnet-brain

# Step 1: Ensure no writes are happening
# (shut down Claude Code, wait for any background jobs)
sleep 30

# Step 2: Export memory
ruflo memory export --path .swarm/memory.db > memory-for-host-b.json

# Step 3: Verify export
sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries;" > count-a.txt
echo "Exported $(cat count-a.txt) entries"

# Step 4: Transfer to Host B
scp memory-for-host-b.json user@host-b:/tmp/
scp count-a.txt user@host-b:/tmp/
```

**Host B (destination):**

```bash
cd /Users/stuartkerr/Code/ruvnet-brain

# Step 5: Import memory
ruflo memory import \
  --source /tmp/memory-for-host-b.json \
  --target .swarm/memory.db

# Step 6: Verify import
sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries;" > count-b.txt

# Step 7: Compare counts
if diff count-a.txt count-b.txt; then
  echo "✓ Migration successful (all entries transferred)"
else
  echo "✗ Migration failed (entry count mismatch)"
  # If count is lower, some entries may have been dropped (check import logs)
fi
```

### Multi-Host Sync (Append-Only)

If you want both hosts to share the same memory.db over a network (NFS, for example):

```bash
# On both hosts, point to shared memory.db
# In ~/.claude/settings.json:
{
  "memory": {
    "path": "/mnt/shared-nfs/ruvnet-brain/.swarm/memory.db"
  }
}

# Rules:
# 1. Only one host writes at a time (coordination required)
# 2. Other hosts set read-only: sqlite3 /mnt/shared-nfs/.swarm/memory.db "PRAGMA query_only = 1;"
# 3. Sync with "write-host writes; all others call PRAGMA wal_checkpoint(RESTART);"
```

---

## Procedure: ADR Currency Audit

**When to use:** Quarterly review, or after major changes to verify ADRs still reflect reality.

**Estimated time:** 15–30 minutes (depends on number of ADRs)

**Risk level:** Read-only; safe

### Step 1: List All ADRs and Their Status

```bash
# Query memory for ADR status
sqlite3 .swarm/memory.db << 'EOF'
SELECT 
  key, 
  json_extract(value, '$.status') as status,
  json_extract(value, '$.dateAccepted') as accepted_date,
  json_extract(value, '$.title') as title
FROM memory_entries
WHERE key LIKE 'adrstatus-%'
ORDER BY json_extract(value, '$.dateAccepted') DESC;
EOF

# Cross-reference with file system
echo "=== ADR Files on Disk ==="
ls docs/adr/*.md | sed 's|docs/adr/||' | sort
```

### Step 2: Verify Each Accepted ADR Is Wired

```bash
# For each ADR, check if files listed in `governs:` actually exist and are tracked

# Example: ADR-073 governs: plugin/scripts/project-progression-contract.mjs
adr_file="docs/adr/0073-agentdb-perennial-project-continuity.md"
governs=$(grep -A20 "^governs:" "$adr_file" | grep "  - " | awk '{print $3}')

for file in $governs; do
  if [ ! -e "$file" ]; then
    echo "WARNING: ADR-073 governs $file (FILE NOT FOUND)"
  else
    echo "✓ $file exists"
  fi
done
```

### Step 3: Check for Stale Governs

```bash
# Find files governed by deleted ADRs (dangerous: unmaintained code)

cd /Users/stuartkerr/Code/ruvnet-brain

# Extract all files from all ADRs' governs: sections
all_governed=$(for adr in docs/adr/*.md; do
  grep -A20 "^governs:" "$adr" | grep "  - " | awk '{print $3}'
done | sort -u)

# Check each file's git history to see which ADR controls it
for file in $all_governed; do
  if ! grep -l "ADR-[0-9]" "$file" 2>/dev/null | head -1; then
    echo "WARNING: File $file is governed by an ADR but doesn't reference it in code comments"
  fi
done
```

### Step 4: Flag Superseded ADRs That Still Have Live Code

```bash
# High risk: old ADR's logic is still in code, but new ADR changed the decision

sqlite3 .swarm/memory.db << 'EOF'
SELECT 
  json_extract(value, '$.adrId') as old_adr,
  json_extract(value, '$.supersededBy') as new_adr,
  json_extract(value, '$.dateSuperseeded') as date
FROM memory_entries
WHERE key LIKE 'adrstatus-%' AND json_extract(value, '$.status') = 'superseded'
ORDER BY json_extract(value, '$.dateSuperseeded') DESC;
EOF

# For each superseded ADR, verify old files were migrated to new ADR
# Example: if ADR-0A was superseded by ADR-0B, check that ADR-0B's governs: includes ADR-0A's files
```

---

## Procedure: SessionStart Performance Tune

**When to use:** SessionStart is taking > 2 seconds (goal < 1 second).

**Estimated time:** 5–15 minutes

**Risk level:** Medium (may impact recall quality if aggressive tuning applied)

### Measure Baseline

```bash
# Time the SessionStart hook
time bash ~/.claude/hooks/agentdb-ensure.sh

# Typical output: real 0m1.234s (good), real 0m5.678s (needs tuning)
```

### Optimization 1: Reduce Checkpoint Table Size

```bash
# Archive old checkpoints (> 60 days)
sqlite3 .swarm/memory.db << 'EOF'
DELETE FROM memory_entries
WHERE key LIKE 'project-state-current%' 
  AND updated_at < datetime('now', '-60 days');

PRAGMA optimize;
VACUUM;
EOF

# Re-measure
time bash ~/.claude/hooks/agentdb-ensure.sh
```

### Optimization 2: Disable HNSW Search (If Not Used)

```bash
# If semantic search is not critical, clear the HNSW index
sqlite3 .swarm/memory.db << 'EOF'
DELETE FROM memory_entries WHERE key LIKE 'hnsw_%';
PRAGMA optimize;
VACUUM;
EOF

# Verify SessionStart still works
bash ~/.claude/hooks/agentdb-ensure.sh
```

### Optimization 3: Add Database Index

```bash
# Index the common query: SELECT ... WHERE key LIKE 'project-state-current%'
sqlite3 .swarm/memory.db << 'EOF'
CREATE INDEX IF NOT EXISTS idx_memory_key_pattern 
  ON memory_entries(key, updated_at DESC);

PRAGMA optimize;
EOF

# Re-measure
time bash ~/.claude/hooks/agentdb-ensure.sh
```

### Optimization 4: Increase SessionStart Timeout

If you've optimized the DB but still can't reach < 2s, accept the real hardware constraint:

```bash
# In ~/.claude/settings.json
{
  "hooks": {
    "sessionStart": {
      "timeout": 10000  // Increase from 5s to 10s
    }
  }
}
```

**Document the reason:**
- `HNSW index cold, 800MB dataset`
- `SSD I/O contention with CI tests`
- `Remote NFS-mounted memory.db`

---

## See Also

- [Operator Guide: Memory Health](OPERATOR-GUIDE-MEMORY-HEALTH.md) — Monitoring and diagnostics
- [Developer Guide: Memory API](DEVELOPER-GUIDE-MEMORY-API.md) — For code using memory store
- [FAQ: Memory & Continuity](FAQ-MEMORY-CONTINUITY.md) — Common questions
