// tests/unit/nightly-corpus-zip-coverage.test.mjs — the nightly corpus archive must be one an
// installed customer can actually apply.
//
// Measured defect (2026-09-30, owner Mac): the nightly corpus release (corpus-sha256-*, produced by
// corpus-seed.yml -> scripts/corpus-reconcile.mjs prepareCorpusCandidate -> scripts/build-bundle.mjs)
// published a ruvnet-brain.zip with NO COVERAGE.json and NO CORPUS-COVERAGE.json inside it, so the
// customer updater (kb/forge-update.mjs) refused every night:
//   "staged ReleaseCoverage failed integrity: COVERAGE.json is missing; CORPUS-COVERAGE.json is missing"
// build-bundle writes the release coverage projection only when handed a seed identity; the code-release
// path (scripts/code-release-corpus.mjs) hands it one, the nightly path did not.
//
// These tests drive the REAL prepareCorpusCandidate with its `run` seam routed to the REAL assembleBundle
// and the REAL baseline observer, then install the result through the REAL updater over a local HTTP
// "releases/latest". Only the retrieval oracles and the receipt seal are stubbed: they read the archive,
// they never shape it, and each has its own suite.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { main as reconcileMain, normalizeExtractedCorpus, prepareCorpusCandidate, readPriorCoverage } from '../../scripts/corpus-reconcile.mjs';
import { validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { extractZip } from '../../kb/zip-extract.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { SEED_IDENTITY, buildCorpus, buildRuntimeRoot, readJson, sha256File, tempDir, writeCoverage } from '../helpers/assemble-bundle-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { placeTrustedCoverageValidator } = await import('../../bin/install.mjs');

const VERSION = getVersion(); // the runtime the nightly builds at (build-bundle stamps package.json's version)
const BUILDER_SHA = 'c'.repeat(40);
const UPDATER_MODULES = ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
  'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs'];

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const sign = (bytes) => crypto.sign(null, crypto.createHash('sha256').update(bytes).digest(), KEYS.privateKey);
let server; let origin; const served = { release: null, zip: null, sig: null };
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/releases/latest')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(served.release)); return; }
    if (req.url.startsWith('/ruvnet-brain.zip.sig')) { res.writeHead(200); res.end(served.sig); return; }
    if (req.url.startsWith('/ruvnet-brain.zip')) { res.writeHead(200); res.end(served.zip); return; }
    res.writeHead(404).end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

/** The runtime checkout prepareCorpusCandidate requires; the scripts it spawns are routed by `run` below. */
function nightlyRuntimeRoot() {
  const root = buildRuntimeRoot(dirs);
  fs.mkdirSync(path.join(root, 'scripts', 'oracle'), { recursive: true });
  for (const file of ['build-bundle.mjs', 'corpus-candidate.mjs', 'public-verification-inputs.mjs', 'oracle/retrieval-accuracy.mjs', 'oracle/repo-recall.mjs']) {
    fs.writeFileSync(path.join(root, 'scripts', file), '// routed to the real implementation by the test run seam\n');
  }
  for (const file of ['retrieval-accuracy-oracle.json', 'repo-recall-floor.json']) {
    fs.writeFileSync(path.join(root, 'data', file), '{}');
  }
  // build-bundle reads the frozen fixture to state corpus currency; it must be the real one.
  fs.copyFileSync(path.join(ROOT, 'data', 'retrieval-query-evidence.json'), path.join(root, 'data', 'retrieval-query-evidence.json'));
  return root;
}

