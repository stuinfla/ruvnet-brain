import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { persistAndVerifyRvfIndex } from './rvf-index.mjs';

export const INCREMENTAL_LEDGER_SCHEMA = 2;

const emptyPlan = (reason) => ({
  mode: 'full',
  reason,
  unchanged: [],
  add: [],
  modify: [],
  delete: [],
});

const normalizeContent = (content) => String(content).replace(/\r\n?/g, '\n');

export function stableChunkId({
  repo,
  sourcePath,
  chunkerVersion,
  ordinal,
  content,
}) {
  const identity = JSON.stringify([
    String(repo).toLowerCase(),
    String(sourcePath).replaceAll('\\', '/'),
    String(chunkerVersion),
    Number(ordinal),
    normalizeContent(content),
  ]);
  return `chunk:${createHash('sha256').update(identity).digest('hex')}`;
}

export function buildCorpusLedger(chunks, { buildFingerprint }) {
  const grouped = new Map();
  for (const chunk of chunks) {
    const sourcePath = String(chunk.path).replaceAll('\\', '/');
    if (!grouped.has(sourcePath)) grouped.set(sourcePath, []);
    grouped.get(sourcePath).push(chunk);
  }

  const files = {};
  for (const sourcePath of [...grouped.keys()].sort()) {
    const sourceChunks = grouped.get(sourcePath);
    const sourceIdentity = JSON.stringify(sourceChunks.map(({ id, text }) => [
      String(id),
      normalizeContent(text),
    ]));
    files[sourcePath] = {
      sourceHash: `sha256:${createHash('sha256').update(sourceIdentity).digest('hex')}`,
      chunkIds: sourceChunks.map(({ id }) => id),
    };
  }
  return {
    schemaVersion: INCREMENTAL_LEDGER_SCHEMA,
    buildFingerprint,
    files,
  };
}

export function chunkDelta(previousChunks, currentChunks) {
  const before = new Set(previousChunks.map(({ id }) => String(id)));
  const after = new Set(currentChunks.map(({ id }) => String(id)));
  return {
    deleteIds: [...before].filter((id) => !after.has(id)).sort(),
    insertIds: [...after].filter((id) => !before.has(id)).sort(),
  };
}

export function planLegacyRekey({ passages, chunks, idmap }) {
  if (!Array.isArray(passages) || passages.length !== chunks.length) {
    return { ok: false, reason: `passage-count-mismatch:${passages?.length ?? 0}:${chunks.length}` };
  }
  if (!idmap?.idToLabel || !idmap?.labelToId) {
    return { ok: false, reason: 'missing-idmap' };
  }
  const next = { idToLabel: {}, labelToId: {}, nextLabel: idmap.nextLabel };
  for (let index = 0; index < chunks.length; index++) {
    const old = passages[index];
    const chunk = chunks[index];
    if (old?.text !== chunk.text || old?.path !== chunk.path || old?.title !== chunk.title) {
      return { ok: false, reason: `corpus-mismatch-at:${index}:${chunk.path}` };
    }
    const label = idmap.idToLabel[String(old.id)];
    if (!Number.isInteger(label)) return { ok: false, reason: `missing-label-for:${old.id}` };
    const stableId = String(chunk.id);
    next.idToLabel[stableId] = label;
    next.labelToId[String(label)] = stableId;
  }
  return { ok: true, idmap: next };
}

export function planLegacyDelta({ passages, chunks, idmap }) {
  if (!Array.isArray(passages) || !idmap?.idToLabel) {
    return { ok: false, reason: 'legacy-artifacts-invalid' };
  }
  const available = new Map();
  for (const chunk of chunks) {
    const key = JSON.stringify([chunk.path, chunk.title, chunk.text]);
    if (!available.has(key)) available.set(key, []);
    available.get(key).push(String(chunk.id));
  }
  const matches = [];
  const deleteIds = [];
  const matchedNew = new Set();
  for (const old of passages) {
    const key = JSON.stringify([old.path, old.title, old.text]);
    const next = available.get(key)?.shift();
    if (next && Number.isInteger(idmap.idToLabel[String(old.id)])) {
      matches.push({ oldId: String(old.id), newId: next });
      matchedNew.add(next);
    } else {
      deleteIds.push(String(old.id));
    }
  }
  return {
    ok: true,
    matches,
    deleteIds,
    insertIds: chunks.map(({ id }) => String(id)).filter((id) => !matchedNew.has(id)),
  };
}

export function rekeyStagedIdmap({ staged, matches, insertedIds }) {
  const next = { idToLabel: {}, labelToId: {}, nextLabel: staged.nextLabel };
  for (const { oldId, newId } of matches) {
    const label = staged.idToLabel[oldId];
    if (!Number.isInteger(label)) throw new Error(`staged idmap lost label for ${oldId}`);
    next.idToLabel[newId] = label;
    next.labelToId[String(label)] = newId;
  }
  for (const id of insertedIds) {
    const label = staged.idToLabel[id];
    if (!Number.isInteger(label)) throw new Error(`staged idmap lost inserted label for ${id}`);
    next.idToLabel[id] = label;
    next.labelToId[String(label)] = id;
  }
  return next;
}

const hasLegacyIds = (files) => Object.values(files || {}).some(({ chunkIds } = {}) =>
  Array.isArray(chunkIds) && chunkIds.some((id) => typeof id === 'number' || /^\d+$/.test(String(id))),
);

