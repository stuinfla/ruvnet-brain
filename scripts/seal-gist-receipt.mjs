#!/usr/bin/env node
// Seals a complete, current ruv-gists.sources.json (schema 3) covering every gist rUv has
// published, embeds the corresponding ruv-gists RVF, and validates the whole result -- using ONLY
// the repo's single canonical gist pipeline: observeSourceUniverse (source-coverage.mjs, fresh live
// listing) -> buildGistAggregate (gist-receipts.mjs, capture + render + embed + seal + validate,
// atomically). There is no independent binding step any more: a receipt can never be sealed with
// passagesSha256:null, because buildGistAggregate renders and hashes the passage bytes in the same
// call that seals the receipt.
//
//   node scripts/seal-gist-receipt.mjs [--assets kb] [--policy kb] [--owner ruvnet]
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { observeSourceUniverse } from './source-coverage.mjs';
import { buildGistAggregate } from './gist-receipts.mjs';

export const REPO_KB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kb');

export function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

// MUST mirror source-coverage.mjs main()'s OWN policyDir resolution exactly (see there:
// `policyDir = assetsIndex >= 0 ? kbDir : path.join(ROOT, 'kb')`) -- policy (external-sources.json,
// no-corpus-repos.json) is NOT the same directory as assets whenever assets points somewhere other
// than the repo's own kb/ (e.g. the live installed ~/.cache/ruvnet-brain/kb). The sealed receipt's
// sourceObservationSha256 is compared byte-for-byte against whatever buildCoverage computes later,
// and a policy-dir mismatch silently changes the REPOSITORY half of that combined hash (gists are
// fine) so every gist reads FAILED with "observation differs from coverage" even though nothing
// about the gists themselves is wrong. Found live 2026-09-12: assetsDir was the install cache,
// which has no external-sources.json of its own, so this file's old default (policy==assets) fell
// back to an empty external list -- 218 repos instead of buildCoverage's real 228. Default policy
// to the repo's kb/ (source-coverage.mjs's own default), never to assetsDir.
export function resolvePolicyDir(argv, repoKb = REPO_KB) {
  return arg(argv, '--policy', repoKb);
}

async function main(argv = process.argv.slice(2)) {
  const assetsDir = arg(argv, '--assets', 'kb');
  const owner = arg(argv, '--owner', 'ruvnet');
  const policyDir = resolvePolicyDir(argv);
  const externalPath = path.join(path.resolve(policyDir), 'external-sources.json');
  const externalSources = fs.existsSync(externalPath)
    ? JSON.parse(fs.readFileSync(externalPath, 'utf8')).sources : [];
  const observation = observeSourceUniverse({ owner, externalSources });
  console.log(`live gists observed: ${observation.gists.rows.length}`);
  const result = await buildGistAggregate({ observation, outDir: assetsDir });
  if (result.omitted) {
    console.log(`[seal-gist-receipt] @${owner} currently has zero public gists -- aggregate omitted, nothing sealed.`);
    return 0;
  }
  console.log(`sealed gist count: ${Object.keys(result.sourceReceipt.gists).length}`);
  console.log(`passagesSha256: ${result.sourceReceipt.passagesSha256}`);
  console.log(`receiptSha256: ${result.sourceReceipt.receiptSha256}`);
  console.log(`reused ${result.reuseEvidence.reused.length} cached, fetched ${result.reuseEvidence.fetched.length} fresh gist(s)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`[seal-gist-receipt] ${error.message}`);
    process.exitCode = 1;
  });
}
