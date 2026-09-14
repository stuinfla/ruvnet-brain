// tests/unit/assemble-bundle.test.mjs — Step 5 of the corpus-seed/release pipeline consolidation
// (2026-09-13), remediated after Dual's independent review of 86cbe798 found the sealed-input
// boundary was a file-existence toggle: `if (fs.existsSync(receipt))` was the whole check, and the
// original fixture's `receiptSha256: 'unused-in-fixture'` proved nothing validated it. Every fixture
// here is now sealed by the REAL producer (tests/helpers/assemble-bundle-fixture.mjs), and the risky
// axis is tested directly: an external corpus with no seal, a tampered seal, coverage drift, the full
// seed path end to end, and a candidate-archive round-trip.
//
// The five properties Dual's review named as REQUIRED are still here (proofs 1-5), now against
// genuine seals rather than fake ones.
//
// assembleBundle is a real async function (no process.exit anywhere in it — only the CLI wrapper at
// the bottom of build-bundle.mjs exits), so it is imported and called directly here, in-process.
// Stores are genuine .big.rvf files written by the real @ruvector/rvf runtime (2 vectors each, far
// below the 1,024-vector HNSW threshold, so the index audit PASSes). NO NETWORK: assembleBundle is
// offline by construction (orgRepoCount is called with a disabled live probe — proven below), and
// the only subprocess is the real local `zip`/`unzip` this repo's own build already depends on.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { SELECTION_FILE, validateSelectionReceipt } from '../../scripts/public-inputs.mjs';
import { validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { extractZip } from '../../kb/zip-extract.mjs';
import {
  SEED_IDENTITY, buildCorpus, buildRuntimeRoot, commitFor, readJson, sha256File, tempDir, writeCoverage,
  writeProse, writeStore,
} from '../helpers/assemble-bundle-fixture.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const IDENTITY = { version: '7.7.7-fixture', sourceSnapshot: 'a'.repeat(40) };
const outDirFor = () => path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
const PROSE = {
  primers: { alpha: '# alpha primer\n\nThe real, sealed alpha primer body.\n' },
  l2: { 'alpha-topic': '# Alpha Topic\nSealed public L2 content.\n' },
  topics: { alpha: [{ slug: 'alpha-topic' }] },
  cards: '## alpha\nThe real, correct capability text.\n',
  aliases: { alpha: ['alpha-brain'] },
};

/** A STANDALONE kb: the checkout's own kb/ IS the corpus (assembleBundle's `--assets kb` default). */
async function writeStandaloneKb(runtimeRoot, stores) {
  const kb = path.join(runtimeRoot, 'kb');
  const ledgerStores = {};
  const updaterStores = {};
  for (const name of stores) {
    ledgerStores[name] = await writeStore(kb, name);
    updaterStores[name] = { kbName: name, canonicalBundleUrl: `https://example.invalid/${name}/bundle.zip` };
  }
  fs.writeFileSync(path.join(kb, 'RVF-GENERATIONS.json'), JSON.stringify({ schemaVersion: 1, brainVersion: '0.0.0', releaseTag: 'v0.0.0', stores: ledgerStores }));
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', canonicalManifestUrl: 'https://example.invalid/manifest.json', stores: updaterStores }));
  return kb;
}

describe('assembleBundle — required proof 1: supplied corpus bytes win EXCLUSIVELY', () => {
  it('never falls back to a poisoned checkout copy of SOURCE.json, capability-cards.md, a primer, ruv-gists.sources.json, or concepts.sources.json', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, {
      runtimeRoot, stores: ['alpha', 'ruv-gists', 'concepts'], derived: ['concepts'],
      overrides: {
        'ruv-gists.sources.json': JSON.stringify({ real: true, marker: 'genuine-ruv-gists-receipt' }),
        'concepts.sources.json': JSON.stringify({ real: true, marker: 'genuine-concepts-receipt' }),
      },
    });
    // The corpus is sealed. NOW poison every same-named file in the checkout.
    const kb = path.join(runtimeRoot, 'kb');
    fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builder: 'POISONED', canonicalManifestUrl: 'https://poisoned.invalid/manifest.json',
      stores: { alpha: { kbName: 'alpha', sourceCommit: 'f'.repeat(40), sourceRepo: 'https://poisoned.invalid/alpha' } } }));
    fs.writeFileSync(path.join(kb, 'capability-cards.md'), '## alpha\nPOISONED capability text that must never ship.\n');
    fs.writeFileSync(path.join(kb, 'alpha-primer.md'), '# alpha primer\n\nPOISONED primer body.\n');
    fs.writeFileSync(path.join(kb, 'ruv-gists.sources.json'), JSON.stringify({ poisoned: true }));
    fs.writeFileSync(path.join(kb, 'concepts.sources.json'), JSON.stringify({ poisoned: true }));
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores.sort()).toEqual(['alpha', 'concepts', 'ruv-gists']);
    const source = readJson(path.join(outDir, 'SOURCE.json'));
    expect(source.builder).toBe('rvf-kb-forge');
    expect(source.canonicalManifestUrl).toBe('https://example.invalid/manifest.json');
    expect(source.stores.alpha.sourceRepo).toBe('https://github.com/ruvnet/alpha');
    expect(source.stores.alpha.sourceCommit).toBe(commitFor('alpha'));
    expect(JSON.stringify(source)).not.toMatch(/POISON/i);
    for (const [file, sealed] of [['capability-cards.md', PROSE.cards], ['alpha-primer.md', PROSE.primers.alpha]]) {
      expect(fs.readFileSync(path.join(outDir, file), 'utf8')).toBe(sealed);
    }
    expect(readJson(path.join(outDir, 'ruv-gists.sources.json'))).toEqual({ real: true, marker: 'genuine-ruv-gists-receipt' });
    expect(readJson(path.join(outDir, 'concepts.sources.json'))).toEqual({ real: true, marker: 'genuine-concepts-receipt' });
  });
});

