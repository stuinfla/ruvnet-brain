#!/usr/bin/env node
// MEASUREMENT ONLY (ci-probe/* branch). Where does the doctor's first question spend its time on a
// fresh public install? Runs the published package exactly as a customer gets it, in throwaway
// HOMEs, and times: the cold model phases separately, the cold probe end to end, the warm probe
// alone, and the warm probe three-at-once (the protected-release public-verification condition).
// usage: node doctor-cold-probe.mjs <version> <outDir>
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [version, outDir] = process.argv.slice(2);
if (!version || !outDir) { console.error('usage: doctor-cold-probe.mjs <version> <outDir>'); process.exit(2); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-probe-${version}-`));
fs.mkdirSync(outDir, { recursive: true });
const QUERY = 'What package name is declared in the RuvNet Brain KB package manifest?';
const results = [];
const record = (row) => { const r = { version, ...row }; results.push(r); console.log(JSON.stringify(r)); };
const swap = () => { try { return execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).trim(); } catch { return null; } };
const load = () => os.loadavg().map((v) => +v.toFixed(2));

record({ stage: 'host', cpus: os.availableParallelism(), memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
  freeGB: +(os.freemem() / 2 ** 30).toFixed(1), swap: swap(), node: process.version, platform: `${process.platform}-${process.arch}` });

execFileSync('npm', ['pack', `ruvnet-brain@${version}`, '--silent'], { cwd: root, stdio: 'pipe' });
execFileSync('tar', ['-xzf', `ruvnet-brain-${version}.tgz`], { cwd: root });
const pkg = path.join(root, 'package');

function homeFor(name) {
  const home = path.join(root, name);
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  return { home, brainHome, kb: path.join(brainHome, 'kb'), models: path.join(brainHome, 'models') };
}
function envFor(h, models = h.models, extra = {}) {
  return { ...process.env, HOME: h.home, RUVNET_BRAIN_HOME: h.brainHome, RUVNET_BRAIN_KB: h.kb, KB_MODEL_CACHE: models,
    RUVNET_STRICT_INSTALL: '0', CI: 'true', ...extra };
}

const A = homeFor('home-a');
fs.mkdirSync(path.join(A.home, '.claude'), { recursive: true });
let t = Date.now();
const inst = spawnSync(process.execPath, [path.join(pkg, 'bin', 'install.mjs'), '--yes', '--force', '--version', `v${version}`,
  '--no-nightly-prompt', '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck', '--no-verify'],
{ cwd: pkg, env: envFor(A), encoding: 'utf8', timeout: 1_800_000 });
fs.writeFileSync(path.join(outDir, `install-${version}.log`), `${inst.stdout}\n----\n${inst.stderr}`);
record({ stage: 'install', exit: inst.status, secs: (Date.now() - t) / 1000,
  modelsAfterInstall: fs.existsSync(A.models) ? fs.readdirSync(A.models) : [] });
if (inst.status !== 0) { fs.writeFileSync(path.join(outDir, `results-${version}.json`), JSON.stringify(results, null, 2)); process.exit(1); }

// The phase-split warm script lives in a scratch file next to the KB (runner-only).
const warmScript = path.join(A.kb, '_probe-warm.mjs');
fs.writeFileSync(warmScript, `
const t0 = performance.now();
const ask = await import('./forge-ask.mjs');
const t1 = performance.now();
await ask.warmQueryEmbedder();
const t2 = performance.now();
const rr = await import('./forge-rerank.mjs');
const t3 = performance.now();
await rr.warmReranker();
const t4 = performance.now();
console.log(JSON.stringify({ importAskMs: Math.round(t1 - t0), embedderWarmMs: Math.round(t2 - t1),
  importRerankMs: Math.round(t3 - t2), rerankerWarmMs: Math.round(t4 - t3) }));
process.exit(0);
`);

function timedProbe(h, label, models, { background = false } = {}) {
  const trace = path.join(outDir, `rt-${version}-${label}.jsonl`);
  const ceTrace = path.join(outDir, `ce-${version}-${label}.jsonl`);
  const args = ['-l', process.execPath, 'forge-ask-all.mjs', '--dir', h.kb, '--q', QUERY,
    '--repos', 'ruvnet-brain', '--k', '3', '--pool', '8', '--bounded'];
  const env = envFor(h, models, { KB_RETRIEVAL_TRACE: trace, KB_CE_TRACE: ceTrace, RUVNET_BRAIN_QUERY_DEADLINE_MS: '600000' });
  const started = Date.now();
  const finish = (status, stdout, stderr) => {
    const rss = (String(stderr).match(/(\d+)\s+maximum resident set size/) || [])[1];
    const rt = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const ce = fs.existsSync(ceTrace) ? fs.readFileSync(ceTrace, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { stage: 'probe', label, exit: status, secs: (Date.now() - started) / 1000, maxRssMB: rss ? Math.round(rss / 2 ** 20) : null,
      phases: rt.map(({ routeMs, retrievalMs, rerankMs, lane }) => ({ routeMs, retrievalMs, rerankMs, lane })),
      pool: ce.map(({ pooledAll, scored, prefilterMs }) => ({ pooledAll, scored, prefilterMs })),
      answered: /#1|repo\s*=/.test(String(stdout)), load: load(), swap: swap(),
      stderrTail: String(stderr).split('\n').filter((l) => l && !/^\s+\d+\s+[a-z]/.test(l)).slice(-2) };
  };
  if (!background) {
    const r = spawnSync('/usr/bin/time', args, { cwd: h.kb, env, encoding: 'utf8', timeout: 900_000 });
    return finish(r.status, r.stdout, r.stderr);
  }
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/time', args, { cwd: h.kb, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve(finish(status, stdout, stderr)));
  });
}

// 1. Customer cold, phases split: an EMPTY model cache, then the model phases one at a time.
fs.rmSync(A.models, { recursive: true, force: true });
t = Date.now();
const warm = spawnSync(process.execPath, ['_probe-warm.mjs'], { cwd: A.kb, env: envFor(A), encoding: 'utf8', timeout: 900_000 });
record({ stage: 'cold-phase-split', exit: warm.status, secs: (Date.now() - t) / 1000,
  phases: (() => { try { return JSON.parse(warm.stdout.trim().split('\n').pop()); } catch { return warm.stdout.slice(-300); } })(),
  stderrTail: String(warm.stderr).split('\n').slice(-3) });
// The probe right after: models cached, process fresh.
record(timedProbe(A, 'after-warm', A.models));

// 2. Customer cold end to end: empty cache again, the probe pays download + load + query.
fs.rmSync(A.models, { recursive: true, force: true });
record(timedProbe(A, 'cold-e2e', A.models));

// 3. Warm cache, one process at a time (what a customer's later CLI questions cost).
for (let i = 1; i <= 3; i++) record(timedProbe(A, `warm-alone-${i}`, A.models));

// 4. The public-verification condition: three separate KB copies sharing the warm cache, three at once.
const copies = ['home-b', 'home-c', 'home-d'].map((n) => {
  const h = homeFor(n);
  fs.mkdirSync(path.dirname(h.kb), { recursive: true });
  execFileSync('cp', ['-R', A.kb, h.kb]);
  return h;
});
for (let round = 1; round <= 2; round++) {
  const rows = await Promise.all(copies.map((h, i) => timedProbe(h, `concurrent3-r${round}-${i}`, A.models, { background: true })));
  for (const r of rows) record(r);
}

// 5. The installer's own doctor once (the exact customer-visible line), on the warm home.
t = Date.now();
const doc = spawnSync(process.execPath, [path.join(pkg, 'bin', 'install.mjs'), '--doctor'], { cwd: pkg, env: envFor(A), encoding: 'utf8', timeout: 600_000 });
const docLines = String(doc.stdout).split('\n').filter((l) => /verified in|no answer came back|reader reported|QUERY DEADLINE|Grounding/.test(l));
record({ stage: 'installer-doctor', exit: doc.status, secs: (Date.now() - t) / 1000, lines: docLines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).slice(0, 6) });

fs.writeFileSync(path.join(outDir, `results-${version}.json`), JSON.stringify(results, null, 2));
