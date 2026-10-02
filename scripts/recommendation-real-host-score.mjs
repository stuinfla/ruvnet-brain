#!/usr/bin/env node
/**
 * recommendation-real-host-score.mjs — score a real-host run (scripts/recommendation-real-host.mjs) and
 * its agreement with the simulated host (ADR-093 rev 3).
 *
 *   node scripts/recommendation-real-host-score.mjs --real <real-host.json> --dir <e2e dir> [--floor 0.532] [--json]
 *
 * Correctness is family-aware (same product as an accepted id). Agreement compares, per prompt, what the
 * real host named with what the simulated host would have named under the same floor: both silent, or
 * the same product. A prompt the real hook did NOT inject a hint for is reported separately, because
 * then the two hosts did not see the same input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from './recommendation-eval.mjs';
import { applyFloor } from './recommendation-floor.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POS = new Set(['design', 'diagnosis']);

export function scoreRealHost(real, key, simPicks, cards) {
  const productOf = new Map(cards.map((c) => [c.id, c.product || c.id]));
  const same = (a, b) => a === b || (productOf.has(a) && productOf.get(a) === productOf.get(b));
  const byQid = new Map(key.map((k) => [k.qid, k]));
  const rows = real.rows.map((r) => {
    const k = byQid.get(r.qid);
    const right = r.said ? (k.accept || []).some((a) => same(r.said, a)) : null;
    const sim = simPicks[r.qid] ?? null;
    const agree = (!r.said && !sim) || (r.said && sim && same(r.said, sim));
    return { ...r, accept: k.accept, sim, right, agree };
  });
  const pos = rows.filter((r) => POS.has(r.category));
  const neg = rows.filter((r) => !POS.has(r.category));
  const said = rows.filter((r) => r.said);
  const pct = (a, n) => ({ k: a, n, pct: n ? +((100 * a) / n).toFixed(1) : null, ci95: wilson(a, n).map((x) => +(x * 100).toFixed(1)) });
  const sameInput = rows.filter((r) => r.injected === Boolean(byQid.get(r.qid).lane));
  // Hint delivery against the 1-minute load each prompt ran at: how the lane behaves on a busy laptop.
  const buckets = [[0, 60], [60, 120], [120, 240], [240, Infinity]];
  const deliveryByLoad = buckets.map(([lo, hi]) => {
    const inB = rows.filter((r) => r.expectHint && Number.isFinite(r.load1m) && r.load1m >= lo && r.load1m < hi);
    return { load: hi === Infinity ? `>=${lo}` : `${lo}-${hi}`, ...pct(inB.filter((r) => r.injected).length, inB.length) };
  });
  return {
    n: rows.length,
    deliveryByLoad,
    recall: pct(pos.filter((r) => r.right).length, pos.length),
    precision: pct(said.filter((r) => POS.has(r.category) && r.right).length, said.length),
    falseFiring: pct(neg.filter((r) => r.said).length, neg.length),
    hintDeliveredWhereExpected: pct(rows.filter((r) => r.expectHint && r.injected).length, rows.filter((r) => r.expectHint).length),
    hintsNotExpected: rows.filter((r) => !r.expectHint && r.injected).length,   // catalogue/lexical lanes, which the floor does not govern
    agreement: pct(rows.filter((r) => r.agree).length, rows.length),
    agreementSameInput: pct(sameInput.filter((r) => r.agree).length, sameInput.length),
    rows,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const real = JSON.parse(fs.readFileSync(arg('--real'), 'utf8'));
  const dir = arg('--dir');
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'judge-key.json'), 'utf8'));
  const floor = Number(arg('--floor', '0.532'));
  const sim = applyFloor(key, JSON.parse(fs.readFileSync(path.join(dir, 'judge-picks.json'), 'utf8')).picks, floor);
  const cards = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'package-cards.json'), 'utf8')).cards;
  const keyed = new Map(key.map((k) => [k.qid, k]));
  real.rows.forEach((r) => { const k = keyed.get(r.qid); r.expectHint = Boolean(k.lane) && (k.lane !== 'semantic' || k.topSimilarity >= floor); });
  const out = scoreRealHost(real, key, sim, cards);
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(out, null, 1)}\n`); process.exit(0); }
  const f = (n, s) => console.log(`${n.padEnd(30)} ${s.k}/${s.n} = ${s.pct}% [${s.ci95.join('–')}]`);
  f('recall (family-aware)', out.recall); f('precision (family-aware)', out.precision); f('false firing', out.falseFiring);
  f('hints delivered / expected', out.hintDeliveredWhereExpected);
  for (const b of out.deliveryByLoad) f(`  delivered at load ${b.load}`, b); f('agreement with simulated host', out.agreement); f('  …where both saw a hint', out.agreementSameInput);
  for (const r of out.rows) console.log(`${r.qid} ${r.category.padEnd(9)} hint=${r.injected ? 'y' : 'n'}${r.expectHint ? '' : '(not expected)'} real=${r.said || '-'} sim=${r.sim || '-'} ${r.said ? (r.right ? 'RIGHT' : 'WRONG') : ''} ${r.agree ? '' : 'DISAGREE'}`);
}
