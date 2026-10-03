# Provenance-Stratum Receipt Attribution — Reconciliation Night — 2026

**Dream Cycle 2026-09-23 — DEEP=grounding-quality, SCAN=retrieval-precision,citation-binding (slot 3 of 5, `20260923 % 5 == 3`)**. No bonus modulus tonight (`% 25` = 23, `% 75` = 48, both non-zero).

## Rotation / Ledger Check

`main`'s own `docs/dream-cycle/LEDGER.md` stops at 2026-08-31 (9 rows) — **stale**, not because the
routine stopped, but because ledger rows ship inside draft PRs that are not merging. Reconciled against
the real state instead: `origin/dream/*` branches exist through **2026-09-22** (27 branches), confirming
the routine has run every scheduled night. Read the ledger as committed on the most recent branch
(`dream/2026-09-22-enforcement-integrity`) instead of `main`'s stale copy.

**The backlog, independently re-measured tonight via GitHub MCP (`list_pull_requests`, both states):**
25 open draft `dream/*` PRs (oldest: `#269`, opened 2026-09-08, now **15 days**), plus 3 open non-dream
PRs (`dependabot` ×2, `release/4.3.29`). Every one of the last 30 *closed* PRs checked tonight — dream
and non-dream alike, back to 2026-08-20 — reads `merged: false` in the GitHub API, even several (`#315`,
`#318`) whose commits plainly landed on `main` (`git log` shows `(#315)`/`(#318)` suffixes) — work is
reaching `main` through a path this API field doesn't credit as "merged," but the `dream/*` track
specifically shows **zero** landed content on `main` from any of the 25 open branches. Zero `dream/*`
PRs merged since `#178` (2026-08-26) — now **28 days**, worse than every prior night's report (23 days
on 2026-09-18, "nearly 4 weeks" on 2026-09-22). This was flagged to the human owner directly tonight,
ahead of any per-night report, since it is stale by definition otherwise. See **Recommendation**.

## Reconciliation (per ISSUE DISPOSITION OVERRIDE)

Tonight's slot (grounding-quality / retrieval-precision,citation-binding) already has an open, complete,
independently-critiqued, CI-green candidate: **PR `#297`** (`dream/2026-09-18-grounding-quality-provenance-receipt`),
which fixes `scripts/eval-brain.mjs`'s `gradeQuestion()` `provenance` case to grade off `routedRepo`
(the citation `kb/verify-citation.mjs` actually verified as resolving) instead of the raw top-ranked,
possibly-fabricated citation. PR `#297`'s own comment thread shows a prior session already brought it
fully current against `main` on 2026-09-22 (merge-conflict resolution after `main` gained an independent,
complementary `!abstained` fix; re-verified 20/20 unit, byte-identical integration, fully green CI) and
left it "waiting on human review" — unchanged since.

Per this repo's `findingPolicy`/ISSUE DISPOSITION OVERRIDE (`skipIf: duplicate-open-issue,
existing-fix-pr`), opening a second PR proposing the identical fix would be pure backlog padding — the
exact failure mode 5 of the last 6 grounding-quality nights have warned about. Tonight's honest,
non-duplicative contribution is **independent same-day re-verification** (dated 2026-09-23, not reused
from 2026-09-18/22) that the fix is still correct, still current, and still necessary, plus fresh
evidence pushed into the durable record.

## Five candidates considered (one selected)

1. **[SELECTED]** Independently re-verify and reconcile PR `#297` — already the correct, minimal,
   fully-critiqued fix for this exact surface; adding a second body of evidence rather than a second PR
   is the only action that doesn't worsen the backlog.
2. Open a new PR with the identical `routedRepo` fix — rejected: `#297` already exists, open, green,
   current; a duplicate PR is exactly the anti-pattern the backlog finding argues against.
3. Issue `#236`'s citation-rank-hijack structural gap (recovered as ADR-0087 via PR `#287`, still
   `Proposed`/open) — rejected again tonight: still requires a human wire-format decision, outside
   bounded-repair authority, unchanged since three prior nights' identical analysis.
