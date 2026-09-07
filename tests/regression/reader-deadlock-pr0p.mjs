#!/usr/bin/env node
// tests/regression/reader-deadlock-pr0p.mjs
//
// CONTRIBUTED BY Jan Lafko (@lafinak) in issue #29 — adopted verbatim (minus this header) as the
// project regression guard for the corrupted-cache futex_wait_queue deadlock his report found + fixed.
// His original: https://github.com/stuinfla/ruvnet-brain/issues/29 . Run it via the vitest wrapper
// tests/integration/reader-deadlock-regression.test.mjs, which spawns THIS as a child process under an
// OS-level timeout — because (Jan flagged this) the deadlock freezes Nodes event loop, so no in-process
// timer (Promise.race / setTimeout / vitests own per-test timeout) can ever fire; only an external kill works.
//
// regression-pr0p.mjs — minimal regression repro for issue #29 (the futex_wait_queue deadlock).
//
// WHAT IT PROVES: a corrupted (truncated) local model cache must never hang the reader on a
// second load attempt in the same process. Before the fix, a broken cache file threw quickly on
// the FIRST loadCE() call (never populating the module-level cache), then DEADLOCKED on the
// SECOND call to loadCE() in that same process. After the fix, the first call self-heals (wipes
// the corrupt copy, refetches, succeeds), so the second call just returns the cached instance.
//
// IMPORTANT: priming (making sure a model is cached) and testing (corrupt + call twice) MUST run
// in SEPARATE processes. If the same process both primes successfully and then corrupts the
// file, the in-memory `_ce` cache from the successful prime masks the corruption entirely and the
// test proves nothing — this script is split into `prime` and `test` subcommands specifically to
// avoid that trap.
//
// Invoked by the Vitest wrapper with --fixture-root, a copied --dir and disposable KB_MODEL_CACHE.
// Unscoped direct invocation is refused before importing the reader or touching model bytes.
//
// Exit 0 = passes. Exit 1 = FAILS — the deadlock reproduced.
//
// IMPORTANT — this MUST be run under an OS-level hard timeout, e.g.:
//   timeout 30s node regression-pr0p.mjs test --dir .
// The in-process HANG_BUDGET_MS/Promise.race guard below is NOT sufficient on its own: on the
// pre-fix code, the deadlock freezes Node's entire event loop (confirmed via /proc/<pid>/task/*/
// wchan — 27/28 threads parked in futex_wait_queue), so even a plain setTimeout callback never
// gets a chance to fire. Only an external process-level kill (the `timeout` command, a CI job
// timeout, a parent process's child.kill()) actually terminates it. If wiring this into vitest,
// don't rely on vitest's own per-test timeout for the SAME reason — spawn this file as a child
// process with execFileSync/spawnSync and a real OS timeout, and assert on the child's exit code.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The fixed path deliberately deletes a corrupt ~23MB model and re-fetches it. That is normally
// quick, but it is still a network transfer; 15s misclassified a slow registry/CDN response as the
// historical indefinite futex deadlock. Keep a finite in-process diagnostic deadline while leaving
// the authoritative OS-level guard in the Vitest parent comfortably outside it.
const HANG_BUDGET_MS = 60_000;
const CE_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const MODE = process.argv[2];
const KB_DIR = path.resolve(arg('--dir', '.'));
const FIXTURE_ROOT = arg('--fixture-root', null);

function fixturePath(candidate) {
  if (!FIXTURE_ROOT || !candidate) throw new Error('a disposable --fixture-root and KB_MODEL_CACHE are required');
  const root = fs.realpathSync(FIXTURE_ROOT);
  if (fs.readFileSync(path.join(root, '.reader-deadlock-fixture'), 'utf8') !== 'disposable\n') {
    throw new Error('not a disposable reader fixture');
  }
  const relative = path.relative(root, fs.realpathSync(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('reader corruption target must stay inside the disposable fixture');
  }
}

function requireScores(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !Number.isFinite(row.ceScore))) {
    throw new Error('expected finite cross-encoder scores; fallback is not a successful model load');
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`TIMED OUT after ${ms}ms — ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function findOnnx(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = findOnnx(p); if (found) return found; }
    else if (entry.name.endsWith('.onnx')) return p;
  }
  return null;
}

async function loadModules() {
  fixturePath(KB_DIR);
  fixturePath(process.env.KB_MODEL_CACHE);
  const rerankPath = path.join(KB_DIR, 'forge-rerank.mjs');
  if (!fs.existsSync(rerankPath)) {
    console.error(`Cannot find forge-rerank.mjs under ${KB_DIR} — pass --dir <kb-dir>.`);
    process.exit(2);
  }
  const { rerankPairs } = await import(pathToFileURL(rerankPath).href);
  const { loadTransformers } = await import(pathToFileURL(path.join(KB_DIR, 'resolve-deps.mjs')).href);
  return { rerankPairs, loadTransformers };
}

async function prime() {
  const { rerankPairs } = await loadModules();
  console.log('--- priming: ensure a CE model is cached locally (real network call if cold) ---');
  const rows = await rerankPairs('priming query', [{ fullText: 'priming passage', path: 'prime.md' }]);
  requireScores(rows);
  console.log(`primed OK. ceScore=${rows[0].ceScore}`);
}

async function test() {
  const { rerankPairs, loadTransformers } = await loadModules();
  const { modelCache } = await loadTransformers();
  fixturePath(modelCache);
  const ceRoot = path.join(modelCache, CE_MODEL);
  const onnxFile = fs.existsSync(ceRoot) ? findOnnx(ceRoot) : null;
  if (!onnxFile) {
    console.error(`No cached model found under ${ceRoot} — run 'prime' first.`);
    process.exit(2);
  }
  fixturePath(onnxFile);

  console.log(`--- corrupting ${onnxFile} on purpose (truncating to 20%, same damage a cut-off download leaves) ---`);
  const original = fs.readFileSync(onnxFile);
  fs.writeFileSync(onnxFile, original.subarray(0, Math.floor(original.length * 0.2)));

  const docs = [{ fullText: 'test passage one', path: 'a.md' }, { fullText: 'test passage two', path: 'b.md' }];
  let failed = false;
  try {
    console.log('--- call #1 (fresh process — never loaded successfully before now) ---');
    const r1 = await withTimeout(rerankPairs('regression query one', docs), HANG_BUDGET_MS, 'call #1');
    requireScores(r1);
    console.log(`call #1 OK, ceScore=${r1[0]?.ceScore}`);

    console.log('--- call #2 (THE REGRESSION CHECK: pre-fix, this deadlocks in futex_wait_queue) ---');
    const r2 = await withTimeout(rerankPairs('regression query two', docs), HANG_BUDGET_MS, 'call #2');
    requireScores(r2);
    console.log(`call #2 OK, ceScore=${r2[0]?.ceScore}`);

    console.log('\nPASS — both calls completed within budget. No deadlock.');
  } catch (e) {
    failed = true;
    console.error(`\nFAIL — ${e.message}`);
    console.error('This is the pr0p / issue #29 regression: a corrupted local cache deadlocked a repeat call.');
  }
  process.exit(failed ? 1 : 0);
}

if (MODE === 'prime') await prime();
else if (MODE === 'test') await test();
else { console.error('Usage: node regression-pr0p.mjs <prime|test> --fixture-root <disposable-root> --dir <copied-kb-dir>'); process.exit(2); }
