// tests/unit/oracle-repo-recall.test.mjs
//
// The blocking corpus retrieval gate. Every predicate here is proved by BREAKING the thing it
// guards and watching the gate refuse — a test that cannot fail on broken input is not a test.
//
// The gate replaced ADR-086's C3 as the blocking predicate after C3 measured 59.0% on the real
// archive. That swap is a DECLARED REDUCTION in release requirements, not a demonstration that C3
// passed, and the report is required to say so in its own fields — the last test pins that, because
// the honesty of the published report is the thing most likely to erode quietly.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ABSOLUTE_FLOOR, RECALL_KIND, RECALL_SCHEMA_VERSION, RecallGateError,
  effectiveFloor, evaluateGate, loadFixture, readFloor, runRepoRecall, scoreQuestion, tally,
  validateFloor, validateRecallReport,
} from '../../scripts/oracle/repo-recall.mjs';

const FIXTURE_COUNT = 194;
const fixtureSha = loadFixture().fixtureSha256;

const rowsWith = ({ n = FIXTURE_COUNT, covered = FIXTURE_COUNT, top5 = 176, top1 = 139, errors = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    store: `s${i}`,
    expectedPath: 'a.md',
    repoCovered: i < covered && i >= errors,
    exactFileRank: i < top1 ? 1 : i < top5 ? 4 : null,
    returnedPaths: [],
    ...(i < errors ? { error: 'boom', repoCovered: false, exactFileRank: null } : {}),
  }));

describe('the frozen fixture', () => {
  it('is exactly one human question per repository and is bound by digest', () => {
    const f = loadFixture();
    expect(f.questions).toHaveLength(FIXTURE_COUNT);
    expect(new Set(f.questions.map((q) => q.store)).size).toBe(FIXTURE_COUNT);
    expect(f.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.sourceCommit).toBe('149b290c2b9ae5f60abb61169689e7580b99be69');
  });

  it('resolves its default when the CLI flag is absent — null, not undefined, is what argv parsing yields', () => {
    // The first real run of this gate died with "paths[0] must be of type string. Received null"
    // because a default parameter only fires on undefined, and `arg(argv, '--fixture')` returns null.
    expect(loadFixture(null).questions).toHaveLength(FIXTURE_COUNT);
    expect(readFloor(null).hitTop5Floor).toBe(176);
  });

  it('changes identity the instant a question or a label is edited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-fixture-'));
    const original = JSON.parse(fs.readFileSync('data/retrieval-query-evidence.json', 'utf8'));
    const [first] = Object.keys(original.queries);
    const edited = structuredClone(original);
    edited.queries[first].expected.path = 'somewhere/else.md';
    const file = path.join(dir, 'edited.json');
    fs.writeFileSync(file, JSON.stringify(edited));
    expect(loadFixture(file).fixtureSha256).not.toBe(fixtureSha);
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
  it('scores equivalent content under a different filename as a MISS, with no retrospective credit', () => {
    const s = scoreQuestion({ store: 'myrepo', expectedPath: 'readme.md', results });
    expect(s.exactFileRank).toBeNull();
    expect(s.repoCovered).toBe(true);
  });
  it('reports no coverage when nothing came back from the requested repository', () => {
    expect(scoreQuestion({ store: 'absent', expectedPath: 'a', results }))
      .toMatchObject({ repoCovered: false, exactFileRank: null });
  });
});

