---
id: ADR-105
title: One AgentDB integration standard for Claude Code and Codex hooks
status: Accepted
date: 2026-10-10
updated: 2026-10-11 00:30:00 EDT
version: 1.1.1
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [agentdb, hooks, continuity, recall, enrollment, decisions, claude-code, codex]
supersedes: [ADR-061, ADR-073, ADR-100, ADR-101, ADR-102]
supersession: in part — only the clauses listed under "What this supersedes"; every other clause of those ADRs stays in force
relates: [ADR-063, ADR-066, ADR-072, ADR-075, ADR-076, ADR-103]
---

# ADR-105 — One AgentDB integration standard for Claude Code and Codex hooks

**Status**: Accepted

Accepted on the owner's 2026-10-10 direction to choose one standard. It records the decision only.
Each clause carries its own implementation state in the conformance table. The dual-seat
review that ADR-075 §5 requires has not been run on this text. It is still owed.

## Context

Five ADRs gave conflicting answers to the same questions: which store, which command, which
working directory, what to do when there is no store, and what a failed read means. The answers
were written months apart. Each later ADR corrected an earlier one in an appended section and
left the earlier body as it was. A reader who read an ADR from the top could follow a clause the
code had already stopped obeying. The conflicts, with line numbers as of 2026-10-10:

| Question | Conflicting claims | What the code does (source of truth) |
|---|---|---|
| Absent store | ADR-073:139 "SessionStart initializes it … before work begins" | Lazy enrollment that requires consent; the boundary is queued until a native bootstrap (`project-memory-enrollment.mjs`) |
| Ruflo working directory | ADR-073:194 "the production CLI now uses the canonical `.swarm` cwd" vs ADR-073:188 `rufloCwdFor` scratch | Private scratch directory with an explicit `--path`; `CLAUDE_FLOW_MEMORY_PATH` is deleted from the turn writer's environment (`turn-outcome-capture.mjs` `runSteps`) |
| Write flags | ADR-100:61 and ADR-102:245 `ruflo memory store --no-upsert --path` | `--no-upsert --require-native --append-only --path <abs>` in all four writers |
| Structural restore read | ADR-073:57 "does not depend on … raw SQLite", ADR-073:112 `ruflo memory list --format json` | A schema-pinned, read-only reader owned by the product (`project-progression-reader.mjs`, `agentdb-recall-reader.mjs`). ADR-073:214 admits this. |
| Recall order and budget | ADR-101 §3–§4: ranked search first, then exact reads | Exact curated reads first, on the native read-only path, one child at a time. Ranked search gets at most 80% of the remaining time (`SEARCH_BUDGET_SHARE`). |
| Git identity budget | ADR-101:62 "≤100ms timeout each" | One `git rev-parse` with timeout `min(600ms, budget/3)` (`agentdb-recall.mjs:310`, `project-store-resolver.mjs` `gitProject`) |
| Recall failure | ADR-102:252 "silent on failure, deduped per session by content hash" vs ADR-101:54 "reported as unavailable/timed out" and :67 "delivered again" | Unavailable or timed-out is rendered in the block. Recall is exempt from the per-session dedupe (`ground-ruvnet.sh:659,679`). |
| Store transport | ADR-061:119 "an MCP-aware caller owns the write" (`memory_store` request) | The MCP `memory_*`/`agentdb_*` tools write `.swarm/agentdb-memory.db`. ADR-100:117–118 and ADR-102:240 already rule that store non-canonical. |

## Decision

There is **one door to project memory, and both hosts use it.** The standard has eight rules.

### 1. One store, one door

- **Project history** has exactly one canonical store: `<primary-checkout>/.swarm/memory.db`. The
  path is resolved by `resolveProjectStore`. A linked worktree uses its primary checkout's store.
- Hooks read and write it only through the **global** Ruflo binary (`resolveRuflo`), never `npx`.
  Every call passes an explicit absolute `--path`.
- Ruflo keeps two stores by design: the `ruflo memory …` CLI uses `.swarm/memory.db`, and the MCP
  `agentdb_*` controller tools use `.swarm/agentdb-memory.db`. In addition,
  `agentdb_hierarchical-*` and `agentdb_pattern-*` ignore `namespace`.
- The MCP `agentdb_*` and `memory_*` tools are therefore **never** used for project history.
  `.swarm/agentdb-memory.db` is non-canonical diagnostic history. It is never migrated, written,
  or treated as authoritative.
