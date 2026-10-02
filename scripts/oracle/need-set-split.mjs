#!/usr/bin/env node
/**
 * scripts/oracle/need-set-split.mjs — a frozen, stratified train / held-out split of a need set.
 *
 * Anything that LEARNS from novice needs (a query adapter, a learned abstain model) may train only
 * on `train`; every claim about it is measured on `heldout`. The split is a pure function of the
 * question ids and a salt: within each repository the ids are ordered by sha256(salt + id) and the
 * first round(n * trainFraction) go to train. Re-running it on the same set yields the same split.
 *
 *   node scripts/oracle/need-set-split.mjs --set <need-set.json> [--salt v1] [--train 0.5] [--out <file>]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function splitNeedSet(questions, { salt = 'v1', trainFraction = 0.5 } = {}) {
  const byRepo = new Map();
  for (const q of questions) {
    if (!byRepo.has(q.repo)) byRepo.set(q.repo, []);
    byRepo.get(q.repo).push(q.id);
  }
  const train = [];
  const heldout = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const ids = byRepo.get(repo)
      .map((id) => ({ id, h: createHash('sha256').update(`${salt}\n${id}`).digest('hex') }))
      .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
      .map((x) => x.id);
    const cut = Math.round(ids.length * trainFraction);
    train.push(...ids.slice(0, cut));
    heldout.push(...ids.slice(cut));
  }
  return { salt, trainFraction, train, heldout };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const set = JSON.parse(fs.readFileSync(arg('--set'), 'utf8'));
  const split = splitNeedSet(set.questions, { salt: arg('--salt', 'v1'), trainFraction: Number(arg('--train', 0.5)) });
  const out = { kind: 'ruvnet-brain-need-set-split', set: { kind: set.kind, version: set.version, n: set.questions.length,
    contentHash: set.contentHash }, ...split };
  if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify({ train: split.train.length, heldout: split.heldout.length, contentHash: set.contentHash }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
