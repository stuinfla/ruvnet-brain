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
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { storeRoot, storesAt } from '../kb/store-root.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER = path.join(ROOT, 'kb', 'local-ingests.json');

/** Which recorded ingests are absent from the store root retrieval actually reads. */
export function missingIngests({ ledgerFile = LEDGER, root = storeRoot() } = {}) {
  let recorded = [];
  try { recorded = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).ingests ?? []; } catch { return []; }
  const present = new Set(storesAt(root));
  return recorded.filter((e) => !present.has(e.store ?? e.name.toLowerCase()));
}

const isMain = (() => {
  try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isMain) {
  const apply = process.argv.includes('--apply');
  const gone = missingIngests();
  if (!gone.length) {
    console.log(`[restore] every recorded local ingest is present in ${storeRoot()}`);
    process.exit(0);
  }
  // NAMED, never counted. "4 stores missing" is the truncation that reads as completeness.
  console.log(`\n[restore] ${gone.length} recorded ingest(s) are NOT in ${storeRoot()}:`);
  for (const e of gone) console.log(`    ${e.name.padEnd(16)} ingested ${String(e.at).slice(0, 10)}`);
  if (!apply) {
    console.log('\n  read-only. Re-run with --apply to re-ingest them.\n');
    process.exit(1); // a non-zero exit so a nightly job can SEE the gap rather than log past it
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
