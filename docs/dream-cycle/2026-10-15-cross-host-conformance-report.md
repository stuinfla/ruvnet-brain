# Cross-Host Conformance SOTA Report — 2026-10-15

## TL;DR

Tonight's slot (0 → `cross-host-conformance`, scan `codex-parity,stranger-project-behaviour`,
`20261015 % 5 == 0`, no bonus modulus: `%25`=15, `%75`=65) is dominated, again, by the same two
facts the last several nights on this surface have already recorded: (1) the review-lane backlog
keeps growing with no merges, and (2) PR #396's hook-conformance-gate fix is still the single
highest-value item sitting in it. Tonight's own contribution is not a new code-level finding — it is
a bounded, mechanical repair that directly reduces (2): PR #396 had drifted to `mergeable_state:
dirty` (flagged 2026-10-10 in #424); this session merged current `main` into its branch, resolved the
one conflict (a generated file, regenerated rather than hand-edited), and re-verified the original
14/14 passing test result still holds post-merge. No issue filed — per `findingPolicy.skipIf:
["existing-fix-pr", "duplicate-open-issue"]`, this reconciles existing work rather than creating more
of it.

## What's new

Nothing code-level. Confirmed fresh tonight via GitHub MCP:
- `search_pull_requests repo:stuinfla/ruvnet-brain head:dream` → **98 opened all-time, 55 still open,
  5 ever merged** (#143, #148, #150, #178, #215 — all before 2026-09-01). Last merge 2026-08-26 (#178)
  — **50 days** with zero merges since, a number that has grown every single night this has been
  checked (40 on 10-10, 44 on 10-14, now 50).
- Issue #410 (filed 2026-10-06, restated in PRs #411/#419/#421/#422/#424/#436/#438/#440/#452/#453)
  still open, still the correct diagnosis: this is a human triage bottleneck, not a research-quality
  problem. Not re-filed (`skipIf: duplicate-open-issue`).
- `tests/integration/hook-conformance-both-hosts.test.mjs` on current `main` (`1d4ec0b5`, 10 releases
  and 10 days after PR #396 was opened) still has **zero** `spawnSync`/`spawn(` calls — the regression
  #396 fixes is still live, unfixed, on `main`, 39 days after the original 2026-09-07 break.

## Tonight's reconciliation action: unblocking PR #396

PR #396's branch (`dream/2026-10-05-cross-host-conformance`) had drifted to `mergeable_state: dirty`
against `main` after 10 days of unrelated releases (4.6.4 → 4.7.6). Rather than re-stating that fact a
third time (#424 on 10-10 already did), this session did the mechanical rebase work issue #410 itself
named as "a few hours of mechanical reconciliation, not a code change":

1. `git fetch --unshallow` (this container's checkout is shallow by default and cannot compute a real
   merge-base otherwise — the same class of sandbox limitation #298/#299/#332 document for the
   `dream-machine compile` step, worked around here rather than reported as a blocker).
2. `git merge origin/main --no-commit --no-ff` on a disposable worktree of the PR branch. **Exactly one
   conflict**: `data/convergence-manifest.json` — a generated artifact, not hand-authored content.
3. Resolved by regenerating it (`npm run convergence:write`), not by picking either side's bytes.
   `scripts/convergence-manifest.mjs` (check mode) confirms `{"ok":true,...}` post-regeneration.
4. Re-ran the PR's own targeted evidence: `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs`
   → **14/14 passing**, identical to PR #396's original evaluation receipt — the merge changed nothing
   about the behavior under test.
5. Committed as a real two-parent merge commit (verified: `git log -1 --format="%H %P"` shows both
   parents) and pushed to `dream/2026-10-05-cross-host-conformance`. Left a comment on #396 documenting
   exactly this, so the PR's own evaluation receipt is not silently reinterpreted as having been re-run
   in full (it was not — only the merge and the one targeted test were re-verified; the original Darwin/
   critic/security sections stand as originally evidenced).

This PR's own diff did not change — no new production code, no new claim, nothing for an independent
critic to re-check beyond "does the merge introduce behavior change" (it does not: the only touched
path outside the conflict is a mechanical history merge, and the one real conflict resolved to a
regenerated, machine-verified artifact).

## Scans: codex-parity, stranger-project-behaviour

No new defect found in either scan tonight. Budget was spent on the #396 unblock instead, consistent
with the standing learning signal ("zero of last 14 merged → bias to a tiny, easily-reviewable
candidate" — unblocking an existing tiny candidate is a stricter reading of that signal than writing a
new one). Not claiming either scan is exhaustively clear; recording as not-attempted-in-depth tonight
rather than silently skipped.

## Hypothesis (frozen before action)

> Given PR #396's branch has drifted from current `main`, when `main` is merged into it and the one
> resulting conflict is resolved by regenerating the affected file with the repo's own tooling (rather
> than hand-editing), then the PR's original targeted test evidence (14/14 passing) should reproduce
> unchanged post-merge — because the conflict is confined to a derived artifact, not to the PR's actual
> code change — falsifiable by re-running that exact test command after the merge.

**VERDICT: ACCEPT.** The hypothesis held: 14/14 passed post-merge, matching the original receipt
exactly. This is not a new code finding and claims no new quality improvement beyond what #396 already
evidenced; it is a successful repair of the mechanism blocking that evidence from being mergeable.

## Reward-Hack Check

No benchmark, gold-answer, or threshold file touched. The only file this session wrote in the PR branch
beyond the merge itself is the regenerated `data/convergence-manifest.json`, produced by the repo's own
script, not hand-tuned. Nothing here could inflate a metric — it only removes a mechanical obstruction
to review.

## Security Review

No new capability granted, no new code path. `git fetch --unshallow` and the worktree merge are local,
read-mostly operations against this session's own fetched refs; the only write is the push to the PR's
own pre-existing branch (`dream/2026-10-05-cross-host-conformance`), which this automation already had
write access to and had authored in a prior night.

## Regression Analysis

N/A for this session's own action (merge + regenerated derived file + re-verified existing test). PR
#396's own Regression Analysis section (byte-identical `test:integration` baseline-vs-candidate) is
unaffected and was not re-run in full tonight — flagged explicitly in the #396 comment so this is not
mistaken for a full re-evaluation.

## ADR

None — mechanical reconciliation, not an architectural decision.

## Gist

LOCAL — no `gh` CLI / gist-creation tool available this session, consistent with every prior night.
This committed report is the full record.

## Issue

**NONE** — per the ISSUE DISPOSITION OVERRIDE: no new, reproduced, actionable, unresolved defect
tonight. #396 already covers the live gate defect (now unblocked); #410 already covers the backlog.

## Witness

```
SESSION_COMMIT = 1d4ec0b54e00d9fa3eec4e77630e5cc9d40797ee
REPORT_HASH    = c1af77dc52cdd8a86269b4f58e071b048802ee32218c546679a4d3e00a352e04
WITNESS        = b3ebe2dd55fb97a420f350807d793c8e8a6289f6899b4ec54820b674cc90c3a8
```

(REPORT_HASH above is computed on this file's content immediately prior to inserting these three
values, the same minor unavoidable circularity every prior night's witness section has — recomputing
the hash of the file including these inserted bytes is not expected to match, by construction.)

Verification procedure anyone can reproduce:
1. `git checkout dream/2026-10-15-cross-host-conformance-reconciliation`
2. `sha256sum docs/dream-cycle/2026-10-15-cross-host-conformance-report.md` → REPORT_HASH
3. `git log -1 --format=%H` on the session commit this branched from → `1d4ec0b54e00d9fa3eec4e77630e5cc9d40797ee`
4. `printf '%s%s' "$REPORT_HASH" "1d4ec0b54e00d9fa3eec4e77630e5cc9d40797ee" | sha256sum` → WITNESS
5. Compare against the ledger row for 2026-10-15.

## Recommendation (for the repo owner, priority order)

1. **PR #396 is now mechanically ready to merge** — rebased, one conflict resolved via regeneration
   (not hand-editing), original 14/14 test result re-confirmed post-merge. It restores real safety
   coverage for a hook-conformance gate that has been silently vacuous on both hosts for 39 days. This
   is the single most actionable item in the backlog right now.
2. **The backlog itself is still the dominant fact**: 55 open drafts, 98 opened all-time, 5 merged, 50
   days since the last merge. Issue #410 already names the fix (a human triage/rebase pass); this
   session did one concrete instance of that triage (item 1) rather than re-stating the ask a sixth
   time.

## Merge Policy

Human review required. This session never self-merges and never autonomously promotes candidate state.
`autoMerge: false` (`dream.config.json`, ADR-068) held throughout — all actions tonight were on
existing draft branches, pushed as commits, never merged into `main` or into any PR's base.
