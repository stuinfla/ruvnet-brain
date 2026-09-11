---
id: ADR-079
title: Testing gates and public CI - pre-commit enforcement and visible discipline
status: Proposed
date: 2026-09-11
authors: [Stuart Kerr, Codex]
tags: [architecture, testing, ci, gates, enforcement, coverage, performance, visibility]
supersedes: []
relates: [ADR-009, ADR-012, ADR-020, ADR-034, ADR-055, ADR-061, ADR-069, ADR-070, ADR-072, ADR-075, ADR-076, ADR-077, ADR-078]
governs:
  - tests/
  - .github/workflows/tests.yml
  - .github/workflows/performance.yml
  - scripts/gate-runner.mjs
  - scripts/coverage-report.mjs
  - scripts/performance-baseline.mjs
  - vitest.config.js
  - jest.config.js
---

# ADR-079 — Testing gates and public CI: pre-commit enforcement and visible discipline

**Status**: Proposed (2026-09-11)

## Context

Quality gates today are fragmented:

1. **No pre-commit checks**: Broken tests can be committed locally
2. **No unified gate runner**: Tests run in multiple ways (vitest, jest, npm test)
3. **No coverage gate**: Coverage can drop without causing CI failure
4. **No performance baseline**: Regressions are discovered post-ship
5. **CI results are hidden**: Only visible in GitHub UI; no public build status page
6. **No test traceability**: Test results don't link back to requirements (ADRs, issues)

The result is that a feature can ship with broken tests if the developer skips `npm test` before pushing. The North Star path requires:

1. **Pre-commit enforcement**: No commit is possible if any test fails
2. **Public CI status**: Every PR shows live test results with pass/fail indicators
3. **Coverage gates**: Pull coverage below threshold blocks merge
4. **Performance gates**: Benchmarks show regression risk before ship
5. **Test traceability**: Every test links to the requirement it validates

## Decision

Implement three-tier testing gates with public CI visibility:

### 1. Pre-Commit Local Gates (Blocking)

Every commit runs a fast gate before the commit is created. Fails immediately if any check fails.

**Gate sequence** (priority order; stops at first failure):

1. **Syntax check** (~1s): JavaScript/TypeScript parse
2. **Lint** (~2s): ESLint on changed files only (not full repo)
3. **Unit tests** (~8s): vitest on affected tests only
4. **Type check** (~3s): tsc on changed files only
5. **Security scan** (~2s): npm audit (known vulnerabilities only)

**File**: `.git/hooks/pre-commit` (installed by `npm run setup`)  
**Implementation**: `scripts/gate-runner.mjs`  
**Total time**: <20s (most commits)  
**Failure output**: Single culprit highlighted + remediation step

Example:
```
❌ Pre-commit gate FAILED

  Unit test failed:
  tests/unit/memory-full-integration.test.mjs › session recall

    AssertionError: expected undefined to equal "2026-09-11T14:30:00Z"

  Fix: npm test -- --run tests/unit/memory-full-integration.test.mjs
       (or rollback the change)

Commit blocked. Fix the test and try again.
```

**Zero bypass**: No `--no-verify` flag is allowed. If a developer needs to bypass, they must pass a signed `-B` flag with an explicit ADR reason.

### 2. PR GitHub Actions Gates (Visible + Blocking)

Every PR runs the full test matrix in parallel on GitHub Actions. Results are displayed as status checks + badge on PR.

**Full test matrix**:
- Unit tests (vitest): all files
- Integration tests (jest): all integration suites
- Build verification: TypeScript compile + production build
- Coverage report: generate HTML, post artifact link to PR
- Performance benchmark: compare against baseline
- ADR/DDD gates: verify consistency (ADR-077)
- Documentation: verify links, check for broken references

**File**: `.github/workflows/tests.yml`  
**Trigger**: On every push to PR  
**Execution**: ~2 minutes (parallel jobs)  
**Results display**:
  - Pass/fail badges in PR description
  - Coverage % comment on PR
  - Performance delta linked in PR
  - Full logs available as artifacts

