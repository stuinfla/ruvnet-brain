#!/bin/sh
# memdb-health.sh — AgentDB (.swarm/memory.db) drift probe.
# Exit 0 = healthy or absent; exit 1 = UNHEALTHY (integrity failure or journal-mode drift).
# Context: idx_bridge_key/idx_bridge_ns corruption recurred 3x on 2026-07-09/10 while the DB
# was in WAL mode — so this probe exists to catch BOTH integrity damage early AND any writer
# that flips the DB out of WAL (a persistent, database-level switch any connection can make).
DB="${1:-.swarm/memory.db}"
[ -f "$DB" ] || { echo "memdb-health: SKIP ($DB not found)"; exit 0; }
JM=$(sqlite3 "$DB" "PRAGMA journal_mode;" 2>/dev/null)
IC=$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>/dev/null | head -1)
echo "memdb-health: journal_mode=$JM integrity=$IC"
[ "$JM" = "wal" ] && [ "$IC" = "ok" ] && exit 0
echo "memdb-health: UNHEALTHY — journal_mode=$JM integrity=$IC (repair: sqlite3 $DB 'REINDEX;' then re-check; escalate to .recover if still bad)" >&2
exit 1
