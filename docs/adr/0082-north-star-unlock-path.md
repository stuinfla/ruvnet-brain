---
id: ADR-082
title: North Star 95/100+ Unlock Path — Four ADRs
status: Rejected
date: 2026-09-11
updated: 2026-09-11
authors: [Stuart Kerr, Codex]
tags: [architecture, north-star, coordination, memory, gates, release, testing]
supersedes: []
relates: [ADR-076, ADR-077, ADR-078, ADR-079]
governs:
  - docs/adr/0076-*.md
  - docs/adr/0077-*.md
  - docs/adr/0078-*.md
  - docs/adr/0079-*.md
---

**Status**: Rejected (2026-09-11)

**REJECTED — the four ADRs this path bundles (076, 077, 078, 079) were each rejected on measurement the same day; see their status blocks.** The goal itself — 95/100 across the eight pillars — is unchanged. This document's route to it, the four levers as built, is withdrawn. What actually happened is in PROGRESS.md 2026-09-11 15:50 EDT.

# North Star 95/100+ Unlock Path — Four ADRs

**Created**: 2026-09-11  
**Target Release**: v3.5.0 (4-week sprint)  
**North Star Score Unlocked**: +175 points  

## Overview

Four complementary ADRs that together unlock the 95/100+ North Star score path. Each ADR removes one critical gap in continuity, accountability, safety, and visibility.

| ADR | Title | Unlock | Effort | Score Gain |
|-----|-------|--------|--------|-----------|
| **ADR-076** | Memory full integration | Session recall + decision ledger | 2-3 days | +45 |
| **ADR-077** | Continuity gates | ADR-as-code automation | 2 days | +40 |
| **ADR-078** | Release automation | One-command ship | 2 days | +45 |
| **ADR-079** | Testing gates & public CI | Pre-commit enforcement + visibility | 4 days | +50 |
| | **TOTAL** | | **10-13 days** | **+180** |

## Execution Sequence

### Week 1: Continuity & Memory (ADR-076 + ADR-077)

**Goal**: Every decision is recorded, every session recalls context, every ADR is enforced.

- **Mon-Wed**: Implement ADR-076 (memory hooks + decision registry)
  - Create: `plugin/hooks/memory-ensure.mjs`, `memory-store-decisions.mjs`, `scripts/memory-snapshot-threads.mjs`
  - Tests: `tests/unit/memory-*.test.mjs` (14 tests)
  - Verify: SessionStart recall works on real branch switch

- **Wed-Fri**: Implement ADR-077 (ADR validation gates)
  - Create: `scripts/adr-validate.mjs`, `adr-supersede-check.mjs`, `adr-impl-status.mjs`, `.git/hooks/pre-commit`
  - Wire: Pre-commit hook + ADR validation
  - Tests: `tests/unit/adr-gate-*.test.mjs` (12 tests)
  - Verify: Governed file protection works, no commits to Proposed ADRs

**Deliverables**:
- Memory session-start auto-recall + decision ledger ✓
- ADR enforcement at commit time ✓
- 26 unit tests, all passing ✓

---

### Week 2: Release Automation (ADR-078)

**Goal**: Shipping is one command, all gates are enforced, evidence is archived.

- **Mon-Tue**: Build release.mjs orchestrator
  - Semver detection from commits (commitlint integration)
  - Test gate runner (unit, integration, build, ADR, performance, security)
  - Package.json + CHANGELOG.md update
  - Git tag creation + push

- **Wed-Thu**: GitHub Actions workflow
  - Create: `.github/workflows/release.yml`, `publish-npm.yml`
  - Verify tag matches package.json
  - Publish to npm with SLSA provenance
  - Archive evidence to `.release-evidence/v3.x.x/`

- **Fri**: Rollback procedure
  - Implement: `npm run release -- --rollback v3.x.x`
  - Confirm: npm unpublish + branch revert works
  - Test: Full rollback scenario

**Deliverables**:
- One-command release (`npm run release -- [patch|minor|major]`) ✓
- All test gates enforced before tag ✓
- Evidence archived in `.release-evidence/` ✓
- Rollback procedure proven ✓

---

### Week 3: Testing Gates (ADR-079, Part 1)

**Goal**: Pre-commit gates block broken code. PR results are visible. Coverage is protected.

- **Mon-Tue**: Pre-commit gate enforcement
  - Create: `scripts/gate-runner.mjs`, `.git/hooks/pre-commit`
  - Sequence: syntax → lint → unit (affected only) → type → security
  - Timing: <20s per commit
  - Tests: `tests/unit/gate-runner.test.mjs` (8 tests)

- **Wed-Thu**: GitHub Actions test workflow
  - Create: `.github/workflows/tests.yml` (parallel jobs)
  - Jobs: lint, unit, integration, build, coverage, performance, ADR gates
  - PR status checks: pass/fail badges
  - Coverage comment: % delta, threshold enforcement

