---
id: ADR-027
title: The brain advocates, it does not wait — capability advocacy + the death of passive signals
status: Proposed
date: 2026-07-21
updated: 2026-08-01
authors: [Stuart Kerr, Claude Code]
tags: [strategy, learning, proactivity, agentdb, sona, reasoningbank, console, health]
supersedes: []
relates: [ADR-0013, ADR-0023, ADR-0024, ADR-0025]
---

**Status**: Proposed (2026-07-21)

Governed DDD: `docs/ddd/0004-advocacy-context.md`

## The failure that forced this

For **three weeks**, RuvNet Brain had indexed 69 of rUv's repositories — including `agentic-flow`'s
ReasoningBank, `ruflo`'s SONA/MoE intelligence layer, the 4-step RETRIEVE → JUDGE → DISTILL →
CONSOLIDATE pipeline, and the `ruflo-intelligence` plugin that wraps 29 intelligence MCP tools.

It could have *answered* any question about any of them. It never once *said*:

> "Your learning system is installed and switched off. Turn it on."

The owner discovered it himself, on 2026-07-21, and measured the cost: the learner had **5
trajectories and 7 patterns, last trained six days earlier**, while **1,884 captured events** sat
undelivered in a queue. Draining it took the learner to **412 trajectories / 412 patterns** in one
command. Three weeks of learning had been available for the asking and never asked for.

His verdict, recorded verbatim because it is the design input: *"That is the most obvious active
piece of intelligence you could have given me."*

## The strategic error underneath it

**We built a search box and called it a brain.**

rUv's problem is not that his work is undocumented. It is that it is **undiscovered**. His own
`ruflo-intelligence` README calls cross-project IPFS pattern transfer *"the substrate plugin's most
underused capability."* The author knows people cannot find what he built. Dozens of genuinely
powerful technologies inside RuVector are effectively invisible to the people who already have them
installed.

**Closing that gap is the product.** Retrieval is a means. A brain that waits to be asked is a
search box with good manners; a brain that says *"you own X, it is off, here is what turning it on
buys you, shall I?"* is the thing worth having on your shoulder.

## The mechanical error underneath THAT

Every signal this system produces is **passive**. Reviewed across 2026-07-20/21, the pattern is
exact and repeats without variation:

| Signal | Encoded as | Result |
|---|---|---|
| ADR status (Proposed vs Accepted) | prose in a response | model read past it; design intent relayed as fact |
| Proactivity | prompt text in a session hook | model reasoned past it, articulately |
| Retrieval confidence | result formatting | thin evidence read as "nothing exists" → hand-rolling |
| Store integrity | a console card | corruption sat unfixed until the owner noticed |
| Learning | a CLI nobody runs | 1,884 events queued, learner idle six days |

Against that, the signals encoded as **gates** — `ground-before-write`, `verify-interface`,
`pre-push` — were obeyed **100% of the time**, including three occasions in one session where they
stopped this author from hand-rolling a tool rUv already ships.

**The conclusion is not subtle: knowledge that does not interrupt does not act.**

## Decision

### 1. Capability advocacy becomes a first-class product surface

The brain audits the user's machine for RuvNet capability that is **installed but dormant** and
recommends it, unprompted. Dormant-but-installed is classified as a **defect**, never a neutral
state.

The audit is grounded in what is actually on the machine — never a hardcoded list of "cool
features," which would rot within a week of rUv shipping.

### 2. Detection without a remedy is prohibited

Any surface that can detect a problem MUST be able to offer a fix. Concretely: every health
dimension that can report `fail` must have a corresponding recommendation with an executor behind
it. A card that worries someone is not a button that fixes it.

This is enforced structurally — recommendations are constructed through
`console-engine.makeRecommendation()`, which **throws** on any recommendation lacking evidence,
cost, an undo, and (when it touches the machine) a plain-English impact statement.

### 3. Signals become active

Anything load-bearing moves out of prose and into a gate, a recommendation, or an alarm:

- **Memory/store corruption** joins the GONG path already used for retrieval outage — the same
  loud, in-band, unmissable treatment. Silent integrity failure is unacceptable.
- **Score deltas alarm, not just scores.** A fall from 100 → 49 must be its own signal; without a
  persisted baseline, a cliff and a drift look identical.
- **The learning flush runs on a heartbeat**, not only on a clean `SessionEnd`. A queue that drains
  only on graceful exit will always leak, because sessions compact, crash, and resume.

