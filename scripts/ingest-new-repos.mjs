#!/usr/bin/env node
/**
 * ingest-new-repos.mjs — load what rUv shipped, without being asked.
 *
 * THE GAP THIS CLOSES, and it is embarrassing rather than subtle. The owner asked on 2026-08-20
 * why `ruvnet/ultrasonic` was not in the brain: *"aren't you loading everything Ruv creates every
 * day?????"* The honest answer was no, and nothing ever had. `nightly-wrapper.sh` refreshed
 * lessons, health, the release watchdog and the replay proof — and contained ZERO references to
 * ingestion. New rUv repos only ever entered the brain when a human typed `ingest-repo.mjs` by
 * hand, so the corpus drifted behind the org silently and the only symptom was a question the
 * brain could not answer.
 *
 * `brain-stamp.mjs` already COMPUTES built-vs-pending every night. Nothing acted on it. Measuring
 * a gap and never closing it is how 137 repos stayed uningested while the scorecard reported the
 * number cheerfully.
 *
 * WHY IT IS BOUNDED. Ingestion embeds a whole repository; doing 137 in one night would run for
 * hours and starve everything after it in the nightly. `--max` (default 3) keeps the nightly
 * bounded and lets the corpus converge over days instead of blocking on one enormous run. That is
 * a deliberate trade, and the run SAYS how many remain rather than implying it finished.
 *
 * WHAT IT WILL NOT DO. It does not write capability cards. An ingested store with no card is DARK —
 * valid bytes that no by-description query can reach — and `ingest-repo.mjs` already says so on
 * every run. Inventing a card from a repo name would put a confident description in the routing
 * layer that nobody grounded in the source, which is worse than an honest gap: it would route real
 * questions to a corpus that cannot answer them. So this reports the dark stores it created and
 * leaves the card to someone who reads the repo.
 *
 *   node scripts/ingest-new-repos.mjs                 # report only
 *   node scripts/ingest-new-repos.mjs --apply         # ingest up to --max new repos
 *   node scripts/ingest-new-repos.mjs --apply --max 5
 */
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeRoot, storesAt, darkStores } from '../kb/store-root.mjs';
import { assertIsolatedMutationWorktree } from './worktree-integrity.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OWNER = process.env.RUVNET_ORG_OWNER || 'ruvnet';
const APPLY = process.argv.includes('--apply');
const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const MAX = Number(arg('--max', '3'));

/** Every repo the org actually has right now. Live, never a remembered list. */
function liveOrgRepos() {
  try {
    const out = execFileSync('gh', [
      'repo', 'list', OWNER, '--limit', '500', '--no-archived', '--json', 'name,isFork,pushedAt,diskUsage',
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    return JSON.parse(out)
      .filter((r) => !r.isFork)
      // AN EMPTY REPO IS NOT A FAILURE TO RETRY FOREVER (measured 2026-08-20).
      //
      // The first bulk run reported 7 failures; six of them are size=0KB — genuinely empty
      // repositories (socket, Auto-GPT, CodeGPT, ruvGPT2, rUvGPT, AIConverse). `git fetch` succeeds
      // and there is simply nothing to embed, so ingestion fails correctly and then the repo stays
      // "missing", so the NEXT night retries it, forever. A permanent nightly failure that is
      // actually correct behaviour trains the reader to ignore the failure line — which is how a
      // real failure would then hide inside it.
      .filter((r) => Number(r.diskUsage ?? 1) > 0)
      // Newest first: if the budget only allows a few tonight, spend it on what rUv shipped most
      // recently, which is what a question is most likely to be about.
      .sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)))
      .map((r) => r.name);
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

export function pendingRepos(orgRepos, root = storeRoot()) {
  const have = new Set(storesAt(root).map((s) => String(s).toLowerCase()));
  return orgRepos.filter((name) => !have.has(String(name).toLowerCase()));
}

const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  if (APPLY) {
    try { assertIsolatedMutationWorktree(ROOT, 'ingest-new-repos --apply'); }
    catch (error) { console.error(error?.message || String(error)); process.exit(2); }
  }
  const repos = liveOrgRepos();
  if (!Array.isArray(repos)) {
    // A LIST WE COULD NOT FETCH IS NOT AN EMPTY LIST. Reporting "0 new repos" here would read as
    // "the brain is current" when the truth is "I could not look" — the exact conflation this
    // repository keeps paying for.
    console.error(`[ingest-new] could NOT list ${OWNER}'s repos: ${repos.error}`);
    console.error('[ingest-new] this is NOT "nothing new" — it is "I could not look". Exiting 1.');
    process.exit(1);
  }

  const root = storeRoot();
  const missing = pendingRepos(repos, root);
  console.log(`[ingest-new] ${OWNER}: ${repos.length} live repos, ${storesAt(root).length} ingested, ${missing.length} missing`);
  if (!missing.length) { console.log('[ingest-new] corpus is level with the org.'); process.exit(0); }

  console.log(`[ingest-new] next up (newest first): ${missing.slice(0, MAX).join(', ')}`);
  if (!APPLY) {
    console.log(`[ingest-new] report only. Re-run with --apply to ingest up to ${MAX}.`);
    process.exit(0);
  }

  let done = 0; let failed = 0;
  for (const name of missing.slice(0, MAX)) {
    console.log(`\n[ingest-new] ingesting ${name}`);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ingest-repo.mjs'), '--name', name],
      { cwd: ROOT, stdio: 'inherit', env: process.env, timeout: 45 * 60_000 });
    if (r.status === 0) done += 1;
    else { failed += 1; console.log(`[ingest-new] ${name} FAILED — left missing so the next run retries it`); }
  }

  const stillMissing = missing.length - done;
  const dark = darkStores(root);
  console.log(`\n[ingest-new] ingested ${done}, failed ${failed}, ${stillMissing} still missing.`);
  if (dark.length) {
    console.log(`[ingest-new] ${dark.length} store(s) are DARK — valid bytes no by-description query can reach.`);
    console.log('[ingest-new] a card is a claim about what a repo is FOR; write it from the source, not the name.');
  }
  process.exit(failed ? 1 : 0);
}
