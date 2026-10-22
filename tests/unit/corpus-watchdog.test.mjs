// tests/unit/corpus-watchdog.test.mjs — the watchdog that pages when the corpus nightly goes QUIET.
//
// THE BUG THIS ENCODES (live run history, 2026-09-28 and 2026-09-29): corpus-nightly-dispatch ran on
// schedule, stood down in ~13s because CORPUS_NIGHTLY was unset, and concluded `success`. A red-only
// alert cannot see that. The rule defended here: a GREEN SCHEDULER IS NOT A REFRESHED CORPUS, and
// ABSENCE OF EVIDENCE IS FAILURE (config/scheduled-jobs.json). Fixture shapes are the real ones —
// run titles, the corpus-release-outcome.json record, and release tags — captured from
// stuinfla/ruvnet-brain with gh 2.101.0.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  judgeCorpusHealth, classifyCorpusRun, deferralSince, failedStage, formatEastern, summarizeNight, RED, WARNING, GREEN,
} from '../../scripts/corpus-watchdog.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NOW = new Date('2026-09-29T17:17:00Z');
const HOUR = 3_600_000;
const ago = (h) => new Date(NOW.getTime() - h * HOUR).toISOString();
const TAG = (n) => `corpus-sha256-${String(n).repeat(64).slice(0, 64)}`;

// A healthy baseline every case perturbs: yesterday published, tonight published, code release verified.
const dispatcher = (id, h, conclusion = 'success') => ({ id, attempt: 1, event: 'schedule', status: 'completed', conclusion, createdAt: ago(h) });
const corpusRun = (id, h, fields) => ({
  id, title: `protected-release corpus corpus-${id - 1}-1`, status: 'completed', conclusion: 'success',
  createdAt: ago(h), updatedAt: ago(h - 3), ...fields,
});
const PUBLISHED = { outcomeRecord: { conclusion: 'success', jobs: { identity: 'success', prepare: 'success', no_change: 'skipped', authorize: 'success', publish: 'success' } } };
const NO_CHANGE = { outcomeRecord: { conclusion: 'success', jobs: { identity: 'success', prepare: 'success', no_change: 'success', authorize: 'skipped', publish: 'skipped' } } };
// The signed aggregate's coverage block: what the code release's three install lanes found (scripts/
// public-verification-aggregate.mjs requires eligibleCurrent === eligibleTotal for the aggregate to verify).
const SHIPS_ALL_CURRENT = { eligibleTotal: 197, eligibleCurrent: 197, coverageGeneration: 'f'.repeat(64) };
const VERIFIED_CODE = { tag: 'v9.8.7', publishedAt: ago(50), aggregate: { state: 'verified', coverage: SHIPS_ALL_CURRENT } };
const OBSERVED_CLEAN = { observable: true, newestTag: TAG(1), degraded: { carried: [], missing: [] }, stores: [] };
const LATEST = { tag: TAG(1), publishedAt: ago(7), generation: ago(8) };
const PROMOTED = { outcomeRecord: { conclusion: 'success', jobs: { identity: 'success', prepare: 'success', no_change: 'skipped', authorize: 'success', publish: 'success', canary: 'success', promote: 'success' } } };
const healthy = (over = {}) => ({
  latestRelease: LATEST,
  corpusReleases: [{ tag: TAG(1), publishedAt: ago(7) }],
  corpusRuns: [corpusRun(101, 10, PUBLISHED)],
  dispatcherRuns: [dispatcher(100, 10)],
  codeRelease: VERIFIED_CODE,
  deferral: OBSERVED_CLEAN,
  ...over,
});
const finding = (result, check) => result.findings.find((f) => f.check === check);

