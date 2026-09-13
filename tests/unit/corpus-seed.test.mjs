import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createCorpusReceipt,
  verifyCorpusReceipt,
  verifySeedBaseline,
} from '../../scripts/corpus-candidate.mjs';
import {
  corpusSeedTag,
  publishCorpusSeed,
} from '../../scripts/corpus-seed-publish.mjs';

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createArchive(bundle, bundleRoot) {
  if (fs.existsSync(bundle)) fs.rmSync(bundle);
  if (process.platform === 'win32') {
    const escapedRoot = bundleRoot.replaceAll("'", "''");
    const escapedBundle = bundle.replaceAll("'", "''");
    return execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${escapedRoot}' -DestinationPath '${escapedBundle}' -Force`,
    ], { encoding: 'utf8' });
  }
  return execFileSync('zip', ['-qr', bundle, 'ruvnet-brain'], { cwd: path.dirname(bundleRoot), encoding: 'utf8' });
}

// Rebuild ARCHIVE-MANIFEST.json from the exact bytes present in bundleDir right now (mirrors
// scripts/build-bundle.mjs's own manifest assembly), then seal a fresh zip over it. Every mutation
// test in this file mutates bundleDir *before* calling seal(), so the manifest and the zip it seals
// are always mutually consistent — exactly like the real builder.
function seal(root, bundleDir) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === 'ARCHIVE-MANIFEST.json') continue;
      const full = path.join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full, relative);
      else files.push({ path: relative, sha256: sha256(full), bytes: stat.size });
    }
  };
  walk(bundleDir);
  const manifest = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-archive-manifest',
    version: '9.9.9',
    releaseTag: 'v9.9.9',
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
  fs.writeFileSync(path.join(bundleDir, 'ARCHIVE-MANIFEST.json'), JSON.stringify(manifest, null, 2));
  const bundle = path.join(path.dirname(path.dirname(bundleDir)), 'ruvnet-brain.zip');
  createArchive(bundle, bundleDir);
  return bundle;
}

const SOURCE_COMMIT = 'a'.repeat(40);