/** Point a corpus's updater configuration at the local "releases/latest". */
function pointAtOrigin(corpusDir) {
  const file = path.join(corpusDir, 'SOURCE.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), canonicalManifestUrl: `${origin}/releases/latest` }));
}

/**
 * The run seam, routed to real code: build-bundle.mjs -> the real assembleBundle (in a child, because
 * `run` is synchronous) against the fixture runtime, driven by EXACTLY the argv prepareCorpusCandidate
 * produced; public-verification-inputs.mjs -> the real CLI. Oracles and the seal are stubbed green.
 */
function realToolchain(runtimeRoot, calls) {
  const driver = path.join(tempDir(dirs, 'driver'), 'assemble.mjs');
  fs.writeFileSync(driver, `import { assembleBundle } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'build-bundle.mjs')).href)};
await assembleBundle(JSON.parse(process.env.ASSEMBLE_OPTIONS));\n`);
  return (command, args) => {
    calls.push(args);
    const script = args[0].split(path.sep).slice(-2).join('/');
    if (script.endsWith('/build-bundle.mjs')) {
      const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
      const seedIdentity = flag('--seed-tag') === undefined ? null : { tag: flag('--seed-tag'), archiveSha256: flag('--seed-sha256'),
        archiveBytes: Number(flag('--seed-bytes')), baselineReceiptSha256: flag('--baseline-receipt-sha256') };
      const options = { corpusDir: flag('--assets'), runtimeRoot, outDir: flag('--out'), seedIdentity,
        identity: { version: flag('--version'), sourceSnapshot: flag('--source-snapshot') } };
      return spawnSync(process.execPath, [driver], { encoding: 'utf8', env: { ...process.env, ASSEMBLE_OPTIONS: JSON.stringify(options) } });
    }
    if (script.endsWith('/public-verification-inputs.mjs')) {
      return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'public-verification-inputs.mjs'), ...args.slice(1)], { encoding: 'utf8' });
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

/**
 * Tonight's nightly, end to end through prepareCorpusCandidate. The seed is a REAL previous generation
 * (an assembled archive, tagged by its own digest exactly as corpus-sha256-* tags are). Returns the
 * published archive plus the seed a customer is still running.
 */
async function runNightly() {
  const runtimeRoot = nightlyRuntimeRoot();
  const seedCorpus = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
  pointAtOrigin(seedCorpus);
  writeCoverage(runtimeRoot, seedCorpus);
  const seedOut = path.join(tempDir(dirs, 'seed'), 'ruvnet-brain');
  // The customer's installed generation: a valid, applicable archive for the same runtime.
  await assembleBundle({ corpusDir: seedCorpus, runtimeRoot, outDir: seedOut,
    identity: { version: VERSION, sourceSnapshot: BUILDER_SHA }, seedIdentity: SEED_IDENTITY });
  const seedZip = `${seedOut}.zip`;
  const seedSha256 = sha256File(seedZip);
  const seed = { file: seedZip, tag: `corpus-sha256-${seedSha256}`, sha256: seedSha256, dir: seedOut };

  const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta', 'gamma'] });
  pointAtOrigin(corpusDir);
  const coverage = writeCoverage(runtimeRoot, corpusDir);
  const out = tempDir(dirs, 'nightly');
  const calls = [];
  const candidate = prepareCorpusCandidate({
    root: runtimeRoot, assetsDir: corpusDir, builderSha: BUILDER_SHA,
    candidateDir: path.join(out, 'candidate', 'ruvnet-brain'),
    receiptFile: path.join(out, 'evidence', 'corpus-receipt.json'),
    coverageFile: path.join(runtimeRoot, 'data', 'source-coverage.json'),
    coverage, seedArchive: { file: seed.file, tag: seed.tag, sha256: seed.sha256 },
    run: realToolchain(runtimeRoot, calls),
  });
  return { candidate, calls, seed, runtimeRoot };
}

async function extracted(zip) {
  const dir = tempDir(dirs, 'extract');
  await extractZip(zip, dir);
  return dir;
}

describe('the nightly corpus archive carries a release-bound coverage projection', () => {
  it('extracts to a tree validateCoverageDirectory accepts for the runtime it was built at', async () => {
    const { candidate, calls, seed } = await runNightly();
    const tree = await extracted(candidate.bundleFile);

    expect(fs.existsSync(path.join(tree, 'COVERAGE.json')), 'COVERAGE.json ships inside the archive').toBe(true);
    expect(fs.existsSync(path.join(tree, 'CORPUS-COVERAGE.json')), 'CORPUS-COVERAGE.json ships inside the archive').toBe(true);
    const result = validateCoverageDirectory(tree, { expectedVersion: VERSION });
    expect(result.failures).toEqual([]);
    expect(result.valid).toBe(true);

    // The projection names the runtime the corpus was built AT and the seed it was reconciled from.
    const coverage = readJson(path.join(tree, 'COVERAGE.json'));
    expect(coverage.releaseIdentity).toEqual({ version: VERSION, tag: `v${VERSION}`, sourceSnapshot: BUILDER_SHA });
    expect(readJson(path.join(tree, 'SOURCE.json')).brainVersion).toBe(VERSION);
    expect(coverage.corpusSeed).toMatchObject({ tag: seed.tag, archiveSha256: seed.sha256, archiveBytes: fs.statSync(seed.file).size });
    expect(coverage.corpusSeed.receiptSha256).toMatch(/^[0-9a-f]{64}$/);

    // Same machinery as the code release: the baseline is observed first, then build-bundle gets the seed.
    const scripts = calls.map((args) => path.basename(args[0]));
    expect(scripts.indexOf('public-verification-inputs.mjs')).toBeLessThan(scripts.indexOf('build-bundle.mjs'));
    expect(calls.find((args) => path.basename(args[0]) === 'build-bundle.mjs')).toEqual(expect.arrayContaining(['--seed-tag', seed.tag]));
  }, 120_000);

  it('TEETH: the same tree is refused for any other runtime version', async () => {
    const { candidate } = await runNightly();
    const tree = await extracted(candidate.bundleFile);
    const other = validateCoverageDirectory(tree, { expectedVersion: '0.0.1' });
    expect(other.valid).toBe(false);
    expect(other.failures.join('; ')).toMatch(/release version .* differs from 0\.0\.1/);
  }, 120_000);

  it('the published archive still seeds the NEXT night (its extra ledgers are overwritten, never trusted)', async () => {
    const { candidate, runtimeRoot } = await runNightly();
    const extractedSeed = await extracted(candidate.bundleFile);
    const assetsDir = path.join(tempDir(dirs, 'next'), 'assets');
    normalizeExtractedCorpus({ extractedDir: extractedSeed, assetsDir });
    fs.copyFileSync(path.join(runtimeRoot, 'kb', 'PRIVATE-STORES.json'), path.join(assetsDir, 'PRIVATE-STORES.json'));
    // corpus-reconcile's carried-store dating reads the previous generation's sealed coverage from here.
    expect(readPriorCoverage(assetsDir)?.kind).toBe('ruvnet-brain-corpus-coverage');
    writeCoverage(runtimeRoot, assetsDir);
    const outDir = path.join(tempDir(dirs, 'next-out'), 'ruvnet-brain');
    await assembleBundle({ corpusDir: assetsDir, runtimeRoot, outDir,
      identity: { version: VERSION, sourceSnapshot: BUILDER_SHA }, seedIdentity: SEED_IDENTITY });
    expect(validateCoverageDirectory(outDir, { expectedVersion: VERSION }).valid).toBe(true);
  }, 120_000);

  it('main() hands the downloaded seed archive to preparation (the CLI the workflow runs)', async () => {
    const runtimeRoot = nightlyRuntimeRoot();
    for (const name of ['external-sources.json', 'no-corpus-repos.json']) {
      fs.copyFileSync(path.join(ROOT, 'kb', name), path.join(runtimeRoot, 'kb', name));
    }
    const seedCorpus = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, seedCorpus);
    const seedOut = path.join(tempDir(dirs, 'seed'), 'ruvnet-brain');
    await assembleBundle({ corpusDir: seedCorpus, runtimeRoot, outDir: seedOut, identity: { version: VERSION, sourceSnapshot: BUILDER_SHA } });
    const zip = `${seedOut}.zip`;
    const sha = sha256File(zip);
    const work = tempDir(dirs, 'main');
    let seen = null;
    const code = await reconcileMain(['--root', runtimeRoot, '--seed-archive', zip, '--seed-tag', `corpus-sha256-${sha}`,
      '--seed-sha256', sha, '--assets', path.join(work, 'assets'), '--workspace', path.join(work, 'ws'), '--builder-sha', BUILDER_SHA],
    { reconcileAndPrepare: async (options) => { seen = options; return { reconciliation: {}, noChange: true }; },
      stdout: { write() {} }, stderr: { write() {} } });
    expect(code).toBe(0);
    expect(seen.seedArchive).toEqual({ file: zip, tag: `corpus-sha256-${sha}`, sha256: sha });
  }, 120_000);
});