describe('assembleBundle — required proof 2: unchanged input hashes', () => {
  it('every corpus file in the archive — stores, sealed prose, and the receipt itself — is byte-identical to the corpus copy', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = outDirFor();

    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    const receipt = readJson(path.join(corpusDir, SELECTION_FILE));
    const sealedPaths = receipt.files.map((row) => row.path);
    expect(sealedPaths).toEqual(expect.arrayContaining(['alpha-primer.md', 'l2/alpha-topic.md', 'l2-topics.alpha.json', 'capability-cards.md', 'repo-aliases.json']));
    for (const name of ['alpha.big.rvf', 'alpha.big.rvf.idmap.json', 'alpha.big.rvf.embed.json', 'alpha.passages.jsonl',
      'alpha.meta.json', SELECTION_FILE, ...sealedPaths]) {
      expect(sha256File(path.join(outDir, name)), `${name} must be byte-identical to the corpus copy`)
        .toBe(sha256File(path.join(corpusDir, name)));
    }
  });
});

describe('assembleBundle — required proof 3: exact selected stores', () => {
  it('the assembled archive contains precisely the corpus-selected stores — no extra, no missing', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta', 'gamma'] });
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(fs.readdirSync(outDir).filter((f) => /\.big\.rvf$/.test(f)).sort()).toEqual(['alpha.big.rvf', 'beta.big.rvf', 'gamma.big.rvf']);
    expect(Object.keys(readJson(path.join(outDir, 'RVF-GENERATIONS.json')).stores).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(readJson(path.join(outDir, 'manifest.json')).builtRepos.map((r) => r.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('excludes a store the checkout private-store fence marks private, in every shipped artifact', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { privateStores: ['secret'] });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'secret'] });
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores).toEqual(['alpha']);
    expect(fs.existsSync(path.join(outDir, 'secret.big.rvf'))).toBe(false);
    expect(readJson(path.join(outDir, 'manifest.json')).builtRepos.map((r) => r.name)).not.toContain('secret');
    expect(Object.keys(readJson(path.join(outDir, 'SOURCE.json')).stores)).toEqual(['alpha']);
  });
});

