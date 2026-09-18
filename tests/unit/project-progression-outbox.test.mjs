import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgressionOutbox } from '../../plugin/scripts/project-progression-outbox.mjs';

const roots = [];
function temporaryRoot({ spool = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'progression-outbox-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.swarm'), { mode: 0o700 });
  if (spool) fs.mkdirSync(path.join(root, '.swarm', 'project-progression-outbox.d'), { mode: 0o700 });
  return root;
}
function snapshot(eventKey = 'project-progress-v1-test-event', overrides = {}) {
  return { eventKey, payloadDigest: 'a'.repeat(64), completeProjectState: { nextAction: 'replay me' }, ...overrides };
}
function commit(s) { return { eventKey: s.eventKey, payloadDigest: s.payloadDigest, readbackDigest: s.payloadDigest, committedAt: '2026-08-22T17:30:00.000Z' }; }
function legacyPath(root) { return path.join(root, '.swarm', 'project-progression-outbox.jsonl'); }
function published(root) { return fs.readdirSync(path.join(root, '.swarm', 'project-progression-outbox.d')).filter((x) => x.endsWith('.rec')); }

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('ProjectProgression crash outbox', () => {
  it('publishes a private snapshot and commit marker, then a fresh instance replays both', () => {
    const root = temporaryRoot();
    const synced = [];
    const outbox = new ProgressionOutbox({ projectRoot: root, fsync(fd) { synced.push(fd); } });
    const a = snapshot();
    outbox.appendSnapshot(a);
    expect(published(root)).toHaveLength(1);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(outbox.spoolPath, published(root)[0])).mode & 0o777).toBe(0o600);
    expect(outbox.pendingSnapshots()).toEqual([a]);
    outbox.markCommitted(commit(a));
    expect(published(root)).toHaveLength(2);
    expect(outbox.pendingSnapshots()).toEqual([]);
    expect(new ProgressionOutbox({ projectRoot: root }).pendingSnapshots()).toEqual([]);
    expect(synced.length).toBeGreaterThanOrEqual(2);
  });

  it('imports legacy complete lines without modifying an unterminated tail, then appends new records to the spool', () => {
    const root = temporaryRoot();
    const a = snapshot('a');
    const b = snapshot('b', { payloadDigest: 'b'.repeat(64) });
    const legacy = `${JSON.stringify({ type: 'snapshot', eventKey: a.eventKey, payloadDigest: a.payloadDigest, snapshot: a })}\n{"type":"snapshot"`;
    fs.writeFileSync(legacyPath(root), legacy);
    const outbox = new ProgressionOutbox({ projectRoot: root });
    outbox.appendSnapshot(b);
    expect(fs.readFileSync(legacyPath(root), 'utf8')).toBe(legacy);
    expect(outbox.pendingSnapshots()).toEqual([a, b]);
    outbox.markCommitted(commit(a));
    expect(new ProgressionOutbox({ projectRoot: root }).pendingSnapshots()).toEqual([b]);
  });

  it('reports the true physical line for malformed legacy records and preserves bytes', () => {
    const root = temporaryRoot();
    const valid = { type: 'snapshot', eventKey: 'a', payloadDigest: 'a'.repeat(64), snapshot: snapshot('a') };
    const bytes = Buffer.from(`${JSON.stringify(valid)}\n\nnot-json\n`);
    fs.writeFileSync(legacyPath(root), bytes);
    const outbox = new ProgressionOutbox({ projectRoot: root });
    expect(() => outbox.pendingSnapshots()).toThrow(/line 3/);
    expect(fs.readFileSync(legacyPath(root)).equals(bytes)).toBe(true);
  });

  it('rejects divergent identities and readback digests', () => {
    const root = temporaryRoot();
    const outbox = new ProgressionOutbox({ projectRoot: root });
    const a = snapshot();
    outbox.appendSnapshot(a);
    expect(() => outbox.markCommitted({ ...commit(a), readbackDigest: 'f'.repeat(64) })).toThrow(/readback digest mismatch/i);
    outbox.appendSnapshot(snapshot(a.eventKey, { payloadDigest: 'b'.repeat(64) }));
    expect(() => outbox.pendingSnapshots()).toThrow(/event key collision/i);
  });

  it('supports short positive writes and rejects zero progress without publishing a record', () => {
    const root = temporaryRoot();
    const outbox = new ProgressionOutbox({
      projectRoot: root,
      io: { writeSync: (fd, buffer, offset, length) => fs.writeSync(fd, buffer, offset, Math.min(3, length)) },
    });
    outbox.appendSnapshot(snapshot());
    expect(outbox.pendingSnapshots()).toHaveLength(1);
    const failedRoot = temporaryRoot();
    const failed = new ProgressionOutbox({ projectRoot: failedRoot, io: { writeSync: () => 0 } });
    expect(() => failed.appendSnapshot(snapshot())).toThrow(/invalid outbox write progress/);
    expect(published(failedRoot)).toHaveLength(0);
  });

  it('leaves no published record on file fsync or rename failure', () => {
    const fsyncFailRoot = temporaryRoot();
    expect(() => new ProgressionOutbox({ projectRoot: fsyncFailRoot, fsync(fd) {
      if (fs.fstatSync(fd).isFile()) throw new Error('fsync failed');
    } }).appendSnapshot(snapshot())).toThrow(/fsync failed/);
    expect(published(fsyncFailRoot)).toHaveLength(0);
    const renameRoot = temporaryRoot();
    expect(() => new ProgressionOutbox({ projectRoot: renameRoot, io: { renameSync: () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); } } }).appendSnapshot(snapshot())).toThrow(/rename failed/);
    expect(published(renameRoot)).toHaveLength(0);
  });

  it.runIf(process.platform !== 'win32')('propagates post-publication directory sync failure and leaves the record replayable', () => {
    const root = temporaryRoot({ spool: false });
    let calls = 0;
    const outbox = new ProgressionOutbox({ projectRoot: root, fsync() { calls += 1; if (calls === 4) throw new Error('directory sync failed'); } });
    expect(() => outbox.appendSnapshot(snapshot())).toThrow(/directory sync failed/);
    expect(published(root)).toHaveLength(1);
    expect(new ProgressionOutbox({ projectRoot: root }).pendingSnapshots()).toHaveLength(1);
  });

  it('rejects malformed published records and ignores temporary files', () => {
    const root = temporaryRoot();
    const dir = path.join(root, '.swarm', 'project-progression-outbox.d');
    fs.writeFileSync(path.join(dir, '.dead.tmp'), 'partial');
    fs.writeFileSync(path.join(dir, `${'a'.repeat(32)}.rec`), '{"type":"snapshot"}\nextra\n');
    expect(() => new ProgressionOutbox({ projectRoot: root }).pendingSnapshots()).toThrow(/invalid published outbox record/);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked spool directory', () => {
    const root = temporaryRoot({ spool: false });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-target-'));
    roots.push(target);
    fs.symlinkSync(target, path.join(root, '.swarm', 'project-progression-outbox.d'), 'dir');
    expect(() => new ProgressionOutbox({ projectRoot: root }).appendSnapshot(snapshot())).toThrow(/spool/);
  });

  it.runIf(process.platform !== 'win32')('revalidates a spool path when concurrent creation reports EEXIST', () => {
    const root = temporaryRoot({ spool: false });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-race-target-'));
    roots.push(target);
    const spool = path.join(root, '.swarm', 'project-progression-outbox.d');
    const outbox = new ProgressionOutbox({ projectRoot: root, io: {
      mkdirSync(dir, options) {
        if (dir === spool) { fs.symlinkSync(target, dir, 'dir'); throw Object.assign(new Error('exists'), { code: 'EEXIST' }); }
        return fs.mkdirSync(dir, options);
      },
    } });
    expect(() => outbox.appendSnapshot(snapshot())).toThrow(/spool/);
  });

  it('validates a record before creating a spool file', () => {
    const root = temporaryRoot();
    const outbox = new ProgressionOutbox({ projectRoot: root });
    expect(() => outbox.appendRecord({ type: 'snapshot', eventKey: 'x', payloadDigest: 'x'.repeat(64) }))
      .toThrow(/snapshot identity mismatch/);
    expect(published(root)).toHaveLength(0);
  });

  it.runIf(process.platform !== 'win32')('syncs existing ancestors on every instance and retries failed parent synchronization', () => {
    const root = temporaryRoot();
    const targets = new Map();
    const synced = [];
    let fail = true;
    const options = { projectRoot: root, io: {
      openSync(file, ...args) { const fd = fs.openSync(file, ...args); targets.set(fd, file); return fd; },
    }, fsync(fd) {
      synced.push(targets.get(fd));
      if (fail) { fail = false; throw new Error('parent sync interrupted'); }
      fs.fsyncSync(fd);
    } };
    const first = new ProgressionOutbox(options);
    expect(() => first.appendSnapshot(snapshot('first'))).toThrow('parent sync interrupted');
    expect(published(root)).toHaveLength(0);
    synced.length = 0;
    first.appendSnapshot(snapshot('retry'));
    expect(synced.slice(0, 2)).toEqual([root, path.join(root, '.swarm')]);
    synced.length = 0;
    new ProgressionOutbox(options).appendSnapshot(snapshot('other-writer'));
    expect(synced.slice(0, 2)).toEqual([root, path.join(root, '.swarm')]);
    expect(first.pendingSnapshots().map((row) => row.eventKey)).toEqual(['other-writer', 'retry']);
  });

  it.runIf(process.platform === 'win32')('syncs each file without claiming directory fsync on Windows', () => {
    const root = temporaryRoot();
    const synced = [];
    const outbox = new ProgressionOutbox({ projectRoot: root, fsync(fd) {
      synced.push(fs.fstatSync(fd).isFile()); fs.fsyncSync(fd);
    } });
    outbox.appendSnapshot(snapshot());
    expect(synced).toEqual([true]);
    expect(outbox.pendingSnapshots()).toEqual([snapshot()]);
  });

  it('reduces reversed records, commits before snapshots, and duplicate commits consistently', () => {
    const root = temporaryRoot();
    const outbox = new ProgressionOutbox({ projectRoot: root });
    const a = snapshot('a'), b = snapshot('b');
    outbox.markCommitted(commit(a));
    outbox.appendSnapshot(a);
    outbox.markCommitted(commit(a));
    outbox.appendSnapshot(b);
    const reverse = new ProgressionOutbox({ projectRoot: root, io: {
      readdirSync: (...args) => fs.readdirSync(...args).reverse(),
    } });
    expect(outbox.pendingSnapshots()).toEqual([b]);
    expect(reverse.pendingSnapshots()).toEqual([b]);
    outbox.markCommitted(commit({ ...a, payloadDigest: 'b'.repeat(64) }));
    expect(() => outbox.pendingSnapshots()).toThrow(/commit collision/);
    expect(() => reverse.pendingSnapshots()).toThrow(/commit collision/);
  });

  it('rejects differing bodies that claim the same event and digest', () => {
    const root = temporaryRoot();
    const outbox = new ProgressionOutbox({ projectRoot: root });
    outbox.appendSnapshot(snapshot());
    outbox.appendSnapshot(snapshot(undefined, { completeProjectState: { nextAction: 'different' } }));
    expect(() => outbox.pendingSnapshots()).toThrow(/event key collision/);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['missing newline', Buffer.from('{}')],
    ['invalid UTF-8', Buffer.from([0xff, 0x0a])],
    ['missing commit time', Buffer.from(JSON.stringify({ type: 'commit', eventKey: 'a', payloadDigest: 'a', readbackDigest: 'a' }) + '\n')],
    ['mismatched readback', Buffer.from(JSON.stringify({ type: 'commit', eventKey: 'a', payloadDigest: 'a', readbackDigest: 'b', committedAt: 'now' }) + '\n')],
  ])('rejects a published %s record', (_label, bytes) => {
    const root = temporaryRoot();
    const outbox = new ProgressionOutbox({ projectRoot: root });
    fs.writeFileSync(path.join(outbox.spoolPath, `${'c'.repeat(32)}.rec`), bytes);
    expect(() => outbox.records()).toThrow();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER])('rejects invalid write progress %s', (progress) => {
    const root = temporaryRoot();
    expect(() => new ProgressionOutbox({ projectRoot: root, io: { writeSync: () => progress } })
      .appendSnapshot(snapshot())).toThrow(/invalid outbox write progress/);
    expect(published(root)).toHaveLength(0);
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked parent for reads as well as writes', () => {
    const root = temporaryRoot();
    const parent = path.join(root, '.swarm');
    fs.renameSync(parent, path.join(root, 'saved-swarm'));
    fs.symlinkSync(path.join(root, 'saved-swarm'), parent, 'dir');
    const outbox = new ProgressionOutbox({ projectRoot: root });
    expect(() => outbox.records()).toThrow(/parent/);
    expect(() => outbox.appendSnapshot(snapshot())).toThrow(/parent/);
  });
});
