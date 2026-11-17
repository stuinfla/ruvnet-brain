# Slice build: frozen settings (DRAFT; becomes FROZEN.md with times, values and hashes filled before the first blind score)

slice result, not a whole-corpus result. Stores: agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo.

## Fixed engineering choices (decided before any blind score; approved by the lead at 12:2x a.m. as listed in note 1)
1. Served result = lexical lane first 5 distinct files + the other lane's next 5 distinct files not already served (10 in all);
   control = lexical lane first 10 files (G6 equal slots). History section = first 3 history items (system b).
2. Lexical lane = the recorded 24-store lane (rigE / rigF / rigG `v2-bm25.jsonl`), unchanged. Sensitivity (not a rule row):
   the same lane filtered to the 7 slice stores, if run.
3. A manifest unit maps to its text file (README or entry file, `text_path`), the file a reader would open.
4. Unanswerable tuning tasks for the abstain gene = dev questions whose gold lies wholly OUTSIDE the 7 stores (tuning data).
5. All need / cue embedders at 8 bits (quantized), the Brain's setting; A8.5's full-precision test is separate and later.
6. Unit set of a build is frozen by a snapshot (`units.snapshot.jsonl` in the build folder); every step of a build reads it.
7. Need index: one vector per summary and per kept (not held-out) newcomer question, metadata file + kind, in RVF
   (`@ruvector/rvf`), exact scan (`forceExact`), cosine; query = nearest 300 vectors collapsed to files in rank order.
