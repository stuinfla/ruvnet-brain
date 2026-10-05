import fs from 'node:fs';
import path from 'node:path';

const OUTBOX_NAME = 'project-progression-outbox.jsonl';
const READ_CHUNK_BYTES = 64 * 1024;

// Decode only complete records, so a multibyte character crossing reads stays intact.
function* readJsonl(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let parts = [];
  let line = 0;
  const parse = (bytes, terminated) => {
    if (!bytes.length) return undefined;
    const text = bytes.toString('utf8');
    if (!text.trim()) return undefined;
    try { return JSON.parse(text); } catch {
      if (!terminated) return undefined;
      throw new Error(`malformed outbox record at line ${line}`);
    }
  };
  try {
    let length;
    while ((length = fs.readSync(fd, chunk, 0, chunk.length, null))) {
      let start = 0;
      for (let end = 0; end < length; end += 1) {
        if (chunk[end] !== 10) continue;
        parts.push(Buffer.from(chunk.subarray(start, end)));
        line += 1;
        const record = parse(Buffer.concat(parts), true);
        if (record !== undefined) yield record;
        parts = []; start = end + 1;
      }
      if (start < length) parts.push(Buffer.from(chunk.subarray(start, length)));
    }
    if (parts.length) {
      line += 1;
      const record = parse(Buffer.concat(parts), false);
      if (record !== undefined) yield record;
    }
  } finally { fs.closeSync(fd); }
}

// Inspect only the final record; preceding history is never decoded or copied.
function finalRecord(fd, size) {
  const parts = [];
  let position = size;
  while (position > 0) {
    const length = Math.min(READ_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, chunk, read, length - read, position + read);
      if (!count) throw new Error('outbox tail changed during inspection');
      read += count;
    }
    const delimiter = chunk.lastIndexOf(10);
    parts.unshift(delimiter < 0 ? chunk : chunk.subarray(delimiter + 1));
    if (delimiter >= 0) break;
  }
  return Buffer.concat(parts).toString('utf8');
}

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
}

function writeAll(fd, value) {
  const content = Buffer.from(value);
  let offset = 0;
  while (offset < content.length) offset += fs.writeSync(fd, content, offset, content.length - offset);
}

export class ProgressionOutbox {
  constructor({ projectRoot, fsync = fs.fsyncSync } = {}) {
    requireIdentity(projectRoot, 'projectRoot');
    this.path = path.join(projectRoot, '.swarm', OUTBOX_NAME);
    this.fsync = fsync;
  }

  appendRecord(record) {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const fd = fs.openSync(this.path, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR | noFollow, 0o600);
    try {
      let separator = '';
      const size = fs.fstatSync(fd).size;
      if (size) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 10) {
          try { JSON.parse(finalRecord(fd, size)); }
          catch { throw new Error('incomplete outbox final record; preserve and recover the torn tail before appending'); }
          separator = '\n';
        }
      }
      fs.fchmodSync(fd, 0o600);
      writeAll(fd, `${separator}${JSON.stringify(record)}\n`);
      this.fsync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  appendSnapshot(snapshot) {
    requireIdentity(snapshot?.eventKey, 'snapshot.eventKey');
    requireIdentity(snapshot?.payloadDigest, 'snapshot.payloadDigest');
    return this.appendRecord({
      type: 'snapshot',
      eventKey: snapshot.eventKey,
      payloadDigest: snapshot.payloadDigest,
      snapshot,
    });
  }

  markCommitted(receipt) {
    requireIdentity(receipt?.eventKey, 'receipt.eventKey');
    requireIdentity(receipt?.payloadDigest, 'receipt.payloadDigest');
    requireIdentity(receipt?.readbackDigest, 'receipt.readbackDigest');
    requireIdentity(receipt?.committedAt, 'receipt.committedAt');
    if (receipt.readbackDigest !== receipt.payloadDigest) throw new Error('readback digest mismatch');
    return this.appendRecord({ type: 'commit', ...receipt });
  }

