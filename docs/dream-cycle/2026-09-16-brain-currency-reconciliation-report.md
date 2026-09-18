# Dream Cycle 2026-09-16 — brain-currency reconciliation (duplicate of PR #292)

## Rotation

DATE=2026-09-16 · DEEP=`brain-currency` · SCAN=`dark-stores`,`corpus-freshness` · SLOT=1
(`20260916 % 5`) · no bonus deep dive (`% 25`=16, `% 75`=41) · SESSION_COMMIT=`0230299408d4ab89a5b6661b55f3ac26396274e9`.

## Ledger Check

Read `docs/dream-cycle/LEDGER.md` (41 rows through 2026-08-31, the most recent on `main`). Reconciled
against GitHub: two open brain-currency issues, **#258** (panel freshness dated by checkout mtime, not
grading time) and **#260** (`kb/forge-currency.mjs`'s `SOURCE_PATH` still checkout-relative). #260
already has an applicable, unmerged fix (PR #280) — not duplicated tonight (`findingPolicy.skipIf:
"existing-fix-pr"`).

## Deep Dive, independently derived

`scripts/brain-score.mjs`'s `readPanel()` already prefers each grade file's own `summary.generatedAt`
over checkout `mtime` (landed via an unrelated 2026-09-13 consolidation commit, `8caa157`) — but
`scripts/brain-grade-groundtruth.mjs`, the sole producer of `data/grade-*.json`, never wrote that
field. `tests/unit/brain-score-producer.test.mjs:198`'s own fixture comment already documents this gap
("no generatedAt — every real `data/grade-*.json` today"). Confirmed live: all 6 committed grade files'
`summary.generatedAt` is `undefined`; `grep generatedAt scripts/brain-grade-groundtruth.mjs` had zero
matches. Issue #258's read-side fix is therefore reachable in name only — the original false-freshness
defect is exactly as live today as it was on 2026-09-06.

I froze this hypothesis, implemented a candidate (extracted a pure `summarizeGrading()` into a new
`scripts/brain-grade-summarize.mjs`, stamping `generatedAt` at the only producer, mirroring this repo's
own `brain-stamp.mjs` → `brain-stamp-resolve.mjs` precedent for extracting side-effect-free logic out
of a network-calling, API-key-gated script), and ran a full TEETH proof plus baseline-vs-candidate
comparison across `test:unit` (byte-identical, 12 failed files/39 failed tests both sides after the
mandatory `convergence:write` regeneration; one full-suite-only flake in an unrelated
`retrieval-canary.test.mjs` assertion, confirmed passing in isolation both before and after),
`test:integration` (byte-identical, 9 failed files/23 failed tests), `qa:pr` (docs/wiring/coverage/
claims-source failures all pre-existing and unrelated — no ADR governs either changed file, confirmed
via `doc-currency.mjs`; the 2 UNWIRED entries reproduce identically with the candidate stashed out),
`claims:verify` (3 PASS/4 SKIP, unchanged), and `eval:gate` (blocked, no installed corpus — expected,
matches every prior night on this container class). A separate, independent adversarial-critic
subagent reviewed the diff: **CLEAR** — verbatim-preserving extraction, one production call site, no
`evals/` file touched, non-tautological tests.

## Reconciliation — this is PR #292, not a second finding

While preparing to push, `git ls-remote origin dream/2026-09-16-brain-currency` showed the branch
already existed: a concurrent firing of tonight's same SLOT=1/DEEP landed **first**, at
2026-09-16T09:23:05Z, as **PR #292** ("Dream Cycle 2026-09-16: brain-currency — panelStrict
generatedAt write-side completion (#258)"). Reading its body: identical root cause (`readPanel()`'s
`generatedAt` preference is unreachable because the producer never stamps it), identical fix shape
(extract a pure summary-builder into a new module — `scripts/brain-grade-summary.mjs` there vs.
`scripts/brain-grade-summarize.mjs` here — stamp `generatedAt` at the producer, inject `now` for
tests), identical evidence pattern (TEETH RED→GREEN, baseline-vs-candidate `test:unit`/
`test:integration`, `qa:pr` lane triage naming the same pre-existing docs/wiring/coverage failures),
same target issue (#258), same conclusion (ACCEPT, human review required).

This is a genuine independent duplicate — two separately-reasoned sessions converged on the same bug
and the same fix, not a case of two different findings sharing a DEEP/SLOT (the pattern most prior
concurrent-night ledger rows describe). Per `findingPolicy.dedupeBy: ["deep", "scan", "path",
"signature"]` and `skipIf: ["duplicate-open-issue", "existing-fix-pr"]`, and per this repo's own
standing concern — a 13-PR-deep `dream/*` review backlog as of tonight, first flagged 2026-08-26 and
unresolved since — shipping a second, nearly-identical diff as PR #293 would add pure duplication to
exactly the problem already flagged, not new evidence. **Standing down from opening a competing PR.**

What tonight's independent work *does* add: PR #292's own body has no independent-adversarial-critic
section. Tonight's session supplies that missing leg — a separately-implemented equivalent fix, put
through its own independent critic pass (CLEAR) and its own full baseline-vs-candidate run, converging
on the same conclusion by a different path. That is corroborating evidence PR #292 did not have before
tonight, recorded here rather than duplicated as code.

**Recommendation**: merge PR #292 (or #280 for #260, whenever reviewed) rather than expecting a third
attempt at the same fix from a future night. This candidate's own diff was discarded (not pushed) to
avoid the duplicate.

## Reward-Hack Check / Security Review

N/A for this row — no production diff ships from tonight's session (see Reconciliation above). The
discarded candidate touched no `evals/` file, no gold answer, no threshold, and no credential/network
surface; full detail was captured in the independent-critic pass and applies equally to PR #292's
equivalent diff.

## Darwin

Not applicable — a deterministic 1-field producer fix has one right answer, not a fitness-ranked
population. (`npx @metaharness/darwin evolve --sandbox mock` ran regardless, returned its generic
canned leaderboard, available-but-inapplicable — consistent with every prior night that checked.)

## Scan Findings

**dark-stores**: `kb/store-root.mjs`'s `darkStores()`/`rootNeverMaterialized()` re-confirmed correct
tonight (`stores 0 dark 0`, this container's store root never materialized — not evidence of a wipe,
per `restore-local-ingests.mjs`'s own framing, confirmed again via `node scripts/restore-local-ingests.mjs`,
exit 2, "NOT evidence of a wipe"). No new dark-store defect.

**corpus-freshness**: covered above — the finding and PR #292 are the same.

## Competitors (C-grade, sizing only)

Sakana AI Scientist, OpenHands, DSPy/GEPA, SWE-agent, Cursor background agents: none publish a
discipline for reconciling two independently-generated fixes for the same defect before either lands —
single-agent-per-task designs don't hit this class of duplication. Full comparative table in the
frozen pre-implementation gist (`/tmp/dream-gist-2026-09-16.md`, this session).

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session. Full pre-reconciliation report
(hypothesis, evaluation receipt, evidence, independent critic result) committed separately does not
exist on `main`; this reconciliation report supersedes it as the record of tonight's row. The
pre-reconciliation working notes remain at `/tmp/dream-gist-2026-09-16.md` in this session only (not
committed, since the candidate diff itself was discarded).

## Issue

#258 (existing — the finding this reconciles to; not duplicated, not closed by this session, since
only a human/reviewer closes issues on merge).

## ADR

None — no ADR's `governs:` frontmatter names `scripts/brain-score.mjs`, `scripts/brain-grade-groundtruth.mjs`,
or either session's new pure-summary module.

## Witness

```
SESSION_COMMIT = 0230299408d4ab89a5b6661b55f3ac26396274e9
REPORT_HASH    = d9d87d845d17bb161fa5ca708c95d18e0f6849f9c9d0e69ece826e70d60a806f
WITNESS        = 37d37c3c1a3ad00089643ebaf2a07c7cf44b81ff74cc6812c30cf9df52018102
```

Verifier: (1) fetch this file's raw content as it existed before this Witness section was filled in;
(2) `sha256sum` it and confirm it equals `REPORT_HASH`; (3) `printf '%s%s' REPORT_HASH SESSION_COMMIT
| sha256sum` and confirm it equals `WITNESS`; (4) `git show 0230299408d4ab89a5b6661b55f3ac26396274e9`
on `stuinfla/ruvnet-brain` to confirm the session commit is real and matches tonight's `main` tip.

## Merge Policy

Human review required. This session never self-merges and never autonomously promotes candidate
state. `autoMerge: false` held throughout. No code candidate ships from this row.

## Standing note for the repo owner

As of tonight the `dream/*` PR backlog is 13 open (spanning 2026-09-01 through tonight's #291/#292),
essentially frozen since 2026-08-31 (only 1 `dream/*` PR — #215 — has merged since #178 on 2026-08-26).
Tonight is itself a symptom: two independent nightly sessions spent a full research-and-evaluation
cycle each converging on the identical, already-open issue (#258) because neither had the other's
in-flight work visible before starting, and the backlog meant #258's read-side fix sat live-but-broken
on `main` for 3 days before either caught it. The fix is ready in PR #292 (and #260's in PR #280);
review throughput, not further nightly research, is what's blocking both.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01L1GrQFdaJSB5kV8Pg21S5e

---
_Generated by [Claude Code](https://claude.ai/code/session_01L1GrQFdaJSB5kV8Pg21S5e)_
