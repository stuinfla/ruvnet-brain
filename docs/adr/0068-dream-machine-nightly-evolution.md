---
id: ADR-068
title: The Dream Machine runs this repo's nights — evaluation is not promotion
status: Accepted
date: 2026-08-19
updated: 2026-08-30
authors: [Stuart Kerr, Claude Code]
tags: [automation, evaluation, nightly, self-improvement, promotion-gate]
supersedes: []
relates: [ADR-023, ADR-055, ADR-058, ADR-063, ADR-067]
governs:
  - dream.config.json
  - docs/dream-cycle/LEDGER.md
  - tests/unit/dream-config.test.mjs
---

# ADR-068 — The Dream Machine runs this repo's nights

## Status

**Status**: Accepted

Accepted 2026-08-19; **RUNNING since 2026-08-20** (routine `trig_01VuFmQFG3YdaPeswTPMVaT6`, cron `30 8 * * *`
UTC). The config is committed and validated, and the nightly cloud schedule now exists — it was created on the
owner's explicit instruction, since doing so spends his account and was his to authorize.

## Context

rUv ships [`dream-machine`](https://github.com/ruvnet/dream-machine) (npm `dream-machine@0.1.1`,
verified live before this ADR): *"a config-driven engine for nightly, cloud-scheduled,
evidence-gated repository evolution. Composes @metaharness/flywheel, darwin, and redblue behind a
promotion gate that never merges."*

It is the **generalization of two routines already running nightly** against `ruvnet/ruflo` and
`ruvnet/metaharness` — both ~800-line prompts running the same 26-step pipeline, differing only in a
small per-repo delta. The engine factors the shared spine out and leaves the delta in a
`dream.config.json`.

Why this repo wants it, specifically. The last week produced a long list of defects that shared one
shape: **nothing was watching the surfaces nobody was looking at.** Hooks were broken in other
people's projects for weeks. The brain's store count silently reverted overnight, twice. Five
ratified `ship` lessons could not fire. A `$1,600` spend rule was advisory. Every one of those was
found by a human noticing, or by an adversarial audit run on demand — never by the repo itself.

A nightly cycle that forms one falsifiable hypothesis, measures it against this repo's REAL
evaluators, and records the result whether or not it liked the answer is precisely the missing
organ.

## Decision

**1. Adopt `dream-machine` as the nightly evolution engine, configured by a committed
`dream.config.json`.** Not a hand-written prompt. The engine is rUv's; the delta is ours. This is
the project's standing rule — never hand-roll what rUv already ships — applied to the one place we
were about to hand-roll it.

**2. The rotation slots are THIS repo's real failure surfaces, not the scaffold's generic ones.**
`dream-machine init` scaffolds `correctness / security / architecture / performance /
developer-experience`. Those are placeholders. Ours are derived from where this repo has actually
broken:

| slot | why it is a surface here |
|---|---|
| `cross-host-conformance` | hooks were broken on Codex and in foreign projects for weeks, undetected |
| `brain-currency` | 67 stores of 201 live repos; 29 dark; the cache silently reverted twice |
| `enforcement-integrity` | rules stored and ratified but delivered as advisory text nobody reads |
| `grounding-quality` | the product's core claim — retrieval bound to real source |
| `memory-durability` | three days of writes evaporated behind an `[OK]` success line |

**3. `autoMerge: false`, and this is not a default we inherited — it is the decision.** rUv's own
config sets `autoMerge: true` for his repo. Ours is false. This repo already has a pre-push gate,
a version-bump gate, a doc-currency gate and a both-hosts conformance gate; a machine that merges
past them would make every one of those a formality. **Evaluation is not promotion.** The night ends
in a DRAFT PR and a ledger row; a human merges.

**4. The evaluators are the ones that can actually falsify a claim about this product**, not `npm
test` alone:

- `npm run eval:gate` — the frozen 120-question held-out set across 5 strata. This is the gate of
  record (ADR-0002) and the only thing that measures whether the brain still answers correctly.
