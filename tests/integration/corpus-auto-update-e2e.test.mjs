// tests/integration/corpus-auto-update-e2e.test.mjs — "all accounts auto update anytime a new corpus of
// knowledge happens … prove this all works end to end" (owner, 2026-10-02).
//
// REAL processes in an isolated temp HOME: the real installer installs corpus A; a 127.0.0.1 GitHub then
// "publishes" B; the REAL SessionStart hook (hook-shim.mjs → the installed spine) runs on a KB built 1h ago
// with a refresh receipt minutes old (fresh by every age rule) and must still launch the detached updater,
// land B, write a valid signature record, keep the private store byte-identical, then stay quiet and
// throttled. Then the long-lived MCP server (plugin/mcp/server.mjs) must, on its own timer, pick up C and
// serve it without a restart. Then: offline, lock held, remote OLDER than local, tampered signature.
//
// Test-side substitutions, and ONLY these (same as footprint-three-updates.test.mjs): the Ed25519 trust root
// in the harness copies of bin/install.mjs and kb/forge-update.mjs is a test key; the installed SOURCE.json
// polls the local server; `npx` on PATH runs the harness bin/install.mjs instead of downloading
// ruvnet-brain@latest from npm (it IS this code). The fixture bundle's kb entry points are stubs, so the stub
// npx re-places the package's real updater files after an update (production bundles carry them), and the
// reader dependency marker (kb/node_modules/@xenova/transformers/package.json) is placed once, as `npm i`
// would; POSIX only (the npx stand-in is a /bin/sh script); the search worker is a 20-line stand-in that reports the corpus tag of the KB it opened (RUVNET_BRAIN_CHILD_MCP).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { prepareCorpusCandidate } from '../../scripts/corpus-reconcile.mjs';
import { addPrivateStore } from '../../scripts/customer-seams.mjs';
import { getVersion } from '../../scripts/version.mjs';
import { SEED_IDENTITY, buildCorpus, buildRuntimeRoot, readJson, sha256File, tempDir, writeCoverage } from '../helpers/assemble-bundle-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VERSION = getVersion();
const REPO = 'stuinfla/ruvnet-brain';
const BUILDER_SHA = 'c'.repeat(40);
const KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_PUB = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).trim();
const sign = (bytes) => crypto.sign(null, crypto.createHash('sha256').update(bytes).digest(), KEYS.privateKey);
const UPDATER_FILES = ['forge-update.mjs', 'zip-extract.mjs', 'brain-profile.mjs', 'refresh-run.mjs',
  'update-storage-transaction.mjs', 'lifecycle-evidence-retention.mjs', 'corpus-release-identity.mjs'];
const shared = [];
const log = (line) => { if (process.env.CORPUS_E2E_TRANSCRIPT) fs.appendFileSync(process.env.CORPUS_E2E_TRANSCRIPT, `${line}\n`); };

let server; let origin; const served = { gen: null, offline: false, hits: 0 };
const release = (gen) => ({ tag_name: gen.tag, draft: false, prerelease: false, published_at: gen.generation,
  body: `Corpus generation: ${gen.generation}`, assets: [
    { name: 'ruvnet-brain.zip', size: gen.zip.length, digest: `sha256:${gen.sha256}`, browser_download_url: `${origin}/dl/${gen.sha256}.zip` },
    { name: 'ruvnet-brain.zip.sig', size: gen.sig.length, browser_download_url: `${origin}/dl/${gen.sha256}.zip.sig` }] });

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
  const extra = ['gamma', 'delta', 'epsilon', 'zeta'];
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

