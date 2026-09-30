#!/usr/bin/env node
/**
 * duplicate-gate-replay.mjs — replay plugin/scripts/duplicate-gate.mjs over real history, read-only.
 *
 * For each code file ADDED by the last N commits (git log --diff-filter=A), score it exactly as the
 * gate would have at that moment: against the tree at the commit's first parent. Uses the gate's own
 * extract/prepare/rank/exemption — the replay is the gate, pointed at the past, never a second copy.
 * Features are cached per blob sha, so N commits cost one extraction per distinct blob.
 *
 *   node scripts/duplicate-gate-replay.mjs [--commits 300] [--threshold 0.5] [--seed <sha>]... [--json out.json]
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extract, prepare, rank, exemption, isTest, isRelocation, strengthOf, SCOPE, THRESHOLD, MIN_COPIED_LINES } from '../plugin/scripts/duplicate-gate.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(opt('--commits', 300));
const threshold = Number(opt('--threshold', THRESHOLD));
const minCopied = Number(opt('--min-copied', MIN_COPIED_LINES));
const seeds = argv.flatMap((a, i) => (a === '--seed' ? [argv[i + 1]] : []));
const CODE = /\.(mjs|cjs|js|ts|mts|sh|py)$/;
const FIXTURE = /(^|\/)(__)?fixtures?(__)?\/|node_modules\//;

const git = (args, input) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** Read many objects in one `git cat-file --batch` call; texts in input order ('' when missing). */
function blobs(specs) {
  if (!specs.length) return [];
  const r = spawnSync('git', ['cat-file', '--batch'], { input: `${specs.join('\n')}\n`, maxBuffer: 1 << 30 });
  const buf = r.stdout; const out = []; let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    const head = buf.slice(pos, nl).toString().split(' ');
    if (head.length < 3 || head[1] === 'missing') { out.push(''); pos = nl + 1; continue; }
    const n = Number(head[2]); out.push(buf.slice(nl + 1, nl + 1 + n).toString('utf8')); pos = nl + 1 + n + 1;
  }
  return out;
}

const commits = [];
let cur = null;
for (const line of git(['log', '--diff-filter=A', '--name-only', '--format=COMMIT %H %P', `-${N}`]).split('\n')) {
  if (line.startsWith('COMMIT ')) { const [, sha, parent] = line.split(' '); cur = { sha, parent, added: [] }; commits.push(cur); } else if (line.trim() && cur) cur.added.push(line.trim());
}
for (const s of seeds) {
  const [sha, parent] = git(['log', '-1', '--format=%H %P', s]).trim().split(' ');
  const added = git(['show', '--diff-filter=A', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
  commits.push({ sha, parent, added, seed: true });
}

const featureCache = new Map(); // `${blob sha}:${path}` -> features (the stem makes them path-dependent)
const rows = []; const timings = [];
for (const c of commits) {
  const targets = c.added.filter((p) => SCOPE.some((d) => p.startsWith(d)) && CODE.test(p));
  if (!targets.length || !c.parent) continue;
  const t0 = Date.now();
  const tree = git(['ls-tree', '-r', c.parent]).split('\n').filter(Boolean).map((l) => {
    const [meta, p] = l.split('\t'); const [, type, sha] = meta.split(' '); return { p, sha, type };
  }).filter((x) => x.type === 'blob' && CODE.test(x.p) && !FIXTURE.test(x.p));
  const missing = tree.filter((x) => !featureCache.has(`${x.sha}:${x.p}`));
  const texts = blobs(missing.map((x) => x.sha));
  missing.forEach((x, i) => { if (texts[i].length <= 400_000) featureCache.set(`${x.sha}:${x.p}`, extract(x.p, texts[i])); });
  const entries = tree.filter((x) => featureCache.has(`${x.sha}:${x.p}`)).map((x) => ({ path: x.p, f: featureCache.get(`${x.sha}:${x.p}`) }));
  const model = prepare(entries);
  const stems = new Set([...tree.map((x) => x.p), ...c.added].filter((p) => !isTest(p)).map((p) => p.split('/').pop().replace(/\.[^.]+$/, '')));
  const newTexts = blobs(targets.map((p) => `${c.sha}:${p}`));
  for (const [i, p] of targets.entries()) {
    const text = newTexts[i];
    const ex = exemption(p, text, stems);
    if (ex) { rows.push({ commit: c.sha.slice(0, 8), file: p, skip: ex, seed: !!c.seed }); continue; }
    const t1 = Date.now();
    const ranked = rank(model, extract(p, text), { self: p, testsOnly: isTest(p), limit: 10 }).filter((m) => !isRelocation(p, m.path));
    timings.push(Date.now() - t1);
    // Re-derive strength at the replay's own knobs so thresholds can be swept without editing the gate.
    const knobs = { threshold, minCopied };
    const top = ranked.sort((a, b) => strengthOf(b, knobs) - strengthOf(a, knobs));
    const strength = top[0] ? strengthOf(top[0], knobs) : 0;
    rows.push({ commit: c.sha.slice(0, 8), file: p, seed: !!c.seed, score: top[0]?.score ?? 0, strength, copied: top[0]?.copied.length ?? 0, block: strength >= 1 && !isTest(p), shadow: strength >= 1 && isTest(p),
      top: top.map((m) => ({ path: m.path, score: +m.score.toFixed(3), copied: m.copied.length, copyShare: +m.copyShare.toFixed(3), parts: Object.fromEntries(Object.entries(m.parts).map(([k, v]) => [k, +v.toFixed(2)])), exports: m.sharedExports.slice(0, 4), lits: m.sharedLits })) });
  }
  timings.push(-(Date.now() - t0));
}

const judged = rows.filter((r) => !r.skip);
const blocks = judged.filter((r) => r.block);
const rankMs = timings.filter((t) => t >= 0).sort((a, b) => a - b);
console.log(`commits=${commits.length} candidates=${rows.length} judged=${judged.length} skipped=${rows.length - judged.length} `
  + `blocks=${blocks.length} (${(100 * blocks.length / (judged.length || 1)).toFixed(1)}%) threshold=${threshold} `
  + `rank p50=${rankMs[Math.floor(rankMs.length / 2)] ?? 0}ms max=${rankMs.at(-1) ?? 0}ms`);
console.log(`shadow would-blocks (tests, never refused): ${judged.filter((r) => r.shadow).length}`);
for (const r of blocks) console.log(`BLOCK strength=${r.strength.toFixed(2)} score=${r.score.toFixed(3)} copied=${r.copied} ${r.commit} ${r.file} -> ${r.top.slice(0, 3).map((m) => `${m.path}@${m.score}/${m.copied}`).join(' | ')}`);
const out = opt('--json', '');
if (out) fs.writeFileSync(out, JSON.stringify({ threshold, rows }, null, 1));
