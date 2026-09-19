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
// STEP 2 (2026-09-13): this file no longer owns its own fetch+write+chunk logic. Actual content
// ingestion routes through the one canonical pipeline (gist-receipts.mjs's captureGistSources ->
// buildGistAggregate), the same producer corpus-reconcile.mjs and seal-gist-receipt.mjs use. This
// file's own job is now just: (1) the cheap human-index/discovery operation (--index-only,
// --dry-run — pure listing, no per-gist fetch), and (2) deciding WHEN to invoke the canonical
// pipeline and with what local capture cache, never re-rendering a passage itself.
//
//   node scripts/ingest-gists.mjs                    # incremental (only re-fetches changed gists)
//   node scripts/ingest-gists.mjs --full             # ignore the local capture cache, refetch everything
//   node scripts/ingest-gists.mjs --owner ruvnet     # default owner
//   node scripts/ingest-gists.mjs --dry-run          # list what would change, write nothing
//
// Embedding is a SEPARATE step (this file never builds vectors — nightly-gists.sh's own sharded
// `forge-big.mjs shard-all` does, after this exits 0 with real changes):
//   node kb/forge-big.mjs both --dir kb --name ruv-gists

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest } from './coverage-integrity.mjs';
import { buildGistAggregate, captureGistSources } from './gist-receipts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');
const NAME = 'ruv-gists';
// The RESUMABLE capture cache (raw body text included) -- kept in the preparation workspace (kb/,
// this job's own working directory) and NEVER published: build-bundle.mjs only ever ships named,
// non-dotfile artifacts. It is purely an optimization; a missing or `--full`-ignored cache just
// means every currently-listed gist is treated as changed and refetched.
const CAPTURE_CACHE = path.join(KB, `.${NAME}.capture-cache.json`);

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

function loadCaptureCache() {
  if (FULL || !fs.existsSync(CAPTURE_CACHE)) return null;
  try { return JSON.parse(fs.readFileSync(CAPTURE_CACHE, 'utf8')); }
  catch { return null; } // a corrupt local cache is a MISS, never a crash — everything refetches.
}

function saveCaptureCache(captured) {
  try { fs.writeFileSync(CAPTURE_CACHE, JSON.stringify(captured)); }
  catch (error) { console.error(`  note: could not persist the local capture cache (${error.message})`); }
}

async function main() {
  if (!fs.existsSync(KB)) { console.error(`ingest-gists: no kb dir at ${KB}`); process.exit(2); }

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

  // "changed" is computed against the ONE canonical schema-3 receipt (kb/ruv-gists.sources.json) —
  // never a private cache file's idea of the truth. Absent/unreadable/pre-schema-3 reads as "nothing
  // known yet", so every listed gist counts as changed (a correct, if conservative, first run).
  const receiptFile = path.join(KB, `${NAME}.sources.json`);
  let knownUpdatedAt = new Map();
  if (!FULL && fs.existsSync(receiptFile)) {
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (receipt.schemaVersion === 3) {
        knownUpdatedAt = new Map(Object.entries(receipt.gists || {}).map(([id, row]) => [id, row.updatedAt]));
      }
    } catch { /* treat as "nothing known yet" */ }
  }
  const changed = gists.filter((g) => knownUpdatedAt.get(g.id) !== g.updated_at);
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

  const observedAt = new Date().toISOString();
  const rows = gists.map((g) => ({ id: g.id, updated_at: g.updated_at, html_url: g.html_url,
    truncated: g.truncated, files: g.files }));
  const observation = {
    owner: OWNER, observedAt,
    // Bind the exact listed file inventory and its truncation indicator. A timestamp-only digest
    // could otherwise reuse a capture after the API changes a file's pinned raw blob or completeness.
    observationSha256: digest({ owner: OWNER, rows }),
    gists: { rows },
  };
  const now = () => observedAt;

  // Capture once ourselves (reusing the local body-bearing cache for anything unchanged) so we have
  // real raw bytes to persist for NEXT run's reuse. Handing that same captured set to
  // buildGistAggregate as ITS cache means its own internal capture pass is a 100%-reuse, zero-network
  // pass — this file still routes every byte through the one canonical pipeline, it just does not
  // throw away the bytes it already paid to fetch.
  const priorCache = loadCaptureCache();
  const captured = await captureGistSources({ observation, cache: priorCache, now });
  // Embedding is deliberately NOT done here (buildVector: null) — nightly-gists.sh's own sharded
  // `forge-big.mjs shard-all` embeds afterward, only when this process reports real changes; see the
  // module header. generation stays null and RVF-GENERATIONS.json is left untouched.
  const result = await buildGistAggregate({ observation, cache: captured, outDir: KB, buildVector: null, now });
  saveCaptureCache(captured);

  if (result.omitted) {
    console.log(`ingest-gists: @${OWNER} currently has zero public gists — aggregate omitted, nothing ingested.`);
    writeIndex(gists);
    return;
  }
  // Report OUR OWN capture pass's reuseEvidence, not buildGistAggregate's internal one -- the latter
  // is a 100%-reuse pass by construction (it is handed the set WE just captured) and would always
  // read "reused N, fetched 0" regardless of how much real network work just happened.
  console.log(`ingest-gists: ${gists.length} gists · reused ${captured.reuseEvidence.reused.length} · fetched ${captured.reuseEvidence.fetched.length} fresh`);
  writeIndex(gists);
  console.log(`  wrote kb/${NAME}.passages.jsonl + kb/${NAME}.meta.json + kb/${NAME}.sources.json`);
  console.log(`  next: node kb/forge-big.mjs both --dir kb --name ${NAME}   (embed → ${NAME}.big.rvf)`);
}

await main();