export function planIncrementalRefresh({ previous, current }) {
  if (previous?.schemaVersion !== current?.schemaVersion) {
    return emptyPlan('ledger-schema-changed');
  }
  if (previous?.buildFingerprint !== current?.buildFingerprint) {
    return emptyPlan('build-fingerprint-changed');
  }
  if (hasLegacyIds(previous?.files)) {
    return emptyPlan('legacy-sequential-chunk-ids');
  }

  const before = previous?.files || {};
  const after = current?.files || {};
  const beforePaths = new Set(Object.keys(before));
  const afterPaths = new Set(Object.keys(after));
  const unchanged = [];
  const add = [];
  const modify = [];
  const remove = [];

  for (const sourcePath of afterPaths) {
    if (!beforePaths.has(sourcePath)) add.push(sourcePath);
    else if (before[sourcePath]?.sourceHash === after[sourcePath]?.sourceHash) unchanged.push(sourcePath);
    else modify.push(sourcePath);
  }
  for (const sourcePath of beforePaths) {
    if (!afterPaths.has(sourcePath)) remove.push(sourcePath);
  }

  return {
    mode: 'incremental',
    reason: null,
    unchanged: unchanged.sort(),
    add: add.sort(),
    modify: modify.sort(),
    delete: remove.sort(),
  };
}

export async function stageRvfDelta({
  sourcePath,
  stagePath,
  deleteIds = [],
  inserts = [],
  dimensions,
  RvfDatabase,
}) {
  if (!RvfDatabase) throw new TypeError('RvfDatabase is required');
  if (!fs.existsSync(sourcePath)) throw new Error(`source RVF does not exist: ${sourcePath}`);
  if (fs.existsSync(stagePath) || fs.existsSync(`${stagePath}.idmap.json`)) {
    throw new Error(`staging target already exists: ${stagePath}`);
  }

  const sourceMap = `${sourcePath}.idmap.json`;
  const stageMap = `${stagePath}.idmap.json`;
  fs.copyFileSync(sourcePath, stagePath, fs.constants.COPYFILE_EXCL);
  if (fs.existsSync(sourceMap)) fs.copyFileSync(sourceMap, stageMap, fs.constants.COPYFILE_EXCL);

  let db;
  try {
    db = await RvfDatabase.open(stagePath);
    const deletion = deleteIds.length ? await db.delete(deleteIds) : { deleted: 0 };
    const ingestion = inserts.length
      ? await db.ingestBatch(inserts)
      : { accepted: 0, rejected: 0 };
    const status = await db.status();
    await persistAndVerifyRvfIndex({
      db,
      dimensions,
      rvfPath: stagePath,
      RvfDatabase,
    });
    db = null;
    return {
      deleted: deletion.deleted,
      accepted: ingestion.accepted,
      rejected: ingestion.rejected,
      totalVectors: status.totalVectors,
      deadSpaceRatio: status.deadSpaceRatio,
    };
  } catch (error) {
    if (db) {
      try { await db.close(); } catch { /* preserve the mutation failure */ }
    }
    fs.rmSync(stagePath, { force: true });
    fs.rmSync(stageMap, { force: true });
    throw error;
  }
}

export function promoteArtifactSet({
  liveDir,
  candidateDir,
  files,
}) {
  const relativeFiles = [...new Set(files || [])];
  if (!relativeFiles.length) throw new Error('promotion needs at least one artifact');
  for (const file of relativeFiles) {
    if (pathIsUnsafe(file)) throw new Error(`unsafe promotion artifact path: ${file}`);
    if (!fs.existsSync(path.join(candidateDir, file))) {
      throw new Error(`candidate artifact is missing: ${file}`);
    }
  }

  const lockDir = path.join(liveDir, '.promotion.lock');
  const backupDir = path.join(liveDir, `.promotion-backup-${process.pid}-${Date.now()}`);
  fs.mkdirSync(lockDir);
  fs.mkdirSync(backupDir);
  const backedUp = [];
  const promoted = [];
  let recoveryRequired = false;

  try {
    for (const file of relativeFiles) {
      const live = path.join(liveDir, file);
      if (!fs.existsSync(live)) continue;
      const backup = path.join(backupDir, file);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(live, backup);
      backedUp.push(file);
    }

    for (const file of relativeFiles) {
      fs.renameSync(path.join(candidateDir, file), path.join(liveDir, file));
      promoted.push(file);
    }
  } catch (error) {
    try {
      for (const file of promoted.reverse()) fs.rmSync(path.join(liveDir, file), { recursive: true, force: true });
      for (const file of backedUp.reverse()) {
        const live = path.join(liveDir, file);
        fs.mkdirSync(path.dirname(live), { recursive: true });
        fs.renameSync(path.join(backupDir, file), live);
      }
    } catch (rollbackError) {
      recoveryRequired = true;
      // Originals not yet restored remain ONLY here. Keep the reader-visible lock
      // too: an incomplete generation must not be served or automatically promoted.
      const failure = new Error(`promotion failed: ${error.message}; rollback failed: ${rollbackError.message}; `
        + `recovery required, backup and lock retained at ${backupDir} and ${lockDir}`, { cause: rollbackError });
      failure.code = 'ERECOVERYREQUIRED';
      failure.backupDir = backupDir;
      failure.lockDir = lockDir;
      throw failure;
    }
    throw new Error(`promotion failed and was rolled back: ${error.message}`, { cause: error });
  } finally {
    if (!recoveryRequired) {
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

function pathIsUnsafe(file) {
  return typeof file !== 'string'
    || !file
    || path.isAbsolute(file)
    || file.split(/[\\/]/).includes('..');
}
