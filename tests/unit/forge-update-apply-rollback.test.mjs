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
const hasZip = () => { try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } };
const CAN_ZIP = hasZip();

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
    'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'kb', f), path.join(kbDir, f));
  }
  const updater = path.join(kbDir, 'forge-update.mjs');
  const updaterSource = fs.readFileSync(updater, 'utf8').replace(
    /const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
    `const SIGNING_PUBKEY_PEM = \`${TEST_SIGNING_PUB}\`;`,
  );
  fs.writeFileSync(updater, updaterSource);
  fs.copyFileSync(path.join(ROOT, 'plugin/scripts/coverage-integrity.mjs'), path.join(kbDir, 'coverage-integrity.mjs'));
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
    for (const file of ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
      'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'coverage-integrity.mjs']) {
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
  execFileSync('zip', ['-q', '-r', zipPath, ...fs.readdirSync(stage)], { cwd: stage });
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
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(kbDir, 'forge-update.mjs'), ...args], {
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

describe.skipIf(!CAN_ZIP)('forge-update --apply (issues #106 + #108)', () => {
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
    const { code, out } = await run('--apply', '--result-file', resultFile);

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
    expect(out).toMatch(/no entry for store "alpha"/);
    expect(rollbackCopies()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(kbDir, 'SOURCE.json'), 'utf8')).releaseTag).toBe('v4.0.7');
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
    if (!noop) expect(result.storageDelta.redundantCopyCount).toBe(1);
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

describe.skipIf(!CAN_ZIP)('forge-update --check (issue #108 bug 2)', () => {
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
  });
});
