// Shared harness for the work package 1 (engine) acceptance tests.
// - engineTree(): a scratch copy of packages/ with this test's break (breaks.mjs, V5_BREAK) applied,
//   and the engine module imported from that copy.
// - writePack(): a fixture pack in the one pack format, written by the builder's own store writer
//   (packages/builder/store.mjs writeStore, from the same scratch copy, so it indexes through that
//   copy's analyse()): passages.sqlite (role lexical-db) and history.sqlite (role history-db), each a
//   `units` table and a contentless fts5(subject, body). A passage's header is `repo › path › symbol`
//   and its text is the body only (as the builder stores it); a history item has path
//   `history/<kind>/<ref>`, header `repo › history › <kind> <ref> › <date> › <title>` and
//   start_line/end_line NULL. Plus RECIPE.json (role recipe), PROBES.json (role probes), PACK.json.
// - pilotPack(): the retrieval run's measured index (table `p`, same columns) behind the shipped
//   recipe's analyser, keyword lane and FILES section.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BREAKS } from './breaks.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

// The retrieval run's corpus slice and question sets live outside the product repository on the
// owner's machine and are named ONLY by environment variables (no machine's path is written here):
//   WP1_PILOT_DB, WP1_DEV_QUESTIONS, WP1_RUN_DIR (the retrieval run's folder; WP1_RIG_SCORES,
//   WP1_RIG_RUN and the E, F, G sets default to their places inside it), WP1_QUESTION_SETS.
// A test that needs one skips, naming the variable, without it.
const unset = (name) => `(not set: ${name})`;
const RUN = process.env.WP1_RUN_DIR;
const inRun = (rel) => (RUN ? path.join(RUN, rel) : unset('WP1_RUN_DIR'));
const DEV = process.env.WP1_DEV_QUESTIONS ?? unset('WP1_DEV_QUESTIONS');
export const EXTERNAL = {
  pilotDb: process.env.WP1_PILOT_DB ?? unset('WP1_PILOT_DB'),
  devQuestions: DEV,
  rigScores: process.env.WP1_RIG_SCORES ?? inRun('candidates/rig/per-question.jsonl'),
  rigRun: process.env.WP1_RIG_RUN ?? inRun('candidates/rig/v2-bm25.jsonl'),
  questionSets: process.env.WP1_QUESTION_SETS
    ? process.env.WP1_QUESTION_SETS.split(path.delimiter)
    : RUN ? [DEV, inRun('instrument/E-verified.json'), inRun('instrument/F/F-verified.json'), inRun('instrument/G/G-verified.json')] : [],
};

// The keyword analyser's stop words (the measured lane's list).
export const STOPWORDS = ['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with', 'how', 'what', 'when', 'where', 'who', 'why', 'which', 'whose', 'whom', 'can', 'do', 'does', 'did', 'has', 'have', 'had', 'been', 'being', 'am', 'were', 'about', 'after', 'all', 'also', 'any', 'because', 'before', 'below', 'between', 'both', 'each', 'few', 'from', 'further', 'here', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'its', 'them', 'theirs', 'over', 'under', 'than', 'just', 'only', 'more', 'most', 'other', 'some', 'so', 'too', 'very', 'one', 'two', 'three', 'first', 'last', 'new', 'old'];

/** The day-one recipe as work package 1 assumes it (a request to the owner of recipe/). */
export function wp1Recipe(over = {}) {
  const base = {
    schema: 'ruvnet-brain/recipe',
    version: 1,
    id: 'r2-wp1-fixture',
    units: { passage: { chunker: { name: 'lines', version: 1, maxLines: 80, maxChars: 6000 }, header: 'repo-and-path' } },
    sources: { include: ['.md', '.txt', '.rs', '.ts', '.js', '.mjs', '.py', '.toml', '.json'], excludeDirs: ['.git', 'node_modules', 'target', 'dist'], sourceFile: '.source.json' },
    standing: { docExtensions: ['.md', '.txt'], doc: 'claimed', code: 'implemented', byKind: { commit: 'implemented', release: 'claimed', issue: 'claimed', pull: 'implemented', comment: 'claimed' } },
    analyser: { name: 'lucene-porter-ident', fts5Tokenizer: 'unicode61', minTokenLength: 2, minNumberLength: 4, maxQueryTerms: 1000, splitIdentifiers: true, stemmer: 'porter', stopwords: STOPWORDS },
    models: [],
    lanes: [
      { name: 'lexical', kind: 'fts5-bm25', optional: false, role: 'lexical-db', weights: { subject: 1, body: 1 }, depth: 100, unit: 'passage' },
      { name: 'history', kind: 'fts5-bm25', optional: true, role: 'history-db', weights: { subject: 1, body: 1 }, depth: 100, unit: 'history item' },
    ],
    sections: [
      { name: 'FILES', lane: 'lexical', maxItems: 5, itemChars: 8000, budgetChars: { brief: 20000, full: 44000 } },
      { name: 'HISTORY', lane: 'history', maxItems: 3, itemChars: 2000, budgetChars: { brief: 4000, full: 6000 } },
    ],
    result: { capChars: { brief: 24000, full: 60000 }, defaultDetail: 'brief' },
    deadlineMs: 10000,
    probes: { perRepo: 1, termsPerProbe: 3, minTermLength: 4 },
  };
  return { ...base, ...over };
}

