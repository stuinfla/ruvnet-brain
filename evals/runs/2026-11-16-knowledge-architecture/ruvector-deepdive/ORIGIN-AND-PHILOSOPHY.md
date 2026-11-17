Updated: 2026-11-17 00:49:11 EST | Version 1.0.0
Created: 2026-11-17 00:02:22 EST

# RuVector: where it came from, what it is for, and what a "vector database" reading of it misses

Sources: rUv's gists (the 517 in `~/RVF-KnowledgeBases/ruvnet-brain-v2-work/src/_gists/`; 79 read in full by three
readers, notes with line numbers in `raw/G1-origin-gists.md` and `raw/G2-2026-gists.md`), the RuVector git
history from the first commit (`~/Code/RuVector_Clean`, 3,602 commits), the current README, ADRs and examples at
commit `979c31ac`, and the READMEs of agentdb, ruflo, agentic-flow, agenticow, RuLake and FACT
(`raw/G3-readmes-history-examples.md`). Quotations marked **V** were re-found by me with grep at the cited
line; others are as the readers reported them. Gists are cited as `id-prefix file:line`.

A caution that applies to the whole page: several of the long gists read as research output written for rUv
rather than by him. "In his words" here means published by him. And his own later writing corrects several
early claims; those corrections are listed in section 5 because they show which ideas are real today.

## 1. The short version

RuVector did not begin as a place to keep embeddings of documents. It began as the engine for **agent memory**:
what an agent did, what happened, what worked, and why. Search by similarity is one tool inside it. The ideas
it was built around are these: memory has structure (episodes, skills, causes), the store should change with
use, an answer should be rebuilt by following associations rather than fetched as a slab of text, a system
should know when things do not fit together and say so, and everything should be provable and reversible.

## 2. How it got here (dated)

| When | What rUv was building | Evidence |
|---|---|---|
| 2024 | No database. Memory as a discipline of the prompt: retrieve before every reply; knowledge written as a hypergraph document | gists `7831ac7e`, `d9c04cb0`, `18c4c692` |
| Oct 2025 | AgentDB: "Most memory systems were designed for data retrieval. AgentDB was built for **autonomous cognition**" (V). The stored unit is an experience: episode, pattern, causal edge, skill. ReasoningBank: score = 0.65 similarity + 0.15 recency + 0.20 confidence - 0.10 diversity penalty (V for the constants) | `36f60264 agentdb.md:37`; `0670d207 ReasoningBank.md:131` |
| 19 Nov 2025 | RuVector's first day: a fast Rust engine with the AgenticDB interface. "Reflexion, skills, causal memory = what agents need, not just embeddings" (V) | first README, commit `17203d113`; `f9b631ba Ruvector.md:183` |
| 26 Nov 2025 | The turn: "Traditional systems treat the index as passive storage ... The index itself becomes a neural network" (V) | `c5c4a191 ruvector-GNN.md:7` |
| Dec 2025 - Jan 2026 | More roles for the same substrate: self-optimising routing (SONA), structure by minimum cut, hyperbolic and mixed geometry ("Forcing everything into Euclidean space **wastes dimensions** and **distorts relationships**", V), coherence with refusal | `59a2a414`, `39e62715`, `48b42652 ruvector.md:100`, `e511e4d7` |
| Jan 2026 | "Vectors answer 'similar to what.'" Graphs answer connected to what, and why (V for the first sentence) | `8219cc41 rvlite.md:335` |
| Feb 2026 | RVF: "This is not a database format. It is an **executable knowledge unit**" (V). Project knowledge exported by kind into RVF segments | `636e0daa rvf.md:38`; `docs/adr/ADR-056-rvf-knowledge-export.md` |
| Mar 2026 | The shared brain: knowledge as signed containers with votes; Brainpedia: "A claim without evidence is a candidate. A claim with evidence is knowledge" (V) | `docs/adr/ADR-062-brainpedia-architecture.md:81` |
| Apr - Jun 2026 | ruLake ("Honest refusals beat confident lies", V), typed graph with vectors bound to node labels, MRAgent ("Memory is Reconstructed, Not Retrieved"), agenticow (memory that branches like Git, V) | `478f7899 README.md:21`; ADR-253; ADR-269, 270; `d6e2716a agenticow-gist.md:5` |
| Jul 2026 on | The README is rewritten around what is true today: "a Rust native substrate for fast local decisions and agent memory across sessions" (V) | `README.md:5` |

