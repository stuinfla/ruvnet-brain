// tests/integration/footprint-three-updates.test.mjs — the footprint guarantee end to end (ADR-0098).
//
// A REAL install (bin/install.mjs, from a local bundle zip) into a temp HOME, a forced reinstall (the
// installer's own "preserve the prior generation" path), a private store added by the sanctioned writer,
// then THREE consecutive `bin/install.mjs --update` runs, each against a newer signed corpus generation
// served by a 127.0.0.1 GitHub. Before every update the measured 2026-10-01 cruft is planted (a kb.bak,
// an install-preserved copy, a kb.pre-update copy, a *-quarantine-* dir of copies, four stale npx
// installer copies, an over-cap ledger, ruflo scratch debris). After every update the test asserts:
// exactly one KB tree under HOME, nothing that must not exist, total bytes inside the budget and not
// growing, the private store byte-identical, and every positive-confirmation line green.
//
// Test-side substitutions, and ONLY these: the embedded Ed25519 trust root in the harness copies of
// bin/install.mjs and kb/forge-update.mjs is a test key (no test holds the release key), the installed
// SOURCE.json polls the local server, and RUVNET_BRAIN_TEST_NPM_LATEST / RUVNET_BRAIN_TEST_NOW pin the
// registry answer and the clock. Everything else — extraction, signature check, storage transaction,
// private-overlay restore, host spine, the sweep — is the shipped code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { prepareCorpusCandidate } from '../../scripts/corpus-reconcile.mjs';
import { addPrivateStore } from '../../scripts/customer-seams.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { writeOwn } from '../../plugin/scripts/mcp-readiness.mjs';
import { LIFECYCLE_EVIDENCE_RETENTION_POLICY } from '../../kb/lifecycle-evidence-retention.mjs';
import { SEED_IDENTITY, buildCorpus, buildRuntimeRoot, readJson, sha256File, tempDir, writeCoverage } from '../helpers/assemble-bundle-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = getVersion();
const REPO = 'stuinfla/ruvnet-brain';
const BUILDER_SHA = 'c'.repeat(40);
const KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const sign = (bytes) => crypto.sign(null, crypto.createHash('sha256').update(bytes).digest(), KEYS.privateKey);
const shared = [];
const MIB = 1024 * 1024;
const CONFIRMATION_IDS = ['software', 'hosts', 'knowledge', 'in-use', 'footprint', 'cruft'];

let server; let origin; const served = { gen: null };
const release = (gen) => ({ tag_name: gen.tag, draft: false, prerelease: false, published_at: gen.generation,
  body: `Corpus generation: ${gen.generation}`, assets: [
    { name: 'ruvnet-brain.zip', size: gen.zip.length, digest: `sha256:${gen.sha256}`, browser_download_url: `${origin}/dl/${gen.sha256}.zip` },
    { name: 'ruvnet-brain.zip.sig', size: gen.sig.length, browser_download_url: `${origin}/dl/${gen.sha256}.zip.sig` }] });

