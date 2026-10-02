---
description: "Come up to speed on this project from AgentDB: the brief (state, what changed, decisions, standing rules, open items, gate outcomes, agent findings) and, on request, the full recorded history. Also records a decision, lesson or open item explicitly, with a read-back receipt."
updated: 2026-10-01
---

# RuvNet-Brain: rnb-brief

The user wants to know **what has happened on this project**, from the record — not from your memory.

## Do this

**1. Show the brief.** Run it and show the output as-is:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/continuity-brief.mjs"
```

**2. If they asked for more** (history, "everything", one kind of thing, a time window), pull it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/continuity-brief.mjs" --full [--kind decision|lesson|commit|release|gate|finding|open-item] [--since 7d] [--limit 200]
```

Every line carries its provenance (the AgentDB key and time, or the commit SHA). Quote it when you
rely on an item. A line marked `detected` was inferred from the transcript, not stated explicitly —
say so. A line marked `PENDING` is durable in the outbox but not yet committed to AgentDB.

**3. If they asked you to record something** (a decision, a standing rule, an open item):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/continuity-brief.mjs" --record --kind decision|lesson|open-item --text "<exactly what was decided>" [--owner "<who>"]
```

Report it as stored only when it prints `stored-and-read-back`. `durable-pending` means it is safe in the
outbox and will commit at the next capture boundary — say exactly that, not "stored".

## What NOT to do

- Do not summarize the history from memory or from the conversation instead of running the command.
- Do not hand-write rows into `.swarm/memory.db` or call `ruflo memory store` for these yourself.
- If the last line says `AgentDB: recording stuck`, tell the user that line verbatim before anything else.