## 3. The principles, and what each rejects

1. **Memory is experience with outcomes, not text.** The unit carries what was tried, what happened, and how
   well it went. Rejected: a store that only knows what a passage says. (`36f60264`; agentdb controllers
   `ReflexionMemory.ts`, `SkillLibrary.ts`, `CausalMemoryGraph.ts`.)
2. **Reconstruct, do not retrieve.** Find the cues a question touches, walk cue to tag to content, prune,
   stop when the evidence is decisive. The README's own table says: "Follow Cue, Tag, and Content associations
   instead of retrieving one flat chunk" (V, `README.md:444`). Rejected: top-k chunks.
3. **Structure answers "connected to what, and why".** Graphs, hyperedges, causal edges, typed nodes with
   vectors bound to them. Rejected: a flat pile of points.
4. **Geometry should fit the data.** Hierarchies belong in hyperbolic space; sets compare with transport
   distances. Rejected: one Euclidean space for everything.
5. **Coherence before confidence.** "Most systems try to get smarter by making better guesses. I am taking a
   different route. I want systems that stay stable under uncertainty by proving when the world still fits
   together and when it does not" (V, `e511e4d7 coherence_engine.md:3`). Rejected: a confidence score as the
   gate. In its place: refusal with a recorded reason.
6. **Abstaining is a correct answer.** MRAgent is scored so that a confident wrong answer is worse than "I
   don't know" (ADR-270). ruLake refuses rather than serve a stale answer.
7. **Freeze the store, evolve the harness.** How the store is searched is a set of settings tuned by an
   evolutionary loop on a training split and judged on a held-out split (ADR-269, 270; MetaHarness Darwin).
   Rejected: hand-tuned retrieval settings, and tuning on the test questions.
8. **Learning comes from recorded outcomes, as data.** Shortcut edges along paths that worked, votes,
   promoted skills, nightly discovery of causal links. The README is explicit: "Learning happens from recorded
   outcomes and feedback, not from reads alone" (V, `README.md:231`).
9. **Boundaries carry the information.** Minimum cut is the recurring instrument: to find structure, to bound
   a context, to admit a memory, to split a codebase into modules.
10. **Memory is versioned.** Branch, change, check with a deterministic external test, promote or discard.
    agenticow's ablation found a cheap language model as judge did worse than a plain vote (its README).
11. **Everything carries proof.** Witness chains on writes, lineage of derived stores, signed receipts,
    "the model can remain probabilistic. The authority boundary cannot" (V, `d08d9c00 rvforge-overview.md:150`).
12. **One retrieval shape is not enough.** "most RAG libraries ship one retrieval shape (dense top-k) and call
    it done" (V, `d8884ebd embeddings-announcement.md:5`). Different question shapes get different paths.
13. **Sometimes no vectors at all.** FACT answers by cached, deterministic tool calls where a question has a
    structured answer.
14. **The application decides what is worth remembering** (V, `README.md:341`). The substrate supplies the
    primitives; it does not decide what is knowledge.

## 4. Vocabulary