function applyPatch(root, pt) {
  const file = path.join(root, pt.file);
  if (pt.create !== undefined) return fs.writeFileSync(file, pt.create);
  const text = fs.readFileSync(file, 'utf8');
  const n = text.split(pt.find).length - 1;
  if (n !== 1) throw new Error(`patch anchor in ${pt.file} matched ${n} times: ${pt.find.slice(0, 80)}`);
  fs.writeFileSync(file, text.replace(pt.find, () => pt.replace));
}

/** Temp folders removed after the test. */
export function scratch(t) {
  const dirs = [];
  t.after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return (prefix = 'wp1-') => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}

/** A scratch copy of packages/ with this test's break applied; returns its root and engine. */
export async function engineTree(tmp, testId) {
  const root = tmp('wp1-tree-');
  fs.cpSync(path.join(ROOT, 'packages'), path.join(root, 'packages'), { recursive: true });
  const brk = process.env.V5_BREAK && BREAKS[process.env.V5_BREAK];
  if (brk && brk.test === testId) for (const pt of brk.patches) applyPatch(root, pt);
  const engineDir = path.join(root, 'packages', 'engine');
  const engine = await import(pathToFileURL(path.join(engineDir, 'index.mjs')).href);
  const analyseNs = await import(pathToFileURL(path.join(engineDir, 'analyse.mjs')).href);
  const store = await import(pathToFileURL(path.join(root, 'packages', 'builder', 'store.mjs')).href);
  return { root, engineDir, engine, analyse: { ...analyseNs, writeStore: store.writeStore } };
}

function writeDb(file, rows, recipe, analyseMod) {
  const units = rows.map((r) => {
    const text = r.text.startsWith(`${r.header}\n`) ? r.text.slice(r.header.length + 1) : r.text;
    return {
      store: r.repo, repo: r.repo, path: r.path, kind: r.kind ?? null, start_line: r.start ?? null, end_line: r.end ?? null,
      header: r.header, text, hash: sha(text), standing: r.standing ?? null, date: r.date ?? null, commit_id: r.commit ?? null,
      flag: r.flag ?? null, subject: r.header,
    };
  });
  analyseMod.writeStore(file, units, { tokenizer: recipe.analyser.fts5Tokenizer, analyser: recipe.analyser });
}

/** Passages of one file: `bodies` is a list of passage bodies (line arrays or strings), in order. */
export function filePassages(repo, file, bodies, { kind = 'source', date = '2026-11-15', commit = 'c0ffee000001' } = {}) {
  let line = 1;
  return bodies.map((b, i) => {
    const lines = Array.isArray(b) ? b : String(b).split('\n');
    const header = `${repo} › ${file} › part${i + 1}`;
    const r = { repo, path: file, kind, start: line, end: line + lines.length - 1, header, text: `${header}\n${lines.join('\n')}`, date, commit };
    line += lines.length + 1;
    return r;
  });
}

export function historyItem(repo, kind, ref, date, title, body) {
  return { repo, path: `history/${kind}/${ref}`, kind, header: `${repo} › history › ${kind} ${ref.slice(0, 10)} › ${date} › ${title}`, text: body, date, commit: kind === 'commit' ? ref : null };
}