Example PR comment:
```
### Test Results

| Gate | Status | Details |
|------|--------|---------|
| **Lint** | ✅ | 0 violations |
| **Unit Tests** | ✅ | 142 passed in 3.2s |
| **Integration** | ✅ | 18 passed in 4.1s |
| **Build** | ✅ | Production build successful |
| **Coverage** | ✅ | 89.4% (+1.2% vs main) |
| **Performance** | ⚠️ | +3.2% latency (alert-level: <5%) |
| **ADR Gates** | ✅ | All ADRs consistent |

**Performance Note**: Memory snapshot test 3.2% slower. Confirm this is expected or investigate before merge.
```

**Merge blocking**: PR cannot be merged if any gate fails (enforced by branch protection rule).

### 3. Public CI Status Page

Maintain a public build status page at `/public/ci-status/` showing:
- Latest build status (green/yellow/red)
- Test results summary (passed/failed/skipped)
- Coverage trend (last 30 days)
- Performance trend (last 30 days)
- Release calendar (next release date, blocked by gate failures)

**File**: `scripts/ci-status-publish.mjs`  
**Updates**: After every workflow completion  
**Location**: Deployed to Vercel under `/public/ci-status/index.html`  
**Refresh rate**: Real-time (via GitHub Releases webhook)

Example page:
```
RuvNet Brain — CI Status

┌─────────────────────────────────────────┐
│ Latest Build: ✅ PASSING (2026-09-12)    │
├─────────────────────────────────────────┤
│ Commit: abc123def456 (feat/adr-076)     │
│ Branch: release/4.3.19                  │
│ Started: 14:22:03 UTC                   │
│ Duration: 2m 34s                        │
└─────────────────────────────────────────┘

Test Results
  ✅ Unit Tests .......... 142/142 passed
  ✅ Integration Tests ... 18/18 passed
  ✅ Build ............... Success
  ✅ Coverage ............ 89.4% (target: 85%)
  ⚠️  Performance ........ +3.2% latency

Coverage Trend (30d)
  Day 1:  85.1%
  Day 7:  86.2%
  Day 14: 87.9%
  Day 30: 89.4% ✓ (trending up)

Release Calendar
  v3.4.19 blocked by: (none)
  Scheduled: 2026-09-12 18:00 UTC
  Status: READY TO SHIP ✅
```

### 4. Coverage Gates

Coverage must not decrease below thresholds:
- **Overall**: 85% minimum (currently: 89.4%)
- **Statements**: 85% minimum
- **Branches**: 80% minimum
- **Functions**: 85% minimum
- **Lines**: 85% minimum

Every PR shows coverage delta. If coverage drops, the PR cannot be merged until tests are added.

**File**: `scripts/coverage-report.mjs`  
**Runs at**: End of unit test phase  
**Output**: HTML artifact + PR comment with delta  
**Block merge**: If any threshold is breached

Example PR comment:
```
### Coverage Report

**Baseline (main)**: 89.4% | **PR**: 87.8% | **Delta**: -1.6% ❌

| Metric | Threshold | PR | Status |
|--------|-----------|----|----|
| Statements | 85% | 87.1% | ✅ |
| Branches | 80% | 77.9% | ❌ BELOW |
| Functions | 85% | 88.3% | ✅ |
| Lines | 85% | 87.8% | ✅ |

❌ **Coverage decreased. Merge blocked.**

Fix: Add tests for branching in `src/memory-store.ts` (7 untested branches)
```

### 5. Performance Baseline and Regression Detection

Maintain a performance baseline for key operations. Every PR compares against baseline and fails if regression exceeds threshold (5%).

**Benchmarked operations**:
- Memory session recall: <2s
- ADR validation gate: <1s
- Release gate execution: <5s
- GitHub API queries: <1s per 10 calls
- Test suite execution: <15s

**File**: `scripts/performance-baseline.mjs`  
**Baseline storage**: `.github/performance-baseline.json`  
**Runs at**: End of build phase  
**Comparison**: Current commit vs baseline

Example baseline:
```json
{
  "timestamp": "2026-09-11T12:00:00Z",
  "baselines": {
    "memory-session-recall": { "value": 1850, "unit": "ms", "threshold": 2000 },
    "adr-validation-gate": { "value": 890, "unit": "ms", "threshold": 1000 },
    "release-gate-execution": { "value": 4200, "unit": "ms", "threshold": 5000 },
    "github-api-query-time": { "value": 800, "unit": "ms", "threshold": 1000 },
    "test-suite-execution": { "value": 12400, "unit": "ms", "threshold": 15000 }
  }
}
```

