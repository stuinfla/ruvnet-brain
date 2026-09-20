import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Dream Cycle 2026-09-20 (cross-host-conformance / stranger-project-behaviour).
//
// `release-candidate-preflight.yml`'s `stranger` job (and the three `early-public-*` jobs) declare
// `needs: ci`. GitHub Actions' default job condition is `success()`, so when `ci` fails, `stranger`
// is SKIPPED, not run and not failed. `aggregate` in turn `needs: [ci, integration, ux, stranger, ...]`
// with no `if:` override, so a skipped `stranger` cascades into a skipped `aggregate` too — the whole
// workflow ends in a page of grey "skipped" checks, never a red one.
//
// This is not hypothetical: commit 965ee55c (2026-09-15) records that `stranger` "had been SKIPPED
// for a month behind a red `ci` job" before anyone noticed the selfcheck defect it exists to catch.
// The root cause that commit fixed was the selfcheck defect itself; it did not touch this dependency
// structure, so the same silent-skip cascade can recur the next time `ci` goes red for any reason.
//
// `aggregate` must therefore run unconditionally (`if: always()`, at JOB level — a step-level
// `always()` would not save it from being skipped in the first place) and its first step must fail
// the job loudly — a non-zero exit — whenever any required lane's result is not `success`, converting
// a silent skip cascade into a visible, red failure.
const ROOT = path.resolve(import.meta.dirname, '../..');
const WORKFLOW_PATH = '.github/workflows/release-candidate-preflight.yml';
const source = fs.readFileSync(path.join(ROOT, WORKFLOW_PATH), 'utf8');

function jobBlock(name) {
  const match = source.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|$)`));
  return match?.[1] ?? '';
}

describe('release-candidate-preflight aggregate has teeth against a silent skip cascade', () => {
  it('runs aggregate unconditionally, at job level, so a skipped upstream lane cannot skip it too', () => {
    const aggregate = jobBlock('aggregate');
    expect(aggregate, 'aggregate job must exist').toBeTruthy();
    // Exactly 4-space indent: a JOB-level property (sibling to `runs-on:`/`needs:`), not a step
    // buried under `steps:` at 6-space indent — a regression that mis-indents `if: always()` onto
    // one step rather than the job would still leave the job itself skippable.
    expect(aggregate).toMatch(/^ {4}if: always\(\)$/m);
  });

  it('fails loudly, not silently, when any required lane did not succeed', () => {
    const aggregate = jobBlock('aggregate');
    // Steps live under `steps:` at 6-space indent (`      - name:` / `      - uses:`); split on
    // that exact indent so the guard step is actually isolated, not the whole job block.
    const steps = aggregate.split(/\n(?=\s{6}-\s+(?:name|uses):)/);
    const guardStep = steps.find((step) => step.includes('needs.*.result'));
    expect(guardStep, 'a step referencing needs.*.result must exist').toBeTruthy();
    // Must actually fail the job (non-zero exit) rather than merely logging.
    expect(guardStep).toMatch(/exit 1/);
    // Never interpolate `toJSON(needs)` directly into a shell string (the injection anti-pattern
    // `tests/unit/release-evidence-dag.test.mjs` already forbids for `NEEDS_JSON`) — pass it
    // through `env:` and reference it as a shell variable instead.
    expect(guardStep).not.toMatch(/echo\s+['"].*\$\{\{\s*toJSON\(needs\)\s*\}\}/);
    expect(guardStep).toMatch(/env:\s*\n\s+NEEDS_JSON:\s*\$\{\{\s*toJSON\(needs\)\s*\}\}/);
    expect(guardStep).toMatch(/\$NEEDS_JSON/);
  });

  it('the guard step runs before any artifact download that would otherwise fail with a confusing error', () => {
    const aggregate = jobBlock('aggregate');
    const guardIndex = aggregate.indexOf('needs.*.result');
    const firstDownloadIndex = aggregate.indexOf('download-artifact');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(firstDownloadIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstDownloadIndex);
  });
});
