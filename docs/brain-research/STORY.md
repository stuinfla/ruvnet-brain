Updated: 2026-11-17 00:42:00 EST | Version 1.0.0
Created: 2026-11-17 00:42:00 EST

# The story: from the first idea to the November measurements

How the Brain came to store and search knowledge the way it does, in dated chapters. Times are Eastern. "RUN"
means `evals/runs/2026-11-16-knowledge-architecture/`. The longer, fully cited accounts this page condenses are
`RUN/history/STORY.md`, `RUN/history/HISTORY.md`, `RUN/history/BISECT.md` and
`RUN/ruvector-deepdive/ORIGIN-AND-PHILOSOPHY.md`. Where those files mark a quotation as second-hand, it stays
second-hand here.

Words: a **store** is the searchable copy of one repository. A **card** is a short hand-written description of
what one tool is for. A **gate** is a check that must pass before a release. **Repository-level** means "it
pointed at the right project"; **file-level** means "it returned the file that holds the answer".

## The flow line

| Date | Decision | One-line reason | What replaced it |
|---|---|---|---|
| 2025-11-19 | rUv starts RuVector as agent memory, not a document index | "what agents need, not just embeddings" | still his direction |
| 2026-06-13 | Build template: 4,000-character chunks, two embedders | an agent's port of earlier scripts; never tested | nothing; still the build |
| 2026-06-27 | "Effectiveness first": sharpest retrieval regardless of size | owner directive | promised benchmark never run |
| 2026-06-28 | Keep bge-base-768, add the ms-marco reranker | 12 questions on one repository | still shipped |
| 2026-07-19 | Global keyword search reverted | 40 against 44 of 48 named questions | overturned by blind tests in November |
| 2026-07-27 | Cards answer before any search | search took 91 to 151 s | still shipped |
| 2026-07-28 | Small MiniLM build retired | download size | still shipped; it was the only build with a header |
| 2026-07-30 | Route or refuse | no reason recorded | still shipped |
| 2026-10-01 | Keyword lane built, shipped off | +2.1 s per question | never switched on |
| 2026-11-15 | Pilot: smaller chunks with headers, real keyword index | right file 3.5% | the pre-registered run |
| 2026-11-16 | Blind measurements: keyword + history adopted, current vectors and cards not | 8 of 164 shipped, 78 of 164 keyword | the research-first plan |
| 2026-11-17 | Research first: rebuild around rUv's own memory design | no rUv retrieval embedder exists; problems must be linked to capabilities | under test for v5 |

## Chapter 1. rUv's path to RuVector (2024 to 2026)

**What he built and why.** In 2024 rUv had no database: memory was a discipline of the prompt. In October 2025
AgentDB stored experiences (episodes, skills, causes), "built for autonomous cognition". RuVector began on 19
November 2025 as a fast Rust engine for that memory: "Reflexion, skills, causal memory = what agents need, not
just embeddings". A week later: "The index itself becomes a neural network". Then hierarchy in its own
geometry, graphs ("Vectors answer 'similar to what'"), the RVF file as "an executable knowledge unit" with
project knowledge stored by kind (ADR-056), signed shared knowledge where "A claim without evidence is a
candidate", and in 2026 MRAgent, "Memory is Reconstructed, Not Retrieved".

**His design ideas.** The stored unit is a thing with links and an outcome, not a passage. An answer is rebuilt
by walking from a cue to what it leads to. Knowledge is stored by kind. "I don't know" is a designed, scored
answer. Search settings are evolved on a training split and judged on a held-out split. Learning is edges and
votes on a branch that can be dropped. Everything carries proof.