- No standalone `agentdb` package. No manual SQL mutation of any managed store.
- Exception: product code may read a store through a **schema-pinned, read-only** reader
  (`withProgressionReader`). Two rules apply to it:
  - On any schema mismatch it stands down to the CLI.
  - It is the same narrow class as ADR-063's `memory-doctor` exception. ADR-063's rule is
    unchanged: no shipped instruction may tell an agent to query a managed store with SQL.
- The user-level cross-project store `~/.claude/global-memory/.swarm/memory.db` (ADR-066,
  `learning-store.mjs`) is a separate scope. Recall reads it only when it already exists and
  learning is explicitly enabled. It is never a fallback for a project store that was refused.

### 2. Run Ruflo clean

- Every Ruflo child runs with these settings:
  - cwd is a private scratch directory under the Brain home (`rufloCwdFor`): one per store, mode
    0700, owned by the user, and not a symlink.
  - `RUFLO_DAEMON_AUTOSTART=0`.
  - Its own process group. The group is killed when the deadline passes.
- `CLAUDE_FLOW_MEMORY_PATH` is never set to the store directory, and the store directory is
  never the cwd. Measured on 2026-10-10 with Ruflo 3.56.3:
  - The variable makes Ruflo create a second `agentdb-memory.db` next to the canonical store.
  - A cwd of `<project>/.swarm` leaves `ruvector.db` and `.claude-flow/` behind in it.
- The explicit `--path` alone binds the store.

### 3. Writes are immutable appends, verified by exact readback

- Every product writer uses this command:
  `ruflo memory store … --path <abs> --no-upsert --require-native --append-only`.
  - The four writers are progression `appendExact`, turn `runSteps`, the continuity journal
    `defaultStore`, and enrollment.
  - Enrollment also passes `--no-embedding`.
- A row is **committed** only when the same exact key read back from the same path returns the
  same content. The readback goes through the read-only reader or `ruflo memory retrieve
  --value-only`. A CLI success line is not proof. Neither is an exit status: the CLI exits 0 even
  on `[ERROR]` (ADR-063).
- **A refusal is not a duplicate.** Two cases count as already stored:
  - Ruflo printed its exact duplicate diagnostic: `immutable append rejected: logical key already
    exists`, or the equivalent `key "<k>" already exists in namespace "<ns>"` message.
  - Or an exact-key read made before the store returned identical content.
- Every other refusal leaves the work pending in its durable outbox or queue. That includes
  native-WAL refusal, `unavailable`, permission errors, and a nonzero exit with any other text.
- A different row under the same key is quarantined and reported. It is never overwritten.

### 4. Reads give exact records first, ranked results second, under one deadline

- Prompt recall has one shared budget of 1900 ms from entry. Every child process shares that
  deadline.
- Measured on 2026-10-10 on a machine with a load average of 30–60:
  - Each ranked `ruflo memory search` is its own process.
  - Five to eight of them in parallel starve every other read past the deadline.
- The order is therefore fixed:
  1. **Exact curated read, first.** The native read-only children run one at a time, about
     0.3 s in total. They return the newest `project-state-current-<epochms>`, ratified lessons
     that apply to this project, and continuity and curated decisions that match prompt terms.
  2. **Ranked semantic search, second.** It gets what remains, capped at 80% of the remaining
     window. Exact values are then read for at most six candidates.
- If ranked search is shed under load, the exact curated records are still delivered.
- **Failure is never reported as empty history.** A failed read renders as `unavailable` or
  `timed out`, never as "no records". A semantic miss is not absent history.
- The block keeps the existing safety rules:
  - It is labelled untrusted historical evidence, not instructions.
  - Text is redacted before it is truncated.
  - The block is ≤600 bytes on the prompt path and ≤1800 bytes for consequential phases.
  - It is delivered on every eligible prompt and never removed by dedupe.

### 5. Project identity: one Git call, fail closed

- Identity comes from **one** call:
  `git rev-parse --path-format=absolute --git-common-dir --show-toplevel`.
  - The budget is `min(600 ms, deadline/3)` on the prompt path.
  - A missing or nonexistent `HOME` does not cause a throw.
- Git that is present but unusable fails **closed** and the identity is unknown. Cases:
  - A timeout.
  - A `.git` marker that Git rejects.
  - An incomplete answer.
  - A common directory that does not end in `.git`.
