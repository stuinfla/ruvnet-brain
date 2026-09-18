import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { loadFixture } from '../../scripts/oracle/repo-recall.mjs';
import { sealRetrievalQueryEvidence } from '../../scripts/retrieval-canary.mjs';
import {
  createCorpusReceipt,
  verifyCorpusReceipt,
  verifySeedBaseline,
} from '../../scripts/corpus-candidate.mjs';
import { RvfDatabase, SOURCE_COMMIT, buildAssets, seal, sha256, writeAccuracyReport, writeRecallReport, attestFixtureRecall } from '../helpers/corpus-seed-fixture.mjs';

// The genuine-RVF bundle fixture (writeMinimalRvf / buildAssets / seal) moved to
// tests/helpers/corpus-seed-fixture.mjs on 2026-09-13 so tests/unit/corpus-seed-release-authority.test.mjs
// can share it — see that file's header for why a placeholder text file cannot stand in for an RVF.

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-seed-'));
  dirs.push(root);
  const bundleDir = await buildAssets(root);
  const bundle = seal(root, bundleDir);
  return { root, bundleDir, bundle, receiptFile: path.join(root, 'corpus-receipt.json') };
}

async function create(f) {
  return createCorpusReceipt({
    bundleFile: f.bundle,
    receiptFile: f.receiptFile,
    builderSourceSha: 'c'.repeat(40),
    createdAt: '2026-08-21T12:34:56.000Z',
  });
}

