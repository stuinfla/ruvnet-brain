Updated: 2026-09-07 11:42:00 EDT | Version 1.0.0
Created: 2026-09-07 11:42:00 EDT

# RuView query-to-source relevance correction

The failed a6c63923 candidate asked for a general RuView overview but accepted only
`docs/adr/ADR-031-ruview-sensing-first-rf-mode.md`. Two independent source reviews
read that archived passage and the returned `harness/ruview/CLAUDE.md`.
The returned document identifies camera-free WiFi-CSI sensing, usage workflows, and
validation limits. The expected ADR is a proposed sensing-first multistatic design
addressing occlusion, depth ambiguity, and multi-person limitations. The broad question
did not uniquely require this narrower document.

Correct the question to ask about that proposed design and the limitations it addresses.
The expected repository, path, passage hash, sample population, and acceptance thresholds
remain unchanged. This query wording was selected from the reviewed source before
executing the corrected query. It must be committed as oracle source and then referenced
by the subsequent candidate's resealed query evidence; it is not permission to relabel
old failed artifacts. The original 6/19 result and diagnostic 18/19 overlay remain failures.

Separately, multi-document MCP requests now fall through the one-card overview shortcut
to actual source retrieval. That runtime fix is general and contains no canary paths or
query-specific matching.
