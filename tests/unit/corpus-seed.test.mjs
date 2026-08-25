import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createCorpusReceipt,
  verifyCorpusReceipt,
} from '../../scripts/corpus-candidate.mjs';
import {
  corpusSeedTag,
  publishCorpusSeed,
} from '../../scripts/corpus-seed-publish.mjs';
import { getVersion, getVersionTag } from '../../scripts/version.mjs';

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function createArchive(bundle, root, { update = false, file = null } = {}) {
  if (process.platform === 'win32') {
    const source = file || path.join(root, 'ruvnet-brain');
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = update
      ? `Compress-Archive -LiteralPath ${quote(source)} -Update -DestinationPath ${quote(bundle)}`
      : `Compress-Archive -Path ${quote(source)} -DestinationPath ${quote(bundle)} -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
    return;
  }
  const args = update
    ? ['-q', '-u', bundle, path.relative(root, file)]
    : ['-qr', bundle, 'ruvnet-brain'];
  execFileSync('zip', args, { cwd: root });
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
    sources: [{ name: 'alpha', status: 'CURRENT', eligible: true }],
  }));
  const bundle = path.join(root, 'ruvnet-brain.zip');
  createArchive(bundle, path.dirname(bundleDir));
  return {
    root,
    assetsDir,
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
  it('creates and verifies a receipt binding every public store, sidecar, fence, policy, and archive byte', () => {
    const f = fixture();
    const receipt = create(f);

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
    });
    expect(receipt.privateFence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.eligibilityPolicy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.archive.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.stores[0].files).toHaveLength(7);
    expect(verifyCorpusReceipt({
      receiptFile: f.receiptFile,
      assetsDir: f.assetsDir,
      bundleFile: f.bundle,
      policyFile: f.policyFile,
    })).toEqual(receipt);
  });

  it('fails closed for unreceipted RVFs, missing sidecars, duplicate RVFs, and orphan ledger rows', () => {
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
    mutations.forEach((mutate, index) => {
      const f = fixture();
      mutate(f);
      expect(() => create(f)).toThrow(expected[index]);
    });
  });

  it('rejects private corpus bytes in the archive and any post-receipt byte or policy drift', () => {
    const privateFixture = fixture();
    const archiveRoot = path.join(privateFixture.root, 'bundle', 'ruvnet-brain');
    fs.writeFileSync(path.join(archiveRoot, 'secret.big.rvf'), 'private-rvf');
    createArchive(privateFixture.bundle, path.dirname(archiveRoot), {
      update: true, file: path.join(archiveRoot, 'secret.big.rvf'),
    });
    expect(() => create(privateFixture)).toThrow(/private store.*archive/i);

    const driftFixture = fixture();
    create(driftFixture);
    fs.appendFileSync(driftFixture.bundle, 'tampered');
    expect(() => verifyCorpusReceipt({
      receiptFile: driftFixture.receiptFile,
      assetsDir: driftFixture.assetsDir,
      bundleFile: driftFixture.bundle,
      policyFile: driftFixture.policyFile,
    })).toThrow(/archive sha256/i);

    const policyFixture = fixture();
    create(policyFixture);
    fs.appendFileSync(policyFixture.policyFile, '\n');
    expect(() => verifyCorpusReceipt({
      receiptFile: policyFixture.receiptFile,
      assetsDir: policyFixture.assetsDir,
      bundleFile: policyFixture.bundle,
      policyFile: policyFixture.policyFile,
    })).toThrow(/eligibility policy/i);
  });
});

describe('immutable corpus seed publishing', () => {
  it('derives the tag from the archive digest and refuses to overwrite an existing release', () => {
    const f = fixture();
    const receipt = create(f);
    const tag = corpusSeedTag(receipt);
    expect(tag).toBe(`corpus-sha256-${receipt.archive.sha256}`);

    const run = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(() => publishCorpusSeed({
      receiptFile: f.receiptFile,
      bundleFile: f.bundle,
      assetsDir: f.assetsDir,
      policyFile: f.policyFile,
      run,
    }))
      .toThrow(/already exists.*refusing to overwrite/i);
    expect(run).toHaveBeenCalledWith('gh', ['release', 'view', tag, '--json', 'tagName'], expect.any(Object));
  });

  it('hands a new digest-tagged prerelease to the repository\'s sole release authority', () => {
    const f = fixture();
    const receipt = create(f);
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      if (args[1] === 'view') return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: 'created', stderr: '' };
    };

    expect(publishCorpusSeed({
      receiptFile: f.receiptFile,
      bundleFile: f.bundle,
      assetsDir: f.assetsDir,
      policyFile: f.policyFile,
      run,
    }))
      .toMatchObject({ tag: corpusSeedTag(receipt), archiveSha256: receipt.archive.sha256 });
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