- `npm run test:all` — unit, mesh, mutation, regression.
- `npm run test:integration` — carries the both-hosts conformance gate, which is the guard against
  the class that broke real users.
- `npm run claims:verify` — every advertised number regenerates from an artifact, or SKIPs loudly.

**5. The ledger is `docs/dream-cycle/LEDGER.md`, committed.** Exactly one row per night, ACCEPT |
REJECT | INCONCLUSIVE. A REJECT with a clean measurement is a successful night — the system
optimizes for shrinking tomorrow's search space, not for producing PRs.

## Alternatives considered

**A hand-written nightly prompt.** Rejected: it is the ~800-line megaprompt the engine exists to
replace, and this repo already carries `scripts/nightly-wrapper.sh`. Two nightly systems disagreeing
about what "nightly" means is the restated-fact defect that has cost this project repeatedly.

**GitHub Actions `dream-nightly.yml` instead of a cloud routine.** Viable and offered upstream. Not
chosen as the primary path because the cloud routine runs on the owner's Claude seats, which the
`spend-guard` policy and `lesson-subscription-seats-never-metered-api` both require; a CI runner
would need a metered key to do LLM evaluation. Recorded as the documented fallback for anyone
without a seat.

**Deferring until the open findings are closed.** Rejected: the open findings are the evidence FOR
adopting it. A machine that surfaces one measured thing per night is what would have caught them.

## Consequences

- The repo gains a nightly, autonomous evaluation cycle whose output is evidence, not merges.
- `docs/dream-cycle/LEDGER.md` becomes a durable, append-only record of what was tried and learned.
- Nights with no `OPENROUTER_API_KEY` report `LLM_EVAL=blocked` and an honest `INCONCLUSIVE`. That is
  a legitimate successful night, not a failure to hide.
- The schedule itself is NOT created by this ADR. Creating a cloud routine spends the owner's
  account; it is his to authorize, and it is one `/schedule` command.

## Honesty boundary

- **MAY claim**: the config is committed, schema-valid against `dream-machine@0.1.1`, and compiles
  to a routine prompt; the engine and its CLI were read from rUv's live source, not recalled.
- **May NOT claim**: that a night has run, that the loop improves this repo, or any verdict
  distribution. Nothing has run yet. The first real claim available is the first ledger row.
- **Unmeasured**: whether this repo's evaluators are sensitive enough for a hypothesis to be
  falsifiable in one night. The first several nights are the experiment that answers it.

## Turning it on

```bash
npx dream-machine schedule dream.config.json --out routine.json   # emit the cloud routine body
```

Then in Claude Code: `/schedule`, nightly cron, target `stuinfla/ruvnet-brain`, and paste the
bootstrap prompt (recommended over a frozen prompt, so the schedule can never drift from the
committed config).

## Currency log

| 2026-09-04 | `docs/dream-cycle/LEDGER.md` (a governed path) gained tonight's row — Dream Cycle 2026-09-04, `health-repair.mjs`'s `--distill-fleet` fix, PR #246 — re-read against this ADR's own decisions before appending: `autoMerge: false` held, the row records ACCEPT with a full evaluation receipt, and a CONCURRENT-NIGHT collision (#243/#244, same slot) was named rather than hidden, per Decision 5 and the 2026-08-20 precedent this same log already records. `dream.config.json` and `tests/unit/dream-config.test.mjs` were not touched tonight. | PR #246 |

| 2026-08-30 | Reviewed against release candidate 4.3.3: the nightly ledger status vocabulary was corrected to the engine's yes/no/blocked contract; auto-merge remains disabled. | 1beedaa |

