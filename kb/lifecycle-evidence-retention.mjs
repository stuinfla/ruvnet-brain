import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { physicalPath } from './refresh-run.mjs';

const TERMINAL_REFRESH = new Set(['SUCCEEDED', 'FAILED', 'ABANDONED']);
const TERMINAL_TRANSACTION = new Set(['NOOP', 'COMMITTED', 'ROLLED_BACK']);
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const PHASE_FILE = /^\d{3}-[A-Z_]+\.json$/;
const QUARANTINE = /^\.prune-[A-Za-z0-9._-]+-[a-f0-9]{16}$/;
// refresh-run.mjs atomicJson(): `<runId>.json.tmp-<pid>-<8 hex>`, written, fsynced, then renamed (#434).
const ATOMIC_TEMP = /^([A-Za-z0-9._-]+)\.json\.tmp-(\d+)-([a-f0-9]{8})$/;
// The write+rename takes milliseconds; a temp this old was abandoned by a crash or a failed write,
// whatever its PID (PIDs are reused, so the age is the evidence, not process liveness).
export const ABANDONED_TEMP_AGE_MS = 60 * 60 * 1000;
// Files an operating system or a file browser drops into any folder it shows (Finder, exFAT/SMB shadows,
// Explorer). They are never evidence and never ours to judge: ignored, and removed when a plain file.
const VOLUME_METADATA = /^(?:\.DS_Store|\._.*|Thumbs\.db|desktop\.ini)$/i;
export const isVolumeMetadata = (name) => VOLUME_METADATA.test(String(name));

export const LIFECYCLE_EVIDENCE_RETENTION_POLICY = Object.freeze({
  schemaVersion: 1,
  policyId: 'lifecycle-evidence-v1',
  maxRefreshReceipts: 32,
  maxTransactionDirectories: 16,
  maxEvidenceBytes: 16 * 1024 * 1024,
});

function rootsFor({ brainHome, kbDir }) {
  const home = path.resolve(brainHome || path.dirname(path.resolve(kbDir || '')));
  const live = path.resolve(kbDir || path.join(home, 'kb'));
  return { refresh: path.join(home, 'refresh-runs'),
    transactions: path.join(path.dirname(live), `.${path.basename(live)}.update-transactions`) };
}

function regularJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a trusted regular file');
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('evidence is not valid UTF-8');
  return { value: JSON.parse(text), bytes: stat.size };
}

function treeBytes(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error('symbolic link is not trusted evidence');
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw new Error('special file is not trusted evidence');
  let bytes = 0;
  for (const name of fs.readdirSync(root)) bytes += treeBytes(path.join(root, name));
  return bytes;
}

function stamp(value, label) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) throw new Error(`${label} has no valid semantic timestamp`);
  return parsed;
}

/**
 * An abandoned atomic-write temporary (#434) is classified, not treated as foreign evidence. It is
 * reclaimable only when it is an exclusive regular file older than ABANDONED_TEMP_AGE_MS and either
 * empty or shadowed by a valid canonical receipt of the same run; a young one is an in-flight write
 * (left alone), and a non-empty orphan with no canonical receipt is preserved as unsafe.
 */
function classifyAtomicTemp(root, file, match, nowMs, unsafe, temporaries) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('atomic-write temporary is not an exclusive regular file');
  const identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  const row = { path: file, runId: match[1], writerPid: Number(match[2]), bytes: stat.size, identity,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  if (!(nowMs - stat.mtimeMs >= ABANDONED_TEMP_AGE_MS)) { temporaries.push({ ...row, disposition: 'in-flight' }); return; }
  let canonical = false;
  try {
    const { value } = regularJson(path.join(root, `${match[1]}.json`));
    canonical = value?.kind === 'ruvnet-brain-refresh-run' && value.runId === match[1];
  } catch { /* no valid canonical receipt */ }
  if (stat.size !== 0 && !canonical) {
    unsafe.push({ path: file, reason: 'abandoned atomic-write temporary has content and no canonical receipt; preserved' });
    return;
  }
  temporaries.push({ ...row, disposition: 'abandoned', canonicalReceipt: canonical });
}

