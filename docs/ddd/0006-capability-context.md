# DDD-0006 — The Capability bounded context

Updated: 2026-09-17 18:31:22 EDT | Version 1.0.1
Created: 2026-07-22

Governs **ADR-032** (the capability surface).

**Status**: Proposed (2026-07-22)

---

## Why this context exists separately from Advocacy

DDD-0004 owns the transformation *knowledge → offer*: Observation → Finding → Remedy → Dismissal. Its
core invariant is deliberately severe:

> **A Finding may not exist without a Remedy, and a Remedy may not exist without an inverse.**

That invariant is correct and must not be weakened. It is also the reason capability state cannot
live inside Advocacy. **If a capability's state could only exist as a Finding, then only the fixable
states would be expressible** — and the three states that matter most to an honest panel are the
three that are not fixable at all:

- `unknown` — we could not check. There is nothing to remedy; there is something to disclose.
- `absent` — you do not have it. Recommending an install is a *different* decision with a different
  consent bar.
- `on` — it is working. Most rows on a healthy machine, and by DDD-0004's rule they would all be
  silence.

A panel built inside Advocacy would render exactly the problems and nothing else, which is a
worry-list, not a capability surface. Worse, it would recreate the failure ADR-032 §2 documents: a
state that could not be expressed gets rounded to a state that can, and the user is told something
false. **Capability owns what is TRUE. Advocacy owns what is WORTH SAYING.** Two questions, two
lifecycles, two failure modes.

The dependency runs one way and only one way: **Advocacy depends on Capability. Capability does not
know Advocacy exists.**

---

## Ubiquitous language

| Term | Precise meaning (exactly one) | Explicitly NOT |
|---|---|---|
| **Capability** | A discrete RuvNet feature this user can have, identified by a stable id | a package, a hook, or a file — those are its artifacts |
| **Artifact** | The concrete thing on this machine a state is read FROM: a file path, a command's output, a config key | a description of that thing |
| **Probe** | One attempt to read one Artifact | the state it produced |
| **Derivation** | A completed Probe, bound to its Artifact, its result, and the time it ran | a cached value |
| **CapabilityState** | `on` \| `off` \| `unknown` \| `absent`. Closed set of four | a boolean, a percentage, a colour |
| **Evidence tier** | `direct` \| `indirect` \| `inferred` — how strongly the Artifact implies the State | a confidence score |
| **Provenance** | Artifact + tier + read time, carried by every State to the surface | a log line written elsewhere |
| **Benefit claim** | What turning it on buys THIS user, with its kind: `measured-here` \| `corpus-cited` \| `none` | marketing copy, a feature description |
| **Stale** | A Derivation older than the last modification of its Artifact | old |
| **Advocacy level** | `silent` \| `important` \| `all` — the user's interruption budget | a verbosity or detail setting |
| **Capability Panel** | The read surface listing every Capability with its State and Provenance | a dashboard, a health card |

### Terms that collide across contexts, named so they stop

- **Surface.** DDD-0005 defines it as *what a hook can observe at a trigger* (`tool` \| `text` \|
  `plan`). This context never uses the bare word. The read surface is the **Capability Panel**; the
  place a State is read from is an **Artifact**.
- **Dormant.** DDD-0004's word, and a **judgement**: installed + inactive + worth interrupting about.
  This context does not use it. Capability reports `off` with an install-state; whether that
  constitutes dormancy is Advocacy's ruling, not ours. Keeping the judgement out of the fact is what
  lets a user at `silent` still see the fact.
- **Observation.** DDD-0004's atom of measured truth. A Derivation is convertible to one at the
  boundary (§ACL), but a Derivation additionally carries tier and staleness, which Advocacy discards.

---

## The core invariant

> **No CapabilityState may exist without a Derivation, and no Derivation may exist without a named
> Artifact.**

The contrapositive is the useful half: **there is no code path that can produce a State from
nothing.** Not from a default, not from an `||` fallback, not from an absent key read as `false`.
A missing Artifact yields `unknown` with a reason — it never yields `off`, because `off` is a claim
about the machine and "I did not find the file" is a claim about the probe.

