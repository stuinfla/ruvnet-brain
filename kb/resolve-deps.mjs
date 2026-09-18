// resolve-deps.mjs — portable resolver for the rvf-kb-forge KB scripts.
//
// Resolves the two runtime deps the KB needs in a machine-independent order:
//
//   @ruvector/rvf        -> RvfDatabase (the .rvf vector store)
//   @xenova/transformers -> the MiniLM embedder (Xenova/all-MiniLM-L6-v2, 384-dim)
//
// Resolution order (first hit wins) for EACH dep:
//   1. The KB output dir's own node_modules (so `cd <kb-dir> && npm i` just works).
//   2. node_modules walked up from this file.
//   3. An explicit env override   (RVF_MODULE_PATH / XENOVA_PATH).
//
// This file ships INSIDE the bundle, so it must not assume anything beyond Node 20.9+ and the
// two npm deps being installable via `npm i @ruvector/rvf @xenova/transformers`.

import { createRequire } from 'node:module';
import { assertSupportedNode } from './node-version.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const KB_DIR = path.dirname(__filename);

// require() rooted at THIS file — node walks up node_modules from the KB dir to the project
// root, so it finds deps installed either in <kb-dir>/node_modules or a parent node_modules.
const localRequire = createRequire(__filename);

function existsModuleDir(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/**
 * Resolve and return the @ruvector/rvf module ({ RvfDatabase, ... }).
 * Order: KB node_modules -> RVF_MODULE_PATH env -> Mac npm-global.
 */
export function loadRvf() {
  assertSupportedNode();
  // 1. project / KB node_modules (walked up from this file)
  try {
    return { mod: localRequire('@ruvector/rvf'), via: 'project node_modules' };
  } catch { /* fall through */ }

  // 2. explicit env override
  const envPath = process.env.RVF_MODULE_PATH;
  if (envPath && existsModuleDir(envPath)) {
    const base = envPath.endsWith('@ruvector/rvf') || envPath.endsWith('@ruvector/rvf/')
      ? envPath
      : path.join(envPath, '@ruvector/rvf');
    try {
      const req = createRequire(path.join(envPath, 'noop.js'));
      return { mod: req('@ruvector/rvf'), via: `RVF_MODULE_PATH (${envPath})` };
    } catch {
      try { return { mod: localRequire(base), via: `RVF_MODULE_PATH dir (${base})` }; } catch { /* fall through */ }
    }
  }

  throw new Error(
    "Cannot resolve '@ruvector/rvf'. Run `cd <kb-dir> && npm i` (or `npm i @ruvector/rvf` at the "
    + 'project root), or set RVF_MODULE_PATH to a node_modules dir that contains it.'
  );
}

/**
 * Close a database that was opened with RvfDatabase.openReadonly().
 *
 * @ruvector/rvf 0.3.4 currently calls saveMappings() even for readonly handles. On Windows that
 * write fails with FsyncFailed, after the backend has already released the native handle and
 * cleared its maps. A read operation must not be reported as failed solely because the SDK tried
 * to persist unchanged mappings during readonly close. Suppress only that exact upstream failure;
 * every other close error remains fatal.
 */
export async function closeReadonlyRvf(db) {
  if (!db) return;
  try {
    await db.close();
  } catch (error) {
    if (!/\bFsyncFailed\b/.test(String(error?.message || error))) throw error;
  }
}

/**
 * Network guard for the reader path (issue #27, reported by Jan Lafko): in a network-restricted
 * sandbox the cold-cache embedder pull opened 53 connections to an unreachable host and hung
 * FOREVER — no timeout, no error, a killed session. transformers.js fetches model files with the
 * global fetch, so this wraps globalThis.fetch ONCE (idempotent) with:
 *   • a hard per-attempt abort budget — RUVNET_BRAIN_FETCH_TIMEOUT_MS, default 120000. Generous on
 *     purpose: it must never kill a slow-but-real ~90MB model download, only convert "hangs
 *     forever" into "fails, loudly, in bounded time". Sandboxed environments can set it to 3000.
 *   • one bounded retry (2 attempts total), then
 *   • an HONEST error naming the exact unreachable host + the offline alternative (pre-seeded
 *     KB_MODEL_CACHE), never a silent hang.
 * Scope: only http(s) requests, only in processes that call loadTransformers() — the reader path.
 */
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.RUVNET_BRAIN_FETCH_TIMEOUT_MS || 120000));
const FETCH_ATTEMPTS = 2;
let _fetchGuarded = false;
export function guardNetwork() {
  if (_fetchGuarded || typeof globalThis.fetch !== 'function') return;
  _fetchGuarded = true;
  const rawFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!/^https?:/i.test(url)) return rawFetch(input, init);
    let lastErr;
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      // Honor a caller-provided signal alongside ours: abort when EITHER fires.
      const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), init.signal].filter(Boolean);
      const signal = signals.length > 1 && typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0];
      try {
        return await rawFetch(input, { ...init, signal });
      } catch (e) {
        lastErr = e;
        if (init.signal && init.signal.aborted) throw e; // the CALLER cancelled — not ours to retry
      }
    }
    const host = (() => { try { return new URL(url).host; } catch { return url.slice(0, 80); } })();
    throw new Error(
      `network unreachable: could not fetch from ${host} `
      + `(${FETCH_ATTEMPTS} attempts × ${Math.round(FETCH_TIMEOUT_MS / 1000)}s timeout; last: ${lastErr && lastErr.name || 'error'}). `
      + `This machine may be network-restricted (sandbox/devcontainer). The query-side embedder model is needed `
      + `once per machine: on a networked machine, run one query, then copy the model cache here and point `
      + `KB_MODEL_CACHE at it. Diagnose with: npx ruvnet-brain --doctor  (RUVNET_BRAIN_FETCH_TIMEOUT_MS tunes this timeout.)`
    );
  };
}

