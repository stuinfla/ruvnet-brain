/**
 * `forge-update.mjs --apply`, end to end, against a real local release: the exit code AND the
 * rollback copy, in the same run — because in issues #106 and #108 they were the same run.
 *
 *   #106  the run knew it had failed, said so in the log, and still exited 0 through the caller.
 *   #108  the run had actually SUCCEEDED, aborted on a store that was legitimately unchanged, and
 *         the abort jumped straight over the release step — ~1.6 GB stranded per night, ten copies
 *         (~16 GB) before the owner noticed. Their workaround was to run the updater, IGNORE its
 *         exit code, and call reclaimBackups() by hand.
 *
 * So every case here asserts both halves: what the process exits with, and what it leaves on disk.
 * A truthful exit code that strands 1.6 GB is only half a fix, and so is a clean disk that lies.
 *
 * Nothing is mocked below the network boundary — a real zip, a real extraction, a real directory
 * swap, real rollback copies — because the property under test is what ends up on the filesystem.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { coverageGenerationFor, releaseCoverageGenerationFor } from '../../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from '../../scripts/public-inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The trusted coverage validator reaches a live KB through the INSTALLER (bin/install.mjs), never
// through the bundle it validates. This fixture obtains it the way production does. Until
// 2026-09-12 this file hand-copied plugin/scripts/coverage-integrity.mjs into the fixture and into
// every fixture BUNDLE — which is exactly why the suite never saw that no production path placed it.
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { placeTrustedCoverageValidator, serverDependencies } = await import('../../bin/install.mjs');
// The updater's module graph is DERIVED (never hand-listed: a new sibling import would silently rot a hand list).
function copyUpdater(fromDir, toDir) {
  const entry = path.join(fromDir, 'forge-update.mjs');
  fs.copyFileSync(entry, path.join(toDir, 'forge-update.mjs'));
  for (const dep of serverDependencies(entry)) {
    const target = path.resolve(toDir, dep.spec);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dep.from, target);
  }
}
const TRUSTED_VALIDATOR_BYTES = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'coverage-integrity.mjs'));
// Use each host's real archive writer; Windows does not ship the POSIX zip command.
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

const STORE_A = { kbName: 'alpha', sourceCommit: 'aaa111aaa111', sourceDescribe: 'v2.0.0', builtUtc: '2026-07-28T15:04:51.856Z' };
const STORE_B = { kbName: 'beta', sourceCommit: 'bbb222bbb222', sourceDescribe: 'v1.4.0', builtUtc: '2026-07-28T14:59:34.177Z' };
const STORE_B_NEW = { kbName: 'beta', sourceCommit: 'ccc333ccc333', sourceDescribe: 'v1.5.0', builtUtc: '2026-08-02T11:00:00.000Z' };

const TEST_SIGNING_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_SIGNING_PUB = TEST_SIGNING_KEYS.publicKey.export({ type: 'spki', format: 'pem' }).trim();
let server; let origin; let served = { release: null, zip: null, sig: null, stallZip: false, hits: { zip: 0, sig: 0 } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/releases/latest')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(served.release));
      return;
    }
    if (req.url.startsWith('/bundle.zip.sig')) {
      served.hits.sig += 1;
      if (!served.sig) { res.writeHead(404).end('missing'); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(served.sig);
      return;
    }
    if (req.url.startsWith('/bundle.zip')) {
      served.hits.zip += 1;
      if (served.stallZip) { // headers and a first chunk, then nothing: a download in progress on a slow link
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': served.zip.length });
        res.write(served.zip.subarray(0, 64));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.end(served.zip);
      return;
    }
    res.writeHead(404).end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

let root; let kbDir;
beforeEach(() => {
  served.hits = { zip: 0, sig: 0 }; served.stallZip = false;
  // realpath: on macOS os.tmpdir() is /var/... which is a symlink to /private/var/..., and
  // forge-update.mjs only runs main() when import.meta.url matches argv[1] — an unresolved path
  // silently no-ops the whole script.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-apply-')));
  kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  copyUpdater(path.join(ROOT, 'kb'), kbDir);
  const updater = path.join(kbDir, 'forge-update.mjs');
  const updaterSource = fs.readFileSync(updater, 'utf8').replace(
    /const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
    `const SIGNING_PUBKEY_PEM = \`${TEST_SIGNING_PUB}\`;`,
  );
  fs.writeFileSync(updater, updaterSource);
  // The live KB was installed by the installer, which places the trusted validator beside the updater.
  placeTrustedCoverageValidator(kbDir);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** A SOURCE.json in the shape this project publishes: bundle identity on top, stores beneath. */
function sourceJson({ releaseTag, brainVersion, builtUtc, stores }) {
  return {
    builder: 'rvf-kb-forge',
    builtUtc,
    brainVersion,
    releaseTag,
    canonicalManifestUrl: `${origin}/releases/latest`,
    stores: Object.fromEntries(stores.map((s) => [s.kbName, { ...s, canonicalManifestUrl: `${origin}/releases/latest` }])),
  };
}

