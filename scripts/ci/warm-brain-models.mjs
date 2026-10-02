#!/usr/bin/env node
// scripts/ci/warm-brain-models.mjs — download every embedder the Brain at $RUVNET_BRAIN_KB requires into
// $KB_MODEL_CACHE, resolving @xenova/transformers from that Brain's own node_modules (the reader that
// will run). Used by ci.yml's warm-brain job (seed corpus) and release-qe's capability battery (the
// exact assembled candidate), so both warm the cache the same way.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requiredEmbedderModels } from '../../plugin/test/model-cache.mjs';

async function main() {
  const modelCache = process.env.KB_MODEL_CACHE;
  const kb = process.env.RUVNET_BRAIN_KB;
  if (!modelCache || !kb) throw new Error('RUVNET_BRAIN_KB and KB_MODEL_CACHE are required');
  fs.mkdirSync(modelCache, { recursive: true });
  const requireFromKb = createRequire(path.join(kb, 'package.json'));
  const T = await import(pathToFileURL(requireFromKb.resolve('@xenova/transformers')).href);
  T.env.localModelPath = modelCache;
  T.env.cacheDir = modelCache;
  T.env.allowRemoteModels = true;
  for (const model of requiredEmbedderModels(kb)) {
    await T.pipeline('feature-extraction', model, { quantized: true });
    console.log(`[warm-brain-models] ${model}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