This is ADR-024's law ("re-derive from the verifiable artifact, never read a self-asserted field")
carried from job receipts into capability state, plus one addition ADR-024 did not need: **the
strength of the derivation travels with the value.** `scripts/onboarding-console.mjs:189` is the
proof that it must —

```js
return fs.existsSync(HOME + '/.claude/hooks/agentdb-ensure.sh') || fs.existsSync(HOME + '/.claude/hooks');
```

— a real read of a real path, producing an honest-looking `ok` on almost any machine on earth. Not a
fabrication. An `inferred` tier rendered as though it were `direct`, for long enough that nobody
re-examined it.

### The corollary that keeps the panel honest

**A Capability that could not be probed still appears.** Omission is not a permitted way to express
doubt, because an omitted row and an absent capability are indistinguishable to a reader. This is
DDD-0004's `unknown ≠ absent` invariant extended from the audit to the render, which is exactly where
it was being lost.

---

## Aggregates

### 1. Capability (root)

- **Invariant:** holds exactly one current `CapabilityState`, and that State is always reachable to
  its Provenance. A Capability with a State and no Provenance is unconstructible.
- **Invariant:** `state` and `installState` are independent axes and neither implies the other. Their
  divergence is the entire point (DDD-0004 said this of Capability; this context is where it is
  enforced structurally rather than described).
- **Invariant:** a Capability may carry at most one Benefit claim, and the claim's `kind` is
  mandatory. `kind: 'none'` is a real, declared value — the same discipline `UNDO_KINDS.NONE` uses in
  `scripts/remedy-registry.mjs`, and for the same reason: *"this genuinely has none"* and *"nobody
  wrote one"* must never look the same on screen.
- **Emits:** `CapabilityStateChanged`, `CapabilityProbeFailed`.

### 2. Derivation (value object, immutable)

- **Invariant:** names its Artifact, its tier, and its read time. All three or it does not construct.
- **Invariant:** a Probe that throws, times out, or returns unparseable output produces a Derivation
  with state `unknown` and a `reason` string — never an absent Derivation, and never `off`.
- **Invariant:** `tier: 'inferred'` requires a `caveat` string. Enforced at construction, mirroring
  `makeRecommendation()`'s `plainImpact` rule, so a weak check cannot be rendered as a strong one
  without deleting a visible gate.
- **Non-invariant, deliberately:** a Derivation may be stale. Staleness is reported, not corrected —
  a value object that silently re-reads is a cache pretending to be a fact.

### 3. CapabilitySnapshot

- **Invariant:** **complete.** Every Capability in the registry appears, including every `unknown`
  and every `absent`. A Snapshot that filters is malformed, not merely unhelpful.
- **Invariant:** carries its own `scannedAt`, and every Capability within it carries its own read
  time. One clock for the page and one per row, because a snapshot with a fresh timestamp over stale
  rows is the shape of the honest-looking lie.
- **Invariant:** the Snapshot is identical at every Advocacy level. The level cannot filter it. This
  is the structural expression of ADR-032's *interruption, never availability* rule — the setting
  lives in a different aggregate precisely so it has no reach into this one.

### 4. AdvocacyBudget

- **Invariant:** governs which severities may speak **unprompted**, and nothing else. It holds no
  reference to a Snapshot and cannot be passed one.
- **Invariant:** `silent` means silent — no badge, no dot, no residual count. A setting that is only
  mostly obeyed teaches the user their choices are advisory.
- **Invariant:** every change is reversible. The existing write path already satisfies this:
  `saveConfig()` (`scripts/onboarding-console.mjs:961`) takes a `0600` backup and journals a
  `restore-config` undo before writing. The budget is one more key in a schema that already survives
  ADR-027's reversal requirement.

### 5. DerivationLedger

- **Invariant:** append-only, and records the previous State alongside the new one. A bare current
  State cannot answer "did this change?", and without that question `CapabilityStateChanged` cannot
  be raised — which is the event the entire anti-nag rule is keyed to.
- **Rationale, from a failure already paid for:** ADR-027 could not distinguish a cliff from a drift
  because no baseline was persisted. The same absence would make "offered once per state change"
  degrade into "offered once per restart", which is a nag with extra steps.

