---
id: ADR-078
title: Release automation - one-command ship with tag-driven deploys
status: Proposed
date: 2026-09-11
authors: [Stuart Kerr, Codex]
tags: [architecture, release, ci, automation, versioning, semver, deployment, npm]
supersedes: []
relates: [ADR-009, ADR-018, ADR-020, ADR-034, ADR-055, ADR-070, ADR-072, ADR-075, ADR-076, ADR-077]
governs:
  - scripts/release.mjs
  - .github/workflows/release.yml
  - .github/workflows/publish-npm.yml
  - package.json (version field)
  - CHANGELOG.md
  - .releaserc.json
---

# ADR-078 — Release automation: one-command ship with tag-driven deploys

**Status**: Proposed (2026-09-11)

## Context

Shipping RuvNet Brain v3.x today requires:

1. **Manual version bump**: Edit package.json, CHANGELOG.md by hand, decide semver level
2. **Split testing**: Run tests locally, then hope CI passes
3. **Tag dance**: Create annotated git tag manually, push separately
4. **Async deployment**: Wait for CI to complete, watch for failures
5. **Evidence collection**: Screenshot the deploy URL, paste into release notes
6. **No rollback procedure**: If v3.4.19 is broken, reverting to v3.4.18 is manual

The failure modes are clear:
- Versions can diverge (package.json vs git tag vs deployed URL)
- Testing can be skipped (local tests pass but CI fails)
- Broken releases ship (no pre-flight checks prevent bad tags)
- Rollbacks are manual (no automation to restore last good state)

The North Star path requires: **One command** → version bump, test, tag, deploy, verify. All gates are enforced. All evidence is captured. Rollback is one flag.

## Decision

Implement a unified release pipeline driven by semantic versioning tags:

### 1. One-Command Release

```bash
npm run release -- [patch|minor|major] [--dry-run] [--skip-deploy]
```

**Flow**:
1. Determine next semver (from commit history or explicit flag)
2. Run full test suite (unit, integration, build)
3. Verify ADR/DDD consistency (ADR-077 gates)
4. Update package.json, CHANGELOG.md
5. Create annotated git tag with release notes
6. Push to remote (with all checks passing)
7. GitHub Actions automatically publishes to npm
8. Verify published bytes match local build
9. Post release notes to GitHub Releases
10. Update explainer and landing page with new version

**File**: `scripts/release.mjs` (main orchestrator)  
**Execution time**: ~90 seconds (including CI wait time)  
**Idempotent**: Running release twice with same version fails early (tag already exists)

### 2. Semantic Versioning from Commits

Use conventional commits to auto-detect version bump:
- `feat:` = minor version bump
- `fix:` = patch version bump
- `BREAKING CHANGE:` = major version bump
- Commit since last tag determines change count

**Tool**: `npx @commitlint/cli@latest` (integrated into release.mjs)  
**Input**: Git log since last tag  
**Output**: Next semver + changelog entry  

Example:
```
Last tag: v3.4.18
Commits since: 3 feat, 7 fix, 0 breaking
Detected: patch bump (highest is fix)
Next: v3.4.19

CHANGELOG addition:
## [3.4.19] - 2026-09-12
### Fixed
- Memory session recall on startup (#124)
- ADR consistency gate false positive on superseded docs (#126)
- Release automation idempotency check (#128)
```

### 3. Pre-Release Testing Gate

Every release runs the full test matrix **before** tagging:

```bash
# Unit tests (fast)
npm test -- --coverage

# Integration tests (full)
npm run test:integration

# Build verification
npm run build

# ADR/DDD gates (ADR-077)
npm run gate:adr

# Performance regression check
npm run benchmark -- --baseline dist/performance.json

# Security scan
npm run audit:security

# Documentation currency (ADR-075)
npm run gate:docs
```

If any gate fails, release aborts with a clear message and no tag is created.

**File**: `scripts/release.mjs` (test phase)  
**Gate check**: All gates must pass before proceeding  
**Failure output**: Exact gate that failed + remediation steps

