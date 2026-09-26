---
id: ADR-061
title: Subscription-only dual-host deliberation for hard problems
status: Proposed
date: 2026-07-28
updated: 2026-09-18
version: 1.2.0
reviewed_digest: 0f78717de5a9
authors: [Stuart Kerr, GPT-5.6-Sol]
tags: [claude-code, codex, subscriptions, adr, ddd, agentic-qe, deliberation]
supersedes: []
relates: [ADR-035, ADR-051, ADR-053, ADR-055, ADR-058]
governs:
  - scripts/subscription-hosts.mjs
  - scripts/dual-host-deliberation.mjs
  - scripts/dual-deliberation-contract.mjs
  - scripts/dual-host-suggest.mjs
  - plugin/skills/ruvnet-brain/SKILL.md
  - tests/unit/subscription-hosts.test.mjs
  - tests/unit/dual-host-deliberation.test.mjs
  - tests/unit/dual-native-admission.test.mjs
  - tests/unit/subscription-routing-guidance.test.mjs
---

# ADR-061: Subscription-only dual-host deliberation

**Status**: Proposed

No acceptance is claimed; machine grading by two vendors and the remaining runtime checks are still required before acceptance.
**Date**: 2026-07-28

## Context

Claude Code and OpenAI Codex are both first-class RuvNet Brain hosts. When a developer has logged
into both through paid developer subscriptions, using only one on a hard problem omits a useful
separate perspective. Architecture, security boundaries, migrations, ADRs, DDDs and experience
quality are precisely where independent reasoning and adversarial reconciliation earn their cost.

The existing model router already records which subscription seats a user has. It does not
coordinate a debate, create an ADR/DDD pair, or make both hosts design the outcome-level Agentic-QE
plan. This decision adds that missing coordination without creating another model router.

“Subscription-only” means **no API-key or per-call API billing path**. It does not mean unlimited
capacity: runs consume each plan's allowance or credits. A valid login can still be quota-limited.

## Decision

### 1. One thin Node coordinator over the two installed CLIs

`dual-host-deliberation.mjs` invokes `claude` and `codex` directly with fixed argv arrays and sends
the complete stage prompt over stdin. It reuses the existing per-user subscription profile and does
not route through OpenRouter, an SDK or an API. The prompt is never placed in argv, so large
cross-critiques cannot hit per-argument limits or leak into process listings.

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

1. separate ADR + DDD + outcome-QE proposals;
2. parallel cross-critiques;
3. one deterministic scribe (selected from the task hash, so neither host is permanently senior);
4. the other host verifies the synthesis;
5. at most one bounded revision and re-verification.

Claude uses manual permissions with headless permission prompts denied, safe/restricted mode,
an empty strict MCP configuration, and only Read/Grep/Glob built-ins. Codex uses a read-only
sandbox and an ephemeral session, ignores user configuration, treats the reviewed root as
untrusted for project configuration, and disables apps, plugins, hooks, memories and automatic
AGENTS.md loading for that invocation. Subscription authentication remains available. Managed
administrator policy still applies; these flags do not claim to replace provider system prompts
or create an operating-system sandbox for Claude. The coordinator never enables a dangerous bypass.

`dual-deliberation-contract.mjs` owns the response contract for every stage. Both hosts receive
the same generated schema in the prompt; Claude additionally receives native `--json-schema`.
Codex's output is admitted by the same strict runtime boundary, not a decoder-schema claim.
Raw model output cannot provide adapter-owned hashes or execution metadata. Empty critique
findings, malformed corrections and undeclared fields fail before admission. Verification
acceptance requires no remaining corrections; requesting changes requires concrete corrections.