8. Graph (rUv's `TypedGraph`, ruvector-graph 2.3.5 from RuVector snapshot 979c31ac, built offline in a standalone harness):
   Cue nodes (newcomer question, capability name, "name: definition", problem statement, ontology problem phrasing / alias /
   everyday bridge) with vectors (vector type CueEmb); Capability nodes with a vector of "name: definition" (CapEmb), merged on
   normalised name + package (package = the manifest whose folder is the longest prefix of the unit's path; else the store);
   Topic (non-ADR unit) / Decision (ADR unit) tags; Package nodes (manifests of the 7 stores); File content nodes.
   Rust edge types: `about` (cue -> tag; U1's solved_by for problem cues), `documented_in` (tag -> file, MRAgent REFERENCES),
   `linked` (tag -> tag, MRAgent LINKED_TO; kept relation: implemented_in, explains, part_of, depends_on (manifest edges, dev
   dependencies left out), extracted and ontology link types with quotes). Ontology cards (private dropped, 430 with a source in
   the 7 stores) are seed tags under the same merge rule.
9. Provenance (G2): rUv's code runs the cue vector search and first hop (`TypedGraph::search_then_traverse`, vector type CueEmb,
   traverse `about`), the keyword arm (the crate's `Bm25Index` over cue text) and every adjacency lookup (`GraphDB` outgoing
   edges). The walk (fusion, decay 0.7, prune, corroboration re-rank, early stop, abstain on raw relevance) is a PORT of rUv's
   MRAgent store interface and harness (A7.15 prescribes a port); the port reproduces rUv's benchmark byte for byte
   (stage0-mragent.json). Fusion agreement of the port (default genome) with rUv's `hybrid_search_text`: reported as measured
   (the two fetch different arm depths: efSearch vs max(4k, k+32)).
10. Content relevance in the walk (memory.mjs:289 form): 0.6 x cosine(query, file vector) + 0.4 x MRAgent sparse score(query
    tokens, file tokens); file vector = normalised mean of the file's unit-summary vectors (files reached only through a card source
    or a package README with no unit: the embedded path words); file tokens = path + summaries.
11. MRAgent's twelve settings: default = rUv's baselineGenome (harness.mjs:20-40). Evolved = rUv's loop (optimize.mjs) with
    Darwin `mapLimit` / `paretoFront` from @metaharness/darwin 0.14.0, POP 16, 12 generations, elite 5, memetic polish grid
    (optimize.mjs:204-217), fitness = optimize.mjs `scalar`, 3-fold cross-validation, mean minus half the range, acceptance gate as
    optimize.mjs; class-stratified half split of the tuning questions (train for evolution, other half for the judgement, R21 /
    rule of the brief); seeded random (20261117) in place of Math.random. "Correct" in the loop = a gold file within the lane's 5
    served slots (promptStrategy window applies within them).
12. Primary genome for the A6.5 / A7.15 rule lines = the evolved (tuned) setting (G1/G2 require the tuned setting); the default is
    scored beside it for R21.
13. A7.15 (b) reading, decided after a non-blind trial build (233 units) showed rank 1 = 23.4%: A7.15 (b) names no rank, so pass =
    lands on the capability AND its README appears anywhere in the reconstructed list; rank 1 and within 5 are reported beside it.
    A6.5's crate check keeps rank 1 as written.
14. Embedder choice A5.3 (+A9.2): candidates all-MiniLM-L6-v2, mdbr-leaf-ir, bge-small-en-v1.5, bge-base-en-v1.5 (incumbent);
    need index alone, any-gold@5, on dev novice slice questions and on held-out generated questions; the smallest model within 3
    points of the best on BOTH.
16. A11 authored cues and playbooks (authored-scan.mjs, plain parser, no model): markdown of the 7 stores (dot folders except
    `.claude-plugin`, node_modules, target skipped); sections under trigger headings (I need to / when to use / use when / decision
    guide / which ... use / quick start / common workflows / getting started / choosing), plus any table whose own header has a
    "When to use / Use when / Use case / Best for / I need / I want" column. Arrow rows and table rows -> cue kind "authored" (need
    text = the row's need field, markdown stripped; the raw field must be found verbatim in the quoted row). Targets -> package node
    by normalised name (same store first), else a capability node (name | store) documented in the authored file. Playbooks = a
    heading in a quick-start / workflow section with >= 2 numbered items or >= 2 code blocks; steps in order with a command
    (inline code, else the next code block's first non-comment line); node label Playbook, linked to the owning package, documented
    in its file; its title is a cue unless it is generic ("Quick start", "Usage", ...). Possibly stale (A11.4) = the file names an
    old package with an alpha tag (pattern in stale-names.json); such cues are ranked below (score x 0.9, re-sorted) in both arms.
    Counts: authored-counts.json. Playbooks exported as a section: graph folder playbooks.json (title, ordered steps with commands,
    source path, lines, quote, last commit date).
17. A12.21 landing: Capability vector (CapEmb) = normalised mean of the vectors of the cues linked to it (a capability with no cue
    keeps its name: definition vector). Landing options: cues (MRAgent), centroids (rUv's search_then_traverse over CapEmb; a
    capability seed lands on itself; keyword arm = the crate's Bm25Index over capability text), both (centroids first, then cues).
    The rule text names no near-tie abstain; none is added beyond MRAgent's abstainThreshold. Choice of landing on tuning questions:
    rUv's loop is run once per landing; the landing whose evolved genome has the highest accuracy on the held-out tuning half is
    frozen (tie: higher risk score). With / without authored cues (A11.2) reported on tuning questions only.
18. A13.22 evidence gene (a deviation from rUv's harness as shipped, added by A13): evidence = content (MRAgent: question-to-content
    similarity, carried evidence 1) | cue (the seed's own vector score from rUv's operator, decayed along the path; a keyword-only seed
    gets its dense score, else the lowest dense score returned) | max. The same number is the raw relevance used for halt and abstain.
    It is a 13th gene in the loop (mutation probability 0.3, polish grid {content, cue, max}); the default genome keeps rUv's
    `content`. R19a stage 0 is reported before any blind recon score.
19. RVF: @ruvector/rvf 0.4.12 (0.4.x: per-vector metadata stored durably and returned on hits, types.d.ts RvfIngestEntry.metadata).
20. A12.21 near-tie: no near-tie abstain is added (lead, 1:00 a.m.: the phrase described ADR-527, it is not rule text); only
    MRAgent's abstainThreshold.
15. Load rule: every embedding batch and query waits while the 1-minute load is above 60 (30 s re-check), 4 ONNX threads, nice 10.
