# DDD — The Onboarding Console

Updated: 2026-08-02
Created: 2026-07-14

> **Status: Implemented (2026-07-14).** Contexts 1 (Stack Inventory), 2 (Wiring Survey), 4
> (Recommendation — pure, schema-enforced), 5 (Change Plan — the only writer, re-reads before write),
> 6 (Memory Health — `notTested[]` excluded from the score) and 8 (Presentation) ship in
> `scripts/console-engine.mjs`, `scripts/onboarding-console.mjs`, and `console/`. Amendment from
> implementation: every machine-touching Recommendation also carries a plain-English `plainImpact`
> (ADR-013 principle 6). Contexts 3 (Operator Profile) and 7 (Savings Ledger) ship in their thin form
> (config + receipts-only) and grow as more is measured.

Companion to **ADR-0013**. Where the ADR states the policy, this states the *structure* that makes
the policy unbreakable. Anywhere below that a rule is enforced by an invariant rather than by a
convention, that is deliberate: **we have already proven that advisory rules do not hold** — the
`!=` version comparison survived in three files despite everyone "knowing" the rule.

---

## The ubiquitous language

| Term | Means | Does NOT mean |
|---|---|---|
| **Observation** | A fact read from the machine, with its source path | An opinion |
| **Drift** | Installed ≠ what policy says should be installed, **in the behind direction** | Any difference (AHEAD is legal) |
| **Shadow** | A second copy of a stack package that can preempt the canonical one | A backup |
| **Recommendation** | A proposal carrying evidence, cost, and a reversal | An instruction |
| **ChangePlan** | A set of mutations the user explicitly consented to | Anything we do on our own |
| **Receipt** | A recorded measurement of something that actually happened | An estimate |
| **Personal lesson** | A current-user statement eligible for explicit ratification | Bundled maintainer, imported, inferred, or demonstration history |
| **Snapshot** | A fresh artifact that validates against the versioned session schema | An arbitrary file at a familiar path |
| **Managed candidate** | A reviewed additive model fact shipped by Brain | Permission to overwrite a user override or enable metered spend |

---

## Bounded contexts

### 1. Stack Inventory  *(upstream — everything depends on it, it depends on nothing)*

Knows what is installed, where, at what version, and whether more than one copy exists.

- **Aggregate root:** `StackPackage { name, installedVersion, policyTag, registryTarget, state }`
- **State** ∈ `CURRENT | BEHIND | AHEAD | BROKEN | UNRESOLVED` — a closed set. `AHEAD` is a
  first-class legal state, not an error; that single modelling choice is what makes the
  alpha-vs-latest downgrade war **structurally impossible** rather than merely forbidden.
- **Invariant:** ordering is decided in exactly one function (`cmpVersion`). No other code in any
  context may compare two version strings. *(The bug we are killing existed in three places because
  three places were allowed to have an opinion.)*
- **Domain events:** `DriftDetected`, `ShadowFound`, `PackageSynced`, `ShadowPurged`, `InstallVerificationFailed`
- **Implemented:** `scripts/stack-sync.mjs` ✅

### 2. Wiring Survey

Knows *how* the user's tools resolve: npx vs global binary, in which hooks, in which projects.

- **Aggregate root:** `ResolutionSite { scope, file, event, matcher, spec, mechanism }`
- `mechanism` ∈ `NPX | GLOBAL_BINARY | PLUGIN | MCP`
- **Invariant:** read-only. This context has **no write capability at all** — not "does not write",
  *cannot*. It is constructed with no filesystem-write dependency.
- **Domain events:** `NpxResolutionSiteFound`, `DeprecatedSpecFound`, `MixedSpecsForSameTool`

### 3. Operator Profile

Who is this person: which harness (Claude Code / Codex / other), which paid services, which projects,
what have they already chosen.

- **Aggregate root:** `OperatorProfile { harness, entitlements[], projects[], statedPreferences[] }`
- **Invariant:** **nothing is inferred that can be asked, and nothing is asked that can be observed.**
  We never guess entitlements from usage — a wrong guess about someone's paid plan is both an error
  and an insult.
- **Invariant:** `statedPreferences` (e.g. *"I use npx on purpose"*) are **sticky**. A recommendation
  contradicted by a stated preference is suppressed permanently, not re-offered next week. *This is
  the difference between an advisor and a nag.*

### 4. Recommendation  *(pure — the only context with no I/O)*

`(Inventory, Wiring, Profile) → Recommendation[]`

- **Aggregate root:**
  ```
  Recommendation {
    id, title, rationale,
    evidence: Observation[],    // REQUIRED, non-empty — what we SAW
    cost:     Cost,             // REQUIRED — time, latency, $, risk
    change:   ChangeSpec,       // REQUIRED — the exact diff
    undo:     ChangeSpec,       // REQUIRED — the exact inverse
    severity: INFO | SUGGESTED | IMPORTANT
  }
  ```