Stage identity hashes cover primary proposal, findings or artifact content. Full stage fields,
including corrections and ADR/DDD metadata, are bound separately by native evidence and causal
trace replay. A primary-content hash alone is not proof of the entire review conversation.

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
identity and full transcripts are not stored by default. Host completion remains `verified: false`;
only later adjudication may train routing. The coordinator returns a transport-neutral
`memory_store` request. An MCP-aware caller owns the write and exact-key read-back; when no
structured callback is available, the duel remains complete but reports `learningPersisted: false`
with the pending request instead of opening a second Ruflo memory driver.

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
| output fails schema | reject the stage; no fence stripping or silent reinterpretation |
| models disagree after bounded revision | return unresolved decisions |
| AgentDB unavailable | return result with `learningPersisted: false` |
| secret canary appears in output | discard output and raise a security finding |

## Verification required before acceptance

1. Claude Code and Codex perform machine grading by two vendors of this ADR and DDD-0014 from fresh contexts.
2. A real key-free dual run completes through both subscription CLIs.
3. Parent-environment sentinel keys are absent from both injected child environments.
4. Repository hash is identical before and after the run.
5. Claude-quota and Codex-capacity failures each produce an honest single-host result.
6. Windows, Linux and macOS argv/path tests pass.
7. Agentic-QE and the machine grading by two vendors approve the experience plan.

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

On 2026-08-10, **Re-read after #130/#131; subscription routing is unchanged.** Governed files moved for update-rail reasons only — rollback cardinality and symlink-guard scope. No provider path became implicit and opt-in remains explicit.

## Currency log

| 2026-09-18 | Replaced conflicting Claude plan-mode output with one canonical native-stage schema and strict raw-content admission; contained ambient client configuration and tools. Added process-boundary negative tests. Native critiques identified these weaknesses; acceptance of the complete ADR and product remains pending. | scripts/dual-deliberation-contract.mjs; scripts/dual-host-deliberation.mjs; tests/unit/dual-native-admission.test.mjs |

| 2026-09-17 | Re-read all 7 resolved governed entries against the current integration working tree: subscription eligibility, credential stripping, bounded stage protocol, schema validation, and the read-only test fixtures still match this Proposed decision. No two-host acceptance is claimed; machine grading by two vendors and runtime checks remain required. Source-bound review digest `0f78717de5a9`. | scripts/subscription-hosts.mjs; scripts/dual-host-deliberation.mjs; scripts/dual-host-suggest.mjs; tests/unit/subscription-hosts.test.mjs; tests/unit/dual-host-deliberation.test.mjs |

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-11 | Currency review at commit 7296c984: decision unchanged and re-pinned — subscription-only, two native CLIs. `scripts/dual-host-deliberation.mjs` +8/−1 since 7cfd9e17 (`32b7b7ca`, the pre-session worktree merge): the host models moved to an explicit `TOP_SUBSCRIPTION_MODELS` map (`claude-code` → `claude-fable-5-1`, `codex` → `gpt-6-astra`, replacing the literal `gpt-5.6-sol`), verified on the native hosts 2026-09-10; no API key, fetch or OpenRouter path was added. `tests/unit/dual-host-deliberation.test.mjs` +1. `plugin/skills/ruvnet-brain/SKILL.md` `60f269ad` (recommend-first contract). The TriSmart skill merged the same day (`tri-smart-skill/`, `scripts/trismart.mjs`) wraps this coordinator (`trismart.mjs:8` imports `dual-host-deliberation.mjs`); it does not replace it. `scripts/subscription-hosts.mjs`, `scripts/dual-host-suggest.mjs` did not move. | Reviewed `scripts/dual-host-deliberation.mjs`, `scripts/subscription-hosts.mjs`, `tests/unit/dual-host-deliberation.test.mjs`. reviewed_digest 6df53471296d. |
| 2026-08-19 | Codex wiring changed under this decision (gate routing + wrapper budget); the subscription-only posture is UNCHANGED — no host gained a metered path. Reinforced rather than eroded: `spend-guard` now refuses an agent fleet that would inherit ANTHROPIC_API_KEY / OPENAI_API_KEY on either host, after agentic-qe#557 billed $1,600 across ~374 headless agents while the Max subscription sat unused. `claude` and `codex` are the seats and are never blocked. |

