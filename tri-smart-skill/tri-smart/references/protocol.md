# TriSmart receipt shape

The structured receipt is the only review output that belongs in AgentDB. Keep prompts and raw transcripts out of the store.

```json
{
  "protocol": "tri-smart-v1",
  "mode": "dual or tri",
  "taskHash": "sha256...",
  "sourceSha": "exact source identity",
  "providers": [
    {"provider":"anthropic","cli":"claude","model":"claude-fable-5-1","auth":"claude.ai subscription"},
    {"provider":"openai","cli":"codex","model":"gpt-6-astra","auth":"ChatGPT subscription"},
    {"provider":"xai","cli":"grok","model":"grok-4.6","auth":"xAI subscription"}
  ],
  "stages": ["proposal", "pairwise-critique", "synthesis", "verification"],
  "quorum": "all selected providers; omit unavailable providers in dual mode",
  "accepted": false,
  "corrections": [],
  "unresolved": [],
  "recordedAt": "ISO-8601"
}
```

Use append-only keys such as `tri-smart-<epochms>-<task-hash-prefix>`. Verify the exact key through Ruflo and then with a direct SQLite query against the same project `.swarm/memory.db`.
