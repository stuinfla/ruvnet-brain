#!/usr/bin/env node
// scripts/customer-state-matrix.mjs — apply ONE published release, through the REAL customer door, to a
// COPY of a real installed brain in ONE customer state at a time, and record what happened.
//
// WHY (2026-09-28 .. 09-30): three customer-path defects shipped in two days, each invisible to the unit
// suite and to scripts/corpus-canary.mjs, because the canary exercises exactly ONE machine state — a clean
// install at the newest approved runtime with no private stores. Customers are not in that state. This
// harness is the canary's install seam (installCustomer, customerEnv, customerManifestUrl are imported,
// not re-implemented), widened from one state to a derived matrix:
//
//   * BASES are real installs: `npm install ruvnet-brain@<v>` + that version's OWN installer + that
//     version's OWN published archive (corpus-canary installCustomer). Runtimes are DERIVED from the live
//     release list as offsets behind the candidate (N-1, N-5, N-11), never hand-typed versions.
//   * STATES are derived one-factor-at-a-time from STATE_AXES: every non-baseline value of every axis is
//     one scenario on top of the N-1 baseline. A state is a mutation of a COPY (APFS clone) of a base.
//   * The DOOR is what customers run: `npx ruvnet-brain@latest --update` = the candidate package's own
//     bin/install.mjs --update (updater self-upgrade, lock, refresh receipt, fallback and host sync all
//     real). The ONE substitution: SOURCE.json's releases/latest origin is a 127.0.0.1 mirror of the REAL
//     release payload whose asset URLs serve the REAL signed bytes downloaded once. Signature, digest,
//     coverage and runtime-identity checks all run as shipped.
//
//   node scripts/customer-state-matrix.mjs --work <dir> --tag vX.Y.Z --zip <ruvnet-brain.zip> \
//        --release-json <release.json> --package <dir containing node_modules/ruvnet-brain> --list
//        | --base N-1 | --scenario <id> [--node <path>]
// Scenarios run strictly one at a time; each writes <work>/results/<id>.json.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { customerEnv, customerManifestUrl, installCustomer, installedModules } from './corpus-canary.mjs';
import { addPrivateStore, resolveRuntime } from './customer-seams.mjs';
export { resolveRuntime };
import { doctorSmokeArgs } from './installed-brain-health.mjs';

export const REPO = 'stuinfla/ruvnet-brain';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * The axes a real customer machine varies on. `baseline` is the clean N-1 customer; every other value
 * becomes exactly one scenario. Runtime values are offsets, resolved against the live release list.
 */
export const STATE_AXES = Object.freeze([
  { axis: 'runtime', baseline: 'N-1', values: ['N-1', 'N-5', 'N-11'] },
  { axis: 'profile', baseline: 'complete', values: ['complete', 'ruvector'] },
  { axis: 'overlay', baseline: 'none', values: ['none', 'private-store'] },
  { axis: 'leftovers', baseline: 'none', values: ['none', 'redundant-copies', 'two-preserved-generations'] },
  { axis: 'lock', baseline: 'none', values: ['none', 'dead-owner'] },
  { axis: 'transaction', baseline: 'none', values: ['none', 'killed-during-candidate-build', 'killed-after-old-rename'] },
  { axis: 'location', baseline: 'home-cache', values: ['home-cache', 'symlinked-cache', 'symlinked-brain-home', 'relocated-env'] },
  { axis: 'reader', baseline: 'present', values: ['present', 'no-node-modules', 'no-model-cache'] },
  { axis: 'network', baseline: 'online', values: ['online', 'manifest-rate-limited'] },
  // How the update is started: the npx installer door, or the INSTALLED updater run directly (the
  // session-start hint 'cd ~/.cache/ruvnet-brain/kb && node forge-update.mjs --apply', old cron lines).
  { axis: 'door', baseline: 'npx-update', values: ['npx-update', 'installed-updater'] },
]);

