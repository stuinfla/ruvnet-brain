/**
 * org-repo-count.mjs — how many repos rUv actually has, DERIVED, with the source recorded.
 *
 * THE DEFECT THIS REPLACES. `orgTotalApprox: 248` was a literal, written twice:
 *
 *     scripts/build-bundle.mjs:402   coverage: { …, orgTotalApprox: 248, … }
 *     scripts/brain-stamp.mjs:77     coverage: { …, orgTotalApprox: 248, … }
 *
 * Measured 2026-08-12, two independent ways: `users/ruvnet.public_repos` = 200, and a paginated
 * `users/ruvnet/repos` fetch = 200 distinct names. So the denominator every coverage percentage in
 * this product is computed against was wrong by 48 — and wrong in BOTH copies, which is what a
 * restated fact always does.
 *
 * Replacing 248 with 200 would repeat the mistake with a fresher number. The count changes whenever
 * rUv pushes a new repo, so it is not a constant and must not be stored as one.
 *
 * HONESTY OVER AVAILABILITY. A build with no network must not silently invent a total. `source` is
 * carried alongside the number so every consumer can see whether it is live:
 *
 *     { count: 200, source: 'live',     at: '2026-08-12T…' }   ← queried just now
 *     { count: 200, source: 'recorded', at: '2026-08-12T…' }   ← last live reading, reused offline
 *     { count: null, source: 'unknown', at: null }             ← never say a number we cannot source
 *
 * A consumer that receives `unknown` must omit the claim rather than print a guess — the same rule
 * sync-census follows when it refuses to write a non-positive census.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** The last LIVE reading, so an offline build reuses a real measurement instead of a literal. */
export const RECORD_PATH = process.env.RUVNET_ORG_COUNT_RECORD
  || path.join(ROOT, 'data', 'org-repo-count.json');

export const OWNER = process.env.RUVNET_ORG_OWNER || 'ruvnet';

/** Ask GitHub. Returns a positive integer or null — never a guess, never a partial page. */
export function fetchLiveCount(owner = OWNER, { run = spawnSync } = {}) {
  // `public_repos` is the account's own count: one request, no pagination to get wrong.
  const r = run('gh', ['api', `users/${owner}`, '--jq', '.public_repos'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error || r.status !== 0) return null;
  const n = Number(String(r.stdout || '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

const readRecord = (file) => {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(j?.count) && j.count > 0 ? j : null;
  } catch { return null; }
};

/**
 * The count, its provenance, and when it was taken.
 * A successful live read updates the record, so the offline fallback is always a real past reading.
 */
/**
 * READING A NUMBER MUST NOT MUTATE A TRACKED FILE.
 *
 * `persist` defaults to FALSE, and that default is the fix for a release that could not ship.
 * Every call used to write `data/org-repo-count.json` — a TRACKED file — with a fresh `at`
 * timestamp. Both production callers (`brain-stamp.mjs`, `build-bundle.mjs`) are BUILD scripts, so
 * building the release candidate dirtied the working tree, and `release-qe`'s stabilization seal
 * requires `dirty === false`. Measured 2026-08-19, once the seal was made to name its cause:
 *
 *     stabilization seal failed: INVALID_LINEAGE
 *       working tree is dirty (1 path(s)):
 *         M data/org-repo-count.json
 *
 * That single line had blocked EVERY release since 2026-08-08 (issue #141: nothing published in
 * eleven days while main advanced 46 commits), because the seal previously reported only the code
 * `INVALID_LINEAGE` and named nothing.
 *
 * The committed record still matters — it is the honest offline fallback, so an air-gapped or
 * rate-limited build reuses the last REAL reading instead of inventing one. It just may not be
 * written as a side effect of being read. Refreshing it is now a deliberate act (`--record`), the
 * same separation `refresh-model-catalog.mjs` already uses for the model snapshot.
 */
export function orgRepoCount({ owner = OWNER, file = RECORD_PATH, now = new Date(), fetch = fetchLiveCount, persist = false } = {}) {
  const live = fetch(owner);
  if (live) {
    const at = now.toISOString();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (persist) fs.writeFileSync(file, `${JSON.stringify({ owner, count: live, at }, null, 2)}\n`);
    } catch { /* recording is best-effort; the live number still stands */ }
    return { count: live, source: 'live', at };
  }
  const rec = readRecord(file);
  if (rec) return { count: rec.count, source: 'recorded', at: rec.at || null };
  return { count: null, source: 'unknown', at: null };
}

/**
 * Refreshing the committed record is a DELIBERATE ACT, never a side effect of a build.
 *
 *     node scripts/org-repo-count.mjs --record
 *
 * Same separation `refresh-model-catalog.mjs` uses for the model snapshot: a build READS, a human
 * (or a scheduled refresh that commits its own result) WRITES. That boundary is what keeps the
 * working tree clean for `release-qe`'s stabilization seal.
 */
const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const record = process.argv.includes('--record');
  const r = orgRepoCount({ persist: record });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  if (record && r.source !== 'live') {
    process.stderr.write('NOT recorded: the live read failed, and a remembered number may not be '
      + 'rewritten as if it were fresh.\n');
    process.exit(1);
  }
}
