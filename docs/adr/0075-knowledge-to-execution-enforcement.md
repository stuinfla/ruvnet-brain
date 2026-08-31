---
id: ADR-075
title: Knowledge-to-execution enforcement is a mandatory policy boundary
status: Accepted
date: 2026-08-30
updated: 2026-08-31
impl: partially implemented
authors: [Stuart Kerr, Codex]
tags: [architecture, enforcement, routing, swarms, adr, ddd, qa, release]
supersedes: []
relates: [ADR-009, ADR-012, ADR-020, ADR-034, ADR-055, ADR-061, ADR-067, ADR-070, ADR-072, ADR-074]
governs:
  - plugin/skills/ruvnet-brain/SKILL.md
  - plugin/skills/ruvnet-brain/PLAYBOOK.md
  - plugin/hooks/hooks.json
  - plugin/hooks/codex-hooks.json
  - plugin/scripts/ground-ruvnet.sh
  - plugin/scripts/ground-before-write.sh
  - plugin/scripts/route-dispatch.sh
  - plugin/scripts/decision-gate.mjs
  - scripts/qa-runner.mjs
  - bin/install.mjs
  - scripts/doc-currency.mjs
  - scripts/convergence-manifest.mjs
  - docs/ddd/0017-release-convergence-context.md
  - tests/unit/execution-policy.test.mjs
  - tests/integration/execution-policy.test.mjs
---

# ADR-075 — Knowledge-to-execution enforcement is a mandatory policy boundary

**Status**: Accepted (2026-08-30)

## Context

RuvNet Brain exists to turn current RuvNet knowledge, project decisions, and user constraints
into correct development behavior. The current repository contains the right instructions, but
they are not all executable obligations. A live audit exposed the failure mode: the Brain knew
that Ruflo coordinates while native Claude/Codex subscription agents execute, yet a caller could
still select Ruflo's API-backed `agent_execute` endpoint. The guidance was correct; the action
selection was not bound to it.

This is not solved by adding more prompt text. The system currently has several distinct layers:

| Area | Current behavior | Failure exposed |
|---|---|---|
| Source grounding | Retrieves and cites source for recognized RuvNet questions | Retrieval does not create an action precondition |
| Host routing | `route-dispatch.sh` records dispatches | It is advisory because some hosts consume the result after dispatch |
| Swarm use | Skills recommend parallel Ruflo swarms | No deterministic rule classifies when a swarm is required |
| Provider choice | ADR-061 documents native subscription execution | No single preflight binds a registered role to that executor |
| ADR currency | `doc-currency.mjs` detects governed-file drift | DDDs lack equivalent machine-readable lifecycle metadata; semantic agreement remains manual |
| QA | `qa-runner.mjs` provides PR/release lanes | The architecture-to-test graph is split across scripts and workflows |

The consequence is a knowledge/behavior split: a capable host can know the correct rule and still
take a different path. That is precisely the class of failure this product must eliminate.

## Decision

Create one executable `ExecutionPolicy` boundary shared by hooks, CLI orchestration, and release
receipts. It does not replace Ruflo, host CLIs, or the existing gates. It decides whether an
action is eligible and which existing executor is allowed.

### 1. Every consequential action receives a policy decision

The policy classifies actions as `read`, `write`, `delegate`, `release`, or `external`. It records
the task fingerprint, source-grounding receipt, project memory recall status, selected host,
executor, swarm requirement, ADR/DDD scope, and QA lane. Missing required evidence yields
`UNKNOWN` or `REFUSE`; it never silently becomes an allow.

### 2. Delegation is host-aware and spend-safe

For ordinary swarm work, Ruflo `swarm_init` and `agent_spawn` remain the coordination ledger.
Execution must use the active host's native subscription executor: Claude Code Task or Codex
collaboration agents. `agent_execute`, SDK/API calls, and OpenRouter are provider-backed paths
and require explicit metered-spend authorization. Grok remains unsupported until an equivalent
host adapter and final-answer boundary exist.

The policy must refuse an API-backed executor when a native host is available but was not selected,
and must refuse a native claim when no native host is actually authenticated. It must expose the
reason and the allowed next executor in a machine-readable receipt.

### 3. Parallelizable development defaults to a Ruflo swarm

The policy marks a task `swarm-required` when it has independent workstreams, crosses three or
more files, changes architecture/QA/release behavior, or explicitly requests a swarm. A task may
be `single-agent` only when the policy records a deterministic reason such as one-file sequential
work or a host capability limitation. The decision is auditable; it is not a prose suggestion.

### 4. ADR and DDD state is part of the action precondition

Every action touching governed code must resolve the governing ADR/DDD set before execution. Each
document must have machine-readable status, date, updated, implementation state, and governed
paths. A governed code change without a same-change reconciliation receipt is refused at the
earliest available boundary. Superseded decisions remain historical but cannot continue to govern
active code. Unbuilt decisions remain explicit and cannot be reported as implemented.

### 5. Architecture decisions require a live dual-seat adversarial review

Any new or materially changed ADR/DDD must first have a source-research receipt, then two
independent adversarial reviews: one from the current authenticated Anthropic/Claude seat and one
from the current authenticated OpenAI/Codex seat. The system resolves the best available model on
each seat at run time and records the exact model IDs, dates, source inputs, disagreements, and
final synthesis. Names such as “Fable 5” or “GPT-5.6-Sol” are historical labels, not permanent
configuration.

