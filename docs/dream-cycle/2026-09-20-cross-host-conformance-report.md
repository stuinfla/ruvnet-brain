# Cross-Host-Conformance SOTA Report — 2026

**Dream Cycle 2026-09-20 — DEEP=cross-host-conformance, SCAN=codex-parity,stranger-project-behaviour (slot 0)**

## Rotation

SLOT=0 (`20260920 % 5 == 0`) → DEEP=`cross-host-conformance`, SCAN=`codex-parity`,`stranger-project-behaviour`.
Session commit `231c565640110e6cfe2a06892a4475a95fc742d5`. No bonus deep-dive (`20260920 % 25 = 20`,
`% 75 = 45`). `npm ci` clean (107 packages, 0 vulnerabilities) — no wasm/NAPI degradation tonight.

## Ledger Check

`docs/dream-cycle/LEDGER.md` on `main` last dated 2026-08-31 (41 rows) — unchanged for 20 days, not because
nothing ran but because rows ship inside candidate PRs and none have merged since #178 (2026-08-26).
Re-checked via GitHub MCP, not assumed: `stuinfla/ruvnet-brain` currently has **~30 `dream/*` PRs open**,
spanning 2026-09-01 through tonight, zero merged in that window. Zero open GitHub issues target the
`cross-host-conformance` DEEP surface as of tonight.

**Standing cross-cutting finding, escalated tonight via direct notification** (not just another PR-body
mention): PR #294 (2026-09-17) found this backlog already cost a real defect — issue #262 was closed
`completed` by the owner on 2026-09-12 while its actual code fix (PR #263) sat unreviewed and was later lost
when its branch was deleted. This has been named in PR bodies since 2026-08-26 with no visible response.
Flagged again here per this repo's disciplines, and separately via a direct push notification tonight, since
the in-PR channel does not appear to be reaching the owner.

## Issue Disposition

Zero open issues on this DEEP surface. No new human commits touched hooks/codex-conformance code since
session-start commit `3996f502` (2026-09-17, the last cross-host-conformance-adjacent night) through tonight's
`231c565` — `git log 3996f502..HEAD` shows only kb-corpus/ADR/QA commits, none touching `plugin/hooks/*`,
`plugin/scripts/*hook*`, or `plugin/scripts/continuity-hook-policy.mjs`. No `codex` CLI is installed in this
container, so ADR-084's one remaining named sub-gap (`decision-gate`'s bash/`exec_command` route) cannot be
measured tonight — not attempted, same reasoning as PR #291 (2026-09-15).

## Deep Dive

Re-verified `plugin/scripts/continuity-hook-policy.mjs`'s 2026-09-11/12 Codex write-route parity extension is
still correctly scoped: `decision-gate`/`grounding-stamp` are registered `['claude', 'codex']`, the bash/
`exec_command` route is deliberately NOT extended (header lines 58-62 explain why extending it without a
`codex` probe would be an unproven leap) — matches PR #291's prior finding, current source unchanged since.

Auditing `plugin/scripts/hook-registry.mjs`'s own header comment (the file this exact DEEP surface's
2026-08-20 finding added Codex coverage to) turned up one new, previously-flagged-but-unfixed defect:
lines ~38-40 named `decision-gate`, `route-dispatch`, `learn-capture` as example ids `codex-hooks.json`
"uses" — PR #278 (2026-09-10) flagged this as stale in its "next steps" and explicitly left it for
"whichever rotation next touches that file's header." Nobody had, until tonight.

## Hypothesis (frozen before verification)

> Given `plugin/scripts/hook-registry.mjs`'s header comment, which names `decision-gate`, `route-dispatch`,
> and `learn-capture` as example ids `codex-hooks.json` uses, when those three example ids are checked
> against `codex-hooks.json`'s current live dispatch tokens (extracted programmatically) and against
> `hook-shim.mjs`'s TABLE, then at least one named example will be found stale, subject to: the underlying
> invariant the comment asserts (every codex-dispatched id resolves through the shim TABLE) must still hold.

## Candidate

`plugin/scripts/hook-registry.mjs`: corrected the header comment's example ids to the current live set
(`session-start`, `decision-gate`, `grounding-stamp`, …) and its causal claim about when/why
`route-dispatch`/`learn-capture` stopped being live Codex examples. `docs/adr/0065-the-payload-boundary-is-the-shipping-invariant.md`:
added a Currency-log row (this file is in ADR-0065's `governs:` list; the repo's own pre-push gate requires
a currency row for any governed-file change) and bumped `updated:`. `data/convergence-manifest.json`:
regenerated (`npm run convergence:write`, required — tracked source changed). Comment/doc-only — one
conceptual change, no behavior change. 3 files, +16/-6 lines net (excluding the mechanically regenerated
manifest).

## Verification (programmatic, not by inspection)

