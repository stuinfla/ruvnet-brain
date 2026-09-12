#!/usr/bin/env node
// Seals a complete, current ruv-gists.sources.json (schema 3) covering every gist rUv has
// published, using ONLY the repo's existing, tested production functions:
//   observeSourceUniverse (source-coverage.mjs) -- fresh live gist listing
//   materializeGistReceipts (corpus-reconcile.mjs) -> reconcileGistReceipts (gist-receipts.mjs)
//     -- per-gist fetch + seal, reusing any receipt that is still exactly current
// This closes the gap found 2026-09-12: the sealed receipt was pinned at 479 gists from
// 2026-08-26 while the live org had grown to 492; release-projection.mjs correctly refused to
// stamp the 13 unsealed gists CURRENT. Running this and committing the result is the fix --
// there is no other tool that reseals this file for a full live gist set.
//
//   node scripts/seal-gist-receipt.mjs [--assets kb] [--owner ruvnet]
import path from 'node:path';
import { observeSourceUniverse } from './source-coverage.mjs';
import { materializeGistReceipts } from './corpus-reconcile.mjs';

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const assetsDir = arg(argv, '--assets', 'kb');
  const owner = arg(argv, '--owner', 'ruvnet');
  const observation = observeSourceUniverse({ owner });
  console.log(`live gists observed: ${observation.gists.rows.length}`);
  const { sourceFile, receipt } = await materializeGistReceipts({ observation, assetsDir });
  console.log(`wrote: ${path.relative(process.cwd(), sourceFile)}`);
  console.log(`sealed gist count: ${Object.keys(receipt.gists).length}`);
  console.log(`receiptSha256: ${receipt.receiptSha256}`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[seal-gist-receipt] ${error.message}`);
  process.exitCode = 1;
});