Example:
```
❌ ADR Consistency Gate Failed
   File: plugin/scripts/ground-ruvnet.sh
   Issue: Governed by ADR-075 (Accepted) but ADR-075 has impl=proposed
   Fix: Either:
     (A) Change ADR-075 status to Accepted + update date
     (B) Move ground-ruvnet.sh to a different governed-by ADR-076

Release aborted. Fix the above and try again.
```

### 4. Tag-Driven GitHub Actions Deploy

Once a tag is pushed, GitHub Actions automatically:
1. Download the exact commit code
2. Verify checksums match local build
3. Publish to npm (via `npm publish`)
4. Create GitHub Release (with CHANGELOG excerpt)
5. Update website explainer (via Vercel deploy)
6. Post announcement to #releases Slack channel
7. Archive release evidence (logs, artifacts) in `.release-evidence/v3.4.19/`

**File**: `.github/workflows/release.yml`  
**Trigger**: Push of `v*.*.*` tags  
**Execution**: ~60 seconds (npm publish, GitHub Release, Vercel)

Example workflow:
```yaml
name: Release Automation

on:
  push:
    tags:
      - 'v*.*.*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
      
      - name: Verify tag matches package.json
        run: |
          TAG=${GITHUB_REF#refs/tags/}
          PKG=$(jq -r .version package.json)
          [ "$TAG" == "v$PKG" ] || exit 1
      
      - name: Install & Build
        run: npm ci && npm run build
      
      - name: Publish to npm
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      
      - name: Create GitHub Release
        uses: actions/create-release@v1
        with:
          tag_name: ${{ github.ref }}
          body_file: .release-evidence/${{ github.ref }}/RELEASE_NOTES.md
      
      - name: Archive evidence
        run: |
          mkdir -p .release-evidence/${{ github.ref }}
          cp package.json .release-evidence/${{ github.ref }}/
          npm list > .release-evidence/${{ github.ref }}/dependencies.txt
          git log --oneline -20 > .release-evidence/${{ github.ref }}/commits.txt
          
      - name: Announce to Slack
        run: npm run announce:release
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_RELEASES }}
```

### 5. Rollback Procedure (One Flag)

If a release is broken, one command reverts:
```bash
npm run release -- --rollback v3.4.19
```

**What it does**:
1. Fetch the last known-good tag (v3.4.18)
2. Verify it exists and is not superseded
3. Push that tag as `HEAD` (move main branch back)
4. Unpublish v3.4.19 from npm (via `npm unpublish @ruvnet/brain@3.4.19`)
5. Archive broken release evidence in `.release-evidence/v3.4.19-ROLLBACK/`
6. Post rollback notice to Slack + GitHub

**File**: `scripts/release.mjs` (rollback phase)  
**Safety**: Requires explicit commit hash confirmation before proceeding

Example:
```
⚠️  Rolling back v3.4.19 → v3.4.18

Current: v3.4.19 (commit abc123def456)
Target:  v3.4.18 (commit xyz789uvw012)

Actions:
  1. Revert main to v3.4.18
  2. Unpublish @ruvnet/brain@3.4.19 from npm
  3. Create rollback tag: v3.4.19-ROLLBACK-20260912T144500Z
  4. Archive broken release to .release-evidence/v3.4.19-ROLLBACK/

Proceed? (type 'yes, rollback v3.4.19')
```

## Consequences

### Pillar Gains

1. **Release Velocity**: 0 → 20 (one command vs manual multi-step)
2. **Testing Discipline**: 0 → 25 (all gates enforced pre-tag)
3. **Audit Trail**: 0 → 20 (every release archived with evidence)
4. **Safety**: 0 → 15 (no version mismatch, rollback is one flag)
5. **Consistency**: 0 → 10 (npm, GitHub, explainer all in sync)

### Effort

- **Release orchestrator**: 2 days (release.mjs, all phases, test coverage)
- **GitHub Actions workflow**: 1 day (release.yml + publish.yml, environment config)
- **Documentation**: 0.5 day (release runbook, troubleshooting guide)
- **Evidence archival system**: 0.5 day (structure, cleanup, verification)

### Timeline

