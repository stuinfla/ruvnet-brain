// tests/unit/memdb-health.test.mjs — scripts/memdb-health.sh, the AgentDB (.swarm/memory.db)
// drift probe. Its own header says WHY it exists: "idx_bridge_key/idx_bridge_ns corruption
// recurred 3x on 2026-07-09/10 while the DB was in WAL mode" — a real, repeating production
// incident with zero regression coverage until now. Pure subprocess tests (no mocks, matching
// autonomy-loop.test.mjs / token-meter.test.mjs's established pattern): a real sqlite3 db file is
// created per test, the script is spawned against it, and the exit code + stdout/stderr are
// asserted against the script's own documented contract. No export/sign-off needed — this is a
// shell script exercised as a subprocess, same as ground-ruvnet.sh and loop-checkpoint.mjs already are.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/memdb-health.sh');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memdb-health-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function run(dbPath) {
  const r = spawnSync('sh', [SCRIPT, dbPath], { encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function sqlite(dbPath, sql) {
  spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' });
}

describe('memdb-health.sh', () => {
  it('exits 0 (SKIP) when the db file does not exist — absence is not unhealthy', () => {
    const r = run(path.join(tmp, 'nope.db'));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SKIP/);
  });

  it('exits 0 when journal_mode=wal and integrity_check=ok', () => {
    const db = path.join(tmp, 'memory.db');
    sqlite(db, 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);');
    const r = run(db);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/journal_mode=wal/);
    expect(r.stdout).toMatch(/integrity=ok/);
  });

  it('exits 1 (UNHEALTHY) when journal_mode has drifted off WAL, even with clean integrity', () => {
    const db = path.join(tmp, 'memory.db');
    // default journal_mode is "delete", not "wal" — this reproduces the drift class verbatim.
    sqlite(db, 'CREATE TABLE t(x); INSERT INTO t VALUES (1);');
    const r = run(db);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNHEALTHY/);
    expect(r.stderr).toMatch(/journal_mode=delete/);
  });

  it('exits 1 (UNHEALTHY) when integrity_check fails, even in WAL mode', () => {
    const db = path.join(tmp, 'memory.db');
    sqlite(db, 'PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);');
    // Corrupt the file directly by truncating it mid-page — sqlite3's integrity_check then reports
    // something other than a clean "ok" line.
    const fd = fs.openSync(db, 'r+');
    fs.ftruncateSync(fd, 200);
    fs.closeSync(fd);
    const r = run(db);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNHEALTHY/);
  });
});