**His own corrections.** "Learns from every query" was withdrawn; most learning layers are young or idle; the
similarity engine is ordinary; on real text his measurements say keyword search and a reranker do the heavy
lifting. He measured bge-base-en-v1.5 (the Brain's model) as rank 2 of 11 on one public test, and a larger bge
gave no lift.

**What the Brain knew of this at the time:** nothing. The first citation of his measurements in project memory
is dated 2026-11-15.

Source: `RUN/ruvector-deepdive/ORIGIN-AND-PHILOSOPHY.md` (sections 2, 3, 5); `RUN/history/HISTORY.md` (first
entry).

## Chapter 2. Before the Brain (December 2025 to mid-June 2026)

**Believed:** Claude, asked to build with rUv's tools, drifts to old patterns and invents APIs; a searchable
copy of his work would fix that. Earlier attempts (a chatbot, Postgres knowledge bases, then RVF files) named the
same failure. **Decided:** on 2026-06-13/14 an agent wrote the `rvf-kb-forge` template: 4,000-character chunks,
400 overlap, MiniLM plus an optional bge-base build. **Evidence at the time:** none; the template rated itself
68 of 100 and said it had not been run end to end. **Learned later:** these defaults were never tested and are
still the build. Source: `RUN/history/STORY.md` chapter 0; `RUN/history/HISTORY.md`.

## Chapter 3. The embedding model is chosen (June 27 to 29, 2026)

**Believed:** MiniLM-384 is "weaker on code lookups"; size does not matter. **Decided:** by the owner's directive
(ADR-0004, "maximize for effectiveness"), the sharpest retrieval regardless of size, with a promised benchmark of
a code-aware embedder and bge-large. On 2026-06-28 the agent kept bge-base-768 and added the ms-marco reranker.
**Evidence at the time:** 12 questions on one repository: MiniLM 49.5 / 81.8, bge 31.6 / 68.0, declared "not
comparable"; reranker +10 points. The first commit (2026-06-29) reported "named 47/48, by-description 27/28",
which measured which repository or card answered. **Learned later:** the benchmark was never run; the one
like-for-like pair favoured MiniLM; the 8-bit model weights were the library example's default, never compared;
and the small build embedded a title and path header while the big build embedded bare text, a difference
nobody recorded. **Why the next step followed:** the gate of record became repository-level, and that is what
was optimised. Source: `RUN/history/HISTORY.md` (June 2026); `docs/adr/0004-effectiveness-first.md`.

## Chapter 4. July: speed, a keyword attempt, and the turn to cards and routing (July 7 to 31)

**Believed:** "The fix is retrieval-layer, not re-encoding". Keyword search does not help. **Decided** (all by agents; the route-or-refuse change has no recorded reason): model
revisions pinned (07-07); a global keyword-plus-meaning search tried and reverted (07-19), kept for meeting
transcripts; low-scored results withheld (07-20); cards answer before search (07-27); MiniLM build retired
(07-28); a card router (07-28); route or refuse (07-30). **Evidence at the time:** keyword: 40 against 44 of 48
questions that name their repository, with a simple keyword search, the regime in which rUv's own notes say
fusion gets worse. Speed: 69 stores, searches of 91 to 151 seconds, two thirds of cold queries timing out. Route
or refuse: no reason recorded. **Learned later:** rUv reported on 2026-07-28 that the Brain "manufactured things
he had not built" because cards were treated as proof; the August 8 release answered "Searched 0 RuvNet repos"
for 45 of 80 sample questions and found the right file for 0 of 60. **Why the next step followed:** speed
forced a change, and cards were the fastest one. Source: `RUN/history/HISTORY.md` (July 2026);
`RUN/history/BISECT.md` sections 1, 6.

## Chapter 5. August and September: gates are changed while the numbers stay flat

**Believed:** the Brain recalls at about 98%. **Decided** (agents, except the targets, which are the owner's): the per-repository pool went from 8 to 64 (09-07, no
reason recorded); the evaluation was moved onto the same refusing path and re-recorded at 80 of 80 (09-09); an
identifier lane was added (09-11); the owner's 95%-per-repository criterion, measured at 59.0%, was removed as a
blocking gate (09-15); the owner set 98% recall and 95% quality as targets (09-29). **Evidence at the time:**
identifier lane 0.9433 against 0.9124 (measured); the nightly file-level series with the repository named began
at 162 of 182 (89%). **Learned later:** the "98%" the owner had been told was the pass mark of a 19-question
sample check shown on 2026-09-30 to be "a coin flip"; with credit for abstained answers removed, 80 of 80 became
48 of 80. Source: `RUN/history/HISTORY.md`; `RUN/history/BISECT.md` sections 2, 3, 8.

## Chapter 6. October: the newcomer is tested for the first time

**Believed:** the right file is in the candidates and only the ordering is wrong. **Decided** (owner and agent, ADR-0099): on 2026-10-01, a
first test in a newcomer's words. A keyword lane and a learned judge shipped switched off; moving the
abstain threshold was rejected by the owner; a different embedder was dismissed as "Not a rUv tool" without a
measurement. **Evidence at the time:** right file in top 5 for 4 of 206; the reranker scored the verbatim gold
below zero for 32 of 35; keyword lane 10 of 206 at +2.1 s. **Learned later:** the fix written down (build the
keyword index with the corpus) was never built; a 2026-10-16 branch found test questions inside the index and
question-specific code worth 10 points, and did not ship. Source: `RUN/history/HISTORY.md` (October 2026);
`docs/adr/0099-self-learning-retrieval.md`.

## Chapter 7. November 15 to 17: measurement with answer keys, then research first

**Believed (owner, 11-16):** "it wasn't this bad months ago". **Decided** (an agent lead under rules hashed in advance; the owner ordered the redirect): a pilot on 11-15; a pre-registered run
on 11-16; on 11-17 at 12:05 a.m., by owner order, research before more
measurement. **Evidence:** 73.7% of passages are longer than the model reads and 50.0% of tokens are never
embedded. Shipped: right file in top 5 for 4 of 113 and 8 of 164. Same model, rebuilt chunks: 26 against 3 of
76. Keyword over rebuilt chunks: 78 of 164 blind. The current vectors added nothing on three question sets. A
history store (commits, issues) met its rule; cards failed their confirmation. Answers 75.7 of 100 against 25.4
with no tool; amateurs remain the unsolved group. The bisect found no file-level measurement before 2026-09-30,
and 0 of 60 on the August release. **What the research changed:** no RuVector-native retrieval embedder exists;
rUv's design links problems to capabilities to files and walks those links, which is what an amateur's question
needs. A dated survey of 2025-2026 methods (`RUN/SURVEY-2026.md`) adds that on public tests of vague,
problem-only questions every disclosed result above 50 nDCG@10 uses a language model in the loop, and no
public system is near 98% on such questions. **Why the next step followed:** the proposal in
`EMBEDDING-RECIPE.md` section (f), under test for v5. Source: `RUN/DECISIONS.md` D0 to D19; `RUN/REPLAN.md`;
`RUN/history/BISECT.md`; `RUN/SURVEY-2026.md` section (c).

## Chapter 8. Where it stands

The recipe that ships (R3) was fixed by a template, a directive and a 12-question test, and has not changed since
2026-07-28. What changed most was the path a question takes, for speed. The measurements now say why it finds
the right file so rarely, and what helps on blind questions. What would reach amateurs is proposed, not proven.
From here on, any change to the recipe must be written on these pages in the same change (ADR-109).
