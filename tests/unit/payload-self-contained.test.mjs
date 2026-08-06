// tests/unit/payload-self-contained.test.mjs
//
// EVERY module the PAYLOAD reaches for at runtime must live INSIDE the payload.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A DIFFERENT GATE FROM installer-sibling-imports-packaged.test.mjs, and why that one
// could not have been extended.
//
// That gate keys on TARBALL membership (`npm pack --dry-run`), which is the right question for
// bin/install.mjs — an npm consumer gets the whole tarball. It is the WRONG question for the plugin,
// and answering the wrong question is what let the L4 surface ship inert for its entire life:
//
//   package.json "files" lists "scripts/", so goal-match.mjs, capability-registry.mjs and
//   advocacy-outcomes.mjs were ALWAYS in the tarball. A tarball-keyed assertion about them would have
//   been GREEN on every commit while the feature was dead on every real install.
//
// The plugin does not travel in the tarball. `.claude-plugin/marketplace.json` declares
// `"source": "./plugin"`, `plugin/scripts/update-apply.mjs`'s stagePayload() does one
// `fs.cpSync(srcDir, staging, {recursive:true})` of exactly that directory, and
// bin/install.mjs's prepareCodexMarketplace() copies only `plugin/`. So nothing outside `plugin/`
// can reach a user through any of the three channels, and all three FLATTEN the `plugin/` level:
//
//   ~/.cache/ruvnet-brain/versions/<gen>/scripts/…        (the Stable Spine)
//   ~/.claude/plugins/cache/ruvnet-brain/…/<ver>/scripts/… (the Claude plugin cache)
//   <codex-marketplace>/…/scripts/…                        (prepareCodexMarketplace)
//   <src>/plugin/scripts/…                                 (a git checkout — the ONLY layout that
//                                                           keeps `plugin/`, and the one nobody ships)
//
// MEASURED, 2026-08-06: `find ~/.cache/ruvnet-brain/versions/4.0.12 -name goal-match.mjs` returned
// NOTHING. anticipate.sh's `[ -f "$GOAL_MATCH" ] || exit 0` then did exactly what it promises — it
// stayed silent — so a whole product surface was absent on every install with no error, no log line
// and no red test. PR #114 fixed the PATH RESOLUTION half; this gate exists so the PACKAGING half
// cannot regress. Neither half works alone.
//
// THE INVARIANT, stated once: the payload boundary is `plugin/`. A payload file may reach any other
// payload file and NOTHING ELSE. Every failure mode this catches is silent by construction — a
// missing module degrades to a catch, a null helper, an `unknown` row, or an early `exit 0` — which
// is precisely why it needs a test rather than a code review.
//
// WHAT "REACHES FOR" MEANS HERE. Three reference forms, all of which really occur in the payload:
//   1. shell:  "$MODULE_DIR/goal-match.mjs", "$SELF_DIR/anticipate.sh", "$HOOK_DIR/…", and the
//              "$CODE_ROOT/scripts/…" idiom that was the original defect.
//   2. js:     path.join(SCRIPTS_DIR|CODE_ROOT|HERE|…, [ 'scripts', ] 'name.mjs')
//   3. the shim dispatch table in hook-shim.mjs, whose `file:` entries are resolved against
//              <root>/scripts/ on every host — the single largest set of runtime references we ship.
// …plus the TRANSITIVE CLOSURE of relative ESM imports from everything reachable, because shipping
// capability-registry.mjs without nightly-controller.mjs (a HARD static import) fails at load with
// ERR_MODULE_NOT_FOUND, which anticipate.sh's catch turns straight back into silence.
//
// ANTI-VACUITY. Every derived list is asserted non-empty. A regex that silently stops matching is the
// exact shape of the failure this file guards, so a gate that guards nothing must be RED, not green.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAYLOAD = path.join(ROOT, 'plugin');
const PAYLOAD_SCRIPTS = path.join(PAYLOAD, 'scripts');