/** The seed plus `count` nightly generations, each built by the REAL prepareCorpusCandidate from the previous one. */
async function buildChain(count) {
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
  const driver = path.join(tempDir(shared, 'driver'), 'assemble.mjs');
  fs.writeFileSync(driver, `import { assembleBundle } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts', 'build-bundle.mjs')).href)};
await assembleBundle(JSON.parse(process.env.ASSEMBLE_OPTIONS));\n`);
  let previous = { file: `${seedOut}.zip`, sha256: sha256File(`${seedOut}.zip`) };
  previous.tag = `corpus-sha256-${previous.sha256}`;
  const seed = previous;
  const generations = [];
  const extra = ['gamma', 'delta', 'epsilon'];
  for (let i = 0; i < count; i += 1) {
    const corpusDir = await buildCorpus(shared, { runtimeRoot, stores: ['alpha', 'beta', ...extra.slice(0, i + 1)] });
    const coverage = writeCoverage(runtimeRoot, corpusDir);
    const out = tempDir(shared, `nightly-${i}`);
    const candidate = prepareCorpusCandidate({
      root: runtimeRoot, assetsDir: corpusDir, builderSha: BUILDER_SHA,
      candidateDir: path.join(out, 'candidate', 'ruvnet-brain'), receiptFile: path.join(out, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(runtimeRoot, 'data', 'source-coverage.json'), coverage,
      seedArchive: { file: previous.file, tag: previous.tag, sha256: previous.sha256 },
      run: (command, args) => {
        const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
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
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const zip = fs.readFileSync(candidate.bundleFile);
    const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
    const gen = { file: candidate.bundleFile, zip, sig: sign(zip), sha256, tag: `corpus-sha256-${sha256}`,
      generation: new Date(Date.parse('2026-09-13T00:30:00.000Z') + i * 86_400_000).toISOString() };
    generations.push(gen);
    previous = gen;
  }
  return { seed, generations };
}

/** The repository as an npm package would deliver it, with ONLY the trust root swapped to the test key. */
function harness() {
  const dir = tempDir(shared, 'harness');
  fs.cpSync(ROOT, dir, { recursive: true, filter: (source) => !['node_modules', '.git', 'dist'].includes(path.basename(source)) });
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(dir, 'node_modules'), 'junction');
  for (const file of ['bin/install.mjs', 'kb/forge-update.mjs']) {
    const target = path.join(dir, file);
    const source = fs.readFileSync(target, 'utf8');
    const swapped = source.replace(/const SIGNING_PUBKEY_PEM = `-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----`;/,
      `const SIGNING_PUBKEY_PEM = \`${TEST_PUB}\`;`);
    if (swapped === source) throw new Error(`trust-root anchor missing in ${file}`);
    fs.writeFileSync(target, swapped);
  }
  return dir;
}

/** Every directory under `root` that is a KB tree (SOURCE.json beside a store), node_modules skipped. */
function kbTrees(root) {
  const out = [];
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === 'SOURCE.json') && entries.some((e) => /\.rvf$/.test(e.name))) out.push(dir);
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'node_modules') walk(path.join(dir, e.name));
  };
  walk(root);
  return out.sort();
}

/** The measured 2026-10-01 cruft, planted fresh before every update. */
function plantCruft({ home, brainHome, kbDir, round }) {
  const copy = (to) => fs.cpSync(kbDir, to, { recursive: true, verbatimSymlinks: true });
  copy(path.join(brainHome, `kb.bak-2026-09-0${round}`));
  copy(path.join(brainHome, `kb.install-preserved-r${round}`));
  copy(path.join(brainHome, `kb.pre-update-2026093${round}`));
  const quarantine = path.join(home, '.cache', `ruvnet-brain-quarantine-2026091${round}`);
  copy(path.join(quarantine, 'kb.bak-old'));
  copy(path.join(quarantine, 'kb.install-preserved-old'));
  for (const [hash, v] of [['a', '4.3.35'], ['b', '4.3.37'], ['c', '4.3.39'], ['d', '4.3.40']]) {
    const dir = path.join(home, '.npm', '_npx', `${hash}${round}`);
    fs.mkdirSync(path.join(dir, 'node_modules', 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ _npx: { packages: [`ruvnet-brain@${v}`] } }));
    fs.writeFileSync(path.join(dir, 'node_modules', 'ruvnet-brain', 'package.json'), JSON.stringify({ version: v }));
    fs.writeFileSync(path.join(dir, 'node_modules', 'ruvnet-brain', 'blob'), Buffer.alloc(MIB));
    const fetched = new Date(Date.now() - 3 * 86_400_000); // stale copies (a copy fetched < 2h ago may be running)
    fs.utimesSync(dir, fetched, fetched);
  }
  fs.writeFileSync(path.join(brainHome, 'evidence.jsonl'), Buffer.alloc(3 * MIB, 0x61));
  fs.mkdirSync(path.join(brainHome, 'ruflo-cwd', 'p', '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(brainHome, 'ruflo-cwd', 'p', '.swarm', 'hnsw.metadata.json'), '{}');
}

const run = (args, env, cwd) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env, cwd });
  let output = ''; let stdout = '';
  child.stdout.on('data', (d) => { output += d; stdout += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', (code) => resolve({ code, output, stdout }));
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const gen = served.gen;
    if (gen && req.url === `/repos/${REPO}/releases/latest`) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(release(gen))); return; }
    if (gen && req.url === `/dl/${gen.sha256}.zip`) { res.writeHead(200); res.end(gen.zip); return; }
    if (gen && req.url === `/dl/${gen.sha256}.zip.sig`) { res.writeHead(200); res.end(gen.sig); return; }
    res.writeHead(404).end('no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  while (shared.length) fs.rmSync(shared.pop(), { recursive: true, force: true });
});

