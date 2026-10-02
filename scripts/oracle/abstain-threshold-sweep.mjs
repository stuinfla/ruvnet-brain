#!/usr/bin/env node
/**
 * scripts/oracle/abstain-threshold-sweep.mjs — what would moving the abstain threshold do?
 *
 * The product abstains when the top cross-encoder logit is below 0. The threshold is applied AFTER
 * scoring, so replaying a measured run at another threshold t is exact for the top citation: no
 * model is re-run. For each t it reports, with 95% Wilson intervals:
 *   (abstained = no citation, or a numeric top logit < t -- the rule both harnesses apply)
 *   needs        confident hits (gold or pre-registered alternative within 5 AND top logit >= t),
 *                confident misses (top logit >= t but neither within 5), their precision, and how
 *                many confident answers at least cite the gold repository first
 *   offTopic     adversarial questions still abstained (no citation, or top logit < t)
 *   heldOut      routed passes of the named/described/scenario strata (grounded AND routed AND
 *                a citation with logit >= t), the gated eval-brain metric
 *
 *   node scripts/oracle/abstain-threshold-sweep.mjs --needs <needs.json> --adversarial <adversarial.json>
 *     --heldout <heldout.json> [--thresholds 0,-1,-2,-3,-4] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wilson } from '../eval-brain.mjs';

const rate = (k, n) => { const w = wilson(k, n); return { k, n, p: +w.p.toFixed(4), lo: +w.lo.toFixed(4), hi: +w.hi.toFixed(4) }; };
const within5 = (r) => (r.fileRank != null && r.fileRank <= 5) || (r.altFileRank != null && r.altFileRank <= 5);

export function sweep({ needs = [], adversarial = [], heldout = [] }, thresholds) {
  return thresholds.map((t) => {
    // The abstain rule both harnesses apply (measure-need-set scoreRow, eval-brain gradeQuestion): no
    // citation, or a NUMERIC top logit below the threshold. A citation without a logit (a card answer)
    // is not an abstention.
    const answered = (cited, ce) => Boolean(cited) && !(typeof ce === 'number' && ce < t);
    const confident = needs.filter((r) => answered(r.cited, r.topCe));
    const hits = confident.filter(within5).length;
    const routedRows = heldout.filter((r) => ['named', 'described', 'scenario'].includes(r.stratum));
    return {
      threshold: t,
      needs: { confidentHit: rate(hits, needs.length), confidentMiss: rate(confident.length - hits, needs.length),
        precision: rate(hits, confident.length),
        // Weaker than a file hit: the top citation is at least from the gold repository.
        confidentRightRepo: rate(confident.filter((r) => r.repoRank === 1).length, confident.length) },
      offTopicAbstain: rate(adversarial.filter((r) => !answered(r.citedPath, r.ce)).length, adversarial.length),
      heldOutRouted: rate(routedRows.filter((r) => r.grounded && r.routed && answered(r.citedPath, r.ce)).length, routedRows.length),
    };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const read = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')).rows : []);
  const thresholds = String(arg('--thresholds') || '0,-0.5,-1,-1.5,-2,-3,-4').split(',').map(Number);
  const out = { kind: 'ruvnet-brain-abstain-threshold-sweep',
    rows: sweep({ needs: read(arg('--needs')), adversarial: read(arg('--adversarial')), heldout: read(arg('--heldout')) }, thresholds) };
  if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify(out, null, 1)}\n`);
  const f = (m) => `${m.k}/${m.n} [${(100 * m.lo).toFixed(1)}-${(100 * m.hi).toFixed(1)}]`;
  for (const r of out.rows) {
    console.log(`t=${r.threshold}: needs hit ${f(r.needs.confidentHit)} miss ${f(r.needs.confidentMiss)} precision ${f(r.needs.precision)} right-repo ${f(r.needs.confidentRightRepo)} | off-topic abstain ${f(r.offTopicAbstain)} | held-out routed ${f(r.heldOutRouted)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
