// Shared harness for the work package 5 (pack builder) acceptance tests. Everything runs through the
// builder's real command (`packages/builder/build.mjs`) in a scratch copy of the tree made by
// helpers.setup(), so a break named in breaks.mjs for the test id is applied to that copy only.
// Fixture sources are written at test time into temp folders; tests read only the pack it writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

export { setup, THREE, repo, FIXTURES, ROOT } from './helpers.mjs';

export const SEP = ' › ';
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Writes a source folder: files is { 'rel/path': text }, meta is the .source.json content. */
export function writeRepo(dir, meta, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.source.json'), JSON.stringify(meta));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** Copies a committed fixture repository so a test may change it. */
export function copyRepo(ctx, from) {
  const to = path.join(ctx.tmp('rb5-src-'), path.basename(from));
  fs.cpSync(from, to, { recursive: true });
  return to;
}

/** Writes the tree's recipe with `edit(recipe)` applied and returns its path. */
export function recipeFile(ctx, tree, edit) {
  const r = JSON.parse(fs.readFileSync(path.join(tree.root, 'recipe', 'RECIPE.json'), 'utf8'));
  edit?.(r);
  const file = path.join(ctx.tmp('rb5-recipe-'), 'RECIPE.json');
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  return file;
}

/** Runs the builder command. Returns { status, stdout, stderr, out }; never asserts. */
export function build(ctx, tree, { sources = [], list = null, recipe = null, cache = null, out = null } = {}) {
  const outDir = out ?? path.join(ctx.tmp('rb5-pack-'), 'pack');
  const args = [path.join(tree.root, 'packages', 'builder', 'build.mjs'), '--recipe', recipe ?? path.join(tree.root, 'recipe', 'RECIPE.json'), '--out', outDir];
  if (cache) args.push('--cache', cache);
  if (list) args.push('--sources', list);
  args.push(...sources);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: outDir };
}

export function built(ctx, tree, opts) {
  const r = build(ctx, tree, opts);
  if (r.status !== 0) throw new Error(`build failed (${r.status}): ${r.stdout}\n${r.stderr}`);
  return r.out;
}

export function query(pack, file, sql, ...params) {
  const db = new DatabaseSync(path.join(pack, file), { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export const units = (pack, where = '1', ...p) => query(pack, 'lexical.db', `SELECT * FROM units WHERE ${where} ORDER BY id`, ...p);

/** Every file under a pack with its sha256 (posix relative paths, sorted). */
export function fileHashes(dir) {
  const out = {};
  (function rec(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(r);
      else out[r] = sha256(fs.readFileSync(path.join(dir, r)));
    }
  })('');
  return out;
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const tmpRoot = () => os.tmpdir();

/** Runs the pack's own probes through the engine of the tree copy, in a separate process. */
export function selfTest(tree, pack) {
  const code = `const e = await import(${JSON.stringify(new URL(`file://${path.join(tree.root, 'packages', 'engine', 'index.mjs')}`).href)});
    const h = e.open(${JSON.stringify(pack)}); try { console.log(JSON.stringify(e.selfTest(h))); } finally { e.close(h); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  if (r.status !== 0) throw new Error(`self-test process failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Searches the pack through the engine of the tree copy, in a separate process. */
export function search(tree, pack, q) {
  const code = `const e = await import(${JSON.stringify(new URL(`file://${path.join(tree.root, 'packages', 'engine', 'index.mjs')}`).href)});
    const h = e.open(${JSON.stringify(pack)}); try { console.log(JSON.stringify(e.search(h, ${JSON.stringify(q)}, { detail: 'full' }))); } finally { e.close(h); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  if (r.status !== 0) throw new Error(`search process failed: ${r.stderr}`);
  return JSON.parse(r.stdout).sections.flatMap((s) => s.items);
}

/** Re-writes PACK.json after a test edited a pack file (the builder's own assemble command). */
export function reassemble(tree, pack) {
  const r = spawnSync(process.execPath, [path.join(tree.root, 'packages', 'builder', 'assemble.mjs'), pack], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`assemble failed: ${r.stderr}`);
}
