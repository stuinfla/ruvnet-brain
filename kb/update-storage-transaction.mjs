import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATES = Object.freeze([
  'LOCKED',
  'CANDIDATE_BUILDING',
  'CANDIDATE_VERIFIED',
  'NOOP',
  'OLD_RENAME_STARTED',
  'OLD_RENAMED',
  'ACTIVATED',
  'LIVE_VERIFIED',
  'CLEANUP_PENDING',
  'COMMITTED',
  'ROLLED_BACK',
  'RECOVERY_REQUIRED',
]);

function assertDirectory(dir, label) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted directory: ${dir}`);
}

function canonicalEntryInventory(root, prefix = '') {
  const entries = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    const file = path.join(root, relative);
    if (entry.isDirectory()) entries.push(...canonicalEntryInventory(root, relative));
    else if (entry.isFile()) {
      const bytes = fs.readFileSync(file);
      entries.push({ path: relative.split(path.sep).join('/'), type: 'file', bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    } else if (entry.isSymbolicLink()) {
      entries.push({ path: relative.split(path.sep).join('/'), type: 'symlink', target: fs.readlinkSync(file) });
    } else throw new Error(`unsupported filesystem entry in transaction tree: ${relative}`);
  }
  return entries;
}

export function treeIdentity(dir) {
  assertDirectory(dir, 'transaction tree');
  const entries = canonicalEntryInventory(dir);
  const bytes = entries.reduce((total, entry) => total + (entry.bytes || 0), 0);
  return { sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'), bytes,
    fileCount: entries.filter((entry) => entry.type === 'file').length, entries };
}

// SYMLINK POLICY (issues #130/#131, applied here 2026-09-11). This threw on ANY symbolic link, and
// the installed brain always carries one: npm's `node_modules/.bin/semver`. So the already-current
// path in forge-update.mjs (managedStorageInventory at :1141) died on every machine, and the same
// link inside a `kb.bak-*` sibling wedged its inventory. A link that cannot be a store file and
// stays inside the tree is inventory, reported as `symlinkCount`. Two cases still throw, because
// they are what the hardening exists for: a link standing in for a store file, and a link that
// escapes the tree (its target is what a receipt would then silently be measuring).
function trustedTreeSummary(dir, kind) {
  const identity = treeIdentity(dir);
  const root = path.resolve(dir);
  let symlinkCount = 0;
  for (const entry of identity.entries) {
    if (entry.type !== 'symlink') continue;
    const relative = entry.path.split('/').join(path.sep);
    const link = path.join(dir, relative);
    if (/\.rvf$/i.test(relative)) throw new Error(`managed ${kind} tree contains a symbolic link in place of a store file: ${link}`);
    const resolved = path.resolve(root, path.dirname(relative), entry.target);
    if (path.isAbsolute(entry.target) || !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`managed ${kind} tree contains a symbolic link that escapes the tree: ${link} -> ${entry.target}`);
    }
    symlinkCount++;
  }
  return { kind, path: dir, sha256: identity.sha256, bytes: identity.bytes, fileCount: identity.fileCount, symlinkCount };
}

// Installer-retained paths are observations, not transaction-owned cleanup candidates. Count link
// payloads themselves without following targets, including a symlink at the retained root.
function observedInstallerSummary(dir, kind) {
  let bytes = 0; let fileCount = 0; let symlinkCount = 0;
  const visit = (file) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) { symlinkCount++; bytes += Buffer.byteLength(fs.readlinkSync(file)); }
    else if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    else if (stat.isFile()) { fileCount++; bytes += stat.size; }
    else throw new Error(`unsupported installer-retained entry: ${file}`);
  };
  visit(dir);
  return { kind, path: dir, bytes, fileCount, symlinkCount,
    status: kind === 'installer-preserved' ? 'PRESERVED_UNCLASSIFIED' : 'UNRESOLVED_INSTALLER_STATE',
    automaticCleanupEligible: false };
}

export function managedStorageInventory(liveDir, { measuredAt = new Date().toISOString() } = {}) {
  const live = path.resolve(liveDir);
  const parent = path.dirname(live);
  const basename = path.basename(live);
  const fullCorpusCopies = [];
  const evidence = [];
  for (const name of fs.readdirSync(parent).sort()) {
    const file = path.join(parent, name);
    const stat = fs.lstatSync(file);
    const installerKind = name.startsWith(`${basename}.install-preserved-`) ? 'installer-preserved'
      : name.startsWith(`${basename}.install-prior-`) ? 'installer-prior'
        : name.startsWith(`.${basename}.install-stage-`) ? 'installer-stage' : null;
    if (installerKind) {
      fullCorpusCopies.push(observedInstallerSummary(file, installerKind));
      continue;
    }
    const kind = name === basename ? 'active'
      : name.startsWith(`${basename}.next-`) ? 'candidate'
        : name.startsWith(`${basename}.rollback-`) ? 'rollback'
          : name.startsWith(`${basename}.failed-`) ? 'failed'
            : name.startsWith(`${basename}.bak-`) ? 'backup' : null;
    if (kind) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`managed ${kind} entry is not a trusted directory: ${file}`);
      fullCorpusCopies.push(trustedTreeSummary(file, kind));
    } else if ([`.${basename}.update-transactions`, 'refresh-runs'].includes(name)) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`managed evidence entry is not a trusted directory: ${file}`);
      evidence.push(trustedTreeSummary(file, name === 'refresh-runs' ? 'refresh-evidence' : 'transaction-evidence'));
    }
  }
  const active = fullCorpusCopies.find(({ kind }) => kind === 'active') || null;
  const redundant = fullCorpusCopies.filter(({ kind }) => kind !== 'active');
  return { schemaVersion: 1, liveDir: live, active, fullCorpusCopies,
    additionalFullCorpusCopyCount: redundant.length,
    additionalFullCorpusBytes: redundant.reduce((sum, row) => sum + row.bytes, 0),
    evidence, evidenceBytes: evidence.reduce((sum, row) => sum + row.bytes, 0),
    totalManagedBytes: [...fullCorpusCopies, ...evidence].reduce((sum, row) => sum + row.bytes, 0), measuredAt };
}

function optionalTreeIdentity(dir) {
  if (!fs.existsSync(dir)) return { exists: false, sha256: null, bytes: 0, fileCount: 0 };
  const { sha256, bytes, fileCount } = treeIdentity(dir);
  return { exists: true, sha256, bytes, fileCount };
}

const identitySummary = (identity) => identity
  ? { sha256: identity.sha256, bytes: identity.bytes, fileCount: identity.fileCount }
  : { sha256: null, bytes: 0, fileCount: 0 };

export function storageDelta(paths, { prior = null, candidate = null, cleanupPending = null,
  inventoryBefore = null, measuredAt = new Date().toISOString() } = {}) {
  const fullCorpusCopies = Object.fromEntries(['live', 'candidate', 'rollback', 'failed']
    .map((name) => [name, optionalTreeIdentity(paths[name])]));
  const redundant = ['candidate', 'rollback', 'failed'].map((name) => fullCorpusCopies[name])
    .filter(({ exists }) => exists);
  const activeBefore = identitySummary(prior);
  const activeAfter = fullCorpusCopies.live;
  const managedAfter = managedStorageInventory(paths.live, { measuredAt });
  const managedBefore = inventoryBefore;
  return {
    activeBefore,
    activeAfter,
    activeBytesDelta: activeAfter.bytes - activeBefore.bytes,
    expectedCandidate: candidate ? identitySummary(candidate) : null,
    fullCorpusCopies,
    redundantCopyCount: managedAfter.additionalFullCorpusCopyCount,
    redundantBytes: managedAfter.additionalFullCorpusBytes,
    managedBefore,
    managedAfter,
    additionalFullCorpusCopyDelta: managedAfter.additionalFullCorpusCopyCount
      - (managedBefore?.additionalFullCorpusCopyCount || 0),
    managedBytesDelta: managedAfter.totalManagedBytes - (managedBefore?.totalManagedBytes || activeBefore.bytes),
    evidenceBytesDelta: managedAfter.evidenceBytes - (managedBefore?.evidenceBytes || 0),
    cleanupPending: cleanupPending ?? fullCorpusCopies.rollback.exists,
    measuredAt,
  };
}

function resultFailures(result) {
  if (result === true || result?.valid === true || result?.ok === true) return [];
  if (Array.isArray(result?.failures)) return result.failures.map(String);
  return [String(result?.reason || 'validation returned no passing verdict')];
}

function transactionPaths(liveDir, transactionId) {
  if (!/^[a-zA-Z0-9._-]+$/.test(transactionId)) throw new Error('transactionId contains unsafe characters');
  const live = path.resolve(liveDir);
  const parent = path.dirname(live);
  const basename = path.basename(live);
  return {
    live,
    candidate: path.join(parent, `${basename}.next-${transactionId}`),
    rollback: path.join(parent, `${basename}.rollback-${transactionId}`),
    failed: path.join(parent, `${basename}.failed-${transactionId}`),
    receipts: path.join(parent, `.${basename}.update-transactions`, transactionId),
  };
}

function recorder(paths, transactionId) {
  fs.mkdirSync(paths.receipts, { recursive: false });
  let sequence = 0;
  return (state, details = {}) => {
    if (!STATES.includes(state)) throw new Error(`unsupported storage transaction state: ${state}`);
    sequence += 1;
    const receipt = { schemaVersion: 1, kind: 'ruvnet-brain-storage-transaction-phase', transactionId,
      sequence, state, recordedAt: new Date().toISOString(), paths: {
        live: paths.live, candidate: paths.candidate, rollback: paths.rollback, failed: paths.failed,
        receipts: paths.receipts,
      }, ...details };
    const name = `${String(sequence).padStart(3, '0')}-${state}.json`;
    writeReceiptAtomic(path.join(paths.receipts, name), receipt);
    return receipt;
  };
}

function writeReceiptAtomic(file, receipt) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function appendRecoveryReceipt(receipts, state, details) {
  const existing = fs.readdirSync(receipts).filter((name) => /^\d+-[A-Z_]+\.json$/.test(name))
    .map((name) => ({ name, sequence: Number.parseInt(name, 10) }))
    .sort((left, right) => left.sequence - right.sequence);
  const sequence = existing.at(-1).sequence + 1;
  const prior = JSON.parse(fs.readFileSync(path.join(receipts, existing.at(-1).name), 'utf8'));
  const receipt = { ...prior, sequence, state, recordedAt: new Date().toISOString(), ...details };
  writeReceiptAtomic(path.join(receipts, `${String(sequence).padStart(3, '0')}-${state}.json`), receipt);
  return receipt;
}

function removeCandidate(candidate) {
  if (fs.existsSync(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
}

function requireDigest(dir, expected, label) {
  if (!expected?.sha256) throw new Error(`${label} tree has no sealed receipt identity`);
  const actual = treeIdentity(dir);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes || actual.fileCount !== expected.fileCount) {
    throw new Error(`${label} tree identity differs from its sealed receipt`);
  }
  return actual;
}

export function recoverIncompleteStorageTransactions(liveDir, { removeTree = removeCandidate } = {}) {
  const live = path.resolve(liveDir);
  const receiptsRoot = path.join(path.dirname(live), `.${path.basename(live)}.update-transactions`);
  if (!fs.existsSync(receiptsRoot)) return [];
  const recovered = [];
  const removeIfPresent = (target) => { if (fs.existsSync(target)) removeTree(target); };
  for (const transactionId of fs.readdirSync(receiptsRoot).sort()) {
    if (/^\.prune-[A-Za-z0-9._-]+-[a-f0-9]{16}$/.test(transactionId)) continue;
    const receipts = path.join(receiptsRoot, transactionId);
    if (!fs.lstatSync(receipts).isDirectory()) throw new Error(`storage transaction receipt entry is not a directory: ${receipts}`);
    const phaseFiles = fs.readdirSync(receipts).filter((name) => /^\d{3}-[A-Z_]+\.json$/.test(name)).sort();
    if (!phaseFiles.length) throw new Error(`storage transaction receipt is empty: ${receipts}`);
    const latest = JSON.parse(fs.readFileSync(path.join(receipts, phaseFiles.at(-1)), 'utf8'));
    if (['NOOP', 'COMMITTED', 'ROLLED_BACK'].includes(latest.state)) continue;
    if (latest.state === 'RECOVERY_REQUIRED') throw new Error(`storage transaction requires manual recovery: ${transactionId}`);
    const paths = latest.paths;
    const expectedPaths = transactionPaths(live, transactionId);
    if (!paths || ['live', 'candidate', 'rollback', 'failed'].some((name) =>
      path.resolve(paths[name] || '') !== expectedPaths[name])
      || (paths.receipts && path.resolve(paths.receipts) !== expectedPaths.receipts)) {
      throw new Error(`storage transaction paths are unsafe or belong to another live tree: ${transactionId}`);
    }
    paths.receipts = expectedPaths.receipts;
    const prior = latest.prior;
    if (!prior?.sha256) throw new Error(`storage transaction has no prior tree identity: ${transactionId}`);
    try {
      // Validate every retained tree before any rename or deletion. A receipt owns
      // paths, but cannot authorize discarding bytes added after the process died.
      if (fs.existsSync(paths.candidate)) requireDigest(paths.candidate, latest.candidate, 'interrupted candidate');
      if (fs.existsSync(paths.rollback)) requireDigest(paths.rollback, prior, 'interrupted rollback');
      if (fs.existsSync(paths.failed)) throw new Error('interrupted failed tree has no safe recovery disposition');
      if (['LOCKED', 'CANDIDATE_BUILDING', 'CANDIDATE_VERIFIED'].includes(latest.state)) {
        requireDigest(live, prior, 'interrupted live');
        removeIfPresent(paths.candidate);
      } else if (latest.state === 'OLD_RENAME_STARTED') {
        const hasLive = fs.existsSync(live);
        const hasRollback = fs.existsSync(paths.rollback);
        if (hasLive === hasRollback) throw new Error('old-tree rename state is ambiguous');
        if (hasRollback) fs.renameSync(paths.rollback, live);
        requireDigest(live, prior, 'recovered live');
        removeIfPresent(paths.candidate);
      } else if (['OLD_RENAMED', 'ACTIVATED'].includes(latest.state)) {
        if (!fs.existsSync(paths.rollback)) throw new Error('rollback tree is missing');
        if (fs.existsSync(live)) requireDigest(live, latest.candidate, 'interrupted activated live');
        if (fs.existsSync(live)) fs.renameSync(live, paths.failed);
        fs.renameSync(paths.rollback, live);
        requireDigest(live, prior, 'recovered live');
        removeIfPresent(paths.failed);
        removeIfPresent(paths.candidate);
        const delta = storageDelta(paths, { prior, candidate: latest.candidate || null });
        appendRecoveryReceipt(receipts, 'ROLLED_BACK', { terminalVerdict: 'interrupted-run-restored', prior,
          storageDelta: delta, reason: `recovered interrupted ${latest.state} transaction before new work` });
        recovered.push({ transactionId, from: latest.state, terminalVerdict: 'interrupted-run-restored',
          storageDelta: delta });
        continue;
      } else if (['LIVE_VERIFIED', 'CLEANUP_PENDING'].includes(latest.state)) {
        const candidate = latest.candidate;
        if (!candidate?.sha256) throw new Error('verified candidate identity is missing');
        requireDigest(live, candidate, 'verified live');
        if (fs.existsSync(paths.candidate) || fs.existsSync(paths.failed)) {
          throw new Error('verified-live cleanup state contains an unexpected extra tree');
        }
        if (fs.existsSync(paths.rollback)) assertDirectory(paths.rollback, 'redundant rollback');
        try { removeIfPresent(paths.rollback); }
        catch (cleanupError) {
          const delta = storageDelta(paths, { prior, candidate, cleanupPending: true });
          appendRecoveryReceipt(receipts, 'CLEANUP_PENDING', { terminalVerdict: 'cleanup-pending', prior,
            candidate, storageDelta: delta, retryable: true, reason: cleanupError.message });
          recovered.push({ transactionId, from: latest.state, terminalVerdict: 'cleanup-pending',
            retryable: true, paths, storageDelta: delta });
          continue;
        }
        const delta = storageDelta(paths, { prior, candidate, cleanupPending: false });
        appendRecoveryReceipt(receipts, 'COMMITTED', { terminalVerdict: 'applied', prior, candidate,
          storageDelta: delta, reason: `completed cleanup for interrupted ${latest.state} transaction` });
        recovered.push({ transactionId, from: latest.state, terminalVerdict: 'applied', storageDelta: delta });
        continue;
      } else throw new Error(`unsupported interrupted state ${latest.state}`);
      const delta = storageDelta(paths, { prior, candidate: latest.candidate || null });
      appendRecoveryReceipt(receipts, 'ROLLED_BACK', { terminalVerdict: 'interrupted-run-restored', prior,
        storageDelta: delta, reason: `recovered interrupted ${latest.state} transaction before new work` });
      recovered.push({ transactionId, from: latest.state, terminalVerdict: 'interrupted-run-restored',
        storageDelta: delta });
    } catch (error) {
      appendRecoveryReceipt(receipts, 'RECOVERY_REQUIRED', { terminalVerdict: 'recovery-required', prior,
        reason: error.message });
      throw new Error(`storage transaction ${transactionId} recovery failed: ${error.message}`);
    }
  }
  return recovered;
}

/**
 * Build and validate a complete sibling candidate, then activate it with two directory renames.
 * The live directory is never modified before candidate validation succeeds.
 */
export function runStorageTransaction({
  liveDir,
  sourceDir,
  transactionId,
  prepareCandidate = () => {},
  validateCandidate = () => ({ valid: true }),
  validateLive = validateCandidate,
  checkpoint = () => {},
  removeRollback = (dir) => fs.rmSync(dir, { recursive: true }),
}) {
  const recovered = recoverIncompleteStorageTransactions(liveDir, { removeTree: removeRollback });
  const pendingCleanup = recovered.find(({ retryable }) => retryable);
  if (pendingCleanup) return { terminalVerdict: 'cleanup-pending', cleanupPending: true,
    recovered: true, paths: pendingCleanup.paths, storageDelta: pendingCleanup.storageDelta };
  const paths = transactionPaths(liveDir, transactionId);
  assertDirectory(paths.live, 'live tree');
  assertDirectory(path.resolve(sourceDir), 'source tree');
  for (const target of [paths.candidate, paths.rollback, paths.failed, paths.receipts]) {
    if (fs.existsSync(target)) throw new Error(`transaction path already exists: ${target}`);
  }
  const inventoryBefore = managedStorageInventory(paths.live);
  fs.mkdirSync(path.dirname(paths.receipts), { recursive: true });
  const record = recorder(paths, transactionId);
  const prior = treeIdentity(paths.live);
  record('LOCKED', { prior });
  checkpoint('LOCKED', paths);
  record('CANDIDATE_BUILDING', { prior });
  checkpoint('CANDIDATE_BUILDING', paths);

  try {
    fs.cpSync(path.resolve(sourceDir), paths.candidate, { recursive: true, errorOnExist: true, preserveTimestamps: true });
    prepareCandidate({ candidateDir: paths.candidate, liveDir: paths.live, paths });
    const failures = resultFailures(validateCandidate({ dir: paths.candidate, phase: 'candidate' }));
    if (failures.length) throw new Error(`candidate validation failed: ${failures.join('; ')}`);
  } catch (error) {
    removeCandidate(paths.candidate);
    record('ROLLED_BACK', { terminalVerdict: 'failed-before-activation', prior,
      storageDelta: storageDelta(paths, { prior, inventoryBefore }), reason: error.message });
    requireDigest(paths.live, prior, 'unchanged live');
    throw error;
  }

  const candidate = treeIdentity(paths.candidate);
  record('CANDIDATE_VERIFIED', { prior, candidate });
  checkpoint('CANDIDATE_VERIFIED', paths);
  if (candidate.sha256 === prior.sha256 && candidate.bytes === prior.bytes && candidate.fileCount === prior.fileCount) {
    removeCandidate(paths.candidate);
    const delta = storageDelta(paths, { prior, candidate, inventoryBefore });
    record('NOOP', { terminalVerdict: 'noop', prior, candidate, storageDelta: delta });
    return { terminalVerdict: 'noop', prior, candidate, paths, storageDelta: delta };
  }

  try {
    record('OLD_RENAME_STARTED', { prior, candidate });
    checkpoint('OLD_RENAME_STARTED', paths);
    fs.renameSync(paths.live, paths.rollback);
    checkpoint('OLD_RENAMED_UNRECEIPTED', paths);
    record('OLD_RENAMED', { prior, candidate });
    checkpoint('OLD_RENAMED', paths);
    try {
      fs.renameSync(paths.candidate, paths.live);
      checkpoint('ACTIVATED_UNRECEIPTED', paths);
    } catch (error) {
      fs.renameSync(paths.rollback, paths.live);
      requireDigest(paths.live, prior, 'restored live');
      record('ROLLED_BACK', { terminalVerdict: 'rolled-back', prior, candidate,
        storageDelta: storageDelta(paths, { prior, candidate, inventoryBefore }), reason: error.message });
      throw new Error(`candidate activation failed; prior tree restored: ${error.message}`);
    }
    record('ACTIVATED', { prior, candidate });
    checkpoint('ACTIVATED', paths);
    requireDigest(paths.live, candidate, 'activated live');
    const failures = resultFailures(validateLive({ dir: paths.live, phase: 'live' }));
    if (failures.length) throw new Error(`live validation failed: ${failures.join('; ')}`);
    record('LIVE_VERIFIED', { prior, candidate });
    checkpoint('LIVE_VERIFIED', paths);
  } catch (error) {
    if (fs.existsSync(paths.rollback)) {
      try {
        if (fs.existsSync(paths.live)) fs.renameSync(paths.live, paths.failed);
        fs.renameSync(paths.rollback, paths.live);
        requireDigest(paths.live, prior, 'rolled-back live');
        removeCandidate(paths.failed);
        removeCandidate(paths.candidate);
        record('ROLLED_BACK', { terminalVerdict: 'rolled-back', prior, candidate,
          storageDelta: storageDelta(paths, { prior, candidate, inventoryBefore }), reason: error.message });
        throw new Error(`${error.message}; prior tree restored and verified`);
      } catch (rollbackError) {
        if (String(rollbackError.message).includes('prior tree restored and verified')) throw rollbackError;
        record('RECOVERY_REQUIRED', { terminalVerdict: 'recovery-required', prior, candidate,
          storageDelta: storageDelta(paths, { prior, candidate, inventoryBefore }),
          reason: `${error.message}; rollback failed: ${rollbackError.message}` });
        throw new Error(`${error.message}; rollback failed and manual recovery is required: ${rollbackError.message}`);
      }
    }
    throw error;
  }

  try {
    removeRollback(paths.rollback);
    checkpoint('ROLLBACK_REMOVED', paths);
  }
  catch (error) {
    if (!fs.existsSync(paths.rollback)) {
      const delta = storageDelta(paths, { prior, candidate, cleanupPending: false, inventoryBefore });
      record('COMMITTED', { terminalVerdict: 'applied', prior, candidate, storageDelta: delta,
        cleanupWarning: error.message });
      return { terminalVerdict: 'applied', prior, candidate, paths, storageDelta: delta };
    }
    const delta = storageDelta(paths, { prior, candidate, cleanupPending: true, inventoryBefore });
    record('CLEANUP_PENDING', { terminalVerdict: 'cleanup-pending', prior, candidate,
      storageDelta: delta, reason: error.message });
    return { terminalVerdict: 'cleanup-pending', cleanupPending: true, prior, candidate, paths,
      storageDelta: delta };
  }
  const delta = storageDelta(paths, { prior, candidate, inventoryBefore });
  record('COMMITTED', { terminalVerdict: 'applied', prior, candidate, storageDelta: delta });
  return { terminalVerdict: 'applied', prior, candidate, paths, storageDelta: delta };
}