/** One-factor-at-a-time derivation: the baseline scenario plus one scenario per non-baseline value. */
export function deriveScenarios(axes = STATE_AXES) {
  const baseline = Object.fromEntries(axes.map(({ axis, baseline: value }) => [axis, value]));
  const scenarios = [{ id: 'baseline', state: baseline }];
  for (const { axis, baseline: value, values } of axes) {
    for (const option of values) if (option !== value) scenarios.push({ id: `${axis}=${option}`, state: { ...baseline, [axis]: option } });
  }
  return scenarios;
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error || r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed: ${r.error?.message || r.stderr || r.stdout}`);
  return r;
};
const clone = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); run('cp', ['-cR', from, to]); };
const kbOf = (home) => path.join(home, '.cache', 'ruvnet-brain', 'kb');

/** Files a public bundle never owns — private overlay probes are measured over exactly these. */
function privateFileDigests(kbDir, name) {
  return Object.fromEntries(fs.readdirSync(kbDir).filter((f) => f === name || f.startsWith(`${name}.`) || f.startsWith(`${name}-`))
    .sort().map((f) => [f, sha256File(path.join(kbDir, f))]));
}

/** The mutations. Each takes a cloned home and returns facts the judge needs. */
const PREPARE = {
  runtime: async () => ({}),
  profile: async (value, { home, kbDir, packageRoot }) => {
    if (value !== 'ruvector') return {};
    writeJson(path.join(home, '.config', 'ruvnet-brain', 'settings.json'), { settings: { brainProfile: 'ruvector' } });
    // The candidate package's own profile writer (the Console and the installer call this same function).
    const { applyBrainProfile } = await import(pathToFileURL(path.join(packageRoot, 'kb', 'brain-profile.mjs')).href);
    return { profileApplied: applyBrainProfile(kbDir, 'ruvector').removedStores?.length ?? null };
  },
  overlay: async (value, { kbDir, sandbox, packageRoot }) => (value === 'private-store'
    ? { privateStore: await addPrivateStore({ kbDir, scratch: sandbox, writerRoot: packageRoot }) } : {}),
  leftovers: async (value, { kbDir }) => {
    if (value === 'none') return {};
    const stamp = Date.now();
    if (value === 'redundant-copies') {
      clone(kbDir, `${kbDir}.bak-${stamp}`);
      clone(kbDir, `${kbDir}.install-preserved-${stamp}`);
    } else {
      // Two prior generations the installer preserved (`npx ruvnet-brain --force` twice): each differs
      // from live by one file, exactly like a real older generation would.
      for (const n of [1, 2]) {
        const dir = `${kbDir}.install-preserved-${stamp}${n}`;
        clone(kbDir, dir);
        fs.appendFileSync(path.join(dir, 'capability-cards.md'), `\n<!-- generation ${n} -->\n`);
      }
    }
    return {};
  },
  lock: async (value, { kbDir }) => {
    if (value === 'none') return {};
    // The exact v3 owner record an updater killed by a reboot leaves behind: same host, a pid that is dead.
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const runId = `${Date.now()}-deadbeefdeadbeef`;
    const brainHome = path.dirname(kbDir);
    const lock = path.join(brainHome, `.${path.basename(kbDir)}.refresh-run.lock`);
    writeJson(path.join(lock, 'owner.json'), { schemaVersion: 3, runId, pid: Number(dead.stdout), token: crypto.randomBytes(24).toString('hex'),
      kbDir, brainHome, receiptPath: path.join(brainHome, 'refresh-runs', `${runId}.json`), host: os.hostname(),
      executable: process.execPath, processStart: 'Thu Jan  1 00:00:00 2026', startedAt: new Date().toISOString(),
      receiptSeed: { action: 'nightly', desiredVersion: null } });
    return { deadPid: Number(dead.stdout) };
  },
  transaction: async (value, { kbDir }) => {
    if (value === 'none') return {};
    // The likely interruption: the REAL door, SIGKILLed (laptop lid, Ctrl-C, a TTL supervisor) while it
    // is building the sibling candidate — the longest phase. runScenario performs that first run.
    if (value === 'killed-during-candidate-build') return { killFirstRunWhen: `${path.basename(kbDir)}.next-` };
    // A REAL crash: the installed runtime's own runStorageTransaction, killed right after it renamed live away.
    const source = `${kbDir}.crash-source`;
    clone(kbDir, source);
    fs.appendFileSync(path.join(source, 'capability-cards.md'), '\n<!-- interrupted candidate -->\n');
    const driver = path.join(path.dirname(kbDir), 'crash-driver.mjs');
    fs.writeFileSync(driver, `import { runStorageTransaction } from ${JSON.stringify(pathToFileURL(path.join(kbDir, 'update-storage-transaction.mjs')).href)};
runStorageTransaction({ liveDir: ${JSON.stringify(kbDir)}, sourceDir: ${JSON.stringify(source)}, transactionId: 'crash-${Date.now()}',
  checkpoint: (state) => { if (state === 'OLD_RENAMED') process.kill(process.pid, 'SIGKILL'); } });\n`);
    const r = spawnSync(process.execPath, [driver], { encoding: 'utf8' });
    fs.rmSync(driver); fs.rmSync(source, { recursive: true, force: true });
    return { crashSignal: r.signal, liveMissingAfterCrash: !fs.existsSync(kbDir) };
  },
  location: async (value, { home }) => {
    const cache = path.join(home, '.cache');
    if (value === 'symlinked-cache') {
      fs.renameSync(cache, path.join(home, 'external-cache'));
      fs.symlinkSync(path.join(home, 'external-cache'), cache);
    } else if (value === 'symlinked-brain-home') {
      fs.renameSync(path.join(cache, 'ruvnet-brain'), path.join(home, 'external-brain'));
      fs.symlinkSync(path.join(home, 'external-brain'), path.join(cache, 'ruvnet-brain'));
    } else if (value === 'relocated-env') {
      fs.renameSync(path.join(cache, 'ruvnet-brain'), path.join(home, 'external-brain'));
      return { env: { RUVNET_BRAIN_HOME: path.join(home, 'external-brain'), RUVNET_BRAIN_KB: path.join(home, 'external-brain', 'kb') } };
    }
    return {};
  },
  reader: async (value, { kbDir }) => {
    if (value === 'no-node-modules') fs.rmSync(path.join(kbDir, 'node_modules'), { recursive: true, force: true });
    if (value === 'no-model-cache') fs.rmSync(path.join(path.dirname(kbDir), 'models'), { recursive: true, force: true });
    return {};
  },
  door: async () => ({}),
  network: async (value) => (value === 'manifest-rate-limited' ? { mirror: { manifestStatus: 403 } } : {}),
};

/** A 127.0.0.1 GitHub: the REAL release payload, asset URLs re-pointed at the REAL bytes on disk. */
async function startMirror({ release, zip, manifestStatus = 200 }) {
  const files = { 'ruvnet-brain.zip': zip, 'ruvnet-brain.zip.sig': `${zip}.sig` };
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === `/repos/${REPO}/releases/latest`) {
      if (manifestStatus !== 200) { res.writeHead(manifestStatus, { 'content-type': 'application/json' }).end('{"message":"API rate limit exceeded"}'); return; }
      const origin = `http://127.0.0.1:${server.address().port}`;
      const assets = release.assets.map((a) => (files[a.name] ? { ...a, browser_download_url: `${origin}/dl/${a.name}` } : a));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...release, assets }));
      return;
    }
    const name = decodeURIComponent((/^\/dl\/(.+)$/.exec(req.url) || [])[1] || '');
    if (files[name]) { res.writeHead(200, { 'content-length': fs.statSync(files[name]).size }); fs.createReadStream(files[name]).pipe(res); return; }
    res.writeHead(404).end('not mirrored');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

