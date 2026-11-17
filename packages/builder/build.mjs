// The pack builder (architecture 2.4; RECIPE-FINAL 2.3). Runs in CI, never on a user's machine.
//   node build.mjs --recipe <RECIPE.json> --out <packDir> [--cache <dir>] [--sources <list.json>] [<sourceDir>...]
// A source is a folder with <sources.sourceFile> = { repo, commit, date }. The list file is
// { "sources": [{ "dir": "...", "repo"?: "...", "history"?: { "owner": "...", "recorded": "<dir>" } } | { "gists": "<passages.jsonl>" }] },
// relative paths against the list file's folder. Everything the builder decides comes from the recipe.
// Output: lexical.db, history.db (when any source has a history export), layered.db and
// layered-coverage.json (when the recipe names a layered store), RECIPE.json, PROBES.json, manifest.json, PACK.json; written to a staging folder and renamed into place only when complete
// and every probe passes against it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { check } from '../contract/validate.mjs';
import { isMain, sha256 } from '../contract/home.mjs';
import * as engine from '../engine/index.mjs';
import { assemble } from './assemble.mjs';
import { openCache } from './cache.mjs';
import { Unreadable, readSource } from './discover.mjs';
import { extract } from './extract.mjs';
import { readHistory, recordedGet } from './history.mjs';
import { probeIndex } from './probes.mjs';
import { settings } from './settings.mjs';
import { openStore } from './store.mjs';
import { manifestOf, sourcePart } from './manifest.mjs';
import { openLayeredStore } from './layered/store.mjs';
import { GISTS_REPO, materializeGists } from './gists.mjs';

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

/** The repository name a list entry will have, from its .source.json alone (or, when that cannot be
 *  read, the name the list gives or the folder's name, as the carry rule reports it). */
function nameOf(entry, s) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(entry.dir, s.sources.sourceFile), 'utf8'));
    if (typeof m?.repo === 'string' && m.repo) return m.repo;
  } catch {}
  return entry.repo ?? path.basename(entry.dir);
}