/** Lay a KB down on disk: SOURCE.json plus one .rvf per store, so inventories are comparable. */
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
    const bytes = Buffer.alloc(512, 7);
    fs.writeFileSync(path.join(dir, `${name}.big.rvf`), bytes);
    publicLedger.stores[name] = { file: `${name}.big.rvf`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, sourceCommit: source.stores[name].sourceCommit || null,
      model: 'fixture-model', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z' };
  }
  const publicLedgerBytes = Buffer.from(`${JSON.stringify(publicLedger)}\n`);
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), `${JSON.stringify({ ...publicLedger,
    kind: 'ruvnet-brain-runtime-generation-ledger' })}\n`);
  fs.writeFileSync(path.join(dir, 'PUBLIC-RVF-GENERATIONS.json'), publicLedgerBytes);
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  fs.writeFileSync(path.join(dir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  const rows = storeNames.map((name) => ({ key: `repo:${name}`, kind: 'repository', name,
    url: `https://github.com/ruvnet/${name}`, status: 'CURRENT', disposition: 'eligible', upstream: {},
    artifact: { store: name }, reasons: [] }));
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0,
    repositories: { expected: rows.length, pages: [] }, gists: { expected: 0, pages: [] } };
  const generatorSourceSha = 'a'.repeat(64);
  const snapshotRoot = 'b'.repeat(64);
  const sourceObservationSha256 = 'c'.repeat(64);
  const policy = { policyDispositionDigests: [], exemptionDigests: [] };
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', generatorSourceSha,
    snapshotRoot, sourceObservationSha256, rows, enumerationReceipt, policy,
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
    // A published bundle ships the updater's module graph — and NOT coverage-integrity.mjs, which
    // build-bundle.mjs cannot see behind the updater's dynamic load. The fixture bundle must match.
    copyUpdater(kbDir, dir);
  }
}

/** Publish `source` as the single .zip asset of a release tagged `tag`. */
function publish(source, tag, mutateStage = () => {}) {
  const stage = path.join(root, `stage-${tag}`);
  layDown(stage, source);
  mutateStage(stage);
  const zipPath = path.join(root, `bundle-${tag}.zip`);
  archiveDirectory(stage, zipPath);
  served.zip = fs.readFileSync(zipPath);
  const digest = crypto.createHash('sha256').update(served.zip).digest();
  served.sig = crypto.sign(null, digest, TEST_SIGNING_KEYS.privateKey);
  served.release = {
    tag_name: tag,
    // Later than every store's forge time, exactly as a real Release is — the timestamp path must
    // not be what makes these cases behave, or the test would be measuring the wrong signal.
    published_at: '2026-08-03T00:00:00.000Z',
    assets: [{ name: 'ruvnet-brain-kb-bundle.zip', browser_download_url: `${origin}/bundle.zip` }],
  };
}

/**
 * ASYNC on purpose. The fake release is served from this very process, so a synchronous spawn would
 * block the event loop that has to answer the updater's fetch — the test would deadlock, not fail.
 */
function runWithEnv(extraEnv, ...args) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // Model Windows' real cwd lock on every host, while retaining real filesystem swaps.
  const preload = path.join(root, 'cwd-lock.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path');
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  const relative = path.relative(path.resolve(from), process.cwd());
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    const error = new Error('EBUSY: cannot rename the process working directory'); error.code = 'EBUSY'; throw error;
  }
  return rename.call(this, from, to);
};`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--require', preload, path.join(kbDir, 'forge-update.mjs'), ...args], {
      cwd: kbDir,
      env: { ...process.env, ...extraEnv, HOME: home, RUVNET_SETTINGS_FILE: path.join(home, 'nope.json') },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}
const run = (...args) => runWithEnv({}, ...args);

const rollbackCopies = () => fs.readdirSync(root).filter((n) => n.startsWith('kb.bak-'));

// SIGTERM settlement is POSIX-only (Windows terminates a process outright and runs no handler), so this case lives in its own
// file that release qualification lists for linux and macos only.
describe('forge-update --apply: a signal settles the run', () => {
  it('SIGTERM during the bundle download records "interrupted", exits 143, and releases the lock and the temp stage', async () => {
    const current = sourceJson({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A] });
    layDown(kbDir, current);
    publish(sourceJson({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A] }), 'v4.0.8');
    served.stallZip = true;
    const resultFile = path.join(root, 'signal-result.json');
    const lockDir = path.join(root, '.kb.refresh-run.lock');
    const stagesBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forge-update-release-')));
    const home = path.join(root, 'home'); fs.mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, [path.join(kbDir, 'forge-update.mjs'), '--apply', '--result-file', resultFile],
      { cwd: kbDir, env: { ...process.env, HOME: home, RUVNET_SETTINGS_FILE: path.join(home, 'nope.json') } });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 30_000;
    while (served.hits.zip === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(served.hits.zip, out).toBe(1);
    expect(fs.existsSync(lockDir), 'the update holds its lock while downloading').toBe(true);
    const ownStages = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forge-update-release-') && !stagesBefore.has(n));
    child.kill('SIGTERM');
    const { code, signal } = await closed;
    expect({ code, signal }, out).toEqual({ code: 143, signal: null });
    expect(out).toMatch(/interrupted by SIGTERM/);
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toMatchObject({ terminalVerdict: 'interrupted', exitCode: 143 });
    expect(fs.existsSync(lockDir), 'lock released').toBe(false);
    expect(ownStages, 'the bundle streams into the temp stage while downloading').toHaveLength(1);
    expect(fs.existsSync(path.join(os.tmpdir(), ownStages[0])), 'temp stage removed').toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
  }, 60_000);
});