| 2026-08-30 | Nightly findings are separated from the bounded release gate; deterministic contract lanes run on PRs while corpus/nightly work remains explicit. | `scripts/qa-runner.mjs` and `docs/QA-RELEASE-PROCESS.md` prevent exploratory work from silently approving or blocking publication. |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-24 (night 5) | **A fifth night ran, SLOT 4 again — deep `memory-durability`, scans `managed-boundary` + `round-trip-proof` — and filed #165 with candidate PR #167.** `scripts/record-lesson.mjs` derived its write-success verdict from regex-matching `ruflo memory store`'s own stdout wording, the exact false-positive shape ADR-063 documents as the 2026-08-13 incident's cause; it never received the exact-key round-trip discipline already established in `degradation-watch.mjs`'s `proveMemoryDurable()` and `learning-replay-fixture.mjs`'s `retrieveExact()`, and hardcoded `ruflo` instead of the shared `resolveRuflo()` (ADR-021 / #99, #105). | New `tests/unit/record-lesson.test.mjs` (zero coverage existed before tonight): 2 of 3 original cases fail red on pre-candidate, all pass green on candidate. `dream-machine ledger verify` caught a real defect in this row's own first draft — a raw `\|` inside a quoted regex literal broke the markdown table, shifting every column after it — fixed by rewording, verified locally with the same tool before the second push. CI's `windows-unit` job then caught a second real gap: the new test's fake-`ruflo` fixture had no Windows `.cmd` shim (the pattern `distill-project.test.mjs` already established for this exact binary), and `record-lesson.mjs` itself was missing the `shell: process.platform === 'win32'` guard CVE-2024-27980 requires for a `.cmd` binary — the same class this ADR's own 2026-08-19 row documents for `dream-config.test.mjs`'s `npx` invocation. Both fixed in the same PR. Re-checked prior nights' fates via GitHub MCP, not assumed: #142/#143, #147/#148, #149/#150 all MERGED; #154/#155 CLOSED, NOT MERGED. `autoMerge: false` held; draft PR awaiting human review. |
| 2026-08-20 (night 2) | **The routine FIRED TWICE, and the ledger says so rather than hiding it.** | First scheduled night after the routine was created this morning; SLOT 0 = cross-host-conformance. Two concurrent firings produced two independent, non-overlapping findings: #147/#148 (Codex TEETH assertions vacuous) and #149/#150 (mesh census blind to codex-hooks.json). #150's own row names the collision — 'CONCURRENT NIGHT — a separate firing of this same routine (same SLOT=0/DEEP) landed first as #147/#148' — which is the discipline working: it detected the overlap and recorded it instead of presenting itself as the only run. BOTH rows kept for 2026-08-20; the one-row-per-night convention assumed one firing, and collapsing them would erase the double-fire. WHY it fired twice is NOT established and is not claimed here. Both candidates were verified independently before promotion (guards broken by hand, watched go red, restored) and merged; `autoMerge:false` held — the machine proposed, a human promoted. |
| 2026-08-20 (night 2) | **A second night ran, on the now-live cloud schedule, and it filed the ledger's second row.** | The cycle executed as the registered routine, SLOT 0 — deep `cross-host-conformance`, scans `codex-parity` + `stranger-project-behaviour` — and filed #147 with candidate PR #148. Re-checked night 1's fate via the GitHub MCP tools rather than assuming it: #142 closed/completed, #143 merged 2026-08-20T05:30:13Z. Finding: `tests/integration/hook-conformance-both-hosts.test.mjs`'s Codex-side assertions were vacuous by measurement — every Codex hook silently short-circuited through two undocumented exit branches (the `codex-hooks.json` trampoline, then `codex-hook-wrapper.mjs`'s spine resolution) before reaching real hook logic, so "no stderr/no artifacts/within timeout" passed by construction, never by measurement, for the Codex host specifically. Candidate installs a real Stable-Spine fixture in the test only; no production Codex wiring changed. `autoMerge: false` held; this is a draft PR awaiting human review, same as night 1. |
| 2026-08-20 | **THE SCHEDULE NOW EXISTS. This document said it did not, and that was true until today.** | "Turning it on" described a human-performed step, and Status said "Accepted as configured, not as running" — because creating a cloud routine spends the owner's account and is his to authorize. He authorized it. Verified first that it genuinely was NOT scheduled: the account held exactly ONE routine (the every-other-day issue watch, `has_more: false`), so night 1 had been a one-off and nothing recurred. Created `Ruvnet Brain Nightly Dream Cycle` (`trig_01VuFmQFG3YdaPeswTPMVaT6`), cron `30 8 * * *` UTC — the config's own value, 04:30 America/New_York, the deliberate stagger recorded in `_cronNote` — enabled, model claude-sonnet-5, source `stuinfla/ruvnet-brain`, environment `StuMaster .env` (the same one the working issue-watch routine uses, so GitHub auth and OPENROUTER_API_KEY resolve identically). Confirmed by an independent `get`, not by the create response. THE PROMPT IS A BOOTSTRAP, NOT THE COMPILED PIPELINE, exactly as "Turning it on" recommends: it runs `dream-machine compile dream.config.json` at run time and executes THAT, so the cloud schedule can never drift from the committed config — a frozen 13.6k prompt would have pinned tonight's compilation into the scheduler forever. It carries the hard invariants inline (never merge; ACCEPT/REJECT/INCONCLUSIVE only; the ledger row is always written; measure against the repo's real evaluators; a guard that cannot fail is not a guard) so they hold even if compilation fails, in which case the night reports INCONCLUSIVE and says why rather than improvising a pipeline from memory. |
| 2026-08-19 (night 1) | **A night has now RUN. This document previously stated it may not claim that.** | The cycle executed 2026-08-19 09:29Z as a cloud routine (container path `/root/.cache/ruvnet-brain/kb` in its own report), took SLOT 4 — deep `memory-durability`, scans `managed-boundary` + `round-trip-proof` — and filed #142 with candidate PR #143. The finding is real and was verified independently rather than on the cycle's own red-green claim: removing the `NEVER_MATERIALIZED` branch from `classify()` turns its new test red with `expected 'WIPED' to be 'NEVER-MATERIALIZED'`. `restore-local-ingests.mjs` had ZERO test coverage before that night, and the repo's own dream-cycle notes told this automation to read any non-zero exit as 'the nightly bundle wiped local work' — so a routine fresh-checkout run would have logged a false wipe every night. `autoMerge: false` held: the machine proposed, a human evaluated and merged. OPERATIONAL NOTE for anyone reading LEDGER.md on main and finding it empty: the ledger row ships IN the candidate PR by design, so it only reaches main when the candidate is accepted — an empty ledger on main means 'nothing accepted yet', NOT 'nothing ran'. STILL NOT VERIFIABLE FROM THIS REPO: whether the routine RECURS. The schedule lives in the owner's Claude account; night 1 executing proves it fired once, not that it is nightly. | 
| 2026-08-19 | **The engine validation this ADR relies on was never running on Windows.** | Decision 1 says the config is validated by rUv's own engine — 'the only validation that counts'. `tests/unit/dream-config.test.mjs` invoked it with `execFileSync('npx', ...)`, and on Windows the binary is `npx.cmd` while execFileSync does no PATHEXT resolution, so both the `compile` and `ledger verify` checks threw ENOENT on that host — red for days inside a windows-unit failure that was itself unreadable, because a wedged sibling job blocked log access for the whole run. Fixing only the NAME moved the error to `spawnSync npx.cmd EINVAL`: since the CVE-2024-27980 hardening, Node refuses to exec a `.cmd` without a shell. Both fixes are needed, and a fix that only changes the error message is not a fix. The config itself was never at fault and is unchanged; what was broken is that one of its two graders was silently absent on one host. |
| 2026-08-19 | **Accepted as configured, not as running.** | `dream.config.json` committed and validated against `dream-machine@0.1.1` (version verified live on npm before writing this). Slots, evaluators and `autoMerge:false` are this repo's decisions, NOT the scaffold's defaults — the scaffold's generic `correctness/security/architecture/performance/developer-experience` were replaced with the five surfaces where this repo has demonstrably broken in the last week. The schedule is deliberately left to the owner: creating a cloud routine spends his account. |
