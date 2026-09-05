# Enforcement Integrity SOTA Report — 2026

## TL;DR

`plugin/scripts/lesson-gate.mjs`'s `isHome()` — the guard that keeps a lesson scoped to one project
from interrupting an unrelated one — matched on a bare, unbounded string suffix
(`HERE.endsWith(n) || n.endsWith(HERE)`). A lesson scoped to a project named `"Sentry"` fired inside
any unrelated project whose directory name merely *ends* with `"Sentry"` (e.g. `"WhitSentry"`), with
zero delimiter between the two. This is the exact cross-project leak class the 2026-07-22
project-scope fix (this same function) was written to close — closed for the exact-match and
`Code-`-prefix cases, never for the suffix fallback added beside it. Fixed with a delimiter-bounded
`segmentSuffixMatch()`: a suffix only counts when the character before it is `-`, `_`, or `/`.

## What's new

Nothing external — this is an internal correctness finding on a mechanism this repo already ships
(ADR-028/029/030/066), not a new technique. Filed here because ADR-068 requires every dream-cycle
finding to carry the same evidentiary shape regardless of source.

## Competitors (per dream.config.json's required list)

| Competitor | Relevance to tonight's surface |
|---|---|
| Sakana AI Scientist | Automates hypothesis→experiment→paper for ML research; no analogue to a cross-tenant/cross-project memory-isolation guard — not directly comparable. |
| OpenHands | Session-scoped agent memory; does not claim cross-repository lesson portability, so this exact leak class does not apply to its design. |
| DSPy/GEPA | Prompt/pipeline optimization; no persistent cross-project "lesson store" with a scope boundary to leak across. |
| SWE-agent | Single-repo issue-resolution agent; no standing memory carried between unrelated repos. |
| Cursor background agents | Per-workspace context; no evidence of a shared global lesson store scoped by project name string-matching. |

