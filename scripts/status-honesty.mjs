#!/usr/bin/env node
// scripts/status-honesty.mjs — THE ANTI-FAKING GATE (ADR-0024). No script may ASSERT a terminal
// success status; success must be DERIVED from a verifiable artifact.
//
// WHY (Stuart, 2026-07-18, after the word "faking" kept coming back): "The fact that you're still
// creating code in a sloppy way that allows it to fake results is toxic and needs to be blown out of
// the system." The historical sin: issue-fix.mjs once hardcoded status:'completed' for issues it
// never touched — no branch, no comment, no artifact. The class, per rUv's own architecture:
//   - a status FIELD can be forged; only RE-DERIVATION from the real artifact catches it
//     (ruvector proof-gate #506: "a structural scan cannot catch a structurally-valid forgery");
//   - verification must pin to the trusted source, never the self-asserted field
//     (ruflo signed-artifact: "an attacker controls that field; pinning to it is a no-op").
//
// LAYER 1 (this file): a lexical scanner over every automation script. It flags any WRITE of a
// terminal success literal (status:'completed', state:"ok", outcome:'success', …) whose statement
// shows NO derivation marker — no captured exit code, no comparison, no ternary on a runtime result,
// no registered verifier call. A comment cannot satisfy it; only a derivation expression can.
// SCOPE IS DELIBERATE: terminal RECEIPT/STATUS tokens only (the historical sin's exact shape), not
// generic `ok: true` returns — a gate that cries wolf gets disabled, which is worse than no gate.
// KNOWN RESIDUAL (documented, accepted): a lexical layer can be gamed by computed keys or an
// always-true verifier — that is why Layer 2 (behavioral fixtures in derived-status.test.mjs)
// executes the real wrapper and the real outcome-verifier, and why the known-bad fixture must FAIL
// on every run. Text can lie; execution can't.
//
// Usage: node scripts/status-honesty.mjs            exit 0 = clean, 1 = violations (printed)
//        imported by tests/unit/derived-status.test.mjs (scanSource / scanRepo)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Terminal success literals — the exact shape of the historical sin. Word-bounded, quote-flexible.
const SUCCESS_WRITES = [
  /\bstatus\s*[:=]\s*['"](completed|success|succeeded|done|fixed|shipped|passed)['"]/,
  /\bstate\s*[:=]\s*['"](ok|completed|success|succeeded|passed)['"]/,
  /\boutcome\s*[:=]\s*['"](success|succeeded|completed)['"]/,
  /"state"\s*:\s*"(ok|completed|success)"/, // literal JSON in sh heredocs/printf
];

// Derivation markers: evidence the assignment is CONDITIONAL on a runtime result. The registry is
// extended by PR — a new receipt-writer fails this gate by default until its derivation is named.
const DERIVATION_MARKERS = [
  '=== 0', '!== 0', '== 0', '!= 0', '-eq 0', '-ne 0', // exit-code comparisons (js + sh)
  '? ', // ternary on a captured result (paired with the comparisons above in practice)
  '.has(', // SUCCESS_OUTCOMES.has(...) — the issue-fix standard
  'r.status', 'res.status', 'res.ok', 'r.ok', '.exitCode', 'exit_code', 'status ===', 'code -eq',
  'remoteBranchExists', 'installedVersion', 'verifyOutcome', 'delivered', 'succeeded ?', 'sent ===',
];

// Guard-clause derivation: `if (!x.ok) return {...failed...}; ... return { state: 'ok', ... };` gates
// the terminal literal on an earlier validator call's `.ok` result — a real derivation — but the guard
// can sit many lines above the literal (one guard per precondition, e.g. refreshRunHealth() checking
// registration, identity, and envelope validity in turn before its one unconditional success return).
// That is outside the local ±2-line window designed for inline ternaries, so it false-positived on
// plugin/scripts/nightly-scheduler.mjs:271 (caught by the 2026-09-12 consistency audit; state:'ok' IS
// gated, just structurally distant). Recognize the guard-clause idiom explicitly instead of widening
// the generic window — widening would also swallow unrelated markers anywhere in the function and
// could hide a genuinely naked literal sitting next to unrelated derivation-looking text.
const OK_GUARD_RE = /\bif\s*\(\s*!\s*[\w$]+(?:\.[\w$]+)*\.ok\b\s*\)\s*return\b/;
const FUNCTION_START_RE = /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/;

/** True if an earlier `if (!validator(...).ok) return ...;` guard, within the innermost enclosing
 * top-level function, precedes line `matchIndex` — i.e. the function cannot reach `matchIndex`
 * without that validator call having already passed. */
function hasEnclosingOkGuard(lines, matchIndex) {
  let start = 0;
  for (let j = matchIndex - 1; j >= 0; j--) {
    if (FUNCTION_START_RE.test(lines[j])) { start = j; break; }
  }
  for (let j = start; j < matchIndex; j++) if (OK_GUARD_RE.test(lines[j])) return true;
  return false;
}

/** Scan one source text. Returns violations: [{line, text}] — success literal with no derivation. */
export function scanSource(src, _name = '(inline)') {
  const violations = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) continue; // comments assert nothing
    if (!SUCCESS_WRITES.some((re) => re.test(line))) continue;
    // The statement window: this line ± 2 (multi-line object literals / sh case arms).
    const windowText = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
    if (DERIVATION_MARKERS.some((m) => windowText.includes(m))) continue;
    if (hasEnclosingOkGuard(lines, i)) continue;
    violations.push({ line: i + 1, text: t.slice(0, 160) });
  }
  return violations;
}

const SCAN_DIRS = ['scripts', 'plugin/scripts', 'scripts/git-hooks'];
const EXT = /\.(mjs|cjs|js|sh)$/;
const EXEMPT = new Set([
  // the scanner itself (its pattern table would self-flag) and test fixtures (known-bad lives there)
  'scripts/status-honesty.mjs',
]);

/** Scan the repo. Returns [{file, violations}] for files with hits. */
export function scanRepo(root = ROOT) {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!EXT.test(f)) continue;
      const rel = path.join(dir, f);
      if (EXEMPT.has(rel)) continue;
      const v = scanSource(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
      if (v.length) out.push({ file: rel, violations: v });
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bad = scanRepo();
  if (bad.length) {
    console.error('status-honesty: ASSERTED (underived) terminal success literals found:\n');
    for (const b of bad) for (const v of b.violations) console.error(`  ${b.file}:${v.line}  ${v.text}`);
    console.error('\nA success status must DERIVE from a verifiable artifact (exit code, re-checked branch/comment, re-read file). Name the derivation in the same statement, or record the honest failure.');
    process.exit(1);
  }
  console.log('status-honesty: clean — every terminal success literal is derivation-conditioned.');
}
