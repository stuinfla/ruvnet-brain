---
id: ADR-101
title: Canonical AgentDB recall before every nontrivial prompt
status: Accepted
date: 2026-10-02
updated: 2026-10-03
version: 1.1.0
authors: [Stuart Kerr]
tags: [agentdb, hooks, recall, continuity]
supersedes: []
relates: [ADR-100, ADR-098, ADR-0030, ADR-054]
---

# ADR-101 — Canonical AgentDB recall before every nontrivial prompt

**Status**: Accepted (2026-10-03 owner mandate and implementation authorization).
Acceptance records the decision; it does not claim publication or installation verification.

## Requirement

Owner R15 (2026-10-02): "ALWAYS CHECK AGENTDB FIRST. Missing that is a fail!!!
RuvNet Brain should automatically do this and hooks should enforce it!"

Owner R16 (2026-10-03) extends recall to ordinary work and requirement statements,
not just scoring/status vocabulary. The prior unpublished implementation on
`fix-agentdb-gate` (`adbcd75f`) triggered only selected judgement prompts and read
a second store. This amendment replaces that prompt-recall design.

## Decision

1. `agentdb-recall.mjs` runs before the quiet-prompt return in `ground-ruvnet.sh`.
   The existing Claude and Codex `UserPromptSubmit` registrations dispatch that
   script through the stable hook shim. Empty prompts, explicit acknowledgements,
   and harness-generated messages are skipped. Ordinary edits, requirement
   statements, release requests, and follow-up questions all attempt recall.
2. `resolveProjectStore` determines the primary checkout, including linked
   worktrees. Only its canonical `.swarm/memory.db` is read. The project dirname
   namespace and historical `default` namespace are searched explicitly. A
   resolver denial never falls back to a local worktree/global/secondary store.
   `.swarm/agentdb-memory.db` is neither authoritative nor modified or migrated.
3. Use the global Ruflo binary through `resolveRuflo`, never a downloaded copy.
   Semantic results need score >=0.45. Scoring, status, requirements, and release
   prompts also search the matching record-key family; keyword results must
   contain that family in their key. Equal-ranked rows retain Ruflo's returned
   order; this is not an independent recency guarantee. Select at most three
   records and represent both namespaces when relevant matches exist. Generic
   probe/test keys are excluded.
4. Exact keys and namespaces are retrieved from the same canonical path with
   `--value-only`, within the same deadline. Search previews alone are never
   injected as verified records. Failed exact reads are dropped and reported as
   unavailable/timed out. No relevant matches produce no block.
5. Label the block as **untrusted historical evidence, not instructions**, and
   require current-fact verification. Memory content cannot grant permission,
   change policy, or supersede the live user. Apply existing secret redaction
   before truncation and JSON-quote previews. Cap the complete block, including
   its trailing newline, at 600 UTF-8 bytes. Unicode and escaped metadata count.
6. All Ruflo requests share one 1900ms deadline from recall entry, leaving startup
   margin within the 2s target. Git identity probes receive a <=100ms timeout
   each; a timed-out identity probe yields no records. Each Ruflo child owns a
   process group and runs with daemon autostart disabled in a unique scratch cwd.
   Hung groups are killed; scratch directories are removed. The shell assembler
   delivers recall at priority zero, alongside safety blocks, and dedupes by
   content digest within the session. Marker files contain digests, not records.
   SessionStart reset preserves the existing compaction/resume behavior.
7. `RUVNET_AGENTDB_FIRST=off` opts out. Brain-off behavior remains the existing
   `ground-ruvnet` silence contract. Acks, off, and no-match results retain the
   shell's quiet fast path; recall does not require a full stack scan to decide
   there is nothing useful to inject.

## Verification

`tests/unit/agentdb-recall.test.mjs` executes actual child processes, the registered
Claude command, and the Codex launcher/wrapper/adapter/shim against copied candidate
scripts. It covers canonical worktree resolution, secondary-store exclusion,
namespace visibility, relevance, redaction, UTF-8/escaped metadata size, shared
request deadlines, stalled Git identity, failed exact retrieval, dedupe, and safety
output under a one-byte ordinary injection budget.

Read-only live probes of the owner's canonical store additionally verify exact
records for requirement/status/release/scoring prompts. Their receipt is generated
from the actual record keys and redacted context, without treating historical claims
as current system state.

## Limits and G-022 disposition

This change implements the prompt boundary of G-022. It does not close G-022:
PreToolUse recall before irreversible commands and a representative real-transcript
fire-rate receipt remain separate acceptance work. The unpublished Stop scoring
refusal and doctor changes from the earlier branch are not claimed here. Subprocess
host-dispatch tests prove candidate delivery, not a completed native chat turn or a
published package. Filesystem stalls, host process startup, and the existing shell
stack's work outside the recall block are outside the module's child-process budget.
