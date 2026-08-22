import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createCorpusReceipt,
  verifyCorpusReceipt,
} from '../../scripts/corpus-candidate.mjs';
import {
  corpusSeedTag,
  publishCorpusSeed,
} from '../../scripts/corpus-seed-publish.mjs';
import { getVersion, getVersionTag } from '../../scripts/version.mjs';
import { writeStoredDirectoryZip, writeStoredZip } from '../helpers/zip-fixture.mjs';

const dirs = [];
const CORPUS_CANDIDATE = path.resolve(import.meta.dirname, '../../scripts/corpus-candidate.mjs');
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-seed-'));
  dirs.push(root);
  const assetsDir = path.join(root, 'assets');
  const bundleDir = path.join(root, 'bundle', 'ruvnet-brain');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(bundleDir, { recursive: true });
  const publicFiles = {
    'alpha.big.rvf': 'rvf-alpha',
    'alpha.big.rvf.idmap.json': '{"ids":[1]}',
    'alpha.big.rvf.embed.json': '{"model":"local"}',
    'alpha.big.passages.jsonl': '{"text":"alpha big"}\n',
    'alpha.big.meta.json': '{"dimensions":384,"variant":"big"}',
    'alpha.passages.jsonl': '{"text":"alpha"}\n',
    'alpha.meta.json': '{"dimensions":384}',
  };
  for (const [name, body] of Object.entries(publicFiles)) {
    fs.writeFileSync(path.join(assetsDir, name), body);
    fs.writeFileSync(path.join(bundleDir, name), body);
  }
  fs.writeFileSync(path.join(assetsDir, 'secret.big.rvf'), 'private-rvf');
  fs.writeFileSync(path.join(assetsDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
  fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1,
    brainVersion: getVersion(),
    releaseTag: getVersionTag(),
    stores: {
      alpha: {
        file: 'alpha.big.rvf',
        sha256: sha256(path.join(assetsDir, 'alpha.big.rvf')),
        bytes: fs.statSync(path.join(assetsDir, 'alpha.big.rvf')).size,
        model: 'local',
        dimensions: 384,
        sourceCommit: 'a'.repeat(40),
        builtUtc: '2026-08-21T12:00:00.000Z',
      },
      secret: {
        file: 'secret.big.rvf',
        sha256: sha256(path.join(assetsDir, 'secret.big.rvf')),
        bytes: fs.statSync(path.join(assetsDir, 'secret.big.rvf')).size,
        model: 'local',
        dimensions: 384,
        sourceCommit: 'b'.repeat(40),
        builtUtc: '2026-08-21T12:00:00.000Z',
      },
    },
  }));
  const policyFile = path.join(root, 'coverage-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify({
    schemaVersion: 1,
    coverageGeneration: 'coverage-2026-08-21',
    sourceObservationSha256: 'd'.repeat(64),
    rows: [{ key: 'repo:alpha', kind: 'repository', name: 'alpha', disposition: 'eligible',
      status: 'CURRENT', artifact: { store: 'alpha' } }],
  }));
  fs.writeFileSync(path.join(assetsDir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  const bundle = path.join(root, 'ruvnet-brain.zip');
  writeStoredDirectoryZip({ archiveFile: bundle, sourceDir: bundleDir, rootName: 'ruvnet-brain' });
  return {
    root,
    assetsDir,
    bundleDir,
    bundle,
    policyFile,
    receiptFile: path.join(root, 'corpus-receipt.json'),
  };
}

function create(f) {
  return createCorpusReceipt({
    assetsDir: f.assetsDir,
    bundleFile: f.bundle,
    policyFile: f.policyFile,
    receiptFile: f.receiptFile,
    builderSourceSha: 'c'.repeat(40),
    createdAt: '2026-08-21T12:34:56.000Z',
  });
}

describe('immutable corpus candidate receipt', () => {
  it('creates and verifies a receipt binding every public store, sidecar, fence, policy, and archive byte', async () => {
    const f = fixture();
    const receipt = await create(f);

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      kind: 'ruvnet-brain-corpus-candidate',
      builderSourceSha: 'c'.repeat(40),
      coverageGeneration: 'coverage-2026-08-21',
      storeCount: 1,
      excludedPrivateStores: ['secret'],
      duplicateRvfDigests: [],
      unreceiptedRvfFiles: [],
      missingSidecars: [],
      publicInventory: {
        repositories: ['alpha'],
        gistAggregate: null,
        derived: [],
        publicStores: ['alpha'],
      },
    });
    expect(receipt.publicInventory.partitionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.finalBytePartitionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.privateFence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.eligibilityPolicy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.stores[0].files).toHaveLength(7);
    await expect(verifyCorpusReceipt({
      receiptFile: f.receiptFile,
      assetsDir: f.assetsDir,
      bundleFile: f.bundle,
      policyFile: f.policyFile,
    })).resolves.toEqual(receipt);
  });

  it('excludes policy-ineligible local evidence and rejects it if it enters the archive', async () => {
    const f = fixture();
    for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
      fs.writeFileSync(path.join(f.assetsDir, `excluded${suffix}`), `excluded${suffix}`);
    }
    const ledgerFile = path.join(f.assetsDir, 'RVF-GENERATIONS.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile));
    ledger.stores.excluded = { file: 'excluded.big.rvf', sha256: sha256(path.join(f.assetsDir, 'excluded.big.rvf')),
      bytes: fs.statSync(path.join(f.assetsDir, 'excluded.big.rvf')).size, model: 'local', dimensions: 384,
      sourceCommit: 'e'.repeat(40), builtUtc: '2026-08-21T12:00:00.000Z' };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    const policy = JSON.parse(fs.readFileSync(f.policyFile));
    policy.rows.push({ key: 'repo:excluded', kind: 'repository', name: 'excluded',
      disposition: 'excluded-no-corpus', status: 'INELIGIBLE', artifact: { store: 'excluded' } });
    fs.writeFileSync(f.policyFile, JSON.stringify(policy));

    const receipt = await create(f);
    expect(receipt.storeCount).toBe(1);
    expect(receipt.publicInventory.excludedRepositories).toEqual(['excluded']);

    fs.copyFileSync(path.join(f.assetsDir, 'excluded.meta.json'), path.join(f.bundleDir, 'excluded.meta.json'));
    writeStoredDirectoryZip({ archiveFile: f.bundle, sourceDir: f.bundleDir, rootName: 'ruvnet-brain' });
    await expect(create(f)).rejects.toThrow(/unclassified archive store.*excluded/i);
    fs.rmSync(path.join(f.bundleDir, 'excluded.meta.json'));

    fs.copyFileSync(path.join(f.assetsDir, 'excluded.big.rvf'), path.join(f.bundleDir, 'excluded.big.rvf'));
    writeStoredDirectoryZip({ archiveFile: f.bundle, sourceDir: f.bundleDir, rootName: 'ruvnet-brain' });
    await expect(create(f)).rejects.toThrow(/unclassified archive store.*excluded/i);
  });

  it('fails closed for unreceipted RVFs, missing sidecars, duplicate RVFs, and orphan ledger rows', async () => {
    const mutations = [
      (f) => fs.writeFileSync(path.join(f.assetsDir, 'orphan.big.rvf'), 'orphan'),
      (f) => fs.rmSync(path.join(f.assetsDir, 'alpha.meta.json')),
      (f) => {
        for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.copyFileSync(path.join(f.assetsDir, `alpha${suffix}`), path.join(f.assetsDir, `beta${suffix}`));
        }
        const ledgerFile = path.join(f.assetsDir, 'RVF-GENERATIONS.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerFile));
        ledger.stores.beta = { ...ledger.stores.alpha, file: 'beta.big.rvf' };
        fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
      },
      (f) => {
        const ledgerFile = path.join(f.assetsDir, 'RVF-GENERATIONS.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerFile));
        ledger.stores.ghost = { ...ledger.stores.alpha, file: 'ghost.big.rvf' };
        fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
      },
    ];
    const expected = [/unreceipted/i, /missing sidecars/i, /duplicate RVF/i, /ledger rows without RVFs/i];
    for (const [index, mutate] of mutations.entries()) {
      const f = fixture();
      mutate(f);
      await expect(create(f)).rejects.toThrow(expected[index]);
    }
  });

  it('rejects private corpus bytes in the archive and any post-receipt byte or policy drift', async () => {
    const privateFixture = fixture();
    const archiveRoot = path.join(privateFixture.root, 'bundle', 'ruvnet-brain');
    fs.writeFileSync(path.join(archiveRoot, 'secret.big.rvf'), 'private-rvf');
    writeStoredDirectoryZip({
      archiveFile: privateFixture.bundle,
      sourceDir: archiveRoot,
      rootName: 'ruvnet-brain',
    });
    await expect(create(privateFixture)).rejects.toThrow(/private store.*archive/i);

    const driftFixture = fixture();
    await create(driftFixture);
    fs.appendFileSync(driftFixture.bundle, 'tampered');
    await expect(verifyCorpusReceipt({
      receiptFile: driftFixture.receiptFile,
      assetsDir: driftFixture.assetsDir,
      bundleFile: driftFixture.bundle,
      policyFile: driftFixture.policyFile,
    })).rejects.toThrow(/archive sha256/i);

    const policyFixture = fixture();
    await create(policyFixture);
    fs.appendFileSync(policyFixture.policyFile, '\n');
    await expect(verifyCorpusReceipt({
      receiptFile: policyFixture.receiptFile,
      assetsDir: policyFixture.assetsDir,
      bundleFile: policyFixture.bundle,
      policyFile: policyFixture.policyFile,
    })).rejects.toThrow(/eligibility policy/i);
  });

  it('fails candidate sealing for stale, private-colliding, or unclassified public stores', async () => {
    const stale = fixture();
    const stalePolicy = JSON.parse(fs.readFileSync(stale.policyFile));
    stalePolicy.rows[0].status = 'STALE';
    fs.writeFileSync(stale.policyFile, JSON.stringify(stalePolicy));
    await expect(create(stale)).rejects.toThrow(/eligible repository is not CURRENT/i);

    const collision = fixture();
    fs.writeFileSync(path.join(collision.assetsDir, 'PRIVATE-STORES.json'),
      JSON.stringify({ privateStores: ['alpha', 'secret'] }));
    await expect(create(collision)).rejects.toThrow(/private\/public store collision.*alpha/i);

    const extra = fixture();
    const ledgerFile = path.join(extra.assetsDir, 'RVF-GENERATIONS.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerFile));
    for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
      fs.writeFileSync(path.join(extra.assetsDir, `beta${suffix}`), `beta${suffix}`);
    }
    ledger.stores.beta = {
      file: 'beta.big.rvf',
      sha256: sha256(path.join(extra.assetsDir, 'beta.big.rvf')),
      bytes: fs.statSync(path.join(extra.assetsDir, 'beta.big.rvf')).size,
      model: 'local', dimensions: 384, sourceCommit: 'e'.repeat(40), builtUtc: '2026-08-21T12:00:00.000Z',
    };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    await expect(create(extra)).rejects.toThrow(/unclassified public stores.*beta/i);
  });

  it('rejects classification-evidence byte drift after the candidate receipt is sealed', async () => {
    const f = fixture();
    await create(f);
    fs.appendFileSync(path.join(f.assetsDir, 'public-store-classes.json'), '\n');
    await expect(verifyCorpusReceipt({
      receiptFile: f.receiptFile,
      assetsDir: f.assetsDir,
      bundleFile: f.bundle,
      policyFile: f.policyFile,
    })).rejects.toThrow(/receipt does not match the exact corpus inputs/i);
  });

  it('rejects duplicate required filenames even when both entries extract successfully', async () => {
    const f = fixture();
    const entries = fs.readdirSync(f.bundleDir).sort().map((name) => ({
      name: `ruvnet-brain/${name}`,
      data: fs.readFileSync(path.join(f.bundleDir, name)),
    }));
    entries.push({ name: 'shadow/alpha.big.rvf', data: fs.readFileSync(path.join(f.bundleDir, 'alpha.big.rvf')) });
    writeStoredZip({ archiveFile: f.bundle, entries });

    await expect(create(f)).rejects.toThrow(/exactly one alpha\.big\.rvf; found 2/i);
  });

  it('creates and verifies through the public CLI without host archive commands', () => {
    const f = fixture();
    const common = [
      '--assets', f.assetsDir,
      '--bundle', f.bundle,
      '--policy', f.policyFile,
      '--receipt', f.receiptFile,
    ];
    const created = spawnSync(process.execPath, [
      CORPUS_CANDIDATE,
      ...common,
      '--builder-source-sha', 'c'.repeat(40),
    ], { encoding: 'utf8' });
    expect(created.status, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, mode: 'create', stores: 1 });

    const verified = spawnSync(process.execPath, [CORPUS_CANDIDATE, '--verify', ...common], { encoding: 'utf8' });
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ ok: true, mode: 'verify', stores: 1 });
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
      assetsDir: f.assetsDir,
      policyFile: f.policyFile,
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
      assetsDir: f.assetsDir,
      policyFile: f.policyFile,
      run,
    }))
      .resolves.toMatchObject({ tag: corpusSeedTag(receipt), archiveSha256: receipt.archive.sha256 });
    expect(calls[1]).toMatchObject({
      command: process.execPath,
      args: expect.arrayContaining([
        expect.stringMatching(/scripts[\\/]release\.mjs$/),
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
