---
id: ADR-063
title: The managed-memory boundary is enforceable, opt-in, and default-off
status: Accepted
date: 2026-08-06
updated: 2026-08-06
authors: [Stuart Kerr, Claude Code]
tags: [enforcement, memory, agentdb, hooks, consent, issue-103]
supersedes: []
relates: [ADR-035, ADR-040, ADR-055]
governs:
  - plugin/scripts/hijack-ruvnet.sh
  - plugin/scripts/hook-shim.mjs
  - plugin/hooks/hooks.json
  - scripts/user-settings.mjs
---

# ADR-063 — The managed-memory boundary is enforceable, opt-in, and default-off

**Status**: Accepted

**Date**: 2026-08-06

## The problem, measured by the reporter (issue #103)

> "In a long Codex session, **59 shell-tool calls directly invoked SQLite against memory-related
> stores. The Brain did not prevent any of them.** No direct DML/DDL occurred, but **49 calls did not
> enforce read-only mode** and nine failed because the agent guessed storage schema details."

The Brain *recommends* an interface boundary it cannot enforce. Verified today, the advisory is
neutered five times over, and **each layer alone is sufficient** to guarantee it can never block:

| # | Layer | Evidence |
|---|---|---|
| 1 | the script's own verdict | `plugin/scripts/hijack-ruvnet.sh:13` — `DECISION="defer"`, hardcoded |
| 2 | the shim's mode table | `plugin/scripts/hook-shim.mjs:86` — `mode: 'advisory'` |
| 3 | the Claude registration | `plugin/hooks/hooks.json:66` — `… hijack-ruvnet \|\| true` |
| 4 | the Codex adapter | `plugin/scripts/codex-hook-adapter.mjs:87-88` — **deletes** `permissionDecision` |
| 5 | the aggressiveness dial | `scripts/user-settings.mjs:149` — `escalates: []`, *"speech only — no value of this setting writes anything anywhere"* |

Defence-in-depth pointed at our own enforcement. Fixing any one changes nothing.

## What we are NOT doing, and why

**Not repurposing the 1–5 dial.** ADR-040 scopes it to *speech*, and `user-settings.mjs:149` says so
in terms. A user who set "Maximum help" asked to be *talked to* more, not to have commands refused.
Silently converting a verbosity preference into a command-authorization preference would be the
worst kind of surprise — and the reporter names this confusion as part of the defect.

**Not enabling enforcement by default.** `user-settings.mjs:13` states the standing rule: *nothing
that acts beyond the current project may default to on*. A block that arrives unannounced can halt
someone's real work over a heuristic, and this project has already shipped three gates that could
never pass (the RVF byte-compare, `EXPECTED_VERSION`, the `Test Files` grep). An unsatisfiable gate
that merely nags is a nuisance; an unsatisfiable gate that *blocks* is an outage.

## The decision

1. **A new setting owns this, separate from speech.** `managedMemoryBoundary`, one of:
   - `advise` — **default**; today's behaviour exactly, byte-for-byte.
   - `read-only` — a direct **write** to a managed store is refused; reads are allowed and advised.
   - `block` — any direct access to a managed store is refused.

   It carries `escalates: ['read-only', 'block']`, so the existing test that forbids an escalating
   value from being a default binds it automatically. No new consent machinery.

2. **Enforcement reuses the blocking rail that already exists.** `mode: 'blocking'` is real and in
   use (`ground-before-write`, `design-wall`, `protect-state`), `codex-hook-wrapper.mjs:11` already
   propagates exit 2 for a declared blocking hook, and the Codex adapter only strips `defer` —
   `deny` passes through. **No new mechanism is invented**; hijack-ruvnet was simply never wired
   into the one we have. The contract is the one `ground-before-write.sh:33` documents:
   `exit 0 = allow · exit 2 + stderr = BLOCK, stderr returned to the model as the reason`.

3. **What is refused is an INVOCATION, never prose.** Issue #102 fixed the matcher to require a
   command in command position AND a managed-store target. Enforcement rides on that same matcher —
   a boundary built on a matcher that fires on prose would refuse a user for *writing a sentence*.

4. **The refusal must name the sanctioned path.** stderr returns to the model, so a block that only
   says "no" burns a turn. It names the `ruflo memory` equivalent, which is the whole point: the
   reporter's nine failures were an agent *guessing schema* it should never have needed.

## Honesty boundary

- **MAY claim** after this ships: the boundary is *enforceable and under user control*; the default
  is unchanged; `read-only` refuses writes and `block` refuses all direct access.
- **May NOT claim**: "the Brain prevents direct SQLite access" — untrue at the default, which is
  where every user starts. Nor "sandboxed": a determined agent can still shell out in ways a
  PreToolUse matcher cannot see. This raises the floor; it is not a jail.

## Consequences

- Users who change nothing see **no behavioural change whatsoever**. That is the point.
- The `|| true` on the Claude registration must go for this hook, or exit 2 is swallowed. That is a
  real edit to a shipped registration and is why this ADR exists rather than a silent patch.
- A future defect in the matcher becomes higher-stakes at `block`. Mitigated by (3) — one shared
  matcher with its own tests — and by the default staying `advise`.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-06 | Governed hook surface moved into the payload (`plugin/scripts/`) under ADR-065; the boundary itself is UNCHANGED and still ships default-off. | The move touches `hook-shim.mjs` and `session-start-core.mjs`, which this ADR governs, so the boundary was re-verified live against the shipped `hijack-ruvnet.sh` rather than assumed: `advise` (the shipped default) → exit 0 on a managed-store `sqlite3` call; `read-only` → exit 2 on a write, exit 0 on a read; `block` → exit 2; and `sqlite3 -json <managed store>` — the exact invocation the #102 matcher used to miss — now blocks. Prose mentioning sqlite and an unrelated `/tmp/myapp.db` both stay exit 0. Reporter's open criterion is unchanged and still unmet: `tests/unit/managed-memory-boundary.test.mjs` asserts `code === 2`, a deny-shaped response, not proof the command did not execute. |
