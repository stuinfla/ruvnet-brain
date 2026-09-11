---
id: ADR-081
status: Accepted
date: 2026-09-11
updated: 2026-09-11
updated_source: implementation
---

# ADR-0081: ADR-as-Code Automation — Pre-Commit Enforcement of Architecture Decisions

**Status**: Accepted (2026-09-11, Continuity Enforcement phase W2–W6)
**Date**: 2026-09-11
**Authors**: Claude Code (System Architecture), directed by Stuart Kerr
**Supersedes**: None
**Related**: ADR-0008 (autonomous engineering loop), ADR-0009 (mirror discipline), ADR-0067 (one decision one reason)

## Context

Architecture Decision Records (ADRs) document the reasoning behind design choices and form the ledger of decisions that cannot be quietly regressed. However, commits that implement architecture changes can be made without explicit ADR linkage, creating a gap between what was decided and what was shipped.

Previous incidents (ADR-0009, ADR-0012) show that gates must be mechanical, not advisory — prompts fail when the model forgets them, especially in long sessions. The grounding gate (ADR-0012) proved this: *"the gate does not forget."*

## Decision

**Pre-commit hook enforcement of ADR linkage** for all architecture-relevant commits:

1. **Commit Message Validation** (`scripts/adr-validate.mjs`):
   - Parse commit message for pattern `ADR-\d{4}` (exact match required)
   - Validate that each ADR referenced exists in `docs/adr/`
   - Check ADR status: block commits that reference "Proposed" ADRs only if they would ship (see verification below)
   - Allow multiple ADR references in a single commit: `ADR-0081, ADR-0012, ADR-0008`
   - Support bypass via environment variable `RUVNET_SKIP_ADR_CHECK=1` with loud logging

2. **Pre-Commit Hook Integration**:
   - Hook runs `scripts/adr-validate.mjs` on every commit
   - Blocks commit if:
     - Commit message exists but contains no `ADR-\d{4}` pattern (for code files in `src/`, `scripts/`, `plugin/`)
     - Referenced ADR does not exist in `docs/adr/`
     - Referenced ADR status is "Proposed" and code would ship (check `package.json` "files" array)
   - Allows commit if:
     - Commit touches only docs, tests, or config
     - Message contains valid ADR reference(s)
     - Bypass variable is set (with warning)

3. **Supersession Audit**:
   - Track when ADRs replace prior decisions via `Supersedes:` field in frontmatter
   - `scripts/adr-index.mjs` maintains a supersession graph
   - CI validates no orphaned or circular supersessions

4. **Implementation Status Verification**:
   - At release time, `scripts/release-authority.mjs` scans committed code:
     - Extract all ADR references from recent commits
     - Verify none are "Proposed" status
     - Report which ADRs cover each changed subsystem
   - Fail release if shipped code references Proposed ADRs

## Verification (run, not asserted)

- **Unit tests** (`tests/unit/adr-validate.test.mjs`):
  - ✓ Accepts commit with valid `ADR-NNNN` pattern
  - ✓ Rejects commit missing ADR reference for code files
  - ✓ Allows commit with no ADR for test/doc/config changes
  - ✓ Rejects commit with non-existent ADR reference
  - ✓ Rejects commit referencing Proposed ADR for shipping code
  - ✓ Accepts commit with multiple ADR references
  - ✓ Accepts commit when bypass variable is set (logs warning)
  - ✓ Extracts correct ADR list from commit message

- **Integration**: Pre-commit hook flow end-to-end
  - Real commit attempt triggers validation
  - Hook blocks + shows error + suggests fix
  - Adding ADR-NNNN to message allows commit

- **Release validation**: `npm run release:authority` checks all ADRs before shipping

## Consequences

- Claude physically cannot commit architecture changes without linking to an ADR — the gap between decision and implementation closes mechanically, not by promise.
- Cost: validation runs in <100ms per commit, negligible.
- Honest limits:
  - Bash heredocs that create files bypass the hook (Bash gate via ADR-0012 covers this layer)
  - Test files and documentation are exempt by design (testing decisions live in tests, not ADRs)
  - The bypass escape hatch exists for human override but logs loudly so it is visible in commit history

## Related Decisions

- **ADR-0008**: Autonomous loop — this gate ensures "decide in ADR, act in code" stays synchronized
- **ADR-0009**: Mirror discipline — ADR-QA is now tied to implementation; no ADR regress possible
- **ADR-0012**: Grounding gate — same pattern (mechanical block, not advisory) applied to architecture decisions
- **ADR-0067**: One decision, one reason — this gate enforces the "decision" part (must name the ADR you're deciding in)
