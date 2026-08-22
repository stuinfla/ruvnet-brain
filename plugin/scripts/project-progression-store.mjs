import { spawnSync } from 'node:child_process';
import { ProgressionOutbox } from './project-progression-outbox.mjs';
import {
  digestCanonical,
  restoreProjectProgression,
  validateProgressionSnapshot,
} from './project-progression-contract.mjs';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { resolveRuflo, RUFLO_MISSING } from './ruflo-bin.mjs';

const PROGRESSION_NAMESPACE = 'project-progression';
const RESUME_SCHEMA = 'ruvnet-brain.project-resume';
const RESUME_VERSION = 1;

function defaultRunner(binary, args, options) {
  return spawnSync(binary, args, options);
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

export class ProjectProgressionStore {
  constructor({
    projectDir,
    requestedStorePath,
    rufloBinary = resolveRuflo(),
    runner = defaultRunner,
    clock = () => new Date().toISOString(),
    fsync,
  } = {}) {
    if (!rufloBinary) throw new Error(RUFLO_MISSING);
    this.resolution = resolveProjectStore({ projectDir, requestedStorePath });
    this.rufloBinary = rufloBinary;
    this.runner = runner;
    this.clock = clock;
    this.outbox = new ProgressionOutbox({ projectRoot: this.resolution.projectRoot, fsync });
  }

  run(args) {
    return this.runner(this.rufloBinary, args, {
      cwd: this.resolution.checkoutRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' },
    });
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
    let readback;
    try { readback = JSON.parse(resultText(retrieved, 'stdout')); } catch { throw new Error('progression readback is not JSON'); }
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

  listSnapshotKeys({ pageSize = 100 } = {}) {
    requirePositiveInteger(pageSize, 'pageSize');
    const keys = [];
    const seen = new Set();
    let offset = 0;
    let total = null;
    do {
      const listed = this.run([
        'memory', 'list', '--namespace', PROGRESSION_NAMESPACE,
        '--limit', String(pageSize), '--offset', String(offset), '--page-info', '--format', 'json',
        '--path', this.resolution.canonicalAgentDbPath,
      ]);
      if (resultStatus(listed) !== 0) {
        throw new Error(`progression structural pagination failed: ${resultText(listed, 'stderr').trim() || 'unknown error'}`);
      }
      const page = parseJson(resultText(listed, 'stdout'), 'progression pagination page');
      total = validatePage(page, { offset, pageSize, total });
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

  restoreLatest({ pageSize = 100, maxOutputBytes = 64 * 1024 } = {}) {
    requirePositiveInteger(maxOutputBytes, 'maxOutputBytes');
    this.replay();
    const keys = this.listSnapshotKeys({ pageSize });
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
      },
    };
    const rendered = JSON.stringify(payload);
    if (Buffer.byteLength(rendered, 'utf8') > maxOutputBytes) {
      throw new Error(`resume payload exceeds the ${maxOutputBytes}-byte output bound`);
    }
    return { payload, rendered };
  }
}
