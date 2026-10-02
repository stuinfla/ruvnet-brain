// tests/unit/corpus-canary.test.mjs — the customer canary: the producer cannot declare success unless
// the consumer accepted.
//
// Measured defect (2026-08-21 .. 2026-09-30): nightly corpus generations reached releases/latest that no
// installed customer could apply (no COVERAGE.json inside the archive; kb/forge-update.mjs refused every
// night). Every producer-side gate was green. scripts/corpus-canary.mjs asks the consumer's question
// instead, and scripts/corpus-promotion.mjs evaluateCanaryVerdict makes its PASS the only door to latest.
//
// OFFLINE CUSTOMER SIMULATION (the pattern of tests/unit/nightly-corpus-zip-coverage.test.mjs): the REAL
// prepareCorpusCandidate builds tonight's archive from a REAL previous generation; a customer tree is that
// previous generation with the installer's own placeTrustedCoverageValidator (RUNTIME-IDENTITY.json) and
// reader node_modules; the updater is the REAL kb/forge-update.mjs module graph with ONLY its embedded
// trust root swapped for a test key (the real archive is signed by RUVNET_SIGNING_KEY, which no test
// holds); GitHub is a 127.0.0.1 server serving `releases/tags/<tag>` with real asset digests. Only the
// install phase is seamed (runCanary's `install`), because in CI it is `npm install ruvnet-brain@<v>` +
// the real installer downloading ~555 MB; everything after it — rewrite, apply, judge, verdict — is real.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { prepareCorpusCandidate } from '../../scripts/corpus-reconcile.mjs';
import { extractZip } from '../../kb/zip-extract.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { evaluateCanaryVerdict, REQUIRED_CANARY_CHECKS } from '../../scripts/corpus-promotion.mjs';
import {
  customerEnv, pointUpdaterAtCandidate, runCanary, storeFreshness, suppliedKbInstaller, FRESHNESS_LIMIT_MS,
} from '../../scripts/corpus-canary.mjs';
import { SEED_IDENTITY, buildCorpus, buildRuntimeRoot, readJson, sha256File, tempDir, writeCoverage } from '../helpers/assemble-bundle-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { placeTrustedCoverageValidator } = await import('../../bin/install.mjs');

const REPO = 'stuinfla/ruvnet-brain';
const VERSION = getVersion();
const BUILDER_SHA = 'c'.repeat(40);
const UPDATER_MODULES = ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
  'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs'];
// The fixture coverage is observed at 2026-09-13T00:00Z (tests/helpers/assemble-bundle-fixture.mjs).
const NOW = Date.parse('2026-09-13T06:00:00.000Z');
const READER_MODULES = ['@babel/parser', '@ruvector/rvf', '@xenova/transformers'];

const KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const sign = (bytes) => crypto.sign(null, crypto.createHash('sha256').update(bytes).digest(), KEYS.privateKey);

const shared = [];
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

// ── a GitHub that serves exactly one staged candidate ────────────────────────────────────────────
let server; let origin; const hits = [];
const served = { tag: null, zip: null, sig: null, failFirstManifest: 0, manifestHits: 0 };
function releasePayload() {
  const digest = crypto.createHash('sha256').update(served.zip).digest('hex');
  const assets = [
    { name: 'ruvnet-brain.zip', size: served.zip.length, digest: `sha256:${digest}`, browser_download_url: `${origin}/dl/ruvnet-brain.zip` },
    ...(served.sig ? [{ name: 'ruvnet-brain.zip.sig', size: served.sig.length,
      digest: `sha256:${crypto.createHash('sha256').update(served.sig).digest('hex')}`, browser_download_url: `${origin}/dl/ruvnet-brain.zip.sig` }] : []),
  ];
  return { tag_name: served.tag, draft: false, prerelease: true, published_at: '2026-09-13T01:00:00Z',
    body: 'Corpus generation: 2026-09-13T00:30:00.000Z', assets };
}
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === `/repos/${REPO}/releases/tags/${served.tag}`) {
      served.manifestHits += 1;
      // The canary's own read is hit 1; the updater's first manifest read is hit 2.
      if (served.manifestHits > 1 && served.failFirstManifest > 0) { served.failFirstManifest -= 1; res.writeHead(503).end('busy'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(releasePayload())); return;
    }
    if (req.url === `/repos/${REPO}/releases/latest`) { res.writeHead(500).end('the canary must never poll latest'); return; }
    if (req.url === '/dl/ruvnet-brain.zip.sig' && served.sig) { res.writeHead(200); res.end(served.sig); return; }
    if (req.url === '/dl/ruvnet-brain.zip') { res.writeHead(200); res.end(served.zip); return; }
    res.writeHead(404).end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  while (shared.length) fs.rmSync(shared.pop(), { recursive: true, force: true });
});

