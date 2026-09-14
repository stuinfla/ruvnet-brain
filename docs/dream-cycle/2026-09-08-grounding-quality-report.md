# Dream Cycle 2026-09-08 — grounding-quality SOTA / reconciliation report

## Rotation

`DATE=2026-09-08` `DAYINT=20260908` `SLOT=3` (`20260908 % 5 == 3`) → `DEEP=grounding-quality`,
`SCAN=retrieval-precision,citation-binding`. No bonus modulus tonight (`% 25 = 8`, `% 75 = 33`,
both non-zero). `SESSION_COMMIT` (start of night) = `80c5322e6eaf87dd93cdeaac9fd12b49811cf034`.
No concurrent firing found: no `dream/2026-09-08-*` branch on `origin`, no
`[Dream Cycle 2026-09-08]` issue open, before this session started.

## Ledger check (STEP 1)

Re-verified recent issue/PR fates via GitHub MCP rather than assuming.

**Surprising-looking but explained**: every `dream/*` PR opened since 2026-08-31 (`#213`/`#215`
excepted) is now **CLOSED, unmerged** — 24 of them closed within one hour on 2026-09-07 (`~18:48
UTC`), including PR #237, which was fully green (`check`/`release-qe`/`windows-unit`/`canonical-qa`
all resolved per its own comment thread) and had been sitting "ready for review" since 09-04.
Read this as **evidence of a real batch-triage action taken between nights**, not a defect this
session should flag as new: `git log` confirms the underlying diffs for at least two of these
closed PRs (#162, #164 — night `2026-08-23`'s grounding-quality candidates) are present on `main`
today, landed via a squashed release-reconciliation commit (`e6774a3`, `release(4.3.8): ship
reconciled candidate`, 2026-09-04) rather than by merging the draft PR directly. This explains the
"growing review backlog, zero merges" pattern every ledger row since 2026-08-26 has flagged: the
backlog of *PRs* is real, but it does not mean the backlog of *fixes* is stuck — this repo has a
separate batch path for landing accepted work that leaves the originating PR unmerged. Worth
noting for future nights so "zero PRs merged" is not read as "zero fixes shipped."

**Reconciliation performed** (ISSUE DISPOSITION OVERRIDE, `dream.config.json`): both open
grounding-quality issues predating this run were found ALREADY INTEGRATED and closed tonight:

- **#161** (2026-08-23, `self-retrieval-bench`'s `HYBRID` label unfalsifiable). `kb/self-retrieval-bench.mjs`'s
  `resolveHybridMode()` now throws rather than mislabels; `kb/forge-hybrid.mjs`'s header no longer
  overclaims `mmrRerank`. Verified tonight: `tests/unit/forge-hybrid-port-claims.test.mjs` +
  `tests/unit/self-retrieval-bench-hybrid-mode.test.mjs`, 2 files / 8 tests, all pass on current
  `main` (`80c5322`). Landed via `e6774a3`. Closed with commit reference.
- **#163** (2026-08-23, `build-primer.mjs` ships ungrounded primers). `scripts/build-primer.mjs`
  now calls the new `scripts/primer-grounding.mjs`'s `writeGroundedPrimer()`, which computes
  citations and `throw`s BEFORE the `fs.writeFileSync`, refusing the write outright when
  `refs.length < 6` (mechanism differs from the issue's proposed `kb/rejected/` redirect — this
  refuses instead of redirecting — but the defect, an ungrounded primer reaching the live path, is
  closed either way). Verified tonight: `tests/unit/primer-grounding.test.mjs` (3/3 pass);
  `tests/unit/countrefs-primer-l2-drift.test.mjs`'s own header now reads "Primer admission is now
  exercised by primer-grounding.test.mjs against actual writes" — confirming the remaining
  `.todo` items in that file are a narrower, separate `build-l2.mjs` retry-behavior gap, not this
  issue's defect. Landed via `e6774a3`. Closed with commit reference.

**#236** (2026-09-03, citation-header rank-hijack, `ADR-0076` proposed) remains open — correctly:
no ADR-0076 decision exists on `main` (`ls docs/adr/ | grep 0076` → empty), the architectural
question it raises is still unresolved, and tonight surfaced no new evidence that would justify
reopening or overriding that pending human decision. Not touched.

Learning signals: PR-merge rate via direct merge is effectively zero over the last 2 weeks (`#178`,
`#215` are the only two `merged:true` `dream/*` PRs found), but the release-reconciliation path
above shows real work IS landing — biasing this session toward a **tiny, easily-reviewable
candidate anyway** (the stated signal), which combined with finding no new actionable defect,
means tonight ships evidence/reconciliation only, no production diff.

## Deep dive — grounding-quality (retrieval-precision, citation-binding)

Re-read `kb/verify-citation.mjs` end to end (the module PR #186 hardened against citation-block
spoofing, and #236 further analyzed for the rank+1 relative-offset variant). Traced its actual
callers: exclusively offline evaluation/QA tooling (`scripts/eval-brain.mjs`,
`scripts/top100-benchmark.mjs`, `scripts/host-install-matrix.mjs`, `bin/install.mjs`'s self-check),
never the live MCP tool surface. The live surface (`kb/forge-mcp-all.mjs`'s `search_ruvnet` tool)
builds its response via `kb/grounded-response.mjs` → `kb/retrieval-result.mjs`, which never
re-parses printed text — it builds a structured envelope directly from the real search results,
self-consistency-checked via `contentSha256` binding and a `safePath()` traversal guard
(`kb/retrieval-result.mjs`'s `parseRetrievalResult`). **This narrows the severity framing of #236's
still-open finding**: the citation-block-spoofing/rank-hijack class is real but confined to this
repo's own offline evaluator reading the CLI text reader's stdout, not the shipped product surface
end users hit. Recording this clarification here since it bears on how urgently `ADR-0076` needs a
decision — not claimed as new evidence toward reopening #236 itself, since it doesn't change
whether the underlying parser gap exists, only how much it matters.

Investigated two fresh hypotheses tonight, both inconclusive/rejected — recorded per this repo's
own discipline against re-litigating a cleared direction without new evidence:

1. **`kb/forge-ask-all.mjs`'s `inventoryReposFromQuery()` explicit `repo:<alias>` directive
   bypasses `repo-aliases.json` resolution** (`byLower` maps only canonical on-disk store names,
   never resolved through `repositoryNames()`, unlike the surrounding fuzzy-match branches a few
   lines down in the same function). This is the same alias-resolution bug class fixed three times
   elsewhere in this repo (`kb/store-root.mjs`'s `darkStores()`, `scripts/brain-score.mjs`'s
   `readCoverage()`, `scripts/source-coverage.mjs`'s `artifactEvidence()` — all per ADR-058).
   **Already investigated and rejected on 2026-09-03** (issue #236's "Two other hypotheses"
   section): "traced the fallback free-text matching path and confirmed the final `repos` output
   is unaffected (only a cosmetic `reason` string differs)." Re-read the code tonight and found
   nothing that contradicts that conclusion — `inventoryReposFromQuery`'s directive is not
   exported for direct unit testing, and confirming it end-to-end needs a real corpus this
   container does not have (see below). Not re-opened; no new evidence.
2. **`kb/forge-rerank.mjs:359-361`'s reranker bypass for ADR/design/"where is"-shaped queries**
   (flagged in issue #163's own "Scan Findings — retrieval-precision" section, 2026-08-23, as
   "recorded for a future night," citing ADR-0060's own unresolved n=120 cascade measurement).
   Still unactionable tonight for the same reason ADR-0060 itself names: it needs a real corpus and
   the interrupted n=120 held-out cascade run to measure, neither available in this container
   (below).

## Control-plane discovery (STEP 0.5)

```
$ node scripts/brain-score.mjs 2>&1 | tail -20
  QUALITY: grounded/routed/abstained all STALE (19.6d > 14d budget); panelStrict 52.5 (5d old,
  6 stores graded) — no quality COMPOSITE, 3 of 4 dimensions stale/unmeasured.
  COVERAGE: catalogue/routable both UNMEASURED — "store root does not exist on this host (never
  materialized) — not evidence of live coverage."

$ node scripts/restore-local-ingests.mjs 2>&1 | tail -8
  (lists locally-recorded ingests from 2026-08-19/20; read-only, would need --apply to re-ingest)

$ node -e "import('./kb/store-root.mjs').then(m=>console.log('stores',m.storesAt(m.storeRoot()).length,'dark',m.darkStores().length))"
  stores 0 dark 0
```

`stores 0 dark 0` — the store root has never materialized on this ephemeral container, the same
condition every prior Dream Cycle night in this repo has hit (confirmed again, not assumed).
`OPENROUTER_API_KEY` **is present** (`LLM_EVAL` not credential-blocked), but `eval:gate` is blocked
regardless by the missing corpus — `EVALUATED=blocked`, not `LLM_EVAL=blocked`; these are distinct
conditions and this report does not conflate them. No `npm run`/`package.json` script exists to
materialize the full ~200-repo corpus from scratch in this container (checked: no `ingest`,
`build:`, or `brain:` script) — building one is out of scope for a bounded nightly cycle, same as
every prior night.

## Hypothesis

No hypothesis reached the freeze-then-evaluate stage tonight. Both fresh leads investigated
(directive-alias bypass; reranker ADR-bypass) resolved to "already cleared" / "environmentally
untestable" before a candidate diff was written — per this repo's own discipline ("Do not
rediscover a failed direction unless new evidence justifies reopening it"), neither was carried
into an implementation attempt.

## Evaluation Receipt

Real evaluators run against unmodified `main` (`80c5322`), tonight's actual baseline since no
candidate diff exists:

- `npm run claims:verify`: 4 PASS / 3 SKIP (baseline, brain-dependent claims, coverage claim) —
  identical composition to every prior documented night.
- `npx vitest run tests/unit` (378 files / 4579 tests): 352 passed files / 12 failed files, 4367
  passed / 16 failed / 46 skipped / 150 todo. All 12 failing files are outside tonight's surface
  (`advocacy-ignored`, `advocacy-outcomes`, `codex-blocking-hooks-parity`,
  `development-maintenance` ×2, `doc-currency`, `hook-shim-fallback-once`,
  `pre-push-worktree-root`, `release-evidence-dag`, `release-vector` ×3, `user-settings`,
  `wired-baseline-classification`, `workflow-env-references-resolve`) — none touch
  `kb/verify-citation.mjs`, `kb/forge-hybrid.mjs`, `kb/self-retrieval-bench.mjs`,
  `kb/forge-rerank.mjs`, `kb/forge-ask-all.mjs`, `kb/grounded-response.mjs`,
  `kb/retrieval-result.mjs`, `scripts/build-primer.mjs`, `scripts/build-l2.mjs`, or
  `scripts/primer-grounding.mjs` (grep-confirmed). The four grounding-quality-surface test files
  run directly (below) all pass clean.
- `npx vitest run tests/integration` (43 files / 374 tests): 32 passed / 8 failed files, 288
  passed / 21 failed / 12 skipped / 53 todo. One failing file,
  `tests/integration/card-lane-hot-path.test.mjs`, sits in this surface's territory (card-lane
  retrieval) — inspected directly: both failures are `structuredContent.cardLane` coming back
  `undefined` on a subprocess that spawns the real, unmodified `kb/forge-mcp-all.mjs` against
  `REAL_KB` (this checkout's `kb/` dir). The test's own header names test 1's precondition as "even
  though the heavy path COULD run" (i.e., real `.rvf` stores present) — a precondition this
  container cannot meet (`stores 0 dark 0`, confirmed above), consistent with every other
  corpus-dependent gap this container hits. Classified environmental, not a code regression;
  not chased further (out of scope, no local fix available without the store bundle). The other 7
  failing integration files (`anticipate-dial`, `anticipate`, `console-apply-timings`,
  `health-repair` ×7 cases, `project-progression-session-start`, `reader-deadlock-regression`,
  `unprompted-speech-registry` ×5) are outside tonight's surface.
- Direct run of the four grounding-quality-surface unit test files:
  `npx vitest run tests/unit/forge-hybrid-port-claims.test.mjs
  tests/unit/self-retrieval-bench-hybrid-mode.test.mjs tests/unit/countrefs-primer-l2-drift.test.mjs
  tests/unit/primer-grounding.test.mjs` → 4 files (1 skipped-by-design `.todo` skeleton), 11 passed
  / 4 todo, 0 failed.
- `node scripts/sync-version.mjs --check`: all surfaces agree on `4.3.14`.
- `node scripts/doc-currency.mjs --check`: pre-existing stamp-lag/presumed-stale violations on
  ADRs unrelated to `ADR-068` or this surface (`0063`-`0073`), same class documented in every prior
  ledger row since 2026-08-26; no new violation introduced (nothing committed here touches governed
  code).

`npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb`, confirmed via
the control-plane probe above, not assumed. Not a credentials block (`OPENROUTER_API_KEY` present).

## Darwin Results

Not run — no candidate diff exists tonight to seed a lineage from.

## Evidence

OBSERVATION (issues #161/#163 described defects in code that, when re-read tonight, already
carries the described fix) → MEASUREMENT (targeted test files run directly against current `main`,
green; `git log` on the changed files points at `e6774a3`) → DECISION (close both as integrated
work records, no GitHub issue re-opened, no PR needed for a fix that already shipped).

Two INFERENCE-grade notes (not independently re-verified end-to-end tonight, flagged as such): (a)
the severity-narrowing read of #236 (citation-spoofing confined to the offline evaluator, not the
live MCP surface) is based on tracing imports/call graphs, not a live exploit attempt against a
running server; (b) the `repo:<alias>` directive bypass re-confirmation rests on re-reading the
code, not a fresh runtime reproduction (the function is not exported, and no corpus exists here to
run it end-to-end).

## Reward-Hack Check

N/A — no benchmark, threshold, or gold answer touched; no candidate code shipped tonight.

## Security Review

No new attack surface — no code changed. The severity-scoping note above (citation-spoofing class
confined to offline eval, not the live tool surface) is itself a security-relevant observation
worth the human reviewer's attention when deciding `ADR-0076`'s urgency, not a new finding requiring
its own issue (it doesn't change what's exploitable, only who is exposed to it).

## Scan Findings

**retrieval-precision**: no new finding tonight beyond the already-recorded, still-blocked
`forge-rerank.mjs` ADR-bypass lead (needs corpus + n=120 cascade run, unavailable here).

**citation-binding**: no new finding tonight. Confirmed (not assumed) that `kb/verify-citation.mjs`'s
citation-block-spoofing residual gap (#236) is scoped to this repo's own offline evaluator, never
the live `search_ruvnet` MCP tool, which uses a structurally different, hash-bound JSON envelope
(`kb/retrieval-result.mjs`) with no text re-parsing step.

## Competitors

Not re-surveyed tonight — no new candidate direction to grade against Sakana AI Scientist, OpenHands,
DSPy/GEPA, SWE-agent, or Cursor background agents. See prior nights' gists (LOCAL, referenced in
issues #161/#163/#236) for standing competitor tables on this surface.

## Gist

LOCAL — no `gh` CLI or MCP gist-creation tool available this session (same limitation every prior
Dream Cycle night in this repo has hit). This report is the durable record, committed here and
referenced from the ledger row and this night's issue-comment reconciliation on #161/#163.

## Witness

Per this pipeline's own STEP 16 ordering, the hashed artifact is the pre-stamp gist snapshot
(`/tmp/dream-gist-2026-09-08.md` in this session's container, ephemeral — same LOCAL-gist
limitation as every prior night, no `gh`/gist-creation tool available), NOT this committed copy
(which has this section filled in after hashing, so its own bytes differ from what was hashed).

```
SESSION_COMMIT = 80c5322e6eaf87dd93cdeaac9fd12b49811cf034
REPORT_HASH    = 847697a3c606cb84f812aad85c4ed44f70370dda3365f2369062f8b7b9ac3d63   (of the pre-stamp snapshot)
WITNESS        = 75330f2abb26da9a38aa4b1b96a6f4835e31ba89803d8d1a8f2f35160c4f176e
```

Verify: (1) checkout `80c5322e6eaf87dd93cdeaac9fd12b49811cf034`; (2) reconstruct the pre-stamp
snapshot as this file's content with this Witness section replaced by the single line `See
docs/dream-cycle/LEDGER.md's 2026-09-08 row for the computed WITNESS value (this file must be
committed and hashed before the stamp can be computed; the row records the exact procedure).`
(i.e. what this section read before this edit); (3) `sha256sum` that reconstruction, confirm it
starts `847697a3c6...`; (4) `printf '%s%s' 847697a3c606cb84f812aad85c4ed44f70370dda3365f2369062f8b7b9ac3d63 80c5322e6eaf87dd93cdeaac9fd12b49811cf034 | sha256sum`,
confirm it starts `75330f2abb...`; (5) re-run `npx vitest run tests/unit/forge-hybrid-port-claims.test.mjs
tests/unit/self-retrieval-bench-hybrid-mode.test.mjs tests/unit/countrefs-primer-l2-drift.test.mjs
tests/unit/primer-grounding.test.mjs` on that commit, confirm 11 passed / 4 todo / 0 failed.

## Recommendation

`evaluated: not attempted` for a new candidate (no hypothesis survived investigation to the
freeze-then-evaluate stage); `evaluated: accepted` for tonight's actual work, the reconciliation of
#161 and #163 as integrated, verified via passing tests and `git log` commit references rather than
assumed. Issue=NONE (no new issue warranted — nothing new, reproduced, and unresolved surfaced).
`autoMerge: false` — this session never self-merges or self-promotes; tonight's PR carries no
production code diff, only this report and the ledger row.