describe('judgeCorpusHealth — the required verdicts', () => {
  it('48h of dispatcher stand-downs (green, ~13s, nothing dispatched) is RED — the live failure mode', () => {
    const result = judgeCorpusHealth(healthy({
      corpusReleases: [{ tag: TAG(1), publishedAt: ago(58) }], // the last real publish, before the stand-downs
      corpusRuns: [],
      dispatcherRuns: [dispatcher(300, 10), dispatcher(200, 34), dispatcher(100, 58)],
    }), NOW);
    expect(result.verdict).toBe(RED);
    expect(finding(result, 'freshness').level).toBe(RED);
    expect(finding(result, 'freshness').detail).toMatch(/2 dispatcher stand-down\(s\)/);
    expect(finding(result, 'tonight').level).toBe(WARNING);
    expect(finding(result, 'tonight').detail).toMatch(/stood down/);
  });

  it('a recent published corpus is GREEN', () => {
    const result = judgeCorpusHealth(healthy(), NOW);
    expect(result.verdict).toBe(GREEN);
    expect(result.lastGoodNight.kind).toBe('published');
  });

  it('a recent no-change night keeps freshness GREEN while the promoted generation is inside 36h', () => {
    const result = judgeCorpusHealth(healthy({
      corpusReleases: [{ tag: TAG(1), publishedAt: ago(30) }],
      latestRelease: { tag: TAG(1), publishedAt: ago(30), generation: ago(31) },
      corpusRuns: [corpusRun(101, 10, NO_CHANGE)],
    }), NOW);
    expect(result.verdict).toBe(GREEN);
    expect(result.lastGoodNight).toMatchObject({ kind: 'no-change', ref: 'run 101' });
  });

  it('48h INVARIANT: the generation customers receive paging at >36h overrides a no-change night', () => {
    const result = judgeCorpusHealth(healthy({
      corpusReleases: [{ tag: TAG(1), publishedAt: ago(200) }],
      latestRelease: { tag: TAG(1), publishedAt: ago(200), generation: ago(201) },
      corpusRuns: [corpusRun(101, 10, NO_CHANGE)],
    }), NOW);
    expect(finding(result, 'freshness').level).toBe(GREEN);
    expect(finding(result, 'promoted-age')).toMatchObject({ level: RED });
    expect(finding(result, 'promoted-age').detail).toMatch(/201\.0h old \(limit 36h/);
    expect(result.verdict).toBe(RED);
  });

  it('promoted-age boundary: 36h exactly is GREEN, one millisecond more is RED; undatable latest is RED', () => {
    const at = (iso) => finding(judgeCorpusHealth(healthy({ latestRelease: { tag: TAG(1), publishedAt: ago(1), generation: iso } }), NOW), 'promoted-age').level;
    expect(at(new Date(NOW.getTime() - 36 * HOUR).toISOString())).toBe(GREEN);
    expect(at(new Date(NOW.getTime() - 36 * HOUR - 1).toISOString())).toBe(RED);
    // No generation stamp (a code release on latest): its publish time dates it.
    expect(finding(judgeCorpusHealth(healthy({ latestRelease: { tag: 'v9.8.7', publishedAt: ago(40), generation: null } }), NOW), 'promoted-age').level).toBe(RED);
    expect(finding(judgeCorpusHealth(healthy({ latestRelease: null }), NOW), 'promoted-age').level).toBe(RED);
  });

  it('CUSTOMER CANARY: a night whose canary refused the candidate is RED tonight AND on the canary check', () => {
    const rejected = corpusRun(201, 5, { conclusion: 'failure', outcomeRecord: { outcome: 'canary-rejected', conclusion: 'failure', jobs: {} } });
    const result = judgeCorpusHealth(healthy({ corpusRuns: [corpusRun(101, 30, PROMOTED), rejected] }), NOW);
    expect(finding(result, 'tonight')).toMatchObject({ level: RED });
    expect(finding(result, 'tonight').detail).toMatch(/customer canary refused/);
    expect(finding(result, 'canary')).toMatchObject({ level: RED });
    expect(result.verdict).toBe(RED);
    // A later promoted night clears it: the LAST canary is what is judged.
    const cleared = judgeCorpusHealth(healthy({ corpusRuns: [corpusRun(301, 30, { conclusion: 'failure', outcomeRecord: { outcome: 'canary-rejected', jobs: {} } }), corpusRun(401, 6, PROMOTED)] }), NOW);
    expect(finding(cleared, 'canary').level).toBe(GREEN);
  });

  it('a failed run tonight is RED even when yesterday published', () => {
    const failed = corpusRun(201, 9, { conclusion: 'failure', outcomeRecord: { conclusion: 'failure', jobs: { ...PUBLISHED.outcomeRecord.jobs, publish: 'failure' } } });
    const result = judgeCorpusHealth(healthy({ corpusRuns: [corpusRun(101, 30, PUBLISHED), failed] }), NOW);
    expect(result.verdict).toBe(RED);
    expect(finding(result, 'tonight')).toMatchObject({ level: RED });
    expect(finding(result, 'freshness').level).toBe(GREEN);
  });

  it('a superseded night is a WARNING, not RED', () => {
    const superseded = corpusRun(201, 9, { conclusion: 'failure', outcomeRecord: { outcome: 'superseded', conclusion: 'failure', jobs: {} } });
    const result = judgeCorpusHealth(healthy({ corpusRuns: [corpusRun(101, 30, PUBLISHED), superseded] }), NOW);
    expect(result.verdict).toBe(WARNING);
    expect(finding(result, 'tonight')).toMatchObject({ level: WARNING });
  });

  it('the 48h boundary is inclusive: exactly 48h still counts, one millisecond more does not', () => {
    const at48 = new Date(NOW.getTime() - 48 * HOUR).toISOString();
    const past48 = new Date(NOW.getTime() - 48 * HOUR - 1).toISOString();
    const base = { corpusRuns: [], dispatcherRuns: [dispatcher(100, 10)] };
    expect(finding(judgeCorpusHealth(healthy({ ...base, corpusReleases: [{ tag: TAG(1), publishedAt: at48 }] }), NOW), 'freshness').level).toBe(GREEN);
    expect(finding(judgeCorpusHealth(healthy({ ...base, corpusReleases: [{ tag: TAG(1), publishedAt: past48 }] }), NOW), 'freshness').level).toBe(RED);
  });

  it('empty history is RED — absence of evidence is failure, never "probably fine"', () => {
    const result = judgeCorpusHealth({}, NOW);
    expect(result.verdict).toBe(RED);
    expect(finding(result, 'freshness').detail).toMatch(/never observed/);
    expect(finding(result, 'code-aggregate').level).toBe(RED);
  });

  it('a failed dispatcher with no corpus run tonight is RED', () => {
    const result = judgeCorpusHealth(healthy({ corpusRuns: [corpusRun(101, 30, PUBLISHED)], dispatcherRuns: [dispatcher(400, 10, 'failure')] }), NOW);
    expect(finding(result, 'tonight').level).toBe(RED);
  });
});

describe('judgeCorpusHealth — code-release aggregate and deferral', () => {
  it('no aggregate 24h after publish is RED; inside the grace window it is not', () => {
    const late = judgeCorpusHealth(healthy({ codeRelease: { tag: 'v9.8.7', publishedAt: ago(24), aggregate: { state: 'missing' } } }), NOW);
    const early = judgeCorpusHealth(healthy({ codeRelease: { tag: 'v9.8.7', publishedAt: ago(23), aggregate: { state: 'missing' } } }), NOW);
    expect(finding(late, 'code-aggregate').level).toBe(RED);
    expect(early.verdict).toBe(GREEN);
  });

  it('an aggregate that does not verify is RED at once, with no grace', () => {
    const result = judgeCorpusHealth(healthy({ codeRelease: { tag: 'v9.8.7', publishedAt: ago(1), aggregate: { state: 'invalid', reason: 'digest mismatch' } } }), NOW);
    expect(finding(result, 'code-aggregate')).toMatchObject({ level: RED });
    expect(finding(result, 'code-aggregate').detail).toMatch(/digest mismatch/);
  });

  it('a store deferred more than 7 days is RED; 7 days exactly is not; a degraded generation warns', () => {
    const deferral = (h) => ({ observable: true, newestTag: TAG(1), degraded: { carried: ['ruflo'], missing: [] }, stores: [{ store: 'ruflo', since: ago(h), lowerBound: false }] });
    const over = judgeCorpusHealth(healthy({ deferral: deferral(7 * 24 + 1) }), NOW);
    const at = judgeCorpusHealth(healthy({ deferral: deferral(7 * 24) }), NOW);
    expect(finding(over, 'deferral').level).toBe(RED);
    expect(finding(over, 'deferral').detail).toMatch(/ruflo/);
    expect(finding(at, 'deferral').level).toBe(GREEN);
    expect(at.verdict).toBe(WARNING); // degraded, not red
  });

  // 2026-10-17 (reviewer finding): the 7-day rule used to read only PROMOTED corpus releases; a code release
  // ships a corpus too, and fresh installs receive it. The signed aggregate carries its eligible/CURRENT counts.
  it('the corpus the newest CODE release ships is judged too: all CURRENT is GREEN and says so', () => {
    const result = judgeCorpusHealth(healthy(), NOW);
    expect(finding(result, 'code-corpus')).toMatchObject({ level: GREEN, detail: 'v9.8.7 ships 197/197 eligible stores CURRENT' });
    expect(result.verdict).toBe(GREEN);
  });
  it('a code release can only ever ship an all-CURRENT corpus: the aggregate verifier refuses anything else (so no watchdog branch pretends otherwise)', () => {
    // The guard lives in scripts/public-verification-aggregate.mjs, not here: a leaf or aggregate whose
    // coverage.eligibleCurrent !== eligibleTotal does not verify, so aggregateState() reports `invalid`
    // (RED code-aggregate) and never hands judgeCorpusHealth a verified code release with a carried store.
    const source = fs.readFileSync(path.join(ROOT, 'scripts/public-verification-aggregate.mjs'), 'utf8');
    expect(source.match(/coverage\.eligibleCurrent !== (leaf|aggregate)\.coverage\.eligibleTotal/g)).toHaveLength(2);
    const watchdog = fs.readFileSync(path.join(ROOT, 'scripts/corpus-watchdog.mjs'), 'utf8');
    expect(watchdog).not.toMatch(/not CURRENT \(/);
    const invalid = judgeCorpusHealth(healthy({ codeRelease: { tag: 'v9.8.7', publishedAt: ago(50),
      aggregate: { state: 'invalid', reason: 'linux/claude coverage is incomplete' } } }), NOW);
    expect(finding(invalid, 'code-aggregate')).toMatchObject({ level: RED });
    expect(finding(invalid, 'code-corpus')).toBeUndefined();
    expect(invalid.verdict).toBe(RED);
  });
  it('MUTATION KILLER: an aggregate with no store counts is never read as "all current" -- it is a WARNING, not GREEN', () => {
    const blind = judgeCorpusHealth(healthy({ codeRelease: { tag: 'v9.8.7', publishedAt: ago(50), aggregate: { state: 'verified' } } }), NOW);
    expect(finding(blind, 'code-corpus')).toMatchObject({ level: WARNING, detail: expect.stringMatching(/records no eligible\/CURRENT store counts/) });
    expect(blind.verdict).toBe(WARNING);
  });
  it('a degraded promoted generation names its carried and missing stores in the WARNING', () => {
    const deferral = { observable: true, newestTag: TAG(1), degraded: { carried: ['ruflo'], missing: ['newrepo'] },
      stores: [{ store: 'ruflo', since: ago(2), lowerBound: false }, { store: 'newrepo', since: ago(2), lowerBound: false }] };
    const result = judgeCorpusHealth(healthy({ deferral }), NOW);
    expect(finding(result, 'degraded')).toMatchObject({ level: WARNING, detail: `${TAG(1)} is degraded: 1 carried (ruflo), 1 missing (newrepo)` });
  });

  it('unobservable deferral (pre-D6.2 generation) is reported, never guessed and never RED', () => {
    const result = judgeCorpusHealth(healthy({ deferral: { observable: false, reason: `${TAG(1)} predates the D6.2 coverage sidecar` } }), NOW);
    expect(result.verdict).toBe(GREEN);
    expect(finding(result, 'deferral').detail).toMatch(/not observable: .*predates/);
  });
});

describe('classifyCorpusRun — reads the pipeline\'s own outcome record', () => {
  it('the real 2026-09-29 record (publisher failed after promotion) is failed', () => {
    const record = { conclusion: 'failure', jobs: { identity: 'success', prepare: 'success', no_change: 'skipped', authorize: 'success', publish: 'failure' } };
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'failure', outcomeRecord: record })).toBe('failed');
  });
  it('no_change success is no-change; publish success is published; neither is unknown', () => {
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', ...NO_CHANGE })).toBe('no-change');
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', ...PUBLISHED })).toBe('published');
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', jobs: [{ name: 'protected-corpus-publisher', conclusion: 'skipped' }] })).toBe('unknown');
  });
  it('since the canary, published means PROMOTED: a staged-only night is not a published night', () => {
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', ...PROMOTED })).toBe('published');
    const stagedOnly = { outcomeRecord: { conclusion: 'success', jobs: { ...PROMOTED.outcomeRecord.jobs, promote: 'skipped' } } };
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', ...stagedOnly })).toBe('unknown');
    const canaryFailed = { outcomeRecord: { conclusion: 'failure', jobs: { ...PROMOTED.outcomeRecord.jobs, canary: 'failure', promote: 'skipped' } } };
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'failure', ...canaryFailed })).toBe('canary-rejected');
    // Job-list fallback: the publisher (stage) succeeding while the canary failed is canary-rejected, never published.
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'failure', jobs: [
      { name: 'protected-corpus-publisher', conclusion: 'success' }, { name: 'customer-canary', conclusion: 'failure' },
      { name: 'promote-canaried-corpus', conclusion: 'skipped' }] })).toBe('canary-rejected');
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', jobs: [
      { name: 'protected-corpus-publisher', conclusion: 'success' }, { name: 'customer-canary', conclusion: 'success' },
      { name: 'promote-canaried-corpus', conclusion: 'skipped' }] })).toBe('unknown');
  });
  it('falls back to the run\'s job list when no outcome record exists', () => {
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'success', jobs: [{ name: 'corpus-no-change-round', conclusion: 'success' }] })).toBe('no-change');
  });
  it('an explicit declared outcome wins; cancelled and running are not good nights', () => {
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'failure', outcomeRecord: { outcome: 'superseded' } })).toBe('superseded');
    expect(classifyCorpusRun({ status: 'completed', conclusion: 'cancelled' })).toBe('failed');
    expect(classifyCorpusRun({ status: 'in_progress', conclusion: null })).toBe('in-progress');
  });
});