// ── tonight's nightly, built ONCE through the real preparation path ──────────────────────────────
let nightly;
async function buildNightly() {
  if (nightly) return nightly;
  const runtimeRoot = buildRuntimeRoot(shared);
  fs.mkdirSync(path.join(runtimeRoot, 'scripts', 'oracle'), { recursive: true });
  for (const file of ['build-bundle.mjs', 'corpus-candidate.mjs', 'public-verification-inputs.mjs', 'oracle/retrieval-accuracy.mjs', 'oracle/repo-recall.mjs']) {
    fs.writeFileSync(path.join(runtimeRoot, 'scripts', file), '// routed to the real implementation by the test run seam\n');
  }
  for (const file of ['retrieval-accuracy-oracle.json', 'repo-recall-floor.json']) fs.writeFileSync(path.join(runtimeRoot, 'data', file), '{}');
  fs.copyFileSync(path.join(ROOT, 'data', 'retrieval-query-evidence.json'), path.join(runtimeRoot, 'data', 'retrieval-query-evidence.json'));

  const seedCorpus = await buildCorpus(shared, { runtimeRoot, stores: ['alpha', 'beta'] });
  writeCoverage(runtimeRoot, seedCorpus);
  const seedOut = path.join(tempDir(shared, 'seed'), 'ruvnet-brain');
  await assembleBundle({ corpusDir: seedCorpus, runtimeRoot, outDir: seedOut,
    identity: { version: VERSION, sourceSnapshot: BUILDER_SHA }, seedIdentity: SEED_IDENTITY });
  const seedZip = `${seedOut}.zip`;
  const seed = { file: seedZip, tag: `corpus-sha256-${sha256File(seedZip)}`, sha256: sha256File(seedZip), dir: seedOut };

  const corpusDir = await buildCorpus(shared, { runtimeRoot, stores: ['alpha', 'beta', 'gamma'] });
  const coverage = writeCoverage(runtimeRoot, corpusDir);
  const out = tempDir(shared, 'nightly');
  const driver = path.join(tempDir(shared, 'driver'), 'assemble.mjs');
  fs.writeFileSync(driver, `import { assembleBundle } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'build-bundle.mjs')).href)};
await assembleBundle(JSON.parse(process.env.ASSEMBLE_OPTIONS));\n`);
  const candidate = prepareCorpusCandidate({
    root: runtimeRoot, assetsDir: corpusDir, builderSha: BUILDER_SHA,
    candidateDir: path.join(out, 'candidate', 'ruvnet-brain'), receiptFile: path.join(out, 'evidence', 'corpus-receipt.json'),
    coverageFile: path.join(runtimeRoot, 'data', 'source-coverage.json'), coverage,
    seedArchive: { file: seed.file, tag: seed.tag, sha256: seed.sha256 },
    run: (command, args) => {
      const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
      if (args[0].endsWith(`${path.sep}build-bundle.mjs`)) {
        const seedIdentity = flag('--seed-tag') === undefined ? null : { tag: flag('--seed-tag'), archiveSha256: flag('--seed-sha256'),
          archiveBytes: Number(flag('--seed-bytes')), baselineReceiptSha256: flag('--baseline-receipt-sha256') };
        const options = { corpusDir: flag('--assets'), runtimeRoot, outDir: flag('--out'), seedIdentity,
          identity: { version: flag('--version'), sourceSnapshot: flag('--source-snapshot') } };
        return spawnSync(process.execPath, [driver], { encoding: 'utf8', env: { ...process.env, ASSEMBLE_OPTIONS: JSON.stringify(options) } });
      }
      if (args[0].endsWith(`${path.sep}public-verification-inputs.mjs`)) {
        return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'public-verification-inputs.mjs'), ...args.slice(1)], { encoding: 'utf8' });
      }
      return { status: 0, stdout: '', stderr: '' }; // retrieval oracles + receipt seal: read-only, own suites
    },
  });
  nightly = { zip: fs.readFileSync(candidate.bundleFile), seed };
  return nightly;
}

