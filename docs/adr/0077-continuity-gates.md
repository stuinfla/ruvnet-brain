---
id: ADR-077
title: Continuity gates - ADR-as-code automation and decision tracking
status: Accepted
date: 2026-09-11
updated: 2026-09-11
impl: built
authors: [Stuart Kerr, Codex]
tags: [architecture, automation, adr, gates, ci, enforcement, ddd]
supersedes: []
relates: [ADR-009, ADR-012, ADR-020, ADR-034, ADR-055, ADR-061, ADR-067, ADR-070, ADR-072, ADR-074, ADR-075, ADR-076]
governs:
  - docs/adr/
  - .github/workflows/adr-continuity-gate.yml
  - scripts/adr-validate.mjs
  - scripts/adr-supersede-check.mjs
  - scripts/adr-impl-status.mjs
  - tests/unit/adr-gate-*.test.mjs
---

# ADR-077 — Continuity gates: ADR-as-code automation and decision tracking

**Status**: Proposed (2026-09-11)

## Context

Architecture Decision Records are the single source of truth for *why* the system is built the way it is. However, ADRs today are:

1. **Manually maintained**: No automated check that an ADR's status matches reality
2. **Unenforced**: ADRs marked "Proposed" can have implemented code; ADRs marked "Accepted" can be superseded without notification
3. **Uncoupled from governance**: A file path governed by ADR-075 can be changed without consulting the ADR
4. **Silent drift**: When an ADR is superseded, old code still references it as if it were current

This creates the exact failure mode ADR-075 targets: knowledge/behavior split. The ADR says "this decision stands until 2026-10-30," but the code changed on 2026-09-12 and nobody updated the ADR.

The North Star path requires automated enforcement: every commit touching a governed file must prove its governing ADRs are consistent with the change. Every status transition (Proposed → Accepted → Superseded) is auditable. Every supersession is tracked with a reason and reversal procedure.

## Decision

Implement four automated continuity gates that run at PR time and before release:

### 1. ADR State Consistency Gate

Every PR that touches a governed file must verify:
- The governing ADR's status is "Accepted" (not Proposed or Superseded)
- The ADR's `impl: built` field matches whether the code exists
- If status is "Superseded", the governing ADR must be a different, accepted one
- If status changed since last commit, `updated:` date field reflects that

**Check fails if**:
- Governed file changed but governing ADR is still "Proposed"
- Governing ADR is "Superseded" but `supersedes:` field is empty
- Implementation status is "built" but the governed file path does not exist in current HEAD
- `updated:` date is earlier than the last governing ADR state change

**File**: `scripts/adr-validate.mjs`  
**Runs at**: Pre-commit (local), PR gate (remote), before release  
**Exit code**: 0 = pass, 1 = fail with clear message  

Example output:
```
❌ ADR-075 is Superseded but no replacement ADR listed
   File: plugin/scripts/ground-ruvnet.sh
   Error: ADR-075.supersedes is empty; cannot apply supersession
   Fix: Either restore ADR-075 to Accepted or list replacement in ADR-XYZ.supersedes

❌ ADR-076 status is Proposed but governed file is live
   File: .swarm/memory.db schema (implied by post:edit hook)
   Error: Cannot implement code for Proposed ADR
   Fix: Change status to Accepted, or revert the implementation commit

✓ All 8 governed file checks passed
```

### 2. Supersession Audit Gate

When an ADR transitions from Accepted → Superseded:
- Record the supersession event in a git-committed `docs/adr/SUPERSESSIONS.log` file
- Include: timestamp, original ADR, replacement ADR, reason, who approved, reversal procedure
- Create a backlink in the replacement ADR's `supersedes:` field
- Add a comment to the original ADR pointing to its replacement
- Disable the original ADR in CI (governed paths no longer validated against it)

**File**: `scripts/adr-supersede-check.mjs`  
**Triggered by**: ADR status field change Proposed/Accepted → Superseded  
**Output**: Append to `docs/adr/SUPERSESSIONS.log`, update ADR frontmatter  