/**
 * A `.prune-<id>-<16 hex>` entry is the rename quarantineAndRemove() makes immediately before it deletes.
 * Only an interruption between the two leaves one behind (a time-limit kill of the updater is the realistic
 * cause, 4.7.21 RC2.3). It is reclaimed when it is older than ABANDONED_TEMP_AGE_MS (no prune is still
 * between rename and delete), has the exact shape this module quarantines (a plain file under refresh-runs;
 * a directory of phase files under the transactions root), and the run it came from is not live again
 * (its canonical entry is absent or terminal). Anything else stays unsafe and is preserved, as before.
 */
function classifyQuarantine(root, entry, name, kind, nowMs, unsafe, quarantines) {
  const preserve = (reason) => unsafe.push({ path: entry, reason });
  try {
    const stat = fs.lstatSync(entry);
    const ageMs = nowMs - Math.max(stat.mtimeMs, stat.ctimeMs);
    if (!(ageMs >= ABANDONED_TEMP_AGE_MS)) return preserve('recognized pruning quarantine remains');
    const id = /^\.prune-(.+)-[a-f0-9]{16}$/.exec(name)[1];
    if (kind === 'refresh') {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return preserve('recognized pruning quarantine remains (not a quarantined receipt)');
      try {
        const { value } = regularJson(path.join(root, `${id}.json`));
        if (!TERMINAL_REFRESH.has(value?.status)) return preserve('recognized pruning quarantine remains (its run is active)');
      } catch (error) { if (error?.code !== 'ENOENT') return preserve('recognized pruning quarantine remains (its run receipt is unreadable)'); }
    } else {
      if (!stat.isDirectory() || stat.isSymbolicLink()) return preserve('recognized pruning quarantine remains (not a quarantined transaction)');
      const names = fs.readdirSync(entry).filter((file) => !isVolumeMetadata(file));
      if (names.some((file) => !PHASE_FILE.test(file))) return preserve('recognized pruning quarantine remains (not a quarantined transaction)');
      if (fs.existsSync(path.join(root, id))) return preserve('recognized pruning quarantine remains (its transaction is present)');
    }
    quarantines.push({ path: entry, kind, id, bytes: treeBytes(entry), identity: { dev: stat.dev, ino: stat.ino } });
  } catch (error) { preserve(`recognized pruning quarantine remains (${error.message})`); }
}

function scanRefresh(root, unsafe, temporaries = [], nowMs = Date.now(), extras = { quarantines: [], foreign: [], volumeMetadata: [] }) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    if (isVolumeMetadata(name)) { extras.volumeMetadata.push(file); continue; }
    if (QUARANTINE.test(name)) {
      classifyQuarantine(root, file, name, 'refresh', nowMs, unsafe, extras.quarantines);
      continue;
    }
    const temp = ATOMIC_TEMP.exec(name);
    if (temp) {
      try { classifyAtomicTemp(root, file, temp, nowMs, unsafe, temporaries); } catch (error) { unsafe.push({ path: file, reason: error.message }); }
      continue;
    }
    try {
      if (!name.endsWith('.json')) {
        // Not evidence and not ours (a note, a copy someone made): reported and kept, never a reason to
        // fail an update. Only a non-file (directory, link, device) stays unsafe.
        const stat = fs.lstatSync(file);
        if (stat.isFile() && !stat.isSymbolicLink()) { extras.foreign.push({ path: file, bytes: stat.size }); continue; }
        throw new Error('unexpected refresh evidence entry');
      }
      const { value: receipt, bytes } = regularJson(file);
      const runId = name.slice(0, -5);
      if (!SAFE_ID.test(runId) || receipt?.schemaVersion !== 3 || receipt?.kind !== 'ruvnet-brain-refresh-run'
        || receipt.runId !== runId || !['RUNNING', 'SETTLING', ...TERMINAL_REFRESH].includes(receipt.status)) {
        throw new Error('malformed refresh receipt identity or state');
      }
      rows.push({ kind: 'refresh', id: runId, path: file, bytes,
        timestamp: stamp(receipt.finishedAt || receipt.startedAt, `refresh ${runId}`), receipt });
    } catch (error) { unsafe.push({ path: file, reason: error.message }); }
  }
  return rows;
}

