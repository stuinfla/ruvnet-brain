#!/usr/bin/env node
/**
 * restore-local-ingests.mjs — replay every ingest a bundle apply silently removed.
 *
 * WHAT HAPPENED, overnight 2026-08-13 → 08-14. A scheduled bundle apply extracted an Aug-8 bundle
 * over the live brain cache. The outcome for each piece of the previous evening's work was decided
 * entirely by whether it had been committed:
 *
 *   SURVIVED  capability-cards.md — 5 hand-written cards, committed and pushed that night. The live
 *             brain was restored from the repo copy in one command.
 *   DIED      helix, rvQR, RuCelium, wifi-veil — ingested and VERIFIED ROUTING hours earlier, gone
 *             without a trace. Their cards became orphans pointing at stores that no longer existed,
 *             which is worse than absence: the router offers an answer whose source is missing.
 *
 * The owner, correctly and for the second time: "you can't ever let work go overnight — you must
 * always push latest changes or things get overwritten."
 *
 * A `.rvf` is a 32MB gitignored build artifact and CANNOT be committed. So the rule's second half
 * applies: when the artifact cannot be pushed, commit the RECIPE. `ingest-repo.mjs` now records each
 * ingest into `kb/local-ingests.json`, and this replays anything the cache is missing.
 *
 * The wipe was not on either adversarial audit's list, because both read code and this only shows
 * up if you watch the machine overnight. A defect that needs a night to appear needs a ledger to be
 * seen at all.
 *
 * MEASURED 2026-08-19, Dream Cycle memory-durability night: this script cannot tell "the store root
 * was wiped" from "the store root never existed on this host" — a fresh checkout, a CI runner, or
 * this very nightly agent's own ephemeral container all read exactly one recorded ingest away from
 * every other, i.e. IDENTICALLY to a real overnight wipe, because `missingIngests()` only diffs the
 * ledger against `storesAt(root)`, and `storesAt()` silently returns `[]` on ENOENT (kb/store-root.mjs).
 * `restore-local-ingests.mjs` had zero test coverage before tonight, and the repo's own dream-cycle
 * operating notes told this very automation to read ANY non-zero exit as "the nightly bundle wiped
 * local work" — so a routine fresh-checkout run would have logged a false wipe every single night.
 *
 * The fix follows the pattern this repo already uses correctly in `nightly-watchdog.mjs`
 * (MISSING / NEVER-RAN / STALE, three states never collapsed into one alarm) and the general
 * pattern for reconciling a durable recipe against a rebuildable cache (npm's `.package-lock.json`
 * witness co-located with `node_modules`, Dynamo-style tombstones): check whether the root was ever
 * initialized BEFORE treating its contents as evidence of loss.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storeRoot, storesAt, rootNeverMaterialized } from '../kb/store-root.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER = path.join(ROOT, 'kb', 'local-ingests.json');

export const OK = 'OK';
export const NEVER_MATERIALIZED = 'NEVER-MATERIALIZED';
export const WIPED = 'WIPED';

/** Which recorded ingests are absent from the store root retrieval actually reads. */
export function missingIngests({ ledgerFile = LEDGER, root = storeRoot() } = {}) {
  let recorded = [];
  try { recorded = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).ingests ?? []; } catch { return []; }
  const present = new Set(storesAt(root));
  return recorded.filter((e) => !present.has(e.store ?? e.name.toLowerCase()));
}

/**
 * Classify a diff between the recipe ledger and the live store root into three states, never one:
 *   OK                 every recorded ingest is present.
 *   NEVER-MATERIALIZED root does not exist on this host at all — nothing was ever ingested here.
 *                       Not evidence of loss: a fresh checkout, CI runner, or this agent's own
 *                       ephemeral container all look like this on a routine first run.
 *   WIPED               root exists (so this host DID ingest before) but recorded entries are gone —
 *                       the actual signal `restore-local-ingests.mjs` exists to catch.
 */
export function classify({ ledgerFile = LEDGER, root = storeRoot() } = {}) {
  const missing = missingIngests({ ledgerFile, root });
  if (!missing.length) return { state: OK, missing };
  if (rootNeverMaterialized(root)) return { state: NEVER_MATERIALIZED, missing };
  return { state: WIPED, missing };
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const apply = process.argv.includes('--apply');
  const { state, missing: gone } = classify();
  if (state === OK) {
    console.log(`[restore] every recorded local ingest is present in ${storeRoot()}`);
    process.exit(0);
  }
  // NAMED, never counted. "4 stores missing" is the truncation that reads as completeness.
  if (state === NEVER_MATERIALIZED) {
    console.log(`\n[restore] ${storeRoot()} does not exist on this host — ${gone.length} recorded `
      + `ingest(s) were never materialized here. This is NOT evidence of a wipe (fresh checkout, CI `
      + `runner, or an ephemeral agent container all look like this):`);
  } else {
    console.log(`\n[restore] ${gone.length} recorded ingest(s) are NOT in ${storeRoot()}:`);
  }
  for (const e of gone) console.log(`    ${e.name.padEnd(16)} ingested ${String(e.at).slice(0, 10)}`);
  if (!apply) {
    console.log('\n  read-only. Re-run with --apply to re-ingest them.\n');
    // NEVER-MATERIALIZED exits 2 (informational: nothing to restore FROM, just re-ingest) so a
    // caller checking the exit code cannot mistake "never synced here" for "the nightly bundle
    // wiped local work" — WIPED keeps exit 1, the real alarm.
    process.exit(state === NEVER_MATERIALIZED ? 2 : 1);
  }
  let failed = 0;
  for (const e of gone) {
    console.log(`\n[restore] re-ingesting ${e.name}`);
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ingest-repo.mjs'), '--name', e.name],
        { cwd: ROOT, stdio: 'inherit', env: process.env });
    } catch { failed += 1; console.log(`[restore] ${e.name} FAILED — left recorded so the next run retries it`); }
  }
  console.log(`\n[restore] ${gone.length - failed}/${gone.length} restored.\n`);
  process.exit(failed ? 1 : 0);
}