| Term | Meaning in rUv's usage | Where |
|---|---|---|
| Cue / Tag / Content | The thing a question touches / the association it leads to / the stored substance | `examples/mragent/agent/memory.mjs` |
| Reconstruction | Building an answer by traversal, with pruning and early stop | ADR-269, 270 |
| Reflexion, skill, causal edge | An episode with self-critique; a promoted successful pattern; a measured cause-effect link with uplift | agentdb controllers |
| ReasoningBank | Distilled strategy items from trajectories: retrieve, judge, distil, consolidate | `0670d207`; agentic-flow |
| SONA | Self-optimising layer: small adapters, forgetting protection, pattern bank | `crates/sona` |
| Consolidation / replay | Laying shortcut edges along paths that proved right | `examples/mragent/agent/consolidate.mjs` |
| Coherence, residual, gate | How well facts on a graph agree; the disagreement energy; permit / defer / deny | `prime-radiant`; `cognitum-gate-*` |
| Witness, receipt, lineage | Tamper-evident record of what was written, what was returned, what a store derives from | `rvf-runtime`; `ruvector-retrieval-receipt` |
| Cognitive container / executable knowledge unit | One RVF file carrying data, index, model, code and proof | `636e0daa`; ADR-030 |
| Segment | A typed part of an RVF file; knowledge of one kind | `rvf-types` |
| Branch, checkpoint, promote | Copy-on-write memory workflow | agenticow; RVF |
| Freeze the model, evolve the harness | Tune how memory is used, not the memory | ADR-269 |
| Boundary-first | Look for the cut where structure changes | the `*-boundary-discovery` examples |
| Brainpedia page | A canonical knowledge page that exists only through evidence-linked deltas | ADR-062 |
| Claim ladder, scoped novelty | rUv's practice of grading his own claims | agenticow README; `86d69687` |

## 5. What rUv himself has corrected (so the design does not lean on it)

- "Learns from every query" was withdrawn: reading memory does not change learned weights (V, `README.md:461`).
  A commit of 2026-10-24 (`f1484553a`) records that the MicroLoRA output had been the same for every input and
  the forgetting protection had no effect (reader's report). My probe of the current package still shows almost
  no movement through the Node interface (`probes/sona-probe-output.txt`).
- The README lists, under known boundaries, that GNN re-ranking, MRAgent and Darwin are not part of the
  default search, that quantisation is stored but not applied, and that compaction is not wired (reader's
  report of `README.md:587-609`).
- ADR-123 audited the live shared brain in March 2026: 2,064 memories, 943,000 edges, and most of the
  cognitive layers idle (reader's report).
- MRAgent's numbers are from a simulation of RuVector's semantics with a made-up concept embedding; testing on
  a live store is listed as the next step (ADR-269, 270). I ran it: 14 of 14 tests pass; accuracy 50% to 70%,
  hallucination 0.17 to 0.03 on its 60 generated tasks (`probes/mragent-benchmark-output.txt`).
- agenticow's ablation: reflexion cost 2.85 times more for 8 points less; plain retrieval added nothing in that
  setting; "leverage, not intelligence" (reader's report of its README).
- The speed-up headlines of the multi-vector work come with near-zero recall before re-scoring (`627c64b9`).
- No gist reports retrieval quality on a named real text corpus. The only real-text measurements in the whole
  stack are ruflo's BEIR runs and agentdb's LongMemEval runs (`02-NATIVE-EMBEDDING-OPTIONS.md`, table 2), and
  rUv's own production brain ranks by keyword first.

## 6. What a "RAG and vector database" reading misses

1. The question to ask of a corpus is not "what chunks, what embedder" but **"what are the things, what links
   them, and which of them can a person's words actually touch?"**
2. The first hit is not the answer. It is a **cue**. The answer is what the cue leads to.
3. A project's knowledge has **kinds** (identity, taxonomy, decisions, dependencies, timeline, patterns,
   lessons), and rUv's own export of RuVector's knowledge stores each kind separately in one file (ADR-056).
4. **"I don't know" is designed in** and scored, and a refusal carries its reason.
5. The retrieval settings are **evolved against a held-out set**, by a loop rUv ships.
6. Learning is **edges and votes written after outcomes**, on a branch that can be dropped.
7. A hierarchy is a first-class object with its own geometry.
8. Proof of what went in, and of what came out, is part of the format.
9. And the honest other half: the similarity engine underneath is ordinary, most learning layers are young or
   idle, and the parts measured on real text say keyword search and a re-ranker do the heavy lifting. The
   unconventional design is rUv's direction and partly his shipped code; its value for this corpus is exactly
   what the experiments have to establish.

## 7. What was not read

- About 440 of the 517 gists (those not about memory, knowledge, vectors, graphs or learning by description).
- Issues, pull-request discussions and release notes on the hosting site (the history store of the lead's run
  holds them; they were not mined for philosophy).
- Public talks and posts (not on this machine).
- About 30 example folders with no README.
