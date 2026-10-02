#!/usr/bin/env node
/**
 * recommendation-judge-score.mjs — score what the host model SAID, given the hints the shipped
 * pipeline emitted (ADR-093 rev 2). Inputs come from scripts/recommendation-e2e.mjs (judge-key.json)
 * and a judge that saw only prompts + hints (judge-picks.json: { picks: { qid: id|null } }).
 *
 *   node scripts/recommendation-judge-score.mjs --dir <e2e out dir> [--cards plugin/scripts/package-cards.json] [--family] [--json]
 *
 * A prompt the pipeline stayed silent on counts as silent. Precision is over what the model said.
 * Wilson 95% intervals throughout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from './recommendation-eval.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POS = new Set(['design', 'diagnosis']);
// The closed catalogue speaks in building-block names; these are the packages each one names.
export const CATALOGUE_PACKAGES = Object.freeze({
  ruvector: ['ruvector', '@ruvector/rvf', '@ruvector/core', '@ruvector/node'],
  agentdb: ['agentdb'],
  ruflo: ['ruflo', 'claude-flow', '@claude-flow/swarm'],
  aidefence: ['@claude-flow/aidefence', 'aidefence-core'],
  'agentic-qe': ['agentic-qe'],
  'agentic-flow': ['agentic-flow'],
  rulake: ['rulake'],
});

export function judgeScore(key, picks, cards, { familyAware = false } = {}) {
  const storeOf = new Map(cards.map((c) => [c.id, c.store]));
  // FAMILY-AWARE (ADR-093 rev 3): a pick is right when it is the same PRODUCT as an accepted id, per the
  // corpus-derived product map on the cards (scripts/package-cards.mjs deriveProducts). Off by default so
  // the strict number is always the one reported first.
  const productOf = new Map(cards.map((c) => [c.id, c.product || c.id]));
  const sameProduct = (a, b) => familyAware && productOf.has(a) && productOf.get(a) === productOf.get(b);
  const sets = [...new Set(key.map((k) => k.set))];
  const pct = (k, n) => ({ k, n, pct: n ? +((100 * k) / n).toFixed(1) : null, ci95: wilson(k, n).map((x) => +(x * 100).toFixed(1)) });
  const summarize = (rows) => {
    let hit = 0; let said = 0; let correct = 0; let ff = 0; let wrong = 0;
    const pos = rows.filter((r) => POS.has(r.category)).length;
    for (const r of rows) {
      const p = picks[r.qid] ?? null;
      if (!p) continue;
      said++;
      const ids = [p, ...(CATALOGUE_PACKAGES[p] || [])];
      const ok = ids.some((id) => r.accept.includes(id) || r.acceptStores.includes(storeOf.get(id))
        || r.accept.some((a) => sameProduct(id, a)));
      if (POS.has(r.category)) { if (ok) { hit++; correct++; } else wrong++; } else ff++;
    }
    return { n: rows.length, recall: pct(hit, pos), precision: pct(correct, said), falseFiring: pct(ff, rows.length - pos), wrongPackage: wrong };
  };
  return {
    overall: summarize(key),
    blinds: summarize(key.filter((k) => /blind/.test(k.set))),
    bySet: Object.fromEntries(sets.map((s) => [s, summarize(key.filter((k) => k.set === s))])),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const dir = arg('--dir', null);
  if (!dir) { console.error('--dir required'); process.exit(2); }
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'judge-key.json'), 'utf8'));
  const picks = JSON.parse(fs.readFileSync(path.join(dir, 'judge-picks.json'), 'utf8')).picks || {};
  const cards = JSON.parse(fs.readFileSync(arg('--cards', path.join(ROOT, 'plugin', 'scripts', 'package-cards.json')), 'utf8')).cards;
  const r = judgeScore(key, picks, cards, { familyAware: process.argv.includes('--family') });
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(r, null, 1)}\n`); process.exit(0); }
  const line = (name, s) => console.log(`${name.padEnd(36)} recall ${s.recall.k}/${s.recall.n} ${s.recall.pct}% [${s.recall.ci95.join('–')}]  precision ${s.precision.k}/${s.precision.n} ${s.precision.pct}% [${s.precision.ci95.join('–')}]  false-firing ${s.falseFiring.k}/${s.falseFiring.n} ${s.falseFiring.pct}% [${s.falseFiring.ci95.join('–')}]  wrong ${s.wrongPackage}`);
  line('overall', r.overall);
  line('blinds (1+2)', r.blinds);
  for (const [s, v] of Object.entries(r.bySet)) line(s, v);
}