4. Fresh code-reading pass over `kb/forge-ask-all.mjs` / `kb/verify-citation.mjs` for a new
   retrieval-precision defect — attempted; no genuinely new, small, testable gap surfaced beyond what
   prior nights already found-and-fixed or found-and-rejected (citation spoofing: fixed 08-28; routed
   receipt: fixed 08-28; provenance receipt: this PR; rank-hijack: blocked on ADR-0087; `bannerPresent`
   regex scope: flagged non-blocking by two independent critics now, still not the failure mode in
   front of it — no live repro without a corpus this container doesn't have).
5. `rerank-cap-eval.mjs`/`rerank-cap-warm-ab.mjs`'s "grounded ⇒ ≥1 result" treatment (flagged 2026-08-28,
   still unactioned) — rejected: offline A/B tooling, not the gate of record, needs design work not a
   bounded patch, and doesn't fit tonight's bias toward reducing the backlog rather than adding to it.

## Hypothesis (frozen before touching anything, re-verified unchanged)

> Given the frozen `provenance` stratum in `scripts/eval-brain.mjs`'s `gradeQuestion()`, when the "did a
> winning gist chunk carry its banner" check is computed from `routedRepo` (`receipt?.repo ?? top?.repo
> ?? null`) instead of the raw top-ranked citation (`citations[0].repo`), then the `provenance` stratum
> should correctly fail a bannerless gist chunk that `verify-citation.mjs` actually verified as the
> grounding source, even when a different, unverified citation ranks first — subject to: zero behavior
> change for `grounded`/`routed`/`abstained`, `ABSTAIN_CE` unchanged, `evals/held-out.json` hash
> unchanged, and the two receipt-less callers of `gradeQuestion` behaviorally unaffected.

## Candidate (unchanged from PR #297, re-verified not re-authored)

`scripts/eval-brain.mjs` line 95: `top?.repo !== 'ruv-gists'` → `routedRepo !== 'ruv-gists'`.
`tests/unit/eval-brain-gate.test.mjs`: one `it()` covering both directions. Confirmed via `git blame`
that current `main` (`e89ea1ba`, commit `12f8bf14`, human-authored 2026-09-19) landed only the sibling
`!abstained` half of this same case — the `routedRepo` half this PR fixes is still live and unpatched on
`main` today.

## Baseline

Unmodified `origin/main` at `e89ea1ba167d9252ec99910304f534c8da5ca0ab` (tonight's `SESSION_COMMIT`),
isolated in a separate `git worktree` at `/tmp/baseline-worktree` (removed after use) to avoid
contaminating the comparison with this branch's own committed report/evidence files.

## Evaluation Receipt (fresh, dated 2026-09-23, independent of PR #297's own claims)

- **`npm run eval:gate`**: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`. Confirmed
  independently: `node scripts/brain-score.mjs` → `stores 0 dark 0`; `node scripts/restore-local-ingests.mjs`
  → exit 2, 125 recorded ingests never materialized on this host, script's own wording: "NOT evidence of
  a wipe" (fresh/ephemeral container, exactly as documented). Same pre-existing condition every recent
  night has recorded.
- **`LLM_EVAL=blocked`**: no `OPENROUTER_API_KEY` or any model-provider key in this container's
  environment (`env | grep -iE 'OPENROUTER|ANTHROPIC|OPENAI'` → none).
- **`gh` CLI**: not installed this session (`which gh` → not found); GitHub MCP tools available and used
  instead (confirmed authenticated as `stuinfla` via `get_me`) for issue/PR reads — no gist-creation MCP
  tool exists, so **GIST: LOCAL** again tonight, same limitation every prior night has recorded.
- **TEETH, independently reproduced twice tonight** (this session, then a fresh independent critic
  subagent with no shared context): reverting only the `scripts/eval-brain.mjs` hunk turns the new test
  RED (`AssertionError: expected false to be true`, 19/20 pass); restoring is GREEN (20/20 pass). Actual
  command output captured both times, not paraphrased.
- **Evidence script** (`docs/dream-cycle/evidence/2026-09-18-grounding-quality-repro.mjs`, corpus-free
  and model-free, re-run tonight unmodified): exit 1 "VULNERABLE" against unmodified `main`
  (`e89ea1ba`), exit 0 "FIXED" against the candidate branch.
