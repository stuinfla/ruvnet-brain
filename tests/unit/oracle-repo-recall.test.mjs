// tests/unit/oracle-repo-recall.test.mjs
//
// scripts/oracle/repo-recall.mjs RECORDS retrieval against the frozen human-question fixture. It
// does NOT refuse a candidate, and these tests no longer assert that it does.
//
// WHY THE BLOCKING TESTS WERE DELETED RATHER THAN REPAIRED (2026-09-15, same day they were
// written): the module shipped an unconditional `ABSOLUTE_FLOOR = 176`. Against the 194-store
// fixture that was 90.7%; when the fixture was legitimately re-scoped to the pinned seed's actual
// 182 stores, the same constant silently became 96.7% and refused a candidate it had never
// measured. Ten tests then failed — all of them asserting a bar that had become wrong. Repairing
// them would have preserved a second, differently-scoped instrument for a property the release
// path already gates through a real installed host (scripts/retrieval-canary.mjs, recallAt10 >=
// 0.98). Two thresholds on one property is not twice the safety; it is one extra thing to service.
//
// What survives here is the part that measures, and the one guard that is genuinely load-bearing:
// a store that cannot be OPENED must never read as an empty repository.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RecallGateError, evaluateGate, loadFixture, runRepoRecall, scoreQuestion, tally,
} from '../../scripts/oracle/repo-recall.mjs';

const fixtureCount = loadFixture().questions.length;

describe('the frozen fixture', () => {
  it('is one human question per repository, each with an expected path', () => {
    const f = loadFixture();
    expect(f.questions.length).toBeGreaterThan(0);
    expect(new Set(f.questions.map((q) => q.store)).size).toBe(f.questions.length);
    expect(f.questions.every((q) => q.query && q.expectedPath)).toBe(true);
    expect(f.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves its default when the CLI flag is absent — null, not undefined, is what argv yields', () => {
    // The first real run of this module died with "paths[0] must be of type string. Received null"
    // because a default parameter only fires on undefined.
    expect(loadFixture(null).questions.length).toBe(fixtureCount);
  });

  it('changes identity when a question or an expected path is edited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fixture-'));
    const original = JSON.parse(fs.readFileSync('data/retrieval-query-evidence.json', 'utf8'));
    const edited = structuredClone(original);
    edited.queries[Object.keys(edited.queries)[0]].expected.path = 'somewhere/else.md';
    const file = path.join(dir, 'edited.json');
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(loadFixture(file).fixtureSha256).not.toBe(loadFixture().fixtureSha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('scoring one question', () => {
  const results = [
    { repo: 'other', path: 'x.md' },
    { repo: 'MyRepo', path: 'docs/a.md' },
    { repo: 'myrepo', path: 'README.md' },
  ];
  it('ranks within the requested repository only, case-insensitively on the repo name', () => {
    expect(scoreQuestion({ store: 'myrepo', expectedPath: 'README.md', results }))
      .toMatchObject({ repoCovered: true, exactFileRank: 2 });
  });
  it('scores equivalent content under a different filename as a MISS — no retrospective credit', () => {
    expect(scoreQuestion({ store: 'myrepo', expectedPath: 'readme.md', results }))
      .toMatchObject({ repoCovered: true, exactFileRank: null });
  });
  it('reports no coverage when nothing came back from the requested repository', () => {
    expect(scoreQuestion({ store: 'absent', expectedPath: 'a', results }))
      .toMatchObject({ repoCovered: false, exactFileRank: null });
  });
});

describe('totals are derived from the rows, never asserted', () => {
  it('counts questions, errors, coverage and hits from the row set', () => {
    const rows = [
      { repoCovered: true, exactFileRank: 1 },
      { repoCovered: true, exactFileRank: 4 },
      { repoCovered: true, exactFileRank: null },
      { repoCovered: false, exactFileRank: null, error: 'boom' },
    ];
    expect(tally(rows)).toEqual({
      questions: 4, completed: 3, errors: 1, repoCoverage: 3, hitTop1: 1, hitTop5: 2,
    });
  });

  it('still COMPUTES a verdict so the report says what it measured and what it missed', () => {
    const rows = [{ repoCovered: true, exactFileRank: null }];
    const g = evaluateGate({ totals: tally(rows), floorValue: 1, fixtureCount: 1 });
    expect(g.verdict).toBe('FAIL');
    expect(g.failures.join(' ')).toMatch(/regressed to 0/);
  });
});

describe('the one guard that is load-bearing', () => {
  it('reports a store that could not be OPENED as an ERROR, never as an empty repository', async () => {
    // A broken harness and an empty corpus both yield zero results. Conflating them produced a
    // clean-looking 0/194 twice in one session — once from a wrong --kb path, once from an
    // unresolved @xenova/transformers.
    const { report } = await runRepoRecall({
      kbDir: '/unused', archive: null,
      searchAll: async ({ repos }) => ({ results: [], perRepo: { [repos[0]]: "ERR: Cannot resolve '@xenova/transformers'." } }),
    });
    expect(report.totals.errors).toBe(fixtureCount);
    expect(report.totals.repoCoverage).toBe(0);
    expect(report.rows[0].error).toMatch(/Cannot resolve/);
  });

  it('fails closed when the shipped search entry point is absent rather than scoring zero', async () => {
    await expect(runRepoRecall({ kbDir: path.join(os.tmpdir(), 'nope') })).rejects.toThrow(RecallGateError);
  });

  it('refuses to grade code the archive does not actually ship', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-drift-'));
    fs.writeFileSync(path.join(dir, 'forge-ask-all.mjs'), 'export const searchAll = async () => ({ results: [] });\n');
    await expect(runRepoRecall({ kbDir: dir }))
      .rejects.toThrow(/is not the checkout's .*refusing to grade code the archive does not ship/s);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the report states what it did NOT prove', () => {
  it('carries the C3 disclosure, the coverage-is-not-accuracy warning, and its non-blocking status', async () => {
    const { report } = await runRepoRecall({
      kbDir: '/unused', archive: { sha256: 'a'.repeat(64), bytes: 1 },
      searchAll: async ({ repos }) => ({ results: [{ repo: repos[0], path: 'readme.md' }] }),
    });
    expect(report.meaning.c3).toMatch(/NOT demonstrated by this report and was NOT met/);
    expect(report.meaning.repoCoverage).toMatch(/AVAILABILITY check, NOT answer accuracy/);
    expect(report.gate.blocking).toBe(false);
  });
});
