---
description: "Write a full project checkpoint to this project's canonical AgentDB store — the goal, the acceptance contract, the decisions, what is done, what is blocked, and the exact next action — so the next session (in Claude Code or Codex) resumes from a verified record instead of from nothing. Prints a read-back receipt."
updated: 2026-09-17
version: 1.0.3
---

# RuvNet-Brain: checkpoint

The user is asking you to **persist the state of this project** so the next session can resume it.

Automatic capture currently runs at `Stop`, `PreCompact`, and `SessionEnd` in Claude Code; Codex
automatic capture has been observed at `SessionEnd`. It records everything that can be READ from
the machine: the git tree, the work ledger, the newest `project-state-current` note, and a bounded
transcript reference. **It cannot read what only you know** — the acceptance contract you
are working to, the decision you just made and why, the exact next action. That is what this command
is for, and it is why a checkpoint is worth more than another automatic snapshot.

## Do this

**1. Write down the real state — from THIS session, not from a template.**

Build a JSON object with the fields you can honestly fill. Every field is optional; set at least one.
Empty is better than invented: a fabricated "next action" is worse than no next action, because the
next session will act on it.

| field | what goes in it |
|---|---|
| `currentGoal` | one sentence: what this work is actually for |
| `acceptanceContract` | what would make it DONE — the conditions, not the vibe |
| `nextAction` | the single next concrete step, specific enough to start cold |
| `decisions` | decisions made and WHY; include the ones you'd otherwise have to re-derive |
| `completed` / `inProgress` / `blockers` | honest status; a blocker named is a blocker halved |
| `failures` | what was tried and did not work, so it is not tried again |
| `changedFiles` | the files this work touched |
| `proofArtifacts` | commands run, outputs seen, receipts — the evidence, not the claim |
| `untested` | what was built but NOT verified. Do not omit this one. |

**2. Store it.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/project-progression-checkpoint.mjs" --json '<your JSON>'
```

For anything longer than a line or two, write the JSON to a temp file first and use
`--json-file <path>` — a large single-quoted argument is how a shell mangles a checkpoint.

When automatic capture reports concurrent heads, inspect them without writing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/project-progression-checkpoint.mjs" --reconcile-inspect
```

After reviewing every reported conflict, apply an exact `expectedHeads` set and explicit
dispositions for each selectable conflict from a JSON file. Source identity, provenance, and
evidence conflicts are mechanical: they are rebuilt or retained with audit references and do not
accept user dispositions.

```json
{"expectedHeads":[{"eventKey":"...","payloadDigest":"..."}],"dispositions":{"<conflictDigest>":{"conflictDigest":"<conflictDigest>","action":"select","head":"..."}}}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/project-progression-checkpoint.mjs" --reconcile-apply --json-file /path/to/reconciliation.json
```

The apply path rejects changed, missing, foreign, or duplicate heads and unknown or stale
dispositions. A new head arriving after review remains visible in the receipt; it is never silently
adopted. Dispositions may explicitly `select`, `replace`, or `clear` a selectable field. Clearing
`currentGoal` or `nextAction` remains cleared against carried notes; a newer ledger value may take
precedence and is disclosed in `reconciliation.supersededByLedger`.

After a successful apply, the reviewed heads have been replaced by a new descendant. Repeating the
same apply file therefore requires a fresh inspect because its expected heads are stale. Exact
outbox replay is idempotent for a previously published event key; repeated reconciliation proposals
are not silently treated as the same review.

**3. Report the receipt, not a claim.**

The command prints the exact event key, the payload digest, and the digest of the row **read back
from the store by that exact key**. Tell the user it is stored only when `readbackVerified` is
`true`. If the command exits non-zero, say exactly what it printed — an unstored checkpoint that is
reported as stored is the specific failure this whole system exists to prevent.

If it reports `replayedPending`, say so: those were snapshots a previously interrupted session had
made durable but never committed, and this checkpoint settled them.

The checkpoint boundary replays pending per-record spool entries before producing and capturing new
state. The legacy `.swarm/project-progression-outbox.jsonl` is read-only compatibility input; an
unreadable or malformed complete line is an error, while an unterminated tail is preserved. Session
Start reports pending or unreadable transport without replaying it; the next capture boundary or
this command performs replay. Temporary spool files are ignored and are not removed by age.

## What NOT to do

- **Do not** invent progress, decisions, or proof to make the checkpoint look complete.
- **Do not** write the user's secrets into it. Redaction runs anyway, but do not rely on it.
- **Do not** hand-write rows into `.swarm/memory.db` or call `ruflo memory store` yourself. This
  command is the one writer; a second path is how two stores drift apart.
- **Do not** claim the next session "will remember" anything the receipt did not confirm.
