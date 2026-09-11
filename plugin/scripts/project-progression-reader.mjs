/**
 * project-progression-reader.mjs — the READ-ONLY fast path for project continuity restoration.
 *
 * WHY THIS EXISTS (measured, not supposed). `restoreProgressionForSession` gives the whole restore
 * SESSION_CONTINUITY_DEADLINE_MS = 2500ms, and every read it performs is a separate `ruflo memory`
 * PROCESS. Measured on this machine (ruflo 3.41.2, Node v24.18.0, warm Transformers cache), in an
 * isolated temp git repo, with `plugin/scripts/project-progression-session-start.mjs` unchanged:
 *
 *     1 snapshot  → restore 923 / 952 / 1001 ms   → "PROJECT CONTINUITY RESTORED"
 *     6 snapshots → restore 2519 / 2530 / 3181 ms → "PROJECT CONTINUITY UNKNOWN" (restore-failed)
 *
 * The cost is O(N) PROCESS SPAWNS: one `memory list` plus one `memory retrieve` per snapshot, each
 * ~400ms of Node + CLI boot. So continuity does not fail loudly on day one — it decays silently as
 * the journal grows, and the seventh checkpoint is the one that switches a project's memory off.
 * A grep of the installed CLI (memory/memory-initializer.js, commands/memory.js, memory/memory-bridge.js)
 * found exactly three memory env switches — CLAUDE_FLOW_DB_PATH, CLAUDE_FLOW_DISABLE_BRIDGE,
 * CLAUDE_FLOW_MEMORY_PATH (plus RUFLO_MEMORY_SCAN_ON_WRITE) — and none of them skips CLI boot, so
 * there is no flag to reach for. The per-call floor stays ~400ms however it is invoked.
 *
 * WHAT THIS DOES. Node 24 ships `node:sqlite`, so the same rows can be read in-process, read-only,
 * in about a millisecond. `~/.claude/hooks/agentdb-ensure.sh` already reads this exact file directly
 * with `sqlite3`, so direct reads of memory.db are the established precedent, not a new liberty.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never writes. `ruflo memory store` remains the ONLY writer
 * of memory.db (upstream #2786/#3155/#3196 keep memory.db and agentdb-memory.db separate on purpose;
 * a second writer is exactly the two-writers-one-path footgun the memory policy exists to stop). It
 * is also strictly a FALLBACK-ABLE optimisation: any reason it cannot answer authoritatively —
 * no node:sqlite, absent file, an encrypted image (CLAUDE_FLOW_ENCRYPT_AT_REST writes an "RFE1"
 * blob, not a SQLite file), a WAL sidecar it cannot open read-only, a schema that is not this one —
 * raises ProgressionReaderUnavailable, and the caller replays the whole operation through the CLI.
 *
 * Reading directly also AVOIDS a hazard the CLI has: `getEntry` bumps access_count and then rewrites
 * the WHOLE database image (memory-initializer.js:3070-3077). Every "read" during a restore is
 * therefore a full-image write under a lock. This path takes no lock and mutates nothing.
 *
 * STRUCTURAL GUARANTEES ARE UNCHANGED, because they are the point of the restore and not negotiable:
 *   • COMPLETE ENUMERATION — one statement returns every active row in the namespace; a count past
 *     the caller's bound is an error, never a silent truncation (the CLI path's own failure mode).
 *   • EXACT KEY/PAYLOAD IDENTITY — rows are fetched by (namespace, key); two active rows sharing one
 *     key is a structural error, not a LIMIT-1 coin toss.
 *   • DIGEST VERIFICATION — untouched: the caller still validates payloadDigest on every snapshot.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

/** Rows that `ruflo memory` itself considers live (memory-initializer.js ACTIVE_MEMORY_ROW_SQL). */
const ACTIVE_ROW_SQL = "(status = 'active' OR status IS NULL)";

/**
 * Every SQLite database file begins with this 16-byte header (sqlite.org/fileformat.html §1.3):
 * the ASCII text "SQLite format 3" followed by one NUL. Built from bytes rather than written as a
 * string escape so no editor, patch tool, or copy-paste can silently turn that NUL into a space —
 * which would make the header never match and quietly disable this whole fast path.
 */
const SQLITE_HEADER = Buffer.concat([Buffer.from('SQLite format 3', 'latin1'), Buffer.of(0)]);

