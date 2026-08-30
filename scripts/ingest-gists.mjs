#!/usr/bin/env node
// ingest-gists.mjs — pull rUv's public GitHub gists into the brain as their own store.
//
// WHY GISTS. The brain indexes rUv's REPOS, which is where an idea lands LAST. His gists are where
// it appears FIRST: `ruflo-3.24.0-flywheel.md` was published as a gist days before anything but an
// ADR existed in our corpus. Indexing them moves the brain's clock from "what rUv has shipped" to
// "what rUv is thinking" — which is the whole premise of this project.
//
// WHY THEY ARE FENCED. A gist is an announcement, not shipped source. It routinely describes work
// that is proposed, unreleased, or still moving. If the brain quotes a gist as fact, it will tell
// users about features that do not exist — the exact drift this project exists to prevent, wearing
// a new hat. So every gist passage carries a provenance banner in its own text, the same way the
// KB already stamps `ADR STATUS: PROPOSED` onto ADR passages. Retrieval then hands the model the
// claim AND its epistemic status together; they cannot be separated downstream.
//
//   node scripts/ingest-gists.mjs                    # incremental (only re-fetch changed gists)
//   node scripts/ingest-gists.mjs --full             # ignore the cache, refetch everything
//   node scripts/ingest-gists.mjs --owner ruvnet     # default owner
//   node scripts/ingest-gists.mjs --dry-run          # list what would change, write nothing
//
// Then embed (the store becomes searchable with no restart — forge-ask-all discovers *.rvf at query
// time):
//   node kb/forge-big.mjs both --dir kb --name ruv-gists

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');
const NAME = 'ruv-gists';
const CACHE = path.join(KB, `.${NAME}.cache.json`);

const argv = process.argv.slice(2);
const arg = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const OWNER = arg('--owner', 'ruvnet');
const FULL = argv.includes('--full');
const DRY = argv.includes('--dry-run');
// --index-only writes the human/git-trackable index from the LIST endpoint alone (~5 API calls,
// no per-gist fetch, no embedding). That is what the nightly job runs: the KB stores are gitignored
// and ship via Release, so nightly CI can keep the INDEX fresh even though it cannot commit vectors.
const INDEX_ONLY = argv.includes('--index-only');
const INDEX_PATH = path.join(ROOT, 'docs', 'RUV-GISTS.md');
const FETCH_TIMEOUT_MS = Number(process.env.RUVNET_GISTS_FETCH_TIMEOUT_MS || 30_000);

// Markdown/text only. A gist's code files are better read from the repo they land in; prose is the
// thing repos don't carry.
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst']);

/** Authenticated GitHub calls via `gh` — 5000 req/hr instead of 60, and no token handling here. */
function gh(endpointArgs) {
  const r = spawnSync('gh', endpointArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: FETCH_TIMEOUT_MS,
  });
  if (r.status !== 0) {
    const detail = r.error?.code === 'ETIMEDOUT' || r.signal
      ? `timed out after ${FETCH_TIMEOUT_MS}ms`
      : (r.stderr || '').trim().slice(0, 200);
    throw new Error(`gh ${endpointArgs.join(' ')} failed: ${detail}`);
  }
  return r.stdout;
}

async function listGists(owner) {
  try {
    const raw = gh(['api', `users/${owner}/gists?per_page=100`, '--paginate', '--slurp']);
    const pages = JSON.parse(raw);
    // --slurp yields an array of pages OR a flat array depending on gh version; flatten defensively.
    return pages.flat().filter((g) => g && g.id);
  } catch (err) {
    // In Actions, gh can NEVER list gists: GITHUB_TOKEN is a GitHub App token and the gists API is
    // closed to those ("Resource not accessible by integration", HTTP 403 — every nightly run since
    // birth). Public gists need no auth at all, so fall back to the plain API (60 req/hr per IP).
    console.error(`  gh failed (${String(err.message).slice(0, 100)}) — falling back to unauthenticated API`);
    return listGistsPublic(owner);
  }
}

// Hermetic-test seam (same pattern as the router's MODEL_ROUTER_CATALOG): integration tests point
// this at an unreachable port to exercise the fallback's failure path without touching the live API.
const API_BASE = process.env.RUVNET_GISTS_API || 'https://api.github.com';

