// The builder (architecture 2.4), skeleton slice: source folders -> passages -> keyword index ->
// probes -> PACK.json. Driven entirely by the recipe; it holds no chunk size or model of its own.
//   node build.mjs --recipe <RECIPE.json> --out <packDir> <sourceDir>...
// Each source folder carries <recipe.sources.sourceFile> = { repo, commit, date }.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { check } from '../contract/validate.mjs';
import { isMain, listFiles, readJson, sha256, writeJsonAtomic } from '../contract/home.mjs';
import { words } from '../engine/analyse.mjs';
import * as engine from '../engine/index.mjs';
import { assemble } from './assemble.mjs';

function chunk(text, { maxLines, maxChars }) {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  let cur = [];
  let start = 1;
  let chars = 0;
  const flush = (end) => {
    if (cur.length) out.push({ start, end, text: cur.join('\n') });
    cur = [];
    chars = 0;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.length > maxChars) {
      flush(n - 1);
      for (let k = 0; k < line.length; k += maxChars) out.push({ start: n, end: n, text: line.slice(k, k + maxChars) });
      start = n + 1;
      return;
    }
    if (cur.length && (cur.length >= maxLines || chars + line.length + 1 > maxChars)) {
      flush(n - 1);
      start = n;
    }
    if (!cur.length) start = n;
    cur.push(line);
    chars += line.length + 1;
  });
  flush(lines.length);
  return out;
}

function readSource(dir, recipe) {
  const meta = readJson(path.join(dir, recipe.sources.sourceFile));
  const files = listFiles(dir).filter((p) => {
    if (p === recipe.sources.sourceFile) return false;
    if (p.split('/').some((seg) => recipe.sources.excludeDirs.includes(seg))) return false;
    return recipe.sources.include.includes(path.extname(p).toLowerCase());
  });
  return { meta, files };
}

function makeProbes(units, recipe) {
  const { termsPerProbe, minTermLength, perRepo } = recipe.probes;
  const stop = new Set(recipe.analyser.stopwords);
  const filesOf = new Map();
  for (const u of units) {
    for (const w of words(u.text, recipe.analyser)) {
      if (w.length < minTermLength || stop.has(w) || /^\d+$/.test(w)) continue;
      if (!filesOf.has(w)) filesOf.set(w, new Set());
      filesOf.get(w).add(`${u.repo}/${u.path}`);
    }
  }
  const probes = [];
  const byRepo = new Map();
  for (const u of units) {
    const f = `${u.repo}/${u.path}`;
    if (!byRepo.has(u.repo)) byRepo.set(u.repo, []);
    if (!byRepo.get(u.repo).includes(f)) byRepo.get(u.repo).push(f);
  }
  for (const [repo, files] of byRepo) {
    let made = 0;
    for (const f of files) {
      if (made >= perRepo) break;
      const own = [];
      for (const u of units.filter((x) => `${x.repo}/${x.path}` === f)) {
        for (const w of words(u.text, recipe.analyser)) {
          if (filesOf.get(w)?.size === 1 && !own.includes(w)) own.push(w);
        }
      }
      if (own.length >= termsPerProbe) {
        probes.push({ question: own.slice(0, termsPerProbe).join(' '), expect: f, repo });
        made++;
      }
    }
  }
  return probes;
}

export function build({ recipePath, sourceDirs, outDir }) {
  const recipeText = fs.readFileSync(recipePath, 'utf8');
  const recipe = check('recipe', JSON.parse(recipeText), recipePath);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  fs.mkdirSync(outDir, { recursive: true });
  const units = [];
  const sources = [];
  let fileCount = 0;
  const dirs = sourceDirs.map((d) => ({ d, ...readSource(d, recipe) })).sort((a, b) => a.meta.repo.localeCompare(b.meta.repo));
  for (const { d, meta, files } of dirs) {
    sources.push({ repo: meta.repo, commit: meta.commit, date: meta.date });
    for (const rel of files) {
      fileCount++;
      const isDoc = recipe.standing.docExtensions.includes(path.extname(rel).toLowerCase());
      for (const c of chunk(fs.readFileSync(path.join(d, rel), 'utf8'), recipe.units.passage.chunker)) {
        units.push({ repo: meta.repo, path: rel, ...c, hash: sha256(c.text), standing: isDoc ? recipe.standing.doc : recipe.standing.code, date: meta.date, commit: meta.commit });
      }
    }
  }
  const db = new DatabaseSync(path.join(outDir, 'lexical.db'));
  db.exec(`CREATE TABLE units (id INTEGER PRIMARY KEY, repo TEXT, path TEXT, start_line INTEGER, end_line INTEGER,
             hash TEXT, standing TEXT, date TEXT, commit_id TEXT, text TEXT);
           CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='${recipe.analyser.fts5Tokenizer}');`);
  const insU = db.prepare('INSERT INTO units VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insF = db.prepare('INSERT INTO fts(rowid, body) VALUES (?, ?)');
  db.exec('BEGIN');
  units.forEach((u, i) => {
    insU.run(i + 1, u.repo, u.path, u.start, u.end, u.hash, u.standing, u.date, u.commit, u.text);
    insF.run(i + 1, `${u.repo} ${u.path.replace(/[/._-]+/g, ' ')}\n${u.text}`);
  });
  db.exec('COMMIT');
  db.close();
  fs.writeFileSync(path.join(outDir, 'RECIPE.json'), recipeText);
  const probes = makeProbes(units, recipe);
  if (!probes.length) throw new Error('no probe could be made from these sources');
  writeJsonAtomic(path.join(outDir, 'PROBES.json'), { schema: 'ruvnet-brain/probes', version: 1, probes });
  const knowledgeDate = sources.map((s) => s.date).sort().at(-1);
  const pack = assemble(outDir, { recipeId: recipe.id, recipeHash: sha256(recipeText), sources, counts: { units: units.length, files: fileCount }, knowledgeDate });
  const h = engine.open(outDir);
  try {
    const t = engine.selfTest(h);
    if (!t.ok) throw new Error(`probe failed against the pack just built: ${JSON.stringify(t.results.filter((r) => !r.pass))}`);
  } finally {
    engine.close(h);
  }
  return pack;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? null : args.splice(i, 2)[1];
  };
  const recipePath = take('--recipe');
  const outDir = take('--out');
  if (!recipePath || !outDir || !args.length) {
    console.error('usage: node build.mjs --recipe <RECIPE.json> --out <packDir> <sourceDir>...');
    process.exit(2);
  }
  try {
    const pack = build({ recipePath: path.resolve(recipePath), sourceDirs: args.map((a) => path.resolve(a)), outDir: path.resolve(outDir) });
    console.log(`built ${pack.generation}: ${pack.counts.units} passages from ${pack.counts.files} files`);
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}