function scanTransactions(root, unsafe, nowMs = Date.now(), extras = { quarantines: [], foreign: [], volumeMetadata: [] }) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (isVolumeMetadata(name)) { extras.volumeMetadata.push(dir); continue; }
    if (QUARANTINE.test(name)) {
      classifyQuarantine(root, dir, name, 'transaction', nowMs, unsafe, extras.quarantines);
      continue;
    }
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isFile() && !stat.isSymbolicLink()) { extras.foreign.push({ path: dir, bytes: stat.size }); continue; }
      if (!SAFE_ID.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('malformed transaction evidence entry');
      }
      const all = fs.readdirSync(dir).sort();
      for (const file of all) if (isVolumeMetadata(file)) extras.volumeMetadata.push(path.join(dir, file));
      const names = all.filter((file) => !isVolumeMetadata(file));
      if (!names.length || names.some((file) => !PHASE_FILE.test(file))) throw new Error('transaction phase inventory is malformed');
      const phases = names.map((file) => regularJson(path.join(dir, file)).value);
      const latest = phases.at(-1);
      if (phases.some((phase, index) => phase?.schemaVersion !== 1
        || phase.kind !== 'ruvnet-brain-storage-transaction-phase' || phase.transactionId !== name
        || phase.sequence !== index + 1 || names[index] !== `${String(index + 1).padStart(3, '0')}-${phase.state}.json`)) {
        throw new Error('transaction phase identity is malformed');
      }
      if (latest?.kind !== 'ruvnet-brain-storage-transaction-phase' || latest.transactionId !== name
        || latest.sequence !== names.length || typeof latest.state !== 'string') {
        throw new Error('transaction phase identity is malformed');
      }
      rows.push({ kind: 'transaction', id: name, path: dir, bytes: treeBytes(dir),
        timestamp: stamp(latest.recordedAt, `transaction ${name}`), latest });
    } catch (error) { unsafe.push({ path: dir, reason: error.message }); }
  }
  return rows;
}

function transactionReferences(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (Object.hasOwn(value, 'transactionReceipts') && value.transactionReceipts !== null) {
    output.push(value.transactionReceipts);
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) transactionReferences(nested, output);
  return output;
}

function newest(rows, predicate) {
  return rows.filter(predicate).sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id))[0] || null;
}

function trustedEvidenceRoot(root, unsafe) {
  try {
    // The PARENT is where the user put the brain (`~/.cache/ruvnet-brain` may be a link to another disk):
    // it must be a directory once resolved. The evidence root itself must not be a link.
    if (!fs.statSync(physicalPath(path.dirname(root))).isDirectory()) throw new Error('evidence root parent is not a directory');
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('evidence root is not a trusted directory (symbolic or special entry)');
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') unsafe.push({ path: root, reason: error.message });
    return false;
  }
}