describe('assembleBundle — required proof 4: consistent explicit version, no silent checkout fallback', () => {
  it('the explicit identity appears everywhere it is supposed to, never a different value read from the checkout', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = outDirFor();
    // A fabricated identity, derived into variables (never repeated as literals in the assertions)
    // so this file itself never restates the one fact it proves is derived.
    const explicitTag = `v9.${Date.now() % 1000}.1-explicit`;
    const { stripTag, getVersionTag } = await import('../../scripts/version.mjs');
    const bareVersion = stripTag(explicitTag);
    const identity = { version: explicitTag, sourceSnapshot: 'b'.repeat(40) };

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity });

    expect(result.archiveManifest.version).toBe(bareVersion);
    expect(result.archiveManifest.releaseTag).toBe(explicitTag);
    const source = readJson(path.join(outDir, 'SOURCE.json'));
    expect(source.brainVersion).toBe(bareVersion);
    expect(source.releaseTag).toBe(explicitTag);
    const ledger = readJson(path.join(outDir, 'RVF-GENERATIONS.json'));
    expect(ledger.brainVersion).toBe(bareVersion);
    expect(ledger.releaseTag).toBe(explicitTag);
    expect(ledger.sourceSnapshot).toBe(identity.sourceSnapshot);
    expect(readJson(path.join(outDir, 'manifest.json')).brainVersion).toBe(bareVersion);
    expect(fs.readFileSync(path.join(outDir, 'README.md'), 'utf8')).toContain(`# RuvNet Brain — ${explicitTag}`);
    const realTag = getVersionTag();
    expect(realTag).not.toBe(explicitTag);
    expect(JSON.stringify(result.archiveManifest)).not.toContain(realTag);
    expect(JSON.stringify(source)).not.toContain(realTag);
  });
});

describe('assembleBundle — required proof 5: one ZIP invocation', () => {
  it('scripts/build-bundle.mjs contains exactly one zip-creation call site', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/build-bundle.mjs'), 'utf8');
    expect(src.match(/spawnSync\(\s*'zip'/g) || []).toHaveLength(1);
  });

  it('one call to assembleBundle produces the release archive exactly once, at the expected path, offline', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = outDirFor();
    const zipFile = `${outDir}.zip`;
    expect(fs.existsSync(zipFile)).toBe(false);

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.zipFile).toBe(zipFile);
    expect(fs.existsSync(zipFile)).toBe(true);
    expect(readJson(path.join(outDir, 'ARCHIVE-MANIFEST.json')).fileCount).toBe(result.archiveManifest.fileCount);
    // Fix 9: never a live GitHub probe — the org total is the committed record or honestly unknown.
    expect(['recorded', 'unknown']).toContain(readJson(path.join(outDir, 'manifest.json')).coverage.orgTotalSource);
  });
});