- **`npm run test:unit`** (460 files/5795→5796 tests): baseline `16 failed | 434 passed | 10 skipped`
  files, `51 failed | 5559 passed | 47 skipped | 138 todo` tests. Candidate: **identical 16 failing
  files** (`adr-format`, `advocacy-ignored`, `advocacy-outcomes`, `advocacy-route`,
  `agentic-qe-early-public`, `candidate-retrieval-matrix`, `console-memory-canonical-store`,
  `corpus-accuracy-gate`, `corpus-customer-promotion`, `corpus-seed-release-authority`, `doc-currency`,
  `hook-shim-fallback-once`, `no-restated-truth`, `rehearse-corpus-pipeline`, `retrieval-canary`,
  `user-settings` — `diff` of the sorted file lists is empty), `50 failed | 5561 passed | 47 skipped |
  138 todo` tests. None reference `scripts/eval-brain.mjs`, `kb/verify-citation.mjs`, or
  `tests/unit/eval-brain-gate.test.mjs`. Net: +1 total test is exactly the one new assertion; failure
  count is *lower* on the candidate (one flake resolved favorably, not a regression).
- **`npm run test:integration`** (51 files/407 tests): baseline and candidate **byte-identical**: `9
  failed | 38 passed | 4 skipped` files, `23 failed | 323 passed | 16 skipped | 45 todo` tests, same 9
  files both sides (`anticipate`, `anticipate-dial`, `console-apply-timings`, `health-repair`, 4×
  `project-progression-*`, `reader-deadlock-regression`) — all pre-existing (missing ONNX/CE model
  cache, root-permission simulation, headless-browser timing), zero touching changed files. Both-hosts
  conformance gate unaffected.
- **`npm run claims:verify`**: `3 PASS / 4 SKIP` — identical composition to every documented night
  (brain-dependent claims skip loudly; coverage run absent; no fabricated pass).

## Blast Radius

`gradeQuestion` has exactly 3 call sites repo-wide (independently re-grepped by the adversarial critic
tonight): `scripts/eval-brain.mjs` (fixed), `scripts/rerank-cap-eval.mjs`, `scripts/rerank-cap-warm-ab.mjs`
— neither of the latter two ever constructs a `receipt`, so `routedRepo = receipt?.repo ?? top?.repo ??
null` falls back to the prior `top?.repo` behavior for both, confirmed empirically (`receipt: undefined`
produces byte-identical output to the pre-fix code).

## Darwin Lineage

Not run — no continuous parameter to evolve for a discrete scoring-attribution correctness fix.

## Evidence

OBSERVATION (`gradeQuestion`'s `provenance` case reads `top?.repo` directly on `main` today, confirmed
via `git blame` to be an incomplete manual port of PR `#297`'s own diff) → MEASUREMENT (TEETH red
pre-fix / green post-fix, reproduced independently twice tonight by two separate agents; evidence script
VULNERABLE→FIXED against tonight's actual `main` HEAD) → INFERENCE (blast radius confined to the one
call site with a `receipt`; zero regression across 460+51 test files) → DECISION (ACCEPT, reconciliation
only — no new commit needed, PR `#297` already carries this fix, pending human review).

## Reward-Hack Check (independently re-derived by a fresh critic subagent tonight, not reused)

1. **Weakened test/benchmark** — CLEAR: `git diff origin/main HEAD -- evals/` empty.
2. **Vacuous assertion** — CLEAR: concrete adversarial fixtures, both directions asserted, RED→GREEN
   reproduced twice.
3. **Hidden cost** — CLEAR: reuses an already-computed variable; no new I/O/dependency/subprocess.
4. **Cherry-picked corpus** — CLEAR: pure-function synthetic fixtures, not a hand-picked held-out subset.
5. **One-directional score inflation** — CLEAR: fix is bidirectionally corrective (turns a false FAIL
   into a correct PASS *and* a false PASS into a correct FAIL); critic could not construct a new
   leniency loophole reachable from the real `verifyGrounding()` call site (one theoretical loophole
   requires a caller to pass a `receipt` inconsistent with its own `citations`, which breaks an
   invariant no real caller violates — same trust boundary already accepted for the `routed` metric
   since 2026-08-28, not new risk from this diff).

## Adversarial Critique (fresh independent subagent, no access to this session's reasoning)

**Verdict: CLEAR.** Independently: read the diff in full, confirmed exactly 3 call sites and the
algebraic fallback for the 2 receipt-less callers, constructed and ran 2 adversarial break scenarios
via direct `node -e` calls (found one, theoretical, unreachable from the real call site, informational
only), reproduced RED→GREEN itself with actual captured output, confirmed `evals/` untouched. One
**non-blocking** repeat observation (also flagged by the 2026-09-18 critic, pre-existing, unrelated to
this diff): `bannerPresent`'s regex scope is the whole stdout dump, not the specific receipted citation.

## Security Review