- `node plugin/scripts/hook-registry.mjs --machine=0` (live registry census) shows the Codex layer's actual
  dispatch commands end in: `session-start`, `continuation-gate`, `grounding-turn-gate`, `decision-gate write`,
  `grounding-stamp`, `unprompted-speech UserPromptSubmit`, `ground-ruvnet`, `grounding-turn-mark`,
  `session-snapshot SessionEnd` — confirmed by direct extraction of `plugin/hooks/codex-hooks.json`'s raw
  command strings, not `--json`'s `shimId` field (null for Codex records; the real token is the wrapper's
  trailing CLI arg, `codexDispatchIdIn()`'s own contract, confirmed by `tests/unit/hook-registry-lint.test.mjs:331-336`).
  **`route-dispatch` and `learn-capture` do not appear.**
- `plugin/scripts/hook-shim.mjs`'s `TABLE` (grep-confirmed, lines 86-170): `route-dispatch` (line 95) and
  `learn-capture` (line 110) both still exist as TABLE keys — they just aren't ones Codex dispatches anymore.
  All 9 ids Codex currently dispatches resolve to real TABLE entries.
- **When did they stop being live Codex examples — verified from git history, not assumed**: `git show
  00526b12:plugin/hooks/codex-hooks.json`'s parent (`00526b12^`) still dispatches `route-dispatch` (PreToolUse)
  and `learn-capture` (PostToolUse); commit `00526b12` itself (2026-09-07, "fix(release): qualify reviewed
  candidate once and retire automatic hooks") wipes the whole file to `{"hooks": {}}`. Commit `56420430`
  (2026-09-09, "fix(hooks): restore constrained continuity lifecycle plane") only re-registers
  `session-start`/`continuation-gate` into that already-empty file — it retires nothing. **An earlier draft
  of this exact fix mis-attributed the retirement to the 2026-09-09 commit; an independent critic agent
  caught this by tracing the actual git history (see Reward-Hack Check below) and it was corrected before
  this report was finalized.**

## Evaluation Receipt

- `tests/unit/hook-registry-lint.test.mjs`: baseline 29 passed/6 skipped → candidate 29 passed/6 skipped,
  byte-identical. This file's own `handlerFor()` assertion (lines 191-220) is the real, continuously-run
  enforcement of the invariant the corrected comment describes — independently confirmed live by the critic
  agent, not merely cited from memory.
- `tests/integration/hook-conformance-both-hosts.test.mjs`, `tests/unit/codex-blocking-hooks-parity.test.mjs`,
  `tests/unit/codex-lifecycle-hooks.test.mjs`, `tests/unit/hook-contract.test.mjs`: 57 passed/10 skipped, 0
  failed.
- Full `test:integration` (49 files/400 tests): 9 failed files/23 failed tests/309 passed/15 skipped/53 todo —
  **byte-identical** to every recent ledger row's documented baseline (native `sqlite3` under this
  container's root user, missing `global Ruflo`, cross-encoder network fetch — none reference the two
  changed files).
