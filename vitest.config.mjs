import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // This suite launches many real Git, shell, Codex, and Ruflo subprocesses. Unbounded file
    // parallelism starves the very watchdogs and latency probes the tests are measuring: the same
    // files pass alone, while the default full run produced ten timeout/latency failures. Five
    // workers still pushed a held-open-stdin probe past its 5s contract; two workers still made the
    // fourth-wall p95 exceed 2x its ceiling. Serialize files so the suite measures product work,
    // not competition from another subprocess-heavy test file.
    maxWorkers: 1,
    include: [
      'tests/unit/**/*.test.mjs', 'tests/integration/*.test.mjs', 'tests/mutation/*.test.mjs',
      // ADR-058 §D7: the interface-gate incident corpus. Listed here AND given its own npm script
      // (test:regression) AND its own CI step — tests/mutation/*.test.mjs sat in this same include
      // array for days with no script and no CI step ever invoking it (see the CI comment on the
      // "Mutation tests" step), so being listed here is necessary but was already PROVEN insufficient
      // once on this exact file; the corpus is not considered wired until its CI step is green.
      'tests/regression/*.test.mjs',
      // Release-critical agentic QE must be part of the ordinary runner. A file that exists under
      // tests/qe but is absent from this include list is silently ignored even when its path is
      // supplied on the command line — the exact vacuous-green failure this suite is meant to stop.
      'tests/qe/**/*.test.mjs',
      // Real-host closure for reopened GitHub issues. These tests exercise installed Codex and
      // browser boundaries and must not become invisible merely because they live outside unit/QE.
      'tests/acceptance/*.test.mjs',
      // ADR-058 D5: the coexistence suite. Same lesson, stated twice on one file in one night —
      // a directory absent from `include` is invisible to `vitest run` no matter what any npm
      // script or CI step claims to run.
      'tests/mesh/*.test.mjs',
    ],
    // Windows runners spawn processes MUCH slower than macOS/Linux (Git Bash startup dominates), and
    // a large slice of this suite deliberately exercises real shell hooks as subprocesses rather than
    // mocking them. vitest's 5s default is marginal there — hook-battery and token-meter timed out on
    // 2026-07-13 with no logic change, pure spawn latency. The assertions are about BEHAVIOUR, not
    // speed, so the honest fix is a timeout that fits the platform, not a weaker test.
    //
    // POSIX 10_000 → 20_000 (2026-07-27): the same rule, applied a second time for the same reason.
    // tests/unit/selfcheck-battery.test.mjs (the post-install hook battery, ADR-053 §2) adds ~19 real
    // process spawns, and it tipped two already-marginal neighbours — hook-battery and
    // verify-interface — into `Test timed out in 10000ms`. MEASURED as a clean A/B on one machine:
    // the full suite WITHOUT that file failed only the 5 expected machine-local hook-registry-lint
    // reds; WITH it, those same 5 plus 3 pure-timeout failures and ZERO assertion failures. Both
    // neighbours pass when run alone. So this is spawn latency, exactly as in 2026-07-13, not a
    // regression — and a weaker test would be the wrong fix.
    //
    // Why raising this does NOT re-hide a real hang: hangs are no longer detected by vitest's clock.
    // selfcheck.mjs asserts each hook against its OWN declared timeout using an external
    // process-group watchdog, so a hook that hangs now fails by CONTRACT with a named budget,
    // whichever way this number moves.
    testTimeout: process.platform === 'win32' ? 30_000 : 20_000,
    hookTimeout: process.platform === 'win32' ? 30_000 : 20_000,
    coverage: {
      provider: 'v8',
      // ADR-0011 Phase 0: measure ALL shipped source, not a flattering 8-file subset. `all: true`
      // counts files no test ever imports at 0% — that zero is the honest truth, not a regression.
      all: true,
      // ADR-0011 Phase 1: the denominator is ALL first-party source — scripts/, kb/, bin/, and the
      // shipped plugin MCP server. plugin/test/run-tests.mjs is the plugin's own test battery and
      // kb/test-guard-injection.mjs is a test script (both run directly in CI), so they are test
      // code, not source — excluded from the denominator like tests/.
      // The visual console is shipped product code too. Omitting it let source-string assertions
      // look green while the browser behavior itself contributed nothing to the release denominator.
      include: ['scripts/**/*.mjs', 'kb/*.mjs', 'bin/*.mjs', 'plugin/mcp/*.mjs', 'console/**/*.js'],
      exclude: ['kb/node_modules/**', 'kb/clones/**', 'kb/test-guard-injection.mjs'],
      // json-summary writes coverage/coverage-summary.json, which scripts/claims-verify.mjs's
      // verifyCoverageBadge RE-DERIVES the README badge % from (it no longer string-matches a
      // hardcoded "10%" needle — a gate that can't fail isn't a gate). ADR-0020.
      reporter: ['text-summary', 'lcov', 'json-summary'],
      // WHY (2026-07-26, measured): vitest's default is `reportOnFailure: false`, and its coverage
      // provider does `if (!this.options.reportOnFailure) await this.cleanAfterRun()` — so ANY run
      // with a failing test wipes coverage/ and writes NOTHING. That is how the honesty gate ended up
      // grading a nine-day-old summary and then, once the file was gone, grading nothing at all while
      // still being asked for a number. The measurement is not the pass/fail verdict: coverage of a
      // red run is still a real measurement of what executed, and whether it may be quoted is decided
      // by claims-verify's freshness precondition, not by silently deleting the evidence.
      reportOnFailure: true,
      // Regression floor: CI fails below these. Set to the measured value ROUNDED DOWN (see the
      // commit that changed this line for the measured values). Raise as coverage grows; never
      // lower silently.
      thresholds: { statements: 26, lines: 28, branches: 26, functions: 31 },
    },
  },
});
