#!/usr/bin/env node
// scripts/no-silent-substitution.mjs — THE GATE THAT WOULD HAVE CAUGHT ME.
//
// WHY (2026-07-13, Stuart: "you're still doing this crap where you fucking lie to me and write a
// bunch of code and then tell me it's Ruv's code?"):
//
//   I wrote scripts/model-router-engine.mjs — 216 lines of my own heuristic with a self-described
//   "placeholder policy" — and SKILL.md called it "the MetaHarness router engine". Meanwhile
//   @metaharness/router@0.3.2 (ADR-040/043, Accepted/implemented) was sitting on npm: rUv's real
//   learned cost-optimal router, the productized DRACO Phase-2 finding. I built a Claude fake and
//   gave it his name. Every test passed. Every gate was green. NOTHING CHECKED FOR THE ONE THING THAT
//   ACTUALLY MATTERED.
//
// That is a QA hole, not a slip. Tests check "does my code work"; nothing checked "should this code
// exist at all, or does rUv already ship it?" This gate closes that hole and runs in CI.
//
// THE RULE IT ENFORCES:
//   If this repo contains code that implements a capability rUv already ships as a package, then
//   EITHER
//     (a) the real package is a declared dependency AND is actually imported somewhere, OR
//     (b) the local file carries an explicit, un-missable disclosure:
//           HAND-ROLLED: <reason>. REAL TOOL: <package>
//   Silence is not an option. You may hand-roll — you may NEVER hand-roll silently, and you may
//   never call your hand-roll by rUv's name.
//
// Usage:  node scripts/no-silent-substitution.mjs        # exit 1 on any violation (CI gate)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The capability map. Each entry: a capability rUv ALREADY SHIPS, the package that provides it, and
 * the signals that this repo is implementing it locally.
 *
 * Add to this list whenever the ecosystem ships something we might be tempted to rebuild. The cost of
 * a missing entry is exactly the bug above: a hand-roll wearing rUv's name, with green tests.
 */
export const CAPABILITIES = [
  {
    capability: 'cost-optimal model routing',
    pkg: '@metaharness/router',
    // Naming your file/docs after rUv's product is the tell. If you use the NAME, you use the TOOL.
    claimsTheName: /metaharness[ -]?router|the metaharness router engine/i,
    localImpl: /cost.?optimal|qualityBar|route.*cheapest|model.?router/i,
  },
  {
    capability: 'test generation / QE fleet',
    pkg: 'agentic-qe',
    claimsTheName: /agentic[ -]?qe/i,
    localImpl: /generate.*tests?.*automatically|coverage.?gap.?analysis/i,
  },
  {
    capability: 'vector store / HNSW',
    pkg: '@ruvector/rvf',
    claimsTheName: /\bRVF\b|ruvector/i,
    localImpl: /hand.?rolled.*cosine|own.*hnsw.*implementation/i,
  },
  {
    capability: 'prompt-injection / PII defence',
    pkg: '@claude-flow/aidefence',
    claimsTheName: /aimds|aidefence/i,
    localImpl: /prompt.?injection.*scanner|pii.*detector/i,
  },
];

// Scan CODE and the SKILL (the two places a substitution can actually deceive someone), not prose.
// A README that says "we use agentic-qe" is a claim about usage — checking it belongs in claims-verify.
// A gate that fires on every doc mentioning a tool is a gate everyone learns to ignore (see the
// windows-unit lesson: a permanently-red required job trains people to stop reading CI).
const SCAN_DIRS = ['scripts', 'bin', 'plugin/scripts', 'plugin/skills'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'clones', 'dist', 'coverage', 'kb']);
const SCAN_EXT = new Set(['.mjs', '.js', '.ts', '.md']);
// This file NAMES every tool in order to police them — exempting it is not a loophole, it is the
// difference between the rulebook and a violation.
const EXEMPT = new Set(['scripts/no-silent-substitution.mjs', 'tests/unit/no-silent-substitution.test.mjs']);

// The disclosure that makes a hand-roll legitimate. Explicit, greppable, impossible to write by accident.
const DISCLOSURE = /HAND-ROLLED:.*REAL TOOL:\s*(\S+)/is;
// Public product language names the assurance mechanism, not the implementation
// filename. “Independent review” was an ambiguous legacy label that allowed a
// signed machine-grade pair to be mistaken for a human approval gate.
export const OBSOLETE_GRADING_LANGUAGE = /\bindependent(?:ly)?\s+review(?:ers?|ed|ing)?\b|\bindependent\s+grading\b/i;
export const CURRENT_GRADING_LANGUAGE = 'machine grading by two vendors';

export function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (SCAN_EXT.has(path.extname(e.name))) out.push(path.join(dir, e.name));
  }
  return out;
}

