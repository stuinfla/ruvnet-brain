---
id: ADR-011
---
# ADR-0011: The Verified Quality Program — gates that can fail, before scores that can be believed

**Status**: Proposed
**Date**: 2026-07-09
**Authors**: Claude Code (Opus 4.8), directed by Stuart Kerr
**Supersedes**: None
**Related**: ADR-0002 (ground-truth multi-vendor gate), ADR-0004 (effectiveness first), ADR-0005 (behavioral grounding, not a lock), ADR-0008 (autonomous engineering loop), ADR-0009 (mirror discipline)

**Design-only.** No code ships with this ADR; the contract IS the deliverable. It moves to
`Accepted` when Phase 0 lands, and to `Implemented` when every Test Contract below passes in CI.

---

## Context

On 2026-07-09 the brain was scored across eight dimensions with a deduction and cited evidence for
every point lost (stored in AgentDB, key `scorecard-2026-07-09`). Overall: **≈55/100**. The scoring
exposed something worse than any individual score: **most of our claims are unfalsifiable**.

### Problem Statement

1. **The quality gate cannot detect the regression it exists to catch.** The frozen held-out set is
   n=12. `routed 10/12` carries a 95% Wilson interval of **[55.2%, 95.3%]**; `9/12` has an upper
   bound of 91.1%. The intervals overlap completely. Detecting a drop from 0.83 → 0.73 at 80% power
   requires **n ≈ 99** (one-sided, one-sample). We gate on a point estimate we cannot distinguish
   from noise.

2. **CI was red for six consecutive pushes and nobody looked.** Two independent causes:
   `tests/unit/verify-bundle.test.mjs` signed with the repo's REAL private key, which CI must never
   hold; and `vitest run` pulled `tests/integration/*` — brain-dependent tests — into a job whose own
   comment says it runs "the brain-independent checks". A security test that runs on exactly one
   laptop guards nothing. Separately, `tests/integration` is still not a required check, so a broken
   integration test was pushed to `main` on 2026-07-09 and nothing stopped it.

3. **The user's reported bug is caused by our own hook.** `plugin/scripts/ground-ruvnet.sh:184`
   instructs the model to end every build response with "Want me to build it now?" — a question
   asked to an empty room during an unattended `/loop`. ADR-0008 specifies the loop that would fix
   this; it is **Accepted (2026-06-28) and unbuilt**, and self-grades the artifact ~30/100.

4. **The brain is expensive per turn, and nothing measures it.** Measured on 2026-07-09: the hook
   injects **60 tok** (chitchat), **813** (recall), **2,065** (build), **2,796** (build+test) — and
   the identical playbook is re-sent every turn. `search_ruvnet` at k=3 returns **2,819 tokens** of
   whole documents (avg 4,486 chars each); k=1 returns 441. A 20-turn build pays ~40–60k tokens of
   injection before the model writes a word. No tool in the stack measures Claude Code's spend:
   `routing_economics` returns hardcoded `qualityScore` constants and observed `$0.00`.

5. **Retrieval is slow in one place only.** A warm single-store search is 10 ms; fan-out across 29
   warm stores is 393 ms; the cross-encoder rerank of 248 candidates is **~12–15 s at ~61 ms/pair —
   97% of query time**. Batching is already maxed (`CE_BATCH_SIZE=16`), so the remaining win is
   cores, not bigger batches.

6. **Method is advised, never enforced.** SPARC / DDD / ADR appear as prose in the hook. Nothing
   verifies a phase ran, an artifact exists, or an Accepted ADR still matches the code. Until
   2026-07-09 the official `ruflo-adr` importer parsed **all 11 of our ADRs as status `unknown`**
   because our header wrote `**Status:**` (colon inside the bold) where the parser expects
   `**Status**:`. The tool that guards our living plans was blind to every one of them.

7. **State is written but not recalled.** `ruflo memory store` writes; `ruflo memory retrieve --key`
   reads; `ruflo memory search` returns **0 hits at every threshold**. On 2026-07-09 `.swarm/memory.db`
   was additionally found corrupt (`database disk image is malformed`, invalid page 1814, rowid out of
   order). It was repaired via `sqlite3 .recover` with **zero row loss** — and search *still* returned
   0, proving the two failures are independent. Nothing was checking `PRAGMA integrity_check`; the rot
   was silent until a write failed.

8. **Autonomy is unfenced.** Enabling the flywheel requires `ruflo daemon start`, which also enables
   five other workers (`map`, `audit`, `optimize`, `consolidate`, `testgaps`). They wrote source and
   tests into this repo unattended and inflated the todo backlog 181 → 266 with four files containing
   **zero assertions**.

---

## Decision

Seven phases, executed in order. **Phase 0 is not negotiable and not reorderable**: every claim made
by a later phase is unverifiable until the gates can fail.