function snapshot(options) {
  const roots = rootsFor(options);
  const unsafe = [];
  const temporaries = [];
  const extras = { quarantines: [], foreign: [], volumeMetadata: [] };
  const nowMs = Date.parse((options.now || (() => new Date().toISOString()))());
  const refresh = trustedEvidenceRoot(roots.refresh, unsafe) ? scanRefresh(roots.refresh, unsafe, temporaries, nowMs, extras) : [];
  const transactions = trustedEvidenceRoot(roots.transactions, unsafe) ? scanTransactions(roots.transactions, unsafe, nowMs, extras) : [];
  const preserveRefresh = new Set((options.preserveRefreshRunIds || []).map(String));
  const preserveTransactions = new Set((options.preserveTransactionPaths || []).map((entry) => physicalPath(entry)));
  const protectedRefresh = new Map();
  const protectRefresh = (row, reason) => { if (row) protectedRefresh.set(row.path, reason); };
  for (const row of refresh) {
    if (['RUNNING', 'SETTLING'].includes(row.receipt.status)) protectRefresh(row, `active ${row.receipt.status}`);
    if (preserveRefresh.has(row.id)) protectRefresh(row, 'explicitly preserved refresh run');
  }
  protectRefresh(newest(refresh, (row) => row.receipt.action === 'nightly'), 'newest nightly receipt');
  protectRefresh(newest(refresh, (row) => row.receipt.action === 'update'), 'newest update receipt');
  protectRefresh(newest(refresh, (row) => row.receipt.status === 'FAILED'), 'newest failed receipt');
  protectRefresh(newest(refresh, (row) => row.receipt.status === 'ABANDONED'), 'newest abandoned receipt');

  const retainedTransactionPaths = new Set();
  for (const row of refresh) {
    if (!protectedRefresh.has(row.path)) continue;
    for (const reference of transactionReferences(row.receipt)) {
      const resolved = path.resolve(String(reference || ''));
      // The updater records real paths; the caller may spell the brain through a link. Same space, both sides.
      const relative = path.relative(physicalPath(roots.transactions), physicalPath(resolved));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        unsafe.push({ path: row.path, reason: `forged external transaction reference: ${String(reference)}` });
      } else retainedTransactionPaths.add(physicalPath(resolved));
    }
  }
  const protectedTransactions = new Map();
  for (const row of transactions) {
    if (!TERMINAL_TRANSACTION.has(row.latest.state)) protectedTransactions.set(row.path, `nonterminal ${row.latest.state}`);
    if (preserveTransactions.has(physicalPath(row.path))) protectedTransactions.set(row.path, 'explicitly preserved transaction');
    if (retainedTransactionPaths.has(physicalPath(row.path))) protectedTransactions.set(row.path, 'referenced by retained refresh receipt');
  }
  const bytes = [...refresh, ...transactions, ...temporaries, ...extras.quarantines].reduce((sum, row) => sum + row.bytes, 0)
    + unsafe.filter(({ reason }) => /quarantine remains/.test(reason)).reduce((sum, { path: entry }) => {
      try { return sum + treeBytes(entry); } catch { return sum; }
    }, 0);
  return { roots, unsafe, refresh, transactions, temporaries, bytes, protectedRefresh, protectedTransactions, ...extras };
}

function counts(state) {
  return { refreshReceipts: state.refresh.length, transactionDirectories: state.transactions.length, bytes: state.bytes };
}

function isWithin(state, policy) {
  return state.unsafe.length === 0 && state.refresh.length <= policy.maxRefreshReceipts
    && state.transactions.length <= policy.maxTransactionDirectories && state.bytes <= policy.maxEvidenceBytes;
}

export function assessLifecycleEvidence(options = {}) {
  const policy = options.policy || LIFECYCLE_EVIDENCE_RETENTION_POLICY;
  const state = snapshot(options);
  return { schemaVersion: 1, kind: 'ruvnet-brain-lifecycle-evidence-retention', policy,
    observedAt: (options.now || (() => new Date().toISOString()))(), before: counts(state),
    protected: {
      refresh: [...state.protectedRefresh].map(([entryPath, reason]) => ({ path: entryPath, reason })),
      transactions: [...state.protectedTransactions].map(([entryPath, reason]) => ({ path: entryPath, reason })),
    },
    removable: {
      refresh: state.refresh.filter((row) => TERMINAL_REFRESH.has(row.receipt.status) && !state.protectedRefresh.has(row.path))
        .sort((a, b) => a.timestamp - b.timestamp).map(({ path: entryPath }) => entryPath),
      transactions: state.transactions.filter((row) => TERMINAL_TRANSACTION.has(row.latest.state)
        && !state.protectedTransactions.has(row.path)).sort((a, b) => a.timestamp - b.timestamp)
        .map(({ path: entryPath }) => entryPath),
    },
    abandonedTemporaries: state.temporaries.filter((row) => row.disposition === 'abandoned')
      .map(({ path: entryPath, runId, writerPid, bytes, sha256, canonicalReceipt }) => ({ path: entryPath, runId, writerPid, bytes, sha256, canonicalReceipt })),
    abandonedQuarantines: state.quarantines.map(({ path: entryPath, kind, id, bytes }) => ({ path: entryPath, kind, id, bytes })),
    foreign: state.foreign, volumeMetadata: state.volumeMetadata,
    removed: { refresh: [], transactions: [] }, after: counts(state), unsafe: state.unsafe,
    withinBudget: isWithin(state, policy) };
}