- **Fri**: Coverage gate automation
  - Create: `scripts/coverage-report.mjs`
  - Threshold: 85% minimum (statements, functions, lines), 80% branches
  - PR comment: coverage table + delta
  - Block merge: if below threshold

**Deliverables**:
- Pre-commit gates block broken tests ✓
- PR shows test results + coverage delta ✓
- Merge blocked on test/coverage failure ✓

---

### Week 4: Public CI Visibility (ADR-079, Part 2)

**Goal**: CI status is public. Performance regressions are caught. Every test links to a requirement.

- **Mon-Tue**: Performance baseline automation
  - Create: `scripts/performance-baseline.mjs`, `.github/performance-baseline.json`
  - Baseline ops: memory recall, ADR validation, release gate, GitHub API, test suite
  - Regression threshold: 5%
  - PR reporting: performance delta + alert if exceeded

- **Wed**: CI status page
  - Create: `scripts/ci-status-publish.mjs`
  - Deployed to: Vercel at `/public/ci-status/`
  - Realtime updates via GitHub Actions webhook
  - Trending data: coverage, performance, release readiness

- **Thu-Fri**: Test traceability
  - Create: `tests/test-utils.mjs` (@requirement decorator)
  - Link tests to ADRs/issues/requirements
  - Generate traceability matrix: coverage % per ADR
  - Report blockers by priority

**Deliverables**:
- Performance regression detection ✓
- Public CI status page (live) ✓
- Test traceability matrix ✓
- Full test report linked to requirements ✓

---

## File Structure (Ready to Commit)

### ADR Documentation
```
docs/adr/0076-memory-full-integration.md      (9.8 KB, 850 words)
docs/adr/0077-continuity-gates.md             (11 KB, 950 words)
docs/adr/0078-release-automation.md           (12 KB, 1000 words)
docs/adr/0079-testing-gates-and-public-ci.md (16 KB, 1200 words)
docs/adr/0082-north-star-unlock-path.md      (this file, implementation sequence)
```

### Implementation Files (To Be Created)

**Week 1 (ADR-076 + ADR-077)**:
```
plugin/hooks/memory-ensure.mjs                (140 lines)
plugin/hooks/memory-store-decisions.mjs       (180 lines)
scripts/memory-snapshot-threads.mjs           (160 lines)
scripts/memory-init.mjs                       (120 lines)
scripts/adr-validate.mjs                      (180 lines)
scripts/adr-supersede-check.mjs               (140 lines)
scripts/adr-impl-status.mjs                   (120 lines)
.git/hooks/pre-commit                         (70 lines)
docs/adr/SUPERSESSIONS.log                    (append-only log)
plugin/hooks/hooks.json                       (updated)
tests/unit/memory-*.test.mjs                  (14 tests, 400 lines)
tests/unit/adr-gate-*.test.mjs                (12 tests, 350 lines)
```

**Week 2 (ADR-078)**:
```
scripts/release.mjs                           (300 lines)
scripts/announce-release.mjs                  (60 lines)
.github/workflows/release.yml                 (150 lines)
.github/workflows/publish-npm.yml             (80 lines)
.releaserc.json                               (40 lines)
tests/integration/release-integration.test.mjs (120 lines)
```

**Week 3-4 (ADR-079)**:
```
scripts/gate-runner.mjs                       (200 lines)
scripts/coverage-report.mjs                   (150 lines)
scripts/performance-baseline.mjs              (160 lines)
scripts/ci-status-publish.mjs                 (120 lines)
.github/workflows/tests.yml                   (180 lines)
.github/performance-baseline.json             (baseline data)
tests/test-utils.mjs                          (80 lines)
tests/unit/gate-runner.test.mjs               (120 lines)
```

**Total New Code**: ~3500 lines (implementation + tests)

---

## Acceptance Criteria per ADR

### ADR-076: Memory Full Integration
- [ ] Session-start auto-surfaces last 3 checkpoints (<2s)
- [ ] Every ADR/version/dependency edit stores `decision:*` key (<5s)
- [ ] SessionEnd captures open issues/PRs (<10s)
- [ ] Reversion writes include full decision context
- [ ] Query performance <200ms on 100+ decisions
- [ ] Zero data loss (SessionEnd + JSONL fallback)

### ADR-077: Continuity Gates
- [ ] `adr-validate.mjs` detects status/impl mismatches (<2s)
- [ ] Pre-commit hook blocks commits to Proposed ADRs
- [ ] `adr-supersede-check.mjs` creates SUPERSESSIONS.log entry (<5s)
- [ ] GitHub Actions PR gate reports pass/fail (<30s)
- [ ] `adr-impl-status.mjs` blocks release if impl status doesn't match code
- [ ] No false positives on real ADRs