// The build streams: sources are read, extracted and written one at a time, in repository order, and
// each one is dropped before the next is read. What is kept across sources is small: the manifest's
// per-source part, the probe index (one number per analysed token) and the report. So the largest
// source sets the memory a build needs, not the whole corpus.
export async function build({ recipePath, sources, outDir, cacheDir = null }) {
  const recipeText = fs.readFileSync(recipePath, 'utf8');
  const recipe = check('recipe', JSON.parse(recipeText), recipePath);
  const s = settings(recipe);
  const recipeHash = sha256(recipeText);
  if (!sources.length) throw new Error('no sources were given');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  const cache = openCache(cacheDir);
  const order = sources.map((entry) => ({ entry, repo: nameOf(entry, s) })).sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  for (let i = 1; i < order.length; i++) if (order[i].repo === order[i - 1].repo) throw new Error(`source ${order[i].repo} is listed twice`);
  const allowed = Math.floor(sources.length * s.carryMaxShare);

  const stage = `${outDir}.part-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const store = { tokenizer: recipe.analyser.fts5Tokenizer, analyser: recipe.analyser };
  const lexical = openStore(path.join(stage, 'lexical.db'), store);
  let history = null; // opened when the first history row comes
  const layered = s.layered ? openLayeredStore(path.join(stage, 'layered.db'), s) : null;
  const probes = probeIndex(recipe.analyser, s.probes);
  const parts = [];
  const unreadable = [];
  const noLastGood = [];
  const report = { rebuilt: [], reused: [], carried: [] };
  try {
    for (const { entry } of order) {
      let snap;
      let carried = null;
      try {
        snap = await snapshotOf(entry, s);
        if (entry.repo && entry.repo !== snap.meta.repo) throw new Error(`${entry.dir} says it is ${snap.meta.repo}, the list says ${entry.repo}`);
        cache.stageLastGood(snap);
      } catch (e) {
        if (!(e instanceof Unreadable)) throw e;
        const u = { repo: entry.repo ?? path.basename(entry.dir), reason: `cannot be read: ${e.message}` };
        unreadable.push(u);
        snap = cache.lastGood(u.repo);
        if (!snap) {
          noLastGood.push(u);
          continue;
        }
        carried = { reason: u.reason };
      }
      const historyHash = snap.history ? sha256(JSON.stringify(snap.history)) : '';
      const key = sha256(`${recipeHash}\n${snap.contentHash}\n${historyHash}`);
      let out = cache.units(key);
      if (out) report.reused.push(snap.meta.repo);
      else {
        out = extract(snap, s);
        cache.saveUnits(key, out);
        report.rebuilt.push(snap.meta.repo);
      }
      for (const r of out.passages) lexical.add(r);
      if (out.history) {
        history ??= openStore(path.join(stage, 'history.db'), store);
        for (const r of out.history.rows) history.add(r);
      }
      layered?.addRepo({ snap, carried });
      probes.add(out.passages);
      parts.push(sourcePart({ snap, carried, out }, s));
    }
    if (unreadable.length && (unreadable.length === sources.length || unreadable.length > allowed)) {
      throw new Error(`${unreadable.length} of ${sources.length} sources cannot be read (${unreadable.map((u) => u.repo).join(', ')}); at most ${allowed} may be carried`);
    }
    if (noLastGood.length) throw new Error(`source ${noLastGood[0].repo} ${noLastGood[0].reason}, and there is no last good state to carry`);
    report.carried = unreadable.map((u) => u.repo).sort();
    cache.commitLastGood();
    lexical.finish();
    history?.finish();
    if (layered) fs.writeFileSync(path.join(stage, 'layered-coverage.json'), `${JSON.stringify(layered.finish(), null, 1)}\n`);
    fs.writeFileSync(path.join(stage, 'RECIPE.json'), recipeText);
    const made = withDb(path.join(stage, 'lexical.db'), (db) => {
      const q = db.prepare('SELECT text FROM units WHERE repo = ? AND path = ? ORDER BY id');
      return probes.make((repo, p) => q.all(repo, p));
    });
    if (!made.length) throw new Error('no probe could be made from these sources');
    fs.writeFileSync(path.join(stage, 'PROBES.json'), `${JSON.stringify({ schema: 'ruvnet-brain/probes', version: 1, probes: made }, null, 2)}\n`);
    const manifest = manifestOf(parts, { recipe, recipeHash, s });
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const sourcesOut = parts.map((p) => ({ repo: p.source.repo, commit: p.source.commit, date: p.source.date }));
    const pack = assemble(stage, {
      recipeId: recipe.id, recipeHash, sources: sourcesOut, knowledgeDate: sourcesOut.map((x) => x.date).sort().at(-1),
      counts: { units: manifest.counts.passages, files: manifest.counts.files, history: manifest.counts.history },
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
    lexical.abort();
    history?.abort();
    layered?.abort();
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

/** Opens a finished store read-only for one job. */
function withDb(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** A list entry { "gists": "<passages.jsonl>" } becomes the `_gists` source, written to a temporary
 *  folder (removed when the process ends) by gists.mjs. */
function gistSource(file, listFile, i) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb5-gists-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const r = materializeGists(file, path.join(dir, GISTS_REPO));
  if (r.problems.length) console.error(`${listFile} sources[${i}]: ${r.problems.length} gist passages skipped (${r.problems[0].reason})`);
  return { dir: r.dir, repo: GISTS_REPO, history: null };
}

function sourceList(listFile) {
  const base = path.dirname(listFile);
  const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
  if (!Array.isArray(list?.sources)) throw new Error(`${listFile} has no "sources" list`);
  return list.sources.map((e, i) => {
    if (typeof e?.gists === 'string') return gistSource(path.resolve(base, e.gists), listFile, i);
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