// THE DAILY VERDICT (2026-10-20): one line, result first, Eastern time, written before any page can fire.
describe('summarizeNight — what the night did, in one line the owner reads first', () => {
  const FAILED_PREPARE = { conclusion: 'failure', outcomeRecord: { outcome: 'failed', conclusion: 'failure',
    jobs: { identity: 'success', prepare: 'failure', no_change: 'skipped', authorize: 'skipped', publish: 'skipped', canary: 'skipped', promote: 'skipped' } } };
  it('formats Eastern 12-hour times with the zone, never UTC: 17:17Z on 2026-09-29 is 1:17 p.m. ET', () => {
    expect(formatEastern(NOW)).toBe('1:17 p.m. ET Sep 29');
    expect(formatEastern('2026-10-20T11:17:00Z')).toBe('7:17 a.m. ET Oct 20');
    expect(formatEastern('2026-12-20T12:17:00Z'), 'EST in winter').toBe('7:17 a.m. ET Dec 20');
    expect(formatEastern('garbage')).toBe('an unknown time');
  });
  it('published: names the promoted generation and the time it landed', () => {
    const night = summarizeNight(healthy({ corpusRuns: [corpusRun(101, 10, PROMOTED)] }), NOW);
    expect(night).toEqual({ outcome: 'published', line: `night: published ${TAG(1)} at ${formatEastern(ago(7))} (1 attempt)` });
  });
  it('degraded: a published night whose generation carries stores names each of them', () => {
    const deferral = { observable: true, newestTag: TAG(1), degraded: { carried: ['cognitum-ruos'], missing: [] }, stores: [] };
    const night = summarizeNight(healthy({ corpusRuns: [corpusRun(101, 10, PROMOTED)], deferral }), NOW);
    expect(night.outcome).toBe('degraded');
    expect(night.line).toBe(`night: degraded -- published ${TAG(1)} at ${formatEastern(ago(7))} (1 attempt) with 1 carried (cognitum-ruos) and 0 missing (none), each named in CORPUS-COVERAGE.json`);
  });
  it('no-change, superseded and canary-rejected are each their own word, with what customers keep', () => {
    expect(summarizeNight(healthy({ corpusRuns: [corpusRun(101, 10, NO_CHANGE)] }), NOW).line)
      .toBe(`night: no-change at ${formatEastern(ago(7))} (1 attempt) -- every knowledge input equals the promoted generation; customers keep ${TAG(1)} (8.0h old)`);
    expect(summarizeNight(healthy({ corpusRuns: [corpusRun(101, 10, { conclusion: 'failure', outcomeRecord: { outcome: 'superseded' } })] }), NOW).outcome).toBe('superseded');
    const rejected = summarizeNight(healthy({ corpusRuns: [corpusRun(101, 10, { conclusion: 'failure', outcomeRecord: { outcome: 'canary-rejected', jobs: {} } })] }), NOW);
    expect(rejected.line).toMatch(/^night: canary-rejected at .* \(GLOBAL: not retried\); customers keep/);
  });
  it('failed: names the STAGE, counts the retry, and says what customers keep', () => {
    const first = corpusRun(101, 10, FAILED_PREPARE);
    const retry = corpusRun(201, 6, FAILED_PREPARE);
    const night = summarizeNight(healthy({ corpusRuns: [first, retry] }), NOW);
    expect(night.outcome).toBe('failed');
    expect(night.line).toBe(`night: failed in prepare/seal (seal-exact-corpus-candidate) at ${formatEastern(ago(3))} (attempt 2 of the night; 1 retried); customers keep ${TAG(1)} (8.0h old)`);
    expect(failedStage({ jobs: [{ name: 'protected-corpus-publisher', conclusion: 'failure' }] })).toBe('publisher (corpus-publish)');
    expect(failedStage({ conclusion: 'cancelled' })).toMatch(/unnamed job \(conclusion cancelled\)/);
  });
  it('in progress, stood down, and no run at all are said plainly, never as a success', () => {
    expect(summarizeNight(healthy({ corpusRuns: [corpusRun(101, 2, { status: 'in_progress', conclusion: null })] }), NOW).line).toMatch(/^night: run 101 still in progress, started/);
    expect(summarizeNight(healthy({ corpusRuns: [], dispatcherRuns: [dispatcher(100, 10)] }), NOW).outcome).toBe('stood-down');
    expect(summarizeNight(healthy({ corpusRuns: [], dispatcherRuns: [dispatcher(100, 10, 'failure')] }), NOW).outcome).toBe('dispatcher-failed');
    expect(summarizeNight(healthy({ corpusRuns: [], dispatcherRuns: [] }), NOW).outcome).toBe('no-run');
    // Yesterday's run is not tonight's.
    expect(summarizeNight(healthy({ corpusRuns: [corpusRun(101, 30, PROMOTED)], dispatcherRuns: [] }), NOW).outcome).toBe('no-run');
  });
});

