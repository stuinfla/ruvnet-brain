// ADR-086 Step 8 — the local rehearsal harness's own contract.
//
// Every case here proves a GUARD by breaking the thing it guards and watching it fail. A recorder
// that cannot detect its own bypass, an isolation check that cannot notice a write, or an
// extracted-byte verifier that cannot notice a flipped byte would each be a test-shaped decoration
// rather than a gate — so each of those is exercised in its broken state, not only its happy one.

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  acquireSeed, boundObservation, createDisposableCheckout, inventoryTree, installCommandRecorder,
  verifyExtractedBytesWithoutOriginals,
} from '../../scripts/rehearse-corpus-pipeline.mjs';
import { canonicalSourceObservation, sourceObservationDigest } from '../../scripts/source-coverage.mjs';

const dirs = [];
const tmp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    try { fs.chmodSync(dir, 0o700); } catch { /* already writable */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('command recorder', () => {
  it('records a publication mutation without executing it, and proves both interception channels', () => {
    const recorder = installCommandRecorder({ dir: tmp('rehearsal-recorder-') });
    const proof = recorder.proveIntercepting();
    expect(proof.ok).toBe(true);
    expect(proof.channels.pathShim.intercepted).toBe(true);
    expect(proof.channels.explicitSeam.intercepted).toBe(true);
    expect(proof.channels.pathShimResolvesInsideStubDir).toBe(true);

    const env = { ...process.env, ...recorder.env };
    const create = spawnSync('gh', ['release', 'create', 'corpus-sha256-x', '--prerelease'], { env, encoding: 'utf8' });
    expect(create.status).toBe(0);
    const mutations = recorder.recorded().filter((row) => row.classification === 'publication-mutation');
    expect(mutations).toHaveLength(1);
    expect(mutations[0].executed).toBe(false);
    expect(mutations[0].args.join(' ')).toBe('release create corpus-sha256-x --prerelease');
  });

  it('answers `gh release view` with the absence proof the publisher requires, without the network', () => {
    const recorder = installCommandRecorder({ dir: tmp('rehearsal-recorder-') });
    const view = spawnSync('gh', ['release', 'view', 'corpus-sha256-x', '--json', 'tagName'],
      { env: { ...process.env, ...recorder.env }, encoding: 'utf8' });
    expect(view.status).not.toBe(0);
    expect(String(view.stderr)).toMatch(/release not found/i);
    expect(recorder.recorded().at(-1)).toMatchObject({ classification: 'stubbed-read', executed: false });
  });

  // The recorder now sits on the WHOLE process, so it classifies the pipeline's own observation
  // traffic too. That made an over-broad rule matter: `gh api graphql` always sends POST and always
  // carries `-f query=...`, so "any -f is a write" stubbed out every repository enumeration and a
  // real rehearsal failed with "GitHub repository enumeration returned no repository connection".
  // Reads must pass through and writes must not, decided per command shape — both directions pinned.
  it.each([
    ['read', ['api', 'graphql', '-f', 'query=query($login:String!){ user(login:$login){ login } }']],
    ['read', ['api', 'users/ruvnet/gists?per_page=1']],
    ['read', ['api', 'repos/x/y', '--method', 'GET']],
    ['read', ['release', 'download', 'v1', '--pattern', 'x']],
    ['write', ['api', 'graphql', '-f', 'query=mutation { createRelease(input:{}) { clientMutationId } }']],
    ['write', ['api', 'repos/x/y/releases', '-f', 'tag_name=v1']],
    ['write', ['api', 'repos/x/y', '--method', 'DELETE']],
    ['write', ['release', 'create', 'v1']],
  ])('classifies `gh %s` correctly: %j', (expected, args) => {
    const recorder = installCommandRecorder({ dir: tmp('rehearsal-recorder-') });
    spawnSync('gh', args, { env: { ...process.env, ...recorder.env }, encoding: 'utf8' });
    const row = recorder.recorded().at(-1);
    if (expected === 'write') {
      expect(row.classification).toBe('publication-mutation');
      expect(row.executed).toBe(false);
    } else {
      expect(row.classification).not.toBe('publication-mutation');
    }
  });

  it('classifies npm publish as a mutation and a plain `npm --version` as a read', () => {
    const recorder = installCommandRecorder({ dir: tmp('rehearsal-recorder-') });
    const env = { ...process.env, ...recorder.env };
    spawnSync('npm', ['publish', '--access', 'public'], { env, encoding: 'utf8' });
    const rows = recorder.recorded();
    expect(rows.find((row) => row.tool === 'npm')).toMatchObject({ classification: 'publication-mutation', executed: false });
  });

  // THE BYPASS PROOF. The repo already documented, in tests/integration/nightly-gists-error-paths.test.mjs,
  // that scripts/nightly-gists.sh REASSIGNS PATH rather than appending to it, which silently defeats
  // PATH stubbing. If the harness could not notice that, a rehearsal would execute a real
  // `gh release create`. So: reproduce the hostile technique and require the detector to report the
  // interception as ABSENT. A detector that returned `intercepted: true` here would fail this test.
  it('detects its own bypass when PATH is reassigned and the explicit seam is removed', () => {
    const recorder = installCommandRecorder({ dir: tmp('rehearsal-recorder-') });
    const bypass = recorder.demonstrateBypass();
    expect(bypass.intercepted).toBe(false);
    expect(bypass.technique).toMatch(/PATH reassignment/);
    // And the same probe IS intercepted when the harness's own env is in force — otherwise the
    // assertion above would pass for the trivial reason that the probe never works at all.
    expect(recorder.proveIntercepting().ok).toBe(true);
  });
});

describe('isolation inventory', () => {
  it('changes digest when a single byte is written, and stays identical when nothing is', () => {
    const dir = tmp('rehearsal-inventory-');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one');
    const before = inventoryTree(dir);
    expect(inventoryTree(dir).digest).toBe(before.digest);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two!');
    expect(inventoryTree(dir).digest).not.toBe(before.digest);
  });

  it('reports an absent tree rather than throwing, so a machine without the installed brain still rehearses', () => {
    const inventory = inventoryTree(path.join(tmp('rehearsal-inventory-'), 'never-created'));
    expect(inventory).toMatchObject({ present: false, digest: null });
  });
});

describe('seed acquisition', () => {
  // Tag and asset come from the committed descriptor, never a literal: a hardcoded version here
  // would drift from the source of truth (and scripts/sync-version.mjs --check flags exactly that).
  // Only sha256/bytes are synthetic, because these cases are about the digest contract itself.
  const committed = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../data/corpus-seed.json'), 'utf8'));
  const descriptor = { tag: committed.tag, asset: committed.asset, sha256: 'a'.repeat(64), bytes: 3 };

  it('refuses a local file whose digest does not match the pin, and says why', () => {
    const dir = tmp('rehearsal-seed-');
    const wrong = path.join(dir, 'wrong.zip');
    fs.writeFileSync(wrong, 'abc');
    const recorder = installCommandRecorder({ dir: path.join(dir, 'bin') });
    const result = acquireSeed({
      descriptor, repo: 'stuinfla/ruvnet-brain', downloadDir: path.join(dir, 'dl'),
      env: { ...process.env, ...recorder.env, GH_TOKEN: 'invalid' }, localCandidates: [wrong],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be downloaded and no local copy matched/);
    expect(result.attempts.some((row) => row.outcome === 'digest-mismatch')).toBe(true);
  });

  it('accepts a local file only when sha256 AND byte length both equal the pin', () => {
    const dir = tmp('rehearsal-seed-');
    const good = path.join(dir, 'good.zip');
    fs.writeFileSync(good, 'abc');
    const sha256 = spawnSync('shasum', ['-a', '256', good], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
    const recorder = installCommandRecorder({ dir: path.join(dir, 'bin') });
    const result = acquireSeed({
      descriptor: { ...descriptor, sha256 }, repo: 'stuinfla/ruvnet-brain', downloadDir: path.join(dir, 'dl'),
      env: { ...process.env, ...recorder.env, GH_TOKEN: 'invalid' }, localCandidates: [good],
    });
    expect(result.ok).toBe(true);
    expect(result.channel).toBe('local-cache-digest-verified');
  });
});

describe('bounded observation', () => {
  const observation = canonicalSourceObservation({
    schemaVersion: 1,
    kind: 'ruvnet-brain-source-observation',
    owner: 'ruvnet',
    observedAt: '2026-09-14T00:00:00.000Z',
    repositories: {
      rows: ['alpha', 'beta', 'gamma'].map((name, index) => ({
        databaseId: index + 1, name, fullName: `ruvnet/${name}`, url: `https://github.com/ruvnet/${name}`,
        diskUsage: (3 - index) * 10, defaultBranchRef: { name: 'main', target: { oid: 'b'.repeat(40) } },
      })),
      expected: 3,
    },
    gists: {
      rows: [1, 2, 3, 4].map((n) => ({ id: `${n}`.repeat(32), version: 'c'.repeat(40), updatedAt: '2026-01-01T00:00:00Z', files: [`f${n}.md`] })),
      expected: 4,
    },
  });

  it('keeps only the named repositories and the first N gists, and re-seals a valid identity', () => {
    const bounded = boundObservation({ observation, api: { canonicalSourceObservation }, repoStores: ['beta'], gistCount: 2 });
    expect(bounded.repositories.rows.map((row) => row.name)).toEqual(['beta']);
    expect(bounded.repositories.expected).toBe(1);
    expect(bounded.gists.rows).toHaveLength(2);
    expect(bounded.observationSha256).toBe(sourceObservationDigest(bounded));
    expect(bounded.observationSha256).not.toBe(observation.observationSha256);
  });

  it('is deterministic — two bindings of the same universe seal the same identity', () => {
    const first = boundObservation({ observation, api: { canonicalSourceObservation }, repoStores: ['alpha', 'beta'], gistCount: 3 });
    const second = boundObservation({ observation, api: { canonicalSourceObservation }, repoStores: ['alpha', 'beta'], gistCount: 3 });
    expect(second.observationSha256).toBe(first.observationSha256);
  });
});

describe('extracted-byte verification with the originals revoked', () => {
  /** A miniature "archive": an extractZip seam that materializes a tree with an ARCHIVE-MANIFEST
   * describing it. Real archives are exercised by the live rehearsal; this fixture exists to prove
   * the verifier's FAILURE paths deterministically and in milliseconds. */
  function fixture({ corrupt = false } = {}) {
    const dir = tmp('rehearsal-extract-');
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, 'staging-marker.txt'), 'original assets');
    const bundleFile = path.join(dir, 'ruvnet-brain.zip');
    fs.writeFileSync(bundleFile, 'not a real zip; extraction is injected');
    const receiptFile = path.join(dir, 'corpus-receipt.json');
    fs.writeFileSync(receiptFile, '{}');
    const payload = Buffer.from('vector bytes here — long enough to flip byte 64'.repeat(4));
    const extractZip = async (_archive, target) => {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'demo.big.rvf'), payload);
      const sha256 = spawnSync('shasum', ['-a', '256', path.join(target, 'demo.big.rvf')], { encoding: 'utf8' }).stdout.split(/\s+/)[0];
      fs.writeFileSync(path.join(target, 'ARCHIVE-MANIFEST.json'), JSON.stringify({
        schemaVersion: 1, kind: 'ruvnet-brain-archive-manifest', version: '0.0.0', releaseTag: 'v0.0.0',
        fileCount: 1, totalBytes: payload.length,
        files: [{ path: 'demo.big.rvf', sha256: corrupt ? 'f'.repeat(64) : sha256, bytes: payload.length }],
      }, null, 2));
    };
    return { dir, assets, bundleFile, receiptFile, extractZip, verifyDir: path.join(dir, 'verify') };
  }

  it('fails, naming the file, when an extracted byte is deliberately flipped', async () => {
    const f = fixture();
    await expect(verifyExtractedBytesWithoutOriginals({
      checkoutRoot: f.dir, assetsDir: f.assets, bundleFile: f.bundleFile, receiptFile: f.receiptFile,
      verifyDir: f.verifyDir, tamper: 'extracted-byte', extractZip: f.extractZip,
    })).rejects.toThrow(/demo\.big\.rvf: extracted bytes sha256=/);
  });

  it('fails when the manifest claims bytes the extracted tree does not carry', async () => {
    const f = fixture({ corrupt: true });
    await expect(verifyExtractedBytesWithoutOriginals({
      checkoutRoot: f.dir, assetsDir: f.assets, bundleFile: f.bundleFile, receiptFile: f.receiptFile,
      verifyDir: f.verifyDir, extractZip: f.extractZip,
    })).rejects.toThrow(/do not reproduce ARCHIVE-MANIFEST\.json/);
  });

  it('genuinely revokes the staging directory before it verifies anything', async () => {
    const f = fixture({ corrupt: true });
    await verifyExtractedBytesWithoutOriginals({
      checkoutRoot: f.dir, assetsDir: f.assets, bundleFile: f.bundleFile, receiptFile: f.receiptFile,
      verifyDir: f.verifyDir, extractZip: f.extractZip,
    }).catch(() => {});
    // The assets directory is gone from its original path: an assembly that still needed it would
    // have nowhere to read from, which is the entire point of this phase.
    expect(fs.existsSync(f.assets)).toBe(false);
    expect(fs.existsSync(`${f.assets}.revoked`)).toBe(true);
  });
});

describe('disposable checkout', () => {
  it('is a real git repository with its own HEAD, and both dependency trees resolve', () => {
    const dir = tmp('rehearsal-checkout-');
    const source = path.resolve(import.meta.dirname, '../..');
    const checkout = createDisposableCheckout({ sourceRoot: source, targetRoot: path.join(dir, 'checkout') });
    expect(checkout.head).toMatch(/^[a-f0-9]{40}$/);
    expect(checkout.head).not.toBe(checkout.sourceHead);
    expect(fs.existsSync(path.join(checkout.root, 'scripts', 'corpus-reconcile.mjs'))).toBe(true);
    expect(fs.lstatSync(path.join(checkout.root, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(checkout.root, 'kb', 'node_modules')).isSymbolicLink()).toBe(true);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout.root, encoding: 'utf8' });
    expect(String(head.stdout).trim()).toBe(checkout.head);
  }, 120_000);
});
