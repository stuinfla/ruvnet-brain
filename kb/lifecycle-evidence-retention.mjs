import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TERMINAL_REFRESH = new Set(['SUCCEEDED', 'FAILED', 'ABANDONED']);
const TERMINAL_TRANSACTION = new Set(['NOOP', 'COMMITTED', 'ROLLED_BACK']);
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const PHASE_FILE = /^\d{3}-[A-Z_]+\.json$/;
const QUARANTINE = /^\.prune-[A-Za-z0-9._-]+-[a-f0-9]{16}$/;

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
  return { value: JSON.parse(fs.readFileSync(file, 'utf8')), bytes: stat.size };
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

function scanRefresh(root, unsafe) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const name of fs.readdirSync(root).sort()) {
    const file = path.join(root, name);
    if (QUARANTINE.test(name)) {
      unsafe.push({ path: file, reason: 'recognized pruning quarantine remains' });
      continue;
    }
    try {
      if (!name.endsWith('.json')) throw new Error('unexpected refresh evidence entry');
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

function scanTransactions(root, unsafe) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    if (QUARANTINE.test(name)) {
      unsafe.push({ path: dir, reason: 'recognized pruning quarantine remains' });
      continue;
    }
    try {
      const stat = fs.lstatSync(dir);
      if (!SAFE_ID.test(name) || !stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('malformed transaction evidence entry');
      }
      const names = fs.readdirSync(dir).sort();
      if (!names.length || names.some((file) => !PHASE_FILE.test(file))) throw new Error('transaction phase inventory is malformed');
      const phases = names.map((file) => regularJson(path.join(dir, file)).value);
      const latest = phases.at(-1);
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
    for (const entry of [path.dirname(root), root]) {
      const stat = fs.lstatSync(entry);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('evidence root is not a trusted directory (symbolic or special entry)');
    }
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') unsafe.push({ path: root, reason: error.message });
    return false;
  }
}

function snapshot(options) {
  const roots = rootsFor(options);
  const unsafe = [];
  const refresh = trustedEvidenceRoot(roots.refresh, unsafe) ? scanRefresh(roots.refresh, unsafe) : [];
  const transactions = trustedEvidenceRoot(roots.transactions, unsafe) ? scanTransactions(roots.transactions, unsafe) : [];
  const preserveRefresh = new Set((options.preserveRefreshRunIds || []).map(String));
  const preserveTransactions = new Set((options.preserveTransactionPaths || []).map((entry) => path.resolve(entry)));
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
      const relative = path.relative(roots.transactions, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        unsafe.push({ path: row.path, reason: `forged external transaction reference: ${String(reference)}` });
      } else retainedTransactionPaths.add(resolved);
    }
  }
  const protectedTransactions = new Map();
  for (const row of transactions) {
    if (!TERMINAL_TRANSACTION.has(row.latest.state)) protectedTransactions.set(row.path, `nonterminal ${row.latest.state}`);
    if (preserveTransactions.has(row.path)) protectedTransactions.set(row.path, 'explicitly preserved transaction');
    if (retainedTransactionPaths.has(row.path)) protectedTransactions.set(row.path, 'referenced by retained refresh receipt');
  }
  const bytes = [...refresh, ...transactions].reduce((sum, row) => sum + row.bytes, 0)
    + unsafe.filter(({ reason }) => /quarantine remains/.test(reason)).reduce((sum, { path: entry }) => {
      try { return sum + treeBytes(entry); } catch { return sum; }
    }, 0);
  return { roots, unsafe, refresh, transactions, bytes, protectedRefresh, protectedTransactions };
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
  fs.renameSync(resolved, quarantine);
  afterQuarantine?.({ entry: resolved, quarantine });
  removeEntry(quarantine);
}

export function pruneLifecycleEvidence(options = {}) {
  const policy = options.policy || LIFECYCLE_EVIDENCE_RETENTION_POLICY;
  const removeEntry = options.removeEntry || ((entry) => fs.rmSync(entry, { recursive: true, force: true }));
  // A prior invocation's quarantine name is not proof of ownership of its current
  // bytes. Preserve it as unsafe, measured evidence; only this invocation may remove
  // the exact entry it just quarantined. Recovery must not guess away private data.
  const initial = assessLifecycleEvidence({ ...options, policy });
  const removed = { refresh: [], transactions: [] };
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
    quarantineAndRemove(candidate.path, root, removeEntry, options.afterQuarantine);
    removed[candidate.kind === 'refresh' ? 'refresh' : 'transactions'].push(candidate.path);
  }
  const final = assessLifecycleEvidence({ ...options, policy });
  return { ...final, before: initial.before, removed,
    after: final.after, withinBudget: final.withinBudget };
}