describe('assembleBundle — the sealed-input boundary is a verified seal, not a file-existence toggle', () => {
  it('(8a) an EXTERNAL corpus with no selection receipt is rejected and never self-materialized into', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'], seal: false });
    const before = fs.readdirSync(corpusDir).sort();
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/carries no sealed public-input selection/);
    // Untouched: no receipt was written into it, no prose was copied in from the checkout.
    expect(fs.readdirSync(corpusDir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(corpusDir, 'alpha-primer.md'))).toBe(false);
  });

  it('(8a) a STANDALONE kb (corpus === runtimeRoot/kb) with no receipt succeeds via fresh materialization', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const kb = await writeStandaloneKb(runtimeRoot, ['alpha']);
    expect(fs.existsSync(path.join(kb, SELECTION_FILE))).toBe(false);
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir: kb, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores).toEqual(['alpha']);
    expect(fs.existsSync(path.join(kb, SELECTION_FILE))).toBe(true);
    expect(() => validateSelectionReceipt({ receipt: readJson(path.join(kb, SELECTION_FILE)), dir: kb })).not.toThrow();
    expect(fs.readFileSync(path.join(outDir, 'alpha-primer.md'), 'utf8')).toBe(PROSE.primers.alpha);
    expect(sha256File(path.join(outDir, SELECTION_FILE))).toBe(sha256File(path.join(kb, SELECTION_FILE)));
  });

  it('(fix 4) a STANDALONE kb never trusts a receipt already sitting in it: the stale receipt cannot flip the toggle', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const kb = await writeStandaloneKb(runtimeRoot, ['alpha']);
    // A stale-but-well-formed receipt from an earlier round that sealed DIFFERENT prose.
    const earlier = await buildCorpus(dirs, { runtimeRoot: buildRuntimeRoot(dirs, { prose: { primers: { alpha: 'STALE earlier primer\n' } } }), stores: ['alpha'] });
    fs.copyFileSync(path.join(earlier, SELECTION_FILE), path.join(kb, SELECTION_FILE));
    const staleReceipt = readJson(path.join(kb, SELECTION_FILE));
    const outDir = outDirFor();

    await assembleBundle({ corpusDir: kb, runtimeRoot, outDir, identity: IDENTITY });

    // Re-materialized from the CURRENT checkout prose; the stale receipt was replaced, not trusted.
    expect(fs.readFileSync(path.join(outDir, 'alpha-primer.md'), 'utf8')).toBe(PROSE.primers.alpha);
    expect(readJson(path.join(kb, SELECTION_FILE)).receiptSha256).not.toBe(staleReceipt.receiptSha256);
  });

  it('(8b) a tampered receipt is rejected on read: wrong digest, empty object, missing sealed file, changed bytes, unsealed managed file', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const build = async (tamper) => {
      const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
      tamper(corpusDir);
      return assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY });
    };
    const receiptFile = (corpusDir) => path.join(corpusDir, SELECTION_FILE);
    await expect(build((c) => {
      const receipt = readJson(receiptFile(c));
      receipt.receiptSha256 = 'a'.repeat(64);
      fs.writeFileSync(receiptFile(c), JSON.stringify(receipt));
    })).rejects.toThrow(/receiptSha256 does not match/);
    // Dual's exact case: `{}` used to take the trusted branch through the `excluded || {...}` default.
    await expect(build((c) => fs.writeFileSync(receiptFile(c), '{}'))).rejects.toThrow(/kind is undefined/);
    await expect(build((c) => fs.rmSync(path.join(c, 'alpha-primer.md')))).rejects.toThrow(/sealed file alpha-primer\.md is missing/);
    await expect(build((c) => fs.appendFileSync(path.join(c, 'alpha-primer.md'), 'tampered'))).rejects.toThrow(/alpha-primer\.md bytes differ/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'rogue-primer.md'), '# unsealed prose riding along\n')))
      .rejects.toThrow(/not sealed by the receipt.*rogue-primer\.md/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'l2', 'rogue.md'), '# unsealed l2 article\n')))
      .rejects.toThrow(/not sealed by the receipt.*l2\/rogue\.md/);
  });
});

