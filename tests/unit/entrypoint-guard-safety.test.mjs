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
    // …and NOT on the correct pattern, or it becomes noise people route around. In shipped code that
    // pattern now lives in ONE place, isDirectInvocation() in plugin/scripts/entrypoint.mjs (a try
    // around both realpathSync calls); this inline string is the same shape, kept here as the probe.
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
 * ONE WAY TO FIND BASH — and `/bin/bash` written anywhere but the resolver is not it.
 *
 * On 2026-08-13 `flywheel-configured-vs-operational.test.mjs` spawned `/bin/bash` directly. It was
 * the ONLY file in the suite that did. On windows-unit the path does not resolve, the hook never
 * ran, and six assertions failed with `expected '' to match …` — a message that names neither bash
 * nor Windows, and reads instead as "the flywheel advisory is broken". It blocked a dependabot PR
 * that had nothing to do with any of it.
 *
 * `resolveBash()` already existed for exactly this (issue #38, from @tkmeownow's tested patch). A
 * second answer written next to a working one is the same defect as `orgTotalApprox: 248` in two
 * producers and seven store-root expressions across 29 call sites: one fact, restated where it will
 * drift. The instance is one line; the CLASS is what keeps costing days, so the class gets the guard.
 */
describe('nothing hardcodes a bash path — the resolver is the only answer', () => {
  const sources = (() => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.git|clones/.test(e.name)) walk(q); continue; }
        if (!/\.(mjs|js)$/.test(e.name)) continue;
        out.push({ rel: path.relative(ROOT, q), text: fs.readFileSync(q, 'utf8') });
      }
    };
    for (const d of ['tests', 'scripts', 'bin', 'plugin']) {
      const full = path.join(ROOT, d);
      if (fs.existsSync(full)) walk(full);
    }
    return out;
  })();

  it('finds sources to check at all', () => {
    expect(sources.length, 'the scan found nothing — the directory list is wrong').toBeGreaterThan(20);
  });

  /**
   * The precise defect is SPAWNING a path that may not exist — not mentioning the string. A fixture
   * that asserts on the literal, and the resolver's own test that pins `resolveBash({},'darwin') ===
   * '/bin/bash'`, are both correct and must stay. So the predicate targets the executable position
   * of a spawn, and clears a file that either uses the resolver or guards on the path existing.
   * A broader rule would flag correct code, and a guard that flags correct code gets deleted.
   */
  const SPAWNS_LITERAL = /(?:spawnSync|execFileSync|execFile|spawn)\(\s*['"`]\/bin\/bash['"`]/;
  const isSafe = (src) => /resolveBash/.test(src) || /existsSync\(\s*['"`]\/bin\/bash['"`]\s*\)/.test(src);

  it('TEETH: no file spawns a literal /bin/bash unguarded', () => {
    const offenders = sources
      .filter((f) => !/hook-shim-bash\.mjs$/.test(f.rel)) // the resolver is where the literal belongs
      .filter((f) => SPAWNS_LITERAL.test(code(f.text)) && !isSafe(code(f.text)))
      .map((f) => f.rel);
    expect(
      offenders,
      'import { resolveBash } from plugin/scripts/hook-shim-bash.mjs. It returns /bin/bash on POSIX, '
      + 'Git-for-Windows bash on win32, and null when there is none — and a null means SKIP, because '
      + 'a platform with no bash is not a product defect. Guarding with existsSync is also accepted.',
    ).toEqual([]);
  });

  it('TEETH: the detector fires on the line that broke CI, and clears the correct forms', () => {
    // Proven by mutation both ways: a pattern that never fires and one that fires on everything are
    // equally useless, and this repo has shipped the first kind already.
    expect(SPAWNS_LITERAL.test("const r = spawnSync('/bin/bash', [HOOK], {")).toBe(true);
    expect(SPAWNS_LITERAL.test("execFileSync('/bin/bash', [CAPTURE], {")).toBe(true);
    expect(SPAWNS_LITERAL.test('const r = spawnSync(BASH, [HOOK], {')).toBe(false);
    // …and a file that merely asserts on the string, or guards first, is not an offender.
    expect(isSafe("expect(resolveBash({}, 'darwin')).toBe('/bin/bash');")).toBe(true);
    expect(isSafe("const hasBinBash = fs.existsSync('/bin/bash');")).toBe(true);
    expect(isSafe("spawnSync('/bin/bash', [p])")).toBe(false);
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

/**
 * THE SAME CLASS, ONE SYNTAX OVER — a copy LOOP over a constant list of script paths.
 *
 * The literal-count check above cannot see `for (const f of DEPENDENCY_FILES) copyFileSync(...)`:
 * there is one copyFileSync call, and the names sit in an array. That is exactly how
 * tests/integration/ingest-gists.test.mjs rotted: its list missed scripts/transient-gh.mjs from
 * v4.7.16 and plugin/scripts/entrypoint.mjs from 4.7.21, and all 11 subprocess cases died on
 * ERR_MODULE_NOT_FOUND with nothing pointing at the list. self-update-publish-branch-guard used the
 * same shape with an array of `*_SRC` constants.
 *
 * Rule: a for-of loop whose list is a constant array naming a .mjs/.js path (inline, a named const, or
 * consts that hold such a path) and whose body calls copyFileSync is a hand list, unless that body
 * itself walks serverDependencies().
 */
const SELF = fileURLToPath(import.meta.url);
const SCRIPT_LITERAL = /['"`][^'"`\n]*\.m?js['"`]/;
function statementAfter(src, from) {
  let i = from;
  while (/\s/.test(src[i] || '')) i += 1;
  if (src[i] !== '{') { const end = src.indexOf(';', i); return src.slice(i, end < 0 ? undefined : end + 1); }
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}' && (depth -= 1) === 0) return src.slice(i, j + 1);
  }
  return src.slice(i);
}
const escapeName = (name) => name.replace(/\$/g, '\\$');
function constantListCopyLoops(src) {
  const hits = [];
  for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+\w+\s+of\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s*\)/g)) {
    let items = m[1];
    if (!items.startsWith('[')) {
      const decl = src.match(new RegExp(`(?:const|let|var)\\s+${escapeName(items)}\\s*=\\s*(\\[[^\\]]*\\])`));
      if (!decl) continue; // not a constant array (a derived list, a function result): not this class
      items = decl[1];
    }
    const names = items.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    const scripts = names.filter((e) => SCRIPT_LITERAL.test(e) || (/^[A-Za-z_$][\w$]*$/.test(e)
      && new RegExp(`(?:const|let)\\s+${escapeName(e)}\\s*=[^;\\n]*\\.m?js['"\`]`).test(src)));
    if (scripts.length === 0) continue;
    const body = statementAfter(src, m.index + m[0].length);
    if (/copyFileSync\(/.test(body) && !/serverDependencies\(/.test(body)) hits.push(m[0].replace(/\s+/g, ' ').slice(0, 80));
  }
  return hits;
}

/** Fixtures that had this shape when the check landed (4.7.21). Not an exemption list to grow: the
 *  test fails when a NEW file shows the shape, and fails when a listed file no longer does, so the
 *  list can only shrink. Each one is the same rot waiting for its script's next import. */
const KNOWN_LOOP_HAND_LISTS = [
  'scripts/claude-terminal-mod.mjs',
  'tests/integration/anticipate-module-resolution.test.mjs',
  'tests/integration/card-lane-hot-path.test.mjs',
  'tests/integration/corpus-auto-update-e2e.test.mjs',
  'tests/mutation/install-selfcheck-consumption-mutation.test.mjs',
  'tests/unit/codex-lifecycle-hooks.test.mjs',
  'tests/unit/corpus-canary.test.mjs',
  'tests/unit/corpus-next-seed.test.mjs',
  'tests/unit/corpus-release-customer-compat.test.mjs',
  'tests/unit/forge-update-apply-rollback.test.mjs',
  'tests/unit/model-router-engine.test.mjs',
  'tests/unit/nightly-corpus-zip-coverage.test.mjs',
  'tests/unit/promoted-lessons-survive-update.test.mjs',
  'tests/unit/release-channel-contract.test.mjs',
  'tests/unit/session-start-budget.test.mjs',
  'tests/unit/update-lock-identity.test.mjs',
];

describe('no fixture copies a script beside a constant list of its imports in a loop', () => {
  const found = (() => {
    const out = new Map();
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const q = path.join(d, e.name);
        if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(q); continue; }
        if (!/\.(mjs|js)$/.test(e.name) || q === SELF) continue; // this file holds the probe strings
        const hits = constantListCopyLoops(code(fs.readFileSync(q, 'utf8')));
        if (hits.length) out.set(path.relative(ROOT, q).split(path.sep).join('/'), hits);
      }
    };
    for (const d of ['tests', 'scripts', 'bin']) {
      const full = path.join(ROOT, d);
      if (fs.existsSync(full)) walk(full);
    }
    return out;
  })();

  it('TEETH: fires on the two shapes that rotted, and clears the derived walk', () => {
    const namedList = "const DEPENDENCY_FILES = [\n  'scripts/ingest-gists.mjs',\n  'scripts/version.mjs',\n];\n"
      + 'for (const relative of DEPENDENCY_FILES) {\n  fs.copyFileSync(path.join(REPO_ROOT, relative), path.join(tmp, relative));\n}';
    expect(constantListCopyLoops(namedList)).toHaveLength(1);
    const constants = "const FULL_HINTS_SRC = path.join(REPO_ROOT, 'scripts/full-hints.mjs');\n"
      + "const WORKTREE_INTEGRITY_SRC = path.join(REPO_ROOT, 'scripts/worktree-integrity.mjs');\n"
      + 'for (const source of [FULL_HINTS_SRC, WORKTREE_INTEGRITY_SRC]) {\n  fs.copyFileSync(source, path.join(dir, path.basename(source)));\n}';
    expect(constantListCopyLoops(constants)).toHaveLength(1);
    expect(constantListCopyLoops("for (const f of ['a.mjs', 'b.mjs']) fs.copyFileSync(f, t);")).toHaveLength(1);
    // Cleared: the derived walk, a loop whose body walks the imports, a list of non-scripts, a loop
    // that never copies.
    expect(constantListCopyLoops('for (const dep of serverDependencies(ENTRY)) fs.copyFileSync(dep.from, t);')).toEqual([]);
    expect(constantListCopyLoops("const entries = [path.join(ROOT, 'a.mjs')];\nfor (const s of entries) {\n"
      + '  fs.copyFileSync(s, t);\n  for (const d of serverDependencies(s)) fs.copyFileSync(d.from, u);\n}')).toEqual([]);
    expect(constantListCopyLoops("for (const f of ['plugin.json', 'data.txt']) fs.copyFileSync(f, t);")).toEqual([]);
    expect(constantListCopyLoops("for (const f of ['a.mjs', 'b.mjs']) fs.writeFileSync(f, '');")).toEqual([]);
  });

  it('no NEW file copies scripts from a hand list in a loop', () => {
    const fresh = [...found.keys()].filter((rel) => !KNOWN_LOOP_HAND_LISTS.includes(rel));
    expect(
      fresh.map((rel) => `${rel}: ${found.get(rel).join(' | ')}`),
      'derive the copy list: for (const dep of serverDependencies(ENTRY)) copy dep.from, keeping its '
      + 'path relative to the repo root (see tests/integration/ingest-gists.test.mjs).',
    ).toEqual([]);
  });

  it('the known list only shrinks: a fixed file must leave it', () => {
    const fixed = KNOWN_LOOP_HAND_LISTS.filter((rel) => !found.has(rel));
    expect(fixed, 'these no longer hand-list in a loop; delete them from KNOWN_LOOP_HAND_LISTS').toEqual([]);
  });
});
