// tests/unit/capability-registry-rnbc-qa.test.mjs — two capability rows the RNBC QA pass found
// printing claims their own data contradicted (2026-10-01, isolated console):
//   • memory-distillation: "only null patterns from 12 memories — distillation has run" (ON) for a
//     store with no countable pattern table.
//   • lessons-in-force: "3 of 5 lessons are ratified and can affect what your AI does" while one of
//     the three was switched off — lessonsFor() does not deliver a demoted lesson.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnbc-capreg-')));
const project = path.join(tmp, 'project');
const store = path.join(tmp, 'lessons.json');
let rows;

const lesson = (id, status, demoted = false) => ({
  id, statement: `Fixture rule ${id}: read the live source before stating the fact.`, trigger: 'assert-fact',
  enforcement: 'checklist', evidence: [{ observed: 'fixture' }], origin: 'user-stated', sourceClass: 'current-user',
  status, ratifiedBy: status === 'candidate' ? null : 'user', demoted,
});

beforeAll(async () => {
  fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
  const r = spawnSync('sqlite3', [path.join(project, '.swarm', 'memory.db'),
    "CREATE TABLE memory_entries(key TEXT, value TEXT, embedding BLOB); INSERT INTO memory_entries VALUES ('a','v',X'01'),('b','v',X'01'),('c','v',X'01');"], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  fs.writeFileSync(store, JSON.stringify({ version: 1, lessons: [lesson('A', 'ratified'), lesson('B', 'ratified', true), lesson('C', 'candidate')] }));
  process.env.RUVNET_LESSON_STORE = store;
  const reg = await import('../../plugin/scripts/capability-registry.mjs');
  rows = new Map(reg.auditAll({ project }).map((row) => [row.key, row]));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('capability rows never print a claim their data contradicts', () => {
  it('a store with no countable pattern table is "not checked", never "only null patterns … ON"', () => {
    const row = rows.get('memory-distillation');
    expect(row.evidence).not.toMatch(/null/);
    expect(row.state).not.toBe('on');
  });

  it('a switched-off lesson is not counted as able to affect what the AI does', () => {
    const row = rows.get('lessons-in-force');
    expect(row.evidence).toMatch(/^1 of 3 lessons/);
  });
});