## Generic implementation enforcement — 2026-09-17

Dual review and Dual implementation are different modes. A review may accept an analysis;
that result always has `verifiedOutcome: false` and grants no execution authority. Implementation
uses a reviewed brief supplied by the calling project. Objective names, source dispositions,
job scope, commands, expected output and completion predicates are plan inputs. Dual does not
hardcode RuvNet Brain, North Star, `main`, or a worktree count.

The canonical contract is `scripts/dual-workflow-contract.mjs`. The reviewed brief binds the
complete Git source inventory (tracked and non-ignored untracked files), file dispositions and
canonical owners, an objective document and acceptance criteria, and the checkout reconciliation.
The executable observer verifies those bytes before and after the debate. This establishes
source binding, not proof that a human or model understood every line.

The approved artifact contains ADR/DDD decisions, no unresolved questions, ordered jobs with
one owner per path, complete goal and deletion coverage, and bounded executable acceptance
checks. Each check specifies `expectedOutput` as well as its command, arguments and purpose;
a zero exit without that output is insufficient. Reviewers must assess whether these checks
actually prove the intended behavior. Neither process exit nor a matching string establishes
semantic correctness on its own.

`--implement --brief <file> <task>` validates preparation before spending model calls, runs the
existing bounded native debate, and activates an accepted plan in the canonical project AgentDB.
`--brief <file> <task>` prepares a replacement without activation. `--reapprove <result-file>`
explicitly replaces the active plan after renewed acceptance and resets all completion credit.
There is no silent scope expansion or automatic retry until agreement.

Workflow state is append-only in AgentDB's `dual-workflow` namespace, with immutable content
chunks in `dual-workflow-content` to avoid argv-size limits. A local exclusive transition lock,
chained event identities and exact read-back prevent two normal controllers from advancing
simultaneously. An interrupted lock fails closed; `--recover-lock` requires a proven exited local owner and refuses a live, reused, remote, or unverifiable owner. It never steals a lock on a timer. These records
are local controller evidence, not signed third-party attestations. A process with arbitrary
write access to AgentDB or the installed controller can tamper with them.

The execution preflight loads active state from AgentDB itself. Omitting the workflow from the
request cannot bypass it. An active job must be the next unfinished job, changes must stay within
its paths, and completed paths must still match their accepted bytes. `--verify-job <id>` runs
the exact approved checks against stable source, then appends acceptance. Failure stops the
sequence. `--complete` checks every job and the plan's live repository completion predicates.
A completed workflow refuses further implementation until another plan is approved.

### Enforcement boundary

These controls operate at Dual's CLI and `execution-preflight.mjs`. A project without an activated
workflow is explicitly reported as unmanaged. This is not a global restriction on every coding
session. Arbitrary shell/file tools that do not invoke the preflight remain outside this boundary.
No new parent-host interception, signed release proof, deployed product readiness, or bug-free
result is claimed. Native host hook registration and real denial proof remain separate work.

The installer preserves canonical relative imports under `dual-runtime/`, with thin stable CLI
entrypoints. Installed tests execute those entrypoints. Fixture tests use disposable repositories
and the real global Ruflo store; they do not call paid model APIs.

Lock publication uses an owner-bearing staging directory and atomic rename. A crash before rename
leaves an unused preparation directory, not a held lock. For legacy ownerless locks or interrupted
recovery, first stop all Dual controllers for that project, then run
`--recover-lock --controllers-stopped`. This is an explicit maintenance acknowledgement, never an
automatic fallback. It removes only empty ownerless lock directories or locally proven exited
owners; live/foreign/malformed owners and unknown nonempty directories are still refused. Normal
`--recover-lock` requires a locally proven exited owner. This is a local single-operator maintenance
procedure, not distributed lease recovery or a grant to override a running controller.