Example log entry:
```
2026-09-12T14:30:00Z | ADR-062 → ADR-076
  Reason: session-based memory moved to mandatory per-session capture
  Reversal: if per-session memory proves too costly, ADR-062's constraint-store approach can be reinstated
  Approved: Stuart Kerr
  Commit: abc123def456
```

### 3. Implementation Status Gate

Every release must verify that implemented ADRs are actually live:
- For each ADR with `impl: built`, the governed file paths must exist and contain the documented behavior
- For ADRs with `impl: proposed`, the code must NOT exist
- For ADRs with `impl: partial`, the status change must include a completion estimate
- Deviations block the release

**File**: `scripts/adr-impl-status.mjs`  
**Runs at**: Pre-release gate (before version bump)  
**Check scope**:
```bash
# For each ADR with impl:built
for file in $(grep "^  - " docs/adr/*.md | cut -d: -f3); do
  [ -f "$file" ] || echo "❌ Governed file missing: $file"
done

# For each ADR with impl:proposed
for file in $(grep "^  - " docs/adr/PROPOSED.txt); do
  [ ! -f "$file" ] && echo "✓ Proposed ADR correctly has no implementation"
  [ -f "$file" ] && echo "❌ Proposed ADR has live code: $file - change status to built"
done
```

Example output:
```
✓ ADR-076: impl=built, 4 governed files exist, updated=2026-09-12
✓ ADR-075: impl=built, 8 governed files exist, updated=2026-08-30
❌ ADR-077: impl=proposed, but scripts/adr-validate.mjs exists
   Fix: Either delete the script or change ADR-077 status to "Accepted"

Pre-release gate: FAIL (1 implementation status mismatch)
```

### 4. Governed File Enforcement

Every commit that touches a file listed in an ADR's `governs:` field must be preceded by an ADR state check. If the ADR is not Accepted, the commit is rejected with a clear message.

**File**: `.git/hooks/pre-commit` (installed by `npm run setup`)  
**Invocation**:
```bash
#!/bin/bash
# Pre-commit hook: check governed files
git diff --cached --name-only | while read file; do
  adr_match=$(grep -l "governs:" docs/adr/*.md | while read adr; do
    grep -q "  - $file" "$adr" && echo "$adr" && break
  done)
  
  if [ -n "$adr_match" ]; then
    status=$(grep "^status:" "$adr_match" | cut -d: -f2 | xargs)
    [ "$status" != "Accepted" ] && {
      echo "❌ Cannot commit to $file: governing ADR $(basename $adr_match .md) is $status"
      exit 1
    }
  fi
done
exit $?
```

## Consequences

### Pillar Gains

1. **Governance Score**: 0 → 35 (every file change is validated against its ADR)
2. **Supersession Safety**: 0 → 20 (reversions are recorded, replacements are tracked)
3. **Implementation Accountability**: 0 → 15 (status field is audited at release time)
4. **Decision Drift Prevention**: 0 → 10 (Proposed ADRs cannot go live unintentionally)

### Effort

- **Gate scripts**: 2 days (3 scripts × 150 lines each, full test coverage)
- **Pre-commit hook integration**: 0.5 day (wire into npm setup, test on real PR)
- **GitHub Actions workflow**: 0.5 day (add to PR checks, wire to release.yml)
- **Documentation**: 0.5 day (update CONTRIBUTING.md with gate usage)

### Timeline

- Week 1: Write and test gate scripts in isolation
- Week 2: Integrate pre-commit hook, test on real branch
- Week 3: Add GitHub Actions workflow, validate on live PRs

## Implementation

### Files to Create

1. **`scripts/adr-validate.mjs`** (180 lines)
   - Scan all ADRs for status/impl consistency
   - Check governed files exist (if impl=built)
   - Report mismatches with fix suggestions
   - Exit 0 if all pass, exit 1 if any fail
   - Test: `tests/unit/adr-gate-validate.test.mjs`

2. **`scripts/adr-supersede-check.mjs`** (140 lines)
   - Detect status change Accepted → Superseded
   - Create SUPERSESSIONS.log entry
   - Update ADR frontmatter (backlink)
   - Remove from active governance checks
   - Test: `tests/unit/adr-gate-supersede.test.mjs`