function harness() {
  const dir = tempDir(shared, 'harness');
  fs.cpSync(ROOT, dir, { recursive: true, filter: (source) => !['node_modules', '.git', 'dist', '.claude'].includes(path.basename(source)) });
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

const run = (args, env, cwd, input = '') => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env, cwd });
  let output = ''; let stdout = '';
  child.stdout.on('data', (d) => { output += d; stdout += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.stdin.end(input);
  child.on('close', (code) => resolve({ code, output, stdout }));
});
const waitFor = async (pred, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (pred()) return true; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 250)); }
  return false;
};
const json = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (served.offline) { req.socket.destroy(); return; }
    const gen = served.gen;
    if (req.url === '/registry/ruvnet-brain/latest') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`{"version":"${VERSION}"}`); return; }
    if (gen && req.url === `/repos/${REPO}/releases/latest`) { served.hits += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(release(gen))); return; }
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

describe('a newly published corpus reaches an install automatically — SessionStart and the long-lived MCP server', () => {
  it.skipIf(process.platform === 'win32')('A → B by SessionStart (no age trigger), throttled after; → C by the server timer, served without restart; offline, lock, older, tampered all keep the live KB', async () => {
    const { seed, generations } = await buildChain(4);
    const [A, B, C, D] = generations;
    const pkg = harness();
    fs.mkdirSync(path.join(pkg, 'dist'));
    fs.copyFileSync(seed.file, path.join(pkg, 'dist', 'ruvnet-brain.zip'));
    const home = fs.realpathSync(tempDir(shared, 'home'));
    const brainHome = path.join(home, '.cache', 'ruvnet-brain');
    const kbDir = path.join(brainHome, 'kb');
    const pluginDir = path.join(home, '.claude', 'plugins', 'cache', 'ruvnet-brain', 'ruvnet-brain', VERSION);
    fs.cpSync(path.join(pkg, 'plugin'), pluginDir, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'ruvnet-brain@ruvnet-brain': [{ installPath: pluginDir, version: VERSION }] } }));
    const bin = tempDir(shared, 'bin');
    const npxLog = path.join(home, 'npx-calls.log');
    // `npx --yes ruvnet-brain@latest <args>` → this package's installer (it is ruvnet-brain@latest here).
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh
echo "$@" >> "${npxLog}"
shift 2
export RUVNET_BRAIN_TEST=1 RUVNET_BRAIN_TEST_NPM_LATEST="${VERSION}" RUVNET_BRAIN_NO_UPDATE_FALLBACK=1 RUVNET_NO_TELEMETRY=1 RUFLO_DAEMON_AUTOSTART=0 RUVNET_TURN_CAPTURE=off npm_config_cache="${home}/.npm" npm_config_update_notifier=false
"${process.execPath}" "${path.join(pkg, 'bin', 'install.mjs')}" "$@"; code=$?
"${process.execPath}" -e 'const fs=require("fs");const f=process.argv[1];const s=JSON.parse(fs.readFileSync(f,"utf8"));s.canonicalManifestUrl=process.argv[2];fs.writeFileSync(f,JSON.stringify(s,null,2))' "${path.join(kbDir, 'SOURCE.json')}" "${origin}/repos/${REPO}/releases/latest"
if grep -q "fixture entry point" "${path.join(kbDir, 'forge-update.mjs')}" 2>/dev/null; then for f in ${UPDATER_FILES.join(' ')}; do cp "${path.join(pkg, 'kb')}/$f" "${kbDir}/$f"; done; fi
exit $code
`, { mode: 0o755 });
    const baseEnv = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter), HOME: home,
      TMPDIR: tempDir(shared, 'tmp'), CODEX_HOME: path.join(home, '.codex'), XDG_CACHE_HOME: path.join(home, '.cache'),
      npm_config_cache: path.join(home, '.npm'), npm_config_update_notifier: 'false', RUVNET_NO_TELEMETRY: '1',
      RUFLO_DAEMON_AUTOSTART: '0', RUVNET_TURN_CAPTURE: 'off', RUVNET_BRAIN_METER: '0' };
    const installEnv = { ...baseEnv, RUVNET_BRAIN_TEST: '1', RUVNET_BRAIN_TEST_NPM_LATEST: VERSION, RUVNET_BRAIN_NO_UPDATE_FALLBACK: '1' };
    const installer = path.join(pkg, 'bin', 'install.mjs');
    const installFlags = ['--yes', '--no-nightly-prompt', '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck', '--no-verify'];
    const pointAtLocalGithub = () => {
      const source = readJson(path.join(kbDir, 'SOURCE.json'));
      fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ ...source, canonicalManifestUrl: `${origin}/repos/${REPO}/releases/latest` }, null, 2));
    };
    const tagNow = () => readJson(path.join(kbDir, 'SOURCE.json')).corpusReleaseTag;
    const npxCalls = () => { try { return fs.readFileSync(npxLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
    const checkRecord = () => json(path.join(brainHome, 'corpus-check.json'));
    const attempt = () => json(path.join(brainHome, 'auto-update.json'));
    // The REAL SessionStart door: hooks.json's command, through hook-shim.mjs and the installed spine.
    const sessionEnv = { ...baseEnv, CLAUDE_PLUGIN_ROOT: pluginDir, RUVNET_BRAIN_TEST: '1', RUVNET_AUTO_UPDATE: 'on',
      RUVNET_AUTO_UPDATE_PROBE_URL: `${origin}/registry/ruvnet-brain/latest` };
    const session = (extra = {}) => run([path.join(pluginDir, 'scripts', 'hook-shim.mjs'), 'session-start'], { ...sessionEnv, ...extra }, home,
      JSON.stringify({ session_id: `e2e-${Date.now()}`, cwd: home, hook_event_name: 'SessionStart', source: 'startup' }));

    // ── install A (real installer), add a private store, then fix the clock rules: built 1h ago, receipt fresh ──
    expect((await run([installer, ...installFlags], installEnv, home)).code).toBe(0);
    pointAtLocalGithub();
    served.gen = A;
    const toA = await run([installer, '--update', '--no-nightly-prompt'], installEnv, home);
    expect(toA.code, toA.output.slice(-4000)).toBe(0);
    expect(tagNow()).toBe(A.tag);
    for (const f of UPDATER_FILES) fs.copyFileSync(path.join(pkg, 'kb', f), path.join(kbDir, f));
    // The reader dependencies a real install's `npm i` provides (the fixture skips the 300 MB download); the
    // updater carries live node_modules across every swap, so this one placement must survive B, C.
    fs.mkdirSync(path.join(kbDir, 'node_modules', '@xenova', 'transformers'), { recursive: true });
    fs.writeFileSync(path.join(kbDir, 'node_modules', '@xenova', 'transformers', 'package.json'), '{"name":"@xenova/transformers"}');
    const overlay = await addPrivateStore({ kbDir, scratch: tempDir(shared, 'overlay'), writerRoot: pkg });
    pointAtLocalGithub();
    const sourceA = readJson(path.join(kbDir, 'SOURCE.json'));
    fs.writeFileSync(path.join(kbDir, 'SOURCE.json'), JSON.stringify({ ...sourceA, builtUtc: new Date(Date.now() - 3_600_000).toISOString() }, null, 2));
    log(`installed A=${A.tag.slice(0, 26)} built 1h ago, refresh receipt fresh; private files=${Object.keys(overlay.digests).length}`);

    // ── 1. publish B; ONE SessionStart; the detached updater must land B with no age condition ──
    served.gen = B;
    const started = Date.now();
    const s1 = await session();
    expect(Date.now() - started, 'SessionStart never waits on the update').toBeLessThan(15_000);
    expect(await waitFor(() => checkRecord() !== null, 20_000), `no check launched; SessionStart said:\n${s1.output.slice(-3000)}`).toBe(true);
    expect(await waitFor(() => attempt()?.outcome === 'succeeded' && !fs.existsSync(path.join(brainHome, 'auto-update.lock')), 240_000),
      `attempt=${JSON.stringify(attempt())} check=${JSON.stringify(checkRecord())}\n${fs.existsSync(path.join(brainHome, '.last-auto-update-knowledge.log')) ? fs.readFileSync(path.join(brainHome, '.last-auto-update-knowledge.log'), 'utf8').slice(-6000) : ''}`).toBe(true);
    expect(tagNow()).toBe(B.tag);
    expect(attempt()).toMatchObject({ trigger: 'newer-corpus-published', targetTag: B.tag });
    expect(checkRecord()).toMatchObject({ outcome: 'updating', verdict: 'UPDATE_AVAILABLE', candidateTag: B.tag });
    const signature = json(path.join(brainHome, 'knowledge-signature.json'));
    expect(signature.coverageSha256).toBe(sha256File(path.join(kbDir, 'COVERAGE.json')));
    expect(signature.bundleSha256).toBe(B.sha256);
    for (const [file, digest] of Object.entries(overlay.digests)) expect(sha256File(path.join(kbDir, file)), file).toBe(digest);
    expect(npxCalls()).toBe(1);
    log(`1 SessionStart: launched in ${Date.now() - started}ms-ish; KB now ${tagNow().slice(0, 26)}; signature bound to COVERAGE; private bytes identical; s1 knowledge line: ${(s1.stdout.match(/KNOWLEDGE[^\n]*/) || ['(none)'])[0].slice(0, 160)}`);

    // ── 2. the next session says what happened ONCE and does not relaunch (60-min per-machine throttle) ──
    const checkedAt = checkRecord().launchedAt;
    const s2 = await session();
    expect(s2.stdout).toContain('KNOWLEDGE UPDATED]');
    const s3 = await session();
    expect(s3.stdout).not.toContain('KNOWLEDGE UPDATED]');
    expect(checkRecord().launchedAt).toBe(checkedAt);
    expect(npxCalls()).toBe(1);
    log(`2 next session: "${(s2.stdout.match(/KNOWLEDGE UPDATED][^\n]*/) || [''])[0].slice(0, 140)}"; third session silent; no relaunch (check stamp unchanged, npx calls=1)`);

    // ── 3. the long-lived MCP server: a session open for days never fires SessionStart again ──
    const worker = path.join(tempDir(shared, 'worker'), 'worker.mjs');
    fs.writeFileSync(worker, `import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
const tag = JSON.parse(fs.readFileSync(path.join(process.env.KB_DIR, 'SOURCE.json'), 'utf8')).corpusReleaseTag;
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (l) => { const m = JSON.parse(l);
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {} } });
  else if (m.method === 'brain/warmup') send({ jsonrpc: '2.0', id: m.id, result: { ready: true } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'serving ' + tag }] } });
  else send({ jsonrpc: '2.0', id: m.id, result: {} }); });
