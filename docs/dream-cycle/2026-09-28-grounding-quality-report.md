# Dream Cycle 2026-09-28 — grounding-quality

DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5, `20260928 % 5 == 3`).
No bonus deep dive tonight (`% 25` = 3, `% 75` = 53, both non-zero).

## Read this first — the backlog, now 28 days

31 open `dream/*` PRs (#269 through #333, oldest 20 days old), **zero merged since #214/#215
(2026-08-31)** — the longest zero-merge stretch in this ledger's history, live-counted tonight via
the GitHub MCP tools, not assumed. 5 open `dream-cycle` issues (#298, #274, #264, #260, #258). This
is not new information — every night since 2026-08-26 has flagged it — but it is the single
highest-value thing for the human owner to look at tonight, ahead of the finding below.

## Compile-blocked issue #298 — new evidence, no new issue

Tonight's own `npx -y dream-machine@0.1.1 compile dream.config.json --out /tmp/tonight.md` **succeeded**
(unlike the 2026-09-19 and 2026-09-27 nights, both recorded in #298). Separately, testing #298's own
suggested remediation — vendor `dream-machine@0.1.1` into `devDependencies` so the nightly compile has
a locally-installed binary instead of depending on an `npx -y` fetch at run time — this session ran
`npm install --no-save --no-audit --no-fund dream-machine@0.1.1` and it was **itself denied** by the
same sandbox classifier, reason `[Code from External]`. Per the denial's own instructions, no
workaround was attempted (writing a fabricated `package-lock.json` entry to route around it would be
exactly the kind of bypass the denial explicitly prohibits). This is new evidence: #298's suggested
fix is not self-administrable by an automated night either — it needs a human, working outside this
sandbox, to do the one-time `npm install --save-dev dream-machine@0.1.1` and commit the resulting
lockfile change. Recorded as a comment on #298 (still open, unresolved); no new issue opened.

## Hypothesis

> Given a query matching `specificationToCompletionMethodQuestion()` or `pythonFreeRustNeuralQuestion()`
> (or the concept-inventory/`stableCoreSwarmTopology` compound mode) in `kb/forge-ask-all.mjs`'s
> `sourceBackedCardLane()`, when the synthetic capability-card candidate is forced to rank #1 via
> `candidates.unshift(...)` ahead of already-collected real evidence, then `kb/verify-citation.mjs`'s
> `citationResolves()` can never resolve that citation — because its path
> (`capability-cards.md#<repo>`) is a hand-written, top-level file that neither `kb/forge-corpus.mjs`
> nor `kb/forge-build.mjs` ever chunks into any repo's own passages store — so the rank-#1 citation
> any "read the top result" consumer relies on is permanently unverifiable while genuinely resolvable
> evidence sits one rank lower. Then changing `unshift` to `push` (2 call sites) should make
> `results[0]` a real, verifiable citation whenever real evidence exists, subject to: zero change to
> `implementation.implementationSources` or to any existing assertion on the joined result text
> (order-independent), and the all-card/zero-real-evidence case must still correctly return `null`
> via the lane's own unchanged final gate.

Frozen before touching any file. Not modified since.

## Candidate

`kb/forge-ask-all.mjs`: 2 sites, `candidates.unshift({...})` → `candidates.push({...})` (the
specification-to-completion/Rust-neural branch, and the concept-inventory/`stableCoreSwarmTopology`
branch), plus a one-line comment at each site. `tests/unit/forge-ask-all.test.mjs`: one new TEETH
test, `"TEETH: the source-backed-card lane must not force an unverifiable citation to rank #1"`.
3 files changed (+ `data/convergence-manifest.json`, regenerated, not hand-edited), +68/-4 lines.

## Evaluation Receipt

- **TEETH, independently reproduced twice** (this session + an adversarial critic subagent, neither
  the fix's own author claim alone): reverting only the two `unshift`/`push` changes turns the new
  test red — `expected 'capability-cards.md#method-engine2' not to match /^capability-cards\.md#/` —
  restoring it is green; diff after restore matches the candidate byte-for-byte.
- Targeted regression: `npx vitest run tests/unit/forge-ask-all.test.mjs
  tests/unit/source-card-adversarial-qe.test.mjs tests/unit/verify-citation.test.mjs` → 140/140 pass.
  Critic separately ran the same set plus the `forge-mcp-*` integration tests → 150 passed/4 todo/0
  failed.
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (`stores 0
  dark 0`, this container never materializes a corpus; not a credentials block, `OPENROUTER_API_KEY`
  is present).
- `npm run claims:verify`: 3 PASS / 4 SKIP (standard composition).

## Baseline

Unmodified `origin/main` at `587e2bb10a2b54cd2cb8fc599a6609a350bc4e2b` (this session's starting
commit, re-fetched and confirmed identical to `origin/main` before starting). Compared via
`git stash` / `git stash pop`, sequentially (not concurrently, to avoid load-induced flake) against
the same working tree.

## Darwin Lineage

Not run — no continuous parameter to evolve for an ordering fix (two literal `unshift`→`push` calls).

## Evidence

OBSERVATION (`sourceBackedCardLane()` unshifts a synthetic card candidate whose path can never match
anything `citationResolves()`'s per-repo passages-store lookup could contain) → MEASUREMENT (TEETH
red pre-fix / green post-fix, reproduced independently twice; `test:unit` full-suite failing-file set
byte-identical baseline vs candidate, 15/15 files, with the only delta being the new test's own +1
pass; `test:integration` byte-identical, 10 failed/39 passed/5 skipped files both sides) → INFERENCE
(sole call site of `sourceBackedCardLane` is `searchAllPrimary`; no consumer depends on the card
occupying rank #1; the lane's `k-1` slicing and `proofSources.length < 1 → return null` final gate
guarantee `push` can neither truncate real evidence out of `results` nor silently leave a
zero-evidence answer) → DECISION (ACCEPT, pending human review).

## Reward-Hack Check

CLEAR. No benchmark, threshold, or gold answer touched (`evals/held-out.json` unchanged). The fix
does not touch `kb/verify-citation.mjs`'s resolution logic at all — only which array index a
candidate occupies before `parseCitations()` ever runs on the printed stdout. Not one-directional:
this cannot inflate a score, since `verifyGrounding()`'s overall pass/fail path is unchanged (the
lane already required ≥1 real, resolvable citation to return anything).

## Adversarial Critique

Independent `general-purpose` subagent, no access to this session's reasoning, tasked explicitly to
find reasons to REJECT. **Verdict: CLEAR.** Independently confirmed the diagnosis (its own greps of
`forge-corpus.mjs`/`forge-build.mjs` for "capability-cards" returned zero hits), the blast radius
(sole call site `forge-ask-all.mjs:3331`; `card-lane.mjs` is a separate, unrelated "fast lane"
mechanism, correctly left out of scope), ran the test suite itself, independently reverted/restored
the fix to confirm the test is not vacuous, confirmed no gold data or existing assertion was touched,
and traced the lane's own guards to confirm `push` cannot regress the zero-evidence case. One
incidental corroboration noted: `scripts/eval-brain.mjs`'s own code comments already document this
exact "`citations[0]` can under-count a correctly-routed answer" hazard class, independent evidence
this is the right fix direction rather than a novel theory.

## Security Review

Pure ordering change inside an offline retrieval/citation-assembly function — no network call, no new
credential path, no new user-input parsing. Does not touch `verify-citation.mjs`'s resolution logic;
the phantom citation is exactly as (un)resolvable as before, it simply no longer occupies rank #1
ahead of real evidence. No new attack surface. Side note, not claimed as a fix: this incidentally
makes the synthetic candidate a less predictable target for issue #236/ADR-0087's still-unresolved
citation-rank-hijack gap, since it no longer sits at a fixed, guessable rank — that issue remains
open and architectural, unaffected by tonight's candidate either way.

## Regression Analysis

`test:integration` (54 files/422 tests): **byte-identical** baseline vs candidate — 10 failed/39
passed/5 skipped files (25 failed/335 passed/17 skipped/45 todo tests), all pre-existing
cross-encoder-model-priming failures (`expected finite cross-encoder scores; fallback is not a
successful model load` — no network/model cache in this container), matching every prior night's
documented pattern exactly. `test:unit` (473 files/5892→5893 tests): **byte-identical failing-file
set**, 15/15 files identical between baseline and candidate (`corpus-seed-release-authority`,
`hook-shim-fallback-once`, `rehearse-corpus-pipeline`, `corpus-accuracy-gate`, `advocacy-outcomes`,
`no-restated-truth`, `pre-commit-convergence-heal`, `retrieval-canary`, `advocacy-route`,
`user-settings`, `corpus-customer-promotion`, `lesson-migrate-agentdb`,
`console-memory-canonical-store`, `advocacy-ignored`, `agentdb-fleet-doctor-sql-escape` — none touch
citation/grounding/`forge-ask-all`). The only delta is the new test's own +1 pass (5664→5665 passed,
43 failed both sides). An earlier, discarded comparison run (three heavy `vitest` invocations
launched concurrently, competing for the same CPU) showed a transient extra failure — re-run
sequentially per this repo's own documented load-flake precedent (2026-08-31 ledger row), and it
disappeared; not counted as a regression.

## ADR

None — not an architectural decision, a two-line ordering fix mirroring an already-documented hazard
class (`scripts/eval-brain.mjs`'s own comments).

## Gist

LOCAL — no `gh` CLI or gist-creation MCP tool available this session (same limitation every prior
Dream Cycle night on this repo has recorded).

## Issue

`NONE` — per this repo's ISSUE DISPOSITION OVERRIDE: a new, reproduced, actionable defect was found
and resolved within bounded authority tonight (verified fix, TEETH red→green, independent critic
CLEAR, zero regression). A verified fix is a work record carried by its PR, not a tracking issue.

## Witness

```
SESSION_COMMIT = 587e2bb10a2b54cd2cb8fc599a6609a350bc4e2b
REPORT_HASH    = e7df8d894cb07358f6132d45a41c7546030379ef0e6e0d0bd59efbfb0f62d348
WITNESS        = af0a09d1bac45765f084a761192cbda9bd1f62593f1ef0aa7d4ebd694bd836d1
```

Verifier procedure: (1) check out `SESSION_COMMIT`; (2) apply this PR's diff; (3) run
`sha256sum docs/dream-cycle/2026-09-28-grounding-quality-report.md` and confirm it matches
`REPORT_HASH` above (computed on the pre-witness-stamp version of this file, per this pipeline's
STEP 16 ordering — committed bytes differ after this section is filled in); (4)
`printf '%s%s' "$REPORT_HASH" "$SESSION_COMMIT" | sha256sum` and confirm it matches `WITNESS`; (5) run
`npx vitest run tests/unit/forge-ask-all.test.mjs -t "TEETH: the source-backed-card lane"` and confirm
it passes on the candidate and fails when the two `push` calls are reverted to `unshift`.

## Merge Policy

**Human review required.** `autoMerge: false` per `dream.config.json` (ADR-068) — the decision, not a
default. This session never self-merges and never autonomously promotes candidate state. Draft, by
design.