- Week 1: Build release.mjs (dry-run, test phases, tag creation)
- Week 2: Integrate GitHub Actions workflow, test on real tag
- Week 3: Add rollback procedure, test on real rollback scenario
- Week 4: Update docs, run full dry-run release cycle

## Implementation

### Files to Create

1. **`scripts/release.mjs`** (300 lines)
   - Parse semver from commits (commitlint integration)
   - Run all gates (tests, ADR, performance, security)
   - Update package.json + CHANGELOG.md
   - Create annotated git tag with release notes
   - Push tag to remote
   - Rollback procedure (revert + npm unpublish)
   - Test: `tests/integration/release-integration.test.mjs`

2. **`.github/workflows/release.yml`** (150 lines)
   - Triggered on `v*.*.*` tag push
   - Verify tag matches package.json
   - Install, build, publish to npm
   - Create GitHub Release
   - Archive evidence to `.release-evidence/`
   - Post to Slack

3. **`.github/workflows/publish-npm.yml`** (80 lines)
   - Separate workflow for npm publish (reusable)
   - Publish with provenance (SLSA v1.0)
   - Verify checksums match source

4. **`.releaserc.json`** (40 lines)
   - Conventional commits config
   - Changelog format template
   - Tag prefix: `v`

5. **`scripts/announce-release.mjs`** (60 lines)
   - Post to Slack (webhook)
   - Include version, changelog excerpt, link to GitHub Release
   - Use template for consistency

### Hook Registration

Add to `plugin/hooks/hooks.json`:
```json
{
  "pre:release": "node scripts/release.mjs"
}
```

### Acceptance Criteria

1. **One-command release**: `npm run release -- patch` succeeds in <2 minutes (local), <10 min with CI
2. **Auto-versioning**: Semver is detected from commits, not prompted
3. **All gates enforced**: Any failing test/ADR/perf/security blocks release (no skip flag)
4. **Tag created**: Annotated git tag matches package.json version
5. **Evidence archived**: `.release-evidence/v3.4.19/` contains build artifacts + logs
6. **npm published**: Package appears on npm registry within 60 seconds of tag
7. **GitHub Release created**: Release notes include full CHANGELOG section
8. **Rollback works**: `npm run release -- --rollback v3.4.19` unpublishes + reverts branch

### Git Commands

```bash
# Create implementation branch
git checkout -b feat/adr-078-release-automation

# Create files
git add scripts/release.mjs \
         .github/workflows/release.yml \
         .github/workflows/publish-npm.yml \
         .releaserc.json \
         scripts/announce-release.mjs \
         plugin/hooks/hooks.json \
         tests/integration/release-integration.test.mjs \
         docs/adr/0078-release-automation.md

git commit -m "ADR-078: Release automation - one-command ship

Implement unified release pipeline:
1. Semantic versioning from conventional commits
2. Pre-release testing gate (all checks enforced)
3. Tag-driven GitHub Actions deploy
4. npm + GitHub + Slack synchronization
5. One-flag rollback procedure

Release flow: npm run release -- [patch|minor|major]
Execution: ~90s local + ~60s CI
Rollback: npm run release -- --rollback v3.x.x

Timeline: 2 days orchestrator, 1 day GA, 0.5 day announcer
Acceptance: all gates pass before tag, npm published <60s, rollback verified"

# Verify tests pass
npm test -- tests/integration/release-integration.test.mjs

# Dry run (no actual push/publish)
npm run release -- patch --dry-run
```

## Alternatives Considered

### A. semantic-release (npm package, rejected)
- Heavy dependency
- Less control over test gates
- Not integrated with RuvNet-specific ADR checks (ADR-077)

### B. Manual release with checklist (rejected)
- Error-prone
- Difficult to enforce consistency
- No automation for git, npm, Slack sync

### C. GitHub Releases UI only (rejected)
- Still requires local version bump
- No test gate enforcement
- Slack announcement is manual

## Success Metrics (95/100+ North Star)

- Release is one command (+15 points)
- All gates enforced pre-tag (+15 points)
- npm/GitHub/Slack stay in sync (+10 points)
- Rollback is automatic (+5 points)

**Total unlock**: +45 points toward 95/100
