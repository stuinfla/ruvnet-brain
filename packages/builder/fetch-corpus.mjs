// Fetches the pinned corpus for the release build (CI only; never shipped):
//   node fetch-corpus.mjs --corpus recipe/CORPUS.json --into <dir> --list <sources.json> [--gists <passages.jsonl> | --no-gists]
// Each source is fetched at exactly its pinned commit (a shallow fetch of that one commit, never a
// branch tip) into <dir>/<repo>, and given its .source.json { repo, commit, date }, the date being the
// commit's own committer date. The builder's --sources list file is written with one { dir } per source
// and, unless --no-gists, one { gists } entry; a gists file that does not exist stops the run (the
// release pack is not built silently without the gists). Exit 1 with the reason on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from '../contract/home.mjs';

const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[0-9a-f]{40}$/;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 1_800_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${cwd ?? '.'}: ${(r.stderr || r.error?.message || '').trim().slice(0, 400)}`);
  return r.stdout.trim();
}

/** Reads and checks the corpus file: { sources: [{ repo, url, commit }] }. */
export function readCorpus(file) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(c?.sources) || !c.sources.length) throw new Error(`${file} has no sources`);
  const seen = new Set();
  for (const s of c.sources) {
    if (!REPO.test(String(s?.repo)) || !COMMIT.test(String(s?.commit)) || typeof s?.url !== 'string' || !s.url) throw new Error(`${file}: each source needs a plain repo, a url and a full 40-character commit (${JSON.stringify(s).slice(0, 120)})`);
    if (seen.has(s.repo.toLowerCase())) throw new Error(`${file}: ${s.repo} is listed twice`);
    seen.add(s.repo.toLowerCase());
  }
  return c;
}

/** Fetches every source at its pin and writes the list file. Returns the list's entries. */
export function fetchCorpus({ corpus, into, list, gists = null }) {
  const c = readCorpus(corpus);
  fs.mkdirSync(into, { recursive: true });
  const entries = [];
  for (const s of c.sources) {
    const dir = path.join(into, s.repo);
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists; fetch into an empty folder`);
    fs.mkdirSync(dir);
    git(['init', '--quiet'], dir);
    git(['fetch', '--quiet', '--depth', '1', '--no-tags', s.url, s.commit], dir);
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
    const head = git(['rev-parse', 'HEAD'], dir);
    if (head !== s.commit) throw new Error(`${s.repo}: fetched ${head}, pinned ${s.commit}`);
    const date = git(['show', '-s', '--format=%cs', 'HEAD'], dir);
    fs.writeFileSync(path.join(dir, '.source.json'), `${JSON.stringify({ repo: s.repo, commit: s.commit, date })}\n`);
    entries.push({ dir, repo: s.repo });
  }
  if (gists) {
    if (!fs.existsSync(gists)) throw new Error(`the gists passage file ${gists} does not exist; pass --no-gists to build without them (docs/F04-DECISIONS.md G1)`);
    entries.push({ gists: path.resolve(gists) });
  }
  fs.writeFileSync(list, `${JSON.stringify({ sources: entries }, null, 1)}\n`);
  return entries;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? null : args.splice(i, 2)[1];
  };
  const noGists = args.includes('--no-gists');
  const corpus = take('--corpus');
  const into = take('--into');
  const list = take('--list');
  const gists = noGists ? null : take('--gists');
  if (!corpus || !into || !list || (!noGists && !gists)) {
    console.error('usage: node fetch-corpus.mjs --corpus <CORPUS.json> --into <dir> --list <sources.json> (--gists <passages.jsonl> | --no-gists)');
    process.exit(2);
  }
  try {
    const e = fetchCorpus({ corpus: path.resolve(corpus), into: path.resolve(into), list: path.resolve(list), gists: gists && path.resolve(gists) });
    console.log(`fetched ${e.filter((x) => x.dir).length} sources at their pins${e.some((x) => x.gists) ? ' and listed the gists' : ' (no gists)'}; list: ${list}`);
  } catch (e) {
    console.error(`fetch failed: ${e.message}`);
    process.exit(1);
  }
}
