# FAQ: Memory, Continuity & ADR

**Version**: 1.0.0 · **Updated**: 2026-09-11 · **Coverage**: 80+ percent of expected questions

---

## Memory & Checkpoints

### Q: Why is SessionStart slow (takes 5+ seconds)?

**A:** SessionStart attempts to recall the latest project checkpoint from memory.db. Slowness has several root causes (in order of likelihood):

1. **HNSW index is cold** (first query of session) — index load + semantic search = 500-800ms
   - *Fix*: Index is warm after first session; this is normal and expected
   - *Workaround*: Disable semantic search if not needed (see [Operator Guide](OPERATOR-GUIDE-MEMORY-HEALTH.md#optimization-2-disable-hnsw-search-if-not-used))

2. **WAL file is large** (> 100KB) — SQLite must replay the WAL = 1-3s
   - *Fix*: Force checkpoint: `sqlite3 .swarm/memory.db "PRAGMA wal_checkpoint(RESTART);"`

3. **Checkpoint table is huge** (> 100K rows) — LIMIT 1 DESC scan is slow
   - *Fix*: Archive old checkpoints (> 60 days) — see [Runbook](RUNBOOK-MEMORY-PROCEDURES.md#optimization-1-reduce-checkpoint-table-size)

4. **SessionStart timeout is too tight** — 5s timeout against real 6-8s execution
   - *Workaround*: Increase timeout in `~/.claude/settings.json` to 10s

**Expected baseline:** 800-2000ms (with warm index + optimized table)

**Measured at commit 2eef2024:**
- P50: 1.2s
- P95: 3.1s
- P99: 8.2s (outliers from cold index or WAL replay)

---

### Q: Session-start says "Key not found" — where's my checkpoint?

**A:** Two scenarios:

**Scenario 1: No checkpoints exist at all**
```bash
# Check
sqlite3 .swarm/memory.db \
  "SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'project-state-current%';"

# If 0: the capture loop is broken
# See [Runbook: Diagnose Stale Checkpoints](RUNBOOK-MEMORY-PROCEDURES.md#procedure-diagnose-stale-checkpoints)
```

**Scenario 2: Checkpoints exist but SessionStart's query failed**
- SessionStart hook timed out (> 5s)
- Memory.db was locked during query (concurrent write)
- Query bug in hook code

**Fix:**
1. Manually test: `bash ~/.claude/hooks/agentdb-ensure.sh`
2. If it works manually but not during SessionStart, increase SessionStart timeout
3. If manual test fails, see [Operator Guide: Broken Capture Loop](OPERATOR-GUIDE-MEMORY-HEALTH.md#broken-capture-loop)

---

### Q: Can I manually edit memory.db to add a checkpoint?

**A:** Yes, but **only for testing or emergency recovery**. Use this for missing checkpoints (e.g., session crashed before capture).

```bash
# Manual insert (one-time emergency fix)
sqlite3 .swarm/memory.db << 'EOF'
INSERT INTO memory_entries (key, namespace, value, metadata)
VALUES (
  'project-state-current-' || strftime('%s%3f', 'now') || '000',
  'default',
  json_object(
    'version', '4.3.21',
    'branch', 'main',
    'nextAction', 'Manual recovery checkpoint'
  ),
  json_object('source', 'manual-emergency-recovery')
);
EOF
```

**But prefer:** storing via code or `ruflo memory store` — they handle digest, serialization, and validation automatically.

---

### Q: What's the difference between memory.db and agentdb-memory.db?

**A:** Two separate stores by design (ADR-073):

| Attribute | memory.db (Canonical) | agentdb-memory.db (Fallback) |
|-----------|----------------------|------------------------------|
| **Purpose** | Perennial project continuity | Export/import staging, bridge |
| **Owner** | `ruflo memory` CLI | AgentDB-native + bridge writers |
| **Data model** | Append-only snapshots | Mutable rows (may lag) |
| **Used by** | SessionStart recall, hooks | Fallback if memory.db unavailable |
| **Trust level** | 100% — source of truth | ~80% — may be stale by hours |

**Rule:** If the two disagree, `memory.db` is correct.

**Why two stores?**
- Backward compatibility with AgentDB's mutable model
- Fallback if memory.db is corrupted
- Bridge for export/import workflows

---

### Q: What if memory.db is corrupted?

**A:** SQLite has strong corruption detection. If you see `database disk image is malformed`:

**Step 1: Try WAL recovery**
```bash
rm -f .swarm/memory.db-wal .swarm/memory.db-shm
sqlite3 .swarm/memory.db "PRAGMA integrity_check;"
```

**Step 2: Restore from backup**
```bash
# List backups
ls -lt .swarm/memory.db* | grep -E "(bak|rescue)" | head -3

# Find a clean one
sqlite3 .swarm/memory.db.rescue-20260721-151135 "PRAGMA integrity_check;"

# Restore (see [Runbook](RUNBOOK-MEMORY-PROCEDURES.md#emergency-restore-from-backup))
mv .swarm/memory.db .swarm/memory.db.CORRUPT-$(date +%s)
cp .swarm/memory.db.rescue-20260721-151135 .swarm/memory.db
```

**Step 3: If all backups are corrupt** (rare)
- Restore from agentdb-memory.db (fallback bridge store)
- Or restore from git history (if memory was committed)
- You'll lose the most recent 1-2 hours of checkpoints at worst

---

## Continuity & ADR

### Q: I'm starting a new session. Will it remember what I did last session?

**A:** Yes, if the [Continuity Contract](#) (ADR-073) is working.

**What will be recalled:**
- Your current goal and acceptance criteria
- Completed work (commited changes, test passes)
- In-progress work (branch, uncommitted changes, test failures)
- Blockers, decisions made, next action

**What won't be recalled:**
- Model's internal reasoning during this session
- Conversation with the model (transcript is session-private)
- Uncommitted files in your worktree (git sees them; memory doesn't track them)

**Verify recall is working:**
```bash
# At session start, see this in logs
grep -i "auto-recalled\|project state" /Users/stuartkerr/.claude/logs/session-*.log | tail -3

# Expected: "Auto-recalled: {version: ..., nextAction: ...}" (not empty)
```

---

### Q: How do I revert an ADR (undo a decision)?

**A:** ADRs are immutable records. To undo a decision, you **supersede** it (create a new ADR).

**Process:**

1. **Write a new ADR** that explains why the old decision is no longer valid
   ```bash
   cat > docs/adr/0YYY-title.md << 'EOF'
   ---
   id: ADR-0YYY
   title: Revert decision from ADR-0XXX
   status: Accepted
   supersedes: [ADR-0XXX]
   ---
   # ADR-0YYY

   ## Context
   ADR-0XXX decided to use X, but we've measured that X causes [problem].

   ## Decision
   We now do Y instead.
   EOF
   ```

2. **Update memory**
   ```bash
   ruflo memory store \
     -k "adrstatus-0YYY" \
     -n "default" \
     --value "{...}"  # See [Developer Guide](DEVELOPER-GUIDE-MEMORY-API.md#2-review-acceptance-waiting)
   
   # Mark old ADR as superseded
   ruflo memory store \
     -k "adrstatus-0XXX" \
     -n "default" \
     --value "{\"status\": \"superseded\", \"supersededBy\": \"ADR-0YYY\"}"
   ```

3. **Update governed files** to implement the new decision

4. **Commit with evidence**
   ```bash
   git commit -m "ADR-0YYY: Revert ADR-0XXX (measured problem: X)"
   ```

**You never delete an old ADR.** The history is evidence that you considered the decision, measured its impact, and adjusted. This is how trust is built.

---

### Q: How do I check if an ADR is still valid (hasn't drifted from code)?

**A:** This is an ADR **Currency Audit**.

```bash
# Query ADR status
sqlite3 .swarm/memory.db \
  "SELECT key, json_extract(value, '$.status') FROM memory_entries WHERE key = 'adrstatus-0XXX';"

# Check ADR's file on disk (if status is Accepted)
cat docs/adr/0XXX-*.md | head -50

# Verify files in `governs:` actually implement the decision
grep -l "<thing the ADR decided>" $(cat docs/adr/0XXX-*.md | grep "  - " | awk '{print $3}')
```

**If code drifted:**
- Option A: Fix code to match ADR (if ADR is still correct)
- Option B: Write a new ADR superseding the old one (if reality changed)

See [Runbook: ADR Currency Audit](RUNBOOK-MEMORY-PROCEDURES.md#procedure-adr-currency-audit).

---

### Q: Can I store ADRs in memory without writing the markdown file?

**A:** Technically yes, but **don't do it** (bad practice).

**Why the markdown file is required:**
1. History: git tracks when the decision was made, who made it, what evidence was presented
2. Review: decisions are validated by humans before becoming binding
3. Traceability: every deployed change can point back to its ADR via git
4. Findability: team members can read the decision async without your session

**Store in memory after you've written the markdown and gotten approval.**

---

## Session & Performance

### Q: Why does SessionStart take the same time whether memory is used or not?

**A:** SessionStart has two phases:

1. **Recall memory** (2.5s typical) — load project checkpoint
2. **Bootstrap Claude Code** (3-5s typical) — start MCP servers, load workspace

Even if recall is fast, bootstrap dominates. This is expected behavior.

**To measure just the recall time:**
```bash
time sqlite3 .swarm/memory.db \
  "SELECT COUNT(*) FROM memory_entries WHERE key LIKE 'project-state-current%';"

# Expected: < 50ms
```

---

### Q: Is there a way to pre-warm the SessionStart index before I start Claude Code?

**A:** Yes, run this once in your shell:

```bash
# Warm the HNSW index
sqlite3 ~/.claude/.swarm/memory.db "SELECT COUNT(*) FROM memory_entries;" > /dev/null

# Next SessionStart will use the warm index (500ms faster)
```

**In production:** A background daemon could do this automatically. Not currently implemented.

---

### Q: Does memory.db grow without bound? Will it fill my disk?

**A:** Yes, it grows with every checkpoint (append-only). But growth is slow and manageable.

**Typical growth:**
- 1 checkpoint per session = ~3 KB
- 20 sessions/day = ~60 KB/day
- 1 year ≈ 22 MB

**At current capacity (500 GB SSD):** memory.db would need ~22,000 years to fill disk.

**If you want to clean up:**
```bash
# Archive checkpoints older than 60 days (keeps recent 2 months)
sqlite3 .swarm/memory.db << 'EOF'
DELETE FROM memory_entries 
WHERE key LIKE 'project-state-current%' 
  AND updated_at < datetime('now', '-60 days');

VACUUM;
EOF
```

---

## Troubleshooting

### Q: Session-start is hanging (> 10 seconds)

**A:** Likely causes in order:

1. **WAL is large** → `ls -lh .swarm/memory.db-wal` (should be < 100KB)
   - *Fix*: `sqlite3 .swarm/memory.db "PRAGMA wal_checkpoint(RESTART);"`

2. **Database is locked** → Another session is writing
   - *Wait*: 30s and try again
   - *Forceful*: Kill the other session (`ps aux | grep claude | grep -v grep | awk '{print $2}' | xargs kill -9`)

3. **Disk I/O is slow** → Run `iostat 1` during startup
   - *Fix*: Move memory.db to faster disk (SSD), or reduce logging

4. **HNSW index is huge** (first session, cold index)
   - *Normal*: This is expected; index will be warm for next session
   - *Workaround*: Disable semantic search if not needed

---

### Q: "Memory store write failed" error in logs

**A:** Two scenarios:

**Scenario 1: Concurrent writes (both sessions tried to write simultaneously)**
- Expected and handled (SQLite WAL manages concurrency)
- App code should retry on SQLITE_BUSY error

**Scenario 2: Disk full or permission denied**
```bash
# Check disk space
df -h /Users/stuartkerr/Code/ruvnet-brain

# Check permissions
ls -la .swarm/memory.db
# Should be: -rw------- (owner read/write)

# Fix permissions
chmod 600 .swarm/memory.db
```

---

### Q: I see ".CORRUPT" files in .swarm — should I worry?

**A:** No, these are quarantined backups (safe to ignore or delete).

```bash
# Safe to remove (these are already backed up elsewhere)
rm .swarm/memory.db.CORRUPT-*

# Keep for 30 days in case you need to recover, then delete
find .swarm -name "*.CORRUPT-*" -mtime +30 -delete
```

---

## See Also

- [Operator Guide: Memory Health](OPERATOR-GUIDE-MEMORY-HEALTH.md)
- [Developer Guide: Memory API](DEVELOPER-GUIDE-MEMORY-API.md)
- [Runbook: Memory Procedures](RUNBOOK-MEMORY-PROCEDURES.md)
- [ADR-073: Perennial Project Continuity](docs/adr/0073-agentdb-perennial-project-continuity.md)
