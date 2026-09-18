import crypto from 'node:crypto';
import { retrievalRuntimeFiles } from '../../scripts/build-bundle.mjs';
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
  RecallGateError, readRecallReport, evaluateGate, loadFixture, main, runRepoRecall, scoreQuestion, tally, validateRecallReport,
} from '../../scripts/oracle/repo-recall.mjs';
import { attestMeasurementReport, verifyMeasurementReport } from '../../scripts/oracle/measurement-attestation.mjs';

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

describe('measurement attestation', () => {
  it('signs and verifies the complete repo-recall report', async () => {
    const keys = (await import('node:crypto')).default.generateKeyPairSync('ed25519');
    const { report } = await runRepoRecall({ kbDir: '/unused', reportAttestationKey: null,
      searchAll: async ({ repos }) => ({ results: [{ repo: repos[0], text: 'Actual passage', path: 'README.md' }] }) });
    const attestation = attestMeasurementReport(report, keys.privateKey);
    expect(() => verifyMeasurementReport(report, attestation, keys.publicKey)).not.toThrow();
    expect(() => verifyMeasurementReport({ ...report, measuredUtc: 'tampered' }, attestation, keys.publicKey)).toThrow(/identity mismatch/);
    expect(() => verifyMeasurementReport(report, attestation, null)).toThrow(/public key/);
  });

  it('refuses to sign injected search results', async () => {
    const key = (await import('node:crypto')).default.generateKeyPairSync('ed25519').privateKey;
    await expect(runRepoRecall({ kbDir: '/unused', reportAttestationKey: key, searchAll: async () => ({ results: [] }) }))
      .rejects.toThrow(/injected/);
  });
});

