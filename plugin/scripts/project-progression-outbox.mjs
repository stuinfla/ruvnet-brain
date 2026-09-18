import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder, isDeepStrictEqual } from 'node:util';

const OUTBOX_NAME = 'project-progression-outbox.jsonl';
const SPOOL_NAME = 'project-progression-outbox.d';
const RECORD_NAME = /^[0-9a-f]{32}\.rec$/;
const HEX32 = /^[0-9a-f]{32}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const POSIX = process.platform !== 'win32';

function requireIdentity(value, label) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} must be a non-empty string`);
}

function checkedWrite(fd, value, writeSync = fs.writeSync) {
  const content = Buffer.from(value);
  let offset = 0;
  while (offset < content.length) {
    const progress = writeSync(fd, content, offset, content.length - offset);
    if (!Number.isInteger(progress) || progress <= 0 || progress > content.length - offset) throw new Error('invalid outbox write progress');
    offset += progress;
  }
}

function decode(bytes, label) {
  try { return UTF8.decode(bytes); } catch { throw new Error(`invalid UTF-8 in ${label}`); }
}

export class ProgressionOutbox {
  constructor({ projectRoot, fsync = fs.fsyncSync, io = {} } = {}) {
    requireIdentity(projectRoot, 'projectRoot');
    this.projectRoot = projectRoot;
    this.path = path.join(projectRoot, '.swarm', OUTBOX_NAME);
    this.spoolPath = path.join(projectRoot, '.swarm', SPOOL_NAME);
    this.fsync = fsync;
    this.io = io;
  }

  _lstat(file) { return (this.io.lstatSync || fs.lstatSync)(file); }
  _exists(file) { try { this._lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
  _mkdir(dir, options) { return (this.io.mkdirSync || fs.mkdirSync)(dir, options); }
  _syncDirectory(dir) {
    if (!POSIX) return;
    const open = this.io.openSync || fs.openSync;
    const close = this.io.closeSync || fs.closeSync;
    const stat = this.io.fstatSync || fs.fstatSync;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
    const fd = open(dir, flags);
    try { if (!stat(fd).isDirectory()) throw new Error(`outbox sync target is not a directory: ${dir}`); this.fsync(fd); } finally { close(fd); }
  }
  _ensureSpool() {
    const swarm = path.dirname(this.spoolPath);
    try {
      const stat = this._lstat(swarm);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('outbox parent must be a regular directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { this._mkdir(swarm, { recursive: true, mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
    }
    const swarmStat = this._lstat(swarm);
    if (!swarmStat.isDirectory() || swarmStat.isSymbolicLink()) throw new Error('outbox parent must be a regular directory');
    try {
      const stat = this._lstat(this.spoolPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('outbox spool must be a regular directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { this._mkdir(this.spoolPath, { recursive: false, mode: 0o700 }); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
    }
    const spoolStat = this._lstat(this.spoolPath);
    if (!spoolStat.isDirectory() || spoolStat.isSymbolicLink()) throw new Error('outbox spool must be a regular directory');
    // Another writer may have created either directory and died before syncing its parent.
    // Existence does not prove durability; every publisher establishes both ancestor entries.
    this._syncDirectory(this.projectRoot);
    this._syncDirectory(swarm);
  }
  _unlink(file) { try { (this.io.unlinkSync || fs.unlinkSync)(file); } catch { /* best effort cleanup */ } }
  _readFileNoFollow(file, label) {
    const open = this.io.openSync || fs.openSync;
    const close = this.io.closeSync || fs.closeSync;
    const stat = this.io.fstatSync || fs.fstatSync;
    const read = this.io.readFileSync || fs.readFileSync;
    const initial = this._lstat(file);
    if (initial.isSymbolicLink() || !initial.isFile()) throw new Error(`invalid regular file ${label}`);
    const fd = open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const info = stat(fd);
      if (!info.isFile()) throw new Error(`invalid regular file ${label}`);
      return read(fd);
    } finally { close(fd); }
  }
  _publishRename(tmp, ready) {
    const rename = this.io.renameSync || fs.renameSync;
    let last;
    for (let attempt = 0; attempt < (process.platform === 'win32' ? 5 : 1); attempt += 1) {
      try { rename(tmp, ready); return; } catch (error) {
        last = error;
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
      }
    }
    throw last;
  }

  appendRecord(record) {
    this._validate(record, 'new outbox record');
    this._ensureSpool();
    const id = crypto.randomBytes(16).toString('hex');
    if (!HEX32.test(id)) throw new Error('invalid generated outbox record id');
    const tmp = path.join(this.spoolPath, `.${id}.tmp`);
    const ready = path.join(this.spoolPath, `${id}.rec`);
    const open = this.io.openSync || fs.openSync;
    const close = this.io.closeSync || fs.closeSync;
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
    let fd = null;
    let created = false;
    let published = false;
    try {
      fd = open(tmp, flags, 0o600);
      created = true;
      (this.io.fchmodSync || fs.fchmodSync)(fd, 0o600);
      checkedWrite(fd, `${JSON.stringify(record)}\n`, this.io.writeSync || fs.writeSync);
      this.fsync(fd);
      close(fd);
      fd = null;
      if (this._exists(ready)) throw new Error(`outbox record collision: ${ready}`);
      this._publishRename(tmp, ready);
      published = true;
      this._syncDirectory(this.spoolPath);
    } catch (error) {
      if (fd !== null) { try { close(fd); } catch { /* preserve original error */ } }
      if (created && !published) this._unlink(tmp);
      throw error;
    }
    return record;
  }

  appendSnapshot(snapshot) {
    requireIdentity(snapshot?.eventKey, 'snapshot.eventKey');
    requireIdentity(snapshot?.payloadDigest, 'snapshot.payloadDigest');
    return this.appendRecord({ type: 'snapshot', eventKey: snapshot.eventKey, payloadDigest: snapshot.payloadDigest, snapshot });
  }

  markCommitted(receipt) {
    requireIdentity(receipt?.eventKey, 'receipt.eventKey');
    requireIdentity(receipt?.payloadDigest, 'receipt.payloadDigest');
    requireIdentity(receipt?.readbackDigest, 'receipt.readbackDigest');
    requireIdentity(receipt?.committedAt, 'receipt.committedAt');
    if (receipt.readbackDigest !== receipt.payloadDigest) throw new Error('readback digest mismatch');
    return this.appendRecord({ ...receipt, type: 'commit' });
  }

  _validate(record, label) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`invalid outbox record in ${label}`);
    requireIdentity(record.eventKey, `${label} eventKey`);
    requireIdentity(record.payloadDigest, `${label} payloadDigest`);
    if (record.type === 'snapshot') {
      if (!record.snapshot || typeof record.snapshot !== 'object' || Array.isArray(record.snapshot)
        || record.snapshot.eventKey !== record.eventKey || record.snapshot.payloadDigest !== record.payloadDigest) {
        throw new Error(`snapshot identity mismatch in ${label}`);
      }
    } else if (record.type === 'commit') {
      requireIdentity(record.readbackDigest, `${label} readbackDigest`);
      requireIdentity(record.committedAt, `${label} committedAt`);
      if (record.readbackDigest !== record.payloadDigest) throw new Error(`commit digest mismatch in ${label}`);
    } else throw new Error(`unsupported outbox record in ${label}`);
    return record;
  }

  _parseLine(bytes, line, label) {
    if (bytes.length === 0) return null;
    let record;
    try { record = JSON.parse(decode(bytes, label)); } catch { throw new Error(`malformed outbox record at ${label} line ${line}`); }
    return this._validate(record, label);
  }

  _legacyRecords() {
    if (!this._exists(this.path)) return [];
    const bytes = this._readFileNoFollow(this.path, this.path);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return [];
    const complete = bytes.subarray(0, lastNewline);
    const lines = [];
    let start = 0;
    for (let end = 0; end <= complete.length; end += 1) {
      if (end !== complete.length && complete[end] !== 0x0a) continue;
      lines.push(this._parseLine(complete.subarray(start, end), lines.length + 1, `${this.path}:${lines.length + 1}`));
      start = end + 1;
    }
    return lines.filter(Boolean);
  }

  _spoolRecords() {
    if (!this._exists(this.spoolPath)) return [];
    const spoolStat = this._lstat(this.spoolPath);
    if (!spoolStat.isDirectory() || spoolStat.isSymbolicLink()) throw new Error('outbox spool must be a regular directory');
    const entries = (this.io.readdirSync || fs.readdirSync)(this.spoolPath, { withFileTypes: true });
    return entries.filter((entry) => RECORD_NAME.test(entry.name)).map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`invalid published outbox record ${path.join(this.spoolPath, entry.name)}`);
      const label = path.join(this.spoolPath, entry.name);
      const bytes = this._readFileNoFollow(label, label);
      if (!bytes.length || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) throw new Error(`invalid published outbox record ${label}`);
      let record;
      try { record = JSON.parse(decode(bytes.subarray(0, -1), label)); } catch { throw new Error(`invalid published outbox record ${label}`); }
      return this._validate(record, label);
    });
  }

  records() {
    const parent = path.dirname(this.spoolPath);
    if (this._exists(parent)) {
      const stat = this._lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('outbox parent must be a regular directory');
    }
    return [...this._legacyRecords(), ...this._spoolRecords()];
  }

  pendingSnapshots() {
    const snapshots = new Map();
    const committed = new Map();
    for (const record of this.records()) {
      if (record.type === 'snapshot') {
        const prior = snapshots.get(record.eventKey);
        if (prior && (prior.payloadDigest !== record.payloadDigest
          || !isDeepStrictEqual(prior.snapshot, record.snapshot))) throw new Error('outbox event key collision');
        snapshots.set(record.eventKey, record);
      } else {
        const prior = committed.get(record.eventKey);
        if (prior && prior !== record.payloadDigest) throw new Error('outbox commit collision');
        committed.set(record.eventKey, record.payloadDigest);
      }
    }
    return [...snapshots.values()].filter((record) => {
      const digest = committed.get(record.eventKey);
      if (digest && digest !== record.payloadDigest) throw new Error('outbox commit digest mismatch');
      return !digest;
    }).sort((left, right) => left.eventKey.localeCompare(right.eventKey)).map((record) => record.snapshot);
  }
}