---

## Domain events

| Event | Raised when | Consumed by |
|---|---|---|
| `CapabilityStateChanged(id, from, to, artifact, at)` | a Derivation differs from the ledger's last | Advocacy, DerivationLedger, Console |
| `CapabilityProbeFailed(id, artifact, reason)` | a Probe throws, times out, or cannot parse | Console (renders `unknown` + reason) |
| `DerivationStale(id, artifact, ageSeconds)` | Artifact mtime is newer than the Derivation | Console (marks the row), scheduler |
| `BenefitClaimUnsourced(id)` | a Benefit claim is constructed without a `kind` | **nothing — this throws.** Listed so the prohibition is visible in the event table rather than implied |
| `AdvocacyLevelChanged(from, to, undoToken)` | the user changes their budget | Console, DismissalLedger (DDD-0004) |

`CapabilityStateChanged` carries **both** States deliberately, for the same reason DDD-0004's
`HealthDegraded` does: `off` in isolation is ambiguous; `on → off` is a fact worth interrupting a
person about, and `unknown → off` is a probe that started working, which is not.

---

## The anti-corruption boundary against Advocacy (DDD-0004)

This is the boundary that matters, because the two contexts are adjacent, both talk about
capabilities, and collapsing them is the tempting move.

**Direction.** Advocacy imports from Capability. Capability imports nothing from Advocacy — not
`Finding`, not `Remedy`, not `Dismissal`, not `severity`. A `grep` for those terms inside this
context should return nothing, and that is a checkable property rather than a convention.

**The translation, stated exactly.** Advocacy consumes a Capability and may construct a Finding from
it. The mapping is Advocacy's to make and Capability never performs it:

| Capability emits | Advocacy may translate to | Advocacy must NOT translate to |
|---|---|---|
| `state: 'off'` + `installState: 'installed'` | `CapabilityFoundDormant` → a Finding | anything, if no Remedy exists for it |
| `state: 'unknown'` | **nothing.** Doubt is disclosed by the Panel, never advocated | a Finding — "I could not check" has no remedy |
| `state: 'absent'` | at most an `INFO` Finding, and only with a Remedy | an `IMPORTANT` — you cannot have a defect in something you never installed |
| `state: 'on'` | nothing | a congratulation. Silence is the correct response to working software |

