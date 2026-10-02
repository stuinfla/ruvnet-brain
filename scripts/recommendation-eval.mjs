#!/usr/bin/env node
/**
 * recommendation-eval.mjs — score the package recommender against a need-prompt eval set (ADR-0093).
 *
 *   node scripts/recommendation-eval.mjs [--set evals/recommendation-eval.v1.json]... [--cards <file>] [--json] [--verbose]
 *
 * Reports, per split and overall: recall on positives (fired AND an accepted package), precision over
 * all firings, false-firing rate on negatives (off-topic + no-fit) — each with a Wilson 95% interval,
 * because 30 prompts is a small sample and a bare percentage would overstate what it shows.
 * An `accept` id that is not in the card set is reported, never silently counted as a miss.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexCards, rank, SNAPSHOT_FILE } from '../plugin/scripts/package-recommender.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Wilson score interval, 95%. Returns [lo, hi] as fractions; [0, 0] for n = 0. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const POSITIVE = new Set(['design', 'diagnosis']);

export function scoreItem(item, decision) {
  const fired = Boolean(decision);
  const pkg = decision?.card?.id || null;
  const store = decision?.card?.store || null;
  if (!POSITIVE.has(item.category)) return { fired, pkg, correct: !fired, firedCorrect: false };
  const accepted = fired && ((item.accept || []).includes(pkg) || (item.acceptStores || []).includes(store));
  return { fired, pkg, correct: accepted, firedCorrect: accepted };
}

export function summarize(rows) {
  const pos = rows.filter((r) => POSITIVE.has(r.category));
  const neg = rows.filter((r) => !POSITIVE.has(r.category));
  const fired = rows.filter((r) => r.fired);
  const firedCorrect = rows.filter((r) => r.firedCorrect).length;
  const hits = pos.filter((r) => r.correct).length;
  const falseFires = neg.filter((r) => r.fired).length;
  const pct = ([lo, hi]) => [+(lo * 100).toFixed(1), +(hi * 100).toFixed(1)];
  return {
    n: rows.length,
    positives: pos.length,
    negatives: neg.length,
    recall: { k: hits, n: pos.length, pct: pos.length ? +((hits / pos.length) * 100).toFixed(1) : null, ci95: pct(wilson(hits, pos.length)) },
    precision: { k: firedCorrect, n: fired.length, pct: fired.length ? +((firedCorrect / fired.length) * 100).toFixed(1) : null, ci95: pct(wilson(firedCorrect, fired.length)) },
    falseFiring: { k: falseFires, n: neg.length, pct: neg.length ? +((falseFires / neg.length) * 100).toFixed(1) : null, ci95: pct(wilson(falseFires, neg.length)) },
    wrongPackage: pos.filter((r) => r.fired && !r.correct).length,
  };
}

export function evaluate(items, index) {
  const ids = new Set(index.entries.map((e) => e.card.id));
  const missing = [...new Set(items.flatMap((i) => i.accept || []).filter((id) => !ids.has(id)))];
  const rows = items.map((item) => {
    const { decision, reason, ranked } = rank(item.prompt, index);
    return {
      id: item.id, category: item.category, split: item.split, prompt: item.prompt, accept: item.accept,
      ...scoreItem(item, decision),
      reason, top: ranked.slice(0, 3).map((r) => `${r.card.id}:${r.score.toFixed(2)}[${r.matched.join(',')}]`),
    };
  });
  const splits = [...new Set(rows.map((r) => r.split))];
  return {
    missingAcceptIds: missing,
    overall: summarize(rows),
    bySplit: Object.fromEntries(splits.map((s) => [s, summarize(rows.filter((r) => r.split === s))])),
    rows,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const sets = [];
  let cards = SNAPSHOT_FILE;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--set') sets.push(process.argv[++i]);
    if (process.argv[i] === '--cards') cards = process.argv[++i];
  }
  if (!sets.length) sets.push(path.join(ROOT, 'evals', 'recommendation-eval.v1.json'));
  // --split dev restricts BOTH scoring and output to one split, so tuning never shows held-out rows.
  const splitArg = process.argv.includes('--split') ? process.argv[process.argv.indexOf('--split') + 1] : null;
  const items = sets.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).items)
    .filter((i) => !splitArg || i.split === splitArg);
  const index = indexCards(JSON.parse(fs.readFileSync(cards, 'utf8')));
  const result = evaluate(items, index);
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(result, null, 1)}\n`); process.exit(0); }
  const line = (name, s) => console.log(`${name.padEnd(9)} n=${s.n}  recall ${s.recall.k}/${s.recall.n} ${s.recall.pct}% [${s.recall.ci95.join('–')}]  precision ${s.precision.k}/${s.precision.n} ${s.precision.pct}% [${s.precision.ci95.join('–')}]  false-firing ${s.falseFiring.k}/${s.falseFiring.n} ${s.falseFiring.pct}% [${s.falseFiring.ci95.join('–')}]  wrong-pkg ${s.wrongPackage}`);
  if (result.missingAcceptIds.length) console.log(`accept ids not in card set: ${result.missingAcceptIds.join(', ')}`);
  line('overall', result.overall);
  for (const [s, v] of Object.entries(result.bySplit)) line(s, v);
  if (process.argv.includes('--verbose')) {
    for (const r of result.rows) {
      const mark = r.correct ? 'ok ' : 'XX ';
      console.log(`${mark}${r.id} ${r.category.padEnd(9)} -> ${r.fired ? r.pkg : '(silent:' + r.reason + ')'} | ${r.top.join('  ')}`);
    }
  }
}
