import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { sqlite } = vi.hoisted(() => ({ sqlite: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: sqlite }));
import { diagnose } from '../../plugin/scripts/memory-doctor.mjs';

const fixtures = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-doctor-wal-'));
  fixtures.push(dir);
  const db = path.join(dir, 'memory.db');
  fs.writeFileSync(db, 'disposable database bytes');
  return db;
}
function writerSidecars(db) {
  fs.writeFileSync(`${db}-wal`, 'concurrent writer committed frames');
  fs.writeFileSync(`${db}-shm`, 'concurrent writer index');
}
function expectPreserved(db) {
  expect(fs.readFileSync(db, 'utf8')).toBe('disposable database bytes');
  expect(fs.readFileSync(`${db}-wal`, 'utf8')).toBe('concurrent writer committed frames');
  expect(fs.readFileSync(`${db}-shm`, 'utf8')).toBe('concurrent writer index');
}
afterEach(() => {
  sqlite.mockReset();
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('memory doctor never owns a concurrent writer WAL', () => {
  it('refuses a result when sidecars appear during an immutable read, preserving their bytes', () => {
    const db = fixture();
    sqlite.mockImplementationOnce((_exe, [uri]) => {
      expect(uri).toContain('immutable=1');
      writerSidecars(db);
      return 'ok\n';
    });
    const result = diagnose(db);
    expect(result.unreadable).toBe('a writer opened the store mid-read');
    expect(result.learns).toBe(false);
    expect(sqlite).toHaveBeenCalledTimes(1);
    expectPreserved(db);
  });

  it('preserves newly appeared sidecars when the read fails', () => {
    const db = fixture();
    sqlite.mockImplementationOnce(() => {
      writerSidecars(db);
      throw Object.assign(new Error('database is locked'), { stderr: 'database is locked' });
    });
    expect(diagnose(db).unreadable).toBe('database is locked');
    expectPreserved(db);
  });

  it('uses ordinary read-only mode for a later retry with sidecars already present', () => {
    const db = fixture();
    writerSidecars(db);
    sqlite.mockImplementation((_exe, [uri, sql]) => {
      expect(uri).toContain('mode=ro');
      expect(uri).not.toContain('immutable=1');
      return sql === 'PRAGMA integrity_check;' ? 'ok\n' : '0\n';
    });
    expect(diagnose(db).total).toBe(0);
    expectPreserved(db);
  });

  it('does not create sidecars when a resting-store diagnosis completes', () => {
    const db = fixture();
    sqlite.mockImplementation((_exe, [uri, sql]) => {
      expect(uri).toContain('immutable=1');
      return sql === 'PRAGMA integrity_check;' ? 'ok\n' : '0\n';
    });
    expect(diagnose(db).total).toBe(0);
    expect(fs.existsSync(`${db}-wal`)).toBe(false);
    expect(fs.existsSync(`${db}-shm`)).toBe(false);
  });
});