Pure, offline scoring-logic change inside an evaluation script consuming only this repo's own
already-generated subprocess output and its own frozen held-out set. `routedRepo` is produced by the
same already-trusted `kb/verify-citation.mjs` disk-verification path already invoked on the same call,
read one property deeper than before. No new network call, credential, write path, or untrusted-input
path. Attack surface unchanged from `main`.

## Regression Analysis

See Evaluation Receipt: `test:integration` byte-identical (9/23 both sides); `test:unit` identical
16-file failure set, one fewer failing test on the candidate (net improvement, not regression). The
changed branch (`provenance` case) executes only under `npm run eval:gate`, itself blocked in this
container — unexercised against real data on this host either way, tonight or on 2026-09-18/22.

## ADR

Not architectural — a bug-fix recovery mirroring an already-accepted sibling fix (`routed`'s own use of
`receipt`, accepted 2026-08-28). No ADR filed, consistent with that fix's own precedent and PR `#297`'s
own prior decision not to file one.

## Gist

LOCAL — no `gh` CLI, no gist-creation MCP tool this session (same limitation every prior night has
recorded). Full report committed at `docs/dream-cycle/2026-09-23-grounding-quality-reconciliation-report.md`.

## Issue

`NONE` — per ISSUE DISPOSITION OVERRIDE: this is a re-verification of an already-open, already-tested,
already-critiqued fix PR (`#297`), not a new defect. No issue opened, none needed.

## PR

`#297` (existing, not new) — no new commit pushed tonight, since the branch is already 0 commits behind
`main` and already carries the complete, correct, current fix (confirmed via `git rev-list --left-right
--count origin/main...origin/dream/2026-09-18-grounding-quality-provenance-receipt` → `0  56`, and
`git diff origin/main origin/dream/... -- scripts/eval-brain.mjs` shows exactly the one intended hunk,
nothing else drifted). Posted one reconciliation comment on `#297` recording tonight's independent
re-verification (dated, with fresh numbers) rather than a redundant second status update, and repeating
the now-worse backlog figure with today's exact count.

## Recommendation

`evaluated: yes`, `verdict: ACCEPT` (already established 2026-09-18, re-confirmed independently tonight;
pending human review and merge — never self-promoted). With more urgency than any individual finding:
**the `dream/*` backlog is the single highest-value thing for the human owner to act on.** 25 open draft
PRs, oldest 15 days, zero merged in 28 days — worse every night this has been checked. PR `#297`
specifically is a fully green, twice-independently-critiqued, zero-regression, one-line fix that has
been ready to merge since 2026-09-18 (5 days) and fully current since 2026-09-22 (1 day). Tonight
deliberately added evidence, not backlog: reconciliation, not a new PR.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
REPORT_HASH    = 7738098b99242ae0477e298bb2ea691b658673110058d03c1f7b33b4369462b4
WITNESS        = 3d03a0cca2b356cb535e9d1a1ce581b3d20af6bd77269e8a502e7166eb7180ba
```

Note on `REPORT_HASH`: sha256 of this report's content as it stood through the "Recommendation"
section, computed BEFORE this Witness section was rewritten with the stamp — it will therefore NOT
match a fresh `sha256sum` of this file as it now reads, since rewriting this section changed the bytes.
Expected by construction (STEP 16's own chicken-and-egg order), not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout e89ea1ba167d9252ec99910304f534c8da5ca0ab` (tonight's base commit on `main`).
2. Check out `origin/dream/2026-09-18-grounding-quality-provenance-receipt` (PR `#297`'s head, unchanged
   by tonight's run).
3. Recompute `sha256(REPORT_HASH + SESSION_COMMIT)` — must equal `WITNESS` above.
4. `git checkout HEAD -- scripts/eval-brain.mjs` after restoring `origin/main`'s version, run `npx
   vitest run tests/unit/eval-brain-gate.test.mjs` (must show 1 failed/19 passed), then restore the
   candidate's version (must show 20/20 passed).
5. Run `node docs/dream-cycle/evidence/2026-09-18-grounding-quality-repro.mjs` against unmodified `main`
   (exit 1, VULNERABLE) and against the candidate branch (exit 0, FIXED).
6. Run `npm run test:unit` and `npm run test:integration` on both an unmodified `main` worktree and the
   candidate branch; confirm the failing-file lists are identical (`test:integration`) or the candidate
   is no worse (`test:unit`), and none touch `scripts/eval-brain.mjs` or `tests/unit/eval-brain-gate.test.mjs`.