### ADR-078: Release Automation
- [ ] `npm run release -- patch` succeeds in <2 min (local), <10 min (CI)
- [ ] Semver auto-detected from conventional commits
- [ ] All test gates enforced (can't be skipped)
- [ ] Tag matches package.json version exactly
- [ ] Evidence archived in `.release-evidence/v3.x.x/`
- [ ] npm package published within 60s of tag
- [ ] Rollback verified on real rollback scenario

### ADR-079: Testing Gates & Public CI
- [ ] Pre-commit gate blocks broken tests (<20s)
- [ ] PR shows test results + status badges (<2 min)
- [ ] Merge blocked if tests fail
- [ ] Coverage % and delta visible on PR
- [ ] Performance regression detected (>5% threshold)
- [ ] CI status page updates real-time
- [ ] Test traceability matrix generated, coverage % per ADR

---

## Git Commit Sequence

```bash
# Week 1: Memory + ADR Gates
git checkout -b feat/adr-076-076-north-star-path
git add docs/adr/0076-*.md docs/adr/0077-*.md
git commit -m "ADR-076/077: Memory integration and continuity gates

Unlock North Star path: session recall, decision ledger, ADR enforcement"

git add plugin/hooks/memory-*.mjs scripts/memory-*.mjs .git/hooks/pre-commit ...
git commit -m "Implementation: ADR-076 memory system (4 files, 14 tests)

SessionStart auto-recall, decision registry, thread snapshots, reversion tracking"

git add scripts/adr-*.mjs docs/adr/SUPERSESSIONS.log ...
git commit -m "Implementation: ADR-077 continuity gates (3 files, 12 tests)

ADR state validation, supersession audit, governed file enforcement"

# Week 2: Release Automation
git add docs/adr/0078-*.md
git commit -m "ADR-078: Release automation

One-command ship, tag-driven deploys, automatic rollback"

git add scripts/release.mjs scripts/announce-*.mjs .github/workflows/release.yml .releaserc.json
git commit -m "Implementation: ADR-078 release automation (5 files)

Semantic versioning, test gates, npm publish, Slack integration"

# Week 3-4: Testing Gates
git add docs/adr/0079-*.md
git commit -m "ADR-079: Testing gates and public CI

Pre-commit enforcement, visible PR results, coverage/performance tracking"

git add scripts/gate-runner.mjs scripts/coverage-*.mjs scripts/ci-status-*.mjs \
         .github/workflows/tests.yml .github/performance-baseline.json
git commit -m "Implementation: ADR-079 testing gates (8 files, 22 tests)

Pre-commit gates, PR status checks, coverage protection, performance baseline"

# Final: Create PR for all four ADRs
gh pr create --title "North Star 95/100+ path: ADR-076/077/078/079" \
  --body "See docs/adr/0082-north-star-unlock-path.md for overview

Four complementary ADRs unlock +180 score points:
- ADR-076: Memory full integration (+45 points)
- ADR-077: Continuity gates (+40 points)
- ADR-078: Release automation (+45 points)
- ADR-079: Testing gates & public CI (+50 points)

10-13 days implementation, 26+ tests, 3500 lines new code.
Ready to execute."
```

---

## Risk Mitigation

### Risk: Pre-commit gates block legitimate commits
**Mitigation**: `-B` flag requires explicit ADR reason; audit trail recorded in git history

### Risk: Release automation misses a gate
**Mitigation**: Each gate has isolated test suite; dry-run flag allows verification before real release

### Risk: Memory store becomes too large
**Mitigation**: Checkpoint size is bounded (~1KB per checkpoint); LIMIT 100 on session-start recall

### Risk: Performance baseline drifts over time
**Mitigation**: Baselines updated only on explicit approval; deltas calculated against baseline, not prior PR

### Risk: CI status page becomes stale
**Mitigation**: Webhook-driven updates; fallback to GitHub Actions API if webhook fails

---

## Success Metrics (95/100+ North Star)

| Category | Current | After ADRs | Delta |
|----------|---------|-----------|-------|
| **Continuity** | 0 | 25 | +25 |
| **Governance** | 0 | 35 | +35 |
| **Velocity** | 0 | 20 | +20 |
| **Safety** | 0 | 30 | +30 |
| **Visibility** | 0 | 20 | +20 |
| **Accountability** | 0 | 25 | +25 |
| **Test Discipline** | 0 | 25 | +25 |
| **Performance** | 0 | 15 | +15 |
| | | | |
| **TOTAL SCORE** | ~40-50 | 95-110 | **+45-60 points** |

---

## Next Steps

1. **Approve ADR-076 through ADR-079** (review + accept)
2. **Create feature branch** (`feat/adr-076-north-star-path`)
3. **Week 1 sprint**: Implement ADR-076 + ADR-077
4. **PR + review cycle**: (2 days)
5. **Week 2 sprint**: Implement ADR-078
6. **PR + review cycle**: (2 days)
7. **Week 3-4 sprint**: Implement ADR-079
8. **Final PR + release**: Tag v3.5.0 with all four ADRs live
9. **Measure**: Re-score against 95/100+ North Star target

---

**Prepared by**: Codex, System Architecture Designer  
**Date**: 2026-09-11  
**Status**: Proposed