/** The one change the harness makes to an install: the origin of the channel it already polls. */
export function pointAtMirror(kbDir, origin) {
  const file = path.join(kbDir, 'SOURCE.json');
  const source = readJson(file);
  const expected = customerManifestUrl({ repo: REPO });
  if (source.canonicalManifestUrl !== expected) throw new Error(`installed SOURCE.json polls ${source.canonicalManifestUrl}, not ${expected}`);
  writeJson(file, { ...source, canonicalManifestUrl: customerManifestUrl({ apiBase: origin, repo: REPO }) });
}

function newestRefreshReceipt(brainHome) {
  const dir = path.join(brainHome, 'refresh-runs');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.length ? readJson(files[0]) : null;
}

/** A real query through the installed reader, then the installed citation verifier. */
async function searchWorks({ kbDir, brainHome, nodeBin, repo }) {
  const args = doctorSmokeArgs(kbDir).map((a) => (a === 'ruvnet-brain' ? repo : a));
  const r = spawnSync(nodeBin, args, { cwd: kbDir, encoding: 'utf8', timeout: 600_000,
    env: { ...process.env, KB_MODEL_CACHE: path.join(brainHome, 'models'), RUVNET_BRAIN_QUERY_DEADLINE_MS: '240000' } });
  if (r.status !== 0 || !String(r.stdout).trim()) return { ok: false, detail: `exit ${r.status} ${r.signal || ''} ${String(r.stderr).slice(-300)}` };
  try {
    const { verifyGrounding } = await import(pathToFileURL(path.join(kbDir, 'verify-citation.mjs')).href);
    const v = await verifyGrounding(r.stdout, kbDir);
    return { ok: v.grounded === true, detail: v.grounded ? v.receipt.path : v.reason };
  } catch (error) { return { ok: false, detail: `verifier: ${error.message}` }; }
}