If only one seat is available, the result is `DEGRADED` and may inform implementation but cannot be
represented as a completed dual review. A provider API call is never substituted for a native seat
without explicit metered-spend authorization. The final ADR must distinguish research evidence,
adversarial objections, synthesized decision, and unresolved disagreement.

### 6. QA is generated from the same policy inventory

The canonical QA runner owns the release graph. Every test directory and workflow must declare
whether it is required, conditional, manual, held, or retired, with a reason and an owner. A test
that is present but absent from the graph is a failure; a test that is intentionally not required
must be represented as an explicit non-pass state. PR and release lanes may differ in cost, but
the release receipt must enumerate every omitted lane and why it is not release-blocking.

### 7. Receipts are the durable bridge between knowing and doing

The policy decision, source-grounding identity, memory recall key, executor, test evidence, and
result are appended to the project AgentDB memory and bound to the source identity manifest.
Receipts are evidence, not authority: publication still requires the protected release workflow.

### 8. One published generation is the only version presented as current

The published npm/GitHub release is the canonical generation. Host plugin caches, the Stable Spine,
MCP runtime, status markers, and user-facing version claims must converge to that exact version; a
development checkout is an explicit, temporary exception and must never be presented as the
published current version. A missing optional KB asset may degrade knowledge refresh, but it may not
strand executable host behavior on an older generation. The updater must report the degraded KB
plane and continue the executable host-sync transaction, while the release gate keeps publication
red until all required assets exist.

## Failure semantics

- Missing source grounding for a RuvNet-shaped consequential action: `UNKNOWN`/refuse before write.
- API-backed executor selected for ordinary native-host work: `REFUSE` with native route.
- Parallelizable task without a swarm decision: `REFUSE` until classified.
- ADR/DDD governed code moved without reconciliation: `REFUSE` at edit or push, whichever is first.
- Test outside the QA graph: `FAIL` in canonical QA.
- Native host unavailable: `DEGRADED`, never an invented provider or fake agent result.
- Policy implementation unavailable: preserve the existing safe hook behavior and emit a diagnostic;
  never claim enforcement that did not run.

## Acceptance criteria

1. A fixture that requests a Ruflo swarm with authenticated native Claude/Codex state produces a
   `swarm-required` decision and names the native executor; selecting API-backed `agent_execute`
   produces a refusal without making a provider call.
2. A three-file architecture task, a one-file sequential fix, and an explicit swarm request each
   produce deterministic decisions with reasons and no prompt interpretation.
3. Mutating a governed ADR, DDD, or source file without its reconciliation receipt makes the
   earliest available gate fail and identifies the exact document/path pair.
4. The QA inventory detects a newly added test file and a newly added workflow that are absent
   from the canonical graph; intentional manual/held/retired entries remain visible and non-green.
5. Packed Claude and Codex hook paths preserve the same policy decision and receipt shape; an
   unsupported host is reported as unsupported rather than silently treated as native.
6. A complete policy receipt round-trips through the project `.swarm/memory.db` at the exact path
   and binds to the convergence manifest source identity.
7. A changed ADR/DDD cannot receive a `dual-review-complete` receipt unless both native seats
   produced independently identifiable review outputs from the same source-research input; a
   one-seat or provider-backed run is visibly `DEGRADED`.
8. A host-only update with a missing KB asset still converges the executable plugin/spine to the
   exact published npm version, records `kb-refresh: DEGRADED`, and never reports the older active
   version as current.

## Current implementation status

`Accepted, partially implemented.` The deterministic execution classifier and the enforced live-evidence
preflight are implemented and in the canonical contract lane, and host-only update now has a defined degraded-KB path that can still converge
the executable plugin/spine. Existing grounding, currency, wiring, convergence, and release gates
remain active. The cross-host dispatch, ADR/DDD reconciliation receipt, dual-seat receipt, and
architecture-to-test graph remain unbuilt until their acceptance criteria pass on both supported
host paths.

## Currency log
| 2026-08-31 | Added the executable preflight: consequential delegation now requires fresh successful Brain grounding plus an exact append-only project AgentDB checkpoint receipt before routing, and API-backed execution remains refused when a native host is available. | `scripts/execution-preflight.mjs`; `scripts/execution-policy.mjs`; `tests/unit/execution-preflight.test.mjs`; canonical contract lane. |
| 2026-08-31 | Reconciled after the canonical QA runner changed from serial fail-fast execution to concurrent independent-lane collection. | `scripts/qa-runner.mjs` now preserves this ADR's enforcement boundary while ensuring one failed lane cannot hide later policy failures; `tests/unit/qa-runner-concurrency.test.mjs` locks that behavior. |


| 2026-08-30 | Created after a live audit showed that correct Brain guidance could still be bypassed by selecting Ruflo's API-backed executor instead of the native subscription executor. | `plugin/skills/ruvnet-brain/SKILL.md`, `docs/adr/0061-subscription-only-dual-host-deliberation.md`, `plugin/scripts/route-dispatch.sh`, and the failed Ruflo execution receipt in the session record. |