/**
 * Is the real package genuinely used? Checks EVERY manifest in the repo, not just the root — the
 * first version of this gate only read the root package.json and cried wolf on @ruvector/rvf, which
 * is declared in kb/package.json and used all over kb/. A gate with false positives gets switched
 * off, and then it protects nothing.
 */
export function packageIsReallyUsed(pkg, root = ROOT) {
  const manifests = ['package.json', 'kb/package.json', 'plugin/package.json'];
  let declared = false;
  for (const m of manifests) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(root, m), 'utf8'));
      if ({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies }[pkg]) { declared = true; break; }
    } catch { /* manifest absent — keep looking */ }
  }
  if (!declared) return { declared: false, imported: false };

  // Match ANY real code reference to the package, not just a static `import ... from`. kb/ loads
  // @ruvector/rvf through a lazy dynamic resolver (createRequire/resolve-deps), so a static-import
  // regex reports the most heavily-used dependency in the repo as "never imported". A gate that
  // flags real usage as fraud is worse than no gate.
  const nameRe = new RegExp(`['"\`]${pkg.replace(/[/@.]/g, '\\$&')}['"\`/]`);
  const codeDirs = ['scripts', 'kb', 'bin'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const imported = codeDirs
    .flatMap((d) => walk(d, []))
    .filter((f) => ['.mjs', '.js', '.ts'].includes(path.extname(f))) // code only — a doc mentioning it is not usage
    .some((f) => nameRe.test(fs.readFileSync(f, 'utf8')));
  return { declared, imported };
}

export function audit(root = ROOT) {
  const violations = [];
  const files = SCAN_DIRS.flatMap((d) => {
    const abs = path.join(root, d);
    return fs.existsSync(abs) ? walk(abs, []) : [];
  }).filter((f) => !EXEMPT.has(path.relative(root, f).split(path.sep).join('/')));

  for (const cap of CAPABILITIES) {
    const use = packageIsReallyUsed(cap.pkg, root);
    for (const abs of files) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const src = fs.readFileSync(abs, 'utf8');

      // BOTH signals are required, and that conjunction IS the crime:
      //   buildsIt  — this file implements the capability
      //   namesIt   — and calls it by rUv's name
      // Merely mentioning a tool is not a substitution. Merely implementing something is not either
      // (you are allowed to write code). Implementing it AND wearing rUv's name is the deception.
      if (!(cap.claimsTheName.test(src) && cap.localImpl.test(src))) continue;

      // Two ways to be innocent: actually use the real tool, or openly admit you did not.
      if (use.imported || DISCLOSURE.test(src)) continue;

      violations.push({
        file: rel,
        capability: cap.capability,
        pkg: cap.pkg,
        why: use.declared
          ? `implements "${cap.capability}" and calls itself ${cap.pkg}, but the package is declared and NEVER IMPORTED — a hand-roll wearing rUv's name`
          : `implements "${cap.capability}" and calls itself ${cap.pkg}, but the package is NOT a dependency — a Claude fake with rUv's label on it`,
        fix: `Either USE ${cap.pkg} (npm i ${cap.pkg}; import it), or add the disclosure: "HAND-ROLLED: <reason>. REAL TOOL: ${cap.pkg}"`,
      });
    }
  }
  return violations;
}

export function auditUserFacingGradingLanguage(root = ROOT) {
  const files = ['docs', '.github'].flatMap((dir) => {
    const abs = path.join(root, dir);
    return fs.existsSync(abs) ? walk(abs, []) : [];
  }).filter((file) => !file.endsWith('no-silent-substitution.mjs'));
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    if (!OBSOLETE_GRADING_LANGUAGE.test(source)) return [];
    return [{ file: path.relative(root, file).split(path.sep).join('/'),
      capability: 'two-vendor machine grading',
      pkg: 'native subscription reviewers',
      why: `user-facing grading language uses the obsolete independent-review label; use "${CURRENT_GRADING_LANGUAGE}"`,
      fix: `replace the legacy label with "${CURRENT_GRADING_LANGUAGE}"` }];
  });
}

function main() {
  const violations = [...audit(), ...auditUserFacingGradingLanguage()];
  console.log('no-silent-substitution — is any local code impersonating a real rUv tool?\n');
  if (!violations.length) {
    console.log('✅ none. Every RuvNet capability this repo names is either genuinely used or openly disclosed as a hand-roll.');
    process.exit(0);
  }
  for (const v of violations) {
    console.error(`❌ ${v.file}`);
    console.error(`   capability : ${v.capability}`);
    console.error(`   problem    : ${v.why}`);
    console.error(`   fix        : ${v.fix}\n`);
  }
  console.error(`${violations.length} silent substitution(s). You may hand-roll — you may NEVER hand-roll SILENTLY,`);
  console.error("and you may never call your hand-roll by rUv's name.");
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
