// tests/integration/forge-guard-fence.test.mjs — kb/forge-guard.mjs is the safety net built AFTER a
// truncated-passage bug already shipped once (see PROGRESS.md history). The catcher itself has never
// been tested to prove it actually catches anything (memory `test-coverage-gaps-2026-07-07`).
//
// WHY SUBPROCESS: forge-guard.mjs's main() runs unconditionally at module top level
// (`main().catch(...)`, last line of the file) and calls process.exit() — importing it would run a
// real CLI invocation with whatever argv the test runner happens to have and then kill the process.
// dir/name/variant ARE plain function params (not hardcoded like build-bundle.mjs's KB constant), so
// unlike that gap, no cloned-ROOT trick is needed here — just point --dir at a temp fixture.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function runGuard(args) {
  const r = spawnSync('node', [path.join(REPO_ROOT, 'kb/forge-guard.mjs'), ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('forge-guard.mjs — MISSING file detection (runnable now, no store fixture needed)', () => {
  it('FAILs and exits non-zero when the .rvf/.passages.jsonl/.meta.json trio is entirely absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-missing-'));
    const r = runGuard(['--dir', dir, '--name', 'nonexistent-kb']);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/MISSING file: nonexistent-kb\.rvf/);
    expect(r.stdout).toMatch(/MISSING file: nonexistent-kb\.passages\.jsonl/);
    expect(r.stdout).toMatch(/=== OVERALL: FAIL ===/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints a clear usage error and exits 2 when --dir/--name are omitted', () => {
    const r = runGuard([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Usage: node forge-guard\.mjs/);
  });
});

// The remaining checkStore() branches — PARITY (passages count vs meta count), TRUNCATION (the
// original clipped-at-200/240-char bug this guard exists to catch), and LIVE QUERY (a real
// searchKb() call against the store) — all need an actual queryable .rvf + matching
// passages.jsonl/meta.json trio, not just placeholder files (unlike build-bundle.mjs's
// filename-only discovery, forge-guard genuinely reads and parses store contents). Building one
// requires the real embedding pipeline (kb/forge-build.mjs, local MiniLM via
// @xenova/transformers, needs KB_MODEL_CACHE pointed at an existing model cache — e.g. the one
// documented in MEMORY.md's dogfood snippet) against a tiny 2-3 file fixture repo. That's a
// legitimate but heavier prerequisite than a "skeleton" should silently assume is free, so it's
// left as `it.todo` with the exact setup spelled out rather than faked.
describe.todo('forge-guard.mjs — checkStore() parity/truncation/live-query (needs a real built fixture store)', () => {
  it.todo('flags PARITY when passages.jsonl line count != meta.json entry count');
  it.todo('flags TRUNCATION when >MAX_CAP_FRACTION of passages sit at the legacy 200/240-char cap AND equal their own preview (the original bug this guard was built to catch)');
  it.todo('flags TRUNCATION when any passage is empty or shorter than its own preview');
  it.todo('flags "LIVE QUERY returned 0 hits" when searchKb() can find nothing with real text for a generic query');
  it.todo('PASSes cleanly (fails: [], notes: [...]) against a genuinely well-formed small fixture store');
});
