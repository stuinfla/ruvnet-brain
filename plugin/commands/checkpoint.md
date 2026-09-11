---
description: "Write a full project checkpoint to this project's canonical AgentDB store — the goal, the acceptance contract, the decisions, what is done, what is blocked, and the exact next action — so the next session (in Claude Code or Codex) resumes from a verified record instead of from nothing. Prints a read-back receipt."
updated: 2026-09-11
---

# RuvNet-Brain: checkpoint

The user is asking you to **persist the state of this project** so the next session can resume it.

Automatic capture already runs at Stop, PreCompact and SessionEnd, and it records everything that can
be READ from the machine: the git tree, their work ledger, their newest `project-state-current` note,
a bounded transcript reference. **It cannot read what only you know** — the acceptance contract you
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

**3. Report the receipt, not a claim.**

The command prints the exact event key, the payload digest, and the digest of the row **read back
from the store by that exact key**. Tell the user it is stored only when `readbackVerified` is
`true`. If the command exits non-zero, say exactly what it printed — an unstored checkpoint that is
reported as stored is the specific failure this whole system exists to prevent.

If it reports `replayedPending`, say so: those were snapshots a previously interrupted session had
made durable but never committed, and this checkpoint settled them.

## What NOT to do

- **Do not** invent progress, decisions, or proof to make the checkpoint look complete.
- **Do not** write the user's secrets into it. Redaction runs anyway, but do not rely on it.
- **Do not** hand-write rows into `.swarm/memory.db` or call `ruflo memory store` yourself. This
  command is the one writer; a second path is how two stores drift apart.
- **Do not** claim the next session "will remember" anything the receipt did not confirm.