// ── THE CUSTOMER ────────────────────────────────────────────────────────────────────────────────
function customerKb(seed, { brainVersion = VERSION } = {}) {
  // realpath: forge-update.mjs runs only when argv[1] equals its own (symlink-resolved) module URL.
  const home = fs.realpathSync(tempDir(dirs, 'customer'));
  const kbDir = path.join(home, 'kb');
  fs.cpSync(seed.dir, kbDir, { recursive: true });
  for (const file of UPDATER_MODULES) fs.copyFileSync(path.join(ROOT, 'kb', file), path.join(kbDir, file));
  const updater = path.join(kbDir, 'forge-update.mjs');
  fs.writeFileSync(updater, fs.readFileSync(updater, 'utf8').replace(
    /const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
    `const SIGNING_PUBKEY_PEM = \`${TEST_PUB}\`;`));
  placeTrustedCoverageValidator(kbDir, { brainVersion });
  return { home, kbDir };
}

function publish(zipBytes, tag, { signature = sign(zipBytes) } = {}) {
  served.zip = zipBytes;
  served.sig = signature;
  served.release = { tag_name: tag, published_at: '2026-09-30T07:17:00Z', body: 'Corpus generation: 2026-09-30T07:17:00.000Z',
    assets: [{ name: 'ruvnet-brain.zip', browser_download_url: `${origin}/ruvnet-brain.zip` }] };
}