Each phase carries a **Test Contract** — a machine-checkable exit criterion. A phase is not done
because it was built; it is done because its Test Contract passes in CI and would fail if the work
were reverted (mutation-verified, per ADR-0002's ground-truth discipline).

### Phase 0 — Make the gates able to fail

- Expand `evals/held-out.json` from 12 → **120 questions**, stratified across five strata:
  *named* · *described-need* · *full scenario* · **adversarial (the correct answer is "not in this
  corpus")** · *gist-vs-repo provenance*. Expectations chosen from first principles before the brain
  is run against them, per the existing frozen-set discipline.
- `scripts/eval-brain.mjs` gates on the **Wilson lower bound**, not the point estimate.
- Promote `tests/integration` to a required CI check on Linux (`.github/workflows/integration-linux.yml`
  already exists and is green as of 2026-07-09: 39 passed, 1 skipped).
- Widen `coverage.include` from 8 files to every shipped source file; set the floor at
  `measured − 2` points.
- Add a **claims ledger**: every user-facing number (`~56× cheaper`, `33% → 96%`, `12/12 grounded`)
  is regenerated by a script. `npm run claims:verify` fails CI when any advertised number cannot be
  reproduced from source.

**Test Contract.** (a) `npm run eval` reports a Wilson lower bound and refuses to promote below the
recorded baseline; (b) the suite has ≥80% power to detect routed 0.90 → 0.80 (n ≥ 69 suffices;
n = 120 gives margin); (c) deliberately breaking one integration test blocks a push; (d)
`npm run claims:verify` fails when a published number is edited to a false value.

### Phase 1 — Autonomy: implement ADR-0008's loop contract

An **autonomy gate** in `ground-ruvnet.sh`, active when the turn is unattended (`/loop`, "autonomously",
"unattended", `RUVNET_AUTONOMOUS=1`):

- **Never halt to ask.** Override beat A.5 ("Want me to build it now?") and the API-key ask. Choose
  the cheapest-to-reverse interpretation, record the assumption, proceed.
- **Declare done-criteria in iteration 1**, machine-checkable (a command + expected exit code).
- **Resume first, checkpoint last.** Each iteration reads the prior checkpoint and continues from
  `next`; each iteration writes `{iteration, doneCriteria, done, next, blockers, noProgressCount}`.
  Shape follows rUv's own durable-execution pattern (`ruflo/v3/@claude-flow/integration/src/long-running-worker.ts`:
  `saveCheckpoint` / `resumeFromCheckpoint`, progress 0→1, auto-retry with exponential backoff) and
  `agenticow/examples/checkpointing.mjs` (rollback to the last checkpoint **without replaying**
  completed steps).
- **Stop conditions**, stated when triggered: all done-criteria pass · `noProgressCount ≥ 2` ·
  a decision that is genuinely the user's · token budget exhausted.
- **Autonomy safety fence.** Unattended runs never publish, deploy, force-push, rewrite history,
  delete data, rotate secrets, post outward-facing content, or spend on new paid services. They do
  everything up to that line, checkpoint, stop, and name the click required.

ADR-0008 moves `Accepted` → `Implemented` **in the same commit**, with an `Updated:` date.

**Test Contract.** A seeded unattended loop (i) runs ≥3 iterations without asking a question,
(ii) survives `kill -9` and resumes from checkpoint without repeating completed steps,
(iii) halts on done-criteria, (iv) halts and asks when a fenced action is required, and
(v) halts after two no-progress iterations. All five assertions in `tests/integration/`.

### Phase 2 — Cut the token tax

- Inject the "take the wheel" playbook **once per session** (SessionStart). Per-turn output becomes
  one line plus only the gates that actually fired.
- `search_ruvnet` returns **snippet + path + score** by default; the full document only on an explicit
  second call or `--full`.
- Surface a per-session meter: tokens the brain injected, queries issued.

**Test Contract.** Re-run the 2026-07-09 probe: build-prompt injection **≤ 250 tok** (from 2,065);
`search_ruvnet` k=3 **≤ 900 tok** (from 2,819). `npm run eval` lower bound unchanged (fail-closed):
a cheaper brain that answers worse is a regression, not a saving.

### Phase 3 — Make it fast without making it dumber

Shard the cross-encoder across worker threads (97% of a 13.6 s query).

**Explicitly rejected: vector prefiltering.** Measured 2026-07-09 — restricting the CE to the top-48
candidates by vector distance is **5.3× faster and wrong**: for *"store embeddings without a server"*
the full rerank returns `ruvector/CARD/ruvector-card`; the prefiltered run returns
`src/governance/shard-embeddings.ts`. The capability card is not in the top-48 by vector distance.
The cross-encoder is the only mechanism that finds it — the same mechanism that moved described-need
routing 33% → 96%. A 5× speedup that deletes the product's best feature is the most expensive kind of
optimization.

**Test Contract.** p50 warm query **≤ 3.0 s** AND `npm run eval` Wilson lower bound not lower than
baseline. Both, or neither.

### Phase 4 — Enforce the method instead of advising it

- Each SPARC phase emits an artifact; a `Stop` hook verifies the artifact exists and references the
  code it claims.
- `adr-verify` runs in CI: an `Accepted` ADR whose referenced files no longer support its claim fails
  the build. ADR headers are linted to the `ruflo-adr` parse contract (`**Status**:`, `**Date**:`,
  `**Related**:`) so the graph is never silently empty again.
- QE runs against **code** (`quality_assess`), never against a remote URL: `qe_qx_analyze` returned an
  F grade in 2 ms for a page whose every asserted claim was false when checked against the real HTML.
- Repair `ruflo memory search`, or replace recall with an index we control. Recall is what
  "does not get lost" means; write-only memory is a diary, not a brain.

**Test Contract.** A requirement walks Spec → Pseudocode → Architecture → Refinement → Completion with
a machine-checked artifact per phase; killing the process mid-phase resumes at that phase;
`memory search` returns the checkpoint it just wrote; `adr-verify` fails on a deliberately contradicted
ADR.

### Phase 5 — Knowledge coverage, freshness, and the untested claim

- Ingest the registry in tiers (`data/manifest.json` today: **"Covers: 20/169 repos"**).
- Every answer carries its snapshot date; `--doctor` warns when a repo's snapshot trails upstream HEAD.
- **Red-team the provenance banner.** We assert that stamping `GIST STATUS: may describe PROPOSED or
  UNRELEASED work` onto every gist chunk prevents the brain from repeating an unshipped claim as
  fact. That is an assertion, not a result: we proved the text reaches the model, never that the model
  obeys it.

**Test Contract.** Tier-1 coverage ≥ 60%. A planted gist claiming an unshipped feature must not be
restated as shipped in ≥95% of trials.

### Phase 6 — Safety of autonomy, and of the store itself

- Fence tests: a loop that attempts `npm publish` must stop and ask.
- Scope the daemon (`--workers harness`) so enabling `RUFLO_HARNESS_LOOP` does not also enable five
  workers that write code into the user's repo.
- Nightly `PRAGMA integrity_check` on `.swarm/memory.db`, alerting on failure, with
  `agentdb-sessions.jsonl` retained as the proven fallback.

**Test Contract.** The fence tests pass; a corrupted `memory.db` fixture is detected by the nightly
check within one run.

---

## Consequences

### Positive

- Every score becomes falsifiable. A claimed 90 survives an attempt to disprove it.
- The user's actual reported bug (autonomy halting) is fixed by Phase 1, not deferred behind speed work.
- Token cost per build turn drops ~90% with a fail-closed quality guard, so cheapness can never be
  bought with worse answers.
- ADRs re-enter the tooling: the `ruflo-adr` graph can verify them, which is the difference between a
  living plan and stale paper (ADR-0009's Mirror Discipline, applied to itself).

### Negative

- Phase 0 delays visible improvement by ~2 days and produces no user-facing feature.
- A 120-question held-out set costs ~20 minutes per eval run at today's 13.6 s/query; Phase 3 must
  land before the eval is comfortable to run on every push.
- Widening `coverage.include` will drop the headline coverage number. That number was flattering
  because it measured 8 files.

### Risks

- **Sample-size theatre.** Growing the held-out set to 120 without stratification would raise n and
  still miss the failure modes that matter. Mitigation: the five strata are part of the Test Contract,
  and the adversarial stratum must be non-empty.
- **The autonomy fence is prompt-enforced, not harness-enforced.** A model can, in principle, ignore
  it. Mitigation: fence-relevant actions (publish/deploy/push) also require a tool the loop is not
  granted; the prompt fence is defense in depth, not the only defense.
- **Phase 3 could regress quality invisibly.** Mitigation: the Test Contract requires the eval lower
  bound to hold; the vector-prefilter experiment is recorded here precisely so nobody re-tries it as
  an "obvious" optimization.
- **Fixing `memory search` may be out of our control** (it is `@claude-flow/cli` behavior). Mitigation:
  Phase 4 permits replacing recall with an index we own rather than blocking on upstream.

---

## References

- `evals/held-out.json`, `scripts/eval-brain.mjs`, `evals/baseline.json` — the frozen set and gate.
- `plugin/scripts/ground-ruvnet.sh:184` — the halt this program removes.
- `docs/adr/0008-autonomous-engineering-loop.md` — Accepted, unbuilt; Phase 1 implements it.
- `docs/adr/0002-ground-truth-multivendor-gate.md` — the ground-truth discipline this ADR extends.
- `docs/adr/0009-mirror-discipline-self-audit-and-qa.md` — the brain must pass its own bar.
- `ruflo/v3/@claude-flow/integration/src/long-running-worker.ts` — checkpoint / resume / retry pattern.
- `agenticow/examples/checkpointing.mjs` — rollback without replay.
- `agent-harness-generator/docs/adrs/ADR-157-darwin-checkpoints-durable-execution.md` — durable,
  crash-resumable runs with a content-addressed call cache (Status: Proposed).
- AgentDB `scorecard-2026-07-09` — the scored baseline this program is measured against.
