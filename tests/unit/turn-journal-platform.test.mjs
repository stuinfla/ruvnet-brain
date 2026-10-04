import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { journalTurn, readJournal, syncTurnDirectory, acknowledgeJournal } from '../../plugin/scripts/turn-transport-journal.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const projectRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-platform-'))); roots.push(projectRoot);
  const db = path.join(projectRoot, '.swarm', 'memory.db'); fs.mkdirSync(path.dirname(db));
  const stat = fs.statSync(projectRoot); const key = 'turn-platform-synthetic';
  const step = { kind: 'store', projectRoot, projectDir: projectRoot, rootIdentity: `${stat.dev}:${stat.ino}`,
    args: ['memory', 'store', '-k', key, '--value', 'Synthetic non-private conclusion.', '-n', 'turns', '--path', db, '--no-upsert'] };
  return { db, key, step };
}
function capabilityIo({ openError, directoryError, fileError } = {}) {
  const events = []; const types = new Map();
  const io = { ...fs,
    openSync(file, flags, mode) {
      const directory = fs.existsSync(file) && fs.statSync(file).isDirectory();
      events.push({ operation: 'open', directory, flags, mode });
      if (directory && openError) throw Object.assign(new Error('synthetic directory open failure'), { code: openError });
      const fd = directory ? 0x7fff0000 + events.length : fs.openSync(file, flags, mode); types.set(fd, directory); return fd;
    },
    fsyncSync(fd) {
      const directory = types.get(fd); events.push({ operation: 'fsync', directory });
      const code = directory ? directoryError : fileError;
      if (code) throw Object.assign(new Error('synthetic flush failure'), { code });
      if (!directory) fs.fsyncSync(fd);
    },
    closeSync(fd) { events.push({ operation: 'close', directory: types.get(fd) }); if (!types.get(fd)) fs.closeSync(fd); types.delete(fd); },
  };
  return { io, events };
}
describe('turn journal platform durability is explicit and file flush is mandatory', () => {
  it.each(['EISDIR', 'EPERM', 'EACCES'])('handles Windows directory open %s after exclusive create and file fsync', (code) => {
    const f = fixture(); const { io, events } = capabilityIo({ openError: code }); let evidence;
    const file = journalTurn(f.step, f.db, f.key, { platform: 'win32', io, onDurability: (value) => { evidence = value; } });
    expect(readJournal(file, f.db).value).toBe('Synthetic non-private conclusion.');
    expect(events[0]).toMatchObject({ operation: 'open', directory: false, flags: 'wx', mode: 0o600 });
    expect(events.findIndex((event) => event.operation === 'fsync' && !event.directory)).toBeLessThan(events.findIndex((event) => event.operation === 'open' && event.directory));
    expect(evidence).toMatchObject({ fileFsync: 'completed', entry: 'created-exclusively', directoryFsync: 'unavailable', reason: code });
    expect(evidence.limitation).toContain('power loss is unproven');
  });
  it.each(['EINVAL', 'ENOTSUP', 'EBADF', 'EACCES'])('handles Windows unsupported directory flush %s and closes its descriptor', (code) => {
    const f = fixture(); const { io, events } = capabilityIo({ directoryError: code }); let evidence;
    journalTurn(f.step, f.db, f.key, { platform: 'win32', io, onDurability: (value) => { evidence = value; } });
    expect(evidence.directoryFsync).toBe('unavailable'); expect(events.at(-1)).toMatchObject({ operation: 'close', directory: true });
  });
  it.each(['linux', 'darwin'])('unexpected directory EIO on %s fails closed before reporting queued durability', (platform) => {
    const f = fixture(); const { io } = capabilityIo({ directoryError: 'EIO' }); let evidence;
    expect(() => journalTurn(f.step, f.db, f.key, { platform, io, onDurability: (value) => { evidence = value; } })).toThrow('synthetic flush failure');
    expect(evidence).toBeUndefined();
  });
  it('Windows directory EIO and missing paths are never treated as unsupported capability', () => {
    for (const code of ['EIO', 'ENOENT']) {
      const f = fixture(); const { io } = capabilityIo({ openError: code });
      expect(() => journalTurn(f.step, f.db, f.key, { platform: 'win32', io })).toThrow();
    }
  });
  it.each(['win32', 'linux'])('file fsync failure on %s remains fatal even if directory flush is unsupported', (platform) => {
    const f = fixture(); const { io, events } = capabilityIo({ fileError: 'EIO', openError: 'EPERM' });
    expect(() => journalTurn(f.step, f.db, f.key, { platform, io })).toThrow('synthetic flush failure');
    expect(events.some((event) => event.directory)).toBe(false);
  });
  it('an existing exact entry is reflushed before successful evidence; no upsert occurs', () => {
    const f = fixture(); journalTurn(f.step, f.db, f.key); const { io, events } = capabilityIo({ openError: 'EPERM' }); let evidence;
    journalTurn(f.step, f.db, f.key, { platform: 'win32', io, onDurability: (value) => { evidence = value; } });
    expect(evidence.entry).toBe('existing-exact-match-reflushed'); expect(events.some((event) => event.operation === 'fsync' && !event.directory)).toBe(true);
  });
  it('acknowledgement exposes the same Windows namespace limitation', () => {
    const f = fixture(); const file = journalTurn(f.step, f.db, f.key); const { io } = capabilityIo({ openError: 'EPERM' });
    expect(acknowledgeJournal(file, f.db, { platform: 'win32', io })).toMatchObject({ directoryFsync: 'unavailable' });
    expect(fs.existsSync(file)).toBe(false);
  });
});