function update({ home, kbDir }) {
  fs.mkdirSync(path.join(home, 'user-home'), { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(kbDir, 'forge-update.mjs'), '--apply'], { cwd: kbDir,
      env: { ...process.env, HOME: path.join(home, 'user-home'), RUVNET_SETTINGS_FILE: path.join(home, 'none.json') } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Rebuild the archive with one entry replaced or removed, exactly as a broken publisher would ship it. */
async function rezip(zip, mutate) {
  const tree = await extracted(zip);
  mutate(tree);
  const out = path.join(tempDir(dirs, 'rezip'), 'ruvnet-brain.zip');
  execFileSync('zip', ['-q', '-r', '-X', out, ...fs.readdirSync(tree)], { cwd: tree });
  return fs.readFileSync(out);
}

describe('an installed customer on the approved runtime takes the nightly through the existing updater', () => {
  it('applies it in place: SOURCE.json moves to the new generation and exactly one copy remains', async () => {
    const { candidate, seed } = await runNightly();
    const customer = customerKb(seed);
    const before = readJson(path.join(customer.kbDir, 'SOURCE.json'));
    const tag = `corpus-sha256-${sha256File(candidate.bundleFile)}`;
    publish(fs.readFileSync(candidate.bundleFile), tag);

    const { code, out } = await update(customer);

    expect(code, out).toBe(0);
    const after = readJson(path.join(customer.kbDir, 'SOURCE.json'));
    expect(after.corpusReleaseTag).toBe(tag);
    expect(after.builtUtc).not.toBe(before.builtUtc);
    expect(Object.keys(after.stores).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(validateCoverageDirectory(customer.kbDir, { expectedVersion: VERSION }).valid).toBe(true);
    // ONE installed copy: the only store bytes anywhere under the customer's home are the live kb/ ones
    // (the updater keeps receipts in .kb.update-transactions, never a second tree or a rollback copy).
    const rvfs = [];
    const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.big.rvf')) rvfs.push(path.relative(customer.home, file));
    } };
    walk(customer.home);
    expect(rvfs.sort()).toEqual(['kb/alpha.big.rvf', 'kb/beta.big.rvf', 'kb/gamma.big.rvf']);
    expect(fs.readdirSync(customer.home).filter((name) => !['user-home', '.kb.update-transactions'].includes(name))).toEqual(['kb']);
  }, 180_000);

  it('BREAK IT: an archive without COVERAGE.json is refused and the live tree is untouched', async () => {
    const { candidate, seed } = await runNightly();
    const customer = customerKb(seed);
    const before = fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json'));
    const broken = await rezip(candidate.bundleFile, (tree) => fs.rmSync(path.join(tree, 'COVERAGE.json')));
    publish(broken, `corpus-sha256-${crypto.createHash('sha256').update(broken).digest('hex')}`);

    const { code, out } = await update(customer);

    expect(code).not.toBe(0);
    expect(out).toMatch(/staged ReleaseCoverage failed integrity: COVERAGE\.json is missing/);
    expect(fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json')).equals(before)).toBe(true);
  }, 180_000);

  it('BREAK IT: one tampered byte in the sealed coverage is refused, even when re-signed', async () => {
    const { candidate, seed } = await runNightly();
    const customer = customerKb(seed);
    const before = fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json'));
    const tampered = await rezip(candidate.bundleFile, (tree) => {
      const file = path.join(tree, 'CORPUS-COVERAGE.json');
      const text = fs.readFileSync(file, 'utf8');
      // ONE byte, still valid JSON: only the digest binding in COVERAGE.json can catch it.
      expect(text).toContain('"owner": "ruvnet"');
      fs.writeFileSync(file, text.replace('"owner": "ruvnet"', '"owner": "ruvnex"'));
    });
    publish(tampered, `corpus-sha256-${crypto.createHash('sha256').update(tampered).digest('hex')}`);

    const { code, out } = await update(customer);

    expect(code).not.toBe(0);
    expect(out).toMatch(/staged ReleaseCoverage failed integrity: .*corpus coverage byte digest differs/);
    expect(fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json')).equals(before)).toBe(true);
  }, 180_000);

  it('BREAK IT: one tampered archive byte without a matching signature is refused before extraction', async () => {
    const { candidate, seed } = await runNightly();
    const customer = customerKb(seed);
    const bytes = Buffer.from(fs.readFileSync(candidate.bundleFile));
    const signature = sign(bytes);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    publish(bytes, `corpus-sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}`, { signature });

    const { code, out } = await update(customer);

    expect(code).toBe(4);
    expect(out).toMatch(/SIGNATURE VERIFICATION FAILED/);
  }, 180_000);

  it('KEEPS THE GUARD: a customer on a different runtime refuses the same archive and remembers it', async () => {
    const { candidate, seed } = await runNightly();
    const customer = customerKb(seed, { brainVersion: '0.0.1' });
    const before = fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json'));
    publish(fs.readFileSync(candidate.bundleFile), `corpus-sha256-${sha256File(candidate.bundleFile)}`);

    const { code, out } = await update(customer);

    expect(code).toBe(5);
    expect(out).toMatch(/INCOMPATIBLE corpus release/);
    expect(out).toMatch(new RegExp(`built by runtime ${VERSION.replaceAll('.', '\\.')}`));
    expect(fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json')).equals(before)).toBe(true);
  }, 180_000);
});