/** What `npx ruvnet-brain@<approved>` leaves behind, built offline: the previous generation, the
 * installer's validator + runtime stamp, reader node_modules, and the customer-channel manifest URL. */
function customerInstall({ brainVersion = VERSION, updaterPatch = null } = {}) {
  const home = fs.realpathSync(tempDir(dirs, 'customer-home'));
  const kbDir = path.join(home, '.cache', 'ruvnet-brain', 'kb');
  fs.cpSync(nightly.seed.dir, kbDir, { recursive: true });
  for (const file of UPDATER_MODULES) fs.copyFileSync(path.join(ROOT, 'kb', file), path.join(kbDir, file));
  const updater = path.join(kbDir, 'forge-update.mjs');
  let source = fs.readFileSync(updater, 'utf8');
  const swapped = source.replace(/const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
    `const SIGNING_PUBKEY_PEM = \`${TEST_PUB}\`;`);
  expect(swapped).not.toBe(source); // the trust-root swap is the ONLY test-side change to the updater
  source = updaterPatch ? updaterPatch(swapped) : swapped;
  fs.writeFileSync(updater, source);
  placeTrustedCoverageValidator(kbDir, { brainVersion });
  for (const name of READER_MODULES) {
    fs.mkdirSync(path.join(kbDir, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.0.0-fixture' }));
  }
  const sourceFile = path.join(kbDir, 'SOURCE.json');
  fs.writeFileSync(sourceFile, JSON.stringify({ ...readJson(sourceFile), canonicalManifestUrl: `${origin}/repos/${REPO}/releases/latest` }));
  return { home, kbDir };
}

function stage(zipBytes, { signed = true, signature = null } = {}) {
  served.zip = zipBytes;
  served.sig = signed ? (signature || sign(zipBytes)) : null;
  served.tag = `corpus-sha256-${crypto.createHash('sha256').update(zipBytes).digest('hex')}`;
  served.manifestHits = 0;
  served.failFirstManifest = 0;
  return served.tag;
}

async function canary(customer, { tag = served.tag, approvedVersion = VERSION, now = NOW, footprintUpdates = false } = {}) {
  const work = tempDir(dirs, 'canary-work');
  const before = fs.readFileSync(path.join(customer.kbDir, 'SOURCE.json'));
  const verdict = await runCanary({ repo: REPO, tag, approvedVersion, work, apiBase: origin, home: customer.home,
    install: () => ({ kbDir: customer.kbDir }), env: { GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1' },
    now: () => now, retryDelayMs: 0, footprintUpdates });
  return { verdict, before, work, check: (name) => verdict.checks.find((entry) => entry.name === name) };
}

/** The live tree is untouched: SOURCE.json differs only by the canary's own manifest rewrite. */
const untouched = (customer, before) => {
  const { canonicalManifestUrl: _after, ...now } = readJson(path.join(customer.kbDir, 'SOURCE.json'));
  const { canonicalManifestUrl: _before, ...then } = JSON.parse(before.toString('utf8'));
  return JSON.stringify(now) === JSON.stringify(then) && _after.endsWith(`/releases/tags/${served.tag}`);
};

async function rezip(zip, mutate) {
  const tree = tempDir(dirs, 'rezip-tree');
  const file = path.join(tree, 'in.zip');
  fs.writeFileSync(file, zip);
  const extracted = path.join(tree, 'x');
  await extractZip(file, extracted);
  mutate(extracted);
  const out = path.join(tree, 'ruvnet-brain.zip');
  execFileSync('zip', ['-q', '-r', '-X', out, ...fs.readdirSync(extracted)], { cwd: extracted });
  return fs.readFileSync(out);
}

const promotable = (verdict) => evaluateCanaryVerdict({ verdict, tag: verdict.tag, runId: '4242', runAttempt: '1',
  approvedTag: `v${VERSION}`, releaseAssets: releasePayload().assets.map(({ name, digest }) => ({ name, digest })) });

describe('the customer canary applies the staged candidate through a real customer install', () => {
  beforeAll(async () => { await buildNightly(); }, 180_000);

  it('GREEN: every required check passes, the verdict binds this run and the asset digests, and it is promotable', async () => {
    const tag = stage(nightly.zip);
    const customer = customerInstall();
    const { verdict, check } = await canary(customer);

    expect(verdict.checks.filter((entry) => !entry.ok), JSON.stringify(verdict.checks, null, 2)).toEqual([]);
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.checks.map((entry) => entry.name).sort()).toEqual([...REQUIRED_CANARY_CHECKS].sort());
    expect(verdict).toMatchObject({ tag, runId: '4242', runAttempt: '1', approvedVersion: VERSION,
      archiveSha256: tag.slice('corpus-sha256-'.length), updater: { exitCode: 0, attempts: 1, terminalVerdict: 'applied' } });
    expect(check('signature-verified').detail).toMatch(/embedded key/);
    expect(check('node-modules').detail).toMatch(/3 reader package\(s\) intact/);
    expect(check('single-kb-tree').detail).toMatch(/^1 KB tree\(s\) \[\.cache\/ruvnet-brain\/kb\], 3 \.big\.rvf, 0 outside/);
    // What landed is the candidate: the customer's SOURCE.json now names it.
    expect(readJson(path.join(customer.kbDir, 'SOURCE.json')).corpusReleaseTag).toBe(tag);
    // The canary polled the candidate tag, never releases/latest (the server 500s on latest).
    expect(hits.some((url) => url.endsWith('/releases/latest'))).toBe(false);
    expect(promotable(verdict)).toMatchObject({ allowed: true });
  }, 180_000);

  it('BREAK IT (unsigned): no .sig on the release -> updater exit 3, FAIL, live tree untouched, NOT promotable', async () => {
    stage(nightly.zip, { signed: false });
    const customer = customerInstall();
    const { verdict, before, check } = await canary(customer);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.updater.exitCode).toBe(3);
    expect(check('signature-verified').ok).toBe(false);
    expect(check('candidate-release').detail).toMatch(/no detached ruvnet-brain\.zip\.sig/);
    expect(untouched(customer, before)).toBe(true);
    expect(promotable(verdict).allowed).toBe(false);
  }, 180_000);

  it('BREAK IT (forged signature): signed by a key the shipped updater does not carry -> exit 4, FAIL', async () => {
    const attacker = crypto.generateKeyPairSync('ed25519');
    stage(nightly.zip, { signature: crypto.sign(null, crypto.createHash('sha256').update(nightly.zip).digest(), attacker.privateKey) });
    const { verdict } = await canary(customerInstall());
    expect(verdict.updater.exitCode).toBe(4);
    expect(verdict.verdict).toBe('FAIL');
    expect(promotable(verdict).allowed).toBe(false);
  }, 180_000);

  it('BREAK IT (coverage missing): the 40-day defect itself -> the updater refuses, FAIL, NOT promotable', async () => {
    stage(await rezip(nightly.zip, (tree) => fs.rmSync(path.join(tree, 'COVERAGE.json'))));
    const customer = customerInstall();
    const { verdict, before } = await canary(customer);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.updater.exitCode).not.toBe(0);
    expect(verdict.checks.find((entry) => entry.name === 'updater-exit').ok).toBe(false);
    expect(untouched(customer, before)).toBe(true);
    expect(promotable(verdict).allowed).toBe(false);
  }, 180_000);

  it('BREAK IT (wrong runtime): a corpus built for another runtime than the installed one -> exit 5, FAIL', async () => {
    stage(nightly.zip);
    const { verdict } = await canary(customerInstall({ brainVersion: '0.0.1' }), { approvedVersion: '0.0.1' });
    expect(verdict.updater.exitCode).toBe(5);
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.checks.find((entry) => entry.name === 'source-advanced').ok).toBe(false);
    // And a verdict for another runtime can never promote the approved one.
    expect(promotable({ ...verdict, verdict: 'PASS' }).allowed).toBe(false);
  }, 180_000);

  it('BREAK IT (node_modules dropped): an updater that no longer carries the reader deps applies "successfully" -> FAIL', async () => {
    stage(nightly.zip);
    // kb/forge-update.mjs carryLiveNodeModules() is the one carrier; the guard line is its early return.
    const carry = "if (!fs.existsSync(liveModules) || fs.existsSync(path.join(candidateDir, 'node_modules'))) return false;";
    const customer = customerInstall({ updaterPatch: (source) => {
      expect(source).toContain(carry); // the regression is re-created exactly, or the test is void
      return source.replace(carry, 'return false;');
    } });
    const { verdict } = await canary(customer);
    // The updater itself exits 0 — only the consumer-side check catches this.
    expect(verdict.updater).toMatchObject({ exitCode: 0, terminalVerdict: 'applied' });
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.checks.find((entry) => entry.name === 'node-modules')).toMatchObject({ ok: false });
    expect(verdict.checks.find((entry) => entry.name === 'node-modules').detail).toMatch(/dropped by the update: @babel\/parser, @ruvector\/rvf, @xenova\/transformers/);
    expect(promotable(verdict).allowed).toBe(false);
  }, 180_000);

  it('BREAK IT (two KB trees): a second brain tree left in the customer home (e.g. a stranded fallback install) -> FAIL', async () => {
    stage(nightly.zip);
    const customer = customerInstall();
    const stray = path.join(customer.home, '.cache', 'ruvnet-brain', 'kb-fallback');
    fs.mkdirSync(stray, { recursive: true });
    for (const file of ['SOURCE.json', 'forge-update.mjs', 'alpha.big.rvf']) fs.copyFileSync(path.join(customer.kbDir, file), path.join(stray, file));
    const { verdict } = await canary(customer);
    expect(verdict.updater.exitCode).toBe(0);
    expect(verdict.checks.find((entry) => entry.name === 'single-kb-tree')).toMatchObject({ ok: false });
    expect(verdict.checks.find((entry) => entry.name === 'single-kb-tree').detail).toMatch(/^2 KB tree\(s\).*1 outside the live KB/);
    expect(verdict.verdict).toBe('FAIL');
  }, 180_000);

  it('BREAK IT (stale knowledge): the same candidate judged 72h after its upstream observation -> FAIL on freshness', async () => {
    stage(nightly.zip);
    const { verdict } = await canary(customerInstall(), { now: Date.parse('2026-09-16T00:00:00.000Z') });
    expect(verdict.checks.find((entry) => entry.name === 'store-freshness')).toMatchObject({ ok: false });
    expect(verdict.verdict).toBe('FAIL');
  }, 180_000);

  it('a transient 503 on the manifest is retried (exit 2 only) and the retry is recorded', async () => {
    stage(nightly.zip);
    served.failFirstManifest = 1;
    const { verdict } = await canary(customerInstall());
    expect(verdict.updater).toMatchObject({ exitCode: 0, attempts: 2 });
    expect(verdict.verdict).toBe('PASS');
  }, 180_000);
});