rl.on('close', () => process.exit(0));
`);
    const mcp = spawn(process.execPath, [path.join(pluginDir, 'mcp', 'server.mjs')], { env: { ...sessionEnv,
      RUVNET_BRAIN_CHILD_MCP: worker, RUVNET_CORPUS_CHECK_INTERVAL_MS: '500', RUVNET_CORPUS_CHECK_MINUTES: '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map(); let nextId = 1;
    readline.createInterface({ input: mcp.stdout }).on('line', (l) => { try { const m = JSON.parse(l); replies.set(m.id, m); } catch { /* ignore */ } });
    const call = async (method, params) => { const id = nextId++; mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      await waitFor(() => replies.has(id), 30_000); return replies.get(id); };
    try {
      await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      const ask = async () => (await call('tools/call', { name: 'search_ruvnet', arguments: { query: 'x' } }))?.result?.content?.[0]?.text;
      expect(await ask()).toBe(`serving ${B.tag}`);
      served.gen = C;
      expect(await waitFor(() => tagNow() === C.tag && attempt()?.outcome === 'succeeded' && !fs.existsSync(path.join(brainHome, 'auto-update.lock')), 240_000),
        `attempt=${JSON.stringify(attempt())} check=${JSON.stringify(checkRecord())}`).toBe(true);
      expect(await ask()).toBe(`serving ${C.tag}`);
      expect(mcp.exitCode).toBe(null);
      for (const [file, digest] of Object.entries(overlay.digests)) expect(sha256File(path.join(kbDir, file)), file).toBe(digest);
      expect(json(path.join(brainHome, 'knowledge-signature.json')).bundleSha256).toBe(C.sha256);
      log(`3 MCP server (pid ${mcp.pid}, never restarted): served B, its own timer installed C, next answer served C`);
    } finally {
      mcp.stdin.end(); mcp.kill();
    }

    // ── 4. offline: recorded quietly; nothing changes; nothing reports a failure ──
    const fast = { RUVNET_CORPUS_CHECK_MINUTES: '0' };
    served.offline = true;
    const calls = npxCalls();
    await session(fast);
    expect(await waitFor(() => checkRecord()?.outcome === 'offline', 60_000), JSON.stringify(checkRecord())).toBe(true);
    expect(tagNow()).toBe(C.tag);
    expect(npxCalls()).toBe(calls);
    expect((await session({ RUVNET_CORPUS_CHECK_MINUTES: '60' })).stdout).not.toMatch(/FAILING/);
    served.offline = false;
    log('4 offline: check recorded "offline", KB stays C, no updater run, no FAILING line');

    // ── 5. lock held: an update already running blocks a second one ──
    await waitFor(() => !fs.existsSync(path.join(brainHome, 'auto-update.lock')), 30_000);
    fs.writeFileSync(path.join(brainHome, 'auto-update.lock'), JSON.stringify({ pid: 1, at: new Date().toISOString() }));
    const before = checkRecord().launchedAt;
    served.gen = D;
    await session(fast);
    await new Promise((r) => setTimeout(r, 1500));
    expect(checkRecord().launchedAt).toBe(before);
    expect(tagNow()).toBe(C.tag);
    fs.rmSync(path.join(brainHome, 'auto-update.lock'));
    log('5 lock held: no check, no update, KB stays C');

    // ── 6. remote OLDER than local (A is published again): REFUSED, never downgrades ──
    served.gen = A;
    await session(fast);
    expect(await waitFor(() => checkRecord()?.outcome === 'refused' && !fs.existsSync(path.join(brainHome, 'auto-update.lock')), 60_000), JSON.stringify(checkRecord())).toBe(true);
    expect(checkRecord().verdict).toBe('REFUSED');
    expect(tagNow()).toBe(C.tag);
    expect(npxCalls()).toBe(calls);
    log('6 remote older (A): verdict REFUSED, no download, KB stays C');

    // ── 7. tampered signature on a newer corpus: the update refuses, the live KB and private bytes stay ──
    served.gen = { ...D, sig: sign(Buffer.from('not the bundle')) };
    await session(fast);
    expect(await waitFor(() => attempt()?.targetTag === D.tag && ['failed', 'succeeded'].includes(attempt()?.outcome)
      && !fs.existsSync(path.join(brainHome, 'auto-update.lock')), 240_000), JSON.stringify(attempt())).toBe(true);
    expect(tagNow()).toBe(C.tag);
    expect(json(path.join(brainHome, 'knowledge-signature.json')).bundleSha256).toBe(C.sha256);
    for (const [file, digest] of Object.entries(overlay.digests)) expect(sha256File(path.join(kbDir, file)), file).toBe(digest);
    const after = await session();
    log(`7 tampered D: attempt ${attempt().outcome} (exit ${attempt().code}: ${String(attempt().reason).slice(0, 120)}); KB stays C; next session: ${(after.stdout.match(/KNOWLEDGE[^\n]*/) || ['(none)'])[0].slice(0, 200)}`);
    expect(attempt().outcome).toBe('failed');
    expect(after.stdout).toMatch(/KNOWLEDGE UPDATE FAILING/);
  }, 900_000);
});
