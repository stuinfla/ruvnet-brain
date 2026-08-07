---
id: ADR-061
title: Subscription-only dual-host deliberation for hard problems
status: Proposed
date: 2026-07-28
updated: 2026-08-01
authors: [Stuart Kerr, GPT-5.6-Sol]
tags: [claude-code, codex, subscriptions, adr, ddd, agentic-qe, deliberation]
supersedes: []
relates: [ADR-035, ADR-051, ADR-053, ADR-055, ADR-058]
governs:
  - scripts/subscription-hosts.mjs
  - scripts/dual-host-deliberation.mjs
  - scripts/dual-host-suggest.mjs
  - plugin/skills/ruvnet-brain/SKILL.md
  - tests/unit/subscription-hosts.test.mjs
  - tests/unit/dual-host-deliberation.test.mjs
  - tests/unit/subscription-routing-guidance.test.mjs
---

# ADR-061: Subscription-only dual-host deliberation

**Status**: Proposed

Codex review is complete; Claude review is still required before acceptance.
**Date**: 2026-07-28

## Context

Claude Code and OpenAI Codex are both first-class RuvNet Brain hosts. When a developer has logged
into both through paid developer subscriptions, using only one on a hard problem wastes a useful
independent perspective. Architecture, security boundaries, migrations, ADRs, DDDs and experience
quality are precisely where independent reasoning and adversarial reconciliation earn their cost.

The existing model router already records which subscription seats a user has. It does not
coordinate a debate, create an ADR/DDD pair, or make both hosts design the outcome-level Agentic-QE
plan. This decision adds that missing coordination without creating another model router.

“Subscription-only” means **no API-key or per-call API billing path**. It does not mean unlimited
capacity: runs consume each plan's allowance or credits. A valid login can still be quota-limited.

## Decision

### 1. One thin Node coordinator over the two installed CLIs

`dual-host-deliberation.mjs` invokes `claude` and `codex` directly with argv arrays. It reuses the
existing per-user subscription profile and does not route through OpenRouter, an SDK or an API.

### 2. Public auth probes, then a real capacity result

- Claude is eligible only when `claude auth status --json` reports `loggedIn: true`,
  `authMethod: "claude.ai"` and a subscription type.
- Codex is eligible only when `codex login status` reports a ChatGPT login.
- CLI presence, an auth-file token shape and user assertion alone are not sufficient.
- A model run that reports quota/capacity exhaustion changes the run to `degraded`; it never causes
  an API fallback.

The profile may cache these classifications, but the coordinator rechecks the public CLI surface
before a duel because billing posture is load-bearing.

### 3. API credentials cannot reach a child

Every provider API-key variable is deleted from the child environment. Tests seed sentinel values
and inspect the injected runner's exact environment. The coordinator never reads, logs or stores
credential values.

### 4. Read-only, bounded debate

Both hosts receive the same task and repository root:

1. independent ADR + DDD + outcome-QE proposals;
2. parallel cross-critiques;
3. one deterministic scribe (selected from the task hash, so neither host is permanently senior);
4. the other host verifies the synthesis;
5. at most one bounded revision and re-verification.

Claude runs in plan mode with read-only tools. Codex runs with a read-only sandbox and an ephemeral
session. The coordinator never enables a dangerous bypass.

The result is `accepted` only when both hosts ran and the verifier accepted the synthesis. One host
still produces a useful `degraded` draft, but the product must not call it a duel or accepted ADR.

### 5. QE means intended experience, not process survival

Every synthesis contains:

- the North Star outcome in user language;
- low/unit, medium/integration and high/end-to-end technical tests;
- numeric thresholds;
- independent qualitative grading;
- negative and degraded-world scenarios;
- mutation tests proving the oracles can fail;
- an Agentic-QE generation/execution plan.

Agentic-QE is the generator and adversarial fleet. Deterministic auth, environment, read-only and
schema gates remain first-party release blockers.

### 6. Consent and non-nagging