function siblings(kbDir) {
  try { return fs.readdirSync(path.dirname(fs.realpathSync(kbDir))).filter((n) => n.includes(path.basename(kbDir)) && n !== path.basename(kbDir)); }
  catch { return ['(kb parent unreadable)']; }
}

export async function runScenario({ scenario, work, tag, zip, release, packageRoot, bases, nodeBin = process.execPath }) {
  const live = path.join(work, 'live');
  const home = path.join(live, 'home');
  fs.rmSync(live, { recursive: true, force: true });
  const runtime = bases[scenario.state.runtime];
  clone(path.join(runtime.dir, 'home'), home);
  fs.mkdirSync(path.join(live, 'tmp'), { recursive: true });
  let kbDir = kbOf(home);
  const facts = { sandbox: live, packageRoot, home, kbDir };
  const prepared = {};
  for (const { axis } of STATE_AXES) Object.assign(prepared, await PREPARE[axis](scenario.state[axis], facts));
  const env = { ...customerEnv({ home, work: live }), PATH: [path.dirname(nodeBin), '/usr/bin', '/bin'].join(path.delimiter), ...(prepared.env || {}) };
  kbDir = env.RUVNET_BRAIN_KB;
  const brainHome = env.RUVNET_BRAIN_HOME;
  const mirror = await startMirror({ release, zip, ...(prepared.mirror || {}) });
  // A crash between the two renames leaves no live tree; touching the rollback copy would falsify the
  // very receipt identity recovery checks, so that state is measured as found.
  const hasLive = fs.existsSync(path.join(kbDir, 'SOURCE.json'));
  const before = hasLive ? { source: readJson(path.join(kbDir, 'SOURCE.json')), generations: readJson(path.join(kbDir, 'RVF-GENERATIONS.json')),
    modules: installedModules(kbDir), private: prepared.privateStore ? privateFileDigests(kbDir, prepared.privateStore.name) : null }
    : { source: {}, generations: { stores: null }, modules: [], private: null };
  if (hasLive) pointAtMirror(kbDir, mirror.origin);
  // Apparent bytes under the sandbox (home + TMPDIR). The volume is shared with other work, so statfs
  // deltas are noise; du over the sandbox is this run's own footprint (APFS clones count at full size).
  const du = () => Number(spawnSync('du', ['-sk', live], { encoding: 'utf8' }).stdout.split(/\s/)[0]) * 1024;
  const bytes0 = du();
  let peakBytes = bytes0;
  const sampler = setInterval(() => { peakBytes = Math.max(peakBytes, du()); }, 10_000);
  const openDoor = (killWhen = null) => new Promise((resolve) => {
    const direct = scenario.state.door === 'installed-updater';
    const child = spawn(nodeBin, direct ? ['forge-update.mjs', '--apply'] : [path.join(packageRoot, 'bin', 'install.mjs'), '--update', '--no-nightly-prompt'],
      { cwd: direct ? kbDir : home, env, stdio: ['ignore', 'pipe', 'pipe'], detached: Boolean(killWhen) });
    let output = '';
    let watch = null;
    if (killWhen) {
      watch = setInterval(() => {
        let names = [];
        try { names = fs.readdirSync(fs.realpathSync(path.dirname(kbDir))); } catch { /* mid-rename */ }
        if (names.some((n) => n.startsWith(killWhen))) {
          clearInterval(watch);
          setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 5000);
        }
      }, 500);
    }
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('close', (code, signal) => { if (watch) clearInterval(watch); resolve({ code, signal, output }); });
  });
  if (prepared.killFirstRunWhen) {
    const first = await openDoor(prepared.killFirstRunWhen);
    prepared.firstRun = { exit: first.code, signal: first.signal, siblings: siblings(kbDir) };
    fs.writeFileSync(path.join(work, 'results', `${scenario.id}.first-run.log`), first.output);
  }
  const started = Date.now();
  const door = await openDoor();
  clearInterval(sampler);
  const wallMs = Date.now() - started;
  await mirror.close();
  fs.writeFileSync(path.join(work, 'results', `${scenario.id}.log`), door.output);
  const receipt = newestRefreshReceipt(brainHome);
  const after = fs.existsSync(path.join(kbDir, 'SOURCE.json')) ? readJson(path.join(kbDir, 'SOURCE.json')) : null;
  const generationsAfter = fs.existsSync(path.join(kbDir, 'RVF-GENERATIONS.json')) ? readJson(path.join(kbDir, 'RVF-GENERATIONS.json')) : null;
  const update = receipt?.phases?.find((p) => p.phase === 'update');
  const search = after ? await searchWorks({ kbDir, brainHome, nodeBin, repo: scenario.state.profile === 'ruvector' ? 'ruvector' : 'ruvnet-brain' }) : { ok: false, detail: 'no KB' };
  return {
    id: scenario.id, state: scenario.state, runtime: runtime.version, candidate: tag, node: spawnSync(nodeBin, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    prepared: { ...prepared, env: undefined, mirror: undefined, killFirstRunWhen: undefined },
    door: { exit: door.code, signal: door.signal, fallback: /falling back to a fresh install|authenticated staged recovery/.test(door.output) ? 'fired' : 'no',
      lastLines: door.output.split('\n').filter((l) => /✗|ERROR|refus|fail|DONE|warn|⚠/i.test(l)).slice(-12) },
    refreshReceipt: receipt ? { status: receipt.status, terminalVerdict: receipt.terminalVerdict,
      updateTerminalVerdict: update?.evidence?.terminalVerdict ?? update?.evidence?.updateResult?.terminalVerdict ?? null,
      failedPhase: receipt.phases?.find((p) => p.status === 'FAIL')?.phase || null,
      updaterReason: receipt.phases?.find((p) => p.status === 'FAIL')?.evidence?.updateResult?.reason?.slice(0, 600) || null } : null,
    storesAdvanced: Boolean(after) && after.releaseTag === tag && after.brainVersion === tag.slice(1)
      && JSON.stringify(generationsAfter?.stores) !== JSON.stringify(before.generations.stores),
    sourceBefore: { releaseTag: before.source.releaseTag, brainVersion: before.source.brainVersion },
    sourceAfter: after ? { releaseTag: after.releaseTag, brainVersion: after.brainVersion } : null,
    privateByteIdentical: before.private ? JSON.stringify(privateFileDigests(kbDir, prepared.privateStore.name)) === JSON.stringify(before.private) : null,
    readerModulesKept: before.modules.every((m) => installedModules(kbDir).includes(m)),
    search, wallClockSec: Math.round(wallMs / 1000), peakDiskGB: Number((peakBytes / 1e9).toFixed(2)), peakGrowthGB: Number(((peakBytes - bytes0) / 1e9).toFixed(2)),
    kbSiblingsAfter: siblings(kbDir), mirrorHits: mirror.hits.length,
  };
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

async function main(argv = process.argv.slice(2)) {
  const work = path.resolve(arg(argv, '--work'));
  const tag = arg(argv, '--tag');
  const release = readJson(arg(argv, '--release-json'));
  const zip = path.resolve(arg(argv, '--zip'));
  const packageRoot = path.join(path.resolve(arg(argv, '--package')), 'node_modules', 'ruvnet-brain');
  const releases = JSON.parse(run('gh', ['api', `repos/${REPO}/releases?per_page=100`]).stdout);
  const scenarios = deriveScenarios();
  if (argv.includes('--list')) { for (const s of scenarios) console.log(s.id); return 0; }
  const offset = arg(argv, '--base');
  if (offset) {
    const version = resolveRuntime(offset, { candidateTag: tag, releases });
    const dir = path.join(work, 'bases', version);
    if (fs.existsSync(path.join(dir, 'home'))) { console.log(`base ${offset} = ${version} exists`); return 0; }
    // Installed AT the scenario path, then moved: every absolute path the installer wrote stays valid
    // when a scenario clones it back to <work>/live.
    const live = path.join(work, 'live');
    fs.rmSync(live, { recursive: true, force: true });
    const started = Date.now();
    fs.mkdirSync(path.join(live, 'home'), { recursive: true });
    installCustomer({ approvedVersion: version, work: live, home: path.join(live, 'home'),
      log: (text) => fs.appendFileSync(path.join(work, `base-${version}.log`), `${text}\n`) });
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(path.join(live, 'home'), path.join(dir, 'home'));
    writeJson(path.join(dir, 'base.json'), { offset, version, installedSec: Math.round((Date.now() - started) / 1000) });
    fs.rmSync(live, { recursive: true, force: true });
    console.log(`base ${offset} = ${version} installed`);
    return 0;
  }
  const id = arg(argv, '--scenario');
  const found = scenarios.find((s) => s.id === id);
  // --runtime crosses one scenario with another runtime offset (e.g. an old install started the old way).
  const scenario = found && arg(argv, '--runtime') ? { id: `${found.id}+runtime=${arg(argv, '--runtime')}`, state: { ...found.state, runtime: arg(argv, '--runtime') } } : found;
  if (!scenario) throw new Error(`unknown scenario ${id}; --list shows them`);
  const bases = {};
  for (const off of new Set(scenarios.map((s) => s.state.runtime))) {
    const version = resolveRuntime(off, { candidateTag: tag, releases });
    bases[off] = { version, dir: path.join(work, 'bases', version) };
  }
  if (!fs.existsSync(path.join(bases[scenario.state.runtime].dir, 'home'))) throw new Error(`base ${scenario.state.runtime} is not installed; run --base first`);
  fs.mkdirSync(path.join(work, 'results'), { recursive: true });
  // The Node axis is the interpreter itself: the same state under another node gets its own result id.
  const nodeBin = arg(argv, '--node') || process.execPath;
  if (arg(argv, '--node')) scenario.id = `${scenario.id}@node${spawnSync(nodeBin, ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8' }).stdout.trim()}`;
  const result = await runScenario({ scenario, work, tag, zip, release, packageRoot, bases, nodeBin });
  writeJson(path.join(work, 'results', `${scenario.id}.json`), result);
  console.log(JSON.stringify(result, null, 2));
  if (!argv.includes('--keep')) fs.rmSync(path.join(work, 'live'), { recursive: true, force: true });
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.stack || error.message); process.exitCode = 1; });
}
