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
import { substitutionVerdict, inScope, codeOf, message } from '../plugin/scripts/substitution-wall.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

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

// ── CLASS 2: STORAGE / QUEUE / JOURNAL (2026-10-12) ─────────────────────────────────────────────
// The package-name rule above said "none" on a 3.38 GB outbox, queues and replay workers in front of
// `ruflo memory store`: storage was not in CAPABILITIES, and spawning the `ruflo` binary counted as
// "rUv is used". This class is behaviour-based, shares ONE detector with the PreToolUse policy
// (plugin/scripts/substitution-wall.mjs), and is a RATCHET over config/state-files.json:
//   · a file the detector refuses must be in `substitutionBaseline` (known debt, signals recorded) or
//     `substitutionAllow` (owner-approved). A NEW one fails; a baseline file that GAINS a signal fails.
//   · every module that appends to a file must be registered in `stateFiles` with its bound (or an
//     explicit `bound: null`), and the count of unbounded ones may not rise above `maxUnbounded`.
export const STATE_CONFIG = 'config/state-files.json';
const APPEND = /\b(?:appendFileSync|appendFile|createWriteStream)\b|\bO_APPEND\b|flags?\s*:\s*['"]a\+?['"]/;
const BOUND = /\bMAX_\w*(?:BYTES|LINES|RECORDS|ROWS|ENTRIES|AGE\w*)\b|\bmax(?:Bytes|Lines|Records|Rows|Entries)\b|\brotat\w+|\bcompact\w*|\btruncateSync\b|\bprune\w*/;

function scopedFiles(root) {
  return ['plugin/scripts', 'scripts'].flatMap((d) => (fs.existsSync(path.join(root, d)) ? walkAll(path.join(root, d)) : []))
    .map((f) => path.relative(root, f).split(path.sep).join('/')).filter(inScope).sort();
}
function walkAll(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walkAll(path.join(dir, e.name), out); }
    else out.push(path.join(dir, e.name));
  }
  return out;
}

/** Every module that appends to a file: its literal targets and the first bound token in its code (or null). */
export function stateFileInventory(root = ROOT) {
  return scopedFiles(root).flatMap((rel) => {
    const code = codeOf(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
    if (!APPEND.test(code)) return [];
    const targets = [...new Set([...code.matchAll(/['"`/]([\w.-]+\.(?:jsonl|ndjson|log))['"`]/g)].map((m) => m[1]))].sort();
    return [{ module: rel, targets, bound: BOUND.exec(code)?.[0] ?? null }]; // bound = a grep-detected token, NOT proof it bounds the target
  });
}

export function readStateConfig(root = ROOT) {
  try { return JSON.parse(fs.readFileSync(path.join(root, STATE_CONFIG), 'utf8')); } catch { return {}; }
}

export function storageAudit(root = ROOT, config = readStateConfig(root)) {
  const violations = []; const notes = [];
  const allow = (config.substitutionAllow || []).map((a) => a.path);
  const baseline = new Map((config.substitutionBaseline || []).map((b) => [b.path, b]));
  for (const rel of scopedFiles(root)) {
    const v = substitutionVerdict({ path: rel, content: fs.readFileSync(path.join(root, rel), 'utf8'), allow });
    const known = baseline.get(rel);
    if (v.verdict === 'refuse' && !known) violations.push({ file: rel, capability: 'storage/queue/journal', pkg: 'ruflo memory', why: message(rel, v).split('\n')[0], fix: `Call ${v.tool}; delete the transport.` });
    else if (v.verdict === 'refuse' && v.signals.some((s) => !known.signals.includes(s))) violations.push({ file: rel, capability: 'storage/queue/journal', pkg: 'ruflo memory', why: `known debt GREW: signals ${v.signals.join(',')} vs baseline ${known.signals.join(',')}`, fix: 'Shrink it toward one ruflo call; never grow it.' });
    else if (known && v.verdict !== 'refuse') notes.push(`${rel} no longer refuses — remove it from substitutionBaseline (the ratchet tightens).`);
  }
  const registered = new Map((config.stateFiles || []).map((s) => [s.module, s]));
  const inventory = stateFileInventory(root);
  for (const s of inventory) if (!registered.has(s.module)) violations.push({ file: s.module, capability: 'state-file ratchet', pkg: STATE_CONFIG, why: `appends to ${s.targets.join(', ') || 'a file'} and is not registered with a bound`, fix: `Register it in ${STATE_CONFIG} stateFiles (bound or explicit null), or store via ruflo memory.` });
  const unbounded = [...registered.values()].filter((s) => s.bound === null && inventory.some((i) => i.module === s.module)).length;
  if (unbounded > (config.maxUnbounded ?? 0)) violations.push({ file: STATE_CONFIG, capability: 'state-file ratchet', pkg: STATE_CONFIG, why: `${unbounded} unbounded append targets > maxUnbounded ${config.maxUnbounded ?? 0}`, fix: 'Bound the new one, or remove an old one first.' });
  for (const m of registered.keys()) if (!inventory.some((i) => i.module === m)) notes.push(`${m} no longer appends — remove it from stateFiles.`);
  return { violations, notes, unbounded };
}

function main() {
  if (process.argv.includes('--inventory')) { console.log(JSON.stringify(stateFileInventory(), null, 2)); process.exit(0); }
  const storage = storageAudit();
  for (const n of storage.notes) console.log(`ℹ ${n}`);
  console.log(`storage/queue/journal: ${(readStateConfig().substitutionBaseline || []).length} known debt file(s), ${storage.unbounded} unbounded append target(s) registered.`);
  const violations = [...audit(), ...storage.violations];
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

if (isDirectInvocation(import.meta.url)) main();