  /** Disposition of one frozen payload, never a commit for its conflicting original key. */
  markRecovered(snapshot, receipt) {
    for (const [label, value] of Object.entries({ eventKey: snapshot?.eventKey,
      payloadDigest: snapshot?.payloadDigest, recoveryEventKey: receipt?.eventKey,
      recoveryPayloadDigest: receipt?.payloadDigest, readbackDigest: receipt?.readbackDigest,
      committedAt: receipt?.committedAt })) requireIdentity(value, label);
    if (receipt.eventKey === snapshot.eventKey || receipt.readbackDigest !== receipt.payloadDigest) {
      throw new Error('unverified recovery disposition');
    }
    return this.appendRecord({ type: 'recovery', eventKey: snapshot.eventKey,
      payloadDigest: snapshot.payloadDigest, recoveryEventKey: receipt.eventKey,
      recoveryPayloadDigest: receipt.payloadDigest, readbackDigest: receipt.readbackDigest,
      committedAt: receipt.committedAt });
  }

  records() {
    return [...readJsonl(this.path)];
  }

  /**
   * Snapshots fsynced but not committed. A key whose records DISAGREE (two snapshots, or a snapshot and
   * a commit, with different digests) is still never replayed — that is the fail-closed part — but it
   * is QUARANTINED, not thrown: on this repo's real outbox one such collision (2026-09-18, two Stop
   * boundaries of one session producing the same sequence and dedup id) made this method throw on
   * every call, every caller swallowed it, and no pending snapshot was replayed for 13 days while the
   * SessionStart notice read 0 pending. Quarantined keys are reported by quarantinedKeys().
   */
  pendingSnapshots() {
    const snapshots = new Map();
    const committed = new Map();
    const quarantined = new Map();
    const recoveries = [];
    for (const record of readJsonl(this.path)) {
      requireIdentity(record?.eventKey, 'outbox eventKey');
      requireIdentity(record?.payloadDigest, 'outbox payloadDigest');
      if (record.type === 'snapshot') {
        const prior = snapshots.get(record.eventKey);
        if (prior && prior.payloadDigest !== record.payloadDigest) quarantined.set(record.eventKey, 'outbox event key collision');
        else snapshots.set(record.eventKey, record);
      } else if (record.type === 'commit') {
        const prior = committed.get(record.eventKey);
        if (prior && prior !== record.payloadDigest) quarantined.set(record.eventKey, 'outbox commit collision');
        committed.set(record.eventKey, record.payloadDigest);
      } else if (record.type === 'recovery') {
        requireIdentity(record.recoveryEventKey, 'recovery event key');
        requireIdentity(record.recoveryPayloadDigest, 'recovery payload digest');
        if (record.eventKey === record.recoveryEventKey || record.readbackDigest !== record.recoveryPayloadDigest) {
          throw new Error('unverified recovery disposition');
        }
        recoveries.push(record);
      } else {
        throw new Error('unsupported outbox record');
      }
    }
    for (const record of snapshots.values()) {
      const digest = committed.get(record.eventKey);
      if (digest && digest !== record.payloadDigest && !quarantined.has(record.eventKey)) {
        quarantined.set(record.eventKey, 'outbox commit digest mismatch');
      }
    }
    const recovered = new Set(recoveries.filter((record) => {
      const target = snapshots.get(record.recoveryEventKey)?.snapshot;
      return !quarantined.has(record.recoveryEventKey)
        && committed.get(record.recoveryEventKey) === record.recoveryPayloadDigest
        && target?.payloadDigest === record.recoveryPayloadDigest
        && target.recoveryDiagnostics?.originalEventKey === record.eventKey
        && target.recoveryDiagnostics?.frozenPayloadDigest === record.payloadDigest;
    }).map((record) => `${record.eventKey}:${record.payloadDigest}`));
    this.quarantine = [...quarantined].map(([eventKey, reason]) => ({ eventKey, reason }));
    return [...snapshots.values()]
      .filter((record) => !quarantined.has(record.eventKey) && !committed.has(record.eventKey)
        && !recovered.has(`${record.eventKey}:${record.payloadDigest}`))
      .sort((left, right) => left.eventKey.localeCompare(right.eventKey))
      .map((record) => record.snapshot);
  }

  /** Keys pendingSnapshots() refused to replay because their records disagree, with the reason. */
  quarantinedKeys() {
    this.pendingSnapshots();
    return this.quarantine;
  }
}