describe('nightAttempts — one scheduled night is ONE attempt whatever else was dispatched in the last 24h', () => {
  // The three dispatches of 2026-10-21/22, verbatim: a manual proving run, a retry slot that stood down, the real night.
  const JUDGED = new Date('2026-10-22T09:00:00Z');
  const run = (id, dispatchId, createdAt, updatedAt, fields = PROMOTED) => ({ id, title: `protected-release corpus corpus-${dispatchId}-1`,
    status: 'completed', conclusion: 'success', createdAt, updatedAt, ...fields });
  const d = (id, event, createdAt) => ({ id, attempt: 1, event, status: 'completed', conclusion: 'success', createdAt });
  const manualProof = d(1001, 'workflow_dispatch', '2026-10-21T10:36:45Z');
  const retrySlotStoodDown = d(1002, 'schedule', '2026-10-21T11:25:56Z'); // created NO protected-release run
  const realNight = d(1003, 'schedule', '2026-10-22T07:36:00Z');
  const night = (over, at = JUDGED) => summarizeNight({ ...healthy(), latestRelease: { tag: TAG(2), publishedAt: '2026-10-22T08:51:00Z', generation: '2026-10-22T08:51:00Z' },
    dispatcherRuns: [realNight, retrySlotStoodDown, manualProof], ...over }, at);
  it('2026-10-22: published at 4:51 a.m. ET Oct 22 (1 attempt) — the manual proving run and the stood-down slot are not retries', () => {
    const result = night({ corpusRuns: [run(5003, 1003, '2026-10-22T07:36:30Z', '2026-10-22T08:51:00Z'), run(5001, 1001, '2026-10-21T10:37:00Z', '2026-10-21T11:10:00Z')] });
    expect(result.line).toBe(`night: published ${TAG(2)} at 4:51 a.m. ET Oct 22 (1 attempt)`);
  });
  it('a failed scheduled run that the retry slot re-dispatched IS attempt 2 of the night', () => {
    const retrySlot = d(1004, 'schedule', '2026-10-22T11:17:00Z');
    const failed = { conclusion: 'failure', outcomeRecord: { outcome: 'failed', conclusion: 'failure', jobs: { identity: 'success', prepare: 'failure' } } };
    const result = night({ dispatcherRuns: [retrySlot, realNight, retrySlotStoodDown, manualProof], latestRelease: { tag: TAG(2), publishedAt: '2026-10-22T12:20:00Z', generation: '2026-10-22T12:20:00Z' },
      corpusRuns: [run(5004, 1004, '2026-10-22T11:17:30Z', '2026-10-22T12:20:00Z'), run(5003, 1003, '2026-10-22T07:36:30Z', '2026-10-22T08:10:00Z', failed), run(5001, 1001, '2026-10-21T10:37:00Z', '2026-10-21T11:10:00Z')] }, new Date('2026-10-22T13:00:00Z'));
    expect(result.line).toBe(`night: published ${TAG(2)} at 8:20 a.m. ET Oct 22 (attempt 2 of the night; 1 retried)`);
  });
  it('a manual proving run BETWEEN the failed scheduled run and its re-dispatched retry is not an attempt of the night', () => {
    const proofBetween = d(1006, 'workflow_dispatch', '2026-10-22T09:00:00Z');
    const retrySlot = d(1004, 'schedule', '2026-10-22T11:17:00Z');
    const failed = { conclusion: 'failure', outcomeRecord: { outcome: 'failed', conclusion: 'failure', jobs: { identity: 'success', prepare: 'failure' } } };
    const result = night({ dispatcherRuns: [retrySlot, proofBetween, realNight, retrySlotStoodDown, manualProof], latestRelease: { tag: TAG(2), publishedAt: '2026-10-22T12:20:00Z', generation: '2026-10-22T12:20:00Z' },
      corpusRuns: [run(5004, 1004, '2026-10-22T11:17:30Z', '2026-10-22T12:20:00Z'), run(5006, 1006, '2026-10-22T09:00:30Z', '2026-10-22T09:40:00Z'),
        run(5003, 1003, '2026-10-22T07:36:30Z', '2026-10-22T08:10:00Z', failed)] }, new Date('2026-10-22T13:00:00Z'));
    expect(result.line).toMatch(/\(attempt 2 of the night; 1 retried\)$/); // not 3
  });
  it("LAST night's re-dispatched retry slot, still inside the 24h window, is not one of tonight's attempts", () => {
    const lastNightRetry = d(1007, 'schedule', '2026-10-21T11:17:00Z'); // yesterday's 07:36Z run failed; this slot re-ran it
    const result = night({ dispatcherRuns: [realNight, lastNightRetry, manualProof],
      corpusRuns: [run(5003, 1003, '2026-10-22T07:36:30Z', '2026-10-22T08:51:00Z'), run(5007, 1007, '2026-10-21T11:17:30Z', '2026-10-21T12:30:00Z')] });
    expect(result.line).toBe(`night: published ${TAG(2)} at 4:51 a.m. ET Oct 22 (1 attempt)`);
  });
  it('a manual dispatch that is the newest run is its own single attempt, said so', () => {
    const laterProof = d(1005, 'workflow_dispatch', '2026-10-22T08:55:00Z');
    const result = night({ dispatcherRuns: [laterProof, realNight, retrySlotStoodDown, manualProof],
      corpusRuns: [run(5005, 1005, '2026-10-22T08:55:30Z', '2026-10-22T08:58:00Z'), run(5003, 1003, '2026-10-22T07:36:30Z', '2026-10-22T08:51:00Z')] });
    expect(result.line).toMatch(/\(1 attempt; manual dispatch\)$/);
  });
});