describe('assembleBundle — coverage is a sealed input bound to THIS corpus', () => {
  it('(8c) the full seed path: createReleaseProjection and bindAssembledReleaseProjection run end to end from assembleBundle', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    const coverage = writeCoverage(runtimeRoot, corpusDir);
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: SEED_IDENTITY });

    expect(result.projection).not.toBeNull();
    for (const file of ['COVERAGE.json', 'CORPUS-COVERAGE.json', 'PUBLIC-RVF-GENERATIONS.json', 'RVF-GENERATIONS.json']) {
      expect(fs.existsSync(path.join(outDir, file)), file).toBe(true);
    }
    const release = readJson(path.join(outDir, 'COVERAGE.json'));
    expect(release.kind).toBe('ruvnet-brain-release-coverage');
    expect(release.corpusSeed.tag).toBe(SEED_IDENTITY.tag);
    expect(release.releaseIdentity).toEqual({ version: IDENTITY.version, tag: `v${IDENTITY.version}`, sourceSnapshot: IDENTITY.sourceSnapshot });
    // Algorithm step 9, through the real path: rows/totals arrive UNCHANGED from the sealed coverage.
    expect(release.rows).toEqual(coverage.rows);
    expect(release.totals).toEqual(coverage.totals);
    expect(readJson(path.join(outDir, 'CORPUS-COVERAGE.json'))).toEqual(coverage);
    expect(readJson(path.join(outDir, 'PUBLIC-RVF-GENERATIONS.json')).kind).toBe('ruvnet-brain-public-generation-ledger');
    expect(readJson(path.join(outDir, 'RVF-GENERATIONS.json')).kind).toBe('ruvnet-brain-runtime-generation-ledger');
    // The independent activation-boundary reader agrees with everything assembleBundle wrote.
    const directory = validateCoverageDirectory(outDir, { expectedVersion: IDENTITY.version, expectedSourceSnapshot: IDENTITY.sourceSnapshot });
    expect(directory.failures).toEqual([]);
    expect(directory.valid).toBe(true);
  });

  it('(fix 6) a PARTIAL seed identity is rejected before any output is written, never downgraded to a non-release build', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusDir);
    const outDir = outDirFor();
    const { baselineReceiptSha256: _dropped, ...partial } = SEED_IDENTITY;
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: partial }))
      .rejects.toThrow(/seed identity is incomplete or malformed/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('(8d) coverage drift is rejected: corpus RVF rebuilt after the coverage was sealed', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusDir);
    // The corpus moves on: alpha is rebuilt with different bytes and its ledger row updated, so the
    // corpus is internally consistent — but the sealed coverage measured the OLD bytes.
    const rvfPath = path.join(corpusDir, 'alpha.big.rvf');
    fs.rmSync(rvfPath); fs.rmSync(`${rvfPath}.idmap.json`);
    const { createRequire } = await import('node:module');
    const { RvfDatabase } = createRequire(new URL('../../kb/package.json', import.meta.url))('@ruvector/rvf');
    const db = await RvfDatabase.create(rvfPath, { dimensions: 3, metric: 'cosine' });
    await db.ingestBatch([{ id: 'v-0', vector: [1, 0, 0] }, { id: 'v-1', vector: [0, 1, 0] }, { id: 'v-2', vector: [0, 0, 1] }]);
    await db.close();
    const ledgerFile = path.join(corpusDir, 'RVF-GENERATIONS.json');
    const ledger = readJson(ledgerFile);
    ledger.stores.alpha = { ...ledger.stores.alpha, sha256: sha256File(rvfPath), bytes: fs.statSync(rvfPath).size };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));

    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/measured against different alpha RVF bytes/);
  });

  it('(8d) coverage drift is rejected: a store the coverage names is absent, a store on disk is unclassified, or the coverage digest is broken', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const ghostRow = (rows) => rows.push({ ...rows[0], key: 'repo:ruvnet/ghost', name: 'ghost', url: 'https://github.com/ruvnet/ghost', artifact: { ...rows[0].artifact, store: 'ghost' } });
    const corpusA = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusA, { mutate: ghostRow });
    await expect(assembleBundle({ corpusDir: corpusA, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/does not match its sealed coverage/);

    const corpusB = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    writeCoverage(runtimeRoot, corpusB, { mutate: (rows) => rows.splice(rows.findIndex((row) => row.name === 'beta'), 1) });
    await expect(assembleBundle({ corpusDir: corpusB, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/does not match its sealed coverage/);

    const corpusC = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusC);
    const coverageFile = path.join(runtimeRoot, 'data', 'source-coverage.json');
    const coverage = readJson(coverageFile);
    coverage.rows[0].status = 'STALE'; // edited after sealing: the generation digest no longer recomputes
    fs.writeFileSync(coverageFile, JSON.stringify(coverage));
    await expect(assembleBundle({ corpusDir: corpusC, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/sealed corpus coverage is invalid/);
  });
});

describe('assembleBundle — corpus SOURCE.json and public-store-classes.json fail loud (fix 6)', () => {
  it('rejects a corpus with no SOURCE.json, an unparseable one, or a repository store with no updater entry', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const build = async (tamper) => {
      const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
      tamper(corpusDir);
      return assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY });
    };
    await expect(build((c) => fs.rmSync(path.join(c, 'SOURCE.json')))).rejects.toThrow(/corpus SOURCE\.json is missing/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'SOURCE.json'), '{ not json'))).rejects.toThrow(/corpus SOURCE\.json is unreadable/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', stores: {} }))))
      .rejects.toThrow(/alpha: sealed corpus SOURCE\.json carries no updater entry/);
  });

  it('rejects an external corpus with no public-store-classes.json, an unparseable one, and a standalone kb whose concepts store cannot be classified', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const external = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    fs.rmSync(path.join(external, 'public-store-classes.json'));
    await expect(assembleBundle({ corpusDir: external, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/carries no public-store-classes\.json/);

    const corrupt = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    fs.writeFileSync(path.join(corrupt, 'public-store-classes.json'), '{ nope');
    await expect(assembleBundle({ corpusDir: corrupt, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/public-store-classes\.json is present but unreadable/);

    const kb = await writeStandaloneKb(runtimeRoot, ['alpha', 'concepts']);
    await expect(assembleBundle({ corpusDir: kb, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/concepts store is present but public-store-classes\.json is missing/);
  });

  it('keeps every per-store updater field the corpus recorded (updateManaged, a per-store releaseTag) while binding identity from the ledger', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const sourceFile = path.join(corpusDir, 'SOURCE.json');
    const source = readJson(sourceFile);
    source.stores.alpha = { ...source.stores.alpha, updateManaged: false, releaseTag: 'v0.0.1-store', sourceCommit: 'f'.repeat(40) };
    fs.writeFileSync(sourceFile, JSON.stringify(source));
    const outDir = outDirFor();

    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    const shipped = readJson(path.join(outDir, 'SOURCE.json')).stores.alpha;
    expect(shipped.updateManaged).toBe(false);
    expect(shipped.releaseTag).toBe('v0.0.1-store');
    expect(shipped.canonicalBundleUrl).toBe('https://example.invalid/alpha/bundle.zip');
    expect(shipped.sourceCommit).toBe(commitFor('alpha')); // the ledger's generation wins over the stale SOURCE copy
  });
});

describe('assembleBundle — candidate archive round-trip', () => {
  it('(8e) an assembled archive re-assembles from its own extracted bytes and preserves the selection receipt byte-for-byte', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outA = outDirFor();
    const first = await assembleBundle({ corpusDir, runtimeRoot, outDir: outA, identity: IDENTITY });

    const extracted = tempDir(dirs, 'extracted');
    await extractZip(first.zipFile, extracted);
    // The extracted archive IS a corpus: it carries its receipt, its sealed prose, its ledger, and
    // its updater configuration — so it re-assembles with nothing re-derived.
    const outB = outDirFor();
    const second = await assembleBundle({ corpusDir: extracted, runtimeRoot, outDir: outB, identity: IDENTITY });

    expect(second.selectedStores).toEqual(first.selectedStores);
    for (const name of [SELECTION_FILE, 'alpha.big.rvf', 'alpha-primer.md', 'capability-cards.md', 'l2/alpha-topic.md']) {
      expect(sha256File(path.join(outB, name)), name).toBe(sha256File(path.join(corpusDir, name)));
    }
    expect(fs.readFileSync(path.join(outB, SELECTION_FILE))).toEqual(fs.readFileSync(path.join(outA, SELECTION_FILE)));
  });
});
