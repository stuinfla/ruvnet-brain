# Memory-Durability SOTA Report — 2026-09-09

## TL;DR

`scripts/record-lesson.mjs`'s round-trip write-verification (added 2026-08-24, PR #167) proves a
store call actually persisted by retrieving the same key back and checking the VALUE — the discipline
ADR-063 established after the 2026-08-13 incident (`ruflo memory store` printed `[OK]` on every write
for three days while nothing persisted). That fix closed the main incident shape but left a narrower,
previously-identified gap open: the round-trip key (`lesson-${slug}`) is deterministic, so a SECOND,
IDENTICAL invocation (a retried or replayed capture with the same `--task`/`--tried`/`--worked`/
`--critique`/`--outcome`, hence the same intended value) whose store call silently no-ops would still
retrieve the FIRST run's value back unchanged — `back.includes(value)` cannot tell "this run wrote it"
from "a prior run wrote it and this run wrote nothing." The 2026-08-29 report named this exact gap
(candidate #2 in that night's five-candidates table) and explicitly deferred it: *"not this repo's
candidate to re-litigate while #167 awaits review."* #167's fix is now confirmed present on `main`
(verified below), so the deferred condition is met and this report closes the gap it was waiting on.

Fix: a one-shot, per-process NONCE "pathway probe," written to a **disposable** key (never the real
`lesson-${slug}` key), mirroring `degradation-watch.mjs`'s `proveMemoryDurable()` exactly — store a
nonce that cannot pre-exist under any prior content, verify IT round-trips, and only then trust the
real write's round trip. `stored` now requires both checks. An earlier draft of this fix poisoned the
real key in place before overwriting it with the real value; an independent adversarial review caught
that this created a new interruption-window data-loss risk (a process killed between the poison write
and the real write would permanently replace a prior run's genuine lesson with nonce garbage) and it
was corrected before this report was finalized — see Reward-Hack Check.

## What's new

Nothing external — this is a residual gap in this repo's own previously-shipped discipline, in a file
already read end to end by two prior Dream Cycle nights (2026-08-24, 2026-08-29).

## A note on tonight's ledger check: a git history rewrite, not nine missed nights

`docs/dream-cycle/LEDGER.md` on `main` still ends at 2026-08-31, and every `list_pull_requests` call
tonight showed **zero merged** dream-cycle PRs since 2026-08-26's #178 — including two, #244 and #246
(2026-09-04, this same DEEP surface), that were **closed without merging** by the repo owner on
2026-09-07. Read naively this looks like a nine-night gap and a wave of rejected candidates. It is
neither: `git log` shows the entire repository history was squashed to a single new root commit,
`4df9f3e0b66219df64253ddebd1f5623265ea446` (no parents), authored and committed 2026-09-07 by the repo
owner. Every dream-cycle PR opened before that date now targets a history `main` no longer shares,
which is why GitHub reports them `closed`/`merged:false` regardless of their actual disposition.

Grep-verified against the current squashed tree: the fixes from #244 (`session-snapshot-contract.mjs`
`legacy()` scanner) and #246 (`health-repair.mjs --distill-fleet` snapshot freshness) are BOTH present
on current `main` byte-for-byte as described in their issues — they were integrated, just not through
a merge commit GitHub's API can see. Reconciled tonight: issues #243 and #245 closed as completed, with
the grep evidence posted to each (see Ledger Check). The broader backlog (~20+ other pre-squash draft
PRs, dated 2026-09-01 through 2026-09-08) was **not** individually audited tonight — flagged for the
owner rather than assumed lost or assumed integrated. `SESSION_COMMIT` for tonight (`7cfd9e17...`) is
itself a descendant of the squashed root, confirmed via `git log --oneline -3`.

## Ledger Check

Read `docs/dream-cycle/LEDGER.md` (ends 2026-08-31, 9 rows). Re-checked via GitHub MCP, not assumed:

- Zero dream-cycle PRs have `merged: true` since #178 (2026-08-26) — unchanged by tonight's findings.
- #243/#244 and #245/#246 (2026-09-04, same DEEP=memory-durability surface): closing PRs show
  `merged: false`, but their fixes are confirmed present on current `main` (see above). Both issues
  closed tonight as completed, each with the grep evidence that proves it, per this repo's own policy
  ("Integrated work is reconciled against current source; its historical finding is not a reason to
  reopen it").
- #165/#167 (2026-08-24, `record-lesson.mjs` round-trip fix) and #191/#192 (2026-08-29,
  `distill-project.mjs` freshness fix): both already closed (`state_reason: completed`) by the owner
  pre-squash; both fixes independently confirmed present on current `main` by direct grep before
  tonight's candidate was designed, so as not to duplicate resolved work.

**Learning signal applied (STEP 1.1):** zero of the recent candidate PRs merged (literally zero,
extending well past the 14-row window) → biased tonight's candidate to the smallest, most
independently-reviewable scope available: one production file, ~35 changed lines, reusing an
already-established pattern (`proveMemoryDurable()`) rather than inventing a new one. No finding has
repeated ≥3 nights on this DEEP surface (four prior nights, four different files: `restore-local-
ingests.mjs`, `record-lesson.mjs`'s wording gap, `distill-project.mjs`, `session-snapshot-
contract.mjs`/`health-repair.mjs`); tonight is `record-lesson.mjs` again, but a structurally distinct,
previously-deferred sub-gap in the same file, not a repeat of the same finding.

## The hypothesis (frozen before implementation)

> Given `scripts/record-lesson.mjs`'s round-trip write verification, when a SECOND invocation with
> IDENTICAL arguments (same `--task`/`--tried`/`--worked`/`--critique`/`--outcome`, hence the same
> `key` and `value`) has a store call that silently no-ops while a PRIOR invocation's genuinely
> successful write of the exact same value is still present at that key, then the existing
> `back.includes(value)` check currently reports success (a false positive — this run wrote nothing);
> adding an independent, per-process nonce "pathway probe" — written to a disposable key, verified to
> round-trip BEFORE the real write is trusted — and gating `stored` on both checks passing, should make
> the script correctly report failure in that scenario — subject to: a genuinely fresh, healthy write
> is still reported as success and exits 0; the original 2026-08-13 incident shape (claimed success,
> real key never retrievable) is still caught; a damaged store answering a SQL-layer error is still
> caught; and the probe never touches the real `key`'s content, so no interruption between the probe
> and the real write can destroy a prior run's genuine lesson.

Unchanged since freeze, with one correction made *before* evaluation was considered complete: the
initial implementation poisoned the real key in place (violating "never touches the real key's
content"); an independent critic caught this before the hypothesis's own "no interruption risk" clause
was actually verified true, and the implementation was corrected to use a disposable key — see
Reward-Hack Check for the full account. The hypothesis's PROSE was not changed after the fact; the
CODE was corrected until it actually satisfied the hypothesis as written.

## Five candidates considered

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `record-lesson.mjs` deterministic-key aliasing gap (chosen) | 5 | 3 | 5 | 5 | 4 | 5 | Previously scored (2026-08-29 report), explicitly deferred pending #167 — now unblocked, confirmed via grep that #167's fix is live on `main`. Reuses an established pattern rather than inventing one. |
| 2 | Audit the ~20 pre-squash draft PRs for what actually landed vs. was lost | 4 | 4 | 2 | 2 | 5 | 1 | Real and important, but not a single falsifiable hypothesis testable tonight — it's a reconciliation project across ~20 PRs. Flagged for the owner instead (see squash note above); too large for a <300-line, one-conceptual-change candidate. |
| 3 | `newestSnapshot()`'s cross-process lock gap (flagged non-blocking by two independent critics, 2026-08-29 and 2026-09-04) | 3 | 2 | 3 | 3 | 2 | 3 | Real, but explicitly scoped out twice already as "strictly narrower than before, not a new risk" — low urgency, and introducing a real lockfile is a bigger conceptual change than tonight's budget favors given the zero-merge learning signal. |
| 4 | `MTIME_GRACE_MS` configurability for coarse-mtime filesystems (2026-08-29 report, "next steps #3") | 2 | 2 | 2 | 2 | 1 | 3 | No reported production filesystem this repo targets has coarse-enough mtime resolution to need it; speculative, no concrete evidence of a live problem. |
| 5 | `learning-replay-fixture.mjs`'s `retrieveExact()` | 1 | 1 | 3 | 3 | 2 | 3 | Read in full (again, having been read on 2026-08-29 too); already correct, already uses the exact-key round-trip discipline this report applies elsewhere. No defect found. |

## Evaluation

Not a retrieval-quality candidate — `npm run eval:gate` independently blocked in this container:
`eval-brain: no brain at /root/.cache/ruvnet-brain/kb` (store root never materialized here; confirmed
independently via `scripts/brain-score.mjs` — `stores 0 dark 0` — and `scripts/restore-local-
ingests.mjs`, which explicitly states this shape is "NOT evidence of a wipe," same condition as every
Dream Cycle night since 2026-08-19). `OPENROUTER_API_KEY` absent tonight → `LLM_EVAL=blocked`, but
irrelevant here: no stage in this candidate needs a model call (a deterministic process/filesystem
verification guard).

**TEETH, proven to fail first — twice, once per implementation revision.**

*Revision 1 (probe on the real key):* `git stash push -u -- scripts/record-lesson.mjs`, ran
`npx vitest run tests/unit/record-lesson.test.mjs` against unmodified `main`: the new "second,
identical invocation" test failed — `AssertionError: expected +0 to be 1` — while the four
pre-existing tests still passed. `git stash pop`: 5/5 pass.

*Revision 2 (probe on a disposable key, after the critic's finding — see Reward-Hack Check):*
re-ran the same stash/pop cycle. Against unmodified `main`: **2 of 5 fail** (the new test, plus the
first TEETH test, whose assertion was independently tightened from an `OR` of two possible messages
to the single message actually reachable post-fix — see Reward-Hack Check item 3). Restored: 5/5 pass.

## Regression analysis

- `npx vitest run tests/integration` (full suite): baseline (`git stash`) vs. candidate —
  **byte-identical**, 21 failed files / 21 failed tests / 288 passed / 12 skipped / 53 todo of 374
  both sides. All 21 pre-existing/environmental (a mix of the documented chmod/EACCES-under-root
  class and several tests that shell out to `git show`/`git cat-file` against short SHAs from the
  PRE-squash history, which no longer resolve in this container's squashed clone — a new, distinct
  environmental class surfaced tonight by the squash discovery above, not caused by this candidate).
- `npx vitest run tests/integration/hook-conformance-both-hosts.test.mjs` in isolation: **9/9 pass**,
  green — both-hosts conformance gate unaffected.
- `npx vitest run tests/unit` (full suite, 381 files, ran to completion, 457s): 18 failed files / 4387
  passed / 46 skipped / 150 todo of 4601. `record-lesson.test.mjs` is not among the 18 (confirmed by
  grep on the run log). The 18 span the same pre-existing chmod/EACCES-under-root and
  post-squash-short-SHA classes noted above, plus one pre-existing `workflow-env-references-
  resolve.test.mjs` failure (`$RUNNER_ENVIRONMENT` read-but-undefined across 4 workflow files) and one
  `convergence-manifest.test.mjs` failure that tonight's candidate itself causes structurally (any
  tracked-source change makes the manifest stale by design) — fixed in this same PR by regenerating
  `data/convergence-manifest.json` via `npm run convergence:write` (confirmed clean after: `{"ok":true,
  ...}`), not left as a failure.
- Blast radius: `grep -rn record-lesson` repo-wide — exactly `scripts/record-lesson.mjs` (this
  candidate), `tests/unit/record-lesson.test.mjs` (this candidate's test), `scripts/wired-check.mjs`
  (confirms the script is human-run, never model-invoked — unaffected, `npm run wired:check` exits 0
  clean), and `plugin/scripts/degradation-watch.mjs` (names `record-lesson` as an event string in its
  own `DEPENDENT_COMMANDS` table — unrelated to this file's internals, unaffected).
- `node scripts/sync-version.mjs --check`: `4.3.16` agrees on every surface.
- `node scripts/doc-currency.mjs --check --changed HEAD`: no blocking currency violations; confirmed
  no ADR's `governs:` frontmatter lists `scripts/record-lesson.mjs` — no Currency-log row required, no
  ADR warranted (a bug fix to a verification detail, not an architectural decision).
- `npm run claims:verify`: 3 PASS / 4 SKIP, identical class to every prior night (skips all
  environmental — brain not installed).
- `node scripts/sync-census.mjs --check`: repository-count surfaces agree (built=77, catalogued=200);
  chunk/store census UNKNOWN (no `.rvf` artifacts in this checkout) — unrelated to this candidate.
- `node scripts/verify-channels.mjs --pre-push`: version check passes; the self-update-manifest-404
  check fails with HTTP 403 from `api.github.com` — an outbound network/rate-limit condition of this
  sandboxed container (this session's own environment notes an HTTPS proxy in front of all outbound
  calls), unrelated to this candidate's diff, which touches no release/update-manifest code.
- No local `.git/hooks/pre-push` is installed in this fresh checkout (no `core.hooksPath`, no Husky
  found), so the equivalent gates were run manually rather than triggered by `git push` itself; none
  were bypassed.

**Independent critic (a fresh general-purpose agent, not this candidate's author).** Full account in
Reward-Hack Check below — verdict on the FINAL, corrected candidate: the blocking finding from the
first review round is resolved; no further issues raised on request to re-review the disposable-key
version's actual behavior via the same TEETH reproduction.

## Darwin Results

Not run — no continuous parameter to evolve for a boolean pathway-liveness gate; skipped rather than
run for form's sake, same precedent as every prior memory-durability night.

## Evidence

- OBSERVATION: `record-lesson.mjs`'s round-trip key is deterministic; a stateless test double cannot
  even model the aliasing gap (a canned-string fake's `retrieve` ignores what was actually stored),
  which is itself evidence the original 2026-08-24 test suite could not have caught this class.
- MEASUREMENT: TEETH proof above, reproduced independently by a separate agent instance, twice (once
  per implementation revision).
- INFERENCE: this is the third file in this repo to receive the "prove it, don't infer it" discipline
  applied via a disposable nonce probe (`degradation-watch.mjs` → `record-lesson.mjs`'s original fix →
  now `record-lesson.mjs`'s own probe mechanism), and the second time in this repo's Dream Cycle
  history that an independent critic caught a real defect in the FIX ITSELF before it shipped (the
  first was PR #167's own reward-hack pass adding a 4th discriminating test case).
- DECISION: ship the disposable-probe-key version; the real-key-poisoning first draft is not shipped
  in any form — fully superseded, not merely amended.
- REJECTION: none — no candidate direction was abandoned tonight; the correction was to execution, not
  to the hypothesis.

## Reward-Hack Check

**Independent-critic pass (a fresh general-purpose agent, not this candidate's author) — full
account, including a real finding.** The critic was asked to reproduce the TEETH proof itself, trace
the fix's logic rather than trust the comments, check for weakened assertions in the test refactor,
review security/blast-radius, and look for edge cases.

Findings:
1. **Reproduced TEETH independently** — confirmed 1 new test failing red pre-fix, 5/5 green post-fix
   (first revision).
2. **Traced the aliasing-gap closure logic itself** and confirmed it works as claimed.
3. **Test refactor check**: confirmed all four original scenarios (incident/healthy/corrupt/missing)
   still exercise the same real-world behaviors through the new stateful fake, not weakened versions.
   Flagged one non-blocking looseness: an assertion regex with a dead alternative
   (`/pathway unproven|retrieve did not return the value/`) where only the first branch was actually
   reachable — tightened in response (see Regression analysis, "Revision 2").
4. Security review: no new attack surface, confirmed by tracing (same as this report's own Security
   Review below).
5. Blast radius: confirmed via its own independent grep, matching this report's findings.
6. **BLOCKING FINDING**: the first implementation wrote the nonce poison to the SAME key
   (`lesson-${slug}`) as the real lesson, before overwriting it with the real value. The critic traced
   a concrete failure scenario: a process killed (Ctrl+C, SIGKILL, OOM) between the poison store and
   the real store, on a REVISION of an existing lesson slug, would permanently replace that prior,
   genuinely durable lesson with meaningless nonce garbage — a new data-loss mode introduced by this
   durability fix itself, on the one file whose entire purpose is durable capture. The critic correctly
   noted the precedent this violated: `degradation-watch.mjs`'s `proveMemoryDurable()` already uses a
   wholly disposable key for exactly this reason, and the first draft did not follow it.
7. Verdict on first draft: **NOT CLEAR**.

**Response**: the finding is correct and was not disputed. Fixed by moving the probe to a disposable
key (`${key}-pathway-probe-${pid}-${Date.now()}`) that is never written to, read from, or capable of
colliding with the real lesson's key — the real key is untouched until the single real store call. Also
tightened the loosened assertion the critic flagged (item 3). Re-ran the full TEETH cycle on the
corrected version (see Regression analysis, "Revision 2") — 5/5 pass, and the interruption-window risk
no longer exists by construction (the real key is written to exactly once, same as before this
candidate existed).

This is disclosed in full, not summarized away, because it is exactly the failure mode this repo's own
`extraDisciplines` name: "a guard that cannot fail is not a guard" — and, symmetrically, a fix for a
durability gap that introduces a NEW durability gap is not a fix. The adversarial-critique step (STEP
10) caught it before it shipped, which is what that step is for.

## Security Review

No new attack surface in the final version: the diff adds two extra `ruflo` subprocess calls (a
disposable-key store + retrieve) using the exact same `ruflo(...)` wrapper and `RUFLO_BIN` resolution
already in use — no new external input, no new write path beyond a throwaway key that is never read by
anything else, no new dependency, no new network call or credential. `scripts/wired-check.mjs` confirms
`record-lesson.mjs` is human-run only, never invoked by the model — unaffected by this change (still
true). The interruption-window data-loss risk the critic found in the FIRST draft is fully closed in
the shipped version, not merely mitigated (the real key is never touched by anything other than the one
real store call, exactly as before this candidate existed).

## Scan Findings

**managed-boundary**: `record-lesson.mjs`'s write path stays inside the sanctioned managed interface
(`ruflo memory store`/`retrieve`) for both the real write and the new probe — never raw SQLite, both
before and after tonight's diff. No bypass found.

**round-trip-proof**: this scan surface IS tonight's Deep Dive finding — a deterministic round-trip key
could be aliased by stale content, closed via an independent, disposable-key nonce probe. No second,
independent round-trip-proof finding reported separately, to avoid double-counting.

## Competitors — write-verification-under-repetition stance (as documented; none used to justify the fix)

| System | Stance on idempotent/repeated-write verification | Grade |
|---|---|---|
| OpenHands (Agent SDK) | 2026 SDK docs name durable state management as a foundation requirement; no documented mechanism for distinguishing a fresh write from stale-but-identical prior state. | A (arXiv 2511.03690, general framing only) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts — a different architecture that sidesteps this exact aliasing class structurally (each mutation is its own version, never overwriting in place). | A (official repo) |
| SWE-agent | No public claims on repeated-write verification surfaced tonight. | C (not deeply searched) |
| Cursor background agents | No public documentation on write-verification-under-repetition surfaced tonight. | C (general framing only) |
| Sakana AI Scientist | No public documentation describing an explicit freshness/liveness check distinct from content-match on its own state artifacts. | C (not deeply searched tonight) |

This repo's own precedent (`degradation-watch.mjs`'s `proveMemoryDurable()`, ADR-063/#140) is the
actual justification — tonight extends that exact pattern to a second file, correcting one execution
mistake along the way, per the adversarial critique it was built to survive.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation as every Dream
Cycle night since 2026-08-19). Full report — competitor grades, evaluation receipt, and the 5-step
witness verifier — committed at this path.

## Witness

```
SESSION_COMMIT = 7cfd9e1770a8583bda9cdc26c614b2de3a77f129
REPORT_HASH    = 776347901f9173055c8f40f3efd6f2a18962e3d39e5a5b77348479199f9af2e9
WITNESS        = 85a28e0b1cdaa4dcf88788c6798e4247041540225146bc4510cff1f69724ac8a
```

(`REPORT_HASH` is the sha256 of this file as it stood immediately before this line was filled in —
i.e. with this Witness section still carrying the placeholder text. Reproducing it requires the
placeholder-Witness version of this file, preserved in git history as this file's first commit.)

5-step verifier: (1) `git log --follow -p -- docs/dream-cycle/2026-09-09-memory-durability-report.md`
and take the version of this file at its first commit (the placeholder-Witness version, this text);
(2) `sha256sum` that version — compare to `REPORT_HASH`; (3) confirm `git show 7cfd9e17...` is `main`'s
HEAD at session start via `git log`; (4) concatenate `REPORT_HASH` + `SESSION_COMMIT` and `sha256sum`
again — compare to `WITNESS`; (5) independently reproduce the TEETH proof: `git stash push -u --
scripts/record-lesson.mjs && npx vitest run tests/unit/record-lesson.test.mjs` (2 cases fail red),
`git stash pop && npx vitest run tests/unit/record-lesson.test.mjs` (5/5 pass).

## Next steps

1. The ~20 pre-squash dream-cycle draft PRs (dated 2026-09-01 through 2026-09-08) were not individually
   audited tonight for what actually landed in the 2026-09-07 squash versus what needs to be
   reconstructed from their branches — the single highest-value reconciliation task surfaced tonight,
   flagged for the owner rather than guessed at.
2. `newestSnapshot()`'s cross-process lock gap (flagged non-blocking twice: 2026-08-29, 2026-09-04)
   remains open — still narrower than before those fixes, not urgent, but not yet closed.
3. `tests/integration` and `tests/unit` each carry a handful of tests that shell out to specific
   pre-squash short SHAs and now fail with `fatal: invalid object name` — a new, distinct environmental
   class surfaced by tonight's squash discovery, worth a dedicated look (likely a fast, mechanical fix:
   those tests need fixtures independent of real repo history, or should skip cleanly when the
   referenced SHA is unresolvable rather than hard-failing).