/**
 * Resolve and dynamically import @xenova/transformers.
 * Order: KB node_modules -> XENOVA_PATH env -> Mac build.
 * Returns { T, modelCache, via } where T is the imported module namespace.
 * Applies guardNetwork() — the reader path must fail loud, never hang (issue #27).
 */
export async function loadTransformers() {
  assertSupportedNode();
  guardNetwork();
  // 1. node_modules — resolve the package entry, import via file:// URL.
  try {
    const resolved = localRequire.resolve('@xenova/transformers');
    // pathToFileURL, NOT 'file://' + path. On Windows the concatenation yields
    // `file://C:\Users\...\transformers.js` — a malformed URL (backslashes, host = "C:") that Node
    // rejects, and the rejection is swallowed by the catch below, so the reader falls through and
    // reports "Cannot resolve '@xenova/transformers'" on a machine where it IS installed. Exactly
    // the class of bug this repo already fixed once for raw C:\ ESM specifiers.
    const T = await import(pathToFileURL(resolved).href);
    return { T, modelCache: chooseModelCache(), via: 'project node_modules' };
  } catch { /* fall through */ }

  // 2. explicit env override — may be a transformers.js file path or a package dir.
  const envPath = process.env.XENOVA_PATH;
  if (envPath) {
    // Same reason as above: a user-supplied XENOVA_PATH on Windows is `C:\...`, and concatenating it
    // onto 'file://' produces a URL Node cannot load.
    const url = envPath.startsWith('file://') ? envPath
      : envPath.endsWith('.js') ? pathToFileURL(path.resolve(envPath)).href
      : pathToFileURL(path.join(path.resolve(envPath), 'src/transformers.js')).href;
    try {
      const T = await import(url);
      return { T, modelCache: chooseModelCache(), via: `XENOVA_PATH (${envPath})` };
    } catch { /* fall through */ }
  }

  throw new Error(
    "Cannot resolve '@xenova/transformers'. Run `cd <kb-dir> && npm i` (or `npm i @xenova/transformers` "
    + 'at the project root), or set XENOVA_PATH to the transformers package dir / src/transformers.js.'
  );
}

/**
 * Pick the one model cache used by every Brain entry path. KB_MODEL_CACHE wins. An installed
 * bundle lives at <brain-home>/kb, while its MCP and installer warm <brain-home>/models, so reuse
 * that sibling when it contains either supported query embedder. A source checkout without that
 * installed layout retains the repo-local kb/models-cache fallback.
 */
export function chooseModelCache({ kbDir = KB_DIR, env = process.env } = {}) {
  if (env.KB_MODEL_CACHE) return env.KB_MODEL_CACHE;
  const sibling = path.join(path.dirname(kbDir), 'models');
  const supported = [
    path.join('Xenova', 'bge-base-en-v1.5'),
    path.join('Xenova', 'all-MiniLM-L6-v2'),
  ];
  if (supported.some((model) => fs.existsSync(path.join(sibling, model)))) return sibling;
  const kbLocal = path.join(kbDir, 'models-cache');
  return kbLocal; // remote download lands here on first run
}

/**
 * Configure a transformers namespace `T` for MiniLM: point at the cache, and allow
 * remote download ONLY when the model isn't already cached (offline-first).
 * Returns { modelCache, haveLocalModel }.
 */
export function configureModel(T, modelCache) {
  const haveLocalModel = fs.existsSync(path.join(modelCache, 'Xenova/all-MiniLM-L6-v2'));
  // localModelPath is where an already-present model is READ. cacheDir is where a remote model is
  // DOWNLOADED. Setting only the former made a successful warm write into transformers.js's own
  // node_modules/.cache while the battery inspected KB_MODEL_CACHE and correctly found it cold.
  T.env.localModelPath = modelCache;
  T.env.cacheDir = modelCache;
  T.env.allowRemoteModels = !haveLocalModel; // fresh machine -> download from HuggingFace
  return { modelCache, haveLocalModel };
}
