# Brain-Currency SOTA Report — 2026

**Dream Cycle 2026-09-26 — DEEP: brain-currency / SCAN: dark-stores, corpus-freshness (slot 1)**

## TL;DR

This is a reconciliation-and-revival night, not a fresh-research night. Tonight's ledger check
(STEP 1) found that `docs/dream-cycle/LEDGER.md` on `main` is stuck at its 2026-08-31 row while the
routine has fired nightly through 2026-09-25 — every one of those ~25 nights' ledger rows lives only
on its own unmerged `dream/*` branch, because **zero dream-cycle PRs have merged since #178
(2026-08-26)**. As of tonight there are 15+ open, unreviewed `dream/*` draft PRs, several explicitly
titled "reconciliation" (#321, #322) because prior nights already pivoted away from adding fresh
findings to an unreviewed pile.

Reconciling this slot's own backlog turned up two `brain-currency` items from 2026-09-06 (issues
#258, #260) that were never closed out:
- **#258** (`panelStrict` freshness read checkout mtime, not grading time): turns out to be
  **already fixed and integrated on `main`** — via commit `12f8bf1` ("chore(release): prepare 4.3.27
  recovery candidate", 2026-09-19), a different implementation (`summary.generatedAt`) than the
  originally-proposed PR #259 (`recordedAt`), which was itself closed unmerged without landing.
  Closed issue #258 tonight as integrated (`closeIntegratedWork`), no code change.
- **#260** (`kb/forge-currency.mjs`'s `brainKnownSet()` reads `SOURCE.json` from this checkout
  instead of the caller's `root`): confirmed **still broken on current `main`** (`e89ea1ba1...`) by
  direct reproduction. Its candidate fix (PR #261, 2026-09-06) was fully diagnosed, implemented,
  tested, and independently critiqued CLEAR at the time — but that PR was also closed unmerged
  (stale-closed, same pattern as #259, no rejection reasoning found in its comments). Tonight revives
  that exact fix, re-validated fresh against current `main` rather than re-researching from scratch.

## What's new

Nothing externally new. This night's contribution is closing a loop a stale-close broke: reproduce →
confirm the diagnosis still holds → re-apply the same bounded fix → re-run the full evaluation suite
fresh against tonight's `main` (which has moved substantially since 2026-09-06) → open a new PR.

## Hypothesis (frozen before implementation)

> Given `kb/forge-currency.mjs`'s `brainKnownSet(root)`, when `root` is a store root whose own
> `SOURCE.json` differs from (or is absent relative to) this git checkout's committed
> `kb/SOURCE.json`, the function's name-alias half will read this checkout's own `kb/SOURCE.json`
> regardless of `root` (via the module-level `SOURCE_PATH` constant), so the returned "known" Set
> mixes live `.rvf` filenames from `root` with a foreign or stale set of `sourceRepo`/`kbName`
> aliases — changing the read to `path.join(root, 'SOURCE.json')` should make the returned Set
> reflect only `root`'s own declared state, subject to: zero behavior change for the `.rvf`-derived
> listing (already correct), and the existing graceful skip when no `SOURCE.json` exists at the
> resolved path must be preserved.

## Candidate

Two files, ~15 production lines: `kb/forge-currency.mjs` (drop the module-level `SOURCE_PATH`
constant; compute `path.join(root, 'SOURCE.json')` inside `brainKnownSet()`). Test file:
`tests/unit/forge-currency-helpers.test.mjs` (+2 cases: alias sourced from `root` not checkout;
no-SOURCE.json-at-root case does not fall back to the checkout's own file).

## Baseline (reproduced fresh on tonight's `main`, `e89ea1ba1...`)

```
has totally-different-repo (expect true):  false   <- root's own SOURCE.json ignored
has metaharness (expect false, BUG if true): true   <- this checkout's real alias leaks in
```

## Evaluation Receipt

- **TEETH**: `git stash push -- kb/forge-currency.mjs` (production fix reverted, tests kept) →
  both new tests fail exactly as predicted (`known.has('metaharness')` true when it must be false,
  on both the foreign-SOURCE.json case and the no-SOURCE.json case). `git stash pop` → 5/5 pass.
- **`test:unit` full suite, baseline vs candidate** (`git stash` on the 2 changed files):
  baseline 16 failed files / 50 failed tests / 5560 passed / 5795 total. Candidate 17 failed / 51
  failed / 5561 passed / 5797 total. **Diff is exactly +1 file** (`convergence-manifest.test.mjs`,
  the mechanical "manifest is stale" consequence of any tracked-source diff) — fixed by
  `npm run convergence:write`, confirmed green after. The other 16 failing files are
  byte-identical baseline vs candidate (chmod/EACCES-under-root, release-identity, and other
  pre-existing container artifacts unrelated to this change).
- **`test:integration`**: baseline vs candidate byte-identical — 9 failed files both sides
  (`anticipate-dial`, `anticipate`, `console-apply-timings`, `health-repair`, 4×
  `project-progression-*`, `reader-deadlock-regression` — all pre-existing
  sqlite3/`@xenova/transformers`/cross-encoder-model-cache infra gaps on this container, none
  referencing the changed files, grep-confirmed). `hook-conformance-both-hosts.test.mjs` (the
  both-hosts conformance gate): **10/10 pass**.
- **`claims:verify`**: 3 PASS / 4 SKIP, unchanged from every recent night's documented baseline.
- **`eval:gate`**: EVALUATED=blocked — `no brain at /root/.cache/ruvnet-brain/kb` (this container
  never materializes a corpus; not the relevant evaluator regardless — no retrieval/grounding
  surface touched). `LLM_EVAL=blocked` too (no `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY` this
  session) — a legitimate no-model-call night.
- **Blast radius**: `grep -rn "brainKnownSet\|SOURCE_PATH"` across `scripts/`, `kb/`, `plugin/`,
  `console/`, `tests/` finds exactly one production call site (`discover()`, unchanged zero-arg
  call) and the one test file. `kb/forge-update.mjs`'s own same-named `SOURCE_PATH` constant is
  confirmed unrelated (different module, different purpose — reads a SOURCE.json bundled next to
  an already-built distribution artifact, not the store root).

## Darwin Lineage

Not applicable — a discrete path-resolution correctness fix has one right answer, not a
fitness-ranked population (same precedent as every structurally identical brain-currency fix since
2026-08-26).

## Evidence

OBSERVATION (issue #260's diagnosis, re-verified live against tonight's `main`, still holds
byte-for-byte) → MEASUREMENT (TEETH red→green reproduced fresh; full-suite baseline-vs-candidate
byte-identical outside the one mechanical delta) → DECISION (ACCEPT, pending human review and the
independent critic's verdict, see below).

## Reward-Hack Check

No file under `evals/`, no gold answer, no threshold touched — only additive `it()` blocks. The fix
makes the "known" Set strictly more accurate to the actual `root` (removes a false inclusion when
`root` has no matching SOURCE.json; adds nothing false), the opposite of a reward hack.

## Security Review

No new attack surface: same read-only `fs.existsSync`/`fs.readFileSync` pattern, now root-relative
instead of checkout-relative. `root` is not attacker-influenced at the one real call site
(`discover()`'s zero-arg call resolves it via `storeRoot()`, gated by the same
`RUVNET_BRAIN_KB`/`KB_DIR` environment variables every other reader in this file family already
trusts).

## Adversarial Critique (independent subagent, not this candidate's author)

**Verdict: CLEAR. No blocking issues.** The critic worked from a fresh context (no prior exposure
to this session's reasoning) and independently:
- Confirmed reward-hack scope: diff touches only `kb/forge-currency.mjs`,
  `tests/unit/forge-currency-helpers.test.mjs`, `data/convergence-manifest.json` — nothing under
  `evals/`, no gold data, no threshold change, both new tests additive.
- Re-derived correctness against the one real call site (`discover()`, zero-arg call defaulting to
  `storeRoot()`) independently, not by trusting this report's claim.
- Re-grepped blast radius itself and confirmed `kb/forge-update.mjs`'s same-named `SOURCE_PATH` is a
  fully separate module with no import/call relationship to `forge-currency.mjs` — not a hidden
  second consumer.
- **Ran its own TEETH proof from scratch**: `git stash push -- kb/forge-currency.mjs` (test file
  kept) → 2 failed/3 passed with real assertion diffs (`expected false to be true` /
  `expected true to be false`), not crashes; `git stash pop` → 5/5 restored, `git status` clean back
  to the original diff.
- Confirmed regression risk is one-directional (strictly more accurate; no plausible path to a lost
  legitimate alias, since the `.rvf`-listing half is unchanged).
- Confirmed `root`'s trust level (via `storeRoot()` → `RUVNET_BRAIN_KB`/`KB_DIR` env vars) is
  unchanged before/after — no new external input path.
- Devised and ran 3 of its own adversarial cases (malformed JSON, nonexistent root, `stores` as an
  unexpected shape) via direct `node` invocation both pre- and post-fix (via its own stash): post-fix
  all three fail closed (empty set, no throw); pre-fix, all three ignored the adversarial root
  content and leaked this checkout's real 33-entry alias set (including `metaharness`) regardless —
  confirming the described defect exactly, from a third angle.
- Non-blocking observation: the `data/convergence-manifest.json` diff is only hash fields
  (`sourceIdentity`, `trackedFilesSha256`) — consistent with mechanical regeneration, not a manual
  edit.

## Competitors (grade C, sizing only)

Sakana AI Scientist, OpenHands, DSPy/GEPA, SWE-agent, Cursor background agents: none have a
published first-class distinction between "the live target's real state" and "the harness's own
bundled/checked-out copy" as a provenance-source concern this repo's own ADR-069 already treats as
first-class. Same framing as every prior brain-currency night on this exact defect class.

## Scan Findings

**dark-stores**: this defect is itself a dark-store false-negative-masking mechanism — the
checkout's own bundled aliases could mask, or on a differently-shaped foreign root, misrepresent, a
genuinely-missing repo in `discover()`'s report. No new dark-store defect found tonight beyond this.

**corpus-freshness**: this candidate IS the corpus-freshness finding — a second, now-closed instance
of the "clone freshness is not artifact freshness" class ADR-069 named for `scripts/brain-stamp.mjs`.

## Standing note for the repo owner

As of tonight: the review backlog first flagged 2026-08-26 is now over a month old. Reviving a
month-old fully-evaluated fix that fell through a stale-close, rather than researching something
new, was the deliberate choice tonight — review throughput, not more nightly research, remains what
blocks this system's realized value. Recommend triaging the ~15-20 open `dream/*` PRs in bulk
(merge, request changes, or explicitly close-as-superseded) rather than letting them continue to
accumulate silently.

## Next steps

1. Human review and merge (or explicit rejection) of the revived candidate PR.
2. Bulk-triage the open `dream/*` PR backlog — the single highest-leverage action available to the
   repo owner right now, repeated from every brain-currency night since 2026-08-26.
3. If a third sibling reader of `SOURCE.json` is found on a future night, the pattern is now:
   resolve it relative to the caller's actual root parameter, never a script's own
   `import.meta.url` directory.

## Witness

```
SESSION_COMMIT = e89ea1ba167d9252ec99910304f534c8da5ca0ab
REPORT_HASH    = 349e453693f04885a040b565830c22d00a055e260b92a4410f3186ba4dbda8e2
WITNESS        = a092fc12e068b1319d7b98bf9df707e7dafb1c580f1019f5c6abaf8934d5cfb7
```

Note on `REPORT_HASH`: it is the sha256 of this report's content as it stood through the
"Recommendation"-equivalent sections (TL;DR through Next steps, before this Witness section itself
was rewritten with the stamp values) — the standard chicken-and-egg order this pipeline's STEP 16
specifies. It will therefore NOT match a fresh `sha256sum` of this file as committed, since filling
in this section changed the bytes — expected by construction, not evidence of tampering.

**Verifier procedure (reproduce independently):**
1. `git checkout e89ea1ba167d9252ec99910304f534c8da5ca0ab` (this cycle's base commit on `main`).
2. Apply the candidate diff from the PR this report is attached to.
3. `npx vitest run tests/unit/forge-currency-helpers.test.mjs` — 5/5 pass.
4. Revert only `kb/forge-currency.mjs` (`git stash push -- kb/forge-currency.mjs`), re-run the same
   file — the two new cases must fail (`known.has('totally-different-repo')` false,
   `known.has('metaharness')` true). Restore (`git stash pop`) and confirm green again.
5. `printf '%s%s' 349e453693f04885a040b565830c22d00a055e260b92a4410f3186ba4dbda8e2 e89ea1ba167d9252ec99910304f534c8da5ca0ab | sha256sum` → must equal `WITNESS` above.

## Recommendation

`evaluated: accepted`. Draft PR filed against issue #260, superseding the stale-closed PR #261 with
a fix re-validated fresh against tonight's `main`. Human review required — this session never
self-merges or self-promotes.