function quarantineAndRemove(entry, root, removeEntry, afterQuarantine) {
  const name = path.basename(entry);
  const resolved = path.resolve(entry);
  if (path.dirname(resolved) !== path.resolve(root) || !SAFE_ID.test(name.replace(/\.json$/, ''))) {
    throw new Error(`refusing unsafe lifecycle evidence removal: ${entry}`);
  }
  const quarantine = path.join(root, `.prune-${name.replace(/\.json$/, '')}-${crypto.randomBytes(8).toString('hex')}`);
  // Vanished since the snapshot (another sweep, the writer itself): already gone, not a failed prune.
  try { fs.renameSync(resolved, quarantine); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  afterQuarantine?.({ entry: resolved, quarantine });
  removeEntry(quarantine);
  return true;
}

// Keep every JSON token (including numeric precision and escaped string spelling).
// Only formatting whitespace is redundant; phase files remain readable by recovery.
function compactTerminalPhases(row) {
  const compacted = [];
  for (const name of fs.readdirSync(row.path).sort()) {
    if (isVolumeMetadata(name)) continue;
    const file = path.join(row.path, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('phase is not an exclusive regular file');
    const originalBytes = fs.readFileSync(file);
    const original = originalBytes.toString('utf8');
    if (!Buffer.from(original, 'utf8').equals(originalBytes)) throw new Error('phase is not valid UTF-8');
    const compact = original.replace(/("(?:\\[\s\S]|[^"\\])*")|[ \t\r\n]+/g, (token, string) => string || '');
    if (Buffer.byteLength(compact) >= stat.size) continue;
    if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(JSON.parse(compact))) throw new Error('phase compaction changed evidence');
    const temporary = `${file}.compact-${crypto.randomBytes(8).toString('hex')}`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', stat.mode & 0o777);
      const replacementStat = fs.fstatSync(descriptor);
      if (replacementStat.uid !== stat.uid || replacementStat.gid !== stat.gid) fs.fchownSync(descriptor, stat.uid, stat.gid);
      fs.fchmodSync(descriptor, stat.mode & 0o777);
      fs.writeFileSync(descriptor, compact);
      fs.futimesSync(descriptor, stat.atimeMs / 1000, stat.mtimeMs / 1000);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      const current = fs.lstatSync(file);
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev
        || current.mode !== stat.mode || current.uid !== stat.uid || current.gid !== stat.gid || current.nlink !== 1
        || !fs.readFileSync(file).equals(originalBytes)) throw new Error('phase changed during compaction');
      fs.renameSync(temporary, file);
      compacted.push(file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }
  return compacted;
}

export const MAX_VANISHED_RETRIES = 64;
export function pruneLifecycleEvidence(options = {}) {
  const policy = options.policy || LIFECYCLE_EVIDENCE_RETENTION_POLICY;
  const removeEntry = options.removeEntry || ((entry) => fs.rmSync(entry, { recursive: true, force: true }));
  // A prior invocation's quarantine name is not proof of ownership of its current
  // bytes. Preserve it as unsafe, measured evidence; only this invocation may remove
  // the exact entry it just quarantined. Recovery must not guess away private data.
  const initial = assessLifecycleEvidence({ ...options, policy });
  const removed = { refresh: [], transactions: [] };
  // #434: reclaim abandoned atomic-write temporaries first (reported with size and sha256, never
  // silent). The file identity is rechecked immediately before it is quarantined.
  const reclaimedTemporaries = [];
  for (const row of snapshot(options).temporaries.filter((entry) => entry.disposition === 'abandoned')) {
    let current;
    // A temp that vanished between the snapshot and this re-check is already gone; it must not throw the whole prune.
    try { current = fs.lstatSync(row.path); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== row.identity.dev
      || current.ino !== row.identity.ino || current.size !== row.identity.size || current.mtimeMs !== row.identity.mtimeMs) continue;
    if (!quarantineAndRemove(row.path, path.dirname(row.path), removeEntry, options.afterQuarantine)) continue;
    reclaimedTemporaries.push({ path: row.path, runId: row.runId, writerPid: row.writerPid, bytes: row.bytes,
      sha256: row.sha256, canonicalReceipt: row.canonicalReceipt });
  }
  // Volume metadata (.DS_Store and friends) is removed when it is a plain file; anything else by that
  // name is left alone (it was never counted as evidence either way).
  const removedVolumeMetadata = [];
  for (const entry of snapshot(options).volumeMetadata) {
    try {
      const stat = fs.lstatSync(entry);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fs.rmSync(entry, { force: true });
      removedVolumeMetadata.push(entry);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  // Abandoned quarantines of this module's own interrupted prunes (classifyQuarantine), identity re-checked
  // immediately before removal and reported, never silent.
  const reclaimedQuarantines = [];
  for (const row of snapshot(options).quarantines) {
    let current;
    try { current = fs.lstatSync(row.path); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (current.isSymbolicLink() || current.dev !== row.identity.dev || current.ino !== row.identity.ino) continue;
    removeEntry(row.path);
    reclaimedQuarantines.push({ path: row.path, kind: row.kind, id: row.id, bytes: row.bytes });
  }
  const compacted = [];
  const compactState = snapshot(options);
  if (!compactState.unsafe.length && compactState.bytes > policy.maxEvidenceBytes) {
    for (const row of compactState.transactions.filter((entry) => TERMINAL_TRANSACTION.has(entry.latest.state))) {
      compacted.push(...compactTerminalPhases(row));
    }
  }
  // Review r2 (4.7.21): an entry that "vanishes" on every rename (a filesystem that keeps listing it, a writer that
  // keeps recreating it) must not spin this loop forever. Bounded; when the bound trips, pruning stops (fails closed:
  // nothing more is removed) and the reason is returned.
  let vanishedRetries = 0; let stopped = null;
  for (;;) {
    const state = snapshot(options);
    if (isWithin(state, policy)) break;
    if (state.unsafe.length) break;
    const refreshCandidates = state.refresh.filter((row) => TERMINAL_REFRESH.has(row.receipt.status)
      && !state.protectedRefresh.has(row.path)).sort((a, b) => a.timestamp - b.timestamp);
    const transactionCandidates = state.transactions.filter((row) => TERMINAL_TRANSACTION.has(row.latest.state)
      && !state.protectedTransactions.has(row.path)).sort((a, b) => a.timestamp - b.timestamp);
    let candidate = state.refresh.length > policy.maxRefreshReceipts ? refreshCandidates[0]
      : state.transactions.length > policy.maxTransactionDirectories ? transactionCandidates[0]
        : [...refreshCandidates, ...transactionCandidates].sort((a, b) => a.timestamp - b.timestamp)[0];
    if (!candidate) break;
    const root = candidate.kind === 'refresh' ? state.roots.refresh : state.roots.transactions;
    if (!quarantineAndRemove(candidate.path, root, removeEntry, options.afterQuarantine)) { // gone: re-snapshot
      vanishedRetries += 1;
      if (vanishedRetries > MAX_VANISHED_RETRIES) {
        stopped = `pruning stopped: lifecycle evidence vanished ${vanishedRetries} times while being removed (last: ${candidate.path}); nothing further was removed`;
        break;
      }
      continue;
    }
    removed[candidate.kind === 'refresh' ? 'refresh' : 'transactions'].push(candidate.path);
  }
  const final = assessLifecycleEvidence({ ...options, policy });
  return { ...final, before: initial.before, removed, reclaimedTemporaries, reclaimedQuarantines, removedVolumeMetadata, compacted,
    after: final.after, withinBudget: final.withinBudget, ...(stopped ? { stopped } : {}) };
}