### 6. Test Traceability (Tests Link to Requirements)

Every test file must declare which ADR/issue/requirement it validates. Tests are grouped by requirement.

**Test structure**:
```javascript
// tests/unit/memory-full-integration.test.mjs
import { describe, it, expect } from 'vitest';
import { test, tag } from '#test-utils';

/**
 * @requirement ADR-076: Memory full integration
 * @issue #142: Session-start recall not working
 * @category critical-path
 */

describe('Memory full integration — ADR-076', () => {
  // All tests in this describe block are tagged @requirement ADR-076
  
  describe('Session-start recall', () => {
    it('should surface last 3 checkpoints at session start', async () => {
      const checkpoints = await recall.lastCheckpoints(3);
      expect(checkpoints).toHaveLength(3);
      expect(checkpoints[0].timestamp).toBeDefined();
    });
    
    it('should include open issues in checkpoint', async () => {
      const checkpoint = await recall.latestCheckpoint();
      expect(checkpoint.openIssues).toBeDefined();
      expect(checkpoint.openIssues.length).toBeGreaterThan(0);
    });
  });
  
  describe('Decision ledger', () => {
    it('should store decision with reason and alternatives', async () => {
      const decision = await memory.storeDecision({
        type: 'adr',
        reason: 'unlock 95/100 path',
        alternatives: ['use redis', 'use jsonl only']
      });
      expect(decision.key).toMatch(/^decision:/);
      expect(decision.timestamp).toBeDefined();
    });
  });
});
```

**Test report** includes traceability matrix:
```
Test Coverage by Requirement

ADR-076 (Memory full integration) ........... 8/8 tests passing (100%)
  ├─ Session-start recall .................. 4/4 ✅
  └─ Decision ledger ....................... 4/4 ✅

ADR-077 (Continuity gates) ................. 6/7 tests passing (86%) ⚠️
  ├─ ADR state consistency ................. 3/3 ✅
  ├─ Supersession audit .................... 2/2 ✅
  └─ Governed file enforcement ............. 1/2 ❌ (needs Windows test)

Issue #142 (Session recall failing) ........ 4/4 tests passing (100%) ✅

Coverage: 18/19 tests passing (95%)
Blocker: ADR-077 incomplete on Windows (skip for now, priority: medium)
```

## Consequences

### Pillar Gains

1. **Test Discipline**: 0 → 25 (pre-commit enforced, no bypass without reason)
2. **PR Quality**: 0 → 20 (full test matrix visible, blocking merge)
3. **Coverage**: 0 → 15 (gates prevent regression)
4. **Performance Safety**: 0 → 15 (regressions caught before ship)
5. **Public Accountability**: 0 → 10 (CI status page is visible)
6. **Test Traceability**: 0 → 10 (every test links to requirement)

### Effort

- **Pre-commit hook integration**: 1 day (gate-runner.mjs, efficient affected-tests)
- **GitHub Actions workflow**: 1 day (tests.yml, parallel matrix, result posting)
- **Coverage reporting**: 1 day (coverage-report.mjs, HTML artifact, PR comment)
- **Performance baseline**: 1 day (performance-baseline.mjs, regression detection)
- **CI status page**: 0.5 day (ci-status-publish.mjs, Vercel deployment)
- **Test traceability infra**: 0.5 day (test-utils, @requirement decorator, report generation)

### Timeline

- Week 1: Pre-commit gates + gate runner (test locally, verify blocking works)
- Week 2: GitHub Actions workflows (matrix config, PR status checks)
- Week 3: Coverage + performance gates (baselines, regression detection)
- Week 4: CI status page + test traceability (public visibility, requirement linking)

## Implementation

### Files to Create

1. **`scripts/gate-runner.mjs`** (200 lines)
   - Detect changed files (git diff)
   - Run only affected tests (vitest --changed)
   - Lint changed files only (eslint --fix-dry-run)
   - Type check changed files (tsc --noEmit --pretty)
   - Fail fast on first error
   - Test: `tests/unit/gate-runner.test.mjs`

2. **`.git/hooks/pre-commit`** (80 lines)
   - Install by `npm run setup`
   - Call gate-runner.mjs
   - Exit 0 if all pass, exit 1 if any fail
   - Support `-B` flag for explicit bypass (with reason)