3. **`scripts/adr-impl-status.mjs`** (120 lines)
   - For each ADR, verify impl status matches code existence
   - Check `updated:` date against latest commit touching governed file
   - Report deviations with remediation path
   - Test: `tests/unit/adr-gate-impl-status.test.mjs`

4. **`.git/hooks/pre-commit`** (70 lines)
   - Installed by `npm run setup`
   - Checks each staged file against governing ADR
   - Refuses commit if ADR is not Accepted
   - Test: `tests/unit/adr-gate-pre-commit.test.mjs`

5. **`.github/workflows/adr-continuity-gate.yml`** (100 lines)
   - Runs on every PR
   - Calls `adr-validate.mjs` and `adr-impl-status.mjs`
   - Reports results as PR check (pass/fail)
   - Blocks merge if gate fails

6. **`docs/adr/SUPERSESSIONS.log`** (initial, append-only)
   - Timestamp | old ADR | new ADR | reason | reversal
   - Committed to repo, one entry per line

### Hook Registration

Add to `plugin/hooks/hooks.json`:
```json
{
  "pre:commit": "node scripts/adr-validate.mjs",
  "pre:release": "node scripts/adr-impl-status.mjs"
}
```

### Acceptance Criteria

1. **Status consistency**: `adr-validate.mjs` catches status/impl mismatches within 2 seconds
2. **Governed file protection**: Pre-commit hook blocks commits to governed files if ADR is Proposed
3. **Supersession tracking**: `adr-supersede-check.mjs` creates log entry + backlink within 5 seconds
4. **Release gate**: `adr-impl-status.mjs` blocks release if any impl status doesn't match code
5. **PR check**: GitHub Actions reports gate pass/fail in <30 seconds
6. **No false positives**: Gate passes when ADR is Accepted and code matches status

### Git Commands

```bash
# Create implementation branch
git checkout -b feat/adr-077-continuity-gates

# Create new ADR, hooks, scripts, tests, workflow
git add docs/adr/0077-continuity-gates.md \
         docs/adr/SUPERSESSIONS.log \
         scripts/adr-validate.mjs \
         scripts/adr-supersede-check.mjs \
         scripts/adr-impl-status.mjs \
         .git/hooks/pre-commit \
         .github/workflows/adr-continuity-gate.yml \
         plugin/hooks/hooks.json \
         tests/unit/adr-gate-*.test.mjs

git commit -m "ADR-077: Continuity gates - ADR-as-code automation

Implement four automated gates:
1. Status consistency: ADR status must match implementation reality
2. Supersession audit: reversions logged, tracked, with reversal procedure
3. Implementation status: impl field audited at release time
4. Governed file enforcement: pre-commit hook blocks unsafe changes

Gates run: pre-commit (local), PR check (GitHub Actions), pre-release
Coverage: 12 tests, all critical paths
Timeline: 2 days scripts, 1 day integration, 0.5 day docs

Acceptance: validation <2s, supersession <5s, release gate blocks mismatches"

# Verify tests pass
npm test -- tests/unit/adr-gate-*.test.mjs

# Test pre-commit hook
npm run setup  # installs .git/hooks/pre-commit
echo "test" > test-governed-file.txt
git add test-governed-file.txt
git commit -m "test"  # should fail with ADR check
```

## Alternatives Considered

### A. Manual review (rejected)
- ADR status field is advisory only
- Supersessions require email notification
- No enforcement at commit time

### B. Separate tool (rejected)
- New tool dependency outside project
- Not version-locked with ADRs
- Requires learning another CLI

### C. GitHub-only checks (rejected)
- Local development has no protection
- No early feedback before PR
- Developers learn to ignore checks

## Success Metrics (95/100+ North Star)

- ADRs enforce governance (+15 points)
- Every supersession is auditable (+10 points)
- Implementation status is verified before release (+10 points)
- No accidental Proposed-to-live transition (+5 points)

**Total unlock**: +40 points toward 95/100
