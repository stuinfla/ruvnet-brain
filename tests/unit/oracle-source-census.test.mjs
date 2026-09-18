import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveSourceCensus, assertSourceCensusPartitions } from '../../scripts/oracle/source-census.mjs';
import { sourceCensusFixture } from '../helpers/oracle-source-census-fixture.mjs';
import { augmentSourceCoverage } from '../helpers/oracle-source-census-fixture.mjs';
import { buildAssets, sha256, writeMinimalRvf } from '../helpers/corpus-seed-fixture.mjs';
import { digest } from '../../plugin/scripts/coverage-integrity.mjs';
import { sealGistReceipt, sealGistReceiptSet } from '../../scripts/gist-receipts.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function census() {
  return sourceCensusFixture();
}

describe('oracle archive source census', () => {
  it('accepts an exact qualified/measured partition set', () => {
    const result = assertSourceCensusPartitions(census(), census().partitions);
    expect(result).toEqual({ missing: [] });
  });

  it.each([
    ['missing', (rows) => rows.slice(1)],
    ['extra', (rows) => [...rows, { id: 'z', kind: 'repository', store: 'z', sourceCommit: 'f'.repeat(40) }]],
    ['changed commit', (rows) => rows.map((row) => row.id === 'alpha' ? { ...row, sourceCommit: 'f'.repeat(40) } : row)],
    ['changed kind', (rows) => rows.map((row) => row.id === 'alpha' ? { ...row, kind: 'gist' } : row)],
  ])('rejects %s partition drift in strict mode', (_label, mutate) => {
    expect(() => assertSourceCensusPartitions(census(), mutate(census().partitions))).toThrow(/census/);
  });

  it('reports missing partitions only for explicit diagnostic matching', () => {
    const rows = census().partitions.slice(0, 1);
    expect(assertSourceCensusPartitions(census(), rows, { allowMissing: true })).toEqual({ missing: ['gist:' + 'b'.repeat(32)] });
  });

  it('rejects a census whose seal or partition identity was changed', () => {
    const value = census();
    expect(() => assertSourceCensusPartitions({ ...value, censusSha256: 'f'.repeat(64) }, value.partitions)).toThrow(/digest/);
    const reversed = [...value.partitions].reverse();
    expect(() => assertSourceCensusPartitions({ ...value, partitions: reversed, censusSha256: value.censusSha256 }, value.partitions)).toThrow(/digest/);
  });

  it.each(['missing', 'overlap', 'unknown', 'fake-commit'])('rejects resealed invalid derived accounting: %s', variant => {
    const value = census();
    if (variant === 'missing') value.excludedDerived = [];
    if (variant === 'overlap') value.excludedDerived[0].store = 'alpha';
    if (variant === 'unknown') value.archiveStores.push('unknown');
    if (variant === 'fake-commit') value.excludedDerived[0].sourceCommit = 'a'.repeat(40);
    const { censusSha256, ...payload } = value;
    value.censusSha256 = digest(payload);
    expect(() => assertSourceCensusPartitions(value,value.partitions)).toThrow(/census/);
  });

  it('fails closed for incomplete coverage and returns null only in historical diagnostic mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-source-census-')); roots.push(root);
    expect(archiveSourceCensus(root, { requireCoverage: false })).toBeNull();
    expect(() => archiveSourceCensus(root)).toThrow(/complete coverage/);
  });

  it('builds and consumes a real modern coverage directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-source-census-valid-')); roots.push(root);
    const assets=await buildAssets(root);
    const versionA = 'c'.repeat(40); const versionB = 'd'.repeat(40);
    const idA = 'e'.repeat(32); const idB = 'f'.repeat(32);
    fs.writeFileSync(path.join(assets, 'ruv-gists.passages.jsonl'), '{"id":"g1","text":"one"}\n{"id":"g2","text":"two"}\n');
    const gist = (id, version) => sealGistReceipt({ gistId: id, versionSha: version,
      updatedAt: '2026-09-13T00:00:00.000Z', ingestedAt: '2026-09-13T00:00:00.000Z', complete: true,
      files: [{ filename: 'note.md', included: true, sha256: '1'.repeat(64), bytes: 4 }] });
    const receipt = sealGistReceiptSet({ owner: 'ruvnet', generated: '2026-09-13T00:00:00.000Z',
      observedAt: '2026-09-13T00:00:00.000Z', sourceObservationSha256: 'c'.repeat(64),
      passagesSha256: sha256(path.join(assets, 'ruv-gists.passages.jsonl')), gists: { [idA]: gist(idA, versionA), [idB]: gist(idB, versionB) } });
    fs.writeFileSync(path.join(assets, 'ruv-gists.sources.json'), JSON.stringify(receipt));
    await writeMinimalRvf(path.join(assets, 'ruv-gists.big.rvf'));
    await writeMinimalRvf(path.join(assets, 'concepts.big.rvf'));
    fs.writeFileSync(path.join(assets, 'concepts.passages.jsonl'), '{"id":"c1","text":"concept"}\n');
    fs.writeFileSync(path.join(assets, 'concepts.meta.json'), '{"dimensions":3}\n');
    fs.writeFileSync(path.join(assets, 'concepts.sources.json'), JSON.stringify({ schemaVersion: 1,
      kind: 'ruvnet-brain-derived-store-receipt', store: 'concepts', inputs: [{ path: 'concepts.meta.json', sha256: sha256(path.join(assets, 'concepts.meta.json')) }],
      passagesSha256: sha256(path.join(assets, 'concepts.passages.jsonl')) }));
    fs.writeFileSync(path.join(assets, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [{ store: 'concepts', receipt: 'concepts.sources.json' }] }));
    const ledger = JSON.parse(fs.readFileSync(path.join(assets, 'RVF-GENERATIONS.json')));
    for (const [store, commit] of [['ruv-gists', null], ['concepts', null]]) {
      const file = `${store}.big.rvf`;
      ledger.stores[store] = { file, sha256: sha256(path.join(assets, file)), bytes: fs.statSync(path.join(assets, file)).size,
        model: 'local', dimensions: 3, sourceCommit: commit, builtUtc: '2026-09-13T00:00:00.000Z' };
    }
    fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify(ledger));
    augmentSourceCoverage(assets, { rows: [
      { key: 'repo:alpha', kind: 'repository', name: 'alpha', url: 'https://github.com/ruvnet/alpha', status: 'CURRENT', disposition: 'eligible', upstream: { sha: 'a'.repeat(40) }, artifact: { store: 'alpha', sourceCommit: 'a'.repeat(40) }, reasons: [] },
      ...[[idA, versionA], [idB, versionB]].map(([id, version]) => ({ key: `gist:${id}`, kind: 'gist', name: id, url: `https://gist.github.com/ruvnet/${id}`, status: 'CURRENT', disposition: 'eligible', upstream: { sha: version }, artifact: { store: 'ruv-gists', sourceCommit: version }, reasons: [] })),
    ] });
    for (const [logical, physical] of [['ruv-gists', 'Ruv-Gists'], ['concepts', 'Concepts']]) {
      fs.renameSync(path.join(assets, `${logical}.big.rvf`), path.join(assets, `${physical}.big.rvf`));
      ledger.stores[physical] = { ...ledger.stores[logical], file: `${physical}.big.rvf` };
      delete ledger.stores[logical];
      for (const suffix of ['passages.jsonl', 'sources.json']) {
        fs.renameSync(path.join(assets, `${logical}.${suffix}`), path.join(assets, `${physical}.${suffix}`));
      }
    }
    fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify(ledger));
    const classes = JSON.parse(fs.readFileSync(path.join(assets, 'public-store-classes.json'), 'utf8'));
    classes.derived[0].store = 'CONCEPTS';
    classes.derived[0].receipt = 'Concepts.sources.json';
    fs.writeFileSync(path.join(assets, 'public-store-classes.json'), JSON.stringify(classes));
    const coverage = JSON.parse(fs.readFileSync(path.join(assets, 'CORPUS-COVERAGE.json'), 'utf8'));
    coverage.rows.forEach((row) => { if (row.artifact?.store === 'ruv-gists') row.artifact.store = 'RUV-GISTS'; });
    augmentSourceCoverage(assets, { rows: coverage.rows });
    const result = archiveSourceCensus(assets);
    expect(result).toMatchObject({ schemaVersion: 2, kind: 'ruvnet-brain-oracle-archive-source-census' });
    expect(result.partitions.map(({ id }) => id)).toEqual(['alpha', `gist:${idA}`, `gist:${idB}`]);
    expect(result.archiveStores).toEqual(['alpha','concepts','ruv-gists']);
    expect(result.excludedDerived).toEqual([{store:'concepts',reason:'derived-view',ledgerDigest:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
    expect(result.excludedDerived[0]).not.toHaveProperty('sourceCommit');
    const receiptFile=path.join(assets,'ruv-gists.sources.json');
    const incomplete=sealGistReceiptSet({...receipt,gists:{[idA]:receipt.gists[idA]}});
    fs.writeFileSync(receiptFile,JSON.stringify(incomplete));
    expect(()=>archiveSourceCensus(assets)).toThrow(/gist.*exact sorted gist set/);
    fs.writeFileSync(receiptFile,JSON.stringify(receipt));
    const rows=JSON.parse(fs.readFileSync(path.join(assets,'CORPUS-COVERAGE.json'),'utf8')).rows;
    rows.find(row=>row.key===`gist:${idA}`).artifact.sourceCommit='9'.repeat(40);
    augmentSourceCoverage(assets,{rows});
    expect(()=>archiveSourceCensus(assets)).toThrow(/coverage sourceCommit differs from authenticated receipt/);

  });
});