**Why the boundary is drawn here and not one step over.** Capability findings today carry
`{id, title, severity, evidence[], why, detail}` (`scripts/capability-audit.mjs`) and no `cost`,
`change`, or `undo` — verified 2026-07-22 — so they cannot pass `makeRecommendation()`, which throws
on each. That is not an impedance mismatch to paper over with an adapter. It is the schema gate
correctly refusing an offer that has no executor behind it, exactly as it refused
`learning:enable-fleet` (`scripts/remedy-registry.mjs` header, failure #1). The ACL therefore does
**not** translate every Capability into a Finding; it translates the subset for which a Remedy with a
declared inverse is registered, and lets the rest render as information in the Panel.

**Enforcement.** `assertRegistryClosure()` already proves every constructible recommendation id
resolves to exactly one remedy with a real undo. Extending it to capability ids makes a
capability-with-a-button-and-no-executor a **CI failure** rather than a click that returns *"Unknown
recommendation id"* — which is what shipped twice before the registry existed.

---

## The anti-corruption layer against the machine

Every Artifact here belongs to somebody else — rUv's CLI, Anthropic's config files, launchd. All of
them drift.

- **Interfaces are grounded before use**, never guessed. The structured MCP CLI boundary gates this;
  the former verify-interface shell ID is silent compatibility only.
  DDD-0004 records a live case where a documented `--train-neural` flag did not exist in the
  installed build.
- **A non-zero exit is `unknown`, never `off`.** This inverts the usual shell instinct and is the
  single most important rule in this section. `ruflo hooks list` failing means the probe failed; it
  does not mean the hooks are disabled. Conflating the two is how a panel confidently reports the
  opposite of the truth on a machine where a binary moved.
- **Parsing is defensive and its failure is visible.** `detectDisabledLearningHooks()` parses an
  ASCII table by column position (`capability-audit.mjs:186-189`). That works today — verified live
  2026-07-22: 26 rows, `Enabled: No` on all 26 — and it will break the first time rUv changes the
  table. When it breaks it must yield `unknown`, loudly, not `enabled = 0` silently. A parse failure
  that happens to produce a plausible number is worse than a crash.
- **Subprocess probes never block first paint.** `ruflo hooks list` carries a 20-second timeout. A
  Capability whose probe is expensive is `unknown` on first render and updates when it completes;
  it is never awaited by the page.

---

## Boundaries — what this context does NOT own

- **It does not decide what to say.** Severity, urgency, and whether a state deserves interruption
  are Advocacy's (DDD-0004). This context has no severity field.
- **It does not own remedies.** `scripts/remedy-registry.mjs` holds seven keys today — none
  capability-related, verified 2026-07-22. Capability names a state; it never names a fix.
- **It does not own presentation.** DDD-0002 §8: the console renders, the domain decides. Colours,
  ordering, and copy live there — subject to the constraint that Provenance must reach the screen.
- **It does not own learning semantics.** What a lesson *is*, when it promotes, how it enforces —
  DDD-0005. This context can report that the lesson store holds twelve candidates and zero ratified;
  it may not rule on what that means for the agent's behaviour.
- **It does not implement any capability.** SONA, MoE, ReasoningBank, the `ruflo hooks` pipeline are
  rUv's. Detecting their state is the whole job. Rebuilding any of it is the substitution failure the
  project exists to prevent, and the standing order is explicit: if we disagree with RuvNet, RuvNet
  is right.
- **It does not prove reachability.** No local Artifact demonstrates that an MCP server is connected.
  Six are configured globally in `~/.claude.json` — `ruflo`, `ask-ruvnet`, `agent-browser-mcp`,
  `rulake`, `pi-brain`, `paste`, verified 2026-07-22 — and configured is the only word we have earned.
  Reachability is `unknown` and stays `unknown` until something on disk proves otherwise.

---

## Why this modelling and not the obvious alternatives

**"Just add an `enabled: boolean` to each thing."** Rejected — it is the disease. A boolean has no
room for "I could not check", so every gap rounds to `false` or, more often, to the reassuring
`true`. Three of the failures in ADR-032 are this exact shape, and none of them involved a fabricated
number: they involved a two-valued vocabulary describing a three-valued world.

**"Put capability state inside Advocacy — it's all one panel."** Rejected on the invariant. DDD-0004
forbids a Finding without a Remedy, correctly, and most capability states have no remedy. Under that
rule the panel could only render fixable problems: healthy rows and unknown rows would both become
silence, and a user could not distinguish "everything is fine" from "we checked nothing."

**"Show a confidence percentage."** Rejected — a number invites averaging, and there is no honest
arithmetic between "the CLI printed `Enabled: No`" and "a directory exists." Three named tiers with a
mandatory caveat on the weakest are checkable by a test; `0.62` is not.

**"Hide `unknown` rows to keep the panel clean."** Rejected hardest. It is the failure of ADR-032 §2
committed deliberately instead of accidentally: a user with twelve lessons was shown a confident zero
because a scope went unnamed. A clean panel that omits what it does not know is not clean. It is
quiet about the only thing the user cannot find out any other way.

---

## Known gaps in this model (honest as of 2026-07-22)

- **The `DismissalLedger` that this context's anti-nag rule depends on does not exist.** DDD-0004
  specifies it; `grep -rn "dismiss" scripts console` returns only `dismissStandby()`
  (`console/app.js:412`), a loading-spinner helper. Every dismissal claim in ADR-032 is therefore
  design intent.
- **The `DerivationLedger` does not exist either**, so `CapabilityStateChanged` cannot currently be
  raised by anything. Both ledgers are prerequisites, not follow-ups.
- **No Capability registry exists.** `capability-audit.mjs` has three detectors and zero call sites
  outside itself, verified 2026-07-22. This document describes a context whose aggregates are, today,
  entirely unbuilt — which is stated here rather than discovered later.