describe('deferralSince — deferred since the first generation of the unbroken run', () => {
  const gen = (h, carried, missing = []) => ({ tag: TAG(h % 10), publishedAt: ago(h), degraded: carried === null ? null : { carried, missing } });
  it('walks back while the store stays carried or missing, and stops at the first clean generation', () => {
    expect(deferralSince([gen(1, ['a']), gen(25, [], ['a']), gen(49, ['a']), gen(73, [])]))
      .toEqual([{ store: 'a', since: ago(49), lowerBound: false }]);
  });
  it('a generation with unknown coverage, or running out of history, makes the answer a lower bound', () => {
    expect(deferralSince([gen(1, ['a']), gen(25, null)])).toEqual([{ store: 'a', since: ago(1), lowerBound: true }]);
    expect(deferralSince([gen(1, ['a']), gen(25, ['a'])])).toEqual([{ store: 'a', since: ago(25), lowerBound: true }]);
  });
  it('a clean or unknown newest generation defers nothing', () => {
    expect(deferralSince([gen(1, [])])).toEqual([]);
    expect(deferralSince([gen(1, null)])).toEqual([]);
  });
});

// gh 2.101.0 `--help` JSON FIELDS, captured 2026-09-29. `isLatest` exists ONLY on `release list` —
// the redesign that created this watchdog exists because release.mjs asked `release view` for it.
const GH_FIELDS = {
  'run list': 'attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName',
  'run view': 'attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,jobs,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName',
  'release list': 'createdAt,isDraft,isImmutable,isLatest,isPrerelease,name,publishedAt,tagName',
  'release view': 'apiUrl,assets,author,body,createdAt,databaseId,id,isDraft,isImmutable,isPrerelease,name,publishedAt,tagName,tarballUrl,targetCommitish,uploadUrl,url,zipballUrl',
};