### 4. We turn rUv's systems ON; we never rebuild them

The learning architecture is not ours to write. `ruflo hooks pre-task/post-task/post-edit/
post-command`, SONA, MoE, ReasoningBank, and `agentdb_consolidate` already exist and work — proven
live this session. Our job is wiring, surfacing, and advocacy. Where rUv ships a discoverable
surface (`ruflo-intelligence`, 29 tools behind `/intelligence` and `/neural`), we **recommend and
install it** rather than building a worse parallel.

### 5. When we disagree with RuvNet, RuvNet is right

**If our instinct disagrees with how RuvNet does something, the disagreement is evidence we have not
found the tool yet — not evidence the tool is wrong.** The required response is to go find the
RuvNet tool that implements it: search the corpus, **read the crate, not the ADR**, and only then
form an opinion.

This exists because the opposite has cost full days, repeatedly: a hand-rolled AgentDB capture hook
while ADR-174's distill pipeline shipped the real design; a fake "MetaHarness router" while
`@metaharness/router` sat on npm; and on 2026-07-21, three lines into hand-rolling a proxy health
check before the `ground-before-write` gate stopped it and `ruflo doctor --component proxy` turned
out to already do all of it. The failure mode is always the same shape — quietly building a worse
version of something that exists, giving it rUv's tool's name, and hiding that it is a hand-roll.

This is **not** "rUv is infallible." Real defects exist and finding them is valuable — the same day,
this project found and reported a genuine macOS bug in `@claude-flow/security`'s `PathValidator`
that breaks `ruflo proxy install` for every Mac user. The rule governs **disposition and sequence**:
look first, assume we are the ones missing context, and never let a disagreement become a silent
reimplementation. If we still disagree after genuinely looking, we say so out loud, cite the exact
source path, and name the hand-roll as a hand-roll.

Enforced by the `ground-before-write` gate rather than by intention.

### 6. Every ADR carries a DDD, and both get attacked

An ADR ships with an accompanying DDD (bounded context, ubiquitous language, invariants), and both
are subjected to adversarial review before acceptance — to establish the design is *optimal*, not
merely workable. Cross-model attack (Claude vs GPT-5.6) is the standing mechanism; tonight it found
defects three Claude reviewers missed.

## The proof case (why this is worth building)

**John O'Hare, 2026-07-21.** A technically excellent engineer running RuVector via a docker sidecar,
self-assessed at *~20%* utilisation. He was handed **one question** to ask his AI — *"give me the
five most differentiated and valuable features of ruvector as a markdown table."*

His response, hours apart:

> *"this is a new way for me to even try to attempt that — which is further than I was before"*
>
> *"been trying to land this upgrade for MONTHS and you unlocked it with one question,,, amazing"*

He shipped a mesh-verified upgrade plan the same day. **He was never blocked by skill.** He was
blocked by not knowing which question to ask — and the only reason anyone knew the question is that
someone else had been lost in the same place first.

**Knowing the question is the scarce resource.** Not intelligence, not documentation, not access.

### The standard this sets

> A developer who solves a hard problem with this tool, and *later* discovers they already owned a
> capability that would have made it trivial, is a **failure of this project** — not of the user.

### The constraint that keeps it honest

**This is goal-aware capability matching, not evangelism.** The job is *not* to push RuvNet
technology into every situation. It is to notice what the person is actually trying to accomplish,
know the stack well enough to identify which parts genuinely serve *that* goal, and offer those.

Recommending rUv tech to someone whose problem it does not fit is the same failure in the opposite
direction — and it is the faster way to destroy trust, because it is indistinguishable from
salesmanship.

The form is always an offer, never a demand: *"Here's something I noticed. Is that something you'd
like me to pursue?"* They do not have to act on it. They do have to **know**.

### Why it stays invisible without this

Users cannot see what is on. In the owner's words: *"a ton of people don't know what is or isn't
turned on because it's very much a black box."* Measured on his own machine the same day: **208
AgentDB stores, 156 with zero learns, 87 holding 154,106 memories while learning nothing.** The
console had `patterns` and `learns` on every fleet entry the entire time and never said the sentence.

## Constraints and honesty

- **Advocacy must not become nagging.** A recommendation is offered once per state change, is
  dismissible, and never re-fires while dismissed. The nudge principle governs: correct, clear,
  confident, deferential, never pushy.