- An unusable Git repository is never reclassified as a non-Git project.
- Symlink escapes and hard-linked stores are refused.

### 6. Enrollment is lazy and needs consent; replay never enrolls again

- No hook creates a store just because a session started. Two cases exist:
  - Without a store, a project enrolls only in one of two ways:
    - By explicit per-path or per-project opt-in.
    - By default for a Git developer root. Home, temporary, system and Brain cache roots are
      excluded.
  - With `RUVNET_TURN_CAPTURE=off`, nothing enrolls.
- In a new store, the first boundary is queued **derived-only** under
  `<project>/.swarm/.memory-enrollment-pending/<sha256>.json`. The file is mode 0600 and fsynced.
  It contains:
  - redacted tool outcome fields;
  - the redacted last assistant message, ≤12,000 chars;
  - a redacted progression extension.
  It never contains prompts, transcripts, tool input or environment.
- A detached worker performs the bootstrap:
  1. It writes `project-bootstrap-<projectIdentity>` with the §3 flags.
  2. It reads the record back exactly from the same path.
  3. It writes `.memory-enrollment.json` atomically.
  4. It replays the queue, rechecking consent for each original path.
- Replay passes `enrollMemory: () => ({state:'existing'})`. A replay therefore never starts
  enrollment again.
- Existing stores are never initialized, replaced or deleted.

### 7. Hooks are thin, shared, explicit about host, and privacy wins

- Both hosts register the same scripts through the stable `hook-shim.mjs`.
  - Codex goes through the stable `codex-hook.mjs` wrapper and then `codex-hook-adapter.mjs`,
    which sets `RUVNET_HOOK_HOST=codex`.
  - Claude identity comes only from a `CLAUDE_PLUGIN_ROOT` that matches the shim's own plugin
    root. If it does not match, the host stays unknown. The host is never guessed from absence.
- The project is resolved at runtime from the event `cwd`. No global hook names a project, a
  path or a namespace in code.
- The following always win over capture and recall. Opt-out is reported as `disabled`, never as a
  failure:
  - `RUVNET_AGENTDB_FIRST=off`
  - `RUVNET_TURN_CAPTURE=off`
  - per-path and per-project privacy policy
  - content-path exclusions
  - brain-off silence

### 8. Decision records: what, why, what it looks like, where the evidence is

The owner requires every key decision to be saved in a form that any project can consult before
its next architectural decision. A decision record is an append-only row in the canonical store.

| Field | Required | Bound | Content |
|---|---|---|---|
| `schema`, `schemaVersion` | yes | — | `ruvnet-brain.decision-record`, `1` |
| `project`, `projectIdentity` | yes | — | `projectRoot` and `projectIdentity.id` from `resolveProjectStore` |
| `at`, `host`, `session` | yes | — | ISO time, `claude`/`codex`, session id or null |
| `status` | yes | — | `ratified` (explicit owner or agent act) or `detected-unconfirmed` |
| `what` | yes | ≤400 chars | the decision, in one statement |
| `why` | yes if ratified | ≤800 chars | the reason, the alternatives rejected and why |
| `shape` | yes if ratified | ≤1,200 chars | what it looks like: interface, command, schema or a short example |
| `evidence` | yes if ratified, ≥1 | ≤8 items, each ≤200 chars | `{kind: path\|commit\|receipt\|adr\|url, ref}` |
| `supersedes` | no | ≤8 keys | exact keys of earlier decision records this one replaces |

- **Key:** `decision-<kebab-slug ≤48>-<YYYYMMDDTHHMMSSmmmZ>`.
  - Namespace: the project namespace (`basename(projectRoot)`), the same one that holds
    `project-state-current-*`. Recall already enumerates it.
  - Written with the §3 flags. A collision is refused, never overwritten.
- **Redaction:** each string field goes through the shared `redactText`, then content-path
  exclusions are masked (`maskExcludedPaths`). Only then is it bounded. The whole value is
  ≤4 KiB.
- **Supersession is a link on the new record.** An append-only store cannot edit the old row.
  A record is superseded when any newer verified decision record lists its key in `supersedes`.
  Readers must compute this from the newer records.
- **Consulted before deciding:**
  - Prompt recall's exact curated pass (§4) reads matching decision records on every eligible
    prompt.
  - Consequential managed-workflow phases call `recall({consequential: true})`. They fail closed
    when history is unavailable (`scripts/model-managed-workflow-service.mjs`).
  - A detected record is evidence, never a ratified instruction.

