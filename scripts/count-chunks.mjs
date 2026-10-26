#!/usr/bin/env node
// scripts/count-chunks.mjs — recount the REAL passage total across the local PUBLIC kb stores and
// restamp it onto every public surface that advertises it. Rule: no number beats a wrong number —
// the hand-typed "129,685 source chunks" rotted (SOURCE.json advertised a corpus that had moved on)
// and was pulled from every surface in v3.2.5. This script is how it comes back honestly: computed
// fresh from disk every time, never hand-typed again.
//
// NOTHING is duplicated here — neither the counting nor the restamping. Both live in
// claims-verify.mjs (`applyFix`), the same module whose `verifyChunkCountSurfaces` gates the result,
// and this file is a thin CLI over it. That is deliberate: a second writer with its own regexes is
// how four surfaces drift four ways in the first place. Private stores (kb/PRIVATE-STORES.json) are
// fenced out by the shared counter, so the public number can never include private content.
//
// A surface with NO existing "N chunks" claim (e.g. explainer/index.html before this was restored)
// is reported, not silently improvised into someone else's prose — the first stamp on a new surface
// is a deliberate one-time copy edit, done by hand once; after that this script keeps it fresh.
//
// Usage:  node scripts/count-chunks.mjs            # recount + write the fresh census into every surface
//         node scripts/count-chunks.mjs --check     # report only; exit 1 if any surface would change
//
// `npm run claims:fix` does this AND the coverage badge in one pass; prefer it. This entry point
// stays because the nightly brain rebuild wants the census restamped without touching coverage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFix } from './claims-verify.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const CHECK = process.argv.includes('--check');

async function main() {
  // summaryFile deliberately points nowhere: this entry point restamps the CENSUS only, and the
  // coverage half then reports itself as "not stamped" rather than silently doing half a job.
  const report = await applyFix({ write: !CHECK, summaryFile: path.join('/nonexistent', 'coverage-summary.json') });
  if (!report.census) {
    console.error('[count-chunks] no public kb stores found under kb/*.big.rvf.idmap.json — is the local brain built? Nothing to stamp.');
    process.exit(1);
  }
  const { chunks, publicStores, builtStores } = report.census;
  const want = chunks.toLocaleString('en-US');
  console.log(`[count-chunks] recounted ${want} chunks across ${publicStores} public stores of ${builtStores} built (private stores excluded per kb/PRIVATE-STORES.json)`);
  for (const n of report.notes) console.warn(`[count-chunks] ${n}`);

  const drifted = report.changed;
  if (CHECK && drifted.length) {
    for (const rel of drifted) console.error(`[count-chunks] DRIFT: ${rel} would restamp -> ${want}`);
    console.error(`\n[count-chunks] --check: ${drifted.length} surface(s) drifted`);
    process.exit(1);
  }
  for (const rel of drifted) console.log(`[count-chunks] ${rel}: restamped -> ${want}`);
  console.log(`\n[count-chunks] done — ${want} chunks is the live count; ${drifted.length} surface(s) rewritten.`);
}

if (isDirectInvocation(import.meta.url)) {
  await main();
}