- **No fabricated capability claims.** The audit reports only what it observed on this machine.
  Recommending a capability the user does not have installed is the same lie as any other.
- **Two learner stores exist and disagree** — the project-local `.claude-flow/neural` and the global
  `~/.claude-flow/neural`. rUv documents this as issue #2245 ("four contradictory sources"). Until
  it is unified upstream, the console MUST read the store that learning actually writes, or state
  plainly that both exist. This ADR does not pretend to fix rUv's fragmentation; it refuses to
  report a corpse as your brain.

## Consequences

- The console gains health/learning recommendations with real executors (`scripts/health-repair.mjs`).
- The capture queue drains on a heartbeat; the learner stops starving.
- New failure mode to watch: advocacy that fires too often becomes noise, and noise is how a real
  alarm gets ignored. Dismissal state is therefore part of the design, not an afterthought.

## Implementation status (updated 2026-07-22, v3.5.0-dev)

**Still Proposed, and the reason is one sentence: the engine is built and it does not render.**

Landed in 3.5.0-dev:

- **Fleet discovery convergence (issue #81)** makes the North Star executor consume
  `memory-doctor.mjs`'s shared no-argument machine-wide discovery policy. An explicit `--root`
  remains scoped, while an unscoped repair includes common roots, configured roots, and the known
  `~/.claude` store instead of rebuilding an incomplete root list inside `health-repair.mjs`.

- **The Remedy Registry** (`scripts/remedy-registry.mjs`) makes principle 2 structural rather than
  aspirational. Building it exposed that the prohibition was already being violated by the code that
  declared it: `learning:enable-fleet` — this ADR's own North Star recommendation — was constructed,
  schema-validated, and offered with **no executor at all**, and `repair:memory-index` promised an
  undo the console had no branch for. Detection without a remedy was not a risk to guard against; it
  had already shipped twice. A closure test now proves every offerable id resolves to exactly one
  runnable remedy with a real inverse, and was verified to fail on both known-bad cases.
- **A real executor for the North Star case**, wired to rUv's ADR-174 distillation
  (`ruflo memory distill run`) rather than anything of ours — the remedy `memory-doctor.mjs` had been
  printing in plain text since the day it was written while the console stayed silent about it.
  Proven on a real 1,250-entry store: repair → 1250 rows intact → distill → 0 to 507 patterns,
  507 episodes, 495 causal edges, then undo → back to 0.
- **Principle 3, partially**: `--distill-fleet` refuses corrupt stores and names them, so repair is
  correctly ordered before learning.

NOT landed, and this is what keeps it Proposed:

- **Recommendations are not rendered anywhere.** `buildHealthRecommendations()` is reachable only
  from `apply()`. Every claim in this document about the brain *advocating* is therefore still
  design intent: a user opening the console sees the same surface they saw before this ADR existed.
  The thesis is unshipped. Verification items 2, 3 and 4 below cannot pass until this changes.
- **Score-delta alarms** (principle 3, second bullet) are not built — there is still no persisted
  baseline, so a cliff and a drift remain indistinguishable.
- **The adversarial review (verification item 5) has not been recorded.** A cross-model hostile
  review was started on 2026-07-21 and was killed before returning a verdict. This ADR has therefore
  NOT met its own standing requirement that an ADR and its DDD be attacked before acceptance
  (principle 6), and it may not move to Accepted until that runs and its findings are written down —
  including anything it defeats.

Version note: this work is **3.5.0-dev**, a minor. It adds a subsystem and new capability; it is not
a patch, and the six commits that introduced it were all mislabelled `fix(...)` at patch level with
no version bump at all — caught by the owner, not by us, which is itself a miss of the standing rule
that any behaviour-changing push bumps the version in the same commit. It is deliberately NOT 4.0.0:
a major marks the release where the product becomes a different thing to the person using it, and
until advocacy renders, it is not.

## Verification (what must be true before this is Accepted)

1. A corrupt store produces a recommendation with a working one-click repair — proven on a real
   store, with row counts before and after.
2. A machine with a healthy store and a live learner produces **no** recommendations (no false
   alarms).
3. A dormant capability on a real machine produces a real recommendation naming it.
4. A score drop from a persisted baseline fires an alarm, demonstrated on known-bad input.
5. The adversarial review of this ADR and its DDD is recorded, including anything it defeated.
