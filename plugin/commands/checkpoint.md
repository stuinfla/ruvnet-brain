---
description: "Write a project checkpoint to this project's AgentDB store with `ruflo memory store` — the goal, the acceptance contract, the decisions, what is done, what is blocked, and the exact next action — and prove it by exact-key `ruflo memory retrieve`. The next session (Claude Code or Codex) restores the newest checkpoint by exact key."
updated: 2026-10-12
---

# RuvNet-Brain: checkpoint

The user is asking you to **persist the state of this project** so the next session can resume it.

PreCompact and SessionEnd already store a small automatic `project-state-auto-<ms>` marker (event,
branch, head). **It cannot record what only you know** — the acceptance contract, the decision you
just made and why, the exact next action. That is what this command is for.

## Do this

**1. Write down the real state — from THIS session, not from a template.** Plain text or JSON with the
fields you can honestly fill: current goal, acceptance contract, next action, decisions (and why),
completed / in progress / blockers, failures, changed files, proof artifacts, and what is UNTESTED.
Empty is better than invented: a fabricated "next action" is worse than none.

**2. Store it with rUv's own tool** (append-only: a new key every time, never an update), in the
project's namespace (the repository directory name):

```bash
KEY="project-state-current-$(node -e 'process.stdout.write(String(Date.now()))')"
ruflo memory store -k "$KEY" -n "<project-dir-name>" --path "<project>/.swarm/memory.db" --value "<the checkpoint text>"
```

**3. Prove it, then report the receipt, not a claim.**

```bash
ruflo memory retrieve -k "$KEY" -n "<project-dir-name>" --path "<project>/.swarm/memory.db" --value-only
```

Say it is stored only when the retrieved value is exactly what you stored. If either command exits
non-zero, quote what it printed.

## What NOT to do

- **Do not** invent progress, decisions, or proof to make the checkpoint look complete.
- **Do not** write secrets into it.
- **Do not** reuse a key: `project-state-current-<epochms>` is append-only, so concurrent sessions never
  overwrite each other. SessionStart restores the newest one by exact key.
