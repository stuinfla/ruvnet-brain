/**
 * health-repair.mjs — the executor behind the console's health recommendations.
 *
 * Context (2026-07-21): the console detected a CORRUPT AgentDB store, scored it 49/100, drew a card,
 * and offered no fix. "When it finds a problem, the fact that it didn't recommend a fix is
 * unconscionable." This file guards the repair half.
 *
 * These are SAFETY tests, not happy-path tests. A repair tool that lies about success, or that
 * destroys rows while claiming to fix indexes, is worse than no repair tool at all — so the
 * properties held here are:
 *
 *   1. A clean store is left alone and says so (no busywork, no false "repaired!").
 *   2. Corruption REINDEX cannot fix is reported as FAILURE with the backup path — never as success.
 *   3. A backup always exists before any write.
 *
 * The lossless-repair case was verified live on the real store rather than synthesized here:
 * 1193 rows before, 1193 after, integrity_check ok. Index-entry drift ("wrong # of entries in
 * index X") is not reproducible with plain SQL — deleting an index from sqlite_master produces
 * ORPHAN-PAGE corruption, a genuinely different class, which is what test 2 exercises.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'health-repair.mjs');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-repair-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const sqlite = (db, sql) => execFileSync('sqlite3', [db, sql], { encoding: 'utf8', timeout: 60_000 }).trim();

/** Remove idx_ns's schema entry — corruption REINDEX genuinely cannot repair. Distro sqlite3
 * builds (ubuntu-24.04's 3.45) compile with defensive guards that REFUSE writable_schema DML, so
 * the plain form threw before ever corrupting and both tests died at the fixture — red on CI since
 * 2026-07-24 (3.9.71) while green on macOS builds without the guard. `--unsafe-testing` (CLI ≥3.44)
 * disables exactly those guards; fall back to the plain form for older CLIs that lack the flag. */
function corruptIndex(db) {
  const sql = "PRAGMA writable_schema=ON; DELETE FROM sqlite_master WHERE type='index' AND name='idx_ns'; PRAGMA writable_schema=OFF;";
  try {
    execFileSync('sqlite3', ['--unsafe-testing', db, sql], { encoding: 'utf8', timeout: 60_000 });
  } catch {
    sqlite(db, sql);
  }
}

function seedStore({ rows = 3 } = {}) {
  const db = path.join(dir, 'memory.db');
  const values = Array.from({ length: rows }, (_, i) => `('lessons','k${i}','v${i}')`).join(',');
  sqlite(db, `CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, namespace TEXT, key TEXT, content TEXT);
              CREATE INDEX idx_ns ON memory_entries(namespace);
              INSERT INTO memory_entries(namespace,key,content) VALUES ${values};`);
  return db;
}

function repair(db) {
  const r = spawnSync(process.execPath, [SCRIPT, '--repair-memory', '--db', db], { encoding: 'utf8', timeout: 120_000 });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
}

function seedDistillableStore(home, relative) {
  const db = path.join(home, relative, '.swarm', 'memory.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  sqlite(db, `CREATE TABLE memory_entries(id INTEGER PRIMARY KEY, namespace TEXT, embedding BLOB);
              CREATE TABLE reasoning_patterns(id INTEGER PRIMARY KEY, promoted INTEGER DEFAULT 0);
              INSERT INTO memory_entries(namespace, embedding) VALUES ('lessons', x'01');`);
  return fs.realpathSync(db);
}

function fakeRuflo(home, marker) {
  const executable = path.join(home, '.npm-global', 'bin', 'ruflo');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "memory" ] && [ "$2" = "backup" ]; then exit 0; fi
if [ "$1" = "memory" ] && [ "$2" = "distill" ] && [ "$3" = "run" ]; then
  shift 3
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--db" ]; then db="$2"; shift 2; else shift; fi
  done
  sqlite3 "$db" "INSERT INTO reasoning_patterns(promoted) VALUES (0);"
  printf '%s\\n' "$db" >> "$DISTILL_MARKER"
  exit 0
fi
exit 1
`);
  fs.chmodSync(executable, 0o755);
  return { ...process.env, HOME: home, DISTILL_MARKER: marker };
}

const backupsIn = () => fs.readdirSync(dir).filter((f) => f.includes('.rescue-'));

describe('health-repair --repair-memory', () => {
  it('leaves a CLEAN store alone and says so', () => {
    const db = seedStore();

    const { out, code } = repair(db);

    expect(code, 'a clean store is a success, not an error').toBe(0);
    expect(out).toMatch(/already clean/i);
    expect(backupsIn(), 'no backup churn when there is nothing to repair').toEqual([]);
    expect(Number(sqlite(db, 'SELECT COUNT(*) FROM memory_entries;'))).toBe(3);
  });

  it('reports FAILURE (never success) on corruption it cannot fix, and keeps the backup', () => {
    const db = seedStore();
    // Orphan-page corruption: remove the index definition itself. REINDEX genuinely cannot repair
    // this, so the tool must say so rather than run REINDEX and declare victory.
    corruptIndex(db);

    const { out, code } = repair(db);

    expect(code, 'unfixable corruption must exit non-zero').toBe(1);
    expect(out).toMatch(/still corrupt/i);
    expect(out, 'the user must be told where their backup is').toMatch(/rescue-/);
    expect(backupsIn().length, 'a backup must exist before any write').toBe(1);
  });

  it('never destroys rows — the data survives even a failed repair', () => {
    const db = seedStore({ rows: 5 });
    corruptIndex(db);

    repair(db);

    expect(Number(sqlite(db, 'SELECT COUNT(*) FROM memory_entries;')), 'rows must be untouched').toBe(5);
  });

  it('says so plainly when there is no store at all, instead of pretending', () => {
    const { out, code } = repair(path.join(dir, 'does-not-exist.db'));
    expect(code).toBe(1);
    expect(out).toMatch(/no memory store/i);
  });
});

describe('health-repair --distill-fleet discovery', () => {
  it('uses the shared no-argument fleet policy so hidden known stores are not dropped', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const source = seedDistillableStore(home, 'source/hm/a');
    const global = seedDistillableStore(home, '.claude');
    const marker = path.join(dir, 'distilled.txt');
    const run = spawnSync(process.execPath, [SCRIPT, '--distill-fleet'], {
      env: fakeRuflo(home, marker),
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n').sort()).toEqual([global, source].sort());
  });

  it('keeps --root genuinely scoped', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(home, { recursive: true });
    const source = seedDistillableStore(home, 'source/hm/a');
    seedDistillableStore(home, '.claude');
    const marker = path.join(dir, 'distilled.txt');
    const run = spawnSync(process.execPath, [SCRIPT, '--distill-fleet', '--root', path.join(home, 'source')], {
      env: fakeRuflo(home, marker),
      encoding: 'utf8',
      timeout: 120_000,
    });

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toEqual([source]);
  });
});
