---
id: ADR-012
status: Accepted
date: 2026-07-13
updated: 2026-09-30
updated_source: derived-from-git
---
# ADR-0012: Grounding gate on the write path — brain consultation is enforced, not advisory

**Status**: Accepted (2026-07-13)
**Date**: 2026-07-13
**Updated**: 2026-07-13 — implemented + installed into `~/.claude/settings.json` the same day; live-fired on its own author within minutes (blocked an ungrounded `ruflo` write mid-rework)
**Updated**: 2026-09-30 — the same write chokepoint now also refuses DUPLICATION (owner: "is it the simplest version of the code that works, that doesn't create duplicates or replication across the project?"): policy `duplicate-code` (`plugin/scripts/duplicate-gate.mjs`, composed by decision-gate, no new hook) refuses a new code file or a ≥15-line new export under scripts/ kb/ plugin/scripts/ tests/ bin/ that matches existing repo code, once per path per session, unless its header says `// DISTINCT-FROM: <path> — <reason>`. Replay over 300 commits (`scripts/duplicate-gate-replay.mjs`): 40 of 478 new files would have been refused, 19 genuine persisted duplicates, 21 moves/extractions, 0 unrelated.
**Authors**: Claude Code, directed by Stuart Kerr
**Supersedes**: None
**Related**: ADR-0004 (effectiveness first), ADR-0005 (behavioral grounding, not a lock), rUv's `@claude-flow/guidance` ADR-G007 (upstream principle), the `feedback_never_impersonate_ruv_tools` standing order

## Context

Twice in one week, Claude wrote code implementing a capability rUv already ships — without
asking the 2GB brain it was sitting on: a hand-rolled `agentdb-autocapture.mjs` (prompt-echo
snapshots) while ruflo ADR-174 `memory distill` shipped the real capture→distill design, and a
hand-rolled "MetaHarness router" while `@metaharness/router@0.3.2` sat on npm. Cost: two full
days and Stuart's trust.

The existing walls each guard a different door — `no-silent-substitution.mjs` gates what
**ships** (CI), `verify-interface.sh` gates what **runs** (PreToolUse on Bash),
`route-dispatch.sh` gates what gets **dispatched** (PreToolUse on Task). Nothing gated what
gets **written**. Every prompt-level rule ("always consult the brain first") failed, exactly as
rUv's guidance package predicts (ADR-G007): *"prompts are advisory. Agents can and do ignore
them, especially in long sessions… The model can forget a rule; the gate does not."*

## Decision

A fourth wall, on the write path, following rUv's own PreToolUse-on-`^(Write|Edit|MultiEdit)$`
wiring pattern (`ruflo/.claude/commands/hooks/overview.md`):

- **`plugin/scripts/ground-before-write.sh`** (PreToolUse, Write|Edit|MultiEdit): blocks
  (exit 2 + teaching stderr) any write/edit of a **code file** whose input mentions a RuvNet
  **product term** (`agentdb, metaharness, ruvector, aidefence, agentic-flow, agentic-qe,
  ruv-swarm, rvf, ruflo`) lacking a fresh (<24 h) grounding stamp for that term.
- **`plugin/scripts/grounding-stamp.sh`** (PostToolUse, `search_ruvnet`): writes the stamps —
  one per product term appearing **in the query only**. The tool result is ignored on purpose:
  its "Searched 37 repos" banner names every product, and stamping from it would ground the
  world on every call, making the gate unfireable.

Scope is deliberately narrow so the gate never becomes a tax that gets switched off: code files
only (docs are enforced by the CI claim gates), product terms only (not generic words), and
per-term granularity (grounding `agentdb` does not unlock `metaharness` — granularity matches
the mistake, same as `verify-interface.sh`'s per-subcommand stamps). Same hardening contract as
its siblings: opt-in via the router `profile.json`, fails open on anything unparseable, bash
builtins only, spoken-override escape hatch (`RUVNET_SKIP_GROUNDING_CHECK=1`).

## Verification (run, not asserted)

- `tests/unit/ground-before-write.test.mjs` — **10/10 green**, including re-introducing both
  real bugs (ungrounded agentdb hook, ungrounded metaharness router) and watching each die,
  the stamp→gate seam end-to-end, the result-banner trap, staleness, opt-in, fail-open, and
  the builtins-only constraint.
- Live path (real `$HOME`, real profile): ungrounded write → exit 2; genuine grounding call →
  stamp appears; identical write → exit 0.
- **Known operational fact:** hook entries added to `~/.claude/settings.json` load at session
  start. Verified live — a real `search_ruvnet` call in the installing session produced no
  stamp. The wall arms on the next session restart.

## Consequences

- Claude physically cannot write RuvNet-domain code the brain has not seen within 24 h — the
  failure mode this repo exists to prevent becomes a mechanical impossibility instead of a
  promise.
- Cost when armed: at most one 5-second `search_ruvnet` call per product per day — and that
  call is the entire point of the product.
- Honest limits: Bash heredocs that write files bypass it (the Bash gate covers the CLI-misuse
  half); `.md` files are exempt by design; users who never opt in are untouched.
