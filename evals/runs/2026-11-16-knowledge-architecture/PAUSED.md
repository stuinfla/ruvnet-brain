Updated: 2026-11-17 00:06:00 EST | Version 1.0.0
Created: 2026-11-17 00:06:00 EST

# Paused jobs (owner order, 12:00 a.m. ET, 2026-11-17)

Everything the lead's measurement agents were running was stopped at a safe boundary between 12:00 and 12:04
a.m. Nothing was deleted; every job is checkpointed and resumes from where it stopped. Each job's own
`PAUSE-STATE.md` has the exact commands. Nothing here is to be resumed until the owner says so.

Checked at 12:05 a.m. with `pgrep`: no `embed-pool-rig`, `run-rigB`, `run-answers`, `judge-run`,
`ask-shipped`, re-ranker or ladder process. Load was still about 55 from work that was NOT to be paused: the
history agent's bisect search worker (`ruvnet-brain-bisect-20261116/.../forge-mcp-all.mjs`, about 2 cores),
several `ruflo memory` processes, `tools/facts.mjs`, and system daemons.

| Job | Folder (under `candidates/` unless noted) | State when paused | Resume | What it was meant to decide |
|---|---|---|---|---|
| Embedder screen, development pass | `rig/` | done and scored: control, arctic-embed-m, gte-modernbert. nomic 13,504 of 17,502 passages. Not started: all-MiniLM-L6-v2, bge-small, jina-code, bge-large, embeddinggemma-2, extra control | `rig/PAUSE-STATE.md` | rule R1 / A3: does any other embedding model beat the current one enough to matter once fused |
| Embedder screen, blind pass (E + F) | `rig/` | control 13,472 of 23,600 passages; nothing else started | same file | the same rule on blind questions; A5.2 non-inferiority for rUv's two default small models |
| Stage 2 full re-embed | none | never started (suspended by A5.L3) | none | confirm a stage-1 winner on full stores |
| Answer level, set E | `answers/` | done: no tool, files+history, files+history+cards, 3 runs each, judged. Shipped product: 63 of 252 answers, 49 judged | `answers/README.md` pause section | rules R8, R9; the cards ablation (decided: not met) |
| Answer level, set F | `answers-F/` | no tool and files+history: 480 answers written, mechanical checks done, NOT judged; with-cards arm not started | `answers-F/PAUSE-STATE.md` | whether the E answer-level result holds on questions whose gold was found without keyword search |
| Side-by-side document | `sbs/`, `SIDE-BY-SIDE.md` (DRAFT) | tables for dev and E done (shipped 4 vs candidate 52 of 113; 9 vs 95 of 164); shipped on F 27 of 80 questions; the 14 worked examples not written | `sbs/PAUSE-STATE.md` | the owner's requested comparison with worked examples |
| Informed-query ladder and blind rewriting (A4) | `ladder/` | sample for E and dev; 80 informed query sets; lexical lane on 240 ladder queries; 191 of 210 blind rewrites written. Not done: F sample, history lane, rewrite lanes, shipped ladder, tables | `ladder/PAUSE-STATE.md` | can the shipped index surface the answer for an informed query; how much a query-rewriting step recovers |
| Re-ranker test (A5 U6-lite) | `rerank/` | both models downloaded; no stage-0 check, no passes | `rerank/PAUSE-STATE.md` | does rUv's best-measured re-ranker lift files that are found but ranked too low |
| Set G (120 amateur questions) | `instrument/G/` | 2 of 120 questions written and validated; about 75 gold passages located by the three authors (lists in their pause notes) | `instrument/G/PAUSE-STATE-G*.md` | enough amateur questions to detect a 10-point change |
| Slice build of the graph, need index, hierarchy, typed decision (A6) | none yet | rules hashed at 12:01 a.m. (v1.6.0, 84faed8e…); extraction pass NOT started | none | the RuVector-design candidates on a bounded slice |

Finished before the pause and not affected: gold-narrowness audit (`gold-audit/`), found-versus-answered split
(`answers/answers-gold-served.md`), confirmation set F retrieval (`rigF/`), ontology, history store, dependency
graph.
