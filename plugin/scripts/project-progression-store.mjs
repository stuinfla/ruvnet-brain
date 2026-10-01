import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProgressionOutbox } from './project-progression-outbox.mjs';
import {
  digestCanonical,
  restoreProjectProgression,
  validateProgressionSnapshot,
} from './project-progression-contract.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';
import { resolveRuflo, rufloInvocation, RUFLO_MISSING } from './ruflo-bin.mjs';

const PROGRESSION_NAMESPACE = 'project-progression';
const RESUME_SCHEMA = 'ruvnet-brain.project-resume';
const RESUME_VERSION = 1;

function defaultRunner(binary, args, options) {
  const invocation = rufloInvocation(binary, args);
  return spawnSync(invocation.executable, invocation.args, { ...options, shell: false });
}

function resultStatus(result) {
  return Number.isInteger(result?.status) ? result.status : 1;
}

function resultText(result, field) {
  const value = result?.[field];
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}

function parseJson(text, label) {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not JSON`); }
}

function plainRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer`);
}

function omissionSummary(value) {
  return {
    count: Array.isArray(value) ? value.length : 1,
    sha256: digestCanonical(value),
  };
}

/**
 * Deterministically reduce a verified resume payload to fit the host context without pretending
 * omitted evidence is empty. The canonical snapshots remain in AgentDB; the projection retains the
 * merged goal/action values, head keys and per-omission digests so the omitted values stay addressable.
 * Returns null when the required resume identity and goal/action alone cannot fit.
 */
export function projectResumePayloadToBound(payload, maxOutputBytes) {
  requirePositiveInteger(maxOutputBytes, 'maxOutputBytes');
  const summary = structuredClone(payload);
  const omissions = [];
  summary.projection = { mode: 'bounded-summary', omitted: omissions };
  const recordOmission = (target, key, pathName) => {
    const value = target[key];
    if (value === undefined) return;
    const digest = omissionSummary(value);
    omissions.push({ path: pathName, ...digest });
    target[key] = { omitted: true, ...digest };
  };
  const size = () => Buffer.byteLength(JSON.stringify(summary), 'utf8');

  // Conflicts are important facts, but their full competing values can dominate the resume context.
  // Keep each conflicting field, its count, and a digest of the exact competing values; top-level
  // head keys remain, and canonical snapshots retain the source values. No winner is chosen.
  if (size() > maxOutputBytes && Array.isArray(summary.state?.resumeConflicts)) {
    const originals = summary.state.resumeConflicts;
    summary.state.resumeConflicts = originals.map((conflict) => ({
      field: conflict.field,
      valueCount: (conflict.values ?? []).length,
      valuesDigest: digestCanonical(conflict.values ?? []),
    }));
    omissions.push({
      path: 'state.resumeConflicts[].values',
      ...omissionSummary(originals.flatMap((conflict) => conflict.values ?? []).map((row) => row.value)),
    });
  }

  if (size() > maxOutputBytes) recordOmission(summary.state, 'journalHeads', 'state.journalHeads');
  // Least central detail first. currentGoal and nextAction are deliberately absent from this list.
  const stateFields = [
    'commands', 'proofArtifacts', 'changedFiles', 'completed', 'untested', 'decisions',
    'plan', 'inProgress', 'blockers', 'failures', 'acceptanceContract', 'provenance',
    'evidence', 'activeStep', 'activeProcess', 'sourceIdentity',
  ];
  for (const field of stateFields) {
    if (size() <= maxOutputBytes) break;
    recordOmission(summary.state, field, `state.${field}`);
  }
  if (size() > maxOutputBytes && summary.evidence) {
    recordOmission(summary, 'evidence', 'evidence');
  }

  // Never clip or replace the user goal or next action. If those plus the identity/omission ledger
  // do not fit, refuse to call this a restore and let SessionStart emit explicit UNKNOWN.
  if (size() > maxOutputBytes) return null;
  return { payload: summary, rendered: JSON.stringify(summary), projected: true };
}