function buildAssets(root) {
  const bundleDir = path.join(root, 'bundle', 'ruvnet-brain');
  fs.mkdirSync(bundleDir, { recursive: true });
  const publicFiles = {
    'alpha.big.rvf': 'rvf-alpha',
    'alpha.big.rvf.idmap.json': '{"ids":[1]}',
    'alpha.big.rvf.embed.json': '{"model":"local"}',
    'alpha.passages.jsonl': '{"text":"alpha"}\n',
    'alpha.meta.json': '{"dimensions":384}',
  };
  for (const [name, body] of Object.entries(publicFiles)) fs.writeFileSync(path.join(bundleDir, name), body);
  fs.writeFileSync(path.join(bundleDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
  fs.writeFileSync(path.join(bundleDir, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1,
    brainVersion: '9.9.9',
    releaseTag: 'v9.9.9',
    stores: {
      alpha: {
        file: 'alpha.big.rvf',
        sha256: sha256(path.join(bundleDir, 'alpha.big.rvf')),
        bytes: fs.statSync(path.join(bundleDir, 'alpha.big.rvf')).size,
        model: 'local',
        dimensions: 384,
        sourceCommit: SOURCE_COMMIT,
        builtUtc: '2026-08-21T12:00:00.000Z',
      },
    },
  }));
  fs.writeFileSync(path.join(bundleDir, 'SOURCE.json'), JSON.stringify({
    builder: 'rvf-kb-forge',
    stores: { alpha: { sourceCommit: SOURCE_COMMIT } },
  }));
  fs.writeFileSync(path.join(bundleDir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  return bundleDir;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-seed-'));
  dirs.push(root);
  const bundleDir = buildAssets(root);
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

describe('immutable corpus candidate receipt (schema 2)', () => {
  it('creates and verifies a receipt binding every public store, sidecar, fence, and archive byte', async () => {
    const f = fixture();
    const receipt = await create(f);

    expect(receipt).toMatchObject({
      schemaVersion: 2,
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
      const f = fixture();
      mutate(f);
      await expect(create(f)).rejects.toThrow(expected[index]);
    }
  });

  it('rejects private corpus bytes in the archive and post-seal archive byte drift', async () => {
    const privateFixture = fixture();
    fs.writeFileSync(path.join(privateFixture.bundleDir, 'secret.big.rvf'), 'private-rvf');
    privateFixture.bundle = seal(privateFixture.root, privateFixture.bundleDir);
    await expect(create(privateFixture)).rejects.toThrow(/private store.*archive/i);

    const driftFixture = fixture();
    await create(driftFixture);
    fs.appendFileSync(driftFixture.bundle, 'tampered');
    await expect(verifyCorpusReceipt({
      receiptFile: driftFixture.receiptFile,
      bundleFile: driftFixture.bundle,
    })).rejects.toThrow(/archive sha256/i);
  });

  it('rejects a schema-1 (downgraded) receipt outright', async () => {
    const f = fixture();
    fs.writeFileSync(f.receiptFile, JSON.stringify({
      schemaVersion: 1, kind: 'ruvnet-brain-corpus-candidate', archive: { file: 'ruvnet-brain.zip', sha256: sha256(f.bundle), bytes: fs.statSync(f.bundle).size },
    }));
    await expect(verifyCorpusReceipt({ receiptFile: f.receiptFile, bundleFile: f.bundle }))
      .rejects.toThrow(/schema downgrade|unsupported corpus receipt/i);
  });

  it('rejects a receipt whose claimed store bytes were forged after creation (arbitrary passage binding)', async () => {
    const f = fixture();
    const receipt = await create(f);
    const forged = structuredClone(receipt);
    forged.stores[0].files[0].sha256 = 'f'.repeat(64);
    fs.writeFileSync(f.receiptFile, JSON.stringify(forged));
    await expect(verifyCorpusReceipt({ receiptFile: f.receiptFile, bundleFile: f.bundle }))
      .rejects.toThrow(/does not match the exact corpus archive contents/i);
  });

  it('rejects inconsistent commits — expected builder SHA and SOURCE-vs-ledger drift', async () => {
    const f = fixture();
    await create(f);
    await expect(verifyCorpusReceipt({
      receiptFile: f.receiptFile, bundleFile: f.bundle, expectedBuilderSha: 'd'.repeat(40),
    })).rejects.toThrow(/expected builder SHA/i);

    const g = fixture();
    const sourceFile = path.join(g.bundleDir, 'SOURCE.json');
    const source = JSON.parse(fs.readFileSync(sourceFile));
    source.stores.alpha.sourceCommit = 'b'.repeat(40);
    fs.writeFileSync(sourceFile, JSON.stringify(source));
    g.bundle = seal(g.root, g.bundleDir);
    await expect(create(g)).rejects.toThrow(/SOURCE manifest sourceCommit/i);
  });

  it('rejects an archive that cannot be safely extracted (zip-slip / unsafe paths)', async () => {
    const f = fixture();
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
    await expect(create(f)).rejects.toThrow(/cannot extract archive/i);
  });
});

describe('verifySeedBaseline — external content-addressed tag never compared to internal release tag', () => {
  it('verifies a seed whose external tag differs from the archive\'s internal ARCHIVE-MANIFEST release tag', async () => {
    const f = fixture();
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
    const f = fixture();
    await create(f);
    const tag = `corpus-sha256-${'0'.repeat(64)}`;
    await expect(verifySeedBaseline({
      seedDescriptor: { tag, sha256: '0'.repeat(64) },
      bundleFile: f.bundle,
      receiptFile: f.receiptFile,
    })).rejects.toThrow(/seed bundle sha256/i);
  });

  it('refuses a non-content-addressed tag unless explicitly pinned', async () => {
    const f = fixture();
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

describe('immutable corpus seed publishing', () => {
  it('derives the tag from the archive digest and refuses to overwrite an existing release', async () => {
    const f = fixture();
    const receipt = await create(f);
    const tag = corpusSeedTag(receipt);
    expect(tag).toBe(`corpus-sha256-${receipt.archive.sha256}`);

    const run = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    await expect(publishCorpusSeed({
      receiptFile: f.receiptFile,
      bundleFile: f.bundle,
      run,
    }))
      .rejects.toThrow(/already exists.*refusing to overwrite/i);
    expect(run).toHaveBeenCalledWith('gh', ['release', 'view', tag, '--json', 'tagName'], expect.any(Object));
  });

  it('hands a new digest-tagged prerelease to the repository\'s sole release authority', async () => {
    const f = fixture();
    const receipt = await create(f);
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      if (args[1] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: 'created', stderr: '' };
    };

    await expect(publishCorpusSeed({
      receiptFile: f.receiptFile,
      bundleFile: f.bundle,
      run,
    }))
      .resolves.toMatchObject({ tag: corpusSeedTag(receipt), archiveSha256: receipt.archive.sha256 });
    expect(calls[1]).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining([
        expect.stringMatching(/[\\/]scripts[\\/]release\.mjs$/),
        '--corpus-seed',
        '--corpus-tag', corpusSeedTag(receipt),
        '--corpus-bundle', f.bundle,
        '--corpus-receipt', f.receiptFile,
        '--target', receipt.builderSourceSha,
      ]),
    });
    expect(calls[1].args.join(' ')).not.toMatch(/release create|--clobber/);
  });
});
