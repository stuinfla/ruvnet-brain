#!/usr/bin/env node
// warm-model-cache.mjs -- load the pinned BGE embedder ONCE, serially, before any concurrent
// forge-refresh worker needs it.
//
// WHY. forge-refresh workers run side by side (corpus-reconcile concurrency 5). On a cold runner
// the first worker to need the model starts a download that creates <cache>/<model>/ before its
// files exist; a second worker that treats "the folder exists" as "the model is cached" forbids
// remote loading and dies on a missing tokenizer.json (2026-11-06: agentdb, carried STALE). Two
// workers that both see "not ready" would instead download the same files at once. Warming the
// cache here, before any worker starts, removes both: every worker then sees a complete cache.
//
// Readiness is the file set the offline reader loads (modelCacheReady), never the folder alone.
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';
import { chooseModelCache, loadTransformers } from './resolve-deps.mjs';
import {
  BGE_MODEL, configureTransformersModel, materializeModelRevision, modelCacheReady,
} from './model-requirements.mjs';

// Must equal the BGE pin in forge-refresh.mjs / forge-big.mjs (a unit test pins all three).
export const WARM_MODEL = BGE_MODEL;
export const WARM_REVISION = '4d6cd88e18e51a5e020c2c305726d76ada9c03cf';

/**
 * Load the pinned embedder through the ONE readiness-gated path every caller shares. Readiness is the
 * file set, so a half-created folder never forbids the download this caller needs; the pinned revision
 * is promoted to the canonical offline location before and after, under the materialize lock.
 */
export async function loadEmbedderPipeline(T, cache, { model = WARM_MODEL, revision = WARM_REVISION } = {}) {
  materializeModelRevision(cache, model, revision);
  configureTransformersModel(T, cache, model);
  const pipeline = await T.pipeline('feature-extraction', model, { quantized: true, revision });
  materializeModelRevision(cache, model, revision);
  return pipeline;
}

export async function warmModelCache({
  cache = chooseModelCache(),
  loadT = loadTransformers,
  log = (line) => console.log(line),
} = {}) {
  materializeModelRevision(cache, WARM_MODEL, WARM_REVISION);
  if (modelCacheReady(cache, WARM_MODEL)) {
    log(`[warm-model] ${WARM_MODEL} already complete in ${cache}`);
    return { cache, downloaded: false };
  }
  const { T } = await loadT();
  await loadEmbedderPipeline(T, cache);
  if (!modelCacheReady(cache, WARM_MODEL)) {
    throw new Error(`[warm-model] ${WARM_MODEL}@${WARM_REVISION} still incomplete in ${cache} after loading`);
  }
  log(`[warm-model] ${WARM_MODEL}@${WARM_REVISION} downloaded and complete in ${cache}`);
  return { cache, downloaded: true };
}

if (isDirectInvocation(import.meta.url)) {
  warmModelCache().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
