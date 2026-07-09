#!/usr/bin/env node
// forge-ask-all.mjs — ONE question → the best source-grounded answer across the ENTIRE RuvNet brain.
//
// The per-repo forge-ask.mjs answers about one repo. This wrapper makes the bundle behave like a
// single brain: it retrieves a candidate pool from EVERY repo (reusing the proven searchKb engine,
// which auto-selects each repo's sharp `big` variant when present), pools the candidates, then
// re-scores the whole pool with ONE cross-encoder pass (rerankPairs) so hits from different repos —
// and different embedders/dimensions — are ranked on a single common scale. Returns the globally
// best whole-document passages, each labeled with the repo it came from (so a consumer always knows
// WHICH part of RuvNet the answer is grounded in, and can cite repo + path).
//
//   node forge-ask-all.mjs --dir <bundle-dir> --q "how does RVF store vectors?" [--k 6] [--pool 8]
//   node forge-ask-all.mjs --dir . --repos ruflo,ruvector --q "..."        # restrict to some repos
//   import { searchAll } from './forge-ask-all.mjs'
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKb } from './forge-ask.mjs';
import { rerankPairs } from './forge-rerank.mjs';

// Discover the repos present in a bundle dir: every <repo>.rvf (the `.big.rvf` is the same repo's
// sharp variant, not a separate repo; idmap/embed/passages sidecars are not stores). Returns the
// unique base names, so searchKb can then pick big-vs-small per repo on its own.
export function discoverRepos(dir) {
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(.+?)(\.big)?\.rvf$/);
    if (!m) continue;                                  // not an rvf store
    if (/\.(idmap|embed)\b/.test(f)) continue;         // sidecar, not a store
    names.add(m[1]);
  }
  return [...names].sort();
}

// Query every repo, pool, rerank on a common scale, return global top-k labeled by repo.
export async function searchAll({ dir, query, k = 6, pool = 8, repos }) {
  const list = (repos && repos.length) ? repos : discoverRepos(dir);
  const perRepo = {};
  // Fan out across repos CONCURRENTLY instead of one-at-a-time — each searchKb() call is an
  // independent round-trip (its own embed + KB read + HNSW query), so 27 serial awaits were 27x the
  // necessary wall-clock. Each repo's error is still isolated to its own perRepo entry.
  const perRepoHits = await Promise.all(list.map(async (name) => {
    try {
      // The concepts store holds ALL repos' prose primers in one place, so it needs a deeper pool than a
      // single source repo — otherwise the queried repo's own primer is crowded out by the other 18 before
      // the cross-encoder ever scores it (the dilution that buried ruflo's primer and lost safla).
      const repoPool = name === 'concepts' ? Math.max(pool, 24) : pool;
      const hits = await searchKb({ dir, name, query, k: repoPool, n: repoPool });
      perRepo[name] = hits.length;
      return hits.map((h) => ({ ...h, repo: name }));
    } catch (e) {
      perRepo[name] = `ERR: ${e.message}`;
      return [];
    }
  }));
  const candidates = perRepoHits.flat();
  // ONE cross-encoder pass over the whole cross-repo pool → a single comparable relevance scale.
  const ranked = await rerankPairs(query, candidates);
  // Repo-name affinity: when the question explicitly NAMES a repo ("Does QuDAG…", "what can SAFLA do",
  // "can ruflo orchestrate…"), that repo should win ties/near-ties over a sibling that merely mentions it.
  // Capability questions almost always name their repo; without this the larger/prose-richer sibling wins
  // the tie (daa over qudag, dspy.ts over safla, agentic-flow over ruflo). A modest additive boost only
  // re-orders near-ties — it never lifts an unrelated repo, since non-named repos are untouched.
  // Word-boundary match on the repo name (not substring) so `fact` doesn't fire on "facts", while
  // multi-word names like `agent-harness-generator` still match. Boost clears a sibling that merely
  // *contains a file named after* the repo (e.g. dspy.ts/…/safla.ts) when the question names the repo.
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isNamed = (repo) => repo.length >= 4 && new RegExp(`\\b${esc(repo)}\\b`, 'i').test(query);
  const NAME_BOOST = 2.0;
  for (const r of ranked) {
    // A concepts hit is labelled repo="concepts" but its path is "<repo>/<kind>/<slug>" — attribute the
    // boost to the UNDERLYING repo so a named repo's PRIMER (which lives in the concepts store) counts too.
    const eff = (r.repo === 'concepts' && r.path) ? (r.path.split('/')[0] || r.repo) : r.repo;
    if (r.ceScore != null && isNamed(eff)) { r.ceScore += NAME_BOOST; r.nameBoosted = true; }
  }
  ranked.sort((a, b) => (b.ceScore ?? -Infinity) - (a.ceScore ?? -Infinity));
  return { repos: list, perRepo, results: ranked.slice(0, k), pooled: candidates.length };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  return {
    dir: get('--dir') || '.',
    query: get('--q') || get('--query'),
    k: parseInt(get('--k') || '6', 10),
    pool: parseInt(get('--pool') || '8', 10),
    repos: (get('--repos') || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

async function main() {
  const { dir, query, k, pool, repos } = parseArgs();
  if (!query) { console.error('Usage: node forge-ask-all.mjs --dir <bundle-dir> --q "question" [--k 6] [--pool 8] [--repos a,b]'); process.exit(2); }
  const { repos: used, perRepo, results, pooled } = await searchAll({ dir, query, k, pool, repos });
  console.log(`\n=== RuvNet Brain (cross-repo) — "${query}" ===`);
  console.log(`repos searched: ${used.join(', ')}  |  per-repo hits: ${JSON.stringify(perRepo)}  |  pooled candidates: ${pooled}\n`);
  results.forEach((r, i) => {
    console.log(`#${i + 1}  repo=${r.repo}  ce=${r.ceScore == null ? 'n/a' : r.ceScore.toFixed(3)}  vec=${r.bestDistance?.toFixed(4)}${r.kind ? `  kind=${r.kind}` : ''}${r.statusLabel ? `  [${r.statusLabel}]` : ''}`);
    console.log(`path : ${r.repo}/${r.path}`);
    console.log(`title: ${r.title}`);
    if (r.designIntentWarning) console.log(r.designIntentWarning);
    console.log(`chars: ${(r.fullText || '').length} | chunks: ${r.chunksJoined}${r.truncated ? ' (truncated)' : ''}`);
    console.log('----- full document -----');
    console.log(r.fullText || r.text || '');
    console.log('===================================================================\n');
  });
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