- **Invariant (schema-enforced, not reviewed):** a `Recommendation` **cannot be constructed** without
  non-empty `evidence`, a `cost`, and an `undo`. This is the ADR's principle 4 made unbreakable — the
  type system refuses the irreversible "helpful" mutation.
- **Invariant:** pure function. No side effects, no network, no writes. Testable by table.
- **Invariant:** **no severity above `SUGGESTED` for anything we have not measured on THIS machine.**

### 5. Change Plan  *(the only context that may mutate anything)*

- **Aggregate root:** `ChangePlan { items: Recommendation[], consentedAt, preState }`
- **Invariant — CONSENT:** a plan may only contain items the user explicitly selected. There is no
  "select all" that includes anything not individually rendered and explained.
- **Invariant — RE-READ BEFORE WRITE:** apply **re-observes** the world and aborts if `preState`
  no longer holds. *This is not paranoia: on 2026-07-12 a concurrent session silently clobbered an
  entire memory checkpoint via exactly this stale-read-then-write pattern, with no error.*
- **Invariant — REVERSAL RECORDED FIRST:** the inverse is persisted **before** the mutation runs. A
  crash mid-apply must leave a working undo.
- **Invariant — BACKUP:** every file mutated is copied to `<file>.bak-<ts>` first.
- **Domain events:** `PlanConsented`, `PlanApplied`, `PlanAborted(worldMoved)`, `PlanReverted`

### 6. Memory Health  *(the original one — nobody else ships this)*

Not "is AgentDB up." **Does recall return the right things when it counts.**

- **Aggregate root:** `MemoryHealthReport { project, dimensions: Dimension[], score, notTested[] }`
- **Dimensions**, each independently probed and independently scored:

  | Dimension | Probe | Why it is not the obvious one |
  |---|---|---|
  | `liveness` | real store→search round-trip **on the path actually in use** | The 2026-05-31 failure "verified" via an adjacent path that wasn't the live one |
  | `coverage` | does a project checkpoint exist, and how stale | A live store with nothing in it passes every liveness check |
  | `recallQuality` | synthetic question → is the checkpoint in top-k? | **The one that matters. Nobody measures it.** A store can be up, populated, and still never surface the thing you need |
  | `compactionSurvival` | was a PreCompact snapshot written | Silence is not health |
  | `sessionSurfacing` | does session start actually put state in front of the model | Written-but-never-read is the same as lost |

- **Invariant:** a dimension that was **not probed** is reported in `notTested[]` and **may not
  contribute to the score**. No dimension is ever scored from an assumption.
- **Invariant:** a known-broken dimension **caps** the overall score. (House rule: no inflated scores.)

### 7. Savings Ledger

MetaHarness / Agentic-QE receipts.

- **Aggregate root:** `Receipt { at, capability, task, chosenTier, baselineTier, measuredMs, measuredUsd }`
- **Invariant — RECEIPTS ONLY:** a saving may only be displayed if it derives from a recorded,
  measured event. **No modelled savings. No "up to". No projections.** If we have no receipts, the
  section says *"nothing measured yet"* — which is honest and, on an onboarding page, is also an
  invitation.
- **Invariant:** the baseline is a **recorded counterfactual** (what the default tier actually costs),
  never an assumed one.

### 8. Presentation  *(downstream read-model only)*

- Consumes read-models from every context. **Holds no domain logic and can write nothing.**
- **Invariant:** every rendered number carries a provenance handle back to its `Observation` or
  `Receipt`. If it cannot be traced, it cannot be shown.

---

## Context map

```
  Stack Inventory ─┐
  Wiring Survey  ──┼──► Recommendation (pure) ──► Change Plan (the ONLY writer) ──► the machine
  Operator Profile─┘            │                        │
                                │                        ├── records inverse BEFORE mutating
  Memory Health ────────────────┤                        └── re-reads world, aborts if moved
  Savings Ledger ───────────────┤
                                ▼
                          Presentation (read-only)
```

**Anti-corruption layer.** Registry shapes (`dist-tags`), npm's on-disk layout, and Claude Code's
hook schema are all **external contracts that will change without telling us**. Each is wrapped in an
adapter that translates into our language at the boundary. Nothing downstream of the adapter knows
what a `dist-tag` is. *(ADR-0001 in `ruflo-ruvector` learned this the hard way: the plugin's docs
drifted from the real CLI surface, and the fix was a smoke test pinning the contract.)*

---

## The invariant that summarizes all of them

> **The console may only tell you things it observed, may only suggest things it can undo, and may
> only change things you pointed at.**

Everything above is the machinery that makes that sentence true even when someone is in a hurry.