/** Writes a fixture pack. Returns its folder. */
export function writePack(dir, analyseMod, { recipe = wp1Recipe(), passages = [], history = null, probes = [], extra = {}, sources } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const recipeText = JSON.stringify(recipe, null, 2);
  fs.writeFileSync(path.join(dir, 'RECIPE.json'), recipeText);
  fs.writeFileSync(path.join(dir, 'PROBES.json'), JSON.stringify({ schema: 'ruvnet-brain/probes', version: 1, probes }));
  writeDb(path.join(dir, 'passages.sqlite'), passages, recipe, analyseMod);
  const roles = { 'RECIPE.json': 'recipe', 'PROBES.json': 'probes', 'passages.sqlite': 'lexical-db' };
  if (history) {
    writeDb(path.join(dir, 'history.sqlite'), history, recipe, analyseMod);
    roles['history.sqlite'] = 'history-db';
  }
  for (const [name, { role, rows }] of Object.entries(extra)) {
    writeDb(path.join(dir, name), rows, recipe, analyseMod);
    roles[name] = role;
  }
  const repos = [...new Set([...passages, ...(history ?? [])].map((r) => r.repo))].sort();
  return manifest(dir, roles, { recipeText, sources: sources ?? repos.map((repo) => ({ repo, commit: 'c0ffee000001', date: '2026-11-15' })) });
}

/** (Re)writes PACK.json listing `roles` (file name -> role) with sizes and hashes. */
export function manifest(dir, roles, { recipeText, sources, fields = {}, hashes = {} }) {
  const files = Object.entries(roles).map(([p, role]) => {
    const full = path.join(dir, p);
    return { path: p, role, size: fs.statSync(full).size, sha256: hashes[p] ?? sha(fs.readFileSync(full)) };
  });
  const pack = {
    schema: 'ruvnet-brain/pack', version: 1,
    generation: `g-2026-11-15-${sha(files.map((f) => f.sha256).join()).slice(0, 12)}`,
    builtAt: '2026-11-15T00:00:00Z', knowledgeDate: '2026-11-15', recipeId: JSON.parse(recipeText).id, recipeHash: sha(recipeText),
    sources, counts: { units: 0, files: files.length }, files, ...fields,
  };
  fs.writeFileSync(path.join(dir, 'PACK.json'), JSON.stringify(pack, null, 2));
  return dir;
}

/** Runs the engine in `n` separate Node processes at once over `questions`; returns, per process,
 *  its process id and one first-five list per question. */
export async function firstFiveInProcesses(n, engineDir, packDir, questions, tmp) {
  const qFile = path.join(tmp('wp1-q-'), 'q.json');
  fs.writeFileSync(qFile, JSON.stringify(questions));
  const one = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, 'wp1-run-engine.mjs'), engineDir, packDir, qFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => (code === 0 ? resolve({ pid: child.pid, lists: JSON.parse(out) }) : reject(new Error(`engine process failed: ${err}`))));
  });
  return Promise.all(Array.from({ length: n }, one));
}

/** A pack around the retrieval run's own keyword index (linked, not copied or rebuilt), keyword
 *  lane and FILES section only, as the run measured it. */
export async function pilotPack(tmp) {
  const pack = path.join(tmp('wp1-pilot-'), 'pack');
  fs.mkdirSync(pack);
  fs.symlinkSync(EXTERNAL.pilotDb, path.join(pack, 'passages.sqlite'));
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'recipe', 'RECIPE.json'), 'utf8'));
  const recipeText = JSON.stringify({ ...shipped, id: 'r2-wp1-pilot', lanes: shipped.lanes.filter((l) => l.name === 'lexical'), sections: shipped.sections.filter((x) => x.name === 'FILES') }, null, 2);
  fs.writeFileSync(path.join(pack, 'RECIPE.json'), recipeText);
  fs.writeFileSync(path.join(pack, 'PROBES.json'), JSON.stringify({ schema: 'ruvnet-brain/probes', version: 1, probes: [] }));
  const db = new DatabaseSync(EXTERNAL.pilotDb, { readOnly: true });
  const repos = db.prepare('SELECT DISTINCT repo FROM p ORDER BY repo').all().map((r) => r.repo);
  db.close();
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(EXTERNAL.pilotDb)) h.update(chunk);
  manifest(pack, { 'RECIPE.json': 'recipe', 'PROBES.json': 'probes', 'passages.sqlite': 'lexical-db' }, {
    recipeText, sources: repos.map((repo) => ({ repo, commit: 'pilot-slice', date: '2026-11-16' })), hashes: { 'passages.sqlite': h.digest('hex') },
  });
  return pack;
}

export const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};