function validatePage(page, { offset, pageSize, total }) {
  if (!plainRecord(page) || !Array.isArray(page.entries)
    || !Number.isSafeInteger(page.total) || page.total < 0
    || page.limit !== pageSize || page.offset !== offset
    || typeof page.hasMore !== 'boolean') {
    throw new Error('malformed pagination page');
  }
  if (total !== null && page.total !== total) throw new Error('pagination total changed during restoration');
  if (page.entries.length > pageSize || offset + page.entries.length > page.total) {
    throw new Error('malformed pagination page');
  }
  const consumed = offset + page.entries.length;
  if (page.hasMore) {
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) {
      throw new Error('non-advancing pagination page');
    }
    if (page.nextOffset !== consumed || consumed >= page.total) throw new Error('malformed pagination page');
  } else if (page.nextOffset !== null || consumed !== page.total) {
    throw new Error('malformed pagination page');
  }
  return page.total;
}

function sortRejected(rows) {
  return rows.sort((left, right) => String(left.eventKey).localeCompare(String(right.eventKey))
    || left.reasons.join('|').localeCompare(right.reasons.join('|')));
}

/**
 * The working directory ruflo runs in. ruflo writes into its cwd on every invocation even when --path
 * names the store (measured 2026-10-01, ruflo 3.49.0): `.claude/`, `.claude-flow/`, `ruvector.db`, and
 * `<cwd>/.swarm/` holding hnsw.metadata.json — the stored snapshot CONTENT — which it also LOADS when it
 * finds one there (ruflo/v3/@claude-flow/cli/src/memory/memory-initializer.ts: getMemoryRoot() = cwd).
 * So the cwd must be:
 *  - never the project tree (it changed the customer's working tree and broke no-op capture detection),
 *    never inside `.swarm` (nested `.swarm/.swarm`);
 *  - PER PROJECT (one shared dir would pool every project's snapshot text and let one project load
 *    another's metadata);
 *  - private and ours: under the Brain's own home (never a shared /tmp name another user could pre-create
 *    or symlink), every directory we create checked to be a real directory, owned by us, mode 0700.
 * Every ruflo call carries --path, so the store it reads and writes is unaffected by the cwd.
 */
export function rufloScratchRoot(env = process.env) {
  if (env.RUVNET_RUFLO_CWD_ROOT) return path.resolve(env.RUVNET_RUFLO_CWD_ROOT);
  return path.join(env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain'), 'ruflo-cwd');
}

/** Create-or-verify one private directory: a real directory (not a link), owned by us, mode 0700. */
export function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`ruflo scratch directory ${dir} is not a real directory (symlink or file); refusing to use it`);
  }
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid()) {
      throw new Error(`ruflo scratch directory ${dir} is owned by uid ${stat.uid}, not ${process.getuid()}; refusing to use it`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
      if ((fs.lstatSync(dir).mode & 0o777) !== 0o700) throw new Error(`ruflo scratch directory ${dir} could not be made private (0700)`);
    }
  }
  return dir;
}

export function rufloCwdFor(storePath, { root = rufloScratchRoot() } = {}) {
  const projectKey = crypto.createHash('sha256').update(path.resolve(storePath)).digest('hex').slice(0, 32);
  fs.mkdirSync(path.dirname(root), { recursive: true });
  ensurePrivateDir(root);
  return ensurePrivateDir(path.join(root, projectKey));
}

/**
 * 4.3.40 ran ruflo with cwd `<project>/.swarm`, so upgraded projects still hold ruflo's cwd artifacts
 * INSIDE the store directory — including `.swarm/.swarm/hnsw.metadata.json`, a copy of snapshot content.
 * Removes exactly those, and only when every path in them is one ruflo is known to write there; anything
 * unexpected (or any symlink) leaves that artifact untouched and is REPORTED. The store itself
 * (memory.db, -wal/-shm, schema.sql), the outbox and queue files are never candidates.
 *
 * The allowlist is measured, not guessed: real ruflo 3.49.0 run with cwd=<dir> and --path elsewhere
 * writes .claude/{memory.db,.proven-config-version,proven-config.json} (init/store),
 * .claude-flow/harness-active-policy.json and .swarm/{hnsw.index,hnsw.metadata.json} and ruvector.db
 * (store), .claude-flow/policy/state.json (retrieve). The owner's real 4.3.40 projects also hold
 * .swarm/.swarm/agentdb-memory.db(-wal,-shm): ruflo's AgentDB bridge opens <cwd>/.swarm/agentdb-memory.db
 * (ruflo/v3/@claude-flow/cli/src/memory/memory-bridge.ts getAgentDbPath), and the native bindings drop
 * ruvector.db into whatever cwd they run in (ruflo/scripts/smoke-memory-no-stray-db.mjs, ADR-125 Phase 7).
 */
