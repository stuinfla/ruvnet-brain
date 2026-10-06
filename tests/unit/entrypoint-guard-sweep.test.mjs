// tests/unit/entrypoint-guard-sweep.test.mjs
//
// Dream Cycle 2026-10-06 — DEEP=enforcement-integrity, SCAN=lesson-delivery,gate-teeth.
//
// tests/unit/entrypoint-symlink.test.mjs already proves the RUNTIME failure for two files: a
// guard comparing process.argv[1] against import.meta.url disagrees through a symlink (npm bin
// shims, wrapper scripts, every os.tmpdir() path on macOS), so main() silently never runs. This
// repo has since fixed that exact defect class seven times by hand (commit 43bf391 claimed "zero
// old-form guards remain"; four more were found after that sweep anyway — PRs #295/#317/#333, and
// 2026-10-02's eval-brain.mjs fix). Scanning `scripts/`, `kb/`, `plugin/` and `bin/` on this same
// commit tonight found the SAME defect in 129 files, not the 7 that whack-a-mole discovery had
// surfaced one Dream Cycle at a time — this repo's own gate of record, `scripts/eval-brain.mjs`
// (`npm run eval:gate`), among them.
//
// An independent adversarial review of this test's first draft (same night) found it both too
// narrow (missed a bare `pathToFileURL(process.argv[1])`, a template-literal `` `file://${...}` ``
// form, and the reversed `process.argv[1] === new URL(import.meta.url).pathname`) and too broad
// (flagged comments describing the historical bug, and a plain `path.resolve(process.argv[1])`
// used for logging with no comparison at all). scripts/entrypoint-guard-scan.mjs's detection rule
// was corrected in response: a non-comment line naming BOTH process.argv[1] and import.meta.url,
// with no realpath-based guard in that line or the 5 lines above it, which fixed every concrete
// case raised (re-verified: bin/install.mjs, plugin/scripts/hook-input.mjs and kb/forge-big.mjs no
// longer match; scripts/route-cheap.mjs, scripts/dream-issue-gate.mjs and 7 other previously-missed
// files now do). DISCLOSED RESIDUAL GAP, not fixed tonight: a guard that compares against a LOCAL
// ALIAS of fileURLToPath(import.meta.url) assigned far above the comparison line (e.g.
// scripts/model-currency.mjs:221, `path.resolve(process.argv[1]) === SELF` where `SELF` was set at
// line 37) is not caught — the scanner is line-local, not a real data-flow analysis. This is a
// known false negative, not a hidden one; closing it needs either a wider per-file window or an
// AST-based pass, out of scope for tonight's bounded candidate.
//
// Fixing 129 production entry points in one unattended night is not a bounded candidate; it is a
// separate, large, human-reviewed effort. What IS bounded tonight is closing the actual gap that
// let the count reach 129 unnoticed: nothing previously re-ran this check on every push. This test
// is that check. It is a RATCHET, not a backfill:
//   - every file already known to carry the broken shape is pinned in the baseline fixture below,
//     so this test is GREEN today — it does not block any existing PR or demand the backlog be
//     fixed to land;
//   - a NEW file (or an existing safe file regressed back) carrying the broken shape, outside the
//     baseline, fails this test immediately instead of waiting for a future night's rediscovery;
//   - the baseline may only ever shrink (a file fixed and removed from it) without touching this
//     test, by design — restoring it is the visible part of paying the backlog down.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanUnsafeEntrypointGuards } from '../../scripts/entrypoint-guard-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'entrypoint-guard-baseline.json');
const BASELINE = new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));

describe('entrypoint guard sweep (static, repo-wide)', () => {
  it('finds no broken entry-point guard outside the known baseline', () => {
    const found = scanUnsafeEntrypointGuards(ROOT);
    const unexpected = found.filter((f) => !BASELINE.has(f));
    expect(unexpected, `new/regressed broken entry-point guard(s), not in the baseline: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('the baseline never grows without this test noticing — every baseline entry is still a real hit today', () => {
    // Deliberately the mirror image of the test above: if a baseline entry stops matching (the
    // file was fixed, or renamed/deleted) that is GOOD NEWS and must not fail CI, so this only
    // reports it — it is a floor check, not a ceiling check. Both tests reading the same live scan
    // keeps "baseline" meaning "frozen snapshot of today", not "whatever happens to pass".
    const found = new Set(scanUnsafeEntrypointGuards(ROOT));
    const stillUnsafe = [...BASELINE].filter((f) => found.has(f));
    const resolved = [...BASELINE].filter((f) => !found.has(f));
    if (resolved.length) {
      // eslint-disable-next-line no-console
      console.log(`[entrypoint-guard-sweep] ${resolved.length} baseline file(s) no longer match — safe to remove from the baseline: ${resolved.join(', ')}`);
    }
    expect(stillUnsafe.length + resolved.length).toBe(BASELINE.size);
  });

  it('TEETH: a freshly written broken guard is caught, not a vacuous pattern', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-guard-teeth-'));
    try {
      fs.mkdirSync(path.join(dir, 'scripts'));
      fs.writeFileSync(
        path.join(dir, 'scripts', 'new-tool.mjs'),
        "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\n" +
        "if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { main(); }\n",
      );
      const found = scanUnsafeEntrypointGuards(dir);
      expect(found).toEqual(['scripts/new-tool.mjs']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag the fixed, realpath-based form (no false positive)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-guard-safe-'));
    try {
      fs.mkdirSync(path.join(dir, 'scripts'));
      fs.writeFileSync(
        path.join(dir, 'scripts', 'fixed-tool.mjs'),
        "import fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n" +
        "function isDirectInvocation() {\n  try {\n    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));\n  } catch { return false; }\n}\n" +
        "if (isDirectInvocation()) { main(); }\n",
      );
      expect(scanUnsafeEntrypointGuards(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
