import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ADR-067 — PROMOTION IS NOT DONE WHEN THE PROSE IS WRITTEN.
 *
 * `lesson-promote --apply` wrote a block into ~/.claude/CLAUDE.md and reported success. That block is
 * PROSE, and this project's founding measurement says what prose is worth:
 *
 *     gates that could interrupt:  8 fired,  8 obeyed   (100%)
 *     prose in CLAUDE.md:          6 chances, 0 obeyed
 *
 * So the pipeline built to stop the owner repeating himself 87 times terminated in the one medium
 * already measured at zero — and called it "promoted".
 *
 * The fix is NOT auto-tagging. A trigger asserts which moment a lesson belongs to, and guessing it is
 * the keyword-classifier mistake ADR-065 recorded in its own numbers. The fix is that promotion may
 * no longer report a half-finished job as a finished one: it states, derived from the store, how many
 * machine-wide lessons actually reach a decision point and names the ones that do not.
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PROMOTE = path.join(ROOT, 'plugin', 'scripts', 'lesson-promote.mjs');

const sqlite = await (async () => {
  try { return (process.getBuiltinModule?.('node:sqlite')) ?? (await import('node:sqlite')); }
  catch { return null; }
})();
const withSqlite = sqlite ? describe : describe.skip;

let home; let globalDb;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-fire-'));
  globalDb = path.join(home, 'global.db');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A global store with a mix of armed and inert lessons — the state the report must describe. */
function seed(rows) {
  const db = new sqlite.DatabaseSync(globalDb);
  db.exec(`CREATE TABLE memory_entries (
    id TEXT PRIMARY KEY, key TEXT NOT NULL, namespace TEXT DEFAULT 'default', content TEXT NOT NULL,
    tags TEXT, metadata TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    provenance_type TEXT DEFAULT 'unknown', UNIQUE(namespace, key))`);
  const ins = db.prepare('INSERT INTO memory_entries (id,key,namespace,content,tags,updated_at) VALUES (?,?,?,?,?,?)');
  rows.forEach((r, i) => ins.run(String(i), r.key, 'global', 'A lesson that says what to DO, at length.',
    r.tags ? JSON.stringify(r.tags.split(',')) : null, 1754800000000));
  db.close();
}

function runApply() {
  const file = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(file, '# instructions\n');
  const r = spawnSync(process.execPath, [PROMOTE, '--apply', '--file', file], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, RUVNET_GLOBAL_MEMORY_DB: globalDb },
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

withSqlite('promotion reports whether what it promoted can actually act', () => {
  it('states how many machine-wide lessons reach a decision point', () => {
    seed([
      { key: 'lesson-armed-one', tags: 'trigger:write-code,enforce:inject' },
      { key: 'lesson-armed-two', tags: 'trigger:ship,enforce:checklist' },
      { key: 'lesson-inert', tags: null },
    ]);
    const out = runApply();
    expect(out).toMatch(/FIRING STATUS — 2 of 3 machine-wide lesson\(s\) reach a decision point/);
  }, 70_000);

  it('TEETH: names the inert ones — a count alone lets the gap stay invisible', () => {
    // The defect was never "the number is wrong", it was that no number existed and `--apply`
    // reported success regardless. A bare count would repeat that in miniature: you would know some
    // lesson was inert and never which, so nothing would get fixed.
    seed([
      { key: 'lesson-armed', tags: 'trigger:write-code,enforce:inject' },
      { key: 'lesson-forgotten-completely', tags: null },
    ]);
    const out = runApply();
    expect(out).toMatch(/1 are PROSE ONLY/);
    expect(out).toContain('lesson-forgotten-completely');
    expect(out, 'and the one command that arms it').toMatch(/ruflo memory store .*--tags "trigger:/s);
  }, 70_000);

  it('TEETH: does NOT auto-assign a trigger — guessing the moment is the banned move', () => {
    // ADR-066 refuses to classify which moment a lesson belongs to; a keyword mapper is what put a
    // false positive into ADR-065's own numbers. If promotion ever started tagging, an inert lesson
    // would silently become an armed one that fires at a moment nobody chose.
    seed([{ key: 'lesson-inert', tags: null }]);
    runApply();
    const db = new sqlite.DatabaseSync(globalDb, { readOnly: true });
    const row = db.prepare("SELECT tags FROM memory_entries WHERE key = 'lesson-inert'").get();
    db.close();
    expect(row.tags, 'the store must be untouched by a report').toBeNull();
  }, 70_000);

  it('says so plainly when there is no machine-wide store at all', () => {
    // A fresh install has none. Reporting "0 of 0 fire" would read as a failing system; the truth is
    // that nothing has been promoted here yet.
    const out = runApply();
    expect(out).toMatch(/no machine-wide lesson store on this machine/);
  }, 70_000);

  it('the firing status is wired into the apply path, not merely defined', () => {
    // The defect class this whole session is about: code that exists and is never called.
    const src = fs.readFileSync(PROMOTE, 'utf8');
    const apply = src.slice(src.indexOf("if (has('--apply'))"));
    expect(apply.slice(0, 500), 'reportFiringStatus must run on the apply path').toMatch(/reportFiringStatus\(\)/);
    expect(src, 'and must read the store through the bridge, not a second reader')
      .toMatch(/import \{ readGlobalRows \} from '\.\/lesson-bridge\.mjs'/);
  });
});
