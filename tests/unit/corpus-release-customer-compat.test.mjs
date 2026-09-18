/**
 * THE CUSTOMER SIDE of a corpus-only release (ADR-086 step 16).
 *
 * A corpus release is tagged `corpus-sha256-<64 hex>` — a CONTENT identity. The runtime a client is
 * running is a SEMVER (`4.3.22`), stamped into every bundle's SOURCE.json by build-bundle.mjs:333-334
 * as `brainVersion` / `releaseTag`. Those are two different identity domains, and before this file
 * existed the updater compared them with a single string inequality
 * (`kb/forge-update.mjs` isBehind: `canon.releaseTag !== local.releaseTag`).
 *
 * `'corpus-sha256-aaa…' !== 'v4.3.22'` is true. It is true again after a perfectly successful
 * install, because the bundle that lands re-stamps `releaseTag: v4.3.22`. So every night, forever:
 * BEHIND -> download -> install -> BEHIND. That is the redownload loop ADR-086's step 16 proof text
 * forbids in its first sentence, and it is measured RED below.
 *
 * The second half is the compatibility boundary, verbatim from the Dual deliberation:
 *   "One releases/latest pointer cannot represent independent newest corpora for multiple
 *    incompatible runtimes. Either explicitly support the current approved runtime with safe
 *    rejection for older clients, or add version-aware discovery. Never silently install
 *    incompatible code."
 * and on how the pin must be enforced:
 *   "Pinning survives only through enforced equality to the approved shipped runtime and its
 *    executable hashes. Copying current-main package.json or preserving a version string alone is
 *    insufficient."
 *
 * So the gate here is bound to BYTES: `kb/RUNTIME-IDENTITY.json` is written by the installer (never
 * by a bundle — build-bundle cannot see it, exactly as it cannot see coverage-integrity.mjs) and
 * names the sha256 of the executables the owner-gated code release placed. The updater re-hashes
 * those files at update time. Tamper one byte and the corpus release is refused — that case is
 * exercised, because a guard that cannot fail on broken code is not a guard.
 *
 * Nothing is mocked below the network boundary: a real zip, a real signature, a real extraction, a
 * real directory swap. The property under test is what ends up on the filesystem and how many times
 * the bytes were fetched.
 */
import { fixtureArtifact } from '../../scripts/ci/coverage-fixture.mjs';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { coverageGenerationFor, releaseCoverageGenerationFor } from '../../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from '../../scripts/public-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { placeTrustedCoverageValidator } = await import('../../bin/install.mjs');

const RUNTIME_VERSION = '4.9.0';        // what this fixture's "installed approved runtime" is
const NEWER_RUNTIME = '4.10.0';         // a corpus built by a runtime this client does not have
const CORPUS_A = `corpus-sha256-${'a'.repeat(64)}`;
const CORPUS_B = `corpus-sha256-${'b'.repeat(64)}`;
const CORPUS_C = `corpus-sha256-${'c'.repeat(64)}`;

function archiveDirectory(stage, zipPath) {
  if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:RUVNET_TEST_ZIP_SOURCE, $env:RUVNET_TEST_ZIP_OUTPUT)';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env,
      RUVNET_TEST_ZIP_SOURCE: stage, RUVNET_TEST_ZIP_OUTPUT: zipPath }, timeout: 30000 });
  } else {
    execFileSync('zip', ['-q', '-r', zipPath, ...fs.readdirSync(stage)], { cwd: stage, timeout: 30000 });
  }
}

const STORE_A = { kbName: 'alpha', sourceCommit: 'aaa111aaa111', sourceDescribe: 'v2.0.0', builtUtc: '2026-09-01T15:04:51.856Z' };
const STORE_A2 = { kbName: 'alpha', sourceCommit: 'ddd444ddd444', sourceDescribe: 'v2.1.0', builtUtc: '2026-09-02T15:04:51.856Z' };