describe('footprint guarantee: real install, forced reinstall, three updates', () => {
  it('ends every lifecycle step with exactly one KB, no cruft, bounded bytes, private bytes intact, all green', async () => {
    const { seed, generations } = await buildChain(3);
    const pkg = harness();
    fs.mkdirSync(path.join(pkg, 'dist'));
    fs.copyFileSync(seed.file, path.join(pkg, 'dist', 'ruvnet-brain.zip'));
    const home = fs.realpathSync(tempDir(shared, 'home'));
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const kbDir = path.join(brainHome, 'kb');
    // A Claude Code host whose plugin cache already holds this version (the spine seeds from it).
    const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', VERSION);
    fs.cpSync(path.join(pkg, 'plugin'), pluginDir, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'ruvnet-brain@ruvnet-brain': [{ installPath: pluginDir, version: VERSION }] } }));
    const env = { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home,
      TMPDIR: tempDir(shared, 'tmp'), CODEX_HOME: path.join(home, '.codex'), npm_config_cache: path.join(home, '.npm'),
      npm_config_update_notifier: 'false', RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: VERSION,
      RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1', RUVNET_NO_TELEMETRY: '1', RUFLO_DAEMON_AUTOSTART: '0', RUVNET_TURN_CAPTURE: 'off' };
    const installer = path.join(pkg, 'bin', 'install.mjs');
    const installFlags = ['--yes', '--no-nightly-prompt', '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck', '--no-verify'];

    const first = await run([installer, ...installFlags], env, home);
    expect(first.code, first.output.slice(-6000)).toBe(0);
    expect(first.output).toContain('Positive confirmation');
    expect(first.output).not.toMatch(/footprint sweep could not run|positive confirmation could not run/);
    // The forced reinstall is the installer's own creator of kb.install-preserved-*; it must not leave one.
    const forced = await run([installer, ...installFlags, '--force'], env, home);
    expect(forced.code, forced.output.slice(-6000)).toBe(0);
    expect(forced.output).toMatch(/released the prior generation/);
    expect(kbTrees(home)).toEqual([kbDir]);

    const overlay = await addPrivateStore({ kbDir, scratch: tempDir(shared, 'overlay'), writerRoot: pkg });

    const totals = [];
    for (const [round, gen] of generations.entries()) {
      // A fixture generation names an unreachable manifest; point this install at the local GitHub.
      const source = readJson(path.join(kbDir, 'SOURCE.json'));
      fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ ...source, canonicalManifestUrl: `${origin}/repos/${REPO}/releases/latest` }, null, 2));
      plantCruft({ home, brainHome, kbDir, round: round + 1 });
      expect(kbTrees(home).length).toBe(6); // live + 3 siblings + 2 quarantined
      served.gen = gen;
      const builtNow = Date.parse(gen.generation) + 3_600_000;
      const stepEnv = { ...env, RUVNET_BRAIN_TEST_NOW: new Date(Math.max(builtNow, Date.now())).toISOString() };
      const update = await run([installer, '--update', '--no-nightly-prompt'], stepEnv, home);
      expect(update.code, update.output.slice(-8000)).toBe(0);
      expect(update.output).not.toMatch(/footprint sweep could not run|positive confirmation could not run/);
      // Optional transcript of what a user sees (for review): FOOTPRINT_E2E_TRANSCRIPT=<file>.
      if (process.env.FOOTPRINT_E2E_TRANSCRIPT) fs.appendFileSync(process.env.FOOTPRINT_E2E_TRANSCRIPT, `\n===== update ${round + 1} =====\n${update.output}`);
      expect(update.output).toMatch(/footprint: removed \d+ item\(s\) that must not exist/);
      expect(fs.existsSync(path.join(brainHome, 'active.json')), 'the host spine was seeded, so versions/ is in the inventory').toBe(true);
      expect(readJson(path.join(kbDir, 'SOURCE.json')).corpusReleaseTag).toBe(gen.tag);
      expect(kbTrees(home), update.output.slice(-4000)).toEqual([kbDir]);
      expect(fs.readdirSync(path.join(home, '.npm', '_npx')).filter((h) => h.endsWith(String(round + 1)))).toEqual([]);
      expect(fs.statSync(path.join(brainHome, 'evidence.jsonl.1')).size).toBe(3 * MIB);
      expect(fs.existsSync(path.join(brainHome, 'evidence.jsonl'))).toBe(false);
      for (const [file, digest] of Object.entries(overlay.digests)) expect(sha256File(path.join(kbDir, file)), file).toBe(digest);

      // Positive confirmation, machine-readable, with the search worker simulated by the REAL readiness
      // writer (this test process plays the worker that opened the live KB) and one metered answer.
      writeOwn(brainHome, { state: 'ready', phase: 'warmup', kbDir: fs.realpathSync(kbDir) });
      fs.appendFileSync(path.join(brainHome, 'token-ledger.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), source: 'mcp', tool: 'search_ruvnet', bytes: 10 })}\n`);
      // `--doctor --json` is the full doctor (one verdict, review S5): stdout is ONLY that object. The fixture
      // KB's search entry points are stubs, so the live grounding question cannot pass here; every
      // positive-confirmation line must, and the exit code must be the verdict's own.
      const doctor = await run([installer, '--doctor', '--json'], { ...stepEnv, RUVNET_BRAIN_TEST_NOW: stepEnv.RUVNET_BRAIN_TEST_NOW }, home);
      const confirmation = JSON.parse(doctor.stdout);
      const confirmationLines = confirmation.lines.filter((l) => CONFIRMATION_IDS.includes(l.id));
      expect(confirmationLines.map((l) => l.id).sort()).toEqual([...CONFIRMATION_IDS].sort());
      expect(confirmationLines.filter((l) => l.state !== 'ok'), JSON.stringify(confirmation.lines, null, 2)).toEqual([]);
      expect(doctor.code).toBe(confirmation.exitCode);
      expect(confirmation.failing.filter((id) => CONFIRMATION_IDS.includes(id))).toEqual([]);
      expect(confirmation.footprint.kbCopies).toBe(1);
      expect(confirmation.footprint.totalBytes).toBeLessThanOrEqual(confirmation.footprint.budgetBytes);
      // Update receipts are the one thing allowed to accumulate, and only up to their own retention policy.
      expect(confirmation.footprint.breakdown.receipts || 0).toBeLessThanOrEqual(LIFECYCLE_EVIDENCE_RETENTION_POLICY.maxEvidenceBytes);
      totals.push(confirmation.footprint);
    }
    // Beyond those receipts, nothing grows across updates except the one new store each generation adds
    // (a fixture store is a few KB): the planted 50+ MB of cruft never survives an update.
    const net = (t) => t.totalBytes - (t.breakdown.receipts || 0);
    expect(net(totals[2]) - net(totals[0]), JSON.stringify(totals.map((t) => t.breakdown))).toBeLessThan(256 * 1024);

    // BREAK IT: the same door with the sweep cut out of the installer must leave the cruft behind, and the
    // confirmation must go red — otherwise the assertions above were never measuring the sweep.
    const shipped = fs.readFileSync(installer, 'utf8');
    const broken = shipped.replace('  enforceFootprint({ holdingRefreshLock: true, quiet: true });\n', '')
      .replace('const footprint = enforceFootprint({ holdingRefreshLock: true });', 'const footprint = null;');
    expect(broken.length).toBeLessThan(shipped.length - 40);
    fs.writeFileSync(installer, broken);
    plantCruft({ home, brainHome, kbDir, round: 9 });
    const stepEnv = { ...env, RUVNET_BRAIN_TEST_NOW: new Date(Math.max(Date.parse(generations[2].generation) + 3_600_000, Date.now())).toISOString() };
    const noSweep = await run([installer, '--update', '--no-nightly-prompt'], stepEnv, home);
    expect(kbTrees(home).length, noSweep.output.slice(-3000)).toBeGreaterThan(1);
    const red = await run([installer, '--doctor', '--json'], stepEnv, home);
    const redConfirmation = JSON.parse(red.stdout);
    expect(red.code).toBe(1);
    expect(redConfirmation.failing).toEqual(expect.arrayContaining(['knowledge', 'cruft']));
    expect(redConfirmation.footprint.kbCopies).toBeGreaterThan(1);
    expect(redConfirmation.lines.find((l) => l.id === 'cruft')).toMatchObject({ state: 'fail', fix: 'npx ruvnet-brain --clean' });
    // …and the one command it names restores the guarantee.
    fs.writeFileSync(installer, shipped);
    const clean = await run([installer, '--clean', '--json'], stepEnv, home);
    expect(clean.code, clean.output.slice(-3000)).toBe(0);
    expect(kbTrees(home)).toEqual([kbDir]);
  }, 900_000);

  // Review S5 + the owner's condition for gating on the signature record: a FRESH verified install and an
  // --update that applies nothing must both leave it present, and "fix: --update" for a lost record must work.
  it('the signature record survives a verified install, an applied update and a no-op update, and is recovered from proof', async () => {
    const { seed, generations } = await buildChain(1);
    const pkg = harness();
    fs.mkdirSync(path.join(pkg, 'dist'));
    fs.copyFileSync(seed.file, path.join(pkg, 'dist', 'ruvnet-brain.zip'));
    fs.writeFileSync(path.join(pkg, 'dist', 'ruvnet-brain.zip.sig'), sign(fs.readFileSync(seed.file)));
    const home = fs.realpathSync(tempDir(shared, 'sig-home'));
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const kbDir = path.join(brainHome, 'kb');
    const record = path.join(brainHome, 'knowledge-signature.json');
    const coverageSha = () => sha256File(path.join(kbDir, 'COVERAGE.json'));
    const env = { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home,
      TMPDIR: tempDir(shared, 'sig-tmp'), CODEX_HOME: path.join(home, '.codex'), npm_config_cache: path.join(home, '.npm'),
      npm_config_update_notifier: 'false', RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: VERSION,
      RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1', RUVNET_NO_TELEMETRY: '1', RUFLO_DAEMON_AUTOSTART: '0', RUVNET_TURN_CAPTURE: 'off' };
    const installer = path.join(pkg, 'bin', 'install.mjs');
    // NO --no-verify: the local bundle's signature beside it is checked with the (test) trust root.
    const fresh = await run([installer, '--yes', '--no-nightly-prompt', '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck'], env, home);
    expect(fresh.code, fresh.output.slice(-6000)).toBe(0);
    expect(fresh.output).toMatch(/signature valid \(sha256 /);
    expect(readJson(record)).toMatchObject({ source: 'install', bundleSha256: seed.sha256, coverageSha256: coverageSha() });
    // The activation marker that froze the sweep while the generation swapped is gone once it finished (S6).
    expect(fs.existsSync(path.join(brainHome, '.kb.install-activation.lock'))).toBe(false);

    const pointAtLocal = () => {
      const source = readJson(path.join(kbDir, 'SOURCE.json'));
      fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ ...source, canonicalManifestUrl: `${origin}/repos/${REPO}/releases/latest` }, null, 2));
    };
    const gen = generations[0];
    served.gen = gen;
    const stepEnv = { ...env, RUVNET_BRAIN_TEST_NOW: new Date(Math.max(Date.parse(gen.generation) + 3_600_000, Date.now())).toISOString() };
    pointAtLocal();
    const applied = await run([installer, '--update', '--no-nightly-prompt'], stepEnv, home);
    expect(applied.code, applied.output.slice(-6000)).toBe(0);
    expect(readJson(record)).toMatchObject({ source: 'update', bundleSha256: gen.sha256, coverageSha256: coverageSha() });

    pointAtLocal();
    const noop = await run([installer, '--update', '--no-nightly-prompt'], stepEnv, home);
    expect(noop.code, noop.output.slice(-6000)).toBe(0);
    expect(noop.output).toMatch(/Nothing to apply — already current/);
    expect(readJson(record)).toMatchObject({ bundleSha256: gen.sha256, coverageSha256: coverageSha() });

    // A lost record: the doctor gates on it (structural) and names --update; --update applies nothing and
    // must still restore it — from this machine's own receipt of the verified apply, never by assumption.
    fs.rmSync(record);
    const lost = await run([installer, '--doctor', '--json'], stepEnv, home);
    // 4.5.1: a lost record is provenance unknown — advisory, naming --update, which restores it below.
    expect(JSON.parse(lost.stdout).lines.find((l) => l.id === 'knowledge')).toMatchObject({ state: 'warn', fix: 'npx ruvnet-brain@latest --update' });
    pointAtLocal();
    const repaired = await run([installer, '--update', '--no-nightly-prompt'], stepEnv, home);
    expect(repaired.code, repaired.output.slice(-6000)).toBe(0);
    expect(repaired.output).toMatch(/signature verification recorded for the live knowledge/);
    expect(readJson(record)).toMatchObject({ bundleSha256: gen.sha256, coverageSha256: coverageSha(), source: expect.stringMatching(/^update-receipt:/) });
    const after = JSON.parse((await run([installer, '--doctor', '--json'], stepEnv, home)).stdout);
    expect(after.lines.find((l) => l.id === 'knowledge').detail).toMatch(/signature verified/);
    expect(after.failing).not.toContain('knowledge');
  }, 600_000);
});
