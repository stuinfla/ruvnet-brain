---
id: ADR-068
title: The Dream Machine runs this repo's nights — evaluation is not promotion
status: Accepted
date: 2026-08-19
updated: 2026-08-19
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

Accepted 2026-08-19. The config is committed and validated; the nightly schedule is a separate,
human-performed step (see **Turning it on**), because creating a cloud routine spends the owner's
account and is his to authorize.

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

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-19 | **Accepted as configured, not as running.** | `dream.config.json` committed and validated against `dream-machine@0.1.1` (version verified live on npm before writing this). Slots, evaluators and `autoMerge:false` are this repo's decisions, NOT the scaffold's defaults — the scaffold's generic `correctness/security/architecture/performance/developer-experience` were replaced with the five surfaces where this repo has demonstrably broken in the last week. The schedule is deliberately left to the owner: creating a cloud routine spends his account. |