describe('immutable corpus candidate receipt (schema 3)', () => {
  it('creates and verifies a receipt binding every public store, sidecar, fence, and archive byte', async () => {
    const f = await fixture();
    const receipt = await create(f);

    expect(receipt).toMatchObject({
      schemaVersion: 3,
      kind: 'ruvnet-brain-corpus-candidate',
      builderSourceSha: 'c'.repeat(40),
      storeCount: 1,
      excludedPrivateStores: ['secret'],
      duplicateRvfDigests: [],
      unreceiptedRvfFiles: [],
      missingSidecars: [],
      bootstrap: null,
    });
    expect(receipt.privateFence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.generationLedger.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.sourceManifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.archiveManifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.stores[0]).toMatchObject({ name: 'alpha', kind: 'repository', sourceCommit: SOURCE_COMMIT });
    expect(receipt.stores[0].files).toHaveLength(5);
    await expect(verifyCorpusReceipt({
      receiptFile: f.receiptFile,
      bundleFile: f.bundle,
    })).resolves.toEqual(receipt);
  });

  it('rejects measurement identities for different runtime bytes, even with a valid report digest', async () => {
    for (const kind of ['accuracy', 'recall']) {
      const f = await fixture();
      const file = `${f.bundle}.${kind}.json`;
      const report = JSON.parse(fs.readFileSync(file, 'utf8'));
      const identity = kind === 'accuracy' ? report.runtime.identity : report.protocol.runtimeIdentity;
      identity.files.find(row => row.path === 'forge-ask-all.mjs').sha256 = 'f'.repeat(64);
      identity.sha256 = digest({files: identity.files, dependencies: identity.dependencies});
      const {runtimeSha256, ...payload} = identity;
      identity.runtimeSha256 = digest(payload);
      fs.writeFileSync(file, JSON.stringify(kind === 'recall' ? attestFixtureRecall(report) : report));
      await expect(create(f)).rejects.toThrow(/runtime files.*differ from the archive/);
    }
  });

  it('rejects a report that omits part of the sealed runtime closure after resealing its digests', async () => {
    const f = await fixture();
    const file = `${f.bundle}.accuracy.json`;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const identity = report.runtime.identity;
    identity.files = identity.files.filter(row => row.path !== 'package.json');
    identity.sha256 = digest({ files: identity.files, dependencies: identity.dependencies });
    const { runtimeSha256, ...payload } = identity;
    identity.runtimeSha256 = digest(payload);
    fs.writeFileSync(file, JSON.stringify(report));
    await expect(create(f)).rejects.toThrow(/complete archive retrieval closure/);
  });

  it('rejects an inconsistent inner runtime digest even when the outer digest is recomputed', async () => {
    const f = await fixture();
    const file = `${f.bundle}.accuracy.json`;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const identity = report.runtime.identity;
    identity.sha256 = 'f'.repeat(64);
    const { runtimeSha256, ...payload } = identity;
    identity.runtimeSha256 = digest(payload);
    fs.writeFileSync(file, JSON.stringify(report));
    await expect(create(f)).rejects.toThrow(/runtime source closure digest/);
  });

  it('rejects an attested recall measurement with no controlled runtime identity', async () => {
    const f = await fixture();
    const file = `${f.bundle}.recall.json`;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    report.protocol.runtimeIdentity = null;
    fs.writeFileSync(file, JSON.stringify(attestFixtureRecall(report)));
    await expect(create(f)).rejects.toThrow(/controlled archive runtime identity/);
  });

  it('verifies a pinned historical receipt using its explicitly supplied historical fixture', async () => {
    const f = await fixture();
    const oldFixture = path.join(f.root, 'historical-fixture.json');
    const historical = JSON.parse(fs.readFileSync(loadFixture().file, 'utf8'));
    const record = Object.values(historical.queries)[0];
    record.expected.passageSha256 = '0'.repeat(64);
    record.recordSha256 = digest({query: record.query, expected: record.expected});
    fs.writeFileSync(oldFixture, JSON.stringify(sealRetrievalQueryEvidence(historical)));
    const reportFile = `${f.bundle}.recall.json`;
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    report.fixture.sha256 = loadFixture(oldFixture).fixtureSha256;
    fs.writeFileSync(reportFile, JSON.stringify(attestFixtureRecall(report)));
    const receipt = await createCorpusReceipt({bundleFile: f.bundle, receiptFile: f.receiptFile,
      builderSourceSha: 'c'.repeat(40), fixtureFile: oldFixture});
    receipt.generator.corpusCandidateSha256 = 'f'.repeat(64);
    fs.writeFileSync(f.receiptFile, JSON.stringify(receipt));
    const options = {bundleFile: f.bundle, receiptFile: f.receiptFile,
      expectedReceiptSha256: sha256(f.receiptFile), fixtureFile: oldFixture};
    await expect(verifyCorpusReceipt(options)).resolves.toEqual(receipt);
    await expect(verifyCorpusReceipt({...options, fixtureFile: null})).rejects.toThrow(/fixture/);
    await expect(verifyCorpusReceipt({...options, expectedReceiptSha256: undefined})).rejects.toThrow(/receipt does not match/);
  });

  it('fails closed for unreceipted RVFs, missing sidecars, duplicate RVFs, and orphan ledger rows', async () => {
    const mutations = [
      (f) => { fs.writeFileSync(path.join(f.bundleDir, 'orphan.big.rvf'), 'orphan'); f.bundle = seal(f.root, f.bundleDir); },
      (f) => { fs.rmSync(path.join(f.bundleDir, 'alpha.meta.json')); f.bundle = seal(f.root, f.bundleDir); },
      (f) => {
        for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.copyFileSync(path.join(f.bundleDir, `alpha${suffix}`), path.join(f.bundleDir, `beta${suffix}`));
        }
        const ledgerFile = path.join(f.bundleDir, 'RVF-GENERATIONS.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerFile));
        ledger.stores.beta = { ...ledger.stores.alpha, file: 'beta.big.rvf' };
        fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
        f.bundle = seal(f.root, f.bundleDir);
      },
      (f) => {
        const ledgerFile = path.join(f.bundleDir, 'RVF-GENERATIONS.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerFile));
        ledger.stores.ghost = { ...ledger.stores.alpha, file: 'ghost.big.rvf' };
        fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
        f.bundle = seal(f.root, f.bundleDir);
      },
    ];
    const expected = [/unreceipted/i, /missing sidecars/i, /duplicate RVF/i, /ledger rows without RVFs/i];
    for (const [index, mutate] of mutations.entries()) {
      const f = await fixture();
      mutate(f);
      await expect(create(f)).rejects.toThrow(expected[index]);
    }
  });

  it('rejects a shipped RVF whose persisted HNSW index has been truncated/corrupted on disk', async () => {
    const f = await fixture();
    const rvfPath = path.join(f.bundleDir, 'alpha.big.rvf');
    const ledgerFile = path.join(f.bundleDir, 'RVF-GENERATIONS.json');

    // Replace the fixture's minimal 2-vector store (below the 1,024-vector HNSW threshold, so it
    // never needs an index) with a real store big enough to require — and actually persist — an
    // HNSW index, then force that index to materialize exactly like build-bundle.mjs's own
    // pre-ship gate does (kb/rvf-index.mjs's persistAndVerifyRvfIndex).
    fs.rmSync(rvfPath);
    fs.rmSync(`${rvfPath}.idmap.json`);
    const db = await RvfDatabase.create(rvfPath, { dimensions: 3, metric: 'cosine' });
    await db.ingestBatch(Array.from({ length: 1024 }, (_, index) => ({
      id: `vector-${index}`,
      vector: index % 2 ? [1, 0, 0] : [0, 1, 0],
    })));
    await db.close();
    const indexer = await RvfDatabase.open(rvfPath);
    const probe = new Float32Array(3);
    probe[0] = 1;
    await indexer.query(probe, 1);
    await indexer.close();

    // Step 13's deep C2 audit proves id-map <-> vector <-> passage <-> source-mapping
    // correspondence, so replacing the store's vectors means replacing its sidecars too — the
    // fixture's 2-passage set describes v-0/v-1, not the 1,024 vectors ingested above. Without
    // this the positive control below fails `passage-missing` before corruption is ever tested.
    const bigPassages = Array.from({ length: 1024 }, (_, index) => ({
      id: `vector-${index}`,
      text: `alpha passage ${index}`,
      path: `docs/${index}.md`,
      title: String(index),
    }));
    fs.writeFileSync(path.join(f.bundleDir, 'alpha.passages.jsonl'), `${bigPassages.map((row) => JSON.stringify(row)).join('\n')}\n`);
    fs.writeFileSync(path.join(f.bundleDir, 'alpha.meta.json'), JSON.stringify({
      dimensions: 3,
      incremental: {
        schemaVersion: 2,
        files: Object.fromEntries(bigPassages.map((row) => [row.path, { chunkIds: [row.id] }])),
      },
    }));

    const rebindLedgerToCurrentBytes = () => {
      const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      ledger.stores.alpha.sha256 = sha256(rvfPath);
      ledger.stores.alpha.bytes = fs.statSync(rvfPath).size;
      fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    };
    rebindLedgerToCurrentBytes();
    f.bundle = seal(f.root, f.bundleDir);

    // Sanity: the intact, correctly indexed archive verifies clean first — otherwise this test
    // would not be proving anything about corruption detection specifically.
    await expect(create(f), 'a fresh, correctly indexed RVF must verify clean, or this test guards nothing').resolves.toMatchObject({ storeCount: 1 });

    // Corrupt: truncate the file exactly at its persisted INDEX_SEG's on-disk offset, discarding
    // the index the way storage corruption or an interrupted write would. The ledger/manifest are
    // then rebound to these exact (corrupted) bytes, so every plain byte-hash check in this
    // receipt still matches — only a real open-and-inspect of the RVF's own segment table can
    // catch this, which is exactly the gap scripts/rvf-index-audit.mjs's auditRvfIndexes closes.
    const inspect = await RvfDatabase.openReadonly(rvfPath);
    const segments = await inspect.segments();
    await inspect.close();
    const indexSeg = segments.find((segment) => segment.segType === 'index');
    expect(indexSeg, 'fixture must have actually persisted an index, or this test guards nothing').toBeTruthy();
    const fd = fs.openSync(rvfPath, 'r+');
    fs.ftruncateSync(fd, indexSeg.offset);
    fs.closeSync(fd);
    expect(fs.statSync(rvfPath).size, 'the file must actually have shrunk').toBeLessThan(indexSeg.offset + indexSeg.payloadLength);

    rebindLedgerToCurrentBytes();
    f.bundle = seal(f.root, f.bundleDir);

    await expect(create(f)).rejects.toThrow(/RVF index audit failed/i);
  });

  it('rejects private corpus bytes in the archive and post-seal archive byte drift', async () => {
    const privateFixture = await fixture();
    fs.writeFileSync(path.join(privateFixture.bundleDir, 'secret.big.rvf'), 'private-rvf');
    privateFixture.bundle = seal(privateFixture.root, privateFixture.bundleDir);
    await expect(create(privateFixture)).rejects.toThrow(/private store.*archive/i);

    const driftFixture = await fixture();
    await create(driftFixture);
    fs.appendFileSync(driftFixture.bundle, 'tampered');
    await expect(verifyCorpusReceipt({
      receiptFile: driftFixture.receiptFile,
      bundleFile: driftFixture.bundle,
    })).rejects.toThrow(/archive sha256/i);
  });

  it('rejects a schema-1 (downgraded) receipt outright', async () => {
    const f = await fixture();
    fs.writeFileSync(f.receiptFile, JSON.stringify({
      schemaVersion: 1, kind: 'ruvnet-brain-corpus-candidate', archive: { file: 'ruvnet-brain.zip', sha256: sha256(f.bundle), bytes: fs.statSync(f.bundle).size },
    }));
    await expect(verifyCorpusReceipt({ receiptFile: f.receiptFile, bundleFile: f.bundle }))
      .rejects.toThrow(/schema downgrade|unsupported corpus receipt/i);
  });

  it('rejects a receipt whose claimed store bytes were forged after creation (arbitrary passage binding)', async () => {
    const f = await fixture();
    const receipt = await create(f);
    const forged = structuredClone(receipt);
    forged.stores[0].files[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(f.receiptFile, JSON.stringify(forged));
    await expect(verifyCorpusReceipt({ receiptFile: f.receiptFile, bundleFile: f.bundle }))
      .rejects.toThrow(/does not match the exact corpus archive contents/i);
  });

  it('rejects inconsistent commits — expected builder SHA and SOURCE-vs-ledger drift', async () => {
    const f = await fixture();
    await create(f);
    await expect(verifyCorpusReceipt({
      receiptFile: f.receiptFile, bundleFile: f.bundle, expectedBuilderSha: 'd'.repeat(40),
    })).rejects.toThrow(/expected builder SHA/i);

    const g = await fixture();
    const sourceFile = path.join(g.bundleDir, 'SOURCE.json');
    const source = JSON.parse(fs.readFileSync(sourceFile));
    source.stores.alpha.sourceCommit = 'b'.repeat(40);
    fs.writeFileSync(sourceFile, JSON.stringify(source));
    g.bundle = seal(g.root, g.bundleDir);
    await expect(create(g)).rejects.toThrow(/SOURCE manifest sourceCommit/i);
  });

  it('rejects an archive that cannot be safely extracted (zip-slip / unsafe paths)', async () => {
    const f = await fixture();
    // kb/zip-extract.mjs (the shared safe extractor also proven in tests/unit/zip-extract.test.mjs)
    // refuses any entry that would escape the destination. Prove that createCorpusReceipt inherits
    // and surfaces that rejection rather than silently trusting whatever the extractor produced.
    const slipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-slip-'));
    dirs.push(slipDir);
    fs.writeFileSync(path.join(slipDir, 'evi'), 'evil payload');
    const slipZip = path.join(slipDir, 'slip.zip');
    execFileSync('zip', ['-q', slipZip, 'evi'], { cwd: slipDir });
    const bytes = fs.readFileSync(slipZip);
    const from = Buffer.from('evi');
    const to = Buffer.from('../evi');
    let hits = 0;
    for (let i = 0; i <= bytes.length - from.length; i += 1) {
      if (bytes.compare(from, 0, from.length, i, i + from.length) === 0) {
        to.copy(bytes, i);
        hits += 1;
      }
    }
    expect(hits, 'the fixture must actually contain a traversal name, or this test guards nothing').toBeGreaterThan(0);
    fs.writeFileSync(f.bundle, bytes);
    // Step 15: the detached accuracy report binds the archive's OUTER digest, so it has to be
    // rewritten for the traversal bytes — otherwise this would assert the accuracy binding rather
    // than the extractor rejection it exists to prove.
    writeAccuracyReport(f.bundle);
    // Same reason for the recall report: it is bound to the archive's OUTER digest and the blocking
    // gate reads it BEFORE extraction, so without rebinding this would assert the recall binding
    // rather than the extractor rejection it exists to prove.
    writeRecallReport(f.bundle);
    await expect(create(f)).rejects.toThrow(/cannot extract archive/i);
  });
});

describe('verifySeedBaseline — external content-addressed tag never compared to internal release tag', () => {
  it('verifies a seed whose external tag differs from the archive\'s internal ARCHIVE-MANIFEST release tag', async () => {
    const f = await fixture();
    const receipt = await create(f);
    // The fixture's archive was sealed with an internal releaseTag of v9.9.9 (see seal()),
    // deliberately unrelated to the external content-addressed seed tag below — proving these are
    // two independent identity domains, never compared against each other.
    expect(receipt.archiveManifestReleaseTag).toBe('v9.9.9');
    const tag = `corpus-sha256-${receipt.archive.sha256}`;
    expect(tag).not.toBe(receipt.archiveManifestReleaseTag);
    const verified = await verifySeedBaseline({
      seedDescriptor: { tag, sha256: receipt.archive.sha256, bytes: receipt.archive.bytes },
      bundleFile: f.bundle,
      receiptFile: f.receiptFile,
    });
    expect(verified).toMatchObject({ tag, sha256: receipt.archive.sha256, bytes: receipt.archive.bytes });
    expect(verified.receipt).toEqual(receipt);
  });

  it('rejects a seed descriptor whose sha256 does not match the actual downloaded bundle', async () => {
    const f = await fixture();
    await create(f);
    const tag = `corpus-sha256-${'0'.repeat(64)}`;
    await expect(verifySeedBaseline({
      seedDescriptor: { tag, sha256: '0'.repeat(64) },
      bundleFile: f.bundle,
      receiptFile: f.receiptFile,
    })).rejects.toThrow(/seed bundle sha256/i);
  });

  it('refuses a non-content-addressed tag unless explicitly pinned', async () => {
    const f = await fixture();
    const receipt = await create(f);
    const legacyPinnedTag = 'v4.2.1-dev'; // sync-version-ignore: today's real immutable legacy seed tag, not the candidate product version
    await expect(verifySeedBaseline({
      seedDescriptor: { tag: legacyPinnedTag, sha256: receipt.archive.sha256 },
      bundleFile: f.bundle,
      receiptFile: f.receiptFile,
    })).rejects.toThrow(/digest-derived tag/i);
    await expect(verifySeedBaseline({
      seedDescriptor: { tag: legacyPinnedTag, sha256: receipt.archive.sha256, allowPinnedTag: true },
      bundleFile: f.bundle,
      receiptFile: f.receiptFile,
    })).resolves.toMatchObject({ tag: legacyPinnedTag });
  });
});