- Full `test:unit` (450 files/5626 tests): candidate first run 13 failed files/40 failed tests — one net-new
  failure (`convergence-manifest.test.mjs`) traced to running `convergence:write` BEFORE the critic-driven
  second edit round, not after; re-ran `npm run convergence:write` and reconfirmed. Final candidate run of
  the 13 originally-failing files, isolated via `git stash` against the identical starting commit
  (`231c565`): **11 failed files/38 failed tests/330 passed — byte-identical to the stashed (pre-candidate)
  baseline on the same 13 files.** None reference `hook-registry.mjs`, `hook-shim.mjs`, `codex-hooks.json`,
  or ADR-0065; composition matches known pre-existing classes (chmod/EACCES-under-root fixtures,
  gh-interception/network-dependent corpus-release tests, `retrieval-canary` — already tracked as open issue
  #286, red since 2026-09-10 — and `doc-currency.test.mjs`'s unrelated ADR-0013 assertion).
- `npm run claims:verify`: 3 PASS/4 SKIP, identical composition to every prior night.
- `npm run eval:gate`: `EVALUATED=blocked` (`no brain at /root/.cache/ruvnet-brain/kb`, `stores 0 dark 0` —
  not a credentials block, not applicable regardless: this is a documentation-accuracy fix, not a retrieval
  surface).
- `node scripts/doc-currency.mjs --check`: ADR-0065 flips from `1 BLOCK · 3 warn` (presumed-stale once
  `hook-registry.mjs` — a governed file — is committed changed without a currency row) to `current · 3 warn`
  after the added row.
- `npm run hooks:check`: PASS. `npm run wired:check`: PASS. `npm run version:check`: `4.3.26` agrees
  everywhere.

## Darwin Lineage

Not run — no continuous parameter to evolve for a prose-accuracy fix; no numeric benchmark axis.

## Evidence

OBSERVATION (`hook-registry.mjs`'s header cites 2 ids `codex-hooks.json` no longer dispatches, flagged by
PR #278 2026-09-10, never fixed) → MEASUREMENT (programmatic extraction of live dispatch tokens + TABLE
keys confirms the claim; git history confirms exactly which commit changed it) → CORRECTION (an
independent critic caught a wrong commit/date attribution in the first fix attempt; git history re-traced,
corrected) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

Independent critic agent (fresh context, no shared history with the candidate's authoring session) verdict:
**initially NOT CLEAR, then CLEAR after correction.** The critic's own report: the first-draft fix correctly
identified the old comment as stale and correctly identified new example ids as accurate, but introduced a
new factual error — attributing the retirement to the wrong commit and the wrong kind of event ("2026-09-09
continuity-plane restore" instead of the 2026-09-07 full-retirement commit `00526b12`). The critic traced
`git show 00526b12:plugin/hooks/codex-hooks.json` and its parent directly to prove this. This session
independently re-verified the critic's claim against the same two commits before accepting it, then
corrected both `hook-registry.mjs` and the ADR-0065 currency row and re-ran the targeted test file. No
benchmark, gold-answer, or threshold was touched at any point; no test was weakened. This is disclosed here
rather than quietly re-drafted, per this repo's own "witness every quantitative claim" and honesty
disciplines — a corrected-in-flight documentation fix is a more trustworthy work record than one that
looks clean because the correction was hidden.

## Security Review

Out of scope in substance — two markdown/comment-only edits (`plugin/scripts/hook-registry.mjs`'s block
comment, `docs/adr/0065-...md`'s Currency log) plus a mechanically regenerated manifest. No credential,
network, filesystem-write, or execution-path surface touched. `grep -r` for the literal old/new comment
text and for `route-dispatch`/`learn-capture` confirms nothing in the repo parses this specific header
comment's prose — the two ids remain referenced elsewhere only as their own real (unrelated) hook/script
names (`route-dispatch.sh`, `learn-capture.sh`) and their own tests.

## Regression Analysis

Zero regressions. See Evaluation Receipt: `test:integration` byte-identical; `test:unit`'s one apparent
net-new failure (`convergence-manifest.test.mjs`) was this session's own build-order artifact (ran
`convergence:write` before the critic-driven second edit), not a candidate defect — fixed by re-running the
regeneration step, then reconfirmed byte-identical against baseline on the full originally-failing set.

## ADR

No new ADR — this is a Currency-log amendment to the existing ADR-0065 (required because that ADR governs
`plugin/scripts/hook-registry.mjs`), not a new architectural decision.

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation as every Dream Cycle
night since 2026-08-19; a direct gist-API probe from a recent night returned `403` from this session's
outbound proxy). Full initial gist draft: see this session's `/tmp/dream-gist-2026-09-20.md` (not
committed — ephemeral per the pipeline's own convention); this committed report is the durable copy.

## Witness

```
SESSION_COMMIT = 231c565640110e6cfe2a06892a4475a95fc742d5
REPORT_HASH    = 066b881711e928008794a998d523d42f7b9378d24fe763760542d5ac94bd55d3
WITNESS        = 3859eb5dee2f248cb6d0d60cb9fe3b77866ed3b06120e6387ca45acc547546b1
```
(REPORT_HASH is sha256 of the initial `/tmp/dream-gist-2026-09-20.md` draft, frozen per STEP 16 before
its own Witness section was filled in — the pipeline's own convention, matching every prior night's
committed report. `WITNESS = sha256(REPORT_HASH + SESSION_COMMIT)`.)

**5-step verifier, reproducible by anyone:**
1. `git show 00526b12^:plugin/hooks/codex-hooks.json` and `git show 00526b12:plugin/hooks/codex-hooks.json`
   — confirm `route-dispatch`/`learn-capture` present before, absent (file wiped) after.
2. `git show 56420430:plugin/hooks/codex-hooks.json` — confirm it only adds `session-start`/`continuation-gate`
   to an already-empty file.
3. `node plugin/scripts/hook-registry.mjs --machine=0` on this PR's branch — confirm the Codex layer's live
   dispatch tokens match the corrected comment.
4. `npx vitest run tests/unit/hook-registry-lint.test.mjs tests/unit/convergence-manifest.test.mjs` — expect
   all green.
5. `sha256sum docs/dream-cycle/2026-09-20-cross-host-conformance-report.md` and compare to `REPORT_HASH`
   above; recompute `sha256(REPORT_HASH + SESSION_COMMIT)` and compare to `WITNESS`.

## Next steps

1. If a `codex` CLI ever becomes available in this container's build image, ADR-084's named
   bash/`exec_command` route sub-gap is the highest-value remaining cross-host-conformance work.
2. **The ~30-open-PR, zero-merged-in-3-weeks backlog is this rotation's most important finding, and it is
   not this row's to fix.** Escalated via direct notification tonight in addition to this report, since PR
   bodies alone have not produced a visible response since 2026-08-26.
3. `hook-registry.mjs`'s header could derive its example ids from `shimTable()`/live registry output at
   doc-generation time instead of hardcoding prose, so this exact class of drift can't recur. Noted, not
   attempted — would be its own conceptual change, out of scope for a single-comment fix.

## Merge Policy

Human review required. This session never self-merges and never autonomously promotes candidate state.
`autoMerge: false` held throughout.