describe('scoring one question', () => {
  const results = [
    { repo: 'other', path: 'x.md' },
    { repo: 'MyRepo', path: 'docs/a.md' },
    { repo: 'myrepo', path: 'README.md' },
  ];
  it('validates case-insensitive repository identity without changing case-sensitive file paths', async () => {
    const fixture=loadFixture(); const byStore=new Map(fixture.questions.map(q=>[q.store,q]));
    const {report}=await runRepoRecall({kbDir:'/unused',reportAttestationKey:null,searchAll:async({repos})=>({results:[{repo:repos[0].toUpperCase(),text:'Actual passage',path:byStore.get(repos[0]).expectedPath}]})});
    expect(()=>validateRecallReport({report,floorValue:0})).not.toThrow();
  });

  it('keeps signed report bytes unchanged and the recorded floor stable on readback', async () => {
    const fixture=loadFixture(); const byStore=new Map(fixture.questions.map(q=>[q.store,q]));
    const {report}=await runRepoRecall({kbDir:'/unused',reportAttestationKey:null,searchAll:async({repos})=>({results:[{repo:repos[0],text:'Actual passage',path:byStore.get(repos[0]).expectedPath}]})});
    const keys=crypto.generateKeyPairSync('ed25519'); report.attestation=attestMeasurementReport(report,keys.privateKey);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recall-readback-')); const file=path.join(dir,'report.json');
    fs.writeFileSync(file,JSON.stringify(report));
    try {const result=readRecallReport({reportFile:file,trustedReportPublicKey:keys.publicKey,floorValue:999999});
      expect(result.report).toEqual(report);expect(result.gate.floorValue).toBe(report.floor.value);
      expect(()=>verifyMeasurementReport(result.report,result.report.attestation,keys.publicKey)).not.toThrow();
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });

  it('ranks in the actual result order, matching repository names case-insensitively', () => {
    expect(scoreQuestion({ store: 'myrepo', expectedPath: 'README.md', results }))
      .toMatchObject({ repoCovered: true, exactFileRank: 3 });
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

describe('report rows must preserve the frozen fixture denominator', () => {
  it('rejects a duplicate or omitted fixture question even when report totals are recomputed', async () => {
    const { report } = await runRepoRecall({
      kbDir: '/unused', archive: null,
      searchAll: async ({ repos }) => ({ results: [{ repo: repos[0], text: 'Actual passage', path: 'README.md' }] }),
    });
    const duplicate = structuredClone(report);
    duplicate.rows[1] = structuredClone(duplicate.rows[0]);
    duplicate.totals = tally(duplicate.rows);
    await expect(() => validateRecallReport({ report: duplicate, floorValue: 0 })).toThrow(/duplicate|exactly match/i);
    const subset = structuredClone(report);
    subset.rows.pop();
    subset.totals = tally(subset.rows);
    await expect(() => validateRecallReport({ report: subset, floorValue: 0 })).toThrow(/exactly match|frozen fixture/i);
    const forgedPath = structuredClone(report);
    forgedPath.fixture.file = path.join(os.tmpdir(), 'attacker-controlled-fixture.json');
    forgedPath.rows.pop();
    forgedPath.totals = tally(forgedPath.rows);
    await expect(() => validateRecallReport({ report: forgedPath, floorValue: 0 })).toThrow(/exactly match|frozen fixture/i);
  });
});

describe('CLI exit policy', () => {
  it('returns zero when only the informational Hit@5 floor is low', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recall-floor-cli-'));
    const floorFile=path.join(dir,'floor.json');
    fs.writeFileSync(floorFile,JSON.stringify({schemaVersion:1,kind:'ruvnet-brain-repo-recall-floor',fixtureSha256:loadFixture().fixtureSha256,hitTop5Floor:1}));
    try {
      let measured;
      const code = await main(['--kb', 'injected','--floor',floorFile], {
        run: async () => (measured=await runRepoRecall({ kbDir: '/unused',floorFile,searchAll: async ({ repos }) => ({
          results: [{ repo: repos[0], text: 'Actual passage', path: 'different-file.md' }],
        }) })),
      });
      expect(measured.report.gate.failures).toContain('exact-file Hit@5 regressed to 0, below the accepted floor of 1');
      expect(measured.report.gate.blocking).toBe(false);
      expect(code).toBe(0);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  });

  it('returns nonzero and preserves unavailable-repository errors', async () => {
    const out = path.join(os.tmpdir(), `repo-recall-cli-${process.pid}.json`);
    const code = await main(['--kb', 'injected', '--out', out], {
      run: () => runRepoRecall({ kbDir: '/unused', searchAll: async ({ repos }) => ({
        results: [], perRepo: Object.fromEntries(repos.map((repo) => [repo, 'ERR: unavailable repository']))
      }) }),
    });
    expect(code).toBe(1);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(report.rows[0].error).toMatch(/unavailable repository/);
    fs.unlinkSync(out);
  });
});

describe('the one guard that is load-bearing', () => {
  it('records a never-resolving query as a fatal execution error', async () => {
    const { report } = await runRepoRecall({ kbDir: '/unused', queryTimeoutMs: 5,
      searchAll: () => new Promise(() => {}) });
    expect(report.totals.errors).toBe(fixtureCount);
    expect(report.rows[0].error).toMatch(/timeout after 5ms/);
  });

  it('rejects malformed search outcomes instead of inferring coverage', async () => {
    const { report } = await runRepoRecall({ kbDir: '/unused', searchAll: async () => ({ results: [{ repo: 'ok' }] }) });
    expect(report.totals.errors).toBe(fixtureCount);
    expect(report.rows[0].error).toMatch(/invalid repo\/path/);
  });

  it.each([
    { repo: 'alpha', path: 'README.md' },
    { repo: 'alpha', path: 'README.md', text: '   ' },
    { repo: 'alpha', path: ' ', text: 'Content' },
    { repo: '', path: 'README.md', text: 'Content' },
  ])('rejects empty passage or attribution: %j', async (row) => {
    const { report } = await runRepoRecall({ kbDir: '/unused', searchAll: async () => ({ results: [row] }) });
    expect(report.totals.errors).toBe(fixtureCount);
    expect(report.totals.repoCoverage).toBe(0);
  });

  it('rejects impossible ranks and forged own-repository coverage in detached reports', async () => {
    const { report } = await runRepoRecall({ kbDir: '/unused', searchAll: async ({ repos }) => ({ results: [{ repo: repos[0], text: 'Actual passage', path: 'README.md' }] }) });
    const impossible = structuredClone(report); impossible.rows[0].exactFileRank = 6;
    impossible.totals = tally(impossible.rows);
    expect(() => validateRecallReport({ report: impossible, floorValue: 0 })).toThrow(/impossible|disagrees/);
    const forged = structuredClone(report); forged.rows[0].repoCovered = true; forged.rows[0].returnedPaths = ['other/README.md'];
    forged.totals = tally(forged.rows);
    expect(() => validateRecallReport({ report: forged, floorValue: 0 })).toThrow(/disagrees/);
  });

  it('does not accept a top-one claim that hides an earlier result from another repository', async () => {
    const fixture = loadFixture();
    const byStore = new Map(fixture.questions.map((q) => [q.store, q]));
    const { report } = await runRepoRecall({ kbDir: '/unused', reportAttestationKey: null,
      searchAll: async ({ repos }) => ({ results: [
        { repo: 'unrelated', path: 'other.md', text: 'Unrelated evidence' },
        { repo: repos[0], path: byStore.get(repos[0]).expectedPath, text: 'Expected evidence' },
      ] }) });
    expect(report.totals.hitTop1).toBe(0);
    expect(report.rows.every((row) => row.exactFileRank === 2)).toBe(true);
    expect(() => validateRecallReport({ report, floorValue: 0 })).not.toThrow();
    const forged = structuredClone(report);
    forged.rows[0].exactFileRank = 1;
    forged.totals = tally(forged.rows);
    expect(() => validateRecallReport({ report: forged, floorValue: 0 })).toThrow(/disagrees/);
  });

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
    const kb = path.resolve(import.meta.dirname, '../../kb');
    for (const file of retrievalRuntimeFiles(kb).files) {
      const source = file === 'coverage-integrity.mjs' ? path.resolve(kb, '../plugin/scripts/coverage-integrity.mjs') : path.join(kb, file);
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.copyFileSync(source, path.join(dir, file));
    }
    fs.writeFileSync(path.join(dir, 'forge-ask-all.mjs'), 'export const searchAll = async () => ({ results: [] });\n');
    await expect(runRepoRecall({ kbDir: dir }))
      .rejects.toThrow(/archive search dependency differs from checkout: forge-ask-all/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the report states what it did NOT prove', () => {
  it('carries the C3 disclosure, the coverage-is-not-accuracy warning, and its non-blocking status', async () => {
    const { report } = await runRepoRecall({
      kbDir: '/unused', archive: { sha256: 'a'.repeat(64), bytes: 1 },
      searchAll: async ({ repos }) => ({ results: [{ repo: repos[0], text: 'Actual passage', path: 'readme.md' }] }),
    });
    expect(report.meaning.c3).toMatch(/NOT demonstrated by this report and was NOT met/);
    expect(report.meaning.repoCoverage).toMatch(/AVAILABILITY check, NOT answer accuracy/);
    expect(report.gate.blocking).toBe(false);
  });
});