/**
 * Raised when this reader cannot answer AUTHORITATIVELY. It is never a verdict about the data — it
 * means "ask the CLI instead". A structural violation of the guarantees above throws a plain Error,
 * which must propagate: downgrading "two rows claim one key" to a CLI retry would convert a
 * detectable corruption into a silent, successful, wrong restore.
 */
export class ProgressionReaderUnavailable extends Error {
  constructor(reason) {
    super(`canonical progression reader unavailable: ${reason}`);
    this.name = 'ProgressionReaderUnavailable';
    this.reason = reason;
  }
}

/**
 * THE PINNED SCHEMA FINGERPRINT — captured from the REAL canonical store on this machine
 * (ruflo 3.41.2, a real project's own <project>/.swarm/memory.db), not transcribed from source:
 *
 *     PRAGMA user_version                -> 0
 *     PRAGMA table_info(memory_entries)  -> the 18 columns below
 *
 * WHY PIN IT. Reading someone else's table is only safe while it is the table you measured. If a
 * later ruflo renames `content`, adds a second liveness column, or partitions rows, a reader that
 * merely SELECTs would answer confidently and WRONGLY — and the wrong answer here is "this project
 * has no history", which is indistinguishable from a fresh project. So a fingerprint mismatch is not
 * an error: it is this module standing down so the CLI, which OWNS the schema, answers instead.
 * Slower is a cost. Silently empty is a lie.
 */
const SCHEMA_FINGERPRINT = Object.freeze({
  userVersion: 0,
  columns: Object.freeze([
    'access_count', 'content', 'created_at', 'embedding', 'embedding_dimensions', 'embedding_model',
    'expires_at', 'id', 'key', 'last_accessed_at', 'metadata', 'namespace', 'owner_id',
    'provenance_type', 'status', 'tags', 'type', 'updated_at',
  ]),
});

/** The fingerprint this module requires, so the doctor and tests can name it exactly. */
export function expectedSchemaFingerprint() {
  return { userVersion: SCHEMA_FINGERPRINT.userVersion, columns: [...SCHEMA_FINGERPRINT.columns] };
}

function assertSchemaFingerprint(database) {
  let columns;
  let userVersion;
  try {
    columns = database.prepare('PRAGMA table_info(memory_entries)').all().map((row) => String(row.name)).sort();
    userVersion = database.prepare('PRAGMA user_version').get()?.user_version;
  } catch (error) {
    throw new ProgressionReaderUnavailable(`schema mismatch: ${error.message}`);
  }
  if (columns.length === 0) throw new ProgressionReaderUnavailable('schema mismatch: memory_entries is absent');
  if (userVersion !== SCHEMA_FINGERPRINT.userVersion) {
    throw new ProgressionReaderUnavailable(
      `schema fingerprint mismatch: user_version ${userVersion} is not ${SCHEMA_FINGERPRINT.userVersion}`);
  }
  if (columns.join(',') !== SCHEMA_FINGERPRINT.columns.join(',')) {
    const missing = SCHEMA_FINGERPRINT.columns.filter((name) => !columns.includes(name));
    const added = columns.filter((name) => !SCHEMA_FINGERPRINT.columns.includes(name));
    throw new ProgressionReaderUnavailable('schema fingerprint mismatch: memory_entries columns differ'
      + `${missing.length ? ` (missing ${missing.join('/')})` : ''}`
      + `${added.length ? ` (unexpected ${added.join('/')})` : ''}`);
  }
}

let sqliteBinding;
function databaseSync() {
  if (sqliteBinding === undefined) {
    try {
      sqliteBinding = createRequire(import.meta.url)('node:sqlite').DatabaseSync ?? null;
    } catch { sqliteBinding = null; }
  }
  return sqliteBinding;
}

/** True when this Node build exposes node:sqlite at all. Exported for diagnostics and tests. */
export function canonicalReaderSupported() {
  return typeof databaseSync() === 'function';
}

function looksLikeSqliteFile(dbPath) {
  let handle;
  try {
    handle = fs.openSync(dbPath, 'r');
  } catch {
    return false;
  }
  try {
    const head = Buffer.alloc(SQLITE_HEADER.length);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    return read === head.length && head.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    fs.closeSync(handle);
  }
}

function requireKey(value) {
  if (typeof value !== 'string' || !value) throw new Error('malformed progression row: missing key');
  return value;
}

/**
 * Open a read-only view of one canonical memory.db.
 *
 * @returns {{ listKeys: Function, readContent: Function, close: Function }}
 * @throws {ProgressionReaderUnavailable} when the CLI must be used instead.
 */
