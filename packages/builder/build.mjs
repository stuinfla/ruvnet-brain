// The pack builder (architecture 2.4; RECIPE-FINAL 2.3). Runs in CI, never on a user's machine.
//   node build.mjs --recipe <RECIPE.json> --out <packDir> [--cache <dir>] [--sources <list.json>] [<sourceDir>...]
// A source is a folder with <sources.sourceFile> = { repo, commit, date }. The list file is
// { "sources": [{ "dir": "...", "repo"?: "...", "history"?: { "owner": "...", "recorded": "<dir>" } }] },
// relative paths against the list file's folder. Everything the builder decides comes from the recipe.
// Output: lexical.db, history.db (when any source has a history export), RECIPE.json, PROBES.json,
// manifest.json, PACK.json; written to a staging folder and renamed into place only when complete
// and every probe passes against it.
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../contract/validate.mjs';
import { isMain, sha256 } from '../contract/home.mjs';
import * as engine from '../engine/index.mjs';
import { assemble } from './assemble.mjs';
import { openCache } from './cache.mjs';
import { Unreadable, readSource } from './discover.mjs';
import { extract } from './extract.mjs';
import { readHistory, recordedGet } from './history.mjs';
import { makeProbes } from './probes.mjs';
import { settings } from './settings.mjs';
import { writeStore } from './store.mjs';
import { manifestOf } from './manifest.mjs';

/** Reads one source in full (files and history) or throws Unreadable. */
async function snapshotOf(entry, s) {
  const src = readSource(entry.dir, s.sources);
  let history = null;
  if (entry.history) {
    try {
      const get = entry.history.get ?? recordedGet(entry.history.recorded);
      history = { owner: entry.history.owner, raw: await readHistory({ owner: entry.history.owner, repo: src.meta.repo, get, perPage: s.history.perPage }) };
    } catch (e) {
      throw new Unreadable(`its history cannot be read (${e.message})`);
    }
  }
  return { ...src, history };
}

