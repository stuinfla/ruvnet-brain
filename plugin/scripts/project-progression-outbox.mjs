import fs from 'node:fs';
import path from 'node:path';

const OUTBOX_NAME = 'project-progression-outbox.jsonl';

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
    const fd = fs.openSync(this.path, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      writeAll(fd, `${JSON.stringify(record)}\n`);
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

  records() {
    if (!fs.existsSync(this.path)) return [];
    const content = fs.readFileSync(this.path, 'utf8');
    const lines = content.split('\n');
    if (lines.at(-1) !== '') lines.pop();
    else lines.pop();
    return lines.filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`malformed outbox record at line ${index + 1}`); }
    });
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
    for (const record of this.records()) {
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
    this.quarantine = [...quarantined].map(([eventKey, reason]) => ({ eventKey, reason }));
    return [...snapshots.values()]
      .filter((record) => !quarantined.has(record.eventKey) && !committed.has(record.eventKey))
      .sort((left, right) => left.eventKey.localeCompare(right.eventKey))
      .map((record) => record.snapshot);
  }

  /** Keys pendingSnapshots() refused to replay because their records disagree, with the reason. */
  quarantinedKeys() {
    this.pendingSnapshots();
    return this.quarantine;
  }
}