describe('the blocking predicates each refuse the thing they guard', () => {
  const floorValue = ABSOLUTE_FLOOR;
  const pass = () => evaluateGate({ totals: tally(rowsWith()), floorValue, fixtureCount: FIXTURE_COUNT });

  it('passes the measured candidate exactly as measured', () => {
    expect(pass()).toEqual({ verdict: 'PASS', failures: [] });
    expect(tally(rowsWith())).toMatchObject({ questions: 194, errors: 0, repoCoverage: 194, hitTop5: 176, hitTop1: 139 });
  });

  it('refuses a run where any question errored', () => {
    const g = evaluateGate({ totals: tally(rowsWith({ errors: 1 })), floorValue, fixtureCount: FIXTURE_COUNT });
    expect(g.verdict).toBe('FAIL');
    expect(g.failures.join(' ')).toMatch(/failed to complete/);
  });

  it('refuses a run that did not ask every frozen question', () => {
    const g = evaluateGate({ totals: tally(rowsWith({ n: 193, covered: 193, top5: 176 })), floorValue, fixtureCount: FIXTURE_COUNT });
    expect(g.verdict).toBe('FAIL');
    expect(g.failures.join(' ')).toMatch(/asked 193 of 194/);
  });

  it('refuses an archive where even ONE repository returns nothing of its own', () => {
    const g = evaluateGate({ totals: tally(rowsWith({ covered: 193 })), floorValue, fixtureCount: FIXTURE_COUNT });
    expect(g.verdict).toBe('FAIL');
    expect(g.failures.join(' ')).toMatch(/1 repository\(ies\) returned nothing of their own/);
  });

  it('REFUSES 175/194 even with perfect repository coverage — the ratchet, not coverage, has the teeth', () => {
    const g = evaluateGate({ totals: tally(rowsWith({ top5: 175 })), floorValue, fixtureCount: FIXTURE_COUNT });
    expect(g.verdict).toBe('FAIL');
    expect(g.failures.join(' ')).toMatch(/regressed to 175, below the accepted floor of 176/);
  });

  it('accepts an improvement above the floor', () => {
    expect(evaluateGate({ totals: tally(rowsWith({ top5: 190 })), floorValue, fixtureCount: FIXTURE_COUNT }).verdict).toBe('PASS');
  });
});

describe('the floor cannot be edited down to buy a pass', () => {
  it('clamps at the absolute floor however low the committed file claims', () => {
    expect(effectiveFloor({ floor: { hitTop5Floor: 0, fixtureSha256: fixtureSha }, fixtureSha256: fixtureSha })).toBe(ABSOLUTE_FLOOR);
    expect(effectiveFloor({ floor: { hitTop5Floor: 190, fixtureSha256: fixtureSha }, fixtureSha256: fixtureSha })).toBe(190);
  });

  it('refuses a floor accepted against a different fixture rather than carrying it over', () => {
    expect(() => effectiveFloor({ floor: { hitTop5Floor: 176, fixtureSha256: 'a'.repeat(64) }, fixtureSha256: fixtureSha }))
      .toThrow(/re-accept the floor against the current fixture/);
  });

  it('refuses a malformed or absent floor instead of defaulting to none', () => {
    expect(validateFloor({ schemaVersion: 2, kind: 'x' }).length).toBeGreaterThan(0);
    expect(validateFloor({ schemaVersion: 1, kind: 'ruvnet-brain-repo-recall-floor', hitTop5Floor: -1, fixtureSha256: fixtureSha })
      .join(' ')).toMatch(/not a count/);
    expect(() => readFloor(path.join(os.tmpdir(), 'no-such-floor.json'))).toThrow(/recall floor missing/);
  });

  it('the committed floor is real, well-formed, and bound to the committed fixture', () => {
    const floor = readFloor();
    expect(floor.hitTop5Floor).toBe(176);
    expect(floor.fixtureSha256).toBe(fixtureSha);
  });
});

