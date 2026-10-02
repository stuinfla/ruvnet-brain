#!/usr/bin/env node
/**
 * recommendation-e2e.mjs — the package recommender AS SHIPPED, end to end (ADR-093 rev 2).
 *
 * 1. Spawns the real search worker (kb/forge-mcp-all.mjs) in a throwaway brain home with the flag on,
 *    and runs its real `brain/warmup`, which starts the recommend endpoint.
 * 2. For every eval prompt, runs the real hook producer (plugin/scripts/advocacy-route.mjs) as a
 *    cold process — flag OFF then flag ON, interleaved — and records wall time and the exact hint
 *    the host model would receive.
 * 3. Writes a judge packet (qid, prompt, hint — no labels) and a separate key, so a model standing in
 *    for the host can decide what it would say without seeing the answers.
 *
 * Nothing touches the real ~/.claude, ~/.codex or ~/.cache/ruvnet-brain: HOME and RUVNET_BRAIN_HOME
 * are a temp dir. The embedder needs a model cache and @xenova/transformers:
 *   --models <dir>   (KB_MODEL_CACHE)     --xenova <dir>  (XENOVA_PATH)
 * Refuses to measure when the 1-minute load average exceeds --max-load (default 60).
 *
 *   node scripts/recommendation-e2e.mjs --models <d> --xenova <d> --out <dir> [--set f.json]... [--max-load 60] [--budget ms]
 *
 * --budget raises the hook's semantic budget for a QUALITY run (what the lane says when it answers);
 * the default-budget run is the LATENCY run (how often, and how fast, it answers under its real limit).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const sets = process.argv.flatMap((a, i) => (a === '--set' ? [process.argv[i + 1]] : []));
const outDir = arg('--out', null);
const maxLoad = Number(arg('--max-load', '60'));
if (!outDir) { console.error('--out <dir> is required'); process.exit(2); }
if (os.loadavg()[0] > maxLoad) { console.error(`load average ${os.loadavg()[0].toFixed(1)} > ${maxLoad}; refusing to measure`); process.exit(3); }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-e2e-'));
const kb = path.join(home, 'kb');
fs.mkdirSync(kb);
const base = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home, RUVNET_BRAIN_HOME: home, RUVNET_HOME_OVERRIDE: home,
  KB_DIR: kb, KB_MODEL_CACHE: arg('--models', ''), XENOVA_PATH: arg('--xenova', ''),
};
const items = (sets.length ? sets : ['evals/recommendation-eval.v1.json'])
  .flatMap((f) => JSON.parse(fs.readFileSync(path.resolve(ROOT, f), 'utf8')).items.map((i) => ({ ...i, set: path.basename(f) })));

const worker = spawn(process.execPath, [path.join(ROOT, 'kb', 'forge-mcp-all.mjs')],
  { env: { ...base, RUVNET_PACKAGE_RECOMMENDER: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
const rl = readline.createInterface({ input: worker.stdout });
const waiters = new Map();
rl.on('line', (l) => { try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch { /* not ours */ } });
const call = (id, method) => new Promise((r) => { waiters.set(id, r); worker.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: {} })}\n`); });

function produce(prompt, flag, n) {
  const env = {
    ...base, RUVNET_EMIT_CANDIDATES: '1',
    RUVNET_ADVOCACY_ROUTE_STATE: path.join(home, `state-${flag}-${n}.json`),
    RUVNET_ADVOCACY_OUTCOMES: path.join(home, `outcomes-${flag}-${n}.jsonl`),
    RUVNET_ADVOCACY_ROUTE_ROOTS: path.join(home, 'none'),
    ...(flag === 'on' ? { RUVNET_PACKAGE_RECOMMENDER: '1' } : {}),
    ...(arg('--budget', null) ? { RUVNET_PACKAGE_RECOMMENDER_BUDGET_MS: arg('--budget', null) } : {}),
    // --floor 0 records every hint so a floor can be derived afterwards on the tuning set only.
    ...(arg('--floor', null) !== null ? { RUVNET_PACKAGE_RECOMMENDER_MIN_SIMILARITY: arg('--floor', null) } : {}),
  };
  const t = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'scripts', 'advocacy-route.mjs')],
    { input: JSON.stringify({ session_id: `e2e-${flag}-${n}`, prompt }), env, encoding: 'utf8', timeout: 10000 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  let cand = null;
  try { cand = r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null; } catch { cand = null; }
  return { ms, status: r.status, cand };
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(1); };
try {
  await call(1, 'initialize');
  const warm = await call(2, 'brain/warmup');
  if (!warm.result?.ready) throw new Error(`warmup failed: ${JSON.stringify(warm.error || warm.result)}`);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(home, 'run')); i++) await new Promise((r) => setTimeout(r, 100));
  produce('warm the page cache once before measuring', 'on', 'warm');
  const packet = []; const key = []; const off = []; const on = []; const added = [];
  items.forEach((it, i) => {
    const a = produce(it.prompt, 'off', i);
    const b = produce(it.prompt, 'on', i);
    off.push(a.ms); on.push(b.ms); added.push(b.ms - a.ms);
    const qid = `Q${String(i + 1).padStart(3, '0')}`;
    key.push({ qid, set: it.set, id: it.id, category: it.category, accept: it.accept || [], acceptStores: it.acceptStores || [],
      lane: b.cand ? (b.cand.candidates ? 'semantic' : String(b.cand.findingId).startsWith('recommend:pkg:') ? 'lexical' : 'catalogue') : null,
      offered: b.cand ? (b.cand.candidates || [b.cand.package || b.cand.capability]) : [], status: b.status,
      topSimilarity: Array.isArray(b.cand?.similarities) ? b.cand.similarities[0] : null });
    if (b.cand) packet.push({ qid, prompt: it.prompt, hint: b.cand.copy });
  });
  const timing = {
    samples: items.length, loadAvg1m: +os.loadavg()[0].toFixed(1), host: `${os.platform()} ${os.arch()} ${os.cpus().length} vCPU node ${process.version}`,
    flagOffMs: { p50: q(off, 0.5), p90: q(off, 0.9) }, flagOnMs: { p50: q(on, 0.5), p90: q(on, 0.9), max: q(on, 1) },
    addedMs: { p50: q(added, 0.5), p90: q(added, 0.9), max: q(added, 1) },
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'judge-packet.json'), JSON.stringify(packet.sort(() => 0), null, 1));
  fs.writeFileSync(path.join(outDir, 'judge-key.json'), JSON.stringify(key, null, 1));
  fs.writeFileSync(path.join(outDir, 'timing.json'), JSON.stringify(timing, null, 1));
  console.log(JSON.stringify(timing));
  console.log(`hints emitted for ${packet.length}/${items.length} prompts; lanes: ${JSON.stringify(key.reduce((m, k) => ({ ...m, [k.lane]: (m[k.lane] || 0) + 1 }), {}))}`);
} finally {
  worker.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(0);
