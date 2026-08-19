---
id: ADR-063
title: The managed-memory boundary is enforceable, opt-in, and default-off
status: Accepted
date: 2026-08-06
updated: 2026-08-19
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

## The instruction-level half (issue #140) — and the rule it appeared to contradict

This ADR made the boundary *enforceable*. @sparkling then measured the other half: the Brain's own
shipped guidance was still **teaching the bypass**. `PLAYBOOK.md` said to "confirm the exact row
through SQLite" and `SKILL.md` offered `.swarm/memory.db`'s mtime as evidence, so an agent following
the product's instructions walked straight into the thing `hijack-ruvnet` exists to refuse. A sweep
found a third, unreported and higher-traffic: the `MEMORY DIAGNOSIS` prompt `ground-ruvnet.sh`
injects on **every engaged turn**, ending "→ exact SQL row".

**The apparent contradiction.** This project also holds a hard-won rule: a memory write is proven
only by an exact-key round trip *confirmed through SQL*. It was learned expensively — on 2026-08-13
`ruflo memory store` printed `[OK] Data stored successfully` over a write that left rowcount 0, and
three days of memory were lost. "Never use sqlite3" and "only SQL proves a write" cannot both stand.

**The resolution, from evidence rather than preference.** The load-bearing half of that rule is
*exact-key round trip*; **SQL was only ever the instrument**, chosen because the CLI's success line
could not be trusted. rUv closed that upstream in **ruflo v3.32.34** — "Existing databases are
migrated automatically on the first native bridge access. **No manual SQL is required.**" — and the
bridge now **fails closed**, preserving the real native error instead of an unrelated fallback
message. Re-measured live on ruflo 3.38.12 rather than assumed:

| Condition | Managed interface answers | Verdict |
|---|---|---|
| key present | prints the stored **VALUE** | proves the write *and* that the read path resolves it — strictly more than a rowcount |
| key absent | `[WARN] Key not found: <key>` | the exact 2026-08-13 signature, reported honestly |
| store damaged | `[ERROR] file is not a database` | fails closed; no false success |
| any non-default path | `--path` reaches it, user-level included | proven against a user-level store |

So the round trip is **kept** and the instrument **changes**. One sharp edge, measured and now
written into the guidance: **the CLI exits 0 even when it prints `[ERROR]`**, so the proof is the
returned VALUE on stdout, never the exit status.

**What still justifies a raw read, and why it is not a bypass.** One narrow case survives: when the
managed interface is *itself* the suspect — retrieve says "Key not found" for a key you have strong
reason to believe was written, and the question is "did the write never land, or did it land
somewhere retrieve cannot see?" (wrong namespace, wrong store file, schema drift — issue #127 is a
live instance, ruflo 3.34 writing `.swarm/agentdb-memory.db` while every probe read
`.swarm/memory.db`). That case belongs to **the Brain's own diagnostic code**, `plugin/scripts/
memory-doctor.mjs`, which does it once, read-only, `immutable=1`-gated, with bounded output — not to
an agent improvising SQL against a schema it must guess, which is precisely the failure #103
measured nine times. The distinction this ADR now draws is therefore **instructional, not
capability-based**: *no shipped instruction may tell an agent to SQL a managed store*, while whether
any direct access is permitted at all remains the user's `managedMemoryBoundary` setting. Nothing
here is a new prohibition on the user, and `advise` still refuses nothing.

**The exception is preserved deliberately.** Unrelated **application** SQLite databases are out of
scope at both layers — the `#102` matcher requires a managed-store target, and the #140 guard
asserts an app DB is never flagged. A rule that banned `sqlite3` everywhere would contradict this
project's own storage guidance and would be routed around.

**The guard that could not fail.** The first #140 test scanned line by line. Run against the real
unfixed files at `93d6725` it reported **zero** offenders: the defect wrapped across four lines, so
the store path and the SQL verb never shared one, and its "teeth" case only proved a regex matched a
one-line string the file never contained. `tests/unit/managed-memory-no-raw-sql.test.mjs` now scans
**instruction blocks**, discovers its surfaces instead of allowlisting three, and carries the
line-scan miss as a standing regression so nobody "simplifies" it back.

## Consequences

- Users who change nothing see **no behavioural change whatsoever**. That is the point.
- The `|| true` on the Claude registration must go for this hook, or exit 2 is swallowed. That is a
  real edit to a shipped registration and is why this ADR exists rather than a silent patch.
- A future defect in the matcher becomes higher-stakes at `block`. Mitigated by (3) — one shared
  matcher with its own tests — and by the default staying `advise`.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-19 | The boundary gained its INSTRUCTION-LEVEL half, and `plugin/scripts/hijack-ruvnet.sh`'s refusal now names the store the caller actually targeted plus `ruflo memory retrieve`. Enforcement semantics are UNCHANGED: `advise` still refuses nothing, and an unrelated application DB is still never in scope. | Issue #140 (@sparkling) measured the contradiction this ADR left open: the shipped guidance still taught the bypass — `PLAYBOOK.md` "confirm the exact row through SQLite", `SKILL.md` `.swarm/memory.db` mtime, and (unreported) `plugin/scripts/ground-ruvnet.sh` "→ exact SQL row" on every engaged turn. The refusal previously hardcoded `<project>/.swarm/memory.db` while the reporter was at `~/.claude-flow/user-memory.db`, so the "sanctioned path" named the wrong file. The conflicting 2026-08-13 raw-SQL rule was retired on evidence, not preference: ruflo v3.32.34 — "No manual SQL is required" — plus a live 3.38.12 re-measure showing VALUE / `[WARN] Key not found` / `[ERROR] file is not a database`, with the caveat that exit status is 0 even on `[ERROR]`. |
| 2026-08-14 | hijack-ruvnet still enforces the boundary unchanged; it now runs inside a gate whose budget provably fits the host timeout, so it can no longer be silently killed mid-decision. |
| 2026-08-06 | Governed hook surface moved into the payload (`plugin/scripts/`) under ADR-065; the boundary itself is UNCHANGED and still ships default-off. | The move touches `hook-shim.mjs` and `session-start-core.mjs`, which this ADR governs, so the boundary was re-verified live against the shipped `hijack-ruvnet.sh` rather than assumed: `advise` (the shipped default) → exit 0 on a managed-store `sqlite3` call; `read-only` → exit 2 on a write, exit 0 on a read; `block` → exit 2; and `sqlite3 -json <managed store>` — the exact invocation the #102 matcher used to miss — now blocks. Prose mentioning sqlite and an unrelated `/tmp/myapp.db` both stay exit 0. Reporter's open criterion is unchanged and still unmet: `tests/unit/managed-memory-boundary.test.mjs` asserts `code === 2`, a deny-shaped response, not proof the command did not execute. |