async function listGistsPublic(owner) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${API_BASE}/users/${owner}/gists?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ruvnet-brain-gists-index' },
    });
    if (res.status === 403 || res.status === 429) {
      const err = new Error(`unauthenticated gists list rate-limited (HTTP ${res.status})`);
      err.rateLimited = true; // runner IPs share the anonymous quota — a known, transient condition
      throw err;
    }
    if (!res.ok) throw new Error(`unauthenticated gists list failed: HTTP ${res.status}`);
    const items = await res.json();
    all.push(...items.filter((g) => g && g.id));
    if (items.length < 100) break;
  }
  return all;
}

/** Raw file bodies. The list endpoint truncates `content`, so fetch each gist individually. */
function fetchGist(id) {
  return JSON.parse(gh(['api', `gists/${id}`]));
}

// ~3200-char paragraph-aligned chunks — same shape build-concepts.mjs uses, so the reader's chunk
// handling and the `#N` suffix convention stay uniform across stores.
function chunk(text, size = 3200) {
  const out = [];
  let buf = '';
  for (const para of text.split(/\n\n+/)) {
    if (buf && buf.length + para.length + 2 > size) { out.push(buf); buf = ''; }
    buf = buf ? `${buf}\n\n${para}` : para;
  }
  if (buf.trim()) out.push(buf);
  return out.length ? out : [];
}

/** The banner that travels WITH the text, so a retrieval hit can never lose its provenance. */
const banner = (g, file) =>
  `SOURCE: GitHub gist by @${OWNER} — "${(g.description || file).replace(/\s+/g, ' ').trim().slice(0, 160)}"\n` +
  `GIST STATUS: rUv's own notes / release announcement — may describe PROPOSED or UNRELEASED work.\n` +
  `Treat as intent, not as confirmed shipped behavior: verify against repo source before asserting.\n` +
  `updated: ${g.updated_at?.slice(0, 10)} · https://gist.github.com/${OWNER}/${g.id}\n\n`;

/** A tiny, git-trackable feed of what rUv has published, newest first. Costs ~5 API calls. */
function writeIndex(gists) {
  const rows = [...gists].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const lines = [
    '# rUv\'s public gists — index',
    '',
    '> Auto-generated by `node scripts/ingest-gists.mjs --index-only`. Newest first.',
    '>',
    '> **These are announcements and notes, not shipped source.** A gist routinely describes work that is',
    '> proposed, unreleased, or still moving. Verify against repo source before asserting behavior.',
    '',
    `_${rows.length} gists · refreshed ${new Date().toISOString().slice(0, 10)}_`,
    '',
    '| Updated | Gist | Description |',
    '|---|---|---|',
  ];
  for (const g of rows) {
    const file = Object.keys(g.files || {})[0] || '(no files)';
    const desc = (g.description || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim().slice(0, 120) || '—';
    lines.push(`| ${g.updated_at.slice(0, 10)} | [${file}](https://gist.github.com/${OWNER}/${g.id}) | ${desc} |`);
  }
  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, lines.join('\n') + '\n');
  console.log(`  wrote ${path.relative(ROOT, INDEX_PATH)} (${rows.length} rows)`);
}

