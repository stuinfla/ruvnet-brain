#!/usr/bin/env node
/**
 * recommendation-floor.mjs — derive the semantic similarity floor on the TUNING set only, freeze it, and
 * apply it to every set (ADR-093 rev 3). The rule is fixed in advance: the floor is the 5th percentile
 * of the nearest card's similarity among the tuning set's correctly-judged recommendations (family-aware).
 *
 *   node scripts/recommendation-floor.mjs --dir <e2e out dir with judge-key.json + judge-picks.json>
 *        [--tune recommendation-eval.v1.json] [--floor <value to apply instead of deriving>] [--json]
 *
 * The e2e run must be made with --floor 0 so every hint (and its top similarity) is recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeScore } from './recommendation-judge-score.mjs';
import { wilson } from './recommendation-eval.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POS = new Set(['design', 'diagnosis']);

export function deriveFloor(key, picks, cards, tuneSet, pct = 0.05) {
  const productOf = new Map(cards.map((c) => [c.id, c.product || c.id]));
  const right = (k, p) => k.accept.includes(p) || k.accept.some((a) => productOf.has(p) && productOf.get(a) === productOf.get(p));
  const sims = key.filter((k) => k.set === tuneSet && k.lane === 'semantic' && POS.has(k.category) && picks[k.qid] && right(k, picks[k.qid]))
    .map((k) => k.topSimilarity).filter(Number.isFinite).sort((a, b) => a - b);
  return sims.length ? +sims[Math.floor(sims.length * pct)].toFixed(3) : null;
}

/** Picks as the shipped hook would produce them under `floor`: below it, no hint, so no pick. */
export function applyFloor(key, picks, floor) {
  return Object.fromEntries(key.map((k) => [k.qid, k.lane === 'semantic' && !(k.topSimilarity >= floor) ? null : picks[k.qid] ?? null]));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const dir = arg('--dir', null);
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'judge-key.json'), 'utf8'));
  const picks = JSON.parse(fs.readFileSync(path.join(dir, 'judge-picks.json'), 'utf8')).picks;
  const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'package-cards.json'), 'utf8')).cards;
  const floor = arg('--floor', null) !== null ? Number(arg('--floor')) : deriveFloor(key, picks, cards, arg('--tune', 'recommendation-eval.v1.json'));
  const gated = applyFloor(key, picks, floor);
  const strict = judgeScore(key, gated, cards);
  const family = judgeScore(key, gated, cards, { familyAware: true });
  const negHinted = (set) => key.filter((k) => set(k) && !POS.has(k.category) && k.lane === 'semantic' && k.topSimilarity >= floor).length;
  const negs = key.filter((k) => /blind/.test(k.set) && !POS.has(k.category)).length;
  const out = { floor, strict, family, hintsOnBlindNegatives: { k: negHinted((k) => /blind/.test(k.set)), n: negs, ci95: wilson(negHinted((k) => /blind/.test(k.set)), negs).map((x) => +(x * 100).toFixed(1)) } };
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(out, null, 1)}\n`); process.exit(0); }
  console.log(`floor ${floor}`);
  const line = (name, s) => console.log(`${name.padEnd(40)} recall ${s.recall.k}/${s.recall.n} ${s.recall.pct}% [${s.recall.ci95.join('–')}]  precision ${s.precision.k}/${s.precision.n} ${s.precision.pct}% [${s.precision.ci95.join('–')}]  false-firing ${s.falseFiring.k}/${s.falseFiring.n} [${s.falseFiring.ci95.join('–')}]`);
  for (const [mode, r] of [['strict', strict], ['family', family]]) {
    line(`${mode} blinds`, r.blinds);
    for (const [s, v] of Object.entries(r.bySet)) line(`${mode} ${s}`, v);
  }
  console.log(`hints injected on blind negatives: ${out.hintsOnBlindNegatives.k}/${out.hintsOnBlindNegatives.n} [${out.hintsOnBlindNegatives.ci95.join('–')}]`);
}
