// tests/integration/behavioral-l1-l4-levels.test.mjs — scripts/behavioral-l1-l4.mjs had ZERO tests
// across all 18 prior coverage-gap audit passes (memory `test-coverage-gaps-2026-07-07`); it was one
// of the two files explicitly named as "fully open, needs live ONNX+OpenRouter fixtures" since pass 11.
// That's true for L1/L2/L3 (they call searchAll(), which needs KB_MODEL_CACHE + a built .rvf) — but
// L4 shells a real, cheap POSIX shell script (plugin/scripts/ground-ruvnet.sh) with no model/network
// dependency at all, confirmed live: `node scripts/behavioral-l1-l4.mjs --levels L4` completes in
// ~0.15s. So L4 is NOT infra-gated the way L1-L3 are, and is exercised for real below.
//
// SHARPEST FINDING (verified live, not assumed — see the command below): an invalid/unmatched
// `--levels` value produces a false-positive "OVERALL: PASS" with ZERO checks run. Root cause
// (scripts/behavioral-l1-l4.mjs:96,147-167): `allPass` is seeded `true` and only ever set to
// `false` inside the per-level loop; if `LEVELS.has(lvl)` is false for L1-L4 (e.g. a typo'd
// `--levels L5`, or `--levels ''`, since the split has no `.filter(Boolean)` unlike --repos), every
// iteration hits `continue` before `allPass` is ever touched, so it exits 0 printing "OVERALL: PASS"
// having executed nothing. This is the SAME "success that measured nothing" failure class this repo's
// own last commit (26b2b00, "Dogfood metaharness_evolve: three 'success-that-measured-nothing' bugs")
// documents — a 4th, previously undiscovered instance, in the one file no audit pass had opened yet.
// Reproduced live:
//   $ node scripts/behavioral-l1-l4.mjs --levels L5 --dir kb
//   === RuvNet Brain — L1–L4 behavioral harness ===
//   === OVERALL: PASS ===          (exit 0 — no L1/L2/L3/L4 block printed at all)
//
// Flagged, NOT fixed here (product-code change, needs sign-off per this repo's established pattern
// across all 18 prior passes): the fix is to seed `allPass` from whether ANY level actually ran
// (`Object.values(results).some(r => r.length)`), not from a literal `true`, and/or exit non-zero
// with an explicit "0 levels selected" message when --levels matches nothing.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/behavioral-l1-l4.mjs');

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, ''); // G()/R() colorize PASS/FAIL for terminal display

function run(args) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
  return { code: r.status, stdout: stripAnsi(r.stdout || ''), stderr: r.stderr || '' };
}

describe('behavioral-l1-l4.mjs — L4 ORCHESTRATE (real hook, no ONNX/network dependency — runnable now)', () => {
  it('all 4 built-in L4 scenarios pass against the real ground-ruvnet.sh hook', () => {
    const r = run(['--levels', 'L4', '--dir', 'kb']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/PASS\s+L4 ORCHESTRATE\s+\(4\/4\)/);
    expect(r.stdout).toMatch(/newbie "go make magic"/);
    expect(r.stdout).toMatch(/spec → build \(RuvNet-named\)/);
    expect(r.stdout).toMatch(/classical-default drift/);
    expect(r.stdout).toMatch(/pure recall \(no build\)/);
    expect(r.stdout).toMatch(/=== OVERALL: PASS ===/);
  });

  it('only requested levels run — L1/L2/L3 titles never appear when --levels L4 is passed', () => {
    const r = run(['--levels', 'L4', '--dir', 'kb']);
    expect(r.stdout).not.toMatch(/ROUTE/);
    expect(r.stdout).not.toMatch(/DEEP-RECALL/);
    expect(r.stdout).not.toMatch(/IMPLEMENT/);
  });
});

describe('behavioral-l1-l4.mjs — BUG: unmatched --levels silently reports PASS with 0 checks run', () => {
  it('reproduces the false-positive: --levels L5 (typo) exits 0 and prints OVERALL: PASS with no level ran', () => {
    const r = run(['--levels', 'L5', '--dir', 'kb']);
    expect(r.code).toBe(0); // current (buggy) behavior — see file header; should arguably be non-zero
    expect(r.stdout).toMatch(/=== OVERALL: PASS ===/);
    expect(r.stdout).not.toMatch(/ROUTE|DEEP-RECALL|IMPLEMENT|ORCHESTRATE/); // proves zero levels executed
  });

  it('reproduces the same false-positive with an empty --levels string (no .filter(Boolean) on the split, unlike --repos)', () => {
    const r = run(['--levels', '', '--dir', 'kb']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/=== OVERALL: PASS ===/);
    expect(r.stdout).not.toMatch(/ROUTE|DEEP-RECALL|IMPLEMENT|ORCHESTRATE/);
  });
});

// Once the fix above lands (sign-off pending), these should replace the "BUG" describe block above.
describe.todo('behavioral-l1-l4.mjs — desired fix: unmatched --levels must not report a silent PASS', () => {
  it.todo('exits non-zero (or prints an explicit "0 levels selected" warning) when --levels matches none of L1-L4');
  it.todo('an empty --levels string is treated the same as an unmatched value, not silently defaulting to all four');
});

// L1 ROUTE / L2 DEEP-RECALL / L3 IMPLEMENT all call searchAll() (kb/forge-ask-all.mjs), which needs
// KB_MODEL_CACHE pointing at a real ONNX model cache + a built kb/*.rvf — same infra requirement as
// prove.mjs and brain-grade-groundtruth.mjs, so these stay honest .todo skeletons rather than faked.
describe.todo('behavioral-l1-l4.mjs — L1 ROUTE classification logic (lines 106-111, needs live KB_MODEL_CACHE + built .rvf)', () => {
  it.todo('"named" matches the expected repo as a whole word in path/title/first-400-chars of fullText, case-insensitively');
  it.todo('"viaCard" is true only when the #1 hit is a concepts capability-card AND named() is true for the expected repo');
  it.todo('"viaTopic" is true only when the #1 hit is neither the expected repo NOR concepts, but still named() the expected repo (a sibling doc mentioning it)');
  it.todo('"pass" is true iff top.repo===expect OR viaCard OR viaTopic — a hit in an unrelated repo that merely mentions the expected repo\'s name in passing must not false-positive (named() alone is not sufficient, the repo-scoping AND is load-bearing)');
});

describe.todo('behavioral-l1-l4.mjs — L2 CODE_RX classification (line 46, needs live KB_MODEL_CACHE + built .rvf, or export CODE_RX directly for a pure regex test)', () => {
  it.todo('matches Rust fn/impl/struct and JS function/class/export/async/=> — the "this is code, not doc-comment" heuristic');
  it.todo('matches the literal "(full body)" marker some passages carry');
  it.todo('does NOT match ordinary prose that happens to contain the word "class" or "function" without a following space (word-boundary false-positive check, e.g. "classroom" or "functional")');
});

describe.todo('behavioral-l1-l4.mjs — L4 missing/leaked directive diff (lines 140-143, currently inline — extracting as a pure checkDirectives(output, must, mustNot) would make this testable without shelling the real hook)', () => {
  it.todo('case-insensitively finds every required "must" phrase and reports none missing when all are present');
  it.todo('reports every absent "must" phrase by name in the "MISSING:" list, not just a boolean');
  it.todo('reports a "mustNot" phrase that IS present in the "LEAKED:" list (Gate 3 leaking on a pure-recall prompt)');
  it.todo('pass is true only when BOTH missing and leaked are empty — a scenario with zero missing but one leaked phrase must still fail');
});