async function main() {
  if (!fs.existsSync(KB)) { console.error(`ingest-gists: no kb dir at ${KB}`); process.exit(2); }

  const cache = !FULL && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  console.log(`ingest-gists: listing public gists for @${OWNER}…`);
  let gists;
  try {
    gists = await listGists(OWNER);
  } catch (err) {
    if (INDEX_ONLY && err.rateLimited) {
      // The index is a freshness feed; one skipped night self-heals on the next run. Exit 0 so a
      // transient shared-IP rate limit doesn't page anyone — real script errors still exit 1.
      console.error(`ingest-gists: SKIP — ${err.message}; the index catches up on the next nightly.`);
      process.exit(0);
    }
    throw err;
  }
  console.log(`  ${gists.length} gists found`);

  if (INDEX_ONLY) { writeIndex(gists); return; }

  const changed = gists.filter((g) => cache[g.id] !== g.updated_at);
  console.log(`  ${changed.length} new or updated since last run${FULL ? ' (--full: cache ignored)' : ''}`);
  if (DRY) {
    for (const g of changed.slice(0, 20)) console.log(`    ${g.updated_at.slice(0, 10)}  ${Object.keys(g.files)[0]}`);
    if (changed.length > 20) console.log(`    … and ${changed.length - 20} more`);
    return;
  }
  if (!changed.length && fs.existsSync(path.join(KB, `${NAME}.passages.jsonl`))) {
    console.log('  nothing to do — store is current.');
    return;
  }

  // Full rebuild of the passage file (ids must stay dense and aligned with the .rvf idmap; a
  // partial append would desynchronise them — the failure mode that maps a vector to the wrong text).
  const passages = [];
  const entries = {};
  let id = 0;
  let files = 0;
  let skipped = 0;

  for (const [i, stub] of gists.entries()) {
    if (i % 25 === 0) process.stdout.write(`\r  fetching ${i}/${gists.length}…`);
    let g;
    try {
      g = fetchGist(stub.id);
    } catch (err) {
      skipped++;
      console.error(`\n  fetch failed for gist ${stub.id}: ${err.message}`);
      continue;
    }
    for (const [fname, f] of Object.entries(g.files || {})) {
      if (!TEXT_EXT.has(path.extname(fname).toLowerCase())) continue;
      // JSONL readers treat U+2028/U+2029 as physical line separators on some runtimes. Normalize
      // them before serialization so one JSON object always remains one physical passage line.
      const body = (f.truncated && f.raw_url ? '' : (f.content || '')).replace(/[\u2028\u2029]/g, '\n');
      if (!body.trim()) {
        skipped++;
        console.error(`\n  empty or truncated text file: ${stub.id}/${fname}`);
        continue;
      }
      const title = (g.description || fname).replace(/\s+/g, ' ').trim().slice(0, 180) || fname;
      const head = banner(g, fname);
      // Banner on EVERY chunk, not just the first. Retrieval returns ONE chunk — if the provenance
      // lives only in chunk 0, then chunk 2 reaches the model as an unlabelled assertion, which is
      // exactly the fence this file claims to build. (Caught by reading a real retrieval: the top
      // hit for "enable the flywheel" was `…flywheel.md#2` and carried no status line.)
      const chunks = chunk(body);
      chunks.forEach((c, ci) => {
        const sid = String(id++);
        const p = `${g.id.slice(0, 8)}/${fname}${chunks.length > 1 ? `#${ci}` : ''}`;
        const text = head + c;
        passages.push({ id: sid, text, path: p, title });
        entries[sid] = { path: p, kind: 'doc', title, chunk: ci, preview: text.slice(0, 200) };
      });
      files++;
    }
    cache[stub.id] = stub.updated_at;
  }
  process.stdout.write('\r');

  // A receipt-only or partial corpus is more dangerous than a failed run: its RVF idmap can look
  // healthy while silently omitting live source. Preserve the previous complete corpus and make
  // the nightly job retry instead of publishing incomplete search data.
  if (skipped > 0) {
    throw new Error(`ingest-gists: refusing to write partial corpus (${skipped} fetch/content failures)`);
  }

  fs.writeFileSync(path.join(KB, `${NAME}.passages.jsonl`), passages.map((p) => JSON.stringify(p)).join('\n') + '\n');
  fs.writeFileSync(path.join(KB, `${NAME}.meta.json`), JSON.stringify({
    model: NAME, dimensions: 0, metric: 'cosine', name: NAME,
    generated: new Date().toISOString(), repo: `gists/${OWNER}`,
    note: "rUv's public gists — announcements and thinking, PROPOSED unless confirmed in repo source.",
    entries,
  }, null, 2));
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));

  console.log(`ingest-gists: ${gists.length} gists · ${files} text files · ${passages.length} passages · ${skipped} skipped`);
  writeIndex(gists);
  console.log(`  wrote kb/${NAME}.passages.jsonl + kb/${NAME}.meta.json`);
  console.log(`  next: node kb/forge-big.mjs both --dir kb --name ${NAME}   (embed → ${NAME}.big.rvf)`);
}

await main();
