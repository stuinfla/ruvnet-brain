# Dream Cycle 2026-09-17 — enforcement-integrity SOTA Report

## Rotation

DEEP=`enforcement-integrity`, SCAN=`lesson-delivery`,`gate-teeth` (slot 2 of 5, `20260917 % 5 == 2`). No
bonus modulus tonight (`%25`=17, `%75`=42). Session start commit: `3996f502b18157fdc84e325fbe87c2a05351d58c`.

## Ledger check

`docs/dream-cycle/LEDGER.md` on `main` is stale at 2026-08-31 even though 17+ consecutive nightly
`dream/*` PRs have opened since (checked directly via GitHub MCP, not assumed). **Zero dream-cycle PR
has merged since #178 on 2026-08-26** — of ~30 open `dream/*` PRs sampled tonight (#227 through #293),
every single one is still `open`/`draft`. This is the single most consequential fact of tonight's run
and is flagged prominently in the Recommendation below.

Re-checked recent fates for this exact surface (enforcement-integrity, slot 2) directly against current
`main` source rather than trusting old PR text:

- **Issue #264** ("opted-in BLOCK lesson silently dropped by cross-trigger nudge-budget truncation"),
  opened 2026-09-07: **still open**. Its fix (PR #281, opened 2026-09-12, independently re-verified by a
  second session on the same night as PR #282) is **current** — rebased onto `main` repeatedly (8 merge
  commits), no conflicts, only CI failure is an unrelated Vercel preview-deployment error. Confirmed the
  underlying defect is still live in `plugin/scripts/lesson-presentation.mjs`'s truncation loop (line
  57-64: `if (inForce.length && spent + cost > nudgeBudget) continue;` — no exemption for `isBlocking()`).
  **Not touched tonight** — an unmerged, current, already-reviewed fix exists; re-deriving it would be a
  third duplicate PR for the same finding, which `dream.config.json`'s `findingPolicy.skipIf:
  ["existing-fix-pr"]` exists to prevent.
- **Issue #262** ("lesson-promote.mjs theme demotion was unreachable dead code"), opened 2026-09-07:
  **closed `completed` by the owner directly, 2026-09-12T08:39:47Z**. But its fix, PR #263, was itself
  closed unmerged in the 2026-09-07 bulk-close event (the same event that orphaned #264/#265's original
  PR) — **and its branch (`dream/2026-09-07-enforcement-integrity`) no longer exists on `origin`**, so
  unlike #281 it cannot simply be rebased and re-reviewed. Per this repo's own "never reopen resolved
  work" rule, the *issue* is left untouched. But the owner's closure recorded a decision about the
  *issue*, not a claim that the *code* had changed — and it hadn't. Verified tonight by direct grep of
  current `main`: `themeKey` appears nowhere as a write target anywhere in the repository, only in the
  (dead) read path — the exact defect PR #263 described is still live. See Deep Dive.

## Deep dive / defect (recovered, not new)

`plugin/scripts/lesson-promote.mjs`'s theme-demotion control (`--demote-theme`/reject a proposed
cross-project lesson theme so it is never re-proposed) has never worked in production. The original
design stored the demotion as a `themeKey` field on a row in the shared lesson store (`lessons.json`);
`lesson-store.mjs`'s `makeLesson()` destructures a fixed field set and freezes the result, so `themeKey`
is silently dropped on the very next legitimate write anywhere in the store. There was also no writer for
it at all — `lesson-ratify.mjs --demote` only demotes by lesson `id`, never by theme. So
`demotedThemeKeys()` always returned an empty `Set` in every real invocation, and `analyze()`'s
sticky-demotion filter could never fire. This is the load-bearing pattern `lesson-gate.mjs`'s own
`OPTIN_PATH` comment already names for a different field (`userOptedIntoBlocking`): "a per-lesson flag in
the store WOULD NOT SURVIVE."

PR #263 (2026-09-07, same original session that found #264) diagnosed and fixed this correctly: move
theme-demotion state off the lesson store entirely, to its own small file
(`~/.config/ruvnet-brain/demoted-themes.json`), written only by a new `setThemeDemoted()` — mirroring the
`OPTIN_PATH` precedent exactly. It never merged. The 2026-09-07 bulk-close closed the PR without merging
it and its branch was subsequently deleted, so unlike #281 there is no live branch to simply rebase.

Tonight's session independently re-derived the fix is still needed (grep confirms `themeKey` has zero
writers repo-wide) and recovered PR #263's own patch from its still-reachable PR head commit
(`refs/pull/263/head`, sha `581f1ad8`), applied it cleanly onto current `main` (`git apply --check`
succeeded with no conflicts), and independently re-validated it end to end rather than trusting the old
PR's claims.

## Hypothesis (frozen before evaluation, unchanged from PR #263's original)

> Given a theme demoted via `lesson-promote.mjs --demote-theme <key>` (a real, non-test invocation, no
> `rejected` Set injected by a test), when the demotion is recorded via `setThemeDemoted()` writing to
> `DEMOTED_THEMES_PATH`, then the theme should never be re-proposed by `analyze()` on a subsequent scan,
> and `--restore-theme <key>` should make it eligible again — relative to baseline (demotion silently
> never takes effect, because nothing ever wrote a qualifying `themeKey` row) — subject to: existing
> per-lesson demotion (`lesson-store.mjs`'s `demote(id, …)`) unaffected; an unrelated theme stays
> promotable; no change to `lesson-store.mjs`'s schema; no new attack surface on the write path.

## Candidate

`plugin/scripts/lesson-promote.mjs` only: 78 insertions / net additions across the file, one conceptual
change (move theme-demotion state to its own file, add two CLI flags), zero lines touching
`lesson-store.mjs`. `tests/unit/lesson-promote.test.mjs`: +112 lines, 5 new tests exercising the real
disk round trip and the real CLI via `execFileSync` (not the pre-existing `{ rejected: Set }` test-only
injection seam, which is exactly why the original bug shipped unnoticed for 6+ weeks).
`data/convergence-manifest.json`: regenerated (required — a tracked source file changed; this repo's own
convention, confirmed via `npm run convergence:write`, byte-diff is exactly the manifest hash for the one
changed file).

## Evaluation Receipt

**TEETH, independently reproduced tonight from scratch — not trusted from PR #263's old claim.**
Applied only the test file first (kept production code at current `main`), ran
`npx vitest run tests/unit/lesson-promote.test.mjs`: **5/5 new tests RED** —
`setThemeDemoted is not a function` ×2, a hand-edited-array-tolerance assertion failure, and 2 CLI-flag
tests failing because the flags don't exist. Restored the production fix: **21/21 GREEN**.

- **Blast radius**: `grep -rn "from.*lesson-promote"` repo-wide → only `scripts/lesson-promote.mjs` (a
  bare re-export compatibility shim) and the test file import this module. An independent critic agent
  additionally confirmed `capability-registry.mjs:655` is the only external caller of `analyze()`, calls
  it with no options, and the new `demotedThemesFile` parameter is optional with a safe default — that
  call site is unaffected.
- **`npx vitest run tests/integration`** (full suite, 400 tests): candidate 9 failed files / 23 failed
  tests / 309 passed; re-ran against baseline (production file + its test stashed out) — **byte-identical
  failing-test-name set**, all pre-existing `sqlite3`/`@xenova/transformers`/native-module container gaps
  (`anticipate*`, `health-repair`, `project-progression-*`, `reader-deadlock-regression`,
  `console-apply-timings`) — none reference `lesson-promote`/`lesson-store`/`lesson-gate`.
- **`tests/integration/hook-conformance-both-hosts.test.mjs`** (the never-weaken both-hosts gate this
  repo's operating notes call out by name): **10/10 pass**, unaffected.
- **`npx vitest run tests/unit`** (full suite, 5622 tests): candidate 40 failed / 5397 passed vs baseline
  39 failed / 5393 passed — **one net new failure, isolated and explained**:
  `tests/unit/convergence-manifest.test.mjs` failed candidate-only because the committed manifest had not
  yet been regenerated for the changed source file; fixed by `npm run convergence:write` (this repo's own
  documented convention for any tracked-source change), then **2/2 pass**. Every other failure in both
  baseline and candidate runs is identical: `advocacy-ignored`, `advocacy-outcomes`, `advocacy-route`,
  `console-memory-canonical-store`, `corpus-accuracy-gate`, `corpus-customer-promotion`,
  `corpus-seed-release-authority`, `doc-currency` (ADR-0013 stamp lag), `hook-shim-fallback-once`,
  `rehearse-corpus-pipeline`, `retrieval-canary`, `user-settings` — all pre-existing chmod/EACCES-under-root
  container artifacts or unrelated corpus/release-pipeline gaps, none touching the changed files.
- **`npm run claims:verify`**: 3 PASS / 4 SKIP, identical composition to every prior documented night
  (brain not installed on this container; not a credentials block).
- **`npm run eval:gate`**: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`, the same
  pre-existing container condition every prior night has recorded independently via
  `restore-local-ingests.mjs`/`brain-score.mjs`/`store-root.mjs` (`stores 0 dark 0`). Not applicable to
  this deterministic-I/O surface regardless — this candidate does not touch retrieval or grounding.