describe('the CLI end to end, through a fake gh that refuses fields real gh refuses', () => {
  function runCli(fixture) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-watchdog-test-'));
    const fake = path.join(dir, 'gh.cjs');
    fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify({ fixture, fields: GH_FIELDS }));
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const { fixture, fields } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const args = process.argv.slice(2); const cmd = args.slice(0, 2).join(' ');
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const json = opt('--json');
if (json) for (const f of json.split(',')) if (!fields[cmd].split(',').includes(f)) { process.stderr.write('Unknown JSON field: "' + f + '"'); process.exit(1); }
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (cmd === 'run list') out(fixture.runs[opt('--workflow')] || []);
if (cmd === 'release list') out(fixture.releases);
if (cmd === 'release view') out({ assets: (fixture.assets[args[2]] || []).map((name) => ({ name })) });
if (cmd === 'run view') out({ jobs: fixture.jobs[args[2]] || [] });
if (args[0] === 'api' && args[1] === 'repos/stuinfla/ruvnet-brain/releases/latest' && fixture.latest) out(fixture.latest);
process.stderr.write('not in fixture: ' + args.join(' ')); process.exit(1);
`);
    fs.chmodSync(fake, 0o755);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/corpus-watchdog.mjs'), '--repo', 'stuinfla/ruvnet-brain', '--now', NOW.toISOString()],
      { encoding: 'utf8', env: { ...process.env, RUVNET_GH_COMMAND: fake } });
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }
  const standDown = (id, h) => ({ databaseId: id, attempt: 1, event: 'schedule', status: 'completed', conclusion: 'success', createdAt: ago(h), updatedAt: ago(h) });
  const releases = [
    { tagName: TAG(1), publishedAt: ago(58), isDraft: false, isPrerelease: false },
    // A staged candidate the canary refused: a prerelease is never evidence of a published night.
    { tagName: TAG(2), publishedAt: ago(9), isDraft: false, isPrerelease: true },
    { tagName: 'v9.8.7', publishedAt: ago(2), isDraft: false, isPrerelease: false },
    { tagName: 'v9.8.6', publishedAt: ago(90), isDraft: false, isPrerelease: false },
  ];

  it('two nights of green stand-downs exit 1 with RED — the page ntfy-alerts sends', () => {
    const result = runCli({
      runs: { 'corpus-nightly-dispatch.yml': [standDown(300, 10), standDown(200, 34)], 'protected-release.yml': [] },
      releases, assets: {}, jobs: {}, latest: { tag_name: TAG(1), published_at: ago(58), body: `Corpus generation: ${ago(59)}` },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/\[RED\] promoted-age: customers receive corpus-sha256-1+, 59\.0h old/);
    expect(result.stdout).toMatch(/^corpus-watchdog RED -- night: stood down at 3:17 a\.m\. ET Sep 29 \(CORPUS_NIGHTLY off, or no install-verified runtime\); customers keep corpus-sha256-1+ \(59\.0h old\)\n {2}judged 1:17 p\.m\. ET Sep 29 \(2026-09-29T17:17:00\.000Z\)\n/); // sync-version-ignore: NOW is this file's fixture clock, rendered in ET and ISO
    expect(result.stdout).toMatch(/\[RED\] freshness: no night ended published or no-change in the last 48h/);
    expect(result.stdout).toMatch(/\[INFO\] code-aggregate: v9\.8\.7 is 2\.0h old; aggregate pending/);
    expect(result.stdout).toMatch(/\[INFO\] deferral: not observable: .*predates the D6\.2 coverage sidecar/);
  });

  it('a no-change night observed only through the run job list exits 0', () => {
    const result = runCli({
      runs: {
        'corpus-nightly-dispatch.yml': [standDown(300, 10)],
        'protected-release.yml': [{ databaseId: 301, attempt: 1, displayTitle: 'protected-release corpus corpus-300-1', status: 'completed', conclusion: 'success', createdAt: ago(10), updatedAt: ago(8) },
          { databaseId: 299, attempt: 1, displayTitle: 'protected-release code 9.8.7', status: 'completed', conclusion: 'failure', createdAt: ago(3), updatedAt: ago(2) }],
      },
      releases, assets: {}, jobs: { 301: [{ name: 'corpus-no-change-round', conclusion: 'success' }] },
      latest: { tag_name: TAG(1), published_at: ago(30), body: `Corpus generation: ${ago(31)}` },
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^corpus-watchdog GREEN -- night: no-change at 5:17 a\.m\. ET Sep 29/);
    expect(result.status).toBe(0);
  });

  it('gh failing to answer is RED, not silence', () => {
    const result = runCli({ runs: {}, releases: null, assets: {}, jobs: {} });
    expect(result.status).toBe(1);
  });
});

describe('the workflow and its pager', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/corpus-watchdog.yml'), 'utf8');
  const code = workflow.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  it('runs 17:17 UTC, again at 12:17 UTC for the same-morning page, and on demand, read-only, with no secrets, never on forks', () => {
    expect(code).toMatch(/schedule:\s*\n\s*- cron: '17 17 \* \* \*'/);
    expect(code).toMatch(/- cron: '17 12 \* \* \*'/);
    expect(code).toMatch(/workflow_dispatch:/);
    expect(code).toMatch(/^permissions:\n {2}contents: read\n {2}actions: read\n/m);
    expect(code).not.toMatch(/secrets\.|write|id-token|environment:/);
    expect(code).toMatch(/if: github\.repository == 'stuinfla\/ruvnet-brain'/);
    expect(code).toMatch(/node scripts\/corpus-watchdog\.mjs/);
    expect(code).toMatch(/exit "\$status"/);
  });
  it('is on ntfy-alerts\' watch list by its exact name, so a red watchdog pages the phone', () => {
    const alerts = fs.readFileSync(path.join(ROOT, '.github/workflows/ntfy-alerts.yml'), 'utf8');
    const list = alerts.match(/workflows:\s*\[([\s\S]*?)\]/)[1];
    expect(list).toMatch(/"corpus-watchdog"/);
    expect(workflow).toMatch(/^name: corpus-watchdog$/m);
  });
  it('asks gh only for JSON fields gh 2.101.0 actually has on that subcommand', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/corpus-watchdog.mjs'), 'utf8');
    const uses = [...source.matchAll(/\['(run|release)', '(list|view)'[^\]]*?'--json', '([^']+)'/g)];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const [, noun, verb, list] of uses) {
      for (const field of list.split(',')) expect(GH_FIELDS[`${noun} ${verb}`].split(','), `${noun} ${verb} --json ${field}`).toContain(field);
    }
  });
});
