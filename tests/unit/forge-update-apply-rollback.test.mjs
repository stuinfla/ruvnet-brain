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
const { placeTrustedCoverageValidator } = await import('../../bin/install.mjs');
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
      if (!served.sig) { res.writeHead(404).end('missing'); return; }
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
  // realpath: on macOS os.tmpdir() is /var/... which is a symlink to /private/var/..., and
  // forge-update.mjs only runs main() when import.meta.url matches argv[1] — an unresolved path
  // silently no-ops the whole script.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-apply-')));
  kbDir = path.join(root, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  for (const f of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
    'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'kb', f), path.join(kbDir, f));
  }
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
    for (const file of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
      'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs']) {
      fs.copyFileSync(path.join(kbDir, file), path.join(dir, file));
    }
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

describe('forge-update --apply (issues #106 + #108)', () => {
  it.each([
    ['missing', null, 3, /signature download returned/],
    ['tampered', Buffer.from('not a signature'), 4, /SIGNATURE VERIFICATION FAILED/],
  ])('refuses a %s signature before backup or live mutation', async (_name, signature, exitCode, message) => {
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A],
    }), 'v4.0.8');
    served.sig = signature;

    const { code, out } = await run('--apply');

    expect(code).toBe(exitCode);
    expect(out).toMatch(message);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
    expect(rollbackCopies()).toEqual([]);
    expect(served.hits).toEqual({ zip: 1, sig: 1 });
  });

  // 4.5: an apply needs ~3.3 GB growth / ~5 GB peak on a real brain. Out of space, it must refuse BEFORE
  // unpacking anything, name the exact amount and the one fix, and leave the live brain untouched.
  it('refuses cleanly, before unpacking, when the disk cannot hold the unpacked bundle and new generation', async () => {
    const current = sourceJson({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A] });
    layDown(kbDir, current);
    publish(sourceJson({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A] }), 'v4.0.8');
    const before = fs.readdirSync(kbDir).sort();
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forge-update-release-')).length;

    const { code, out } = await runWithEnv({ RUVNET_BRAIN_TEST: '1', RUVNET_TEST_FREE_BYTES: '1000' }, '--apply');

    expect(code, out).toBe(6);
    expect(out).toMatch(/not enough free disk space to apply this update: .* has 0\.00 GB free and needs \d+\.\d\d GB \(unpacked bundle .* \+ new generation .* \+ 0\.25 GB headroom\)\. Free \d+\.\d\d GB on that disk, or move the Brain to a bigger disk with {2}npx ruvnet-brain --move-brain <folder on that disk>\. Nothing was changed\./);
    expect(out).not.toMatch(/RUVNET_BRAIN_HOME/);
    expect(fs.readdirSync(kbDir).sort()).toEqual(before);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
    expect(fs.readdirSync(root).filter((n) => /\.next-|\.rollback-|\.failed-|kb\.bak-/.test(n))).toEqual([]);
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forge-update-release-')).length).toBeLessThanOrEqual(tmpBefore);
    // With room, the same release applies (the refusal was about space, nothing else).
    const ok = await runWithEnv({ RUVNET_BRAIN_TEST: '1', RUVNET_TEST_FREE_BYTES: String(64 * 1024 ** 3) }, '--apply');
    expect(ok.code, ok.out).toBe(0);
  });

  // Review S6: the estimate left out the private-store files restorePrivateFilesIntoCandidate copies into the new
  // generation, so a brain with a large private store passed the preflight and could run out of space half-way.
  it('counts private-store bytes carried into the new generation: refused when only they do not fit', async () => {
    const current = sourceJson({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A] });
    current.stores.mynotes = { kbName: 'mynotes', updateManaged: false, sourceCommit: null, builtUtc: '2026-08-01T00:00:00.000Z' };
    layDown(kbDir, current);
    const privateBytes = Buffer.alloc(8 * 1024 ** 2, 3); // 8 MiB of private vectors
    fs.writeFileSync(path.join(kbDir, 'mynotes.big.rvf'), privateBytes);
    const generations = JSON.parse(fs.readFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), 'utf8'));
    generations.stores.mynotes = { file: 'mynotes.big.rvf', bytes: privateBytes.length,
      sha256: crypto.createHash('sha256').update(privateBytes).digest('hex'), model: 'fixture-model', dimensions: 384 };
    fs.writeFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), `${JSON.stringify(generations)}\n`);
    fs.writeFileSync(path.join(kbDir, 'repo-aliases.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(kbDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['mynotes'] }));
    publish(sourceJson({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A] }), 'v4.0.8',
      (stage) => fs.writeFileSync(path.join(stage, 'repo-aliases.json'), JSON.stringify({})));
    const { zipDeclaredBytes } = await import('../../kb/zip-extract.mjs');
    const unpacked = zipDeclaredBytes(path.join(root, 'bundle-v4.0.8.zip'));
    // Temp and the brain share this test's filesystem, so the public-only need is 2 × unpacked + headroom.
    // Give exactly that plus half the private store: enough without the private bytes, short with them.
    const free = 256 * 1024 ** 2 + 2 * unpacked + privateBytes.length / 2;
    const { code, out } = await runWithEnv({ RUVNET_BRAIN_TEST: '1', RUVNET_TEST_FREE_BYTES: String(free) }, '--apply');
    expect(code, out).toBe(6);
    expect(out).toMatch(/not enough free disk space to apply this update: .*\(unpacked bundle .* \+ new generation .* \+ private stores carried into it 0\.01 GB \+ 0\.25 GB headroom\)/);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
    expect(fs.readFileSync(path.join(kbDir, 'mynotes.big.rvf')).equals(privateBytes)).toBe(true); // NOT toEqual: vitest walks every byte of a Buffer (8 MiB = GBs of heap)
    expect(fs.readdirSync(root).filter((n) => /\.next-|\.rollback-|\.failed-|kb\.bak-/.test(n))).toEqual([]);
    // With the private bytes' room as well, the same release applies and the private store survives.
    const ok = await runWithEnv({ RUVNET_BRAIN_TEST: '1', RUVNET_TEST_FREE_BYTES: String(free + privateBytes.length) }, '--apply');
    expect(ok.code, ok.out).toBe(0);
    expect(fs.readFileSync(path.join(kbDir, 'mynotes.big.rvf')).equals(privateBytes)).toBe(true); // NOT toEqual: vitest walks every byte of a Buffer (8 MiB = GBs of heap)
  }, 120_000); // two real signed applies; slow under load

  it('rejects invalid staged ReleaseCoverage before backup or live-tree mutation', async () => {
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A],
    }), 'v4.0.8', (stage) => {
      const coverageFile = path.join(stage, 'COVERAGE.json');
      const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
      coverage.releaseIdentity.version = '0.0.0-tampered';
      fs.writeFileSync(coverageFile, JSON.stringify(coverage));
    });

    const { code, out } = await run('--apply');

    expect(code).toBe(1);
    expect(out).toMatch(/staged ReleaseCoverage failed integrity/);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
    expect(rollbackCopies()).toEqual([]);
  });

  it('returns an explicit successful no-op without creating a rollback when the candidate is byte-identical', async () => {
    // The reported run: the release tag moved, so every store reads BEHIND, but the asset carries
    // the very bundle already on disk. The corpus does not move. Both halves must hold at once —
    // the exit code must not say success, and the 1.6 GB rollback must not be left behind.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.8'); // newer TAG, identical CONTENT

    const resultFile = path.join(root, 'noop-result.json');
    const { code, out } = await run('--apply', '--result-file', resultFile);

    expect(code, out).toBe(0);
    expect(out).toMatch(/storage transaction: noop/);
    expect(out).toMatch(/DONE — exact no-op/);
    expect(rollbackCopies()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toMatchObject({ terminalVerdict: 'noop', storeCount: 2 });
  });

  it('exits 0 and releases the rollback when the bundle moved, even though one store did not (#108)', async () => {
    // 8 of the reporter's 15 stores shared one forge stamp. The first unchanged store in iteration
    // order aborted the entire run; whitelisting it would only promote the next one.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A, STORE_B_NEW],
    }), 'v4.0.8');

    const resultFile = path.join(root, 'applied-result.json');
    // Resolve this against the caller's KB cwd before the updater releases that directory.
    const { code, out } = await run('--apply', '--result-file', path.join('..', 'applied-result.json'));

    expect(code, `the bundle genuinely advanced — this run succeeded\n${out}`).toBe(0);
    expect(out).toMatch(/DONE — 2 store\(s\) updated/);
    expect(out, 'an unchanged store is normal and must be named, not inferred from silence').toMatch(/1 of 2 store\(s\) were already at the canonical build[\s\S]*alpha/);
    expect(rollbackCopies()).toEqual([]);
    expect(served.hits).toEqual({ zip: 1, sig: 1 });
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(result).toMatchObject({ terminalVerdict: 'applied', storeCount: 2 });
    for (const phase of ['source-enumeration', 'ingestion', 'bundle-assembly', 'coverage-generation']) {
      expect(result.phaseEvidence[phase].execution).toMatchObject({ kind: 'imported-release', upstreamFreshness: 'UNKNOWN' });
    }
    expect(result.phaseEvidence.update.execution).toMatchObject({ kind: 'executed', runId: expect.any(String) });
    // And the new bundle really is what is on disk now — read back, not asserted.
    const landed = JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8'));
    expect(landed.releaseTag).toBe('v4.0.8');
    expect(landed.stores.beta.sourceCommit).toBe(STORE_B_NEW.sourceCommit);
    // The promoted generation is the extracted bundle, which never carried the validator. The live,
    // installer-provided copy must be carried forward — or the NEXT --apply (the console runs the
    // updater directly) dies on "installed coverage validator is missing".
    const carried = path.join(kbDir, 'coverage-integrity.mjs');
    expect(fs.existsSync(carried), 'promoted tree must still hold the trusted validator').toBe(true);
    expect(fs.readFileSync(carried).equals(TRUSTED_VALIDATOR_BYTES)).toBe(true);
  });

  it('dies on the exact message when the installer never placed the validator, and proceeds once it has', async () => {
    // Measured 2026-09-12 on a 4.3.21 brain: the already-current path loads the validator from the
    // KB root before it does anything else; with no installer placement it can never get past this.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.7'); // same tag as local → the already-current branch
    fs.rmSync(path.join(kbDir, 'coverage-integrity.mjs'));

    const starved = await run('--apply');
    expect(starved.code).toBe(1);
    expect(starved.out).toMatch(/installed coverage validator is missing; re-run the current installer before self-update/);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');

    expect(placeTrustedCoverageValidator(kbDir).action).toBe('placed');
    const fed = await run('--apply');
    expect(fed.code, fed.out).toBe(0);
    expect(fed.out).toMatch(/Nothing to apply — already current/);
    expect(fed.out).not.toMatch(/coverage validator is missing/);
  });

  it('treats --restore-complete re-landing the SAME bundle as success, not as "nothing landed"', async () => {
    // That flag exists to bring back artifacts a profile removed, so an unchanged bundle identity
    // is the expected outcome of the request — what it restores is FILES, which SOURCE.json's
    // identity has nothing to say about. Refusing here would break the one path whose whole job is
    // to re-land what is already published.
    const current = sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.8');
    fs.rmSync(path.join(kbDir, 'beta.big.rvf')); // as a profile would have removed it
    const profiledLedger = JSON.parse(fs.readFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), 'utf8'));
    delete profiledLedger.stores.beta;
    fs.writeFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), JSON.stringify(profiledLedger));

    const { code, out } = await run('--apply', '--restore-complete');

    expect(code, out).toBe(0);
    expect(out).toMatch(/DONE — 2 store\(s\) updated/);
    expect(fs.existsSync(path.join(kbDir, 'beta.big.rvf')), 'the removed artifact must be back').toBe(true);
    expect(rollbackCopies()).toEqual([]);
  });

  it('rejects a suspect candidate before activation and leaves live bytes untouched', async () => {
    // "Never strand a resource" must not become "always delete". A landed bundle with no entry for
    // the store we asked about is a wrong/broken copy, and then the rollback is the user's recovery.
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_B_NEW],
    }), 'v4.0.8');

    const { code, out } = await run('--apply');

    expect(code, 'a suspect copy is an error, not a no-op').toBe(1);
    expect(out).toMatch(/ships none of the selected stores \(alpha\)/);
    expect(rollbackCopies()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
  });

  it('lands a release that retires a store this brain lists, names it, and keeps node_modules', async () => {
    // Measured 2026-09-30: 4.3.39 no longer ships agentic-flows/agentic-music/cogs/support, and the
    // owner's brain still listed them, so forge-guard ran against stores the candidate cannot contain
    // ("[FAIL] MISSING file: agentic-flows.rvf") and no such brain could ever update.
    const GAMMA = { kbName: 'gamma', sourceCommit: 'ddd444ddd444', sourceDescribe: 'v0.1.0', builtUtc: '2026-07-28T14:00:00.000Z' };
    layDown(kbDir, sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, GAMMA],
    }));
    fs.mkdirSync(path.join(kbDir, 'node_modules', 'embedder', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'node_modules', 'embedder', 'bin', 'run.js'), 'embed');
    fs.mkdirSync(path.join(kbDir, 'node_modules', '.bin'));
    fs.symlinkSync('../embedder/bin/run.js', path.join(kbDir, 'node_modules', '.bin', 'embed'));
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A],
    }), 'v4.0.8');

    const resultFile = path.join(root, 'retired-result.json');
    const { code, out } = await run('--apply', '--result-file', resultFile);

    expect(code, out).toBe(0);
    expect(out).toMatch(/retired by this release \(no longer shipped\): gamma/);
    expect(JSON.parse(fs.readFileSync(resultFile, 'utf8'))).toMatchObject({ terminalVerdict: 'applied', retiredStores: ['gamma'] });
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.8');
    expect(fs.readFileSync(path.join(kbDir, 'node_modules', 'embedder', 'bin', 'run.js'), 'utf8')).toBe('embed');
    // Still the SAME relative link (verbatim, not rewritten absolute, not dropped). Separator-
    // insensitive because Node on Windows stores a relative symlink target with backslashes at
    // creation (lib/internal/fs/utils.js preprocessSymlinkDestination: "Windows symlinks don't
    // tolerate forward slashes"), so even the link this test made reads back as ..\embedder\bin\run.js.
    const target = fs.readlinkSync(path.join(kbDir, 'node_modules', '.bin', 'embed'));
    expect(path.isAbsolute(target), target).toBe(false);
    expect(target.split(/[\\/]/)).toEqual(['..', 'embedder', 'bin', 'run.js']);
    expect(rollbackCopies()).toEqual([]);
  });

  // The release-source gate allows ZERO skipped tests, so this never skips: the symlink half only runs where a
  // process may create symlinks (not Windows); the private-store half runs everywhere.
  it('updates a brain with a PRIVATE store and npm .bin symlinks: private bytes and links carried intact', async () => {
    const canLink = process.platform !== 'win32';
    // The owner's nightly failed 2026-09-24: "private overlay preflight failed: symbolic link is not a
    // governed regular file: node_modules/.bin/semver". npm makes .bin symlinks on every install, so
    // any customer with a private store would hit it. End to end through a real signed --apply.
    const current = sourceJson({ releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A] });
    current.stores.mynotes = { kbName: 'mynotes', updateManaged: false, sourceCommit: null, builtUtc: '2026-08-01T00:00:00.000Z' };
    layDown(kbDir, current);
    const privateBytes = Buffer.from('private-notes-vectors');
    fs.writeFileSync(path.join(kbDir, 'mynotes.big.rvf'), privateBytes);
    fs.writeFileSync(path.join(kbDir, 'mynotes.passages.jsonl'), '{"path":"notes.md","text":"mine"}\n');
    const generations = JSON.parse(fs.readFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), 'utf8'));
    generations.stores.mynotes = { file: 'mynotes.big.rvf', bytes: privateBytes.length,
      sha256: crypto.createHash('sha256').update(privateBytes).digest('hex'), model: 'fixture-model', dimensions: 384 };
    fs.writeFileSync(path.join(kbDir, 'RVF-GENERATIONS.json'), `${JSON.stringify(generations)}\n`);
    fs.writeFileSync(path.join(kbDir, 'repo-aliases.json'), JSON.stringify({ mynotes: ['my-notes'] }));
    fs.writeFileSync(path.join(kbDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['mynotes'] }));
    fs.mkdirSync(path.join(kbDir, 'node_modules', 'semver', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'node_modules', 'semver', 'bin', 'semver.js'), 'semver');
    fs.mkdirSync(path.join(kbDir, 'node_modules', '.bin'));
    if (canLink) fs.symlinkSync('../semver/bin/semver.js', path.join(kbDir, 'node_modules', '.bin', 'semver'));
    publish(sourceJson({ releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A] }), 'v4.0.8',
      (stage) => fs.writeFileSync(path.join(stage, 'repo-aliases.json'), JSON.stringify({})));

    const { code, out } = await run('--apply');

    expect(code, out).toBe(0);
    expect(out).not.toMatch(/private overlay preflight failed|not a governed regular file/);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.8');
    expect(fs.readFileSync(path.join(kbDir, 'mynotes.big.rvf')).equals(privateBytes)).toBe(true); // NOT toEqual: vitest walks every byte of a Buffer (8 MiB = GBs of heap)
    expect(fs.readFileSync(path.join(kbDir, 'mynotes.passages.jsonl'), 'utf8')).toContain('"mine"');
    if (canLink) {
      expect(fs.lstatSync(path.join(kbDir, 'node_modules', '.bin', 'semver')).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(kbDir, 'node_modules', '.bin', 'semver')).split(/[\\/]/)).toEqual(['..', 'semver', 'bin', 'semver.js']);
      expect(fs.readFileSync(path.join(kbDir, 'node_modules', '.bin', 'semver'), 'utf8')).toBe('semver');
    }
  });

  it('does not require a duplicate snapshot budget because rollback is the renamed live tree', async () => {
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A],
    }), 'v4.0.8');

    const { code, out } = await runWithEnv({ RUVNET_MAX_ROLLBACK_SNAPSHOTS: '0' }, '--apply');

    expect(code, out).toBe(0);
    expect(out).toMatch(/storage transaction: applied/);
    expect(rollbackCopies()).toEqual([]);
  });

  it.each(['only-copy-private.rvf', 'only-copy-private.txt'])('refuses a retry with unresolved recovery data: %s', async (privateFile) => {
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_B_NEW],
    }), 'v4.0.8');
    const recovery = path.join(root, 'kb.bak-prior-failure');
    layDown(recovery, current);
    fs.writeFileSync(path.join(recovery, privateFile), Buffer.alloc(4096, 9));

    const { code, out } = await runWithEnv({ RUVNET_MAX_ROLLBACK_SNAPSHOTS: '0' }, '--apply');

    expect(code).toBe(1);
    expect(out).toMatch(/unresolved rollback state exists/);
    expect(out).toMatch(/refusing to create another full-KB copy/);
    expect(rollbackCopies()).toEqual(['kb.bak-prior-failure']);
    expect(fs.readFileSync(path.join(recovery, privateFile))).toEqual(Buffer.alloc(4096, 9));
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
  });

  it.each([false, true])('preserves a measurable private backup while a within-budget update proceeds (noop=%s)', async (noop) => {
    const current = sourceJson({ releaseTag: 'v4.0.7', brainVersion: '4.0.7',
      builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A] });
    layDown(kbDir, current);
    const next = noop ? current : sourceJson({ releaseTag: 'v4.0.8', brainVersion: '4.0.8',
      builtUtc: '2026-08-02T12:00:00.000Z', stores: [STORE_A] });
    publish(next, next.releaseTag);
    const recovery = path.join(root, 'kb.bak-private');
    layDown(recovery, current);
    fs.writeFileSync(path.join(recovery, 'private.txt'), 'unique private bytes');
    const resultFile = path.join(root, 'result.json');
    const { code, out } = await runWithEnv({ RUVNET_MAX_ROLLBACK_SNAPSHOTS: '1',
      RUVNET_MAX_ROLLBACK_BYTES: '10000000' }, '--apply', '--result-file', resultFile);
    expect(code, out).toBe(0);
    expect(fs.readFileSync(path.join(recovery, 'private.txt'), 'utf8')).toBe('unique private bytes');
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe(next.releaseTag);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    expect(result.legacyBackupRetention.retained).toEqual([expect.objectContaining({ path: recovery, bytes: expect.any(Number) })]);
    expect(result.legacyBackupRetention.freed).toBe(0);
    expect(result.storageDelta.redundantCopyCount).toBe(1);
    if (noop) {
      expect(result.storageDelta).toMatchObject({ activeBytesDelta: 0, managedBytesDelta: 0,
        additionalFullCorpusCopyDelta: 0 });
      expect(result.storageDelta.managedBefore.additionalFullCorpusCopyCount).toBe(1);
      expect(result.storageDelta.managedAfter.additionalFullCorpusCopyCount).toBe(1);
      expect(result.phaseEvidence.update.storageDelta).toEqual(result.storageDelta);
    }
  });
  it('unsafe backup symlinks still block real apply despite ample retention budget', async () => {
    const current = sourceJson({ releaseTag: 'v4.0.7', brainVersion: '4.0.7',
      builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A] });
    layDown(kbDir, current);
    publish(current, 'v4.0.8');
    const recovery = path.join(root, 'kb.bak-private');
    layDown(recovery, current);
    fs.writeFileSync(path.join(root, 'private.txt'), 'untouched');
    fs.symlinkSync('../private.txt', path.join(recovery, 'private-link'));
    const { code, out } = await runWithEnv({ RUVNET_MAX_ROLLBACK_BYTES: '10000000' }, '--apply');
    expect(code, out).toBe(1);
    expect(out).toMatch(/unresolved rollback state exists/);
    expect(fs.readFileSync(path.join(root, 'private.txt'), 'utf8')).toBe('untouched');
    expect(served.hits.zip).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
  });
});