- **`node scripts/doc-currency.mjs --check --changed main`**: **0 blocking findings** for this diff. No
  ADR governs `lesson-promote.mjs` specifically (confirmed by grep across `docs/adr/`), so no
  Currency-log row is required. (A full, unscoped `doc-currency --check` shows ~15 pre-existing
  `stamp-lags-doc`/`presumed-stale` findings across ADR-0066 through ADR-0086 — all predate tonight, none
  introduced by this change, and none govern the touched file.)
- **`npm run qa:pr`**: `contract` lane (which runs the touched unit suite) reproduces the same
  pre-existing failures documented above, none in changed files; `version` lane passes
  (`4.3.26` agrees across all surfaces).

## Darwin

Not run — no continuous parameter to evolve for a boolean demotion-persistence fix (same call every prior
night on this exact class of defect has made).

## Evidence

OBSERVATION (`themeKey` has zero writers repo-wide; `demotedThemeKeys()` therefore always returns an
empty Set in real use) → MEASUREMENT (5/5 TEETH red on unmodified `main`, reproduced tonight from
PR #263's recovered patch, not trusted from its old claim; 21/21 green post-fix; full `test:integration`
and `test:unit` suites diffed byte-identical against a same-session baseline, one net-new failure found,
explained, and fixed) → DECISION (ACCEPT, pending human review — recovering orphaned, previously-reviewed
work, not proposing anything new).