describe('a published report cannot lie about the archive or its own numbers', () => {
  const baseReport = (overrides = {}) => {
    const rows = rowsWith();
    return {
      schemaVersion: RECALL_SCHEMA_VERSION, kind: RECALL_KIND, state: 'PASS',
      archive: { sha256: 'a'.repeat(64), bytes: 10 },
      fixture: { sha256: fixtureSha, questionCount: FIXTURE_COUNT },
      floor: { value: ABSOLUTE_FLOOR }, totals: tally(rows), rows, ...overrides,
    };
  };
  const archive = { sha256: 'a'.repeat(64), bytes: 10 };

  it('accepts an honest report', () => {
    expect(validateRecallReport({ report: baseReport(), archive, expectedFixtureSha256: fixtureSha }).state).toBe('PASS');
  });

  it('refuses a report describing a different archive', () => {
    expect(() => validateRecallReport({ report: baseReport(), archive: { sha256: 'b'.repeat(64), bytes: 10 } }))
      .toThrow(/does not describe this archive/);
  });

  it('refuses totals that do not re-derive from the report’s own rows', () => {
    const report = baseReport();
    report.totals = { ...report.totals, hitTop5: 194 };
    expect(() => validateRecallReport({ report, archive })).toThrow(/do not re-derive/);
  });

  it('refuses a report measured against a substituted fixture', () => {
    expect(() => validateRecallReport({ report: baseReport(), archive, expectedFixtureSha256: 'c'.repeat(64) }))
      .toThrow(/different frozen fixture/);
  });

  it('MUST BLOCK: a report that declares its OWN lower floor — the ratchet is read from the committed file', () => {
    // Without this, every other check passes a collapsed candidate: the totals re-derive correctly,
    // the archive binding holds, and the report simply says the bar is lower than it is.
    const rows = rowsWith({ top5: 120 });
    const report = baseReport({ rows, totals: tally(rows), floor: { value: 120 } });
    expect(() => validateRecallReport({ report, archive, expectedFixtureSha256: fixtureSha }))
      .toThrow(/declares a floor of 120, below the committed floor of 176/);
  });

  it('refuses a report whose rows fail the gate even if it declares itself PASS', () => {
    const rows = rowsWith({ top5: 170 });
    expect(() => validateRecallReport({ report: baseReport({ rows, totals: tally(rows) }), archive }))
      .toThrow(/regressed to 170/);
  });
});

describe('the report states what it did NOT prove', () => {
  it('publishes the C3 disclosure, the coverage-is-not-accuracy warning, and the no-credit rule', async () => {
    const { report } = await runRepoRecall({
      kbDir: '/unused', archive: { sha256: 'a'.repeat(64), bytes: 1 },
      searchAll: async ({ repos }) => ({ results: [{ repo: repos[0], path: 'readme.md' }] }),
    });
    expect(report.meaning.c3).toMatch(/NOT demonstrated by this report and was NOT met/);
    expect(report.meaning.repoCoverage).toMatch(/AVAILABILITY check, NOT answer accuracy/);
    expect(report.meaning.hitTop5).toMatch(/scores as a MISS and is not given retrospective credit/);
    expect(report.meaning.notMeasured).toMatch(/generated-answer correctness and citation support were NOT evaluated/);
    expect(report.fixture.questionCount).toBe(FIXTURE_COUNT);
  });

  it('reports a store that could not be OPENED as an ERROR, never as an empty repository', async () => {
    // A broken harness and an empty corpus both yield zero results. Conflating them once published a
    // clean-looking 0/194 twice in one session. The gate must distinguish them.
    const { report } = await runRepoRecall({
      kbDir: '/unused', archive: null,
      searchAll: async ({ repos }) => ({ results: [], perRepo: { [repos[0]]: "ERR: Cannot resolve '@xenova/transformers'." } }),
    });
    expect(report.totals.errors).toBe(FIXTURE_COUNT);
    expect(report.totals.repoCoverage).toBe(0);
    expect(report.state).toBe('FAIL');
    expect(report.failures.join(' ')).toMatch(/failed to complete/);
    expect(report.rows[0].error).toMatch(/Cannot resolve/);
  });

  it('fails closed when the shipped search entry point is absent rather than scoring zero', async () => {
    await expect(runRepoRecall({ kbDir: path.join(os.tmpdir(), 'nope') }))
      .rejects.toThrow(RecallGateError);
  });

  it('MUST BLOCK: grading code the archive does not actually ship', async () => {
    // The measurement imports the checkout's kb/forge-ask-all.mjs because an extracted archive has no
    // node_modules — so it must PROVE that file is byte-identical to the archive's copy. A drift here
    // would mean publishing a number measured on code the customer never receives.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-drift-'));
    fs.writeFileSync(path.join(dir, 'forge-ask-all.mjs'), 'export const searchAll = async () => ({ results: [] });\n');
    await expect(runRepoRecall({ kbDir: dir }))
      .rejects.toThrow(/is not the checkout's .*refusing to grade code the archive does not ship/s);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
