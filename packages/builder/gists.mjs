// rUv's gists as a source (ported from the L+ prototype's lib/gists.mjs): the Brain's gist passage file
// (one JSON line per passage: { id, path: "<gist-id>/<file>#<chunk>", title, text }) becomes a plain
// source folder `_gists`, one file per gist file, so the lexical store and the layered store read it like
// any repository (and the recipe's secret screen and hostile flag apply to it).
//   - Each passage is a 4-line header the Brain wrote (SOURCE / GIST STATUS / Treat as intent / updated)
//     plus a blank line, then a verbatim chunk of the gist file. The header is NOT gist text: it is
//     removed; only its date and URL are kept, as metadata.
//   - Chunks of one file are joined in chunk order with one "\n". A missing or repeated chunk number is
//     recorded, never filled in.
//   - .source.json is { repo: "_gists", commit: "sha256:<passage file>", date: <newest updated date>,
//     gists: { "<gist-id>/<file>": { title, updated, url, chunks, missing_chunks } } }. No clock: the same
//     passage file gives the same folder.
//   node packages/builder/gists.mjs --from <passages.jsonl> --out <empty or new folder>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from '../contract/home.mjs';

export const GISTS_REPO = '_gists';
const HEADER = /^SOURCE: GitHub gist[^\n]*\nGIST STATUS:[^\n]*\nTreat as intent[^\n]*\nupdated: ([^\n]*)\n\n/;
const SAFE = /^[A-Za-z0-9_-]+\/[^/\\\0]+$/;

/** Writes the `_gists` source folder into outDir (which must be absent or empty). Returns a summary. */
export function materializeGists(jsonlPath, outDir) {
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`${outDir} is not empty`);
  const files = new Map();
  const problems = [];
  let passages = 0;
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    passages++;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return problems.push({ line: i + 1, reason: 'not JSON' });
    }
    const [fp, nRaw] = String(o.path ?? '').split('#');
    const n = nRaw === undefined || nRaw === '' ? 0 : Number(nRaw);
    if (!SAFE.test(fp) || fp.split('/').some((s) => s === '.' || s === '..') || !Number.isInteger(n) || n < 0) return problems.push({ line: i + 1, reason: `unsafe or malformed path ${String(o.path).slice(0, 80)}` });
    const m = HEADER.exec(String(o.text ?? ''));
    if (!m) return problems.push({ line: i + 1, reason: 'Brain header not found; passage skipped' });
    const [updated, url] = m[1].split(' · ');
    if (!files.has(fp)) files.set(fp, { title: String(o.title ?? fp), updated: (updated ?? '').trim(), url: (url ?? '').trim() || null, chunks: [] });
    files.get(fp).chunks.push({ n, body: o.text.slice(m[0].length) });
  });
  if (!files.size) throw new Error(`${jsonlPath} holds no gist passage with the Brain header`);
  fs.mkdirSync(outDir, { recursive: true });
  const gists = {};
  for (const fp of [...files.keys()].sort()) {
    const f = files.get(fp);
    f.chunks.sort((a, b) => a.n - b.n);
    const ns = new Set(f.chunks.map((c) => c.n));
    const max = Math.max(...ns);
    const missing = [...Array(max + 1).keys()].filter((k) => !ns.has(k));
    const text = f.chunks.map((c) => c.body).join('\n');
    fs.mkdirSync(path.join(outDir, path.dirname(fp)), { recursive: true });
    fs.writeFileSync(path.join(outDir, fp), text.endsWith('\n') ? text : `${text}\n`);
    gists[fp] = { title: f.title, updated: f.updated, url: f.url, chunks: f.chunks.length, missing_chunks: missing, repeated_chunks: f.chunks.length - ns.size };
  }
  const dates = Object.values(gists).map((g) => g.updated).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!dates.length) throw new Error(`${jsonlPath}: no passage carries an updated date (YYYY-MM-DD)`);
  const commit = `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  fs.writeFileSync(path.join(outDir, '.source.json'), `${JSON.stringify({ repo: GISTS_REPO, commit, date: dates.at(-1), gists }, null, 1)}\n`);
  return { dir: outDir, passages, files: files.size, gists: new Set([...files.keys()].map((k) => k.split('/')[0])).size, problems, commit };
}

if (isMain(import.meta.url)) {
  const a = process.argv.slice(2);
  const from = a[a.indexOf('--from') + 1];
  const out = a[a.indexOf('--out') + 1];
  if (!a.includes('--from') || !a.includes('--out') || !from || !out) {
    console.error('usage: node packages/builder/gists.mjs --from <passages.jsonl> --out <folder>');
    process.exit(2);
  }
  try {
    const r = materializeGists(path.resolve(from), path.resolve(out));
    console.log(`wrote ${r.files} gist files (${r.gists} gists) from ${r.passages} passages; ${r.problems.length} passages skipped`);
  } catch (e) {
    console.error(`gists failed: ${e.message}`);
    process.exit(1);
  }
}
