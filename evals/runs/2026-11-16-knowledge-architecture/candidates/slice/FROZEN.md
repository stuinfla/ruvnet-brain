Updated: 2026-11-17 01:47:00 EST | Version 1.0.0
Created: 2026-11-17 01:47:00 EST

# Slice build: FROZEN settings (look 1), written before any blind slice score

slice result, not a whole-corpus result. Stores: agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo.
Look 1 (A8.3, interim): tier1.done appeared 1:29 a.m. ET; unit snapshot 1,617 of 9,029 units (sha256 5f9a82ea...). Frozen 1:47 a.m.
ET at 1-minute load ~25. Every setting below was chosen on tuning questions only (dev questions with gold wholly in the 7 stores,
held-out generated questions, and dev questions with gold wholly outside the 7 stores as unanswerable tasks); no E, F or G question
was read except id / stratum / asker / knowledge_type / question / sources to build the slice lists. Look 2 rebuilds with THESE
settings (same embedder, genomes, landing, rules) on the tier-2 snapshot.

## 1. Stage 0 (clause G1), look-1 build, measured (stage0-look1.json, stage0-mragent.json)

| check | gate | measured | reading |
|---|---|---|---|
| operator known-answer: harness --selftest replays the crate's own test `search_then_traverse_ranks_and_expands` | pass | pass (d1, d2; topics ai, ml) | operator sound |
| MRAgent port reproduces rUv's benchmark (A7.15 a) | 50.0% / 70.0%, halluc 0.17 / 0.03 | 50.0% / 70.0%, 0.17 / 0.03, output identical to rUv's harness | port sound |
| need index: stored question -> own file rank 1 (A6.4) | >= 99% | 1,992 / 2,000 = 99.6% | pass |
| need index: held-out generated question -> own file within 5 (A6.4) | >= 90% | 401 / 934 = 42.9% (right PACKAGE within 5: 495 / 934 = 53.0%) | FAIL: build not sound for this element |
| graph: RuVector crate description -> its README rank 1 (A6.5), default genome | >= 95% | 130 / 324 = 40.1% (within 5: 158; crate's package within 5: 158 = 48.8%; lands on the crate: 150) | FAIL: build not sound for this element |
| capability's own definition lands on it and reaches its README (A7.15 b; no rank in the rule) | >= 95% | 360 / 500 = 72.0% (lands 366; README reached 378; rank 1 203; within 5 351) | FAIL |
| R24 centroid landing: right capability first by centroid vs nearest cue (A12.21) | centroid > cue | 199 vs 337 of 920 | FAIL (centroid lower) |
| R19a: gold file survives pruning with cue / max, problem-only questions sharing no content word with the file (A13.22) | >= 90% | strict n = 41: reached at all 22; of those surviving: content 21, cue 22, max 22 (100% of reached); 22 / 41 = 53.7% of all | survival among reached passes; the losses are reach, not pruning |
| fusion agreement, ported fusion (default) vs rUv's hybrid_search_text, identical top 4 seeds | reported | 78 / 100 (arm depth 64 vs 36) | as measured |

Consequence under G1 / G2: the need index and the graph lane are scored once at look 1 as A8.3 asks, FLAGGED "stage 0 failed for
that element"; no negative verdict on either design can be drawn from this look.

## 2. Tuning results and the frozen choices

Embedder (A5.3 + A9.2), need index alone, any-gold@5 (screen-look1.json):
| model | dev novice slice (n=22; 17 with a unit) | held-out generated (n=500) |
|---|---|---|
| all-MiniLM-L6-v2 | 9 (40.9%) | 199 (39.8%) |
| **mdbr-leaf-ir** | 10 (45.5%) | 203 (40.6%) |
| bge-small-en-v1.5 | 10 (45.5%) | 206 (41.2%) |
| bge-base-en-v1.5 (incumbent) | 9 (40.9%) | 206 (41.2%) |
Rule: smallest within 3 points of the best on both -> **MongoDB/mdbr-leaf-ir** (q8, transformers.js 4.3.2, 768 dims, query prefix
"Represent this sentence for searching relevant passages: ", documents no prefix; card quote in embed-lib.mjs).

Landing (A12.21), rUv's loop once per landing, held-out tuning half (n=304), accuracy = gold file in the lane's 5 served slots:
| landing | default genome | evolved genome |
|---|---|---|
| cues | 0.562 (risk 0.507) | 0.536 (risk 0.487) |
| centroids | 0.398 | 0.434 |
| both (centroids first) | 0.398 | 0.434 |
Rule (fixed before): highest evolved held-out accuracy -> **landing = cues**.

Genomes FROZEN (landing cues):
- default (rUv's baselineGenome + landing + evidence at MRAgent's own value), sha256 1a007fc5...:
  `{"cueK":4,"efSearch":64,"hybridAlpha":0.5,"fusion":"rrf","traversalDepth":2,"tagFanout":3,"pruneThreshold":0.1,"maxContent":8,"haltConfidence":0.9,"rerank":"gnn","promptStrategy":"evidence-first","abstainThreshold":0,"landing":"cues","evidence":"content"}`
- evolved (rUv's loop, Darwin 0.14.0 mapLimit/paretoFront, seed 20261117), sha256 1c572fe7...:
  `{"cueK":4,"efSearch":24,"hybridAlpha":0.4115956573747099,"fusion":"dbsf","traversalDepth":1,"tagFanout":1,"pruneThreshold":0.15,"maxContent":4,"haltConfidence":0.9,"rerank":"none","promptStrategy":"evidence-first","abstainThreshold":0.1,"landing":"cues","evidence":"content"}`
  Held-out tuning half: evolved 0.536 vs default 0.562 (the evolved genome is LOWER on the tuning test half; dev novice 5/11 vs
  6/11). Dead-setting check on train: haltConfidence does not change the score; all other 12 settings do. Evidence gene: the loop
  kept `content`.
- Primary genome for the A6.5 / A7.15 rule lines = the evolved (tuned) one, as fixed before tuning (G1/G2); the default is scored
  beside it and R21 compares them on blind amateurs.

A11.2, with vs without authored cues, tuning questions (all 609 / held-out half 304), accuracy (compare-*.json):
default-cues 0.513 / 0.562 with, 0.511 / 0.558 without; evolved-cues 0.516 / 0.536 with, 0.513 / 0.540 without. Authored cues stay
in the one frozen design (A11.2).

Authored scan counts (authored-counts.json): 3,047 records = 2,698 cue rows + 349 playbooks, 0 dropped by the verbatim quote check;
in the look-1 graph 2,275 distinct authored cues (247 possibly stale) and 349 playbook nodes. Per store (cue rows: arrow / table;
playbooks): see authored-counts.json.

G4 (8-word overlap) for this build's cue / tag text vs D, E, F, G questions (leak-g4-look1.json): 24 hits on 8 questions
(E3-08, E4-36, F2-31, F2-33, G1-19, G2-14, X1-31, X5-02), all generic phrases such as "how do i stop an ai agent from"; these
questions are reported both ways if any of them changes a rule line.

## 3. Build provenance and versions
- Operator: rUv's `TypedGraph::search_then_traverse` + crate `Bm25Index` + `GraphDB` edges, ruvector-graph 2.3.5 from the RuVector
  snapshot 979c31ac (v2-work, copied; nothing in v2-work changed), standalone harness (slice-build/rust-src/slice-graph-harness),
  rustc/cargo 1.100.0, built offline, binary sha256 a48b91e5.... The walk is a PORT of MRAgent (A7.15), byte-identical on rUv's
  benchmark.
- @ruvector/rvf 0.4.12 (0.4.x, per-vector metadata persisted); @metaharness/darwin 0.14.0; transformers.js 2.17.2 (MiniLM, BGE) and
  4.3.2 (leaf-ir), one model per process.
- Look-1 build files (slice-build/look1): need-leaf-ir.rvf 4d2a5d8b...; items 5b28dc0d...; graph nodes 17a55c35..., edges
  eeb402f4..., vecs 8ea7e1f4..., files.json 428345d7..., files.f32 7d8a43d6...; authored.jsonl 6a588f7c....
  Graph: 42,732 cues (question 8,735, problem 19,083, definition 6,457, name 5,926, authored 2,275, bridge 256), 7,267
  capabilities, 1,536 topics, 81 decisions, 777 packages, 349 playbooks, 2,086 files, 103,932 edges, 430 ontology cards.
- The A14.2 CAPABILITIES export (capabilities-section.G.jsonl) uses these frozen settings (evolved genome, landing cues).

## 4. Fixed engineering choices (decided before any blind score; approved by the lead)
1. Served result = lexical lane first 5 distinct files + the other lane's next 5 distinct files not already served (10 in all);
   control = lexical lane first 10 files (G6 equal slots). History section = first 3 history items (system b).
2. Lexical lane = the recorded 24-store lane (rigE / rigF / rigG `v2-bm25.jsonl`), unchanged. Sensitivity (not a rule row): the
   same lane run to depth 1,000 and filtered to the 7 slice stores before taking files.
3. A manifest unit maps to its text file (README or entry file, `text_path`).
4. Unanswerable tuning tasks for the abstain gene = dev questions whose gold lies wholly OUTSIDE the 7 stores.
5. All embedders at 8 bits (the Brain's setting); A8.5's full-precision test is separate and later.
6. Unit set frozen per build by `units.snapshot.jsonl`.
7. Need index: one vector per summary and per kept newcomer question, metadata file + kind, RVF exact scan, cosine; query =
   nearest 300 vectors collapsed to files in rank order.
8. Graph: Cue nodes (newcomer question, capability name, "name: definition", problem statement, ontology problem phrasing / alias /
   bridge, authored row) with vectors (CueEmb); Capability nodes merged on normalised name + package (package = deepest manifest
   folder containing the unit path, else the store), vector = mean of their cue vectors (A12.21); Topic / Decision per unit;
   Package; Playbook; File. Edge types `about` (cue -> tag), `documented_in` (tag -> file), `linked` (tag -> tag; relation kept:
   implemented_in, explains, part_of, depends_on (manifest, dev deps left out), has_playbook, extracted / ontology link types).
9. Content relevance (memory.mjs:289 form) 0.6 x cosine(query, file vector) + 0.4 x MRAgent sparse score; file vector = mean of
   the file's unit-summary vectors (no unit: embedded path words); file tokens = path + summaries.
10. Loop details: POP 16, 12 generations, elite 5, 2 restarts, memetic polish over optimize.mjs's grid + evidence, fitness
    optimize.mjs `scalar`, 3-fold CV mean minus half the range, acceptance gate as optimize.mjs, class-stratified half split,
    held-out generated questions capped at 500 (seeded), seeded random in place of Math.random. "Correct" = a gold file in the
    lane's 5 served slots.
11. A7.15 (b) reading (decided after a non-blind 233-unit trial): pass = lands AND README anywhere in the reconstructed list.
12. A11 parser rules, stale handling (score x 0.9 in both arms), playbook export (graph folder playbooks.json): as in
    authored-scan.mjs and graph-build.mjs.
13. A12.21: no near-tie abstain added (lead, 1:00 a.m.: the phrase described ADR-527, it is not rule text).
14. A13.22 evidence gene: content | cue | max, a 13th gene; default keeps MRAgent's `content`; the frozen evolved genome kept
    `content`.
15. A14.1 package-level hit: deepest owning manifest from graph/nodes.jsonl, else repository + top-level folder; descriptive.
16. Stability (A5.13): three separate processes over the blind questions; same first five lane files AND same five added files.
17. Load rule: every embedding batch and query waits while the 1-minute load is above 60 (30 s re-check), 4 ONNX threads, nice 10.

## 5. Addendum for look 2 (A15, lead 1:52 a.m.; written 1:56 a.m. ET, after look 1 was scored, before look 2 is built)
Look 2 = the same frozen settings (leaf-ir, landing cues, the two genomes above, all rules of section 4) rebuilt on the tier-2 (or
4:30 a.m.) unit snapshot, with ONE change: `DETERMINISTIC=1`, i.e. every node's adjacency lists (`documented_in`, `linked`, and
the `about` links returned with a seed) are sorted by node id, and seeds with equal scores are ordered by node id. Cause: rUv's
GraphDB returns a node's edges in a different order in each process (look1-checks.md). On the look-1 build this made all three
lanes 192/192 identical across three processes and changed the served first five for 71/192 (default) and 23/192 (evolved)
questions; those trial runs were not scored. Look-1 numbers stay as scored. Every look-2 table carries the every / some / no gold
unit split for amateurs.