Example value (shape only):

```json
{"schema":"ruvnet-brain.decision-record","schemaVersion":1,"project":"/Users/x/Code/app",
 "projectIdentity":"git-sha256:…","at":"2026-10-10T22:00:00.000Z","host":"claude","session":"…",
 "status":"ratified","what":"Project history uses only <primary>/.swarm/memory.db via global ruflo --path",
 "why":"MCP agentdb_* writes a second store; two stores split history (measured 2026-05-31, 2026-10-10)",
 "shape":"ruflo memory store -k K --value V -n NS --path ABS --no-upsert --require-native --append-only",
 "evidence":[{"kind":"adr","ref":"docs/adr/0105-one-agentdb-integration-standard.md"},
             {"kind":"path","ref":"plugin/scripts/turn-outcome-capture.mjs#runSteps"}],
 "supersedes":[]}
```

## Conformance (verified by reading the code on 2026-10-10; working tree, not a published build)

| Rule | State | Evidence or gap |
|---|---|---|
| 1 One store, global binary, `--path` | Implemented | `project-store-resolver.mjs`; `ruflo-bin.mjs`; `agentdb-recall.mjs` `STORE_FILES = ['memory.db']` |
| 2 Scratch cwd, no daemon | Implemented | Capture, recall and the progression/continuity writers use `rufloCwdFor`; the enrollment worker uses a private `mkdtemp` under the OS temp directory (outside the project). A Ruflo spawn in `degradation-watch.mjs` (bare `ruflo` from PATH, inherited env and cwd) is NOT yet covered. Follow-up. |
| 2 `CLAUDE_FLOW_MEMORY_PATH` removed | Implemented at five spawn sites | `turn-outcome-capture.mjs` `runSteps`, `project-progression-store.mjs`, `continuity-journal.mjs`, `project-memory-enrollment.mjs` and `agentdb-recall-process.mjs` pass `CLAUDE_FLOW_MEMORY_PATH: undefined`. Guard: `tests/unit/ruflo-env-scrub.test.mjs` covers the recall spawn only; the other four sites are unguarded by test. `degradation-watch.mjs` is not covered. |
| 3 Native immutable append + exact readback | Implemented | `appendExact` (`project-progression-store.mjs`), `runSteps`, `continuity-journal.mjs` `defaultStore`, `enrollProjectMemory` |
| 3 Refusal ≠ duplicate | Implemented | `appendExact` accepts only the exact duplicate diagnostics. Turn and continuity writers count a row as stored only after a matching exact readback. |
| 4 Exact-first recall, shared deadline | Implemented | `agentdb-recall.mjs` `recall` (curated pass, then `searchDeadlineFor`), `agentdb-recall-process.mjs` |
| 5 One Git call, fail closed | Implemented | `project-store-resolver.mjs` `gitValue`/`gitProject`; `nonGitRoot` tolerates missing HOME |
| 6 Lazy consent-gated enrollment, no re-enroll on replay | Implemented | `project-memory-enrollment.mjs`; `project-capture-queue.mjs` replay passes `enrollMemory: () => ({ state: 'existing' })`. Native test `tests/integration/project-memory-enrollment-native.test.mjs` passes (10/10 with its unit file, 2026-10-10). |
| 7 Shared shim, explicit host | Implemented for capture hooks | `hook-shim.mjs:190–197`, `codex-hook-adapter.mjs:118`. Some scripts still default to `'claude'` when the host is unset (for example `turn-outcome-capture.mjs:490`, `continuity-events.mjs:337`). Follow-up. |
| 7 Single writer | **Gap** | `turn-outcome-capture.mjs:295` still defers Claude Stop turns to a user-level `agentdb-turn-capture.mjs` when one is registered (ADR-100 §3). Under this standard the product is the one writer of project history. A foreign hook is never evidence of capture. Follow-up: remove the deferral, or require that the foreign hook prove the §3 contract. |
| 8 Decision record contract | **Not implemented** | Continuity events (`continuity-events.mjs` `makeEvent`) carry only `summary` (≤400 chars) plus a free-form `detail`. They have no `why`, `shape`, `evidence` or `supersedes`. Recall honors only an in-record `supersededBy`/`superseded` flag (`agentdb-recall.mjs:273`), which an append-only store cannot set afterwards. Follow-up: a writer for decision records, a validator, and supersession computed from `supersedes` on newer records. |

## What this supersedes (in part)

