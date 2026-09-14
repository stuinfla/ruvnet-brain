/**
 * Regression guard for issue #32 (Jan Lafko / @lafinak, 2026-07-20).
 *
 * Twice now, a new module was imported by a bundled reader but never added to
 * build-bundle.mjs's hand-maintained `tools` array, shipping a release zip that
 * died on startup with MODULE_NOT_FOUND before it could answer anything:
 *
 *   1. forge-guard-injection.mjs  (guarded afterwards only by a code comment)
 *   2. forge-hybrid.mjs           (#32 — the comment did not help, as comments cannot
 *                                  know what a file imports)
 *
 * build-bundle.mjs now DERIVES the list by walking the real static import graph.
 * These tests hold that property: if a reader gains an import, it must resolve
 * inside kb/ — because kb/ is all the installed bundle has.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KB = path.join(ROOT, 'kb');

// Must match build-bundle.mjs's ENTRYPOINTS. Anything runnable from an install.
const ENTRYPOINTS = [
  'forge-ask.mjs', 'forge-ask-all.mjs', 'forge-mcp.mjs', 'forge-mcp-all.mjs',
  'forge-rerank.mjs', 'forge-guard.mjs', 'forge-update.mjs', 'verify-citation.mjs',
];

function localImportsOf(absFile) {
  const src = fs.readFileSync(absFile, 'utf8');
  const specs = new Set();
  for (const m of src.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  return [...specs].filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/** Walk the graph, collecting modules and any problems rather than throwing on the first. */
function walk() {
  const seen = new Set();
  const missing = [];
  const escapes = [];
  const queue = [...ENTRYPOINTS];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(KB, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    seen.add(rel);
    for (const spec of localImportsOf(abs)) {
      const target = path.normalize(path.join(path.dirname(rel), spec));
      if (target.startsWith('..')) { escapes.push(`${rel} -> ${spec}`); continue; }
      queue.push(target);
    }
  }
  return { modules: [...seen].sort(), missing, escapes };
}

describe('bundle import graph (issue #32)', () => {
  it('every entry point exists in kb/', () => {
    const absent = ENTRYPOINTS.filter((e) => !fs.existsSync(path.join(KB, e)));
    expect(absent, `entry points missing from kb/: ${absent.join(', ')}`).toEqual([]);
  });

  it('every transitively imported module resolves inside kb/ (the MODULE_NOT_FOUND guard)', () => {
    const { missing } = walk();
    expect(
      missing,
      `these modules are imported by a bundled reader but do not exist in kb/, so any release ` +
        `zip built from this tree would crash on startup: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no bundled module imports outside kb/ (the installed bundle has nothing else)', () => {
    const { escapes } = walk();
    expect(escapes, `imports escaping kb/: ${escapes.join('; ')}`).toEqual([]);
  });

  it('build-bundle.mjs derives its file list instead of hardcoding it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-bundle.mjs'), 'utf8');
    // The bug was a literal array of every module name. Derivation is the fix; assert the
    // mechanism is present rather than trusting that the array happens to be complete today.
    // Step 5 (2026-09-13) parameterized resolveModuleGraph(kbDir) so assembleBundle can walk any
    // finalized corpus's runtime checkout rather than a single closed-over module constant — the
    // arity is deliberately unconstrained here, only that `derivedTools` is DERIVED, never hardcoded.
    expect(src).toMatch(/resolveModuleGraph\s*\(/);
    expect(src).toMatch(/const\s+derivedTools\s*=\s*resolveModuleGraph\([^)]*\)/);
  });

  it('includes forge-hybrid.mjs — the exact module #32 shipped without', () => {
    const { modules } = walk();
    expect(modules).toContain('forge-hybrid.mjs');
  });
});
