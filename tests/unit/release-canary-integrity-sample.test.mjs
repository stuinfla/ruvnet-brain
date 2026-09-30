// The release canary is an INTEGRITY check of the shipped, installed bundle against the generation's own
// repo-recall measurement — not a second judgement of whole-corpus retrieval quality.
//
// Measured 2026-09-30 on the same 19 sampled questions: the previous corpus retrieved 18, the fresh one 17
// (both fail an absolute 98% bar; that is a property of a ~90%-recall corpus over a 19-store sample, not of
// the release). With a measurement in hand the sample is drawn from the stores that measurement retrieved,
// so a packaging / index / model / runtime break shows up as a miss on a store that hit. The stores it
// missed are named, never hidden, and quality stays visible in the recall report.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { RECALL_KIND, loadFixture, tally } from '../../scripts/oracle/repo-recall.mjs';
import { measuredHitStores } from '../../scripts/public-verification-inputs.mjs';
import { STORES, chunkRow, contentMapFor, ordinalRow, plan } from '../helpers/canary-plan-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const chunked = (_dir, store) => [chunkRow(store)];

describe('the legacy sample is drawn from the stores the generation measured as hits', () => {
  const hits = new Set(['old-a', 'old-b', 'old-d']);
  it('samples only measured hits and names the stores it did not sample (fails on the pre-fix code)', () => {
    const { built, notices } = plan(chunked, { contentMap: contentMapFor(STORES), knownHitStores: hits });
    expect(built.denominator.legacySelectedStores).toEqual(['old-a', 'old-b', 'old-d']);
    expect(built.denominator.legacyPopulationStores).toEqual([...STORES].sort()); // population stays coverage-derived
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/1 of 4 fixture store\(s\) not sampled.*old-c/);
  });
  it('without a measurement nothing is filtered: the historical behaviour is unchanged', () => {
    const { built, notices } = plan(chunked, { contentMap: contentMapFor(STORES), knownHitStores: null });
    expect(built.denominator.legacySelectedStores).toEqual([...STORES].sort());
    expect(notices).toEqual([]);
  });
  it('a stale sealed passage is reported as stale, not double-counted as a generation miss', () => {
    const readPassages = (_dir, store) => (store === 'old-c' ? [{ ...chunkRow('old-c'), text: 'rewritten upstream' }] : [chunkRow(store)]);
    const { notices } = plan(readPassages, { contentMap: contentMapFor(STORES), knownHitStores: hits });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/excluded from the legacy sample.*old-c/);
  });
});

describe('measuredHitStores binds the recall report to the exact archive and frozen fixture', () => {
  const workDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'canary-recall-'));
  const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  function scenario({ archiveOverride = {}, fixtureShaOverride = null } = {}) {
    const dir = workDir();
    const archive = path.join(dir, 'ruvnet-brain.zip');
    fs.writeFileSync(archive, 'archive bytes');
    const oracle = path.join(dir, 'fixture.json');
    fs.writeFileSync(oracle, JSON.stringify({ schemaVersion: 2, kind: 'ruvnet-brain-retrieval-query-evidence',
      queries: Object.fromEntries(STORES.map((store) => [store, { query: `independently authored question about ${store}`,
        expected: { path: ordinalRow(store).path, passageSha256: '0'.repeat(64) } }])) }));
    const ranks = { 'old-a': 1, 'old-b': 5, 'old-c': null, 'old-d': 3 };
    const rows = STORES.map((store) => ({ store, expectedPath: ordinalRow(store).path, repoCovered: true,
      exactFileRank: ranks[store], returnedPaths: [] }));
    const report = { schemaVersion: 1, kind: RECALL_KIND, state: 'PASS',
      archive: { sha256: sha(archive), bytes: fs.statSync(archive).size, ...archiveOverride },
      fixture: { sha256: fixtureShaOverride ?? loadFixture(oracle).fixtureSha256, questionCount: STORES.length },
      rows, totals: tally(rows) };
    const recallFile = path.join(dir, 'ruvnet-brain.zip.recall.json');
    fs.writeFileSync(recallFile, JSON.stringify(report));
    return { recallFile, baselineArchive: archive, oracleFile: oracle };
  }
  it('returns exactly the stores whose sealed file ranked within top-k', () => {
    expect([...measuredHitStores(scenario())].sort()).toEqual(['old-a', 'old-b', 'old-d']);
  });
  it('refuses a report that describes a different archive', () => {
    expect(() => measuredHitStores(scenario({ archiveOverride: { sha256: 'f'.repeat(64) } }))).toThrow(/does not describe this archive/);
  });
  it('refuses a report measured against a different frozen fixture', () => {
    expect(() => measuredHitStores(scenario({ fixtureShaOverride: 'e'.repeat(64) }))).toThrow(/different frozen fixture/);
  });
});

describe('release-qe hands the generation’s measurement to the canary only when a generation seeds the release', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  it('downloads the seed’s recall report and exports its path inside the published-generation branch only', () => {
    const branch = ci.slice(ci.indexOf('if [ "$SEED_ORIGIN" = published-generation ]; then'));
    const inside = branch.slice(0, branch.indexOf('\n          fi\n'));
    expect(inside).toContain('--pattern "$SEED_ASSET.recall.json"');
    expect(inside).toContain('test -s "$RUNNER_TEMP/release-seed/$SEED_ASSET.recall.json"');
    expect(inside).toContain('RUVNET_SEED_RECALL=');
    expect(ci.match(/RUVNET_SEED_RECALL=/g)).toHaveLength(1);
  });
  it('passes it to public-verification-inputs as --baseline-recall when present', () => {
    expect(ci).toContain('recall_args=(--baseline-recall "$RUVNET_SEED_RECALL")');
    expect(ci).toMatch(/--observed-baseline "\$\{recall_args\[@\]\}"/);
  });
});