const TEST_SIGNING_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_SIGNING_PUB = TEST_SIGNING_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).trim();
let server; let origin; let served = { release: null, zip: null, sig: null, hits: { zip: 0, sig: 0 } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/releases/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(served.release));
      return;
    }
    if (req.url.startsWith('/bundle.zip.sig')) {
      served.hits.sig += 1;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(served.sig);
      return;
    }
    if (req.url.startsWith('/bundle.zip')) {
      served.hits.zip += 1;
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(served.zip);
      return;
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

let root; let kbDir;
beforeEach(() => {
  served.hits = { zip: 0, sig: 0 };
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-compat-')));
  kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  for (const f of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
    'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs']) {
    const from = path.join(ROOT, 'kb', f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(kbDir, f));
  }
  const updater = path.join(kbDir, 'forge-update.mjs');
  fs.writeFileSync(updater, fs.readFileSync(updater, 'utf8').replace(
    /const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
    `const SIGNING_PUBKEY_PEM = \`${TEST_SIGNING_PUB}\`;`,
  ));
  // The installer — never the bundle — places the trusted validator AND stamps the runtime identity.
  placeTrustedCoverageValidator(kbDir, { brainVersion: RUNTIME_VERSION });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function sourceJson({ brainVersion, builtUtc, stores, corpusReleaseTag = undefined }) {
  return {
    builder: 'rvf-kb-forge',
    builtUtc,
    brainVersion,
    releaseTag: `v${brainVersion}`,
    ...(corpusReleaseTag === undefined ? {} : { corpusReleaseTag }),
    canonicalManifestUrl: `${origin}/releases/latest`,
    stores: Object.fromEntries(stores.map((s) => [s.kbName, { ...s, canonicalManifestUrl: `${origin}/releases/latest` }])),
  };
}

function layDown(dir, source) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify(source, null, 2));
  fs.writeFileSync(path.join(dir, 'forge-guard.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const args=process.argv.slice(2); const value=(name)=>args[args.indexOf(name)+1];
const doc=JSON.parse(fs.readFileSync(path.join(value('--dir'),'SOURCE.json'),'utf8'));
if (!doc.stores?.[value('--name')]) { console.error('no entry for store "'+value('--name')+'"'); process.exit(1); }\n`);
  const storeNames = Object.keys(source.stores).sort();
  const sourceSnapshot = 'd'.repeat(40);
  const publicLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: source.brainVersion, releaseTag: `v${source.brainVersion}`, sourceSnapshot, stores: {} };
  for (const name of storeNames) {
    // Vary the bytes with the store's commit so a genuinely new corpus is genuinely new bytes.
    const bytes = Buffer.alloc(512, source.stores[name].sourceCommit.charCodeAt(0));
    fs.writeFileSync(path.join(dir, `${name}.big.rvf`), bytes);
    publicLedger.stores[name] = { file: `${name}.big.rvf`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, sourceCommit: source.stores[name].sourceCommit || null,
      model: 'fixture-model', dimensions: 384, builtUtc: source.stores[name].builtUtc };
  }
  const publicLedgerBytes = Buffer.from(`${JSON.stringify(publicLedger)}\n`);
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), `${JSON.stringify({ ...publicLedger,
    kind: 'ruvnet-brain-runtime-generation-ledger' })}\n`);
  fs.writeFileSync(path.join(dir, 'PUBLIC-RVF-GENERATIONS.json'), publicLedgerBytes);
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  fs.writeFileSync(path.join(dir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  fs.writeFileSync(path.join(dir, 'forge-mcp-all.mjs'), '// fixture reader\n');
  const rows = storeNames.map((name) => ({ key: `repo:${name}`, kind: 'repository', name,
    url: `https://github.com/ruvnet/${name}`, status: 'CURRENT', disposition: 'eligible', upstream: {},
    artifact: fixtureArtifact(name, publicLedger), reasons: [] }));
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0,
    repositories: { expected: rows.length, pages: [] }, gists: { expected: 0, pages: [] } };
  const generatorSourceSha = 'a'.repeat(64);
  const snapshotRoot = 'b'.repeat(64);
  const sourceObservationSha256 = 'c'.repeat(64);
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', generatorSourceSha,
    snapshotRoot, sourceObservationSha256, rows, enumerationReceipt,
    policy: { policyDispositionDigests: [], exemptionDigests: [] },
    totals: { rows: rows.length, repositories: rows.length, gists: 0, byStatus: { CURRENT: rows.length } } };
  corpus.coverageGeneration = coverageGenerationFor({ generatorSourceSha, snapshotRoot,
    sourceObservationSha256, rows, enumerationReceipt, policyDispositionDigests: [], exemptionDigests: [] });
  const corpusBytes = `${JSON.stringify(corpus, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'CORPUS-COVERAGE.json'), corpusBytes);
  const publicInventory = validatePublicInventory({ assetsDir: dir, coverage: corpus, ledger: publicLedger });
  const release = { ...structuredClone(corpus), kind: 'ruvnet-brain-release-coverage',
    releaseIdentity: { version: source.brainVersion, tag: `v${source.brainVersion}`, sourceSnapshot },
    corpusSeed: { tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1,
      receiptSha256: 'f'.repeat(64) },
    corpusCoverage: { file: 'CORPUS-COVERAGE.json', sha256: crypto.createHash('sha256').update(corpusBytes).digest('hex'),
      coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: crypto.createHash('sha256').update(publicLedgerBytes).digest('hex'),
      bytes: publicLedgerBytes.length, storeCount: storeNames.length },
    publicInventoryPartitionSha256: publicInventory.partitionSha256,
    installedProjectionSchema: 2 };
  delete release.coverageGeneration;
  release.releaseCoverageGeneration = releaseCoverageGenerationFor(release);
  fs.writeFileSync(path.join(dir, 'COVERAGE.json'), JSON.stringify(release));
  if (path.resolve(dir) !== path.resolve(kbDir)) {
    for (const file of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
      'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs']) {
      const from = path.join(kbDir, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, file));
    }
  }
}

/** Publish `source` as the single .zip asset of a release tagged `tag`. */
function publish(source, tag) {
  const stage = path.join(root, `stage-${tag.slice(0, 24)}`);
  fs.rmSync(stage, { recursive: true, force: true });
  layDown(stage, source);
  const zipPath = path.join(root, `bundle-${tag.slice(0, 24)}.zip`);
  fs.rmSync(zipPath, { force: true });
  archiveDirectory(stage, zipPath);
  served.zip = fs.readFileSync(zipPath);
  served.sig = crypto.sign(null, crypto.createHash('sha256').update(served.zip).digest(), TEST_SIGNING_KEYS.privateKey);
  served.release = {
    tag_name: tag,
    published_at: '2026-09-10T00:00:00.000Z',
    assets: [{ name: 'ruvnet-brain-kb-bundle.zip', browser_download_url: `${origin}/bundle.zip` }],
  };
  return stage;
}

function run(...args) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(kbDir, 'forge-update.mjs'), ...args], {
      cwd: kbDir,
      env: { ...process.env, HOME: home, RUVNET_SETTINGS_FILE: path.join(home, 'nope.json') },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const readSource = (dir = kbDir) => JSON.parse(fs.readFileSync(path.join(dir, 'SOURCE.json'), 'utf8'));

// ── 1. THE PROOF TEXT, LITERALLY ────────────────────────────────────────────────────────────────
// "Install corpus A, then report current without another download; install B once, then report
//  current."
describe('corpus release: install A -> current; install B once -> current (no redownload loop)', () => {
  it('installs corpus A, then reports current WITHOUT downloading again; then B once, then current', async () => {
    layDown(kbDir, sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-08-30T04:39:28.414Z', stores: [STORE_A] }));

    // ---- corpus A ----
    publish(sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-09-01T12:00:00.000Z', stores: [STORE_A] }), CORPUS_A);
    const applyA = await run('--apply');
    expect(applyA.code, applyA.out).toBe(0);
    expect(served.hits.zip, 'corpus A is fetched exactly once').toBe(1);
    // The transport identity landed, and the RUNTIME version is still the runtime version.
    const afterA = readSource();
    expect(afterA.corpusReleaseTag).toBe(CORPUS_A);
    expect(afterA.releaseTag, 'runtime identity must stay distinct from the corpus transport tag').toBe(`v${RUNTIME_VERSION}`);
    expect(afterA.brainVersion).toBe(RUNTIME_VERSION);

    // ---- "then report current without another download" ----
    const checkA = await run('--check');
    expect(checkA.code, `already on ${CORPUS_A} — "behind" is not true\n${checkA.out}`).toBe(0);
    expect(checkA.out).toMatch(/All stores current/);
    expect(served.hits.zip, 'a check must never download').toBe(1);
    // And a full --apply must also be a no-op that fetches nothing more than the manifest.
    const reapplyA = await run('--apply');
    expect(reapplyA.code, reapplyA.out).toBe(0);
    expect(reapplyA.out).toMatch(/Nothing to apply — already current/);
    expect(served.hits.zip, 'THE REDOWNLOAD LOOP: re-running must not re-fetch the same corpus').toBe(1);

    // ---- corpus B, exactly once ----
    publish(sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-09-02T12:00:00.000Z', stores: [STORE_A2] }), CORPUS_B);
    const behindB = await run('--check');
    expect(behindB.code, 'a genuinely new corpus IS behind').toBe(10);
    const applyB = await run('--apply');
    expect(applyB.code, applyB.out).toBe(0);
    expect(served.hits.zip, 'corpus B is fetched exactly once').toBe(2);
    expect(readSource().corpusReleaseTag).toBe(CORPUS_B);
    expect(readSource().stores.alpha.sourceCommit).toBe(STORE_A2.sourceCommit);

    // ---- "then report current" ----
    const checkB = await run('--check');
    expect(checkB.code, checkB.out).toBe(0);
    expect(checkB.out).toMatch(/All stores current/);
    expect(served.hits.zip, 'B is installed ONCE — two corpora, two downloads, total').toBe(2);
  }, 120_000);
});

// ── 2. COMPATIBILITY BOUNDARY ───────────────────────────────────────────────────────────────────
describe('corpus release compatibility is enforced against the installed approved runtime', () => {
  it('refuses a corpus release built by a NEWER runtime, cleanly, and never installs it', async () => {
    layDown(kbDir, sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-08-30T04:39:28.414Z', stores: [STORE_A] }));
    publish(sourceJson({ brainVersion: NEWER_RUNTIME, builtUtc: '2026-09-03T12:00:00.000Z', stores: [STORE_A2] }), CORPUS_C);

    const first = await run('--apply');

    expect(first.code, `an incompatible corpus is an error, not a silent install\n${first.out}`).toBe(5);
    expect(first.out).toMatch(/INCOMPATIBLE/);
    expect(first.out).toMatch(new RegExp(`built by runtime ${NEWER_RUNTIME.replace('.', '\\.')}`));
    expect(first.out, 'the user must be told what to do').toMatch(/npx ruvnet-brain/);
    // NEVER SILENTLY INSTALL INCOMPATIBLE CODE: the live tree is exactly as it was.
    const live = readSource();
    expect(live.brainVersion).toBe(RUNTIME_VERSION);
    expect(live.corpusReleaseTag).toBeUndefined();
    expect(live.stores.alpha.sourceCommit).toBe(STORE_A.sourceCommit);
    expect(fs.readdirSync(root).filter((n) => n.startsWith('kb.bak-'))).toEqual([]);

    // ---- "Older clients cannot enter a redownload loop" ----
    const downloadsAfterFirst = served.hits.zip;
    const second = await run('--apply');
    expect(second.code).toBe(5);
    expect(second.out, 'the rejection is remembered, not rediscovered').toMatch(/already rejected/i);
    expect(served.hits.zip, 'a rejected release must never be downloaded a second time').toBe(downloadsAfterFirst);
    const check = await run('--check');
    expect(check.code, 'a check on a known-incompatible release is a clean refusal, not "behind"').toBe(5);
    expect(served.hits.zip).toBe(downloadsAfterFirst);
  }, 120_000);

  it('refuses a corpus release when the installed runtime identity is absent (older client, safe rejection)', async () => {
    layDown(kbDir, sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-08-30T04:39:28.414Z', stores: [STORE_A] }));
    fs.rmSync(path.join(kbDir, 'RUNTIME-IDENTITY.json'), { force: true });
    publish(sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-09-01T12:00:00.000Z', stores: [STORE_A2] }), CORPUS_A);

    const { code, out } = await run('--apply');

    expect(code).toBe(5);
    expect(out).toMatch(/INCOMPATIBLE/);
    expect(out).toMatch(/no installed runtime identity/i);
    expect(served.hits.zip, 'refused BEFORE spending a byte of bandwidth').toBe(0);
    expect(readSource().corpusReleaseTag).toBeUndefined();
  }, 60_000);

  // A test that cannot fail on broken code is not a test: break the executable the pin is bound to
  // and watch the pin fail. This is what makes it an EXECUTABLE-HASH pin rather than a copied
  // version string — the version string in RUNTIME-IDENTITY.json is untouched here.
  it('refuses when a pinned runtime executable no longer hashes to its approved bytes', async () => {
    layDown(kbDir, sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-08-30T04:39:28.414Z', stores: [STORE_A] }));
    const identityBefore = JSON.parse(fs.readFileSync(path.join(kbDir, 'RUNTIME-IDENTITY.json'), 'utf8'));
    fs.appendFileSync(path.join(kbDir, 'coverage-integrity.mjs'), '\n// one byte of drift\n');
    publish(sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-09-01T12:00:00.000Z', stores: [STORE_A2] }), CORPUS_A);

    const { code, out } = await run('--apply');

    expect(code).toBe(5);
    expect(out).toMatch(/coverage-integrity\.mjs/);
    expect(out).toMatch(/does not match/i);
    expect(served.hits.zip).toBe(0);
    // The declared version never changed — only the bytes did. A version-string-only pin passes here.
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'RUNTIME-IDENTITY.json'), 'utf8')).brainVersion)
      .toBe(identityBefore.brainVersion);
  }, 60_000);

  it('still accepts an ordinary semver code release — the corpus path adds a domain, it does not replace one', async () => {
    layDown(kbDir, sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-08-30T04:39:28.414Z', stores: [STORE_A] }));
    publish(sourceJson({ brainVersion: RUNTIME_VERSION, builtUtc: '2026-09-01T12:00:00.000Z', stores: [STORE_A2] }), `v${RUNTIME_VERSION}`);

    const check = await run('--check');
    expect(check.code, 'same runtime tag, same domain -> current').toBe(0);
    expect(check.out).toMatch(/All stores current/);
  }, 60_000);
});

// ── 3. FRESH INSTALL ────────────────────────────────────────────────────────────────────────────
// "Fresh installation succeeds when latest is a compatible corpus tag."
describe('fresh installation from a corpus-tagged latest release', () => {
  it('succeeds and records the corpus transport identity atomically with the swap', () => {
    const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version;
    const sourceDir = path.join(root, 'fresh-source');
    layDown(sourceDir, sourceJson({ brainVersion: packageVersion, builtUtc: '2026-09-01T12:00:00.000Z', stores: [STORE_A] }));
    const live = path.join(root, 'fresh-live');

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { unzipInto } from ${JSON.stringify(new URL('../../bin/install.mjs', import.meta.url).href)};
      await unzipInto(null, ${JSON.stringify(live)}, ${JSON.stringify(sourceDir)}, { releaseTag: ${JSON.stringify(CORPUS_A)} });
      console.log('FRESH_OK');
    `], { cwd: root, encoding: 'utf8', env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' } });

    expect(result.stdout + result.stderr).toContain('FRESH_OK');
    expect(result.status).toBe(0);
    const landed = readSource(live);
    expect(landed.corpusReleaseTag, 'the transport identity is persisted WITH the installation').toBe(CORPUS_A);
    expect(landed.brainVersion, 'runtime version stays distinct').toBe(packageVersion);
    // And the installer left the runtime identity the updater will enforce against.
    const identity = JSON.parse(fs.readFileSync(path.join(live, 'RUNTIME-IDENTITY.json'), 'utf8'));
    expect(identity.brainVersion).toBe(packageVersion);
    expect(identity.executables['coverage-integrity.mjs'].sha256)
      .toBe(crypto.createHash('sha256').update(fs.readFileSync(path.join(live, 'coverage-integrity.mjs'))).digest('hex'));
  }, 120_000);
});

