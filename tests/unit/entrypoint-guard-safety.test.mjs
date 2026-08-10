import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A MODULE MAY NOT CRASH THE CALLER THAT MERELY IMPORTED IT.
 *
 * Every dual-purpose file in this repo — a library when imported, a CLI when run — needs to answer
 * "am I the entrypoint?", and that question has two Windows traps that both fired in CI on 2026-08-10:
 *
 *   1. `new URL(import.meta.url).pathname` yields `/D:/…` on Windows, which `path`/`fs` mangle into
 *      `D:\D:`. hook-shim.mjs learned this in issue #38 ("pathname yields '/C:/…' which path.resolve
 *      mangles into 'C:\\C:\\…'"); `fileURLToPath` is the fix.
 *   2. `fs.realpathSync` THROWS on a path that does not resolve, and under vitest `process.argv[1]`
 *      is not a real file. An unguarded call fails the importing SUITE at load time — not one
 *      assertion, the whole file, with an error that looks nothing like its cause.
 *
 * Both were already handled correctly in `scripts/selfcheck.mjs` and `plugin/scripts/hook-input.mjs`.
 * The pattern existed; a new one got written next to it and shipped broken. That is the failure this
 * guard exists to stop — not the individual bug, which is one line, but fixing it at one site while
 * leaving it at another. `lesson-store.mjs` already names this shape: "One bug, found once, fixed
 * once, left everywhere else — which is the shape of nearly every failure in this project's history."
 */
const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** Files that SHIP to a user's machine. Maintainer-only scripts are out of scope by design. */
const SHIPPED_DIRS = ['bin', 'plugin/scripts', 'plugin/mcp', 'kb'];

function shippedSources() {
  const out = [];
  for (const dir of SHIPPED_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.mjs')) continue;
      out.push({ rel: `${dir}/${name}`, text: fs.readFileSync(path.join(full, name), 'utf8') });
    }
  }
  return out;
}

/** Strip line comments so prose describing the trap is not mistaken for the trap. */
const code = (text) => text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('a shipped module never crashes the process that imports it', () => {
  const files = shippedSources();

  it('finds shipped sources to check at all', () => {
    // Without this, a path typo would make every assertion below vacuously true.
    expect(files.length, 'the scan found no .mjs files — the directory list is wrong').toBeGreaterThan(10);
  });

  it('no shipped file resolves its own path through URL().pathname', () => {
    const offenders = files
      .filter((f) => /import\.meta\.url\s*\)\s*\.pathname/.test(code(f.text)))
      .map((f) => f.rel);
    expect(offenders, 'use fileURLToPath(import.meta.url) — .pathname yields "/D:/…" on Windows')
      .toEqual([]);
  });

  it('no shipped file calls realpathSync(process.argv[1]) outside a try', () => {
    const offenders = [];
    for (const f of files) {
      const src = code(f.text);
      const idx = src.indexOf('realpathSync(process.argv[1])');
      if (idx < 0) continue;
      // The established pattern wraps the comparison in a try. Look for one in the enclosing region
      // rather than parsing: the check is a smell detector, and a false positive costs one comment.
      const region = src.slice(Math.max(0, idx - 400), idx + 200);
      if (!/try\s*\{/.test(region)) offenders.push(f.rel);
    }
    expect(offenders, 'realpathSync throws on an unresolvable path — see scripts/selfcheck.mjs')
      .toEqual([]);
  });

  it('TEETH: the detector fires on the exact shapes that shipped broken', () => {
    // Both strings are verbatim what CI rejected on 2026-08-10.
    const badPathname = 'const isMain = fs.realpathSync(new URL(import.meta.url).pathname);';
    expect(/import\.meta\.url\s*\)\s*\.pathname/.test(code(badPathname))).toBe(true);
    const bad = 'const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === x;';
    expect(/try\s*\{/.test(code(bad))).toBe(false);
    // …and NOT on the correct pattern, or it becomes noise people route around.
    const good = 'function isMain() {\n  try {\n    return fs.realpathSync(process.argv[1]) === y;\n  } catch { return false; }\n}';
    const i = code(good).indexOf('realpathSync(process.argv[1])');
    expect(/try\s*\{/.test(code(good).slice(Math.max(0, i - 400), i + 200))).toBe(true);
    expect(/import\.meta\.url\s*\)\s*\.pathname/.test(code(good))).toBe(false);
  });
});