Each superseded ADR keeps its body as history. Its status line points here.

- **ADR-073**: three clauses are superseded:
  - §1 clause 4, the "raw SQLite" prohibition, as far as product-owned schema-pinned read-only
    reads are concerned;
  - §4 step 3, enumeration with `ruflo memory list`;
  - §6, initialization at SessionStart (removed in code: `restoreProgressionForSession` returns `not-enrolled` and `session-start-core.mjs` only reports the enrollment plan).
  The binary continuity contract, the progression journal, the outbox and the acceptance clauses
  stay in force.
- **ADR-100**: two items are superseded:
  - §2, the write command, which is now the §3 flags;
  - §3, deferral to a user-level writer, which this ADR rules out (gap above).
  Material events, the outbox, the brief and positive confirmation stay in force.
- **ADR-101**: two items are superseded:
  - §3–§4, the order of ranked and exact reads;
  - §6, Git probes of ≤100 ms each.
  The trigger, the canonical-only rule, redaction, the 600 B cap and the 1900 ms budget stay in
  force.
- **ADR-102** (d): the READ-ALWAYS clause "silent on failure, deduped per session by content
  hash", and the `--no-upsert --path` write command. The rest of the closure-ledger proposal is
  unchanged.
- **ADR-061** §7: the MCP-aware caller as the owner of the store write. The transport-neutral
  request must be fulfilled through the §1 door. The rest of the deliberation proposal is
  unchanged.

## Consequences

- One reading order: this ADR states the standard, and the older ADRs state mechanisms and
  history. A new hook needs no new ADR. It follows these eight rules.
- Load no longer turns into apparent amnesia: under contention the exact curated records still
  arrive.
- Three gaps are named, not hidden: the environment scrub, single-writer deferral and decision
  records. None of them is claimed as working until code and a native-host receipt exist.
- Cost: decision records need a writer, and authors need discipline. A record without `why`,
  `shape` and `evidence` is only `detected-unconfirmed`.

## Sources

- Ruflo, searched with `search_ruvnet` by the integration owner on 2026-10-10:
  - `ruflo/plugins/ruflo-agentdb/agents/agentdb-specialist.md`
  - `ruflo/plugins/ruflo-console/hooks/views/memory.ts`
  - `ruflo/v3/docs/releases/v3.32.34.md` ("No manual SQL is required")
- Live Ruflo 3.56.3 search on the canonical store, 2026-10-10. It warned: "16817 entries are in
  …/.swarm/agentdb-memory.db and were not searched. That store is written by the MCP/AgentDB
  path."

## Review record

- 2026-10-10, Opus 5.5 (independent read of HEAD `36fe043f`, file by file, no tests run by the reviewer): REVISE with four blocking findings, all resolved in the same release:
  SessionStart created a store without consent (removed); the curated block could exceed 600 bytes and was discarded when ranked search was empty (curated and ranked are now merged and always leave through `formatBlock`); torn enrollment receipt/queue files wedged enrollment (atomic create-if-absent, torn files tolerated and preserved as `.corrupt`);
  and non-blocking findings fixed: opt-out checked in every enrollment state, Git mount-boundary wording and a missing `git` binary, and a test that now counts Git processes.
- Astra (`gpt-6-astra`): NOT obtained. The managed dispatcher refused the launch ("Native subscription allowance host exited before proof"), because the Brain's `codex` wrapper rejects `codex app-server` ("no proved terminal routing transport"). No bypass was attempted. ADR-075's dual-seat review is therefore OPEN for this ADR.
- Open non-blocking findings carried forward: enrollment queue is unbounded while enrollment stays pending (N2); enrollment lock has a check-then-act gap and no age expiry (N3); "newest" decision slice is key-ordered, not time-ordered (N5); presence enumeration lists every turn key (N6); CLI-fallback exact reads are spawned in parallel (N7); Codex `shell`/`local_shell_call` commands are not mapped for path exclusion (N10).
- 2026-10-10, Opus 5.5 second pass over `git diff 36fe043f 32ebd019`: B1, B2 and B3 RESOLVED. B4 PARTIAL: the first atomic-write fix used `link()`, which a killed hook could leave at nlink 2, making readers reject the file forever. Replaced by a direct exclusive create that every reader tolerates when torn. Also fixed from this pass: a failed curated state/lessons read after a successful enumeration is no longer reported as `ok-empty` (the block says `unavailable curated records`).
