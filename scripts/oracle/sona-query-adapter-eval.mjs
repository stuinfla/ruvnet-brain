#!/usr/bin/env node
/**
 * scripts/oracle/sona-query-adapter-eval.mjs — ADR-099 arm B, an EXPERIMENT: can a SONA MicroLoRA
 * query adapter (@ruvector/sona, rank 1-2) move a novice question's embedding so the gold file ranks
 * higher in the store's own dense index?
 *
 * Train (need-set TRAIN split only): one SONA trajectory per need, beginning at the question's
 * embedding, with one step whose activation is the gold passage's embedding (reward 1) and one step
 * per top dense non-gold passage (reward 0), ended with quality 1. SONA's REINFORCE gradient
 * ((reward - baseline) x activation, ruvector/crates/sona/src/types.rs) then pushes the adapter toward
 * the gold direction. forceLearn() applies it.
 * Evaluate (HELD-OUT, and TRAIN for fit): the gold file's rank among the store's top --depth dense
 * hits for the raw question vs applyMicroLora(question); and the same on the recall-gate fixture, which
 * the adapter must not hurt. An untrained adapter is measured too, because it is not the identity.
 *
 *   node scripts/oracle/sona-query-adapter-eval.mjs --kb <kbDir with forge-ask.mjs + node_modules>
 *     --sona <dir containing node_modules/@ruvector/sona> --set <need-set.json> --split <split.json>
 *     [--recall data/retrieval-query-evidence.json] [--depth 64] [--negatives 4] [--out <file>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wilson } from '../eval-brain.mjs';

/** Rank (1-based) of the first hit whose path is `gold`, or null within the list. */
export function rankOf(paths, gold) {
  const i = paths.indexOf(gold);
  return i < 0 ? null : i + 1;
}

/** Paired comparison of two rank lists (null = not within depth). */
export function compareRanks(base, adapted, cut = 5) {
  const within = (r) => r != null && r <= cut;
  const n = base.length;
  const r = (k) => { const w = wilson(k, n); return { k, n, lo: +w.lo.toFixed(4), hi: +w.hi.toFixed(4) }; };
  let gained = 0;
  let lost = 0;
  for (let i = 0; i < n; i++) {
    if (!within(base[i]) && within(adapted[i])) gained++;
    if (within(base[i]) && !within(adapted[i])) lost++;
  }
  return { base: r(base.filter(within).length), adapted: r(adapted.filter(within).length), gained, lost,
    inDepthBase: base.filter((x) => x != null).length, inDepthAdapted: adapted.filter((x) => x != null).length };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const kb = path.resolve(arg('--kb'));
  const depth = Number(arg('--depth', 64));
  const negatives = Number(arg('--negatives', 4));
  const require = createRequire(path.join(path.resolve(arg('--sona')), 'index.js'));
  const { SonaEngine } = require('@ruvector/sona');
  const { __embedInternals } = await import(pathToFileURL(path.join(kb, 'forge-ask.mjs')).href);
  const { loadRvf } = await import(pathToFileURL(path.join(kb, 'resolve-deps.mjs')).href);
  const { RvfDatabase } = loadRvf().mod;
  const embed = __embedInternals.embed;
  const set = JSON.parse(fs.readFileSync(arg('--set'), 'utf8')).questions;
  const split = JSON.parse(fs.readFileSync(arg('--split'), 'utf8'));
  const stores = new Map();
  const storeOf = async (name) => {
    if (stores.has(name)) return stores.get(name);
    const big = fs.existsSync(path.join(kb, `${name}.big.rvf`));
    const base = path.join(kb, big ? `${name}.big.rvf` : `${name}.rvf`);
    const cfg = JSON.parse(fs.readFileSync(`${base}.embed.json`, 'utf8'));
    const idmap = JSON.parse(fs.readFileSync(`${base}.idmap.json`, 'utf8')).idToLabel;
    const labelToId = new Map(Object.entries(idmap).map(([id, label]) => [Number(label), id]));
    const passages = path.join(kb, big && fs.existsSync(path.join(kb, `${name}.big.passages.jsonl`)) ? `${name}.big.passages.jsonl` : `${name}.passages.jsonl`);
    const pathOf = new Map();
    const textOf = new Map();
    for (const l of fs.readFileSync(passages, 'utf8').split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l);
      pathOf.set(String(r.id), r.path);
      if (!textOf.has(r.path)) textOf.set(r.path, String(r.text || ''));
    }
    const db = await RvfDatabase.openReadonly(base);
    const s = { name, cfg, db, labelToId, pathOf, textOf, engine: new SonaEngine(cfg.dimensions) };
    stores.set(name, s);
    return s;
  };
  const search = async (s, vec) => {
    const hits = await s.db.query(Array.from(vec), depth);
    const paths = [];
    for (const h of hits) {
      const p = s.pathOf.get(String(s.labelToId.get(Number(h.id)) ?? h.id));
      if (p && !paths.includes(p)) paths.push(p);
    }
    return paths;
  };
  const passageEmbed = (s, text) => embed(text, { ...s.cfg, queryPrefix: '' });
  const qs = set.map((q) => ({ ...q, store: q.repo.toLowerCase(), isTrain: split.train.includes(q.id) }));
  // TRAIN
  let trained = 0;
  for (const q of qs.filter((x) => x.isTrain)) {
    const s = await storeOf(q.store);
    const qv = Array.from(await embed(q.need, s.cfg));
    const gold = s.textOf.get(q.path);
    if (!gold) continue;
    const t = s.engine.beginTrajectory(qv);
    const zeros = new Array(64).fill(0);
    s.engine.addTrajectoryStep(t, Array.from(await passageEmbed(s, q.span || gold)), zeros, 1);
    for (const p of (await search(s, qv)).filter((p) => p !== q.path).slice(0, negatives)) {
      s.engine.addTrajectoryStep(t, Array.from(await passageEmbed(s, s.textOf.get(p) || '')), zeros, 0);
    }
    s.engine.endTrajectory(t, 1);
    trained++;
    process.stderr.write(`\r[sona-eval] trained ${trained}`);
  }
  const learn = {};
  for (const s of stores.values()) learn[s.name] = String(s.engine.forceLearn());
  // EVALUATE: raw vs adapted, on held-out and train needs, and on the recall fixture
  const evalSet = async (items) => {
    const base = [];
    const adapted = [];
    for (const it of items) {
      const s = await storeOf(it.store);
      const qv = Array.from(await embed(it.query, s.cfg));
      base.push(rankOf(await search(s, qv), it.gold));
      adapted.push(rankOf(await search(s, s.engine.applyMicroLora(qv)), it.gold));
    }
    return compareRanks(base, adapted);
  };
  const needItems = (isTrain) => qs.filter((q) => q.isTrain === isTrain).map((q) => ({ store: q.store, query: q.need, gold: q.path }));
  const report = { kind: 'ruvnet-brain-sona-query-adapter-eval', depth, negatives, trained, learn,
    heldout: await evalSet(needItems(false)), train: await evalSet(needItems(true)) };
  if (arg('--recall')) {
    const fx = JSON.parse(fs.readFileSync(arg('--recall'), 'utf8')).queries;
    const items = Object.entries(fx).filter(([store]) => stores.has(store))
      .map(([store, v]) => ({ store, query: v.query, gold: v.expected.path }));
    report.recallFixtureSameStores = await evalSet(items);
  }
  if (arg('--out')) fs.writeFileSync(arg('--out'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
