---
description: "Come up to speed on this project from AgentDB with rUv's own tools: the newest project-state-current checkpoint, lessons, recent turn outcomes and decisions, read by exact key with `ruflo memory list|retrieve|search`. Also records a decision, lesson or open item with a read-back receipt."
updated: 2026-10-12
---

# RuvNet-Brain: rnb-brief

The user wants to know **what has happened on this project**, from the record — not from your memory.
Every command below is `ruflo` (the global binary); `<db>` is `<project>/.swarm/memory.db` and `<ns>` is
the project directory name.

## Do this

**1. The newest checkpoint.** List, pick the newest `project-state-current-*` key, read it exactly:

```bash
ruflo memory list -n <ns> --limit 1000 --format json --path <db>
ruflo memory retrieve -k <newest project-state-current-key> -n <ns> --value-only --path <db>
```

**2. Lessons, decisions and recent turns.**

```bash
ruflo memory list -n lessons --format json --path <db>
ruflo memory list -n turns --limit 20 --format json --path <db>
ruflo memory search -q "<what the user asked about>" -n continuity-events --limit 10 --path <db>
```

Quote the key of every item you rely on. Search hits are ranked previews: read the exact value with
`ruflo memory retrieve` before asserting it.

**3. If they asked you to record something** (a decision, a standing rule, an open item):

```bash
ruflo memory store -k "<decision|lesson|open-item>-$(node -e 'process.stdout.write(String(Date.now()))')" -n continuity-events --path <db> --value "<exactly what was decided>"
ruflo memory retrieve -k <that key> -n continuity-events --value-only --path <db>
```

Report it as stored only when the retrieved value matches exactly.

## What NOT to do

- Do not summarize the history from memory or from the conversation instead of running the commands.
- Do not use the MCP `agentdb_hierarchical-*` tools for this: they read a different store.