## Reward-Hack Check

Independent critic agent (fresh context, no shared session with the implementing work) verdict: **CLEAR**.
No benchmark/threshold touched. No existing test weakened — only new tests added, all proven to fail
pre-fix. `THEMES.some((t) => t.key === key)` is a strict-equality check against a fixed, hardcoded enum:
no regex, no dynamic property lookup, no shell/path interpolation of the CLI arg anywhere — an unknown
key is refused loudly before any write. The file path itself is never attacker/CLI-influenced (fixed
default or `RUVNET_DEMOTED_THEMES` env var, same trust class as the existing `RUVNET_LESSON_STORE`).

## Security Review

No new attack surface. `setThemeDemoted()` writes under the existing `~/.config/ruvnet-brain/` trust
boundary, same class as `OPTIN_PATH`/`GATE_STATE_PATH`/`lessons.json`. One real but low-severity, already
line-documented tradeoff: the read-modify-write is unlocked (unlike the primary lesson store's
lock-protected `updateLessons()`) — acceptable because this file is written only by a human running
`--demote-theme`/`--restore-theme` interactively, never by the mining pipeline or a concurrent automated
writer, so the practical race window is negligible. Not fixed tonight (out of scope; flagged, not hidden).

## Scan findings

1. **lesson-delivery** (elevated to tonight's recovered candidate): see above — a demotion control that
   silently never took effect is the delivery-side failure of "you should never have to tell me twice."
2. **gate-teeth**: reviewed `decision-gate.mjs` (428 lines, the sole cross-host PreToolUse refusal
   chokepoint) and `lesson-gate.mjs`/`lesson-store.mjs`/`lesson-bridge.mjs`/`lesson-command-scope.mjs` in
   full for a fresh "guard that cannot fail" defect distinct from the two already-known, already-fixed
   findings on this surface (#264/#281, #262/#263). Both files are unusually heavily hardened — each
   carries extensive inline documentation of prior real defects found and fixed by name, with explicit
   fail-open/fail-closed reasoning at every branch. No new candidate found within tonight's budget;
   recorded as a clean scan rather than manufacturing a marginal finding to fill the slot.

## Competitors

Grade C, general design knowledge, framing only (Sakana AI Scientist, OpenHands, DSPy/GEPA, SWE-agent,
Cursor background agents) — none of the five need to solve "persist a durable per-theme rejection outside
a shared, schema-validated store that silently drops unknown fields," which is the surface this bug lived
on. Not the focus of tonight's evidence.

## Gist

LOCAL — gist writes are blocked by this session's outbound proxy policy (`POST api.github.com/gists` →
`403 Gist writes are not permitted through this proxy`), confirmed by direct probe, not assumed. Full
report committed at this path on the candidate branch, as every prior night without a gist tool has done.

## Witness

```
SESSION_COMMIT = 3996f502b18157fdc84e325fbe87c2a05351d58c
REPORT_HASH    = 5962ea389a1a4acc5db77c90fd255622b8734544b11893442ce23b09d0a9e967
WITNESS        = 48c101ee5dbb79b475ec9d7d68a7978237d8233f6d43153f60ac5b2eba25e1f4
```

Verifier procedure (reproducible by anyone):

1. `git show 3996f502b18157fdc84e325fbe87c2a05351d58c` — confirm this is the real `main` HEAD this
   session started from (matches `origin/main` at session start, before any candidate branch existed).
2. `sha256sum docs/dream-cycle/2026-09-17-enforcement-integrity-report.md` on the committed report —
   must equal `REPORT_HASH` above.
3. `printf '%s%s' <REPORT_HASH> <SESSION_COMMIT> | sha256sum` — must equal `WITNESS` above.
4. `git apply --check` the diff of `plugin/scripts/lesson-promote.mjs` against
   `refs/pull/263/head` (sha `581f1ad8`) on this repo — confirms this candidate is a faithful
   recovery of PR #263's original patch, not a rewritten claim.
5. `git stash` the production file only, run `npx vitest run tests/unit/lesson-promote.test.mjs` (5/5
   red), `git stash pop`, re-run (21/21 green) — reproduces the RED→GREEN proof independently.

## Recommendation

`evaluated: accepted`. Human review required — this session never self-merges. **The 30+-PR dream-cycle
backlog, first flagged 2026-08-26, is now three weeks old and is actively causing collateral damage, not
just delay**: tonight's own investigation found that issue #262 was closed `completed` by the owner while
its actual code fix (PR #263) sat unmerged and was then lost — the tracking signal now falsely reads
"resolved" while the code defect remained live for 10 days, until tonight's independent re-verification
caught it. The single highest-leverage action available to the owner remains reviewing and merging the
backlog, starting with PR #281 (a verified, current, security-relevant fix for issue #264 — an opted-in
refusal that could silently downgrade to an ALLOW) and tonight's PR, both zero-risk per the evaluation
above.