/** Every file under plugin/scripts and plugin/mcp, as repo-relative POSIX paths. */
function payloadFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  for (const sub of ['scripts', 'mcp']) {
    const dir = path.join(PAYLOAD, sub);
    if (fs.existsSync(dir)) walk(dir);
  }
  return out;
}

/**
 * Drop whole-line comments before matching. The payload is heavily commented and several comments
 * QUOTE the very idioms below — unprompted-runtime.mjs's own header now cites the broken
 * `$CODE_ROOT/scripts/user-settings.mjs` path as the thing it fixed. Counting a comment as a runtime
 * reference would make this gate fail on its own documentation, which teaches people to delete the
 * documentation. Only full-line comments are stripped: a partial strip would have to understand
 * strings, and `file://` URLs live in these files.
 */
function stripLineComments(src) {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

// The extension list is CLOSED and ANCHORED with `(?![\w-])`. Without the anchor, greedy backtracking
// matched `token-ledger.jsonl` as `token-ledger.js` and reported ground-ruvnet.sh's token LEDGER — a
// data file it appends to — as a missing module. A gate that fails on a correct file is worse than no
// gate: it gets muted, and then it is not guarding the thing it was written for either.
const EXT = String.raw`\.(?:mjs|cjs|js|sh)(?![\w-])`;
// "$MODULE_DIR/goal-match.mjs", "${SELF_DIR}/anticipate.sh", "$CODE_ROOT/scripts/user-settings.mjs"
const SHELL_REF = new RegExp(String.raw`\$\{?[A-Z][A-Z0-9_]*(?:DIR|ROOT|HOME)\}?\/(?:scripts\/)?([A-Za-z0-9._-]+${EXT})`, 'g');
// path.join(SCRIPTS_DIR, 'anticipate.sh') / path.join(CODE_ROOT, 'scripts', 'user-settings.mjs')
const JS_REF = new RegExp(String.raw`path\.(?:join|resolve)\(\s*(?:SCRIPTS_DIR|CODE_ROOT|HOOK_DIR|SELF_DIR|HERE|PLUGIN_ROOT|MODULE_DIR)\s*,\s*(?:'[^']*'\s*,\s*)*'([A-Za-z0-9._-]+${EXT})'\s*\)`, 'g');
// hook-shim.mjs's dispatch table: { file: 'route-dispatch.sh', … } — resolved against <root>/scripts/
const SHIM_REF = new RegExp(String.raw`\bfile:\s*'([A-Za-z0-9._-]+${EXT})'`, 'g');

/** { file, ref } pairs — every runtime module reference the payload makes, by basename. */
function runtimeRefs() {
  const refs = [];
  for (const abs of payloadFiles()) {
    const ext = path.extname(abs);
    if (!['.mjs', '.js', '.cjs', '.sh'].includes(ext)) continue;
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    const src = stripLineComments(fs.readFileSync(abs, 'utf8'));
    const patterns = ext === '.sh' ? [SHELL_REF] : [JS_REF, SHIM_REF];
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) refs.push({ file: rel, ref: m[1], kind: re === SHELL_REF ? 'shell' : 'js' });
    }
  }
  return refs;
}