3. **`.github/workflows/tests.yml`** (180 lines)
   - Parallel jobs: lint, unit, integration, build, coverage, performance
   - Post results as PR status checks
   - Upload coverage HTML artifact
   - Comment on PR with results

4. **`scripts/coverage-report.mjs`** (150 lines)
   - Generate coverage report (vitest --coverage)
   - Calculate delta vs baseline
   - Post PR comment with table + delta
   - Exit 1 if below threshold

5. **`scripts/performance-baseline.mjs`** (160 lines)
   - Run benchmark suite
   - Compare against `.github/performance-baseline.json`
   - Detect regressions (>5%)
   - Post to PR with delta
   - Update baseline if approved

6. **`scripts/ci-status-publish.mjs`** (120 lines)
   - Listen for GitHub Actions workflow completion webhook
   - Build status page HTML
   - Deploy to Vercel under `/public/ci-status/`
   - Update every 5 minutes with latest status

7. **`tests/test-utils.mjs`** (80 lines)
   - Export `test` and `tag` utilities
   - `@requirement` decorator support
   - Test grouping by requirement
   - Traceability report generation

### Hook Registration

Add to `plugin/hooks/hooks.json`:
```json
{
  "pre:commit": "node scripts/gate-runner.mjs"
}
```

### Acceptance Criteria

1. **Pre-commit blocks broken tests**: `git commit` fails if any test fails (takes <20s)
2. **PR shows test results**: Status checks appear in PR within 2 minutes
3. **Merge blocked on failure**: PR cannot be merged if tests fail
4. **Coverage delta visible**: PR comment shows % change, blocks if below threshold
5. **Performance regression detected**: PR shows if operation is >5% slower
6. **CI status page updates**: Public page reflects latest build status in <5 minutes
7. **Test traceability works**: Test report shows requirement mapping, coverage % per ADR

### Git Commands

```bash
# Create implementation branch
git checkout -b feat/adr-079-testing-gates

# Create all files
git add scripts/gate-runner.mjs \
         scripts/coverage-report.mjs \
         scripts/performance-baseline.mjs \
         scripts/ci-status-publish.mjs \
         .git/hooks/pre-commit \
         .github/workflows/tests.yml \
         .github/performance-baseline.json \
         tests/test-utils.mjs \
         tests/unit/gate-runner.test.mjs \
         docs/adr/0079-testing-gates-and-public-ci.md

git commit -m "ADR-079: Testing gates and public CI enforcement

Implement three-tier testing gates:
1. Pre-commit local gates (blocking): syntax, lint, unit, type, security
2. PR GitHub Actions gates (visible): full matrix, coverage, performance, ADR
3. Public CI status page: real-time build status, trends, release readiness

Gates:
  - Pre-commit: <20s, fails fast, zero bypass
  - PR: 2 min execution, blocks merge on failure
  - Coverage: 85% minimum threshold, tracks delta
  - Performance: 5% regression threshold, tracks baseline
  - Test traceability: every test linked to ADR/issue, coverage % per requirement

Timeline: 4 weeks (gates → workflows → reporting → traceability)
Acceptance: pre-commit blocks bad tests, PR shows results, CI page public"

# Verify setup
npm run setup  # installs pre-commit hook

# Test pre-commit hook
echo "broken code" >> src/test.ts
npm run build  # fail
git add src/test.ts
git commit -m "test"  # should be blocked by pre-commit gate

# Verify tests pass before committing for real
npm test
```

## Alternatives Considered

### A. GitHub-only gates (no pre-commit, rejected)
- Developers can commit broken code locally
- Feedback cycle is slower (wait for CI)
- No prevention of push if tests fail

### B. Slack notifications only (no public page, rejected)
- Status is invisible to public
- Noise: frequent Slack messages
- No historical trend data

### C. Manual performance review (no automation, rejected)
- Regressions discovered post-ship
- No baseline enforcement
- Easy to skip under time pressure

## Success Metrics (95/100+ North Star)

- Pre-commit gates catch breakage (+15 points)
- PR results are visible and blocking (+15 points)
- Coverage regression is prevented (+10 points)
- Performance regression is prevented (+10 points)

**Total unlock**: +50 points toward 95/100