// ── 4. THE OTHER FRESH-INSTALL CONSUMER OF `releases/latest` ────────────────────────────────────
// bin/install.mjs picks the bundle out of the release payload by asset name. Before ADR-086 step 16
// it matched ONLY `ruvnet-brain.zip` and otherwise fell through to a URL assembled from that same
// conventional name — a guaranteed 404, reached by a FRESH install, the one case with no brain
// already on disk. kb/forge-update.mjs's resolveBundleUrl() had learned the fix for this in issue
// #35; the installer had not.
describe('bin/install.mjs resolves the bundle asset of a corpus-tagged release', () => {
  const CORPUS_TAG = `corpus-sha256-${'a'.repeat(64)}`;
  const dl = (name) => ({ name, browser_download_url: `https://example.invalid/${name}` });

  it('prefers the conventional asset name when the release carries it', async () => {
    const { resolveReleaseAsset } = await import('../../bin/install.mjs');
    const r = resolveReleaseAsset({ tag: CORPUS_TAG, assets: [dl('notes.txt'), dl('ruvnet-brain.zip')] });
    expect(r).toMatchObject({ origin: 'exact-name', assetName: 'ruvnet-brain.zip' });
  });

  it('falls back to the single unambiguous .zip rather than to a URL that cannot resolve', async () => {
    const { resolveReleaseAsset } = await import('../../bin/install.mjs');
    const r = resolveReleaseAsset({ tag: CORPUS_TAG,
      assets: [dl('ruvnet-brain-kb-bundle.zip'), dl('ruvnet-brain-kb-bundle.zip.sig'), dl('receipt.json')] });
    expect(r.origin).toBe('single-zip');
    expect(r.assetName).toBe('ruvnet-brain-kb-bundle.zip');
    // The signature is fetched as `${url}.sig`, so the two must stay on the same asset name.
    expect(`${r.url}.sig`).toBe('https://example.invalid/ruvnet-brain-kb-bundle.zip.sig');
  });

  it('TEETH: two .zip assets are genuinely ambiguous and must NOT be guessed', async () => {
    const { resolveReleaseAsset } = await import('../../bin/install.mjs');
    const r = resolveReleaseAsset({ tag: CORPUS_TAG, assets: [dl('a-bundle.zip'), dl('b-bundle.zip')] });
    expect(r.origin).toBe('conventional-url');
    expect(r.assetName).toBe(null);
    expect(r.url).toContain(`/releases/download/${CORPUS_TAG}/ruvnet-brain.zip`);
  });

  it('TEETH: an asset with no download URL is not an asset', async () => {
    const { resolveReleaseAsset } = await import('../../bin/install.mjs');
    expect(resolveReleaseAsset({ tag: CORPUS_TAG, assets: [{ name: 'ruvnet-brain.zip' }] }).origin)
      .toBe('conventional-url');
    expect(resolveReleaseAsset({ tag: CORPUS_TAG, assets: [] }).origin).toBe('conventional-url');
  });
});
