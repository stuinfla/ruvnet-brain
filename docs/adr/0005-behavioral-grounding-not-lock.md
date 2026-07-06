# ADR-0005: Behavioral grounding via retrieve-and-inject + hard-deny + drift SLO (not a "lock")

**Status:** Accepted (2026-06-27) · **Partially implemented — reconciled 2026-07-06 (ADR-0009 decision 2).**
**Red-team origin:** Enf-H1/H2/H3/H6, Arch-H6

> **⚠ SHIPPED-VS-DECIDED RECONCILIATION (2026-07-06, ADR-0009 self-audit).** Of the four teeth decided
> below, only **#1 (retrieve-and-inject) is implemented** — `plugin/scripts/ground-ruvnet.sh` +
> `session-start.sh` inject grounding directives on every relevant turn. The other three are **NOT shipped**
> as of plugin v1.9.1-dev, and this ADR is corrected here so no accepted decision describes a world the code
> doesn't live in (the brain's own living-plans rule, ADR-0009 decision 5 · ADR-0009-ADR-QA):
> - **#2 PreToolUse HARD-DENY** — `plugin/scripts/hijack-ruvnet.sh` ships `DECISION="defer"` (advisory
>   inject, **never blocks**). It is a nudge, not the "one real harness tooth" this ADR claimed.
> - **#3 Stop semantic judge** — **not wired at all**; `plugin/hooks/hooks.json` has only SessionStart /
>   UserPromptSubmit / PreToolUse.
> - **#4 measured drift-rate SLO** — **no drift measurement exists** in `data/` or `scripts/`; the DDD's
>   old "measured drift-rate ≤ SLO" invariant was unmet (now reconciled in DDD v0.2, Enforcement context).
>
> Whether the hard teeth (#2–#4) are worth building — or whether soft retrieve-and-inject is sufficient — is
> deferred to a future ADR that **measures** drift first, rather than asserting the teeth are needed. Today's
> honest statement: enforcement is *retrieve-and-inject only*, a strong nudge, not a lock.

## Context
v0.1 claimed Claude Code hooks could intercept a drafted prose answer and "rip it back." They cannot:
`PreToolUse` sees only tool name+input, never prose; no hook mutates the token stream. "Can't maneuver" was
false, and a lexical denylist is paraphrase-evadable and false-positives on correct contrastive answers.

## Decision
Defense-in-depth, strongest first: **(1) Retrieve-and-inject** — the `UserPromptSubmit` hook runs the KB
query itself and injects real source passages, so the agent answers *from* in-context truth, not a decline-
able mandate. **(2) `PreToolUse` HARD-DENY** — deterministically block installing/writing pgvector/pinecone/
chroma/weaviate deps or hand-rolled cosine/JSON-embeddings when an RVF path exists (the one real harness
tooth). **(3) `Stop` semantic judge** — re-open once if a RuvNet answer dismisses a capability without a
supporting citation. **(4) Semantic** drift detection (embedding-similarity to a drift centroid), not
keywords. We claim a **measured drift-rate SLO** (e.g., ≤2% on the adversarial bait set), never "can't drift."

## Consequences
- Honest: the grounding/hooks live in host config, not inside `brain.rvf`; full strength is Claude Code,
  weaker on Cursor/Codex/API (documented gradient).
- Enforcement is *measured* every version, not asserted.

## Alternatives rejected
- *"Behavioral lock" / mid-draft interception* — not a real hook capability; theater.
- *Keyword denylist as the detector* — evadable + false-positive; replaced by semantic + injection.
