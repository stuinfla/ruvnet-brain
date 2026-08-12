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

/**
 * ADR-067 addendum — A COPIED FILE CARRIES ITS IMPORTS OR IT IS DEAD ON ARRIVAL.
 *
 * Adding ONE import to `plugin/mcp/server.mjs` broke shipping in two places at once, and neither
 * failure named its cause:
 *
 *   the Codex host   `wireCodexHost` copied a HAND-LISTED set of dependencies, so the new sibling
 *                    was absent beside the copied server. Symptom: "no reply to initialize in 15s"
 *                    — a dead server on the packaging boundary.
 *   a mutation test  copied `bin/install.mjs` alone into a temp tree. Symptom: a MUTATION failure
 *                    that was really a packaging one, three layers from its cause.
 *
 * Both are the same defect this repo keeps paying for: a file's import graph, restated somewhere
 * else, drifting the moment the real one changes. Both are now DERIVED. This guard makes sure they
 * stay derived, because the next person to add an import will not remember any of it.
 */
describe('a file that gets copied alone must have its dependencies copied with it', () => {
  it('wireCodexHost derives the server\'s dependencies instead of listing them', () => {
    const install = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
    expect(install, 'the derived walk must exist').toMatch(/export function serverDependencies/);
    const wire = install.slice(install.indexOf('export function wireCodexHost'));
    const body = wire.slice(0, wire.indexOf('\n}\n'));
    expect(body, 'the copy list must come from the walk').toMatch(/serverDependencies\(source\)/);
    expect(body, 'a hand-listed dependency is what broke — it must not come back')
      .not.toMatch(/const managedCliSource = path\.join/);
  });

  it('TEETH: the walk really finds every relative import of the real server', async () => {
    process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
    const { serverDependencies } = await import('../../bin/install.mjs');
    const server = path.join(ROOT, 'plugin', 'mcp', 'server.mjs');
    const found = serverDependencies(server).map((d) => d.spec).sort();
    // Derived from the source on both sides — the test states no literal the product does not.
    const declared = [...fs.readFileSync(server, 'utf8')
      .matchAll(/^\s*import[^'"\n]*from\s*['"](\.[^'"]+)['"]/gm)].map((m) => m[1]).sort();
    expect(declared.length, 'the server must still have relative imports, or this is vacuous').toBeGreaterThan(0);
    for (const spec of declared) expect(found, `${spec} would not be copied beside the server`).toContain(spec);
  });
});

/**
 * THE SWEEP, MADE PERMANENT — no fixture may hand-list a script's imports.
 *
 * On 2026-08-12 this exact class broke FOUR places, and I found them one at a time instead of
 * sweeping:
 *
 *   wireCodexHost               hand-listed the MCP server's deps  -> shipped a dead Codex server
 *   tests/mesh/coexistence      hand-listed the installer's        -> a "mutation failure" that was packaging
 *   build-bundle-fence          hand-listed build-bundle's         -> nine "private-store fence broken" failures
 *   ingest-repo / codex-lifecycle  latent, found only by grepping for the shape
 *
 * The ingest fixture even carried a comment saying "the isolated ROOT must carry the script's real
 * dependency set" — it knew the rule and hand-listed anyway. That is the tell: knowing a rule is not
 * enforcing it. `lesson-store.mjs` names the shape — "one bug, found once, fixed once, left
 * everywhere else, which is the shape of nearly every failure in this project's history."
 *
 * A fixture that copies an entry script into an isolated tree must DERIVE what to copy beside it.
 */
describe('no fixture hand-lists the imports of a script it isolates', () => {
  const suspects = (() => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(q); continue; }
        if (!/\.(mjs|js)$/.test(e.name)) continue;
        const src = fs.readFileSync(q, 'utf8');
        const copies = [...src.matchAll(/copyFileSync\([^)]*['"`]([^'"`]*\.(?:mjs|js))['"`]/g)];
        if (copies.length >= 2) out.push({ rel: path.relative(ROOT, q), src, copies: copies.length });
      }
    };
    for (const d of ['tests', 'scripts', 'bin']) {
      const full = path.join(ROOT, d);
      if (fs.existsSync(full)) walk(full);
    }
    return out;
  })();

  it('finds the fixtures to check at all', () => {
    // Without this a path typo makes the assertion below vacuously true.
    expect(suspects.length, 'the scan found no multi-copy fixtures — the walk is wrong').toBeGreaterThan(0);
  });

  it('every multi-copy fixture derives rather than names its dependencies', () => {
    // THE PREDICATE MUST REQUIRE THE CALL, NOT THE MENTION. The first version tested
    // /serverDependencies/ against the whole file, so a fixture that IMPORTED the walker and then
    // hand-listed anyway passed — proven by mutation: removing the loop and restoring the literal
    // left this green. A guard that cannot fail on the broken shape is not a guard.
    const derives = (src) => /for\s*\(\s*const\s+\w+\s+of\s+serverDependencies\(/.test(src)
      || /cpSync\(/.test(src);
    const handListed = suspects
      .filter((s) => !derives(s.src))
      .map((s) => `${s.rel} (${s.copies} literal copies)`);
    expect(
      handListed,
      'these copy a script into an isolated tree and NAME its siblings. Walk the real imports '
      + 'instead — serverDependencies() in bin/install.mjs is generic over any entry file. A list '
      + 'of a file\'s imports, written anywhere but that file, drifts the moment an import lands.',
    ).toEqual([]);
  });
});
