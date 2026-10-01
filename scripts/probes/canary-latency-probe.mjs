#!/usr/bin/env node
// MEASUREMENT ONLY (ci-probe/* branch). Per-query latency of the release retrieval canaries against
// a fresh public install, through the installed MCP server, two ways:
//   fresh  — a new server per query (cold worker every time), first 6 queries only
//   warm   — ONE warm server for the lane (how a customer's session works), all queries x2 rounds
// Limits are generous (120s) so the true latency is recorded instead of a timeout.
// usage: node canary-latency-probe.mjs <version> <outDir>
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstalledMcpSession, SELF_STORE_PROOF_QUERY, SELF_STORE_PROOF_K } from '../host-install-matrix.mjs';

const [version, outArg] = process.argv.slice(2);
const outDir = path.resolve(outArg || 'probe-out');
fs.mkdirSync(outDir, { recursive: true });
const plan = JSON.parse(fs.readFileSync(new URL('./canary-queries.json', import.meta.url), 'utf8'));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `canary-lat-${version}-`)));
const rows = [];
const record = (row) => { const r = { os: process.platform, version, ...row }; rows.push(r); console.log(JSON.stringify(r)); };

record({ stage: 'host', cpus: os.availableParallelism(), memGB: +(os.totalmem() / 2 ** 30).toFixed(1), node: process.version });
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', `ruvnet-brain@${version}`, '--silent'], { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' });
execFileSync('tar', ['-xzf', `ruvnet-brain-${version}.tgz`], { cwd: root });
const pkg = path.join(root, 'package');
const home = path.join(root, 'home');
const brainHome = path.join(home, '.cache', 'ruvnet-brain');
const env = { ...process.env, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: brainHome, RUVNET_BRAIN_KB: path.join(brainHome, 'kb'),
  KB_MODEL_CACHE: path.join(brainHome, 'models'), RUVNET_STRICT_INSTALL: '0', CI: 'true' };
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
let t = Date.now();
const inst = spawnSync(process.execPath, [path.join(pkg, 'bin', 'install.mjs'), '--yes', '--force', '--version', `v${version}`,
  '--no-nightly-prompt', '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck', '--no-verify'],
{ cwd: pkg, env, encoding: 'utf8', timeout: 1_800_000 });
fs.writeFileSync(path.join(outDir, `install-${process.platform}-${version}.log`), `${inst.stdout}\n----\n${inst.stderr}`);
record({ stage: 'install', exit: inst.status, secs: (Date.now() - t) / 1000 });
// With no host CLI on the runner the installer wires no host, so no persistent copy exists under
// ~/.claude; the package's own plugin server is the same file it would have copied, and it finds
// the installed KB through RUVNET_BRAIN_KB / RUVNET_BRAIN_HOME exactly as the copy does.
const installed = path.join(home, '.claude', 'ruvnet-brain', 'mcp', 'server.mjs');
const serverPath = fs.existsSync(installed) ? installed : path.join(pkg, 'plugin', 'mcp', 'server.mjs');
record({ stage: 'server', serverPath, installedCopy: fs.existsSync(installed) });
if (inst.status !== 0 || !fs.existsSync(serverPath)) { record({ stage: 'abort', serverPresent: fs.existsSync(serverPath) }); process.exit(1); }

const LIMIT = 120_000;
const one = async (session, query, k, label) => {
  const started = Date.now();
  const r = await session.search({ query, k, timeoutMs: LIMIT });
  return { label, ok: !r.error && r.status === 0, broadMs: r.broadMs ?? null, wallMs: Date.now() - started, error: r.error?.message ?? null };
};

// fresh: a new server for each of the first 6 canary queries (worker start + model load every time)
for (const c of plan.cases.slice(0, 6)) {
  const s = createInstalledMcpSession({ serverPath, env, timeout: LIMIT });
  try { record({ stage: 'fresh', id: c.id, ...(await one(s, c.query, plan.k, 'fresh')) }); } finally { await s.close(); }
}

// warm: ONE server for the lane
const s = createInstalledMcpSession({ serverPath, env, timeout: 300_000 });
try {
  t = Date.now();
  const w = await s.search({ query: SELF_STORE_PROOF_QUERY, k: SELF_STORE_PROOF_K, timeoutMs: 300_000 });
  record({ stage: 'warmup', ok: !w.error, wallMs: Date.now() - t, broadMs: w.broadMs ?? null, error: w.error?.message ?? null });
  for (let round = 1; round <= 2; round++) {
    for (const c of plan.cases) record({ stage: 'warm', round, id: c.id, ...(await one(s, c.query, plan.k, 'warm')) });
  }
} finally { await s.close(); }

const stats = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return v.length ? { n: v.length, min: v[0], p50: q(0.5), p90: q(0.9), max: v.at(-1) } : { n: 0 };
};
record({ stage: 'summary',
  fresh: stats(rows.filter((r) => r.stage === 'fresh').map((r) => r.wallMs)),
  warmR1: stats(rows.filter((r) => r.stage === 'warm' && r.round === 1).map((r) => r.broadMs)),
  warmR2: stats(rows.filter((r) => r.stage === 'warm' && r.round === 2).map((r) => r.broadMs)),
  over30s: rows.filter((r) => r.stage === 'warm' && r.broadMs > 30_000).map((r) => `${r.round}:${r.id}:${r.broadMs}`),
  failures: rows.filter((r) => (r.stage === 'warm' || r.stage === 'fresh') && !r.ok).map((r) => `${r.stage}:${r.id}:${r.error}`) });
fs.writeFileSync(path.join(outDir, `latency-${process.platform}-${version}.json`), JSON.stringify(rows, null, 2));