export function openProgressionReader(dbPath) {
  const DatabaseSync = databaseSync();
  if (typeof DatabaseSync !== 'function') throw new ProgressionReaderUnavailable('node:sqlite is unavailable');
  if (typeof dbPath !== 'string' || !dbPath) throw new ProgressionReaderUnavailable('no canonical store path');
  let stat;
  try { stat = fs.statSync(dbPath); } catch { throw new ProgressionReaderUnavailable('canonical store does not exist'); }
  if (!stat.isFile()) throw new ProgressionReaderUnavailable('canonical store is not a regular file');
  // An encrypted image (CLAUDE_FLOW_ENCRYPT_AT_REST) starts with the vault's "RFE1" magic, so the
  // header check covers encryption, truncation and any other non-SQLite blob in one test — before
  // node:sqlite gets a chance to report the generic "file is not a database".
  if (!looksLikeSqliteFile(dbPath)) throw new ProgressionReaderUnavailable('canonical store is not a plain SQLite image');

  let database;
  try {
    database = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new ProgressionReaderUnavailable(`read-only open failed: ${error.message}`);
  }

  try {
    assertSchemaFingerprint(database);
  } catch (error) {
    try { database.close(); } catch { /* the fingerprint verdict is the news */ }
    throw error;
  }

  const prepare = (sql) => {
    try { return database.prepare(sql); } catch (error) {
      throw new ProgressionReaderUnavailable(`schema mismatch: ${error.message}`);
    }
  };
  let listStatement;
  let readStatement;
  try {
    // Prepared eagerly so an unexpected schema (or a WAL image this process cannot read) is
    // reported as UNAVAILABLE now, before the caller has committed to the fast path.
    listStatement = prepare(`SELECT key FROM memory_entries WHERE ${ACTIVE_ROW_SQL} AND namespace = ? ORDER BY key`);
    readStatement = prepare(`SELECT content FROM memory_entries WHERE ${ACTIVE_ROW_SQL} AND namespace = ? AND key = ?`);
  } catch (error) {
    try { database.close(); } catch { /* the open failure is the news */ }
    throw error;
  }

  const query = (statement, params) => {
    try { return statement.all(...params); } catch (error) {
      throw new ProgressionReaderUnavailable(`read failed: ${error.message}`);
    }
  };

  return {
    /** Every active key in `namespace`, sorted, deduplicated-by-error, bounded. */
    listKeys(namespace, { maxEntries = 10_000 } = {}) {
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive safe integer');
      const rows = query(listStatement, [namespace]);
      if (rows.length > maxEntries) throw new Error('progression enumeration exceeds its bound');
      const keys = [];
      const seen = new Set();
      for (const row of rows) {
        const key = requireKey(row?.key);
        if (seen.has(key)) throw new Error(`duplicate progression key in store: ${key}`);
        seen.add(key);
        keys.push(key);
      }
      return keys;
    },

    /** The exact stored value for one (namespace, key), or null when that row does not exist. */
    readContent(namespace, key) {
      requireKey(key);
      const rows = query(readStatement, [namespace, key]);
      if (rows.length === 0) return null;
      if (rows.length > 1) throw new Error(`duplicate progression key in store: ${key}`);
      const content = rows[0]?.content;
      // A non-text column is not this schema; fall back rather than guess at an encoding.
      if (typeof content !== 'string') throw new ProgressionReaderUnavailable('progression row content is not text');
      return content;
    },

    close() {
      try { database.close(); } catch { /* closing a spent read handle is never news */ }
    },
  };
}

/**
 * Run `work(reader)` against a read-only view, closing it afterwards.
 * Returns `{ ok: true, value }`, or `{ ok: false, reason }` when the CLI must be used instead.
 * Structural errors are NOT converted — they propagate, by design (see ProgressionReaderUnavailable).
 */
export function withProgressionReader(dbPath, work) {
  let reader;
  try {
    reader = openProgressionReader(dbPath);
  } catch (error) {
    if (error instanceof ProgressionReaderUnavailable) return { ok: false, reason: error.reason };
    throw error;
  }
  try {
    return { ok: true, value: work(reader) };
  } catch (error) {
    if (error instanceof ProgressionReaderUnavailable) return { ok: false, reason: error.reason };
    throw error;
  } finally {
    reader.close();
  }
}