describe('forge-update --check (issue #108 bug 2)', () => {
  it('exits 0 for a copy already at the canonical release tag, instead of reporting BEHIND forever', async () => {
    // The release tag is a property of the BUNDLE and is written only at the top level of
    // SOURCE.json, so the per-store `local.releaseTag` isBehind() short-circuits on was always
    // undefined. Every store fell through to a timestamp compare against the RELEASE publish time,
    // which is always later than the forge time of the KB inside it — so all 15 stores read BEHIND
    // on every run, `--check` exited 10 permanently, and `--apply` re-downloaded half a gigabyte
    // nightly to change nothing.
    const current = sourceJson({
      releaseTag: 'v4.0.8', brainVersion: '4.0.8', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A, STORE_B],
    });
    layDown(kbDir, current);
    publish(current, 'v4.0.8');

    const { code, out } = await run('--check');

    expect(code, `already on v4.0.8 — "behind" is not true\n${out}`).toBe(0);
    expect(out).toMatch(/All stores current/);
  });

  it('still exits 10 when the canonical release really is newer', async () => {
    const current = sourceJson({
      releaseTag: 'v4.0.7', brainVersion: '4.0.7', builtUtc: '2026-07-31T04:39:28.414Z', stores: [STORE_A],
    });
    layDown(kbDir, current);
    publish(current, 'v99.0.0'); // synthetic 'newer', never a real release

    const { code, out } = await run('--check');

    expect(code, out).toBe(10);
    expect(out).toMatch(/BEHIND/);
    // The hint names the self-upgrading door, never this (possibly old) updater run directly (matrix D8).
    expect(out).toContain('Run:  npx ruvnet-brain@latest --update');
    expect(out).not.toMatch(/node forge-update\.mjs --apply/);
  });
});