/** Relative ESM specifiers: `from './x.mjs'`, `import('../y/z.mjs')`, `export … from './x.mjs'`. */
const REL_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]+\.(?:mjs|js|cjs))['"]/g;

/**
 * Transitive closure of relative imports, seeded from every payload file. Returns every edge as
 * { from, spec, resolved } so a violation names the exact line a maintainer has to go fix.
 */
function importEdges() {
  const seen = new Set();
  const edges = [];
  const queue = payloadFiles().filter((f) => ['.mjs', '.js', '.cjs'].includes(path.extname(f)));
  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs)) continue;
    seen.add(abs);
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    for (const m of stripLineComments(src).matchAll(REL_IMPORT)) {
      const resolved = path.resolve(path.dirname(abs), m[1]);
      edges.push({
        from: path.relative(ROOT, abs).split(path.sep).join('/'),
        spec: m[1],
        resolved,
      });
      if (fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  return edges;
}

const insidePayload = (abs) => {
  const r = path.relative(PAYLOAD, abs);
  return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
};

describe('the plugin payload is self-contained', () => {
  const refs = runtimeRefs();
  const edges = importEdges();

  it('finds runtime module references at all (the gate must not pass vacuously)', () => {
    // If the resolution idioms change, this gate would silently guard nothing and report green —
    // which is exactly the failure it exists to catch, one level up. An empty derived list is a
    // failure, not a pass.
    expect(refs.length, 'no runtime module references found under plugin/ — has the idiom changed? this gate is now blind').toBeGreaterThan(0);
    expect(refs.some((r) => r.kind === 'shell'), 'no $DIR/-style shell references found — the .sh scanner is blind').toBe(true);
    expect(refs.some((r) => r.kind === 'js'), 'no path.join(SCRIPTS_DIR, …) references found — the .mjs scanner is blind').toBe(true);
    expect(edges.length, 'no relative imports found under plugin/ — the closure walker is blind').toBeGreaterThan(0);
  });

  it('every module the payload names at runtime is IN the payload', () => {
    // Basename resolution, deliberately: every one of these idioms resolves against the payload's own
    // scripts/ dir at run time, whatever that dir is called on the host. A name that is not there is
    // a feature that silently does not exist on the Spine, the plugin cache and the Codex install
    // alike — while a git checkout, the one layout nobody ships, keeps working.
    const missing = [...new Set(
      refs.filter((r) => !fs.existsSync(path.join(PAYLOAD_SCRIPTS, r.ref)))
        .map((r) => `${r.file} → ${r.ref}`),
    )].sort();
    expect(
      missing,
      'these are referenced at runtime by a file inside plugin/, but are NOT in plugin/scripts/. ' +
        'Only plugin/ reaches a user (marketplace.json "source": "./plugin"; stagePayload() copies ' +
        'that directory verbatim), and every shipped layout flattens it — so each of these resolves ' +
        'to nothing on a real install and the feature behind it degrades to SILENCE:\n  ' +
        `${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every relative import reachable from the payload stays inside the payload', () => {
    // The closure half. capability-registry.mjs statically imports nightly-controller.mjs and
    // hook-registry.mjs — ship it without them and it throws ERR_MODULE_NOT_FOUND at load, which
    // anticipate.sh's catch converts straight back into silence. A reference that ESCAPES the payload
    // (the `../plugin/scripts/project-identity.mjs` form memory-doctor.mjs carried before the move)
    // is the same defect wearing a working path in a checkout.
    const escaping = edges.filter((e) => !insidePayload(e.resolved))
      .map((e) => `${e.from} → ${e.spec}`);
    const absent = edges.filter((e) => insidePayload(e.resolved) && !fs.existsSync(e.resolved))
      .map((e) => `${e.from} → ${e.spec}`);
    expect(
      [...new Set(escaping)].sort(),
      'these imports reach OUTSIDE plugin/, so they resolve only in a git checkout and throw ' +
        'ERR_MODULE_NOT_FOUND on every shipped layout',
    ).toEqual([]);
    expect(
      [...new Set(absent)].sort(),
      'these imports name a payload path that does not exist',
    ).toEqual([]);
  });

  it('the three L4 modules are in the payload by name (the specific regression)', () => {
    // A named regression test on top of the derived ones. The generic rules above are what keep this
    // honest in general; this is the tripwire for the exact files whose absence made the anticipate
    // surface inert on every install between its build and 2026-08-06.
    for (const f of ['goal-match.mjs', 'capability-registry.mjs', 'advocacy-outcomes.mjs']) {
      expect(fs.existsSync(path.join(PAYLOAD_SCRIPTS, f)), `${f} must ship inside plugin/scripts/`).toBe(true);
    }
  });
});
