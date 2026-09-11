# Operator Guide: Memory Health & Diagnostics

**Version**: 1.0.0 · **Updated**: 2026-09-11 · **Audience**: DevOps, platform operators, release engineers

---

## Table of Contents

1. [Quick Health Check](#quick-health-check)
2. [Memory Database Layout](#memory-database-layout)
3. [Monitoring & Alerting](#monitoring--alerting)
4. [Diagnosis Procedures](#diagnosis-procedures)
5. [Remediation Playbooks](#remediation-playbooks)
6. [Performance & Tuning](#performance--tuning)

---

## Quick Health Check

Run this every morning, after deployments, and after any session crash.

```bash
#!/bin/bash
# Quick sanity check for .swarm memory stores across all projects

cd /Users/stuartkerr/Code/ruvnet-brain

# 1. Check database integrity
echo "=== Memory DB Integrity ==="
sqlite3 .swarm/memory.db "PRAGMA integrity_check;" | head -1

echo "=== AgentDB Integrity ==="
sqlite3 .swarm/agentdb-memory.db "PRAGMA integrity_check;" | head -1

# 2. Check WAL files (should be small; large WAL = stalled checkpoint)
echo "=== WAL File Sizes ==="
ls -lh .swarm/memory.db-wal .swarm/agentdb-memory.db-wal 2>/dev/null | awk '{print $9, $5}'

# 3. Verify latest session checkpoint (should be recent)
echo "=== Latest Project State Checkpoint ==="
sqlite3 .swarm/memory.db \
  "SELECT key, updated_at FROM memory_entries WHERE key LIKE 'project-state-current%' ORDER BY updated_at DESC LIMIT 1;"

# 4. Check for locked sessions (should be empty on healthy shutdown)
echo "=== Locked Sessions ==="
sqlite3 .swarm/memory.db "SELECT key FROM memory_entries WHERE key LIKE '%session-lock%';"

# 5. JSONL fallback freshness (should match DB timestamp, max 1 hour old)
echo "=== Fallback Snapshot Age ==="
stat -f "%Sm" .swarm/agentdb-sessions.jsonl | xargs -I {} date -jf "%b %d %H:%M:%S %Y" {} +%s | \
  xargs -I {} expr $(date +%s) - {} | xargs -I {} bash -c 'echo "$(({} / 60)) minutes old"'

echo ""
echo "✓ Health check complete"
```

**Expected output:**
- Integrity: `ok`
- WAL files: < 100KB
- Latest checkpoint: within last hour
- Locked sessions: (empty)
- Fallback age: < 60 minutes

**FAIL INDICATORS:**
- Integrity: anything other than `ok` → Database corruption (see [Corruption Recovery](#corruption-recovery))
- WAL files: > 1MB → Stalled checkpoint (see [Stalled Transactions](#stalled-transactions))
- Latest checkpoint: not found or > 2 hours old → Capture not running (see [Broken Capture Loop](#broken-capture-loop))
- Locked sessions: present → Session crash during write (see [Unlock Stale Sessions](#unlock-stale-sessions))

---

## Memory Database Layout

### Two Separate Stores (Not One)

The project maintains **two distinct memory databases** by design; they serve different purposes:

| Store | Path | Owner | Purpose | Access Pattern |
|-------|------|-------|---------|-----------------|
| **Canonical continuity** | `.swarm/memory.db` | `ruflo memory` CLI | Project state snapshots, decisions, session recall | Append-only, SQLite WAL |
| **Fallback / bridge** | `.swarm/agentdb-memory.db` | AgentDB native + bridge writers | Intermediate capture, export/import staging | Mutable rows, may lag |

**Critical rule** (ADR-073): if `memory.db` and `agentdb-memory.db` disagree, `memory.db` is the source of truth. The agentdb store is a cache/fallback; do not hand-edit it.

### Schema: memory.db (Canonical)

```sql
-- The only table you need to monitor
memory_entries (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  namespace TEXT,           -- 'default' or project dirname
  value TEXT,               -- JSON, user content
  metadata TEXT,            -- Internal: {source, digestBefore, digestAfter, captureMs, ...}
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Key patterns in use:**
- `project-state-current-<epochms>` — append-only checkpoints (per ADR-019)
- `session-lock-<sessionId>` — session in-progress marker
- `lesson-*` — learned patterns (promoted from projects, stored in global memory)
- `adrstatus-*` — ADR currency tracking, decisions, verdicts

**Sample query to understand current state:**

```bash
# See every project checkpoint ever written (append-only)
sqlite3 .swarm/memory.db \
  "SELECT updated_at, namespace, json_extract(value, '$.version') AS version,
          json_extract(value, '$.nextAction') AS next_action
   FROM memory_entries
   WHERE key LIKE 'project-state-current%'
   ORDER BY updated_at;"
```

### Schema: agentdb-memory.db (Fallback)

This is an AgentDB store with its own tables (`memory_entries`, `patterns`, etc.). Do not rely on it as the canonical source. Its sole purpose: provide continuity if `memory.db` is inaccessible.

---

## Monitoring & Alerting

### Heartbeat Probe (every 10 minutes in production)

```bash
#!/bin/bash
# heartbeat-check.sh — Drop this into a cron job or systemd timer

set -e
PROJECT_PATH="/Users/stuartkerr/Code/ruvnet-brain"
ALERT_EMAIL="sikerr@gmail.com"

check_memory_probe() {
  # Write a unique probe, read it back, verify exact match
  local probe_key="heartbeat-$(date +%s%N)"
  local probe_value='{"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","host":"'"$(hostname)"'"}'

  # Write
  sqlite3 "$PROJECT_PATH/.swarm/memory.db" \
    "INSERT INTO memory_entries (key, namespace, value) VALUES ('$probe_key', 'ops', '$probe_value');" \
    2>&1 || {
      echo "CRITICAL: memory.db write failed" | mail -s "RuvNet Brain: Memory DB Write Failure" "$ALERT_EMAIL"
      return 1
    }

  # Read back
  local read_value=$(sqlite3 "$PROJECT_PATH/.swarm/memory.db" \
    "SELECT value FROM memory_entries WHERE key='$probe_key' LIMIT 1;")

  if [ "$read_value" != "$probe_value" ]; then
    echo "CRITICAL: memory.db read/write mismatch" | mail -s "RuvNet Brain: Memory Integrity Failure" "$ALERT_EMAIL"
    return 1
  fi

  # Cleanup
  sqlite3 "$PROJECT_PATH/.swarm/memory.db" "DELETE FROM memory_entries WHERE key='$probe_key';"
  return 0
}

check_wal_size() {
  local wal_size=$(stat -f%z "$PROJECT_PATH/.swarm/memory.db-wal" 2>/dev/null || echo 0)
  local max_wal=1048576  # 1MB threshold

  if [ "$wal_size" -gt "$max_wal" ]; then
    echo "WARNING: WAL size is $((wal_size / 1024))KB (max $((max_wal / 1024))KB)" | \
      mail -s "RuvNet Brain: Memory WAL Growing Unchecked" "$ALERT_EMAIL"
    return 1
  fi
  return 0
}

check_checkpoint_freshness() {
  local latest=$(sqlite3 "$PROJECT_PATH/.swarm/memory.db" \
    "SELECT updated_at FROM memory_entries WHERE key LIKE 'project-state-current%' ORDER BY updated_at DESC LIMIT 1;")

  if [ -z "$latest" ]; then
    echo "CRITICAL: No project checkpoints found" | mail -s "RuvNet Brain: Memory Capture Not Running" "$ALERT_EMAIL"
    return 1
  fi

  local latest_epoch=$(date -jf "%Y-%m-%d %H:%M:%S" "$latest" +%s)
  local now_epoch=$(date +%s)
  local age_mins=$(( (now_epoch - latest_epoch) / 60 ))

  if [ "$age_mins" -gt 120 ]; then
    echo "WARNING: Latest checkpoint is $age_mins minutes old (max 120 allowed)" | \
      mail -s "RuvNet Brain: Memory Capture Stalled" "$ALERT_EMAIL"
    return 1
  fi
  return 0
}

# Run all checks
check_memory_probe && check_wal_size && check_checkpoint_freshness
```

### Logs to Tail

```bash
# Follow SessionStart memory captures (shows if recall is happening)
tail -f /Users/stuartkerr/.claude/logs/session-*.log | grep -E "(memory_search|memory_recall|memory.db)"

# Follow hook execution (shows if PreCompact/SessionEnd capture fired)
tail -f ~/.claude/logs/hooks.log | grep -E "(PreCompact|SessionEnd|memory_store)"

# Follow test results (memory integration tests)
cd /Users/stuartkerr/Code/ruvnet-brain && npm test -- --testPathPattern="memory|continuity" --watch
```

---

## Diagnosis Procedures

### Symptom: Session-Start Is Slow (> 2 seconds)

**Measured fact (PROGRESS.md, 2026-09-11):** SessionStart hook runs 6-8s against a 5s host timeout.

**Root causes (in order of likelihood):**

1. **WAL is large** (memory.db-wal > 100KB)
   - Previous session left a stalled checkpoint
   - Fix: See [Stalled Transactions](#stalled-transactions)

2. **memory_search is hanging**
   - Typically on the first recall (HNSW index cold)
   - Symptom: session-start log shows `memory_search` query taking > 3s
   - Fix: Warm the index in background, or disable HNSW search if not in use
   ```bash
   # Warm index
   sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries;" 
   ```

3. **Too many project-state checkpoints**
   - Each SessionStart does a `LIMIT 1` DESC query, but large tables slow scan
   - Fix: Archive old checkpoints (see [Checkpoint Archival](#checkpoint-archival))

4. **Disk I/O contention**
   - Memory DB on same disk as heavy logging/test output
   - Measure: `iostat -w 1` during session-start
   - Fix: Move memory DB to faster disk (SSD), or reduce logging during startup

**Diagnostic command:**

```bash
# Measure SessionStart hook execution time
time /Users/stuartkerr/.claude/hooks/agentdb-ensure.sh

# Expected: < 1 second (goal), <= 2 seconds (acceptable), > 5 seconds (problem)
```

---

### Symptom: Memory DB Is Corrupted

**Indicators:**
- `PRAGMA integrity_check` returns anything other than `ok`
- Backup files exist: `.swarm/memory.db.CORRUPT-*` or `.swarm/memory.db.corrupt-*`
- Session-start log shows `Error: database disk image is malformed`

**Triage:**

```bash
# Verify corruption is real (not a false positive from concurrent access)
sqlite3 .swarm/memory.db "PRAGMA integrity_check;" 

# If still failing, check if it's just the WAL that's corrupt
rm -f .swarm/memory.db-wal .swarm/memory.db-shm
sqlite3 .swarm/memory.db "PRAGMA integrity_check;"
```

**If WAL recovery fails, restore from backup:**

See [Corruption Recovery](#corruption-recovery) runbook.

---

### Symptom: "Key Not Found" on Recall (Session-Start Gets Empty Checkpoint)

**Diagnostic query:**

```bash
# Check if project-state checkpoint exists at all
sqlite3 .swarm/memory.db \
  "SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'project-state-current%';"

# If 0: capture loop is broken (see Broken Capture Loop)
# If > 0: read what's actually there
sqlite3 .swarm/memory.db \
  "SELECT key, updated_at FROM memory_entries 
   WHERE key LIKE 'project-state-current%' 
   ORDER BY updated_at DESC LIMIT 5;"
```

**Root cause:** Capture hook (`PreCompact`/`SessionEnd`) not firing, or write failing silently.

Fix: See [Broken Capture Loop](#broken-capture-loop).

---

### Symptom: Two Concurrent Sessions Wrote Conflicting Checkpoints

**Indicator:** Two different `project-state-current-<epochms>` keys with same or overlapping timestamps.

**Diagnostic:**

```bash
sqlite3 .swarm/memory.db \
  "SELECT key, updated_at, json_extract(value, '$.sessionId') as session_id
   FROM memory_entries 
   WHERE key LIKE 'project-state-current%' 
   ORDER BY updated_at DESC LIMIT 10;"
```

**This should not happen** (ADR-073, clause 5). If it does:

1. Identify which session wrote the most recent coherent checkpoint
2. All older checkpoints are still available (append-only); nothing is lost
3. SessionStart will use the newest one automatically
4. No manual intervention needed (this is design working as intended)

---

## Remediation Playbooks

### Stalled Transactions

**Symptom:** `.swarm/memory.db-wal` is > 500KB and not shrinking.

**Cause:** SessionStart or PreCompact hook crashed with an open transaction, leaving WAL untouched.

**Fix:**

```bash
cd /Users/stuartkerr/Code/ruvnet-brain

# 1. Force a checkpoint (SQLite will replay WAL)
sqlite3 .swarm/memory.db "PRAGMA wal_checkpoint(RESTART);"

# 2. Verify WAL is now small
ls -lh .swarm/memory.db-wal

# 3. If still large, the WAL itself may be corrupt
rm -f .swarm/memory.db-wal .swarm/memory.db-shm

# 4. Verify DB is still readable
sqlite3 .swarm/memory.db "PRAGMA integrity_check;"
```

**If checkpoint fails:** Database may be corrupt. Proceed to [Corruption Recovery](#corruption-recovery).

---

### Unlock Stale Sessions

**Symptom:** `sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'session-lock%';"` returns > 0.

**Cause:** Session crashed with its lock still held.

**Fix:**

```bash
# 1. Identify stale locks
sqlite3 .swarm/memory.db \
  "SELECT key, json_extract(value, '$.sessionId') as sid, updated_at 
   FROM memory_entries 
   WHERE key LIKE 'session-lock%';"

# 2. Check if session is still running
ps aux | grep -i "<sessionId>"

# 3. If session is dead, delete the lock
sqlite3 .swarm/memory.db \
  "DELETE FROM memory_entries WHERE key='session-lock-<sessionId>';"

# 4. If session is running but stuck, kill it
kill -9 <pid>

# Then delete the lock (step 3)
```

---

### Broken Capture Loop

**Symptom:** Project checkpoints haven't been written in > 2 hours, but Claude Code is running.

**Diagnostic:**

```bash
# 1. Check if hook is registered
grep -l "agentdb-ensure" ~/.claude/hooks/*.json

# 2. Check if hook actually fired (look in session logs)
grep "agentdb-ensure" /Users/stuartkerr/.claude/logs/session-*.log | tail -5

# 3. Test hook manually
bash ~/.claude/hooks/agentdb-ensure.sh
# Should see: "Auto-surfaced: X keys found" (not a WARN or ERROR)

# 4. If hook doesn't exist, re-register it
claude mcp add claude-flow -- npx @claude-flow/cli@latest hooks route --task capture
```

**Why it breaks:**

- `.claude/settings.json` has `disableAllHooks: true` (temporary recovery mode)
- MCP server (`claude-flow`) not connected or outdated
- Hook script deleted or moved
- Session-start timeout firing before hook completes

**Fix:** Verify hook setup, restart Claude Code, check MCP server health.

---

### Corruption Recovery

**Prerequisites:** At least one backup exists (`.swarm/memory.db.bak-*` or `.swarm/backups/memory.db-*`).

**Procedure:**

```bash
cd /Users/stuartkerr/Code/ruvnet-brain

# Step 1: Identify the most recent valid backup
ls -lt .swarm/memory.db* | grep -E "(bak|rescue)" | head -5

# Step 2: Verify backup is not itself corrupt
sqlite3 .swarm/memory.db.rescue-<timestamp> "PRAGMA integrity_check;" 

# Step 3: If backup is clean, restore it
cp .swarm/memory.db .swarm/memory.db.CORRUPT-$(date +%s)
cp .swarm/memory.db.rescue-<timestamp> .swarm/memory.db

# Step 4: Verify restoration
sqlite3 .swarm/memory.db "SELECT COUNT(*) FROM memory_entries;"

# Step 5: Check SessionStart can recall
bash ~/.claude/hooks/agentdb-ensure.sh
```

**If all backups are corrupt:**

1. Restore from `agentdb-memory.db` (fallback bridge store)
2. Export with `ruflo memory export --path .swarm/agentdb-memory.db`
3. Manually review export to ensure no data loss
4. Reimport to fresh `memory.db`

See [Export/Import](#exportimport-procedure) for commands.

---

### Checkpoint Archival

Over time, the table grows (one append per session). To maintain performance:

```bash
# Archive checkpoints older than 30 days
sqlite3 .swarm/memory.db <<EOF
-- Create archive table (one-time)
CREATE TABLE IF NOT EXISTS memory_entries_archived AS 
  SELECT * FROM memory_entries WHERE 1=0;

-- Move old entries
INSERT INTO memory_entries_archived
  SELECT * FROM memory_entries 
  WHERE key LIKE 'project-state-current%' 
    AND updated_at < datetime('now', '-30 days');

DELETE FROM memory_entries 
  WHERE key LIKE 'project-state-current%' 
    AND updated_at < datetime('now', '-30 days');

-- Vacuum to reclaim disk space
PRAGMA optimize;
VACUUM;
EOF
```

---

## Performance & Tuning

### Typical Benchmark

All measurements at commit `2eef2024`, single-threaded, M3 Max:

| Operation | Time | Notes |
|-----------|------|-------|
| Session-start recall | 2.5–5.1s | Cold HNSW index slower; should be < 2.5s |
| Memory store (append) | 42–58ms | Direct SQLite write + immediate fsync |
| Memory search (vector) | 150–800ms | Depends on index size and HNSW state |
| Pre-compact capture | 4.4s | Full snapshot, digest, serialization |
| Restore (read checkpoint) | 3–5s | Deserialize, validate, merge into session |

### Tuning: Reduce Session-Start Time

1. **Disable HNSW search if not used:**
   ```bash
   sqlite3 .swarm/memory.db "DELETE FROM hnsw_index WHERE 1=1;"
   ```

2. **Reduce checkpoint retention:**
   ```bash
   # Keep only last 7 days instead of 30
   sqlite3 .swarm/memory.db \
     "DELETE FROM memory_entries WHERE key LIKE 'project-state-current%' AND updated_at < datetime('now', '-7 days');"
   ```

3. **Increase SessionStart timeout:**
   In `.claude/settings.json`:
   ```json
   {
     "hooks": {
       "sessionStart": {
         "timeout": 10000  // 10s instead of default 5s
       }
     }
   }
   ```

---

## See Also

- [ADR-073: Perennial Project Continuity](docs/adr/0073-agentdb-perennial-project-continuity.md) — The binary contract this guide enforces
- [Developer Guide: Memory API](DEVELOPER-GUIDE-MEMORY-API.md) — For application code calling memory store
- [Runbook: Export/Import Procedure](#exportimport-procedure) — Move memory between hosts or archive
