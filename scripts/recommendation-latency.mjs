#!/usr/bin/env node
/**
 * recommendation-latency.mjs — what the package recommender ADDS to every prompt (ADR-0093).
 *
 * Measured where the cost is paid: a COLD `node advocacy-route.mjs` process per prompt, exactly as
 * unprompted-runtime.mjs spawns it on UserPromptSubmit. For each eval prompt the producer runs twice,
 * flag OFF then flag ON, interleaved so machine drift lands on both arms; the per-prompt difference is
 * the added latency. Every path the producer could write (state, ledger, HOME) is a fresh temp dir.
 *
 *   node scripts/recommendation-latency.mjs [--set <eval.json>]... [--rounds 1] [--json]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROUTE = path.join(ROOT, 'plugin', 'scripts', 'advocacy-route.mjs');
const CARDS = path.join(ROOT, 'plugin', 'scripts', 'package-cards.json');

const sets = [];
let rounds = 1;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--set') sets.push(process.argv[++i]);
  if (process.argv[i] === '--rounds') rounds = Math.max(1, Number(process.argv[++i]) || 1);
}
if (!sets.length) sets.push(path.join(ROOT, 'evals', 'recommendation-eval.v1.json'));
const prompts = sets.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).items.map((i) => i.prompt));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reco-latency-'));
// Only what the producer needs; nothing inherited that could point it at a real store.
const baseEnv = {
  PATH: process.env.PATH,
  HOME: tmp,
  USERPROFILE: tmp,
  RUVNET_HOME_OVERRIDE: tmp,
  RUVNET_EMIT_CANDIDATES: '1',
  RUVNET_PACKAGE_CARDS: CARDS,
  RUVNET_ADVOCACY_ROUTE_ROOTS: path.join(tmp, 'no-modules'),
};

function run(prompt, flag, n) {
  const env = {
    ...baseEnv,
    RUVNET_ADVOCACY_ROUTE_STATE: path.join(tmp, `state-${flag}-${n}.json`),
    RUVNET_ADVOCACY_OUTCOMES: path.join(tmp, `outcomes-${flag}-${n}.jsonl`),
    ...(flag === 'on' ? { RUVNET_PACKAGE_RECOMMENDER: '1' } : {}),
  };
  const input = JSON.stringify({ session_id: `lat-${flag}-${n}`, cwd: ROOT, hook_event_name: 'UserPromptSubmit', prompt });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [ROUTE], { input, env, encoding: 'utf8', timeout: 10000 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, status: r.status, emitted: Boolean((r.stdout || '').trim()) };
}

const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const off = []; const on = []; const added = []; let failures = 0;
let n = 0;
try {
  run('warm up the filesystem cache once', 'off', 'warm');
  for (let r = 0; r < rounds; r++) {
    for (const prompt of prompts) {
      n++;
      const a = run(prompt, 'off', n);
      const b = run(prompt, 'on', n);
      if (a.status !== 0 || b.status !== 0) failures++;
      off.push(a.ms); on.push(b.ms); added.push(b.ms - a.ms);
    }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const fmt = (arr) => ({ p50: +q(arr, 0.5).toFixed(1), p90: +q(arr, 0.9).toFixed(1), max: +Math.max(...arr).toFixed(1) });
// Percentile bootstrap (2000 resamples, fixed seed) for the ADDED p50/p90, so the report carries an
// interval rather than one number from one noisy run.
function bootstrap(arr, p, B = 2000) {
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1e9) / 1e9; };
  const stats = [];
  for (let b = 0; b < B; b++) stats.push(q(Array.from(arr, () => arr[Math.floor(rnd() * arr.length)]), p));
  return [+q(stats, 0.025).toFixed(1), +q(stats, 0.975).toFixed(1)];
}
const out = {
  samples: n, failures,
  host: `${os.platform()} ${os.arch()} ${os.cpus().length} vCPU node ${process.version}`,
  loadAvg1m: +os.loadavg()[0].toFixed(1),
  flagOffMs: fmt(off), flagOnMs: fmt(on), addedMs: { ...fmt(added), p50ci95: bootstrap(added, 0.5), p90ci95: bootstrap(added, 0.9) },
};
if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
else {
  console.log(`[latency] ${out.samples} paired cold runs on ${out.host}, ${failures} non-zero exits`);
  console.log(`[latency] flag off : p50 ${out.flagOffMs.p50} ms  p90 ${out.flagOffMs.p90} ms  max ${out.flagOffMs.max} ms`);
  console.log(`[latency] flag on  : p50 ${out.flagOnMs.p50} ms  p90 ${out.flagOnMs.p90} ms  max ${out.flagOnMs.max} ms`);
  console.log(`[latency] added    : p50 ${out.addedMs.p50} ms  p90 ${out.addedMs.p90} ms  max ${out.addedMs.max} ms`);
}