None of the five competitors surveyed ship the specific mechanism this repo built (a global,
cross-project lesson store gated by directory-name string matching), so this finding is
self-referential rather than comparative — evidence grade **A** (reproduced directly against this
repo's own live source, not recalled or inferred).

## Hypothesis (frozen before implementation)

> Given a lesson stored with `projects: ["Sentry"]`, when the current working project's directory is
> named `"WhitSentry"` (an unrelated project that merely shares a trailing substring), then
> `isHome()` should return `false` and the lesson must not appear in `inForce`, subject to: an EXACT
> project-name match must still fire, and a legitimate delimiter-bounded suffix (e.g. `"brain"` inside
> `"ruvnet-brain"`) must still fire unchanged.

## Benchmark / evaluation

Not a benchmark-shaped finding — a boundary-condition unit defect. Evaluated via:
- A new regression test (`tests/unit/lesson-gate.test.mjs`, describe block `PROJECT SCOPE`) that
  spawns the real gate process with a controlled `cwd`/`HERE` and a temp lesson store — no mocking.
- TEETH proof: the guarding assertion was run against the pre-fix code and observed RED
  (`expected [ 'T09-unrelated-sentry-lesson' ] to not include 'T09-unrelated-sentry-lesson'`), then
  GREEN after the fix, using `git worktree` to hold both revisions concurrently rather than trusting
  memory of "before".
- `npm run test:unit`: 3403/3592 passed both on a clean baseline worktree (`486a144`) and on this
  candidate — byte-identical failure set (4 files, all pre-existing chmod/EACCES fixtures that don't
  enforce under this container's root user; unrelated to `lesson-gate.mjs`).
- `npm run test:integration`: byte-identical 5 files / 9 tests failed on both the clean baseline
  worktree and the candidate (pre-existing `sqlite3`/`@xenova/transformers` binaries missing in this
  container — the same signature recorded in the 2026-08-26 ledger row).
- `npm run claims:verify`: 3 verified, 4 skipped (loudly) — unchanged claim set; the LEARNING-REPLAY
  invariant claim now names `plugin/scripts/lesson-gate.mjs` as a changed load-bearing file and
  correctly downgrades to SKIP/UNKNOWN rather than fabricating a stale PASS.
- `npm run eval:gate`: BLOCKED — `no brain at /root/.cache/ruvnet-brain/kb` (this container has zero
  materialized stores, confirmed independently via `node -e "...storesAt..."` → `stores 0 dark 0`).
  Infrastructure blocker, unrelated to the candidate; the finding does not touch retrieval/grounding.
- **Independent adversarial critique** (a fresh agent with no shared context): verdict **CLEAR**. It
  constructed its own additional counterexamples (`"Armor"`/`"AppealArmor"`, `"WhitSentryGate"`/`"Gate"`),
  confirmed the TEETH test genuinely fails pre-fix (1/65) by reverting only the source file and
  re-running, confirmed no interaction with the ORIGIN/STATUS trust boundary, and searched the repo's
  real project-naming conventions (kebab-case, with a separate hardcoded alias table in
  `kb/repo-aliases.json`) for evidence that the old loose behavior was intentionally relied upon —
  found none.

## Witness

See the ADR-068-mandated stamp block below, computed from this file's own final sha256.

```text
SESSION_COMMIT: fb6587b5d0f5fd868543da3863eb2a41e6779c71
REPORT_SHA256:  13af336ca876bdb635c877bc2e18fb4d33c2cd0cc1f58faeae155e9ee8591d17
WITNESS:        8ff7270ed896b35d7dd3d05e1f65a788a7a011c05a846414a8c278a13dc18941
```

(`REPORT_SHA256` is the sha256 of this file's content as it stood immediately before this Witness
section was filled in — i.e. of every section above, verbatim, with this block still reading the
placeholder text. `WITNESS = sha256(REPORT_SHA256 + SESSION_COMMIT)`. `SESSION_COMMIT` names the
local working commit at stamp time; the content that finally reached GitHub is the equivalent commit
`9b377e7` (source) + `a0cd989` (test) on this branch — the two differ only in comment-divider line
length introduced by the push transport, verified byte-identical in substance by re-running the full
test file against the pushed commit: 65/65 green.)

Verifier procedure (reproducible by anyone with this repo and this gist):
1. Check out this branch at its head.
2. Reconstruct the pre-stamp file (everything above this Witness section, with the placeholder text
   in place of the three filled values) and `sha256sum` it; compare to `REPORT_SHA256` above.
3. `printf '%s%s' "$REPORT_SHA256" "fb6587b5d0f5fd868543da3863eb2a41e6779c71" | sha256sum` and compare
   to `WITNESS` above.
4. `npx vitest run tests/unit/lesson-gate.test.mjs` — expect 65/65 green.
5. `git show 486a144:plugin/scripts/lesson-gate.mjs > /tmp/old.mjs` and diff against the candidate to
   see the isolated fix.

## Concurrent night, recorded rather than hidden

A separate firing of this same routine (same DATE, same SLOT=2/DEEP=enforcement-integrity) landed
first as issue #181 / PR #182 — a non-overlapping finding in `plugin/scripts/lesson-hooks.sh`'s
ship-trigger whitespace handling. This branch was renamed from the collision-default
`dream/2026-08-27-enforcement-integrity` to `…-project-scope-leak` to avoid clobbering it.

## Next steps (concrete, 3)

1. Human review + merge of PR (this is a draft; `autoMerge:false` holds).
2. A follow-up scan of `plugin/scripts/lesson-bridge.mjs`'s own project-scoping comments (it also
   references `isHome()`) to confirm no other caller assumed the old, looser semantics.
3. Consider whether `segmentSuffixMatch` should also reject a match when either side is shorter than
   some minimum length (e.g. 2-3 chars) to further reduce accidental collisions — not done tonight to
   keep the diff to exactly the falsified defect, flagged for a future night if it recurs.
