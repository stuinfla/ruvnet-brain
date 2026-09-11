# W2 Release Automation — One-Command Ship Pipeline

**Status:** Production ready as of 2026-09-11
**Deliverables:** Complete (scripts/release-cli.mjs + .github/workflows/release.yml)

## Quick Start

### One-Command Release

```bash
# Bump version and create git tag (runs all gates)
npm run release -- patch      # 4.3.22 → 4.3.23
npm run release -- minor      # 4.3.22 → 4.4.0
npm run release -- major      # 4.3.22 → 5.0.0

# Or set explicit version
npm run release -- 4.3.23
```

The script will:
1. ✓ Check working tree is clean
2. ✓ Verify on main or release/* branch
3. ✓ Run full test suite (npm test)
4. ✓ Run unit gates (npm run test:unit)
5. ✓ Verify version sync (all surfaces agree)
6. ✓ Verify tag doesn't exist (no duplicates)
7. ✓ Create annotated git tag (v4.3.23)
8. ✓ Print proof (version, tag, next steps)

### Expected Output

```
▸ GATE 1: working tree clean
  ✓ no uncommitted changes

▸ GATE 2: on main or release branch
  ✓ on branch release/4.3.22

▸ GATE 3: full test suite (npm test)
  ...test output...
  ✓ npm test passed

▸ GATE 4: unit gates (npm run test:unit)
  ...test output...
  ✓ npm run test:unit passed

▸ GATE 5: version sync check
  ✓ all version surfaces agree

▸ GATE 6: release tag does not exist
  ✓ tag v4.3.23 is available

▸ GATE 7: set version and create release tag
  ✓ committed version bump: 4.3.23
  ✓ created tag v4.3.23

▸ PROOF

✓✓✓ RELEASE READY

  Version:   4.3.23
  Tag:       v4.3.23
  Commit:    af547510
  package.json: 4.3.23

Next steps:
  • Push to GitHub: git push origin main v4.3.23
  • Trigger protected-release workflow with:
    gh workflow run protected-release.yml -f candidate_sha=af547510... -f version=4.3.23
```

## Release Gates (Fail-Fast Order)

### Gate 1: Working Tree Clean
- **Check**: `git status --porcelain` returns empty
- **Rationale**: Ensures no uncommitted changes are missed
- **Fix**: Commit or stash changes before retrying

### Gate 2: On Correct Branch
- **Check**: Branch matches `main` or `release/*`
- **Rationale**: Prevents releases from feature branches
- **Fix**: Check out main or a release/* branch

### Gate 3: Full Test Suite Passes
- **Command**: `npm test` (60/60 suite)
- **Rationale**: Ensures no regressions ship
- **Fix**: Debug test failures, commit fixes, retry

### Gate 4: Unit Gates Pass
- **Command**: `npm run test:unit` (vitest)
- **Rationale**: Ensures unit correctness and narrative gates
- **Fix**: Debug unit test failures, commit fixes, retry

### Gate 5: Version Sync Check
- **Check**: All version surfaces agree on current version
- **Surfaces**: plugin.json, package.json, package-lock.json, data/manifest.json, kb/package.json, primer/ruvnet-primer.md, explainer/index.html
- **Rationale**: Prevents version drift into production
- **Fix**: Run `npm run version:sync` to fix drift, then retry

### Gate 6: Tag Doesn't Exist
- **Check**: `git rev-parse vX.Y.Z` returns error (tag not found)
- **Rationale**: Prevents duplicate release tags
- **Fix**: Choose a different version number, or delete stale tag with `git tag -d vX.Y.Z`

### Gate 7: Create Tag and Commit
- **Actions**: 
  - Bump version in plugin/.claude-plugin/plugin.json
  - Run sync-version to propagate
  - Create commit: `chore(release): bump to X.Y.Z`
  - Create annotated git tag: `vX.Y.Z`
- **Rationale**: Single atomic commit of version + tag
- **Failure mode**: On error, working tree will be dirty; fix the error and retry

### Gate 8: Proof (Read-Only)
- **Print**: Version, tag name, commit SHA, package.json version
- **Verify**: All surfaces show the same version
- **Rationale**: Human verification before push

## CI Gate Workflow (`.github/workflows/release.yml`)

The workflow runs automatically on:
1. **Tag push** (v[0-9]+.[0-9]+.[0-9]+) — gates the release
2. **Manual dispatch** — for testing
3. **PR to main** — optional dry-run

### Workflow Gates

Both gates are required and run in order (fail-fast):

| # | Gate | Command | Purpose |
|---|------|---------|---------|
| A | Vitest Unit Tests | `npm run test:unit` | Catch quick failures early |
| B | Comprehensive Suite | `npm test` | Validate full 60/60 suite |

**Outcome**: Both must pass for downstream `protected-release` workflow to proceed.

## Version Source of Truth

The product version is defined in ONE place:

```
plugin/.claude-plugin/plugin.json  ← The ONE source of truth
  ↓ (sync-version.mjs)
  ├─ package.json
  ├─ package-lock.json
  ├─ data/manifest.json (brainVersion field)
  ├─ kb/package.json
  ├─ primer/ruvnet-primer.md
  └─ explainer/index.html
```

Never edit the version directly in package.json; always bump plugin.json and sync.

## Full Release Flow (W2 Automation)

```
1. User runs: npm run release -- patch
2. Script runs 8 gates (local)
3. Script creates git tag
4. User pushes: git push origin main <tag>
5. GitHub workflow runs on tag push
6. Workflow gates run (vitest + npm test)
7. If gates pass: protected-release workflow runs
8. Protected-release creates GitHub Release
9. Protected-release publishes to npm
10. Deployment to Vercel completes
```

## Troubleshooting

### "working tree has uncommitted changes"
- **Cause**: Dirty git state
- **Fix**: `git status` to see changes, then `git add` + `git commit` or `git stash`

### "not on main or release branch"
- **Cause**: On a feature branch
- **Fix**: `git checkout main` or create/checkout a release/* branch

### "npm test failed"
- **Cause**: Test failures
- **Fix**: Debug failures, commit fixes, run `npm run release -- <version>` again

### "npm run test:unit failed"
- **Cause**: Unit test or narrative gate failures
- **Fix**: Debug, commit fixes, retry

### "version sync check failed"
- **Cause**: Version drift (surfaces disagree)
- **Fix**: Run `npm run version:sync` to repair, then retry `npm run release`

### "tag <tag> already exists"
- **Cause**: Tag was already created (possible double-push)
- **Fix**: Delete with `git tag -d vX.Y.Z`, then retry with new version, or if the tag is correct, run `git push origin vX.Y.Z` (it's already local)

## Related Scripts

- `npm run release` — One-command release (W2)
- `npm run release:proof` — Verify release evidence files
- `npm run release:authority` — Verify publishing authority
- `npm run version:check` — Check version sync
- `npm run version:sync` — Fix version drift
- `npm test` — Full test suite
- `npm run test:unit` — Unit gates (vitest)

## How to Update the CHANGELOG

The CHANGELOG is structured into:
- **Unreleased** (current campaign work)
- **[X.Y.Z]** (shipped releases with dates)

To add release notes:
1. Ensure you have context on what shipped
2. Add a new `## [X.Y.Z] — YYYY-MM-DD` section
3. List shipped changes with brief descriptions
4. Commit the CHANGELOG update in the same PR as code

The release script does NOT auto-generate the CHANGELOG; it must be maintained by hand.

---

**Questions?** Check `.github/workflows/release.yml` for CI gate details, or `scripts/release-cli.mjs` for the local gate implementation.
