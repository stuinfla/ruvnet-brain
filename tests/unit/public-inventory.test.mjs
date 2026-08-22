import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePublicInventory } from '../../scripts/public-inventory.mjs';
import { sealGistReceipt, sealGistReceiptSet } from '../../scripts/gist-receipts.mjs';

const roots = [];
const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-inventory-'));
  roots.push(root);
  const stores = ['alpha', 'ruv-gists', 'concepts'];
  const ledger = { schemaVersion: 1, stores: {} };
  for (const store of stores) {
    const body = `${store}-rvf`;
    fs.writeFileSync(path.join(root, `${store}.big.rvf`), body);
    ledger.stores[store] = { file: `${store}.big.rvf`, sha256: sha256(body), bytes: Buffer.byteLength(body),
      model: 'fixture-model', dimensions: 384, sourceCommit: null, builtUtc: '2026-08-21T12:00:00.000Z' };
  }
  fs.writeFileSync(path.join(root, 'RVF-GENERATIONS.json'), JSON.stringify(ledger));
  fs.writeFileSync(path.join(root, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  const gistId = 'a'.repeat(32);
  const gistPassages = '{"gist":"g1"}\n';
  fs.writeFileSync(path.join(root, 'ruv-gists.passages.jsonl'), gistPassages);
  const gist = sealGistReceipt({ gistId, versionSha: 'b'.repeat(40),
    updatedAt: '2026-08-21T11:00:00.000Z', ingestedAt: '2026-08-21T12:00:00.000Z', complete: true,
    files: [{ filename: 'note.md', included: true, sha256: sha256('source'), bytes: 6 }] });
  const gistSources = sealGistReceiptSet({ owner: 'ruvnet', generated: '2026-08-21T12:00:00.000Z',
    observedAt: '2026-08-21T11:00:00.000Z', sourceObservationSha256: 'd'.repeat(64),
    passagesSha256: sha256(gistPassages), gists: { [gistId]: gist } });
  fs.writeFileSync(path.join(root, 'ruv-gists.sources.json'), JSON.stringify(gistSources));
  fs.writeFileSync(path.join(root, 'alpha.md'), 'alpha source');
  fs.writeFileSync(path.join(root, 'concepts.passages.jsonl'), '{"concept":"alpha"}\n');
  fs.writeFileSync(path.join(root, 'concepts.sources.json'), JSON.stringify({ schemaVersion: 1,
    kind: 'ruvnet-brain-derived-store-receipt', store: 'concepts', inputs: [{ path: 'alpha.md', sha256: sha256('alpha source') }],
    passagesSha256: sha256('{"concept":"alpha"}\n') }));
  fs.writeFileSync(path.join(root, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1,
    derived: [{ store: 'concepts', receipt: 'concepts.sources.json' }] }));
  const coverage = { schemaVersion: 1, sourceObservationSha256: 'd'.repeat(64), rows: [
    { key: 'repo:alpha', kind: 'repository', disposition: 'eligible', status: 'CURRENT', artifact: { store: 'alpha' } },
    { key: `gist:${gistId}`, kind: 'gist', disposition: 'eligible', status: 'CURRENT', artifact: { store: 'ruv-gists' } },
  ] };
  return { root, coverage, ledger, gistId };
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('typed public inventory partition', () => {
  it('partitions repository, gist aggregate, and derived families exhaustively', () => {
    const f = fixture();
    const result = validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger });
    expect(result).toMatchObject({ repositories: ['alpha'], gistAggregate: 'ruv-gists', derived: ['concepts'],
      publicStores: ['alpha', 'concepts', 'ruv-gists'] });
    expect(result.partitionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.evidenceFiles.map(({ kind, path: relative }) => [kind, relative])).toEqual([
      ['derived-input', 'alpha.md'],
      ['derived-passages', 'concepts.passages.jsonl'],
      ['derived-receipt', 'concepts.sources.json'],
      ['class-registry', 'public-store-classes.json'],
      ['gist-passages', 'ruv-gists.passages.jsonl'],
      ['gist-receipt', 'ruv-gists.sources.json'],
    ]);
  });

  it('binds the exact classification evidence bytes into the partition digest', () => {
    const f = fixture();
    const before = validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger });
    fs.appendFileSync(path.join(f.root, 'public-store-classes.json'), '\n');
    const after = validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger });
    expect(after.partitionSha256).not.toBe(before.partitionSha256);
  });

  it.each([
    ['extra store', (f) => {
      fs.writeFileSync(path.join(f.root, 'orphan.big.rvf'), 'orphan');
      f.ledger.stores.orphan = { file: 'orphan.big.rvf', sha256: sha256('orphan'), bytes: 6 };
    }, /unclassified.*orphan/i],
    ['missing repository store', (f) => {
      fs.rmSync(path.join(f.root, 'alpha.big.rvf'));
    }, /alpha.*missing/i],
    ['incomplete gist receipt', (f) => {
      const receipt = JSON.parse(fs.readFileSync(path.join(f.root, 'ruv-gists.sources.json'), 'utf8'));
      receipt.gists[Object.keys(receipt.gists)[0]].complete = false;
      fs.writeFileSync(path.join(f.root, 'ruv-gists.sources.json'), JSON.stringify(receipt));
    }, /gist.*complete/i],
    ['missing derived receipt', (f) => {
      fs.rmSync(path.join(f.root, 'concepts.sources.json'));
    }, /derived.*concepts.*receipt/i],
  ])('fails closed for %s', (_name, mutate, error) => {
    const f = fixture();
    mutate(f);
    expect(() => validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger })).toThrow(error);
  });

  it.each([
    ['traversal', '../concepts.sources.json'],
    ['absolute', '/tmp/concepts.sources.json'],
  ])('rejects %s derived receipt paths', (_label, receiptPath) => {
    const f = fixture();
    const classesFile = path.join(f.root, 'public-store-classes.json');
    const classes = readJson(classesFile);
    classes.derived[0].receipt = receiptPath;
    writeJson(classesFile, classes);
    expect(() => validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger }))
      .toThrow(/path escapes/i);
  });

  it('rejects canonical RVF symlinks and case-fold aliases', () => {
    const symlinked = fixture();
    fs.renameSync(path.join(symlinked.root, 'alpha.big.rvf'), path.join(symlinked.root, 'alpha-target.rvf'));
    fs.symlinkSync('alpha-target.rvf', path.join(symlinked.root, 'alpha.big.rvf'));
    expect(() => validatePublicInventory({ assetsDir: symlinked.root,
      coverage: symlinked.coverage, ledger: symlinked.ledger })).toThrow(/canonical RVF.*trusted regular file/i);

    const aliased = fixture();
    aliased.ledger.stores.Alpha = structuredClone(aliased.ledger.stores.alpha);
    expect(() => validatePublicInventory({ assetsDir: aliased.root,
      coverage: aliased.coverage, ledger: aliased.ledger })).toThrow(/case-fold aliases/i);
  });

  it('excludes a private store but rejects a private/public collision', () => {
    const f = fixture();
    const secret = 'secret-rvf';
    fs.writeFileSync(path.join(f.root, 'secret.big.rvf'), secret);
    f.ledger.stores.secret = { file: 'secret.big.rvf', sha256: sha256(secret), bytes: Buffer.byteLength(secret),
      model: 'fixture-model', dimensions: 384, sourceCommit: null, builtUtc: '2026-08-21T12:00:00.000Z' };
    writeJson(path.join(f.root, 'PRIVATE-STORES.json'), { privateStores: ['secret'] });
    expect(validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger }).publicStores)
      .not.toContain('secret');
    writeJson(path.join(f.root, 'PRIVATE-STORES.json'), { privateStores: ['secret', 'alpha'] });
    expect(() => validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger }))
      .toThrow(/private\/public store collision.*alpha/i);
  });

  it.each([
    ['RVF bytes', (f) => fs.appendFileSync(path.join(f.root, 'alpha.big.rvf'), 'moved'), /does not bind the RVF bytes/i],
    ['RVF byte count', (f) => { f.ledger.stores.alpha.bytes += 1; }, /does not bind the RVF bytes/i],
    ['RVF digest', (f) => { f.ledger.stores.alpha.sha256 = '0'.repeat(64); }, /does not bind the RVF bytes/i],
    ['missing ledger store', (f) => { delete f.ledger.stores.alpha; }, /ledger store set differs/i],
    ['extra ledger store', (f) => { f.ledger.stores.orphan = { file: 'orphan.big.rvf' }; }, /ledger store set differs/i],
    ['derived input', (f) => fs.writeFileSync(path.join(f.root, 'alpha.md'), 'moved'), /derived concepts input receipt differs/i],
    ['derived passages', (f) => fs.appendFileSync(path.join(f.root, 'concepts.passages.jsonl'), 'moved'), /does not bind its passage bytes/i],
    ['gist id set', (f) => { f.coverage.rows[1].key = `gist:${'c'.repeat(32)}`; }, /exact sorted gist set/i],
    ['gist count', (f) => {
      const file = path.join(f.root, 'ruv-gists.sources.json'); const receipt = readJson(file);
      receipt.gistSet.count = 2; writeJson(file, receipt);
    }, /exact sorted gist set/i],
    ['gist source observation', (f) => { f.coverage.sourceObservationSha256 = 'e'.repeat(64); }, /observation differs/i],
    ['gist passages', (f) => fs.appendFileSync(path.join(f.root, 'ruv-gists.passages.jsonl'), 'moved'), /does not bind its passage bytes/i],
  ])('fails closed for %s mutation', (_name, mutate, error) => {
    const f = fixture();
    mutate(f);
    expect(() => validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger })).toThrow(error);
  });

  it('rejects overlapping repository and derived store families', () => {
    const f = fixture();
    const passages = '{"derived":"alpha"}\n';
    fs.writeFileSync(path.join(f.root, 'alpha.passages.jsonl'), passages);
    writeJson(path.join(f.root, 'alpha.sources.json'), { schemaVersion: 1,
      kind: 'ruvnet-brain-derived-store-receipt', store: 'alpha',
      inputs: [{ path: 'alpha.md', sha256: sha256('alpha source') }], passagesSha256: sha256(passages) });
    const classesFile = path.join(f.root, 'public-store-classes.json');
    const classes = readJson(classesFile);
    classes.derived.push({ store: 'alpha', receipt: 'alpha.sources.json' });
    writeJson(classesFile, classes);
    expect(() => validatePublicInventory({ assetsDir: f.root, coverage: f.coverage, ledger: f.ledger }))
      .toThrow(/public store classes overlap/i);
  });
});
