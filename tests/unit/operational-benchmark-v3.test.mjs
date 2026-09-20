import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OPERATIONAL_FIXTURES } from '../../evals/operational-benchmark.v2.mjs';
import {
  OPERATIONAL_FIXTURES_V3,
  gradeOperationalFixtureV3,
  matchClaimSlots,
  preflightOperationalOracle,
} from '../../evals/operational-benchmark.v3.mjs';
import { runOperationalBenchmarkV3 } from '../../scripts/run-operational-benchmark.v3.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const tempDirs = [];
function corpus(records = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-v3-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'ARCHIVE-MANIFEST.json'), '{"kind":"archive"}\n');
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), '{"kind":"source"}\n');
  for (const [repo, rows] of Object.entries(records)) {
    fs.writeFileSync(path.join(dir, `${repo}.passages.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  }
  return dir;
}
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const QUERY = { id: 'answerable', class: 'broad', query: 'Find the persisted local index.' };
const GAP_QUERY = { id: 'gap', class: 'broad', query: 'Transfer across projects.' };
const NEGATIVE = { id: 'negative', class: 'negative', query: 'Does this imaginary feature exist?' };
const FACT_A = 'RVF is persisted in a portable file.';
const FACT_B = 'Search uses an on-device vector index.';
function makeCatalog(kb, fixtures = [QUERY, GAP_QUERY, NEGATIVE]) {
  return {
    schema: 'operational-source-oracles/v3',
    corpus: { archiveManifestSha256: hash(fs.readFileSync(path.join(kb, 'ARCHIVE-MANIFEST.json'))),
      sourceManifestSha256: hash(fs.readFileSync(path.join(kb, 'SOURCE.json'))),
      archiveSha256: 'descriptive-only-not-verified-by-this-runner' },
    fixtures: fixtures.map((fixture) => fixture.id === 'answerable' ? {
      id: fixture.id,
      claimSlots: [
        { id: 'portable', alternatives: [{ repo: 'rvfguide', path: 'README.md', passageSha256: hash(FACT_A), spans: ['portable file'] }] },
        { id: 'search', alternatives: [
          { repo: 'rvfguide', path: 'alt.md', passageSha256: hash('Search uses an on-device vector index.'), spans: ['on-device vector index'] },
          { repo: 'vector-index', path: 'INDEX.md', passageSha256: hash(FACT_B), spans: ['on-device vector index'] },
        ] },
      ],
    } : fixture.id === 'gap' ? { id: fixture.id, claimSlots: [], unavailableReason: 'Pinned corpus does not establish automatic transfer.' }
      : { id: fixture.id, claimSlots: [] }),
  };
}

describe('operational benchmark v3 frozen facts and preflight', () => {
  it('preserves all 19 v2 query strings and adds only the approved doctor and discovery cases', () => {
    expect(hash(JSON.stringify(OPERATIONAL_FIXTURES_V3))).toBe('b7fece6f86895adff3112a288e13e1123b61bc5062c8adb6d2b2804ae25cecdd');
    expect(OPERATIONAL_FIXTURES_V3.slice(0, 19)).toEqual(OPERATIONAL_FIXTURES.map(({ id, class: fixtureClass, query }) => ({ id, class: fixtureClass, query })));
    expect(OPERATIONAL_FIXTURES_V3.slice(19)).toEqual([
      { id: 'doctor-local-vector-storage', class: 'broad', query: 'How should I store embeddings in this project without running a server?' },
      { id: 'broad-cross-project-discovery', class: 'broad', query: 'How can agents carry useful learning from one project to another?' },
    ]);
  });

  it('preflights exact passage hashes and every required span before any query can run', async () => {
    const kb = corpus({ rvfguide: [
      { path: 'README.md', text: 'RVF is persisted in a portable file.' },
      { path: 'alt.md', text: 'Search uses an on-device vector index.' },
    ], 'vector-index': [{ path: 'INDEX.md', text: FACT_B }] });
    const catalog = makeCatalog(kb);
    const result = await preflightOperationalOracle({ fixtures: [QUERY, GAP_QUERY, NEGATIVE], catalog, kbDir: kb });
    expect(result.get(QUERY.id)).toMatchObject({ status: 'PASS', resolvedSlots: [
      { id: 'portable' }, { id: 'search' },
    ] });
    expect(result.get(GAP_QUERY.id)).toMatchObject({ status: 'CORPUS_GAP' });
    expect(result.get(NEGATIVE.id)).toMatchObject({ status: 'PASS' });

    const badSpan = structuredClone(catalog);
    badSpan.fixtures[0].claimSlots[0].alternatives[0].spans = ['the candidate answer said this'];
    const invalid = await preflightOperationalOracle({ fixtures: [QUERY, GAP_QUERY, NEGATIVE], catalog: badSpan, kbDir: kb });
    expect(invalid.get(QUERY.id)).toMatchObject({ status: 'INVALID_ORACLE' });

    const wrongCorpus = structuredClone(catalog);
    wrongCorpus.corpus.sourceManifestSha256 = 'f'.repeat(64);
    const gap = await preflightOperationalOracle({ fixtures: [QUERY, GAP_QUERY, NEGATIVE], catalog: wrongCorpus, kbDir: kb });
    expect([...gap.values()].every((item) => item.status === 'CORPUS_GAP')).toBe(true);
  });

  it('treats claim slots as AND and reviewed source alternatives as OR, even for CE-null witness evidence', async () => {
    const kb = corpus({ rvfguide: [{ path: 'README.md', text: FACT_A }, { path: 'alt.md', text: 'Search uses an on-device vector index.' }],
      'vector-index': [{ path: 'INDEX.md', text: FACT_B }] });
    const catalog = makeCatalog(kb);
    const preflight = (await preflightOperationalOracle({ fixtures: [QUERY, GAP_QUERY, NEGATIVE], catalog, kbDir: kb })).get(QUERY.id);
    const cite = (repo, docPath, ce = null, proofMethod = 'untrusted-label') => ({ repo, docPath, ce, proofMethod });
    expect(matchClaimSlots(preflight, { citations: [cite('rvfguide', 'README.md', null, 'reviewed-source-catalog')] }).allSlotsSupported).toBe(false);
    expect(matchClaimSlots(preflight, { citations: [
      cite('rvfguide', 'README.md', null, 'reviewed-source-catalog'),
      cite('vector-index', 'INDEX.md', null, 'reviewed-source-catalog'),
    ] })).toMatchObject({ allSlotsSupported: true });
    expect(matchClaimSlots(preflight, { citations: [
      cite('rvfguide', 'README.md', 1), cite('rvfguide', 'other.md', 1),
    ] }).allSlotsSupported).toBe(false);
    expect(matchClaimSlots(preflight, { citations: [
      cite('rvfguide', 'README.md', 1), cite('rvfguide', 'alt.md', 1),
    ] }).allSlotsSupported).toBe(true);
    expect(matchClaimSlots(preflight, { citations: [
      cite('rvfguide', 'README.md', 1), cite('vector-index', 'INDEX.md', -2),
    ] }).allSlotsSupported).toBe(false);
  });

  it('marks absent source passages as corpus gaps and malformed fixture sets as invalid oracles', async () => {
    const kb = corpus({});
    const catalog = makeCatalog(kb);
    const absent = await preflightOperationalOracle({ fixtures: [QUERY, GAP_QUERY, NEGATIVE], catalog, kbDir: kb });
    expect(absent.get(QUERY.id)).toMatchObject({ status: 'CORPUS_GAP' });
    const malformed = await preflightOperationalOracle({ fixtures: [QUERY, GAP_QUERY, NEGATIVE],
      catalog: { ...catalog, fixtures: catalog.fixtures.slice(1) }, kbDir: kb });
    expect([...malformed.values()].every((item) => item.status === 'INVALID_ORACLE')).toBe(true);
  });

  it('requires process success and explicit uncertainty for negatives and ambiguity', () => {
    expect(gradeOperationalFixtureV3(QUERY, { processOk: false, preflightStatus: 'PASS' })).toMatchObject({ status: 'RETRIEVAL_MISS', pass: false });
    expect(gradeOperationalFixtureV3(NEGATIVE, { processOk: true, preflightStatus: 'PASS',
      output: 'EVIDENCE: THIN. No source found.', verification: { grounded: false, citations: [] } })).toMatchObject({ status: 'PASS', pass: true });
    expect(gradeOperationalFixtureV3(NEGATIVE, { processOk: true, preflightStatus: 'PASS',
      output: 'EVIDENCE: THIN. No source found.', verification: { grounded: true, citations: [{ ce: 1 }] } })).toMatchObject({ pass: false });
  });

  it('keeps corpus-gap fixtures in the fixed denominator and does not invoke retrieval for them', async () => {
    const kb = corpus({ rvfguide: [{ path: 'README.md', text: FACT_A }, { path: 'alt.md', text: 'Search uses an on-device vector index.' }],
      'vector-index': [{ path: 'INDEX.md', text: FACT_B }] });
    for (const name of ['forge-ask-all.mjs', 'verify-citation.mjs']) fs.writeFileSync(path.join(kb, name), '// test boundary');
    const fixtures = [QUERY, GAP_QUERY, NEGATIVE];
    const catalog = makeCatalog(kb, fixtures);
    const searches = [];
    const report = await runOperationalBenchmarkV3({ fixtures, kb, catalog, now: () => 'fixed-time',
      runQuery: async (fixture) => { searches.push(fixture.id); return { stdout: 'EVIDENCE: THIN. No source found.' }; },
      verify: async () => ({ grounded: false, citations: [] }) });
    expect(searches).toEqual([QUERY.id, NEGATIVE.id]);
    expect(report).toMatchObject({ schema: 'ruvnet-brain-operational-benchmark/v3', total: 3, measured: 2,
      qualificationPass: false, corpusGaps: [{ fixtureId: 'gap' }] });
  });

  it('demotes a result if a passage store changes while retrieval is running', async () => {
    const kb = corpus({ rvfguide: [{ path: 'README.md', text: FACT_A }, { path: 'alt.md', text: 'Search uses an on-device vector index.' }],
      'vector-index': [{ path: 'INDEX.md', text: FACT_B }] });
    for (const name of ['forge-ask-all.mjs', 'verify-citation.mjs']) fs.writeFileSync(path.join(kb, name), '// test boundary');
    const fixtures = [QUERY, GAP_QUERY, NEGATIVE];
    const catalog = makeCatalog(kb, fixtures);
    let changed = false;
    const report = await runOperationalBenchmarkV3({ fixtures, kb, catalog,
      runQuery: async (fixture) => {
        if (!changed && fixture.id === QUERY.id) {
          fs.appendFileSync(path.join(kb, 'rvfguide.passages.jsonl'), `${JSON.stringify({ path: 'later.md', text: 'changed during replay' })}\n`);
          changed = true;
        }
        return { stdout: 'EVIDENCE: THIN. No source found.' };
      }, verify: async () => ({ grounded: false, citations: [] }) });
    expect(report.receipts.find((item) => item.fixtureId === QUERY.id)).toMatchObject({
      preflight: { status: 'CORPUS_GAP' }, grade: { pass: false, status: 'CORPUS_GAP' },
    });
    expect(report.qualificationPass).toBe(false);
  });
});
