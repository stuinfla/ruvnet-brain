---
id: ADR-101
title: Always check AgentDB first — recall both stores before a judgement, and refuse a score that skipped it
status: Proposed
date: 2026-10-02
updated: 2026-10-02
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [agentdb, hooks, recall, enforcement, scoring]
supersedes: []
relates: [ADR-100, ADR-098, ADR-0030, ADR-054]
---

# ADR-101 — Always check AgentDB first

**Status**: Proposed (2026-10-02)

Accepted once a release carrying it is `install-verified` and the `--doctor` line below reads ✓ on the
owner's machine.

## Owner requirement (R15, verbatim, 2026-10-02)

"ALWAYS CHECK AGENTDB FIRST. Missing that is a fail!!! RuvNet Brain should automatically do this and hooks
should enforce it!"

## The failure

Asked to score the app against the North Star, the assistant read the README and docs, never recalled the
owner's own records (`plan-4.4-4.5-20260930` — the 4.5 plan; the `scorecard-*` grades; `decision-*`;
`project-state-current-*`), and produced a score inconsistent with three prior rubrics. ADR-100 made sure
material events are *recorded*; nothing made sure they are *read* before a judgement.

Two stores exist per project and both hold such records: `.swarm/memory.db` (the `ruflo memory` CLI default)
and `.swarm/agentdb-memory.db` (the MCP memory tools' store — a distinct file by design, ruflo
`v3/@claude-flow/cli/src/memory/memory-bridge.ts`, #2786; ~16k entries on the owner's repo). Measured on the
owner's repo: the scorecards live in `memory.db`, `north-star-95-execution-authority-2026-09-11` only in
`agentdb-memory.db`. A recall of one store is a recall that misses knowledge.

## Decision

**D1 — Recall at UserPromptSubmit (`plugin/scripts/agentdb-recall.mjs`).** When the prompt asks for a
judgement the owner's records outrank — score/grade/rating, audit/assessment, status/"where are we", the
plan/roadmap/next steps, a requirements check, the North Star, a past decision, an estimate, ship readiness —
it searches BOTH stores with the global ruflo (`ruflo-bin.mjs` `resolveRuflo`, never npx):
`ruflo memory search --format json --path <store> -q "<prompt keywords> plan scorecard decision north star
requirement" --limit 30` plus up to two keyword probes for the record families the trigger names
(`scorecard`, `north-star`, `plan-`, `project-state-current`, `decision-`), all in parallel. It prints a
block of at most 900 bytes naming the top keys per store (auto-captured namespaces such as `turns`,
`sessions`, `commands` are excluded; previews are stripped of control characters and labelled as data) and
the exact `ruflo memory retrieve -k … -n … --path …` command. The trigger is held by a positive and a
negative corpus (`tests/unit/agentdb-recall.test.mjs`: code edits, syntax questions, `git status`,
`npm audit`, rate limiting, decision trees, `requirements.txt` never fire).

**D2 — Delivered through the injection budget.** `ground-ruvnet.sh` calls it behind a cheap superset grep and
files the block as priority 0 (never deferred by the per-prompt budget, never displacing a safety block),
deduped per session by content hash, so an identical recall is not re-sent. One more UserPromptSubmit
registration was not added.

**D3 — Bounds.** Hard deadline 2.0 s for all ruflo processes together; each runs in its own process group and
is SIGKILLed at the deadline (a hung ruflo yields a "timed out — recall it yourself" line, never a hang).
`RUFLO_DAEMON_AUTOSTART=0` on every call (measured: without it a search starts a background daemon in its
cwd). ruflo runs from a fresh per-call directory under the Brain's ruflo scratch root (`rufloCwdFor`,
ADR-098's `ruflo-cwd`), removed afterwards; a leftover `run-*` is classified and swept by the footprint.
No store, no ruflo, no trigger, a harness-generated prompt, or `RUVNET_AGENTDB_FIRST=off`: zero bytes.

**D4 — Enforced at Stop (`plugin/scripts/agentdb-first-gate.mjs`, hook id `agentdb-first-gate`, Claude and
Codex).** When the final answer asserts a score, grade or rating (`46/100`, `6.5 out of 10`, `Grade: B+`,
`Overall: 72%`, a table with a Score column) and no tool call in the same turn read AgentDB (Bash
`ruflo|claude-flow memory search|retrieve|list`, `continuity-brief.mjs`, sqlite3 on a `.swarm` memory db; MCP
`memory_search`, `memory_search_unified`, `memory_retrieve`, `memory_list` — not
`agentdb_hierarchical-recall`, which reads a different, empty container), the turn is continued ONCE with the
recall commands for both stores and the keys D1 already found. Targets and thresholds ("need 95/100",
"ship if >90/100", "95/100+"), counts ("87/100 tests passed"), similarity scores and code blocks are not
scores. Evidence: Claude — the transcript's current turn (`currentTurnRecords`, the boundary every Stop gate
uses); Codex — the rollout after the last `task_started`. When the turn start is not visible it never blocks
on a guess (Codex accepts D1's per-session receipt). `stop_hook_active` and a per-session, per-turn receipt
make it one block per turn. offBehavior `run` (ADR-054: it guards honesty and needs no corpus).

**D5 — Independent of the lesson system's consent.** The gate does not read `blocking-optin.json` and is not
a lesson the model ratified for itself; lessons recorded in either store (`lesson-*`, namespace `lessons`) are
ordinary recall results in D1.

**D6 — Positive confirmation.** `--doctor`, run from a project with an AgentDB store, prints an `AgentDB
first` line: ✓ when the installed Claude plugin registers `ground-ruvnet` (UserPromptSubmit) and
`agentdb-first-gate` (Stop) with both bodies present; advisory `!` naming what is missing (fix:
`npx ruvnet-brain@latest --update`) or that it was switched off. No line without a store.

## Measurements (2026-10-02, owner's real transcripts, read-only, `npm run agentdb-first:replay`)

24 transcripts, 1307 Stop points, 533 user prompts:

- Trigger: 53/533 prompts (9.9%); every fired prompt read by eye was a status/score/plan/ETA/readiness
  question (compaction summaries and harness messages are excluded as on the live path).
- Gate: 42 final answers asserted a score; 7 had read AgentDB in the same turn; 1 project had no store; 34
  would be continued. All 42 were judged genuine score assertions (current, measured or predicted North Star
  / pillar / quality scores): **0 false alarms on the 1265 turns that did not score**. One of the 34 says
  "AgentDB shows 31/100" with the read in an earlier turn — continued by design (the rule is per answer).
- Recall of the detector, estimated from the 64 answers containing any `N/100`: of the 25 not detected, read
  by eye, 23 state a target or threshold ("hit 95/100 by…", "ship if >90/100", "Target: 75/100") and 2 are
  missed assertions ("I claimed 88.1/100 quality while failing at the most basic test" — the word *test*
  reads as a count context).
- Live latency with the real ruflo 3.51.1: whole UserPromptSubmit hook 1.2 s for a score prompt, 0.19 s for
  an ordinary one; a hung ruflo returns at 2.5 s.

## What this does not do

- With the Brain switched off (ADR-054 sentinel) D1 is silent (it lives in `ground-ruvnet`, offBehavior
  `silence`); D4 still runs.
- A linked worktree whose own directory has no `.claude-flow`/`.swarm`/ruflo package reference can be cut by
  ground-ruvnet's quiet-prompt fast path before D1 runs; D4 resolves the primary checkout's stores.
- A recall done by a subagent is not visible in the parent transcript; the parent is asked to read the
  records itself.
- Codex Stop delivery rests on the same declared schema and adapter translation as the other Codex Stop gates;
  it has not been live-observed for this gate.