export async function build({ recipePath, sources, outDir, cacheDir = null }) {
  const recipeText = fs.readFileSync(recipePath, 'utf8');
  const recipe = check('recipe', JSON.parse(recipeText), recipePath);
  const s = settings(recipe);
  const recipeHash = sha256(recipeText);
  if (!sources.length) throw new Error('no sources were given');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  const cache = openCache(cacheDir);

  const read = [];
  const unreadable = [];
  for (const entry of sources) {
    try {
      const snap = await snapshotOf(entry, s);
      if (entry.repo && entry.repo !== snap.meta.repo) throw new Error(`${entry.dir} says it is ${snap.meta.repo}, the list says ${entry.repo}`);
      read.push(snap);
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      unreadable.push({ repo: entry.repo ?? path.basename(entry.dir), reason: `cannot be read: ${e.message}` });
    }
  }
  const allowed = Math.floor(sources.length * s.carryMaxShare);
  if (unreadable.length && (unreadable.length === sources.length || unreadable.length > allowed)) {
    throw new Error(`${unreadable.length} of ${sources.length} sources cannot be read (${unreadable.map((u) => u.repo).join(', ')}); at most ${allowed} may be carried`);
  }
  for (const snap of read) cache.saveLastGood(snap);
  const snaps = read.map((snap) => ({ snap, carried: null }));
  for (const u of unreadable) {
    const last = cache.lastGood(u.repo);
    if (!last) throw new Error(`source ${u.repo} ${u.reason}, and there is no last good state to carry`);
    snaps.push({ snap: last, carried: { reason: u.reason } });
  }
  snaps.sort((a, b) => (a.snap.meta.repo < b.snap.meta.repo ? -1 : 1));
  for (let i = 1; i < snaps.length; i++) if (snaps[i].snap.meta.repo === snaps[i - 1].snap.meta.repo) throw new Error(`source ${snaps[i].snap.meta.repo} is listed twice`);

  const report = { rebuilt: [], reused: [], carried: unreadable.map((u) => u.repo).sort() };
  const results = snaps.map(({ snap, carried }) => {
    const historyHash = snap.history ? sha256(JSON.stringify(snap.history)) : '';
    const key = sha256(`${recipeHash}\n${snap.contentHash}\n${historyHash}`);
    let out = cache.units(key);
    if (out) report.reused.push(snap.meta.repo);
    else {
      out = extract(snap, s);
      cache.saveUnits(key, out);
      report.rebuilt.push(snap.meta.repo);
    }
    return { snap, carried, out };
  });

  const stage = `${outDir}.part-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    const passages = results.flatMap((r) => r.out.passages);
    const store = { tokenizer: recipe.analyser.fts5Tokenizer, analyser: recipe.analyser };
    writeStore(path.join(stage, 'lexical.db'), passages, store);
    const withHistory = results.filter((r) => r.out.history);
    if (withHistory.length) writeStore(path.join(stage, 'history.db'), withHistory.flatMap((r) => r.out.history.rows), store);
    fs.writeFileSync(path.join(stage, 'RECIPE.json'), recipeText);
    const probes = makeProbes(passages, recipe.analyser, s.probes);
    if (!probes.length) throw new Error('no probe could be made from these sources');
    fs.writeFileSync(path.join(stage, 'PROBES.json'), `${JSON.stringify({ schema: 'ruvnet-brain/probes', version: 1, probes }, null, 2)}\n`);
    const manifest = manifestOf(results, { recipe, recipeHash, s });
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const sourcesOut = results.map((r) => ({ repo: r.snap.meta.repo, commit: r.snap.meta.commit, date: r.snap.meta.date }));
    const pack = assemble(stage, {
      recipeId: recipe.id, recipeHash, sources: sourcesOut, knowledgeDate: sourcesOut.map((x) => x.date).sort().at(-1),
      counts: { units: passages.length, files: manifest.counts.files, history: manifest.counts.history },
    });
    const h = engine.open(stage);
    try {
      const t = engine.selfTest(h);
      if (!t.ok) throw new Error(`a probe failed against the pack just built: ${JSON.stringify(t.results.filter((r) => !r.pass))}`);
    } finally {
      engine.close(h);
    }
    if (fs.existsSync(outDir)) fs.rmdirSync(outDir); // an empty folder is allowed; Windows will not rename over one
    fs.renameSync(stage, outDir);
    for (const k of ['rebuilt', 'reused']) report[k].sort();
    cache.report(report);
    return { pack, report };
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

function sourceList(listFile) {
  const base = path.dirname(listFile);
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  if (!Array.isArray(list?.sources)) throw new Error(`${listFile} has no "sources" list`);
  return list.sources.map((e, i) => {
    if (typeof e?.dir !== 'string') throw new Error(`${listFile} sources[${i}] has no dir`);
    const h = e.history;
    if (h && (typeof h.owner !== 'string' || !h.owner || typeof h.recorded !== 'string')) throw new Error(`${listFile} sources[${i}].history needs owner and recorded`);
    return { dir: path.resolve(base, e.dir), repo: e.repo, history: h ? { owner: h.owner, recorded: path.resolve(base, h.recorded) } : null };
  });
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? null : args.splice(i, 2)[1];
  };
  const recipePath = take('--recipe');
  const outDir = take('--out');
  const cacheDir = take('--cache');
  const listFile = take('--sources');
  if (!recipePath || !outDir || (!args.length && !listFile)) {
    console.error('usage: node build.mjs --recipe <RECIPE.json> --out <packDir> [--cache <dir>] [--sources <list.json>] [<sourceDir>...]');
    process.exit(2);
  }
  try {
    const sources = [...(listFile ? sourceList(path.resolve(listFile)) : []), ...args.map((a) => ({ dir: path.resolve(a), history: null }))];
    const { pack, report } = await build({ recipePath: path.resolve(recipePath), sources, outDir: path.resolve(outDir), cacheDir: cacheDir && path.resolve(cacheDir) });
    console.log(`built ${pack.generation}: ${pack.counts.units} passages from ${pack.counts.files} files, ${pack.counts.history} history units`);
    console.log(`rebuilt: ${report.rebuilt.join(', ') || 'none'}; reused: ${report.reused.join(', ') || 'none'}; carried: ${report.carried.join(', ') || 'none'}`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
