#!/usr/bin/env node
/**
 * scripts/route-latency-warm.mjs — paired WARM latency of two or more search runtimes on the same
 * questions, in ONE process (the warm MCP worker's regime).
 *
 * Each arm is a KB directory whose forge-ask-all.mjs is the code under test: a shadow copy of a
 * corpus with that version's kb/*.mjs. Every question is asked of every arm back to back. The arm
 * order rotates per question, and each question first waits for the 1-minute load average to drop
 * below --max-load, so the arms of one question share conditions. searchAll is called exactly as
 * kb/forge-mcp-all.mjs calls it (k 6, allowFullCorpus false). Rows are appended to <out>.rows.jsonl
 * as they finish, so an interrupted run keeps what it measured.
 *
 *   node scripts/route-latency-warm.mjs --set <need-set.json> --out <file> [--stride 3] [--max-load 60]
 *     --arm A_base=<kbDir> --arm B_final=<kbDir> [--arm ...]
 *   node scripts/route-latency-warm.mjs --summarize <rows.jsonl> --arms A_base,B_final[,...]
 *
 * The summary reports, per arm, p50 / p90 and mean stores searched; for each pair, the p50 and p90
 * deltas and the median per-question difference, each with a 95% paired bootstrap interval
 * (2000 resamples, fixed seed). Nothing it writes contains a local path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Seeded LCG, so a summary of the same rows always prints the same intervals. */
function rng(seed = 42) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

export function summarizeRows(rows, labels, { resamples = 2000, seed = 42 } = {}) {
  const ok = rows.filter((r) => labels.every((a) => r[a] && !r[a].err));
  const out = { n: rows.length, nOk: ok.length, arms: {}, deltas: {} };
  if (rows.length) out.loadAt = { min: Math.min(...rows.map((r) => r.loadAt)), max: Math.max(...rows.map((r) => r.loadAt)) };
  for (const a of labels) {
    const ms = ok.map((r) => r[a].ms);
    out.arms[a] = { p50: Math.round(percentile(ms, 0.5)), p90: Math.round(percentile(ms, 0.9)),
      meanRepos: ok.length ? +(ok.reduce((s, r) => s + (r[a].repos || 0), 0) / ok.length).toFixed(3) : 0,
      errors: rows.filter((r) => r[a]?.err).length };
  }
  const rnd = rng(seed);
  for (let x = 0; x < labels.length; x++) for (let y = x + 1; y < labels.length; y++) {
    const A = labels[x];
    const B = labels[y];
    const stat = (idx) => ({
      p50: percentile(idx.map((i) => ok[i][B].ms), 0.5) - percentile(idx.map((i) => ok[i][A].ms), 0.5),
      p90: percentile(idx.map((i) => ok[i][B].ms), 0.9) - percentile(idx.map((i) => ok[i][A].ms), 0.9),
      medianPaired: percentile(idx.map((i) => ok[i][B].ms - ok[i][A].ms), 0.5),
    });
    const all = stat(ok.map((_, i) => i));
    const boots = Array.from({ length: resamples }, () => stat(ok.map(() => Math.floor(rnd() * ok.length))));
    const ci = (k) => [Math.round(percentile(boots.map((s) => s[k]), 0.025)), Math.round(percentile(boots.map((s) => s[k]), 0.975))];
    out.deltas[`${B} - ${A}`] = { p50: Math.round(all.p50), p50CI: ci('p50'), p90: Math.round(all.p90), p90CI: ci('p90'),
      medianPairedDiff: Math.round(all.medianPaired), medianPairedCI: ci('medianPaired'),
      bFaster: `${ok.filter((r) => r[B].ms < r[A].ms).length}/${ok.length}` };
  }
  return out;
}

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const all = (name) => args.flatMap((v, i) => (v === name ? [args[i + 1]] : []));

async function run() {
  const set = arg('--set');
  const out = arg('--out');
  if (!set || !out) throw new Error('--set and --out are required');
  const stride = Math.max(1, Number(arg('--stride')) || 1);
  const maxLoad = Number(arg('--max-load')) || 60;
  const arms = [];
  for (const spec of all('--arm')) {
    const [label, dir] = spec.split('=');
    const { searchAll } = await import(pathToFileURL(path.join(path.resolve(dir), 'forge-ask-all.mjs')).href);
    arms.push({ label, dir: path.resolve(dir), searchAll });
  }
  if (arms.length < 2) throw new Error('at least two --arm label=kbDir are required');
  const questions = JSON.parse(fs.readFileSync(set, 'utf8')).questions.filter((_, i) => i % stride === 0);
  const rowsFile = `${out}.rows.jsonl`;
  fs.writeFileSync(rowsFile, '');
  const ask = async (arm, query) => {
    const t0 = performance.now();
    let res = null;
    let err = null;
    try { res = await arm.searchAll({ dir: arm.dir, query, k: 6, allowFullCorpus: false }); } catch (e) { err = String(e?.message || e).slice(0, 200); }
    return { ms: performance.now() - t0, repos: res?.repos?.length ?? null,
      top: res?.results?.[0] ? `${res.results[0].repo}/${res.results[0].path}` : null, err };
  };
  for (const q of questions.slice(0, 3)) for (const arm of arms) await ask(arm, q.need); // warm, untimed
  const rows = [];
  for (let i = 0; i < questions.length; i++) {
    while (os.loadavg()[0] >= maxLoad) await new Promise((r) => setTimeout(r, 15000));
    const row = { id: questions[i].id, loadAt: +os.loadavg()[0].toFixed(1) };
    for (let j = 0; j < arms.length; j++) {
      const arm = arms[(i + j) % arms.length];
      row[arm.label] = await ask(arm, questions[i].need);
    }
    rows.push(row);
    fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
    process.stderr.write(`\r[route-latency-warm] ${i + 1}/${questions.length}`);
  }
  const summary = summarizeRows(rows, arms.map((a) => a.label));
  fs.writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
  console.log(JSON.stringify(summary, null, 1));
}

async function main() {
  const rowsFile = arg('--summarize');
  if (rowsFile) {
    const rows = fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    console.log(JSON.stringify(summarizeRows(rows, String(arg('--arms') || '').split(',').filter(Boolean)), null, 1));
    return;
  }
  await run();
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