describe('the canary asks more than one customer state (--cases)', () => {
  beforeAll(async () => { await buildNightly(); }, 180_000);
  const casesCanary = (makeCustomer, cases) => runCanary({ repo: REPO, tag: served.tag, approvedVersion: VERSION,
    work: tempDir(dirs, 'canary-cases'), apiBase: origin, env: { GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1' },
    now: () => NOW, retryDelayMs: 0, cases, install: () => makeCustomer() });

  it('runs the private-overlay case as its own fresh install, prefixes its checks, and measures the private bytes', async () => {
    stage(nightly.zip);
    const verdict = await casesCanary(() => customerInstall(), ['clean', 'private-overlay']);
    const names = verdict.checks.map((entry) => entry.name);
    for (const name of REQUIRED_CANARY_CHECKS) {
      expect(names).toContain(name);
      expect(names).toContain(`private-overlay:${name}`);
    }
    expect(names).toContain('private-overlay:private-store-preserved');
    // Every check of BOTH cases is green on a correct updater — named, not inferred from the verdict.
    const failing = verdict.checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`);
    expect(failing).toEqual([]);
    const preserved = verdict.checks.find((entry) => entry.name === 'private-overlay:private-store-preserved');
    expect(preserved).toMatchObject({ ok: true });
    expect(preserved.detail).toMatch(/^[1-9]\d* private file\(s\) byte-identical$/);
    expect(verdict.verdict).toBe('PASS');
  }, 300_000);

  it('an extra case is never run on the clean case\'s KB (the --installed-kb brain is not mutated)', async () => {
    stage(nightly.zip);
    const shared = customerInstall(); // the SAME KB handed to every case, as --installed-kb used to
    const fenceFile = path.join(shared.kbDir, 'PRIVATE-STORES.json');
    const fenceBefore = fs.existsSync(fenceFile) ? fs.readFileSync(fenceFile, 'utf8') : null;
    const verdict = await casesCanary(() => shared, ['clean', 'private-overlay']);
    expect(verdict.checks.find((entry) => entry.name === 'private-overlay:case-ran'))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/handed the clean case's KB/) });
    expect(verdict.verdict).toBe('FAIL');
    expect(fs.existsSync(fenceFile) ? fs.readFileSync(fenceFile, 'utf8') : null).toBe(fenceBefore);
    expect(fs.readdirSync(shared.kbDir).filter((name) => name.startsWith('acme-private-notes'))).toEqual([]);
  }, 300_000);

  it('--installed-kb gives each extra case its own copy of the KB as it was before the clean case ran', () => {
    const work = tempDir(dirs, 'supplied-work');
    const supplied = tempDir(dirs, 'supplied-kb');
    fs.writeFileSync(path.join(supplied, 'PRIVATE-STORES.json'), '{"privateStores":[]}\n');
    fs.writeFileSync(path.join(supplied, 'store.big.rvf'), 'original');
    const install = suppliedKbInstaller({ installedKb: supplied, work, cases: ['clean', 'private-overlay'] });
    expect(install({ work, home: path.join(work, 'home') })).toEqual({ kbDir: path.resolve(supplied) });
    fs.writeFileSync(path.join(supplied, 'store.big.rvf'), 'updated by the clean case');
    const caseWork = path.join(work, 'case-private-overlay');
    const own = install({ work: caseWork, home: path.join(caseWork, 'home') });
    expect(path.relative(caseWork, own.kbDir).startsWith('..')).toBe(false);
    expect(fs.readFileSync(path.join(own.kbDir, 'store.big.rvf'), 'utf8')).toBe('original');
    fs.writeFileSync(path.join(own.kbDir, 'PRIVATE-STORES.json'), '{"privateStores":["acme-private-notes"]}\n');
    expect(fs.readFileSync(path.join(supplied, 'PRIVATE-STORES.json'), 'utf8')).toBe('{"privateStores":[]}\n');
  });

  it('BREAK IT (overlay dropped): an updater that stops restoring private files passes clean but FAILS the overlay case', async () => {
    stage(nightly.zip);
    const restore = 'restorePrivateFilesIntoCandidate({ candidateDir, sourceDir: liveDir, overlay: privateOverlay });';
    const verdict = await casesCanary(() => customerInstall({ updaterPatch: (source) => {
      expect(source).toContain(restore);
      return source.replace(restore, '');
    } }), ['clean', 'private-overlay']);
    expect(verdict.checks.filter((entry) => !entry.name.includes(':')).every((entry) => entry.ok)).toBe(true);
    expect(verdict.checks.filter((entry) => entry.name.startsWith('private-overlay:') && !entry.ok).length).toBeGreaterThan(0);
    expect(verdict.checks.find((entry) => entry.name === 'private-overlay:private-store-preserved'))
      .toMatchObject({ ok: false, detail: expect.stringMatching(/^private files changed or lost: /) });
    expect(verdict.verdict).toBe('FAIL');
    expect(promotable(verdict).allowed).toBe(false);
  }, 300_000);

  it('refuses a case list that does not start with the clean case or names an unknown case', async () => {
    await expect(casesCanary(() => customerInstall(), ['private-overlay'])).rejects.toThrow(/must start with clean/);
    await expect(casesCanary(() => customerInstall(), ['clean', 'nope'])).rejects.toThrow(/must start with clean/);
  });
});

describe('the one change the canary makes to a customer install', () => {
  it('rewrites only releases/latest -> releases/tags/<tag>, and refuses any other channel', () => {
    const kbDir = tempDir(dirs, 'point');
    const tag = `corpus-sha256-${'a'.repeat(64)}`;
    const original = { builtUtc: 'x', stores: { a: { canonicalManifestUrl: null } }, canonicalManifestUrl: `https://api.github.com/repos/${REPO}/releases/latest` };
    fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify(original));
    const { manifestUrl } = pointUpdaterAtCandidate({ kbDir, repo: REPO, tag });
    expect(manifestUrl).toBe(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`);
    expect(readJson(path.join(kbDir, 'SOURCE.json'))).toEqual({ ...original, canonicalManifestUrl: manifestUrl });
    fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ ...original, canonicalManifestUrl: 'https://example.invalid/manifest.json' }));
    expect(() => pointUpdaterAtCandidate({ kbDir, repo: REPO, tag })).toThrow(/not the customer channel/);
  });

  it('the customer child environment carries no inherited token and no host CLI directory', () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'must-not-leak';
    try {
      const env = customerEnv({ home: '/h', work: '/w' });
      expect(Object.values(env)).not.toContain('must-not-leak');
      expect(Object.keys(env).filter((key) => /TOKEN|SECRET|KEY/.test(key))).toEqual([]);
      expect(env.PATH.split(path.delimiter)).toEqual([path.dirname(process.execPath), '/usr/bin', '/bin']);
      expect(env.HOME).toBe('/h');
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous;
    }
  });
});

describe('storeFreshness (pure)', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  const row = (key, upstream, built, ingestedAt = '2026-09-30T08:00:00Z', status = 'CURRENT') => ({ key, status,
    upstream: { sha: upstream }, artifact: { store: key, sourceCommit: built, ingestedAt } });
  const cov = (rows, observedAt = '2026-09-30T07:40:00Z') => ({ observedAt, rows });
  it('passes a fresh observation with every eligible store at its upstream commit', () => {
    expect(storeFreshness({ after: cov([row('a', '1', '1'), row('b', '2', null, null, 'MISSING')]), now }).ok).toBe(true);
  });
  it('fails an observation older than 48h and a stale store; a moved store ingested long ago is FRESH if it is at its upstream commit', () => {
    expect(storeFreshness({ after: cov([row('a', '1', '1')], new Date(now - FRESHNESS_LIMIT_MS - 1).toISOString()), now }).detail).toMatch(/limit 48h/);
    expect(storeFreshness({ after: cov([row('a', '2', '1')]), now }).detail).toMatch(/1 store\(s\) built from a commit older than their observed upstream: a/);
    // MEASURED 2026-09-30: a store keeps the ingestion time of the last night its upstream moved. A store that
    // moved since the install's generation but was ingested 10 days ago is still exactly at its upstream
    // commit, so it is fresh. The old "moved store ingested >48h ago" rule refused exactly this (about three
    // nights after any code release) and would have blocked every nightly.
    expect(storeFreshness({ after: cov([row('a', '2', '2', '2026-09-20T00:00:00Z')]), before: cov([row('a', '1', '1')]), now }).ok).toBe(true);
    // An unmoved store may legitimately carry an old ingestion time.
    expect(storeFreshness({ after: cov([row('a', '1', '1', '2026-09-01T00:00:00Z')]), before: cov([row('a', '1', '1')]), now }).ok).toBe(true);
    expect(storeFreshness({ after: null, now }).ok).toBe(false);
  });
});

// ADR-0098: the opt-in three-update footprint check (--footprint-updates). Measured here on the offline
// fixture; its runtime on the real ~1.4 GB brain is unmeasured, which is why it is not on by default.
describe('footprint-three-updates (opt-in canary check)', () => {
  beforeAll(async () => { await buildNightly(); }, 180_000);

  it('GREEN: apply + two more updates leave exactly one KB, within budget, with no net growth', async () => {
    stage(nightly.zip);
    const started = Date.now();
    const { verdict, check } = await canary(customerInstall(), { footprintUpdates: true });
    expect(check('footprint-three-updates'), JSON.stringify(verdict.checks, null, 2)).toMatchObject({ ok: true });
    expect(check('footprint-three-updates').detail).toMatch(/^3 updates: 1 KB copy each time, within budget/);
    expect(verdict.verdict).toBe('PASS');
    expect(Date.now() - started).toBeLessThan(120_000);
  }, 180_000);

  it('BREAK IT: an updater that leaves its rollback copy behind -> the check goes red', async () => {
    stage(nightly.zip);
    const anchor = 'transaction = runStorageTransaction({ liveDir: KB_DIR, sourceDir: extractDir,';
    const customer = customerInstall({ updaterPatch: (source) => {
      expect(source).toContain(anchor);
      return source.replace(anchor, `${anchor} removeRollback: () => {},`);
    } });
    const { verdict, check } = await canary(customer, { footprintUpdates: true });
    expect(verdict.updater.exitCode).toBe(0); // the updater itself reports success
    expect(check('footprint-three-updates')).toMatchObject({ ok: false });
    expect(check('footprint-three-updates').detail).toMatch(/update 1: 2 KB copies \(.*kb\.rollback-/);
    expect(verdict.verdict).toBe('FAIL');
  }, 180_000);

  it('is absent unless asked for (default-off)', async () => {
    stage(nightly.zip);
    const { check } = await canary(customerInstall());
    expect(check('footprint-three-updates')).toBeUndefined();
  }, 180_000);
});