const SQLITE = (name) => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`];
const LEGACY_CWD_ARTIFACTS = Object.freeze({
  '.swarm': new Set(['hnsw.index', 'hnsw.metadata.json', ...SQLITE('agentdb-memory.db')]),
  '.claude': new Set(['.proven-config-version', 'proven-config.json', ...SQLITE('memory.db')]),
  '.claude-flow': new Set(['harness-active-policy.json', 'policy/', 'policy/state.json']),
  'ruvector.db': null, // a regular file
});

/** Every path under `dir`, relative, directories with a trailing slash; symlinks reported, never followed. */
function relativeEntries(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const rel = prefix + name;
      if (stat.isSymbolicLink()) out.push({ rel, link: true });
      else if (stat.isDirectory()) { out.push({ rel: `${rel}/` }); walk(full, `${rel}/`); }
      else out.push({ rel, file: stat.isFile() });
    }
  };
  walk(dir, '');
  return out;
}

/**
 * With `dryRun`, reports what WOULD be removed and touches nothing (--doctor). Returns
 * { removed: [paths], refused: [{ path, reason }] }; a refusal must be shown to the user, never dropped.
 */
const IN_USE_MS = 10 * 60_000;
// The files that carry DATA: the database, its WAL and its rollback journal. Never -shm: it is the WAL
// index, and every reader — including this proof's own read-only open — rewrites it. Counting it made
// every real 4.3.40 store look "changed while it was being checked" (and "in use" on the next run).
const dataFiles = (dbPath) => {
  const base = path.basename(dbPath);
  return [base, `${base}-wal`, `${base}-journal`];
};
const sqliteFingerprint = (dbPath) => dataFiles(dbPath).map((name) => {
  try { const st = fs.statSync(path.join(path.dirname(dbPath), name)); return `${name}:${st.size}:${st.mtimeMs}`; }
  catch { return `${name}:absent`; }
});
const sameFiles = (a, b) => a.join('|') === b.join('|');

/**
 * Is every active (namespace, key, content) row of a stray nested AgentDB present, byte-identical, in
 * the canonical store? Read-only through the progression reader (node:sqlite, readOnly — no write, no
 * checkpoint). Anything it cannot prove — recently written (in use), unreadable, a row missing or
 * different — keeps the file and says why.
 */
export function proveMirrored(nestedDb, canonicalDb, { now = Date.now(), maxRows = 100_000 } = {}) {
  const fingerprint = sqliteFingerprint(nestedDb);
  const newest = Math.max(...dataFiles(nestedDb).map((name) => {
    try { return fs.statSync(path.join(path.dirname(nestedDb), name)).mtimeMs; } catch { return 0; }
  }));
  if (now - newest < IN_USE_MS) return { ok: false, reason: `kept: agentdb-memory.db was written ${Math.round((now - newest) / 1000)}s ago (in use)` };
  const nested = withProgressionReader(nestedDb, (reader) => reader.allRows({ maxRows }));
  if (!nested.ok) return { ok: false, reason: `kept: agentdb-memory.db could not be read to prove it is mirrored (${nested.reason})` };
  const canonical = withProgressionReader(canonicalDb, (reader) => reader.allRows({ maxRows }));
  if (!canonical.ok) return { ok: false, reason: `kept: memory.db could not be read to prove agentdb-memory.db is mirrored (${canonical.reason})` };
  const have = new Map(canonical.value.map((row) => [`${row.namespace}\u0000${row.key}`, row.content]));
  const missing = nested.value.filter((row) => row.content === null || have.get(`${row.namespace}\u0000${row.key}`) !== row.content);
  if (missing.length) return { ok: false, reason: `kept: ${missing.length} of ${nested.value.length} rows not in memory.db`, missing: missing.length };
  return { ok: true, rows: nested.value.length, fingerprint };
}

export function cleanLegacyRufloDebris(storeDir, { dryRun = false, now = Date.now() } = {}) {
  const removed = [];
  const refused = [];
  for (const [name, allowed] of Object.entries(LEGACY_CWD_ARTIFACTS)) {
    const entry = path.join(storeDir, name);
    let stat;
    try { stat = fs.lstatSync(entry); } catch { continue; } // absent: nothing to do
    if (stat.isSymbolicLink()) { refused.push({ path: entry, reason: 'symbolic link' }); continue; }
    if (allowed === null) {
      if (!stat.isFile()) { refused.push({ path: entry, reason: 'not a regular file' }); continue; }
    } else {
      if (!stat.isDirectory()) { refused.push({ path: entry, reason: 'not a directory' }); continue; }
      const unknown = relativeEntries(entry).filter((item) => item.link || item.file === false || !allowed.has(item.rel))
        .map((item) => (item.link ? `${item.rel} (symbolic link)` : item.rel));
      if (unknown.length) { refused.push({ path: entry, reason: `unexpected entries: ${unknown.join(', ')}` }); continue; }
    }
    // A nested AgentDB is a real store (owner's projects: 1-41 rows, still written by open 4.3.40
    // sessions). It goes only when every row is PROVEN present, identically, in the canonical memory.db.
    const nestedDb = path.join(entry, 'agentdb-memory.db');
    const mirror = name === '.swarm' && fs.existsSync(nestedDb) ? proveMirrored(nestedDb, path.join(storeDir, 'memory.db'), { now }) : null;
    if (mirror && !mirror.ok) { refused.push({ path: entry, reason: mirror.reason, kept: true }); continue; }
    if (!dryRun) {
      // The proof is only valid for the bytes it read: anything written since means the file is in use.
      if (mirror && !sameFiles(mirror.fingerprint, sqliteFingerprint(nestedDb))) {
        refused.push({ path: entry, reason: 'kept: agentdb-memory.db changed while it was being checked (in use)', kept: true });
        continue;
      }
      fs.rmSync(entry, { recursive: true, force: true });
    }
    removed.push(entry);
  }
  return { removed, refused };
}

// What ruflo leaves in a cwd (measured, ruflo 3.49.0): `.swarm/` (hnsw.index, hnsw.metadata.json — a
// copy of every stored value), `.claude/`, `.claude-flow/`, `ruvector.db`. None of it is read back by the
// product: every call carries --path, and the store of record is that file.
const RUFLO_CWD_ARTIFACTS = Object.freeze(['.swarm', '.claude', '.claude-flow', 'ruvector.db']);
const STALE_RUN_MS = 3_600_000;

/**
 * One ruflo invocation's working directory: a fresh private `run-*` directory inside the project's
 * scratch dir, removed again by the caller after the call. ruflo copies every snapshot it touches into
 * `<cwd>/.swarm/hnsw.metadata.json`; with one cwd per call that copy never accumulates (4.4.0 kept one
 * per project that grew without bound and outlived the project). Also clears what 4.4.0 left directly
 * in the project scratch dir and any `run-*` older than an hour (a call killed before its cleanup).
 */
export function rufloRunDir(storePath, { root = rufloScratchRoot(), now = Date.now() } = {}) {
  const projectScratch = rufloCwdFor(storePath, { root });
  for (const name of fs.readdirSync(projectScratch)) {
    const entry = path.join(projectScratch, name);
    let stat;
    try { stat = fs.lstatSync(entry); } catch { continue; }
    const stale = name.startsWith('run-') && stat.isDirectory() && now - stat.mtimeMs > STALE_RUN_MS;
    if (RUFLO_CWD_ARTIFACTS.includes(name) || stale) fs.rmSync(entry, { recursive: true, force: true });
  }
  return fs.mkdtempSync(path.join(projectScratch, 'run-'));
}

export class ProjectProgressionStore {
  constructor({
    projectDir,
    requestedStorePath,
    rufloBinary = resolveRuflo(),
    runner = defaultRunner,
    clock = () => new Date().toISOString(),
    fsync,
    // The read-only fast path (project-progression-reader.mjs). READS ONLY: `ruflo memory store`
    // stays the sole writer of memory.db. Pass `reader: null` to force every read through the CLI.
    reader = withProgressionReader,
  } = {}) {
    if (!rufloBinary) throw new Error(RUFLO_MISSING);
    this.resolution = resolveProjectStore({ projectDir, requestedStorePath });
    // Best effort: a cleanup that cannot run must never stop a capture or a restore.
    try { this.legacyDebris = cleanLegacyRufloDebris(path.dirname(this.resolution.canonicalAgentDbPath)); }
    catch (error) { this.legacyDebris = { removed: [], refused: [{ path: null, reason: error.message }] }; }
    this.rufloBinary = rufloBinary;
    this.runner = runner;
    this.clock = clock;
    this.reader = typeof reader === 'function' ? reader : null;
    this.lastReadPath = null;
    this.outbox = new ProgressionOutbox({ projectRoot: this.resolution.projectRoot, fsync });
  }

  /**
   * Run one read through the in-process reader, or report that the CLI must serve it.
   * Structural errors propagate unchanged — only "I cannot answer authoritatively" falls back.
   */
  readFast(work) {
    if (!this.reader) return { ok: false, reason: 'reader disabled' };
    return this.reader(this.resolution.canonicalAgentDbPath, work);
  }

  run(args) {
    const cwd = rufloRunDir(this.resolution.canonicalAgentDbPath);
    try {
      return this.runner(this.rufloBinary, args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  validateSnapshot(snapshot) {
    const verdict = validateProgressionSnapshot(snapshot, {
      expectedProjectIdentity: this.resolution.projectIdentity,
    });
    if (!verdict.ok) throw new Error(`invalid progression snapshot: ${verdict.errors.join(', ')}`);
  }

  appendExact(snapshot, { onPhase = () => {} } = {}) {
    this.validateSnapshot(snapshot);
    const stored = this.run([
      'memory', 'store', '--key', snapshot.eventKey, '--value', JSON.stringify(snapshot),
      '--namespace', PROGRESSION_NAMESPACE, '--no-upsert', '--provenance', 'system_observation',
      '--path', this.resolution.canonicalAgentDbPath,
    ]);
    const alreadyStored = resultStatus(stored) !== 0;
    if (!alreadyStored) onPhase('stored');

    // THE READ-BACK, through the fast path when it is available.
    //
    // This is not a shortcut past the verification — it IS the verification, taken by an independent
    // route. Reading the row back with the same CLI process family that just wrote it proves the CLI
    // agrees with itself; reading the bytes off disk with node:sqlite proves the row is really there.
    // It also matters for the budget: a capture boundary gets 8s, and a cold `ruflo memory` call
    // measured ~3s in an isolated HOME (matching the 3.0-3.4s figure from the original report), so
    // replay + capture at two CLI calls each did not fit and left the new snapshot uncommitted in the
    // outbox. One CLI write plus a ~1ms read fits with room to spare. The CLI remains the fallback.
    let readbackText = null;
    const fast = this.readFast((reader) => reader.readContent(PROGRESSION_NAMESPACE, snapshot.eventKey));
    if (fast.ok && typeof fast.value === 'string') {
      this.lastReadPath = 'node:sqlite';
      readbackText = fast.value;
    } else {
      this.lastReadPath = `ruflo-cli (${fast.ok ? 'row absent' : fast.reason})`;
      const retrieved = this.run([
        'memory', 'retrieve', '--key', snapshot.eventKey, '--namespace', PROGRESSION_NAMESPACE,
        '--value-only', '--path', this.resolution.canonicalAgentDbPath,
      ]);
      if (resultStatus(retrieved) !== 0) {
        const storeFailure = alreadyStored
          ? `; store failed: ${resultText(stored, 'stderr').trim() || 'unknown error'}`
          : '';
        throw new Error(`progression readback failed: ${resultText(retrieved, 'stderr').trim() || 'unknown error'}${storeFailure}`);
      }
      readbackText = resultText(retrieved, 'stdout');
    }
    let readback;
    try { readback = JSON.parse(readbackText); } catch { throw new Error('progression readback is not JSON'); }
    if (readback.payloadDigest !== snapshot.payloadDigest || digestCanonical(readback) !== digestCanonical(snapshot)) {
      throw new Error('progression readback digest mismatch');
    }
    onPhase('readback-verified');
    return {
      eventKey: snapshot.eventKey,
      payloadDigest: snapshot.payloadDigest,
      readbackDigest: readback.payloadDigest,
      alreadyStored,
      committedAt: this.clock(),
    };
  }

  capture(snapshot, { onPhase = () => {} } = {}) {
    this.validateSnapshot(snapshot);
    this.outbox.appendSnapshot(snapshot);
    onPhase('outbox-fsynced');
    const receipt = this.appendExact(snapshot, { onPhase });
    this.outbox.markCommitted(receipt);
    return receipt;
  }

  replay() {
    const receipts = [];
    for (const snapshot of this.outbox.pendingSnapshots()) {
      const receipt = this.appendExact(snapshot);
      this.outbox.markCommitted(receipt);
      receipts.push(receipt);
    }
    return receipts;
  }

  listSnapshotKeys({ pageSize = 100, maxEntries = 10_000 } = {}) {
    requirePositiveInteger(pageSize, 'pageSize');
    requirePositiveInteger(maxEntries, 'maxEntries');
    if (pageSize > maxEntries) throw new Error('pageSize exceeds the enumeration bound');
    const fast = this.readFast((reader) => reader.listKeys(PROGRESSION_NAMESPACE, { maxEntries }));
    if (fast.ok) {
      this.lastReadPath = 'node:sqlite';
      return fast.value;
    }
    this.lastReadPath = `ruflo-cli (${fast.reason})`;
    return this.listSnapshotKeysViaCli({ pageSize, maxEntries });
  }

  listSnapshotKeysViaCli({ pageSize = 100, maxEntries = 10_000 } = {}) {
    const keys = [];
    const seen = new Set();
    let offset = 0;
    let total = null;
    let protocol = null;
    let limit = pageSize;
    do {
      const listed = this.run([
        'memory', 'list', '--namespace', PROGRESSION_NAMESPACE,
        '--limit', String(limit), '--offset', String(offset), '--page-info', '--format', 'json',
        '--path', this.resolution.canonicalAgentDbPath,
      ]);
      if (resultStatus(listed) !== 0) {
        throw new Error(`progression structural pagination failed: ${resultText(listed, 'stderr').trim() || 'unknown error'}`);
      }
      const page = parseJson(resultText(listed, 'stdout'), 'progression pagination page');
      const nextProtocol = Array.isArray(page) ? 'array' : 'page';
      if (protocol && protocol !== nextProtocol) throw new Error('enumeration protocol changed during restoration');
      protocol = nextProtocol;
      if (protocol === 'array') {
        // Global Ruflo's CLI returns the first `limit` entries and ignores offset/page-info.
        // Grow from zero until its result is shorter than the requested limit. The current
        // CLI honors limit (memory.js -> listEntries); a full response at our cap is ambiguous
        // and must never become a partial successful restore.
        if (page.length > limit) throw new Error('malformed pagination array');
        const current = new Set();
        for (const entry of page) {
          if (!plainRecord(entry) || typeof entry.key !== 'string' || !entry.key
            || entry.namespace !== PROGRESSION_NAMESPACE) throw new Error('malformed pagination entry');
          if (current.has(entry.key)) throw new Error(`duplicate progression key in array: ${entry.key}`);
          current.add(entry.key);
        }
        if ([...seen].some((key) => !current.has(key))) throw new Error('enumeration keys changed during restoration');
        if (page.length < limit) return [...current].sort();
        if (limit === maxEntries) throw new Error('progression enumeration reached its bound without proving completeness');
        for (const key of current) seen.add(key);
        limit = Math.min(maxEntries, limit * 2);
        continue;
      }
      total = validatePage(page, { offset, pageSize, total });
      if (total > maxEntries) throw new Error('progression enumeration exceeds its bound');
      for (const entry of page.entries) {
        if (!plainRecord(entry) || typeof entry.key !== 'string' || !entry.key
          || entry.namespace !== PROGRESSION_NAMESPACE) throw new Error('malformed pagination entry');
        if (seen.has(entry.key)) throw new Error(`duplicate progression key across pages: ${entry.key}`);
        seen.add(entry.key);
        keys.push(entry.key);
      }
      if (!page.hasMore) break;
      offset = page.nextOffset;
    } while (true);
    if (keys.length !== total) throw new Error('pagination did not enumerate the declared total');
    return keys.sort();
  }

  retrieveSnapshots(keys) {
    // The whole batch through ONE read-only handle, or the whole batch through the CLI. Never a
    // mixture: a half-served batch would make "exactly these rows, read exactly this way" untrue.
    const fast = this.readFast((reader) => {
      const snapshots = [];
      const rejected = [];
      for (const key of keys) {
        const content = reader.readContent(PROGRESSION_NAMESPACE, key);
        if (content === null) throw new Error(`progression exact retrieval failed for ${key}: row not found`);
        let snapshot;
        try { snapshot = JSON.parse(content); } catch {
          rejected.push({ eventKey: key, reasons: ['readback is not JSON'] });
          continue;
        }
        if (!plainRecord(snapshot) || snapshot.eventKey !== key) {
          rejected.push({ eventKey: key, reasons: ['exact key/payload identity mismatch'] });
          continue;
        }
        snapshots.push(snapshot);
      }
      return { snapshots, rejected: sortRejected(rejected) };
    });
    if (fast.ok) {
      this.lastReadPath = 'node:sqlite';
      return fast.value;
    }
    this.lastReadPath = `ruflo-cli (${fast.reason})`;
    return this.retrieveSnapshotsViaCli(keys);
  }

  retrieveSnapshotsViaCli(keys) {
    const snapshots = [];
    const rejected = [];
    for (const key of keys) {
      const retrieved = this.run([
        'memory', 'retrieve', '--key', key, '--namespace', PROGRESSION_NAMESPACE,
        '--value-only', '--path', this.resolution.canonicalAgentDbPath,
      ]);
      if (resultStatus(retrieved) !== 0) {
        throw new Error(`progression exact retrieval failed for ${key}: ${resultText(retrieved, 'stderr').trim() || 'unknown error'}`);
      }
      let snapshot;
      try { snapshot = JSON.parse(resultText(retrieved, 'stdout')); } catch {
        rejected.push({ eventKey: key, reasons: ['readback is not JSON'] });
        continue;
      }
      if (!plainRecord(snapshot) || snapshot.eventKey !== key) {
        rejected.push({ eventKey: key, reasons: ['exact key/payload identity mismatch'] });
        continue;
      }
      snapshots.push(snapshot);
    }
    return { snapshots, rejected: sortRejected(rejected) };
  }

  /** How many durable snapshots are fsynced but not yet committed to the canonical store. */
  pendingReplayCount() {
    try { return this.outbox.pendingSnapshots().length; } catch { return null; }
  }

  /**
   * @param {{ replayPending?: boolean }} options
   *   `replayPending: false` restores from COMMITTED rows only. SessionStart uses it because replay
   *   is a WRITE, a write is a `ruflo memory store` process, and one of those alone costs more than
   *   the entire SessionStart budget — so a restore that replayed would time out and report UNKNOWN
   *   precisely when there was durable evidence to show. Pending work is REPORTED here and replayed
   *   at the next capture boundary (Stop / PreCompact / SessionEnd) or by /checkpoint, which are the
   *   boundaries that already own a write budget. The outbox's fsync-then-commit ordering and its
   *   replay-required semantics are untouched: nothing is dropped, only deferred.
   */
  restoreLatest({ pageSize = 100, maxEntries = 10_000, maxOutputBytes = 64 * 1024,
    replayPending = true, projectToBound = false } = {}) {
    requirePositiveInteger(maxOutputBytes, 'maxOutputBytes');
    if (replayPending) this.replay();
    const pendingReplay = replayPending ? 0 : this.pendingReplayCount();
    const keys = this.listSnapshotKeys({ pageSize, maxEntries });
    const exact = this.retrieveSnapshots(keys);
    const restored = restoreProjectProgression(exact.snapshots, {
      expectedProjectIdentity: this.resolution.projectIdentity,
    });
    const rejectedCandidates = sortRejected([
      ...exact.rejected,
      ...restored.rejected.filter((row) => row.reasons.some((reason) => reason !== 'causally stale')),
    ]);
    if (!restored.ok) {
      const error = new Error('no coherent progression state could be restored');
      error.rejectedCandidates = rejectedCandidates;
      error.structurallyEnumerated = keys.length;
      error.pendingReplay = pendingReplay;
      throw error;
    }
    const payload = {
      schema: RESUME_SCHEMA,
      schemaVersion: RESUME_VERSION,
      projectIdentity: this.resolution.projectIdentity,
      heads: restored.heads,
      state: restored.state,
      evidence: {
        structurallyEnumerated: keys.length,
        exactRetrieved: keys.length,
        causallyStale: restored.causallyStale.length,
        rejectedCandidates,
        readPath: this.lastReadPath,
        pendingReplay,
      },
    };
    let rendered = JSON.stringify(payload);
    let finalPayload = payload;
    let projected = false;
    if (Buffer.byteLength(rendered, 'utf8') > maxOutputBytes) {
      const bounded = projectToBound ? projectResumePayloadToBound(payload, maxOutputBytes) : null;
      if (!bounded) {
        throw new Error(`resume payload${projectToBound ? ' and mandatory bounded summary' : ''}`
          + ` exceeds the ${maxOutputBytes}-byte output bound`);
      }
      ({ payload: finalPayload, rendered, projected } = bounded);
    }
    return { payload: finalPayload, rendered, pendingReplay, projected };
  }
}
