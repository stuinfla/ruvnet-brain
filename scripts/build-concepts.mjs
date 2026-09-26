#!/usr/bin/env node
// build-concepts.mjs — thin CLI wrapper around the canonical concepts pipeline (Step 3, 2026-09-13).
//
// This used to be an INDEPENDENT concepts transformation with its own chunker, fence helpers, and
// card handling -- a real duplicate of corpus-aggregates.mjs's buildConceptAggregate. It now owns no
// chunking/fencing/card logic of its own: materializePublicInputs (scripts/public-inputs.mjs) does
// the ONE canonical public-prose selection (fencing private repos, resolving topic ownership), and
// buildConceptAggregate (scripts/corpus-aggregates.mjs) does the ONE canonical passage assembly --
// exactly the pattern Step 2 established for scripts/seal-gist-receipt.mjs as a thin wrapper over
// buildGistAggregate.
//
// Public prose is materialized into a throwaway temp directory first (never over the live kb/ in
// place, even though doing so would be safe -- see public-inputs.mjs's own header) so this tool's
// two responsibilities stay separated: SELECT (temp dir) then ASSEMBLE (writes into kb/ directly,
// matching this tool's historical behavior).
//
//   node scripts/build-concepts.mjs   → writes kb/concepts.passages.jsonl + kb/concepts.meta.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeSourceUniverse } from './source-coverage.mjs';
import { materializePublicInputs } from './public-inputs.mjs';
import { buildConceptAggregate } from './corpus-aggregates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KB = path.join(ROOT, 'kb');

export async function main() {
  const observation = observeSourceUniverse({ owner: 'ruvnet', externalSources: [] });
  const publicInputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-concepts-public-inputs-'));
  try {
    const publicInputs = materializePublicInputs({ builderRoot: ROOT, outDir: publicInputDir });
    const result = buildConceptAggregate({
      publicInputDir,
      selectionReceipt: publicInputs.selectionReceipt,
      observationSha256: observation.observationSha256,
      outDir: KB,
    });
    console.log(`concepts: ${result.passages} passages → kb/concepts.passages.jsonl`);
    console.log('next: node kb/forge-big.mjs both --dir kb --name concepts   (builds concepts.big.rvf)');
  } finally {
    fs.rmSync(publicInputDir, { recursive: true, force: true });
  }
}

if (((() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })())) {
  main().catch((error) => {
    console.error(`[build-concepts] ${error.message}`);
    process.exitCode = 1;
  });
}
