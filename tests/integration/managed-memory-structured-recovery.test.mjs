import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ISSUE #140 (@sparkling) — WHEN SEARCH IS NOT ENOUGH, THE ANSWER IS STRUCTURED RETRIEVAL, NOT SQL.
 *
 * His acceptance criterion, verbatim: "A scenario test reproduces truncated semantic-search output
 * and proves the agent resolves the exact key through Ruflo's structured interfaces."
 *
 * THE REAL INCIDENT: during an OPDA documentation task, Ruflo's user-memory search returned
 * truncated keys and previews. The agent could not read the full content from the search result, so
 * it ran read-only SQLite against `~/.claude-flow/user-memory.db` — a managed store. That bypass was
 * not improvised; the Brain's own PLAYBOOK told it to ("confirm the exact row through SQLite").
 *
 * WHAT THIS TEST PINS, and why it is framed on the CONTRACT rather than on the truncation string:
 * measured on ruflo 3.38.12 while writing this, semantic search for a freshly-stored long value
 * returned `[WARN] No results found` rather than a truncated preview. Insufficient search output has
 * more than one shape — truncated, elided, empty, or simply not yet embedded — and a test asserting
 * one exact shape would pass while the class stayed open. The durable fact is the RECOVERY PATH:
 * whatever search does or does not return, the exact key resolves through
 * `ruflo memory retrieve --path … -k …` and returns the FULL value, with no database access.
 *
 * This is also why the fix is not "never touch sqlite3". Application databases are untouched
 * (#140 grants that explicitly). Only MANAGED stores are in scope.
 */
const ruflo = spawnSync('ruflo', ['--version'], { encoding: 'utf8' });
const HAVE_RUFLO = !ruflo.error && ruflo.status === 0;
// A machine without ruflo cannot answer this question. It must SKIP, not fail — the same fail-open
// rule that a sibling hook violated by refusing every `git push` on machines that lacked it.
const gated = HAVE_RUFLO ? it : it.skip;

const run = (args) => execFileSync('ruflo', args, { encoding: 'utf8', timeout: 120_000 });

describe('issue #140 — the exact key is recoverable without opening the database', () => {
  gated('TEETH: a value too long to read from search output resolves in FULL via retrieve', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-recovery-'));
    const db = path.join(dir, 'memory.db');
    const key = `scenario-140-${process.pid}-${Date.now()}`;
    // Long enough that no preview could carry it, and marked at BOTH ends so a truncated echo
    // cannot masquerade as a complete answer.
    const value = `HEAD-${key} ${'documentation-inventory '.repeat(40)}TAIL-${key}`;
    try {
      run(['memory', 'store', '--path', db, '-n', 'default', '-k', key, '--value', value]);

      // The recovery path the guidance now prescribes: exact key, explicit --path, structured tool.
      const back = run(['memory', 'retrieve', '--path', db, '-n', 'default', '-k', key]);

      expect(back, 'the HEAD of the value must come back').toContain(`HEAD-${key}`);
      expect(back, 'and the TAIL — a truncated echo would carry the head only').toContain(`TAIL-${key}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 200_000);

  gated('a USER-LEVEL store at an explicit --path is reachable the same way', () => {
    // #140's second acceptance criterion. The incident happened against
    // `~/.claude-flow/user-memory.db` — a non-default path — and the argument for raw SQL was that
    // the structured route did not cover it. It does: `--path` is the whole mechanism.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-userlevel-'));
    const db = path.join(dir, 'user-memory.db');
    const key = `userlevel-140-${process.pid}`;
    try {
      run(['memory', 'store', '--path', db, '-n', 'default', '-k', key, '--value', `alt-store-${key}`]);
      expect(run(['memory', 'retrieve', '--path', db, '-n', 'default', '-k', key])).toContain(`alt-store-${key}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 200_000);

  gated('TEETH: a MISSING key reports not-found rather than inventing content', () => {
    // The property that makes retrieve a sufficient substitute for a SQL rowcount. During the
    // 2026-08-13 incident it answered `Key not found` on precisely the writes that had evaporated
    // while `store` was printing `[OK] Data stored successfully` — so retrieve, not SQL, was always
    // the honest witness.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-absent-'));
    const db = path.join(dir, 'memory.db');
    try {
      run(['memory', 'store', '--path', db, '-n', 'default', '-k', 'seed', '--value', 'seed']);
      let out = '';
      try { out = run(['memory', 'retrieve', '--path', db, '-n', 'default', '-k', 'no-such-key-here']); }
      catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
      expect(out, 'an absent key must say so plainly').toMatch(/not found/i);
      expect(out, 'and must not echo the only value in the store').not.toContain('seed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 200_000);

  it('the recovery path this test exercises uses NO database access', () => {
    // Runs everywhere, including machines with no ruflo: the guarantee is a property of THIS FILE,
    // so it must not be skippable. If a future edit reintroduces sqlite3 here, the scenario test
    // would be demonstrating the bypass it exists to forbid.
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    const code = src.replace(/^\s*(\/\/|\*).*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code, 'this scenario must resolve keys through ruflo, never through the database')
      .not.toMatch(/spawnSync\(\s*['"`]sqlite3|execFileSync\(\s*['"`]sqlite3/);
  });
});