Authentication is not consent. Product modes are:

- `off`;
- `suggest` (default): offer once per task/repository/auth-state tuple;
- `auto-readonly`: explicit opt-in to run the bounded read-only protocol automatically.

The suggestion states that source evidence goes to both Anthropic and OpenAI, consumes subscription
allowance, strips API keys and cannot edit the repository. Dismissal is durable.

### 7. Learning stores outcomes, not transcripts

The project `.swarm/memory.db` is the only structured store. Append-only AgentDB rows record task
hash, evidence hash, host/model categories, accepted decision identifiers, unresolved findings, QE
plan identifiers and later independently verified outcomes. Raw prompts, source, host account
identity and full transcripts are not stored by default. Host completion remains
`verified: false`; only later adjudication may train routing.

### 8. Ruflo coordinates; native subscription agents execute

For ordinary swarm work, Ruflo's `swarm_init` and `agent_spawn` establish coordination and tracked
roles. They do not authorize a provider-billed executor. Actual work runs through the active host's
native subscription execution surface: Claude Code's Task tool or Codex collaboration agents.

Provider-backed execution, including `agent_execute`, an SDK/API call, or OpenRouter, requires the
user's explicit opt-in for that task. It is never an automatic fallback when a subscription is
missing, logged out, quota-limited or temporarily unavailable, and routine swarm setup never asks
the user for a provider API key.

## Failure contract

| Failure | Result |
|---|---|
| API key exists in parent environment | strip it before probe and launch |
| auth output changes or is malformed | host is `unknown` and ineligible |
| one subscription is quota-limited | preserve work and return `degraded` |
| both subscriptions unavailable | fail with one actionable login message |
| source changes during the run | invalidate convergence |
| output fails schema | one repair attempt on the same host, then partial |
| models disagree after bounded revision | return unresolved decisions |
| AgentDB unavailable | return result with `learningPersisted: false` |
| secret canary appears in output | discard output and raise a security finding |

## Verification required before acceptance

1. Claude Code and Codex independently review this ADR and DDD-0014 from fresh contexts.
2. A real key-free dual run completes through both subscription CLIs.
3. Parent-environment sentinel keys are absent from both injected child environments.
4. Repository hash is identical before and after the run.
5. Claude-quota and Codex-capacity failures each produce an honest single-host result.
6. Windows, Linux and macOS argv/path tests pass.
7. Agentic-QE and an independent human-readable grader approve the experience plan.

## Review record

On 2026-07-28, Codex 0.145.0 / GPT-5.6-Sol produced the initial source-grounded design through a
ChatGPT subscription with provider API-key variables removed. Claude Code 2.1.220 reported a valid
Max `claude.ai` subscription, but the real model call hit its weekly limit. That is evidence for the
degraded-mode requirement, not a two-sided acceptance. This ADR stays Proposed until Claude
completes the missing side.

On 2026-08-01, the shipped RuvNet Brain skill's executor guidance was reconciled with this ADR:
Ruflo coordination now leads to native Claude Code or Codex subscription execution by default,
while every provider-backed path is explicit opt-in only. A structural regression test protects
that boundary. This documentation repair does not satisfy the outstanding two-host acceptance
requirements, so the ADR remains Proposed.

On 2026-08-07, the governed code was re-read after `scripts/subscription-hosts.mjs` moved; the
decision is unchanged and the ADR stays **Proposed**. The change is two lines in the Codex
subscription probe: auth status is now read from `stdout` AND `stderr` combined, and the match
anchors on line boundaries rather than the whole string. Codex prints `Logged in using ChatGPT`
to stderr, so the previous stdout-only, whole-string test reported a genuinely subscribed host as
unsubscribed — which would silently route a subscription-only deliberation onto a provider-backed
path, the exact outcome this ADR forbids. Detecting the subscription correctly strengthens the
boundary rather than relaxing it: no provider-backed path became implicit, and opt-in remains
explicit. The outstanding two-host acceptance requirement is untouched by this repair.
