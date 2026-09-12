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
import fs from 'node:fs';
import path from 'node:path';
import { observeSourceUniverse } from './source-coverage.mjs';
import { materializeGistReceipts } from './corpus-reconcile.mjs';
import { bindPassagesSha256, validateGistReceiptSet } from './gist-receipts.mjs';
import { sha256File } from '../plugin/scripts/coverage-integrity.mjs';

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

async function main(argv = process.argv.slice(2)) {
  const assetsDir = arg(argv, '--assets', 'kb');
  const owner = arg(argv, '--owner', 'ruvnet');
  // MUST mirror source-coverage.mjs buildCoverage()'s own observation construction exactly (same
  // owner, same external-sources.json, same policyDir==assetsDir convention) — the sealed receipt's
  // sourceObservationSha256 is compared byte-for-byte against whatever buildCoverage computes later,
  // and any difference (e.g. omitting externalSources here) makes validateGistAggregateReceipt throw
  // "observation differs from coverage" even though every gist itself is correctly fetched and sealed.
  // Found 2026-09-12: the receipt this file previously sealed omitted externalSources entirely.
  const externalPath = path.join(path.resolve(assetsDir), 'external-sources.json');
  const externalSources = fs.existsSync(externalPath)
    ? JSON.parse(fs.readFileSync(externalPath, 'utf8')).sources : [];
  const observation = observeSourceUniverse({ owner, externalSources });
  console.log(`live gists observed: ${observation.gists.rows.length}`);
  const { sourceFile, receipt: unbound } = await materializeGistReceipts({ observation, assetsDir });
  // materializeGistReceipts seals with passagesSha256:null (see gist-receipts.mjs's header on
  // reconcileGistReceipts) — that's a real, valid gap: the receipt is built from per-gist GitHub
  // content, before kb/ruv-gists.passages.jsonl (built by a separate embedding step) is known to be
  // stable. Bind it here, now that both exist, so classifyGist's passagesBound check actually passes
  // instead of every gist reading FAILED with a complete-but-unbound receipt (found 2026-09-12).
  const passagesFile = path.join(path.resolve(assetsDir), 'ruv-gists.passages.jsonl');
  if (!fs.existsSync(passagesFile)) {
    console.error(`[seal-gist-receipt] ${passagesFile} does not exist — cannot bind; receipt written UNBOUND (passagesSha256:null).`);
    return 1;
  }
  const passagesSha256 = sha256File(passagesFile);
  const receipt = bindPassagesSha256(unbound, passagesSha256);
  validateGistReceiptSet(receipt, observation); // fail loud rather than write a receipt that can't validate
  fs.writeFileSync(sourceFile, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote: ${path.relative(process.cwd(), sourceFile)}`);
  console.log(`sealed gist count: ${Object.keys(receipt.gists).length}`);
  console.log(`passagesSha256: ${receipt.passagesSha256} (bound to ${path.relative(process.cwd(), passagesFile)})`);
  console.log(`receiptSha256: ${receipt.receiptSha256}`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`[seal-gist-receipt] ${error.message}`);
  process.exitCode = 1;
});
