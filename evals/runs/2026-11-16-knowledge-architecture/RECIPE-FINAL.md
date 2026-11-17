Updated: 2026-11-17 05:33:00 EST | Version 1.0.1
Created: 2026-11-17 01:16:00 EST

# RuvNet Brain v5: the retrieval recipe

What this page is: the recipe v5 builds, what was measured for it and against it, and the experiments still
owed. Every number has its file. Evidence paths are under `evals/runs/2026-11-16-knowledge-architecture/`
(RUN). Decisions: RUN/`DECISIONS.md` (D0 to D23). Rules, all fixed and hashed before their results:
RUN/`PREREGISTRATION.md` (R1 to R10, amendments A1 to A18).

Question sets (all blind except D): D = 113 development questions. E = 164. F = 80, gold found without keyword
search. G = 120, all asked by amateurs who describe only a problem (65 of them inside the 7-store slice).
H = 40 build-guidance goals with the author's own ordered plan as gold. "Amateur" = knows the problem, not the
product, the repository or the term. "Owner's measure" = a question counts when its answer is graded 8 of 10
or better by the blind judge in at least 2 of 3 runs.

## 1. The answer in one screen

- **The 93% gate is not met by anything measured.** Owner's measure with the admitted recipe: experts 16 of
  17 (set F); practitioners 24 of 31 (F); amateurs 17 of 32 (F) and 36 of 65 (G); build guidance 4 of 40 (H).
  The full rebuild "with a recipe that reaches 93%" is therefore NOT triggered. No threshold was changed.
- **What is admitted and built (Tier 1).** Passages rebuilt by symbol and heading; one keyword lane over
  everything with rUv's own Lucene analyser; a history lane; results in sections with a hard size cap; an
  explicit "nothing matched"; no router, no cards answering in place of search. Against the shipped 4.7.28 on
  the same blind questions: right file on the first page 95 of 164 against 9 (E); answers 77.8 of 100 against
  23.8 with no tool (F). v5 wave one implements exactly this (commit 3dff2bc7, tag `contract-v1`) and
  reproduces the measured 40 of 76 development questions in its own test.
- **Which embedding model.** None. The admitted recipe has no vectors and no model download. A small model
  would be needed only for the "need index" of section 3; the registered screen chose `MongoDB/mdbr-leaf-ir`
  (2025, 8-bit) for it, with all four candidates within 5 points of each other.
- **Is anything RuVector-native.** No rUv-trained model for finding documents exists in RuVector, ruvllm,
  ruflo or agentdb (RUN/`ruvector-deepdive/02-NATIVE-EMBEDDING-OPTIONS.md`), so the embedder cannot be. What
  IS rUv's own in the admitted recipe: the keyword analyser (ruflo ADR-088). What was rUv's own in the tested
  design: the RVF store, `TypedGraph::search_then_traverse`, the cue-tag-content memory walk (MRAgent,
  ADR-269 / 270), the evolutionary settings loop (`@metaharness/darwin`).
- **The rUv-design slice (cue sentences, need index, graph walk), measured tonight.** It finds: right file
  among ten served files for 43 to 46 of 101 amateur questions against 18 for the keyword lane and 1 for the
  shipped Brain. It has not yet improved answers: two registered answer-level tests
  of capability descriptions were not met; a third test (ten files per result) is VOID because the host
  rejected results of that size and the model never saw them. The one valid test of its files at equal size (3 keyword + 2
  need-index files) gave 60.0% against 55.4% on the owner's measure, +4.6 [-6.2, 16.9]: rule A18 NOT MET; mean
  score +4.6 [1.2, 8.5] and fewer false claims (17 against 22) make it the first candidate for the next,
  larger instrument, not a part of the recipe.
- **A defect found in the design itself.** The host that delivers tool results rejects a result above its
  token limit: results of 51,000 to 60,000 characters were not delivered 95% to 97% of the time; results up to
  47,000 characters always were. The 60,000-character cap in this recipe's first version (and in v5 commit
  3dff2bc7) is therefore too high. The cap is now 44,000 characters and 20,000 estimated tokens, enforced by
  the server, with a worst-case test.
- **What the night changed about the route.** Finding the file was assumed to be the bottleneck for amateurs.
  Measured: an answering model that searches several times in its own words already recovers much of it (55%
  on the owner's measure on questions whose first keyword page held the answer for 8%). The result must stay
  small enough to be delivered, so every added lane competes for the same few slots. Guidance (10%) was not
  moved by any layer tried.

## 2. Tier 1: admitted; v5 builds this (work packages 1, 4, 5: done and integrated)

### 2.1 What is stored

| Store | Unit | How it is built | Index | Evidence |
|---|---|---|---|---|
| Passages (`lexical.db`) | a symbol (function, type, module) or a heading section, at most 480 tokens, first line `repo > path > symbol` plus a label line; whole source bodies, not opening comments; folders named `v2` are not skipped | deterministic chunker in `packages/builder` (a port of the measured one: identical boundaries on 255 of 255 sample files against the reference's non-tree-sitter paths; code boundaries against the measured run's tree-sitter mode: not measured) | SQLite FTS5 over two fields (subject = header and label; body), rUv's Lucene analyser with Porter stemming plus identifier splitting, shared by builder and engine | same embedder, old passages to new: 3 to 26 of 76 (R2 met). Keyword lane, right file in the first 5: 40 of 76 (D), 78 of 164 (E), 41 of 68 (F), 15 of 120 (G) |
| History (`history.db`) | one unit per commit (all authors, version-bump commits dropped), and per issue, pull request, comment and release note written by the repository owner; split at 1,600 characters; header `repo > history > kind ref > date > title` | read-only calls to the hosting API in CI; tested here against recorded pages only | same index shape | finds 17 of 21 history questions on E, 8 of 12 on F (rule C2 met); no other lane finds more than 1 |
| Per-unit metadata | repository, path, line range, content hash, kind, language, standing, date, flag (hostile text is kept, flagged, and served with a FLAGGED line; secrets are redacted in place) | by the builder from file kind and location | columns | used by the result format |

No vectors, no embedding model, no re-ranker. Measured reasons: the current passage vectors add nothing to
the keyword lane on three blind sets (E 37 against 45 of 80; F 39 against 41 of 68; G 17 against 15 of 120);
two alternative passage embedders improved the vector lane on development questions without clearly improving
the fused result (blind pass not run); the re-ranker rUv measured as best ran at 1.5 pairs a second on this
machine under load, which cannot meet a 1.5-second budget (held; not a negative result).

### 2.2 How a question is answered

1. Every lane runs on every question. No router, no card lane, no refusal to search.
2. FILES: the first 5 distinct files of the keyword lane; each up to 8,000 characters centred on its best
   passage, with `repo/path`, line range, hash, standing, date.
3. HISTORY: the first 3 history items, each up to 2,000 characters.
4. A fixed closing line: code that exists outranks a measured result, which outranks a correction or negative
   result, a decision record, a README claim, a plan, an essay.
5. The whole result is at most 44,000 characters and 20,000 estimated tokens, and no text appears twice
   (version 4: 51,000 to 91,000 characters with every document twice; measured tonight: the host delivers 463
   of 463 results up to 47,000 characters and rejects 95% to 97% of results of 51,000 to 60,000).
6. "Nothing matched" is an explicit per-section result with a reason; a pack without history says so.
7. The same question on the same pack returns the same result in separate processes (tested, 200 of 200).
8. A result the host rejects is worse than no result: the model gets an error, searches again (5.2 searches
   per answer against 2.4) and answers from less. Section budgets are part of the recipe, not tuning, and the
   size test must use what the host accepts, not a number chosen by the builder.

### 2.3 Component specification (as built in v5 at 3dff2bc7)

- Recipe file: `recipe/RECIPE.json` (chunker and cap, analyser `lucene-porter-ident`, lanes with role, field
  weights 1 / 1 and depth 100, sections with item counts and character budgets, standing by kind).
- Pack: `lexical.db`, `history.db` (table `units` + FTS5 `fts(subject, body)`), `manifest.json` (per-source
  commit, counts, hashes, recipe version), `PROBES.json` (known question to expected file), `PACK.json`
  (generation, access, counts). Built in CI only, incremental by content hash; an unreadable source is carried
  at its last good state and named; build is reproducible across processes.
- Engine: `open(pack)`, `search(question, options) -> {sections: [{name, items: [{repo, path, lines, hash,
  standing, date, flag, text}], emptyReason}], closing, meta}`, `selfTest()` from the pack's probes; lanes are
  plug-ins, so a later lane adds a section without a contract change.
- Installer and update: signed release, verified, probed before and after the switch, rolled back by itself on
  a failed post-switch probe, transaction log, uninstall.
- Health: the engine self-test drives one verdict; the session line and `doctor` print the same verdict
  (work package 3, in progress).
- Acceptance: 45 tests (43 pass, 1 opt-in, 1 known weakness marked todo and assigned to the host-shim
  package), 60 breaks each turning its test red.
- Measured costs of the design: keyword query 1.1 to 1.8 seconds on 644,000 to 880,000 passages as built for
  the tests; 1.6 to 2.4 seconds per tool call; text plus index 1.33 GB for 644,000 passages, about 2.3 GB
  projected for the whole corpus against 1.7 GB shipped today; history for 6 repositories took 396 API calls.

### 2.4 What Tier 1 measured

| Measure | Shipped 4.7.28 | Tier 1 (keyword + history) | No tool |
|---|---|---|---|
| Right file in the first 5 (plus first 3 history), D, 113 | 4 | 52 | |
| Same, E, 164 | 9 | 95 | |
| Same, F, 80 | 4 of the 27 run | 49 | |
| Right file among 10 served, 178 slice questions / 101 amateurs | 8 / 1 | 76 / 18 | |
| Answer score of 100, E sample of 84 | 60.8 (49 questions, 1 run, information only) | 73.1 | 25.4 |
| Answer score of 100, F, 80 | not run | 77.8 | 23.8 |
| Answer score of 100, G slice, 65 amateurs | 56.5 (one run; 20 of 65 answers at 8 or better against 35 of 65 for Tier 1 in the same run; 86 of its 312 results rejected by the host) | 68.7 | 23.1 |
| Owner's measure, F: experts / practitioners / amateurs | not run | 16 of 17 / 24 of 31 / 17 of 32 | 0 |
| Owner's measure, G slice, amateurs | not run | 36 of 65 | 0 of 65 |
| Guidance success in 2 of 3 runs, H | not run | 4 of 40 (mean score 45.8) | 0 of 40 (18.2) |
| Right source reached the answering session: E / F / G slice | | 72.5% / 81.3% / 47.2% | |
| Answers at 8 or better when it did: E / F / G slice | | 72% / 83% / 77% | |

Judge: Opus, blind to the arm, behind a seeded calibration gate (18 of 20 within one point after the mechanical
citation and false-claim caps; the guidance gate passed at exactly its bar, 21 of 25); re-judging gave 53 of 60
and 28 of 30 identical scores. A gold-narrowness audit found 6 of 110 sampled "misses" were sufficient sources.

## 3. The rUv-design slice: what was built, what it found, why it is not admitted

Built on 7 stores (9,029 documentation and manifest units; 3,264 extracted): per unit a summary, six newcomer
questions, capabilities with problem statements and a verbatim quote checked by code; 2,698 need rows and 349
playbooks that rUv wrote himself, parsed with no model; a "need index" of those sentences in RVF 0.4.12; a
typed graph (cue, capability, package, decision, file; 103,932 edges) walked with rUv's own operator compiled
from source and a port of his MRAgent walk that reproduces his benchmark exactly. Settings frozen and hashed
before any blind score (RUN/`candidates/slice/FROZEN.md`).

| Test (rule) | What was compared | Result |
|---|---|---|
| File level, look 2 (A6.4, A6.5), 101 amateurs, ten files against ten | keyword 18; + need index 43; + walk 43 (tuned) or 46 (rUv defaults); shipped 1 | numeric thresholds met (+24.8 points, 26 gained, 1 lost); the build failed its own soundness checks (a held-out generated question returns its own file within 5 for 29.9%, gate 90), so recorded "build not sound", not declared met |
| Settings evolved by rUv's loop (R21) | 43 against 46 for his default settings; also lower on the tuning half | not adopted |
| Landing on capability centroids (A12) | 304 against 472 for nearest cue | not adopted |
| Stability across processes | walk 52.6% to 87.5% identical at look 1 (the graph store returns edges in a different order per process); 100% after a sort (A15) | defect found, worked around, to report upstream |
| Answers, capability descriptions (A14.2), 65 amateurs | 53.8% against 55.4% | NOT MET, -1.5 [-12.3, 7.7] |
| Guidance, keyword-chosen playbooks (A10.3), 40 goals | guidance success +1.7 [-2.5, 6.7]; the section carried two thirds of the right tools in 0 of 120 answers | NOT MET |
| Guidance, capability descriptions (A16), 40 goals | 3 of 40 against 4 of 40 | NOT MET |
| Answers, need-index files beside keyword files, 10 files per result (A17), 65 amateurs | 23.1% against 55.4%; the equal-slot control with 10 keyword files: 21.5% | VOID as a test of the lane: the host rejected 96.7% (need arm) and 95.2% (control) of these 51,000 to 60,000-character results; no answer had every result delivered. What it does measure: an oversized result costs about 33 points |
| Answers, 3 keyword + 2 need files, same size as 5 keyword files (A18), 65 amateurs, third use of the questions | 60.0% against 55.4% on the owner's measure; mean score 73.2 against 68.7 (+4.6 [1.2, 8.5]); false claims 17 against 22; 9.5 s per call against 1.6 | NOT MET, +4.6 [-6.2, 16.9]; a positive signal too small for 65 questions |
| Caller-side query rewriting (A4.2, A9.1), file level, 330 questions | replacing the question: experts -27 points; original plus rewrites: problem-only amateurs 12.5% to 34.2%, practitioners -5.6 | NOT MET as registered; the "added beside, never replacing" form is built into the v5 server behind a switch that is off |

Not run (registered, no claim either way): typed abstention over capability nodes; learning from use on a
branch; navigation operations at answer level; the re-ranker at a workable size; passage embedders on blind
sets; late-interaction and learned-sparse models.

## 4. Late-2026 capabilities: what was used, what it measured here

Sources with URLs and dates: RUN/`SURVEY-2026.md`, RUN/`ruvector-deepdive/SURVEY-2025-2026.md`,
`WHAT-2024-THINKING-MISSES.md`.

| Capability (date) | How it was used | What it measured on this corpus |
|---|---|---|
| Vendor guidance for agent-facing search tools: capped responses, high-signal fields, concise results (Anthropic, September 2025) | sections, a size cap (now 44,000 characters), names instead of ids; in v5 | the host's limit measured directly: 463 of 463 results up to 47,000 characters delivered; 95% to 97% of results of 51,000 to 60,000 rejected, costing about 33 points on the owner's measure |
| Caller-side reasoning / query rewriting (2025; every public result above 50 on the BRIGHT benchmark uses a model on the query side) | two registered arms | hurts when it replaces the user's words; helps problem-only amateurs when added beside them; and the answering model already does it unprompted (2.4 searches per answer; 55% on questions whose first page held the answer for 8%) |
| Cue-tag-content memory with reconstruction (rUv ADR-269 / 270; the MRAgent paper, June 2026) | the slice | finds files for amateurs (18 to 43 of 101); no answer-level gain in three tests |
| Typed graph with `search_then_traverse` (RuVector, 2026) | the walk's operator, compiled and self-tested | no gain over the plain need index at look 2; edge order not deterministic across processes |
| Landing by capability centroid (ruflo ADR-527, 2026-11-10) | tuning option | lost to nearest cue on this corpus |
| Evolving settings on a held-out split (`@metaharness/darwin`, 2026) | tuned the walk's 12 settings | did not generalise; rUv's defaults were better |
| Small 2025 embedders (LEAF `mdbr-leaf-ir`, 23 M parameters) | cue-sentence embedder screen | chosen by rule; within 5 points of three older models |
| Copy-on-write branches, governed experiment branches (2026); small late-interaction models; learned-sparse expansion; learned query-side vectors | registered for the next programme | not tested |

A 2024 design (better chunks, keyword plus a bigger embedder, a cross-encoder) was also measured: it is Tier 1
minus the embedder, which added nothing. The 2026 ideas were tested rather than assumed, and on this corpus
tonight the measured winners are the least fashionable ones: precise keyword search over well-cut passages,
history as its own section, a small capped result, and letting the calling model search more than once.

## 5. The three gaps, as measured, with plan and gate

| Gap | Measured | What the numbers point to | Gate for the next step |
|---|---|---|---|
| Finding | the right source reaches the session in 72.5% (E), 81.3% (F), 47.2% (G amateurs) of answers; the need index nearly doubles that for amateurs (86.2%) | the need index raises reach at file level; whether that raises answers is tested only by A18 (equal size); every lane must fit in a result the host delivers, so lanes compete for about five file slots | A18 gave +4.6 [-6.2, 16.9]: not met; next: the same form on about 700 new amateur questions, +5 points with an interval excluding zero as the registered threshold, false claims not higher |
| Answering | when the right source is served, 72% to 83% of answers reach 8 of 10; 6% to 12% of answers carry a false claim and are capped | this caps the whole system near 80% even with perfect finding: corrections and "does not exist" facts stored beside the claims they overturn; an answer-check pass; results that say which product a file belongs to, so neighbours are not mistaken for the target | false claims down 30% and the owner's measure +10 points, on a new double-authored set |
| Guiding (largest) | 4 of 40 with any arm; tools named 66% to 70%; workable order 48%; a keyword-chosen GUIDE section and a capability section each moved nothing except "pitfall mentioned" (+10 to +12 points) | plans are not retrievable as passages; the unit must be an ordered plan tied to a goal, written or checked by a second author, and the instrument itself needs two gold plans per question | guidance success +10 points on a new 2-author guidance set of at least 100 goals |

Why 93% or 98% cannot be claimed or refuted yet: at 40 to 120 questions the two cannot be told apart; about
one question in five crosses the 8-of-10 line between runs of the same system; about one in eight has gold its
own author doubts. Needed first: at least 300 questions per group (amateur, practitioner, expert, guidance),
gold confirmed by a second independent author, success counted in 2 of 3 runs.

## 6. What is unproven or uncomfortable, said plainly

- Nothing reaches 93%. Amateurs are at 53% to 55%, guidance at 10%.
- The idea this run was redirected toward (rUv's memory design as the retrieval core) did not improve answers
  in the registered tests that were valid tonight, on a 36% extraction of a 7-store slice, with soundness
  checks failing. That is a result about this build on this slice, not a verdict on the design: clause G2
  forbids a negative verdict when the build is not sound.
- The lead first reported the void test (A17) as "more files make answers worse" and corrected it about 20 minutes
  later after checking what the model actually received. Every answer run has since been audited for
  delivery: RUN/`candidates/answers/HOST-DELIVERY.md`. Its result: every other reported rule stands unchanged (0 undelivered results in the 5-file arms on E, F, G, H and in the arms with an added section; the concept-card arm on E had 8.8% undelivered and its result is the same on the 61 clean questions). The shipped 4.7.28 had 27.8% of its results rejected by the host, touching 41 of 49 answers. The boundary sits near 50,000 to 52,000 characters; the admitted 5-file result reaches 49,600, which is why the cap moves to 44,000.
- The shipped Brain at answer level: one run on the 65 amateur questions (56.5 against 69.2, -12.8 [-18.9, -6.9]) and 49 questions on E (60.8 against 73.1); never three runs, never on F or H.
- Sets G and H were used two and three times tonight for successive arms; every later arm is labelled so.
- The guidance judge passed calibration at exactly its bar; the guidance gold is one author's plan.
- Code passage boundaries in the v5 builder against the measured run: not measured. Linux, Windows and remote
  CI for v5: not run. One known weakness is open in v5 (a planted `node` can run from the hook when PATH has
  an empty entry), assigned to the host-shim package now being built.
- The corpus nightly is disabled by owner decision until v5's build path replaces it; users' knowledge stays at
  the last published generation meanwhile.

## 7. Exact next experiments, in order

1. Done at 4:05 a.m.: A18 not met (+4.6 [-6.2, 16.9]); A17 void (host delivery limit); cap lowered to 44,000.
2. Build the instrument that can carry the gate: 300 questions per group, two independent authors per gold,
   guidance with two gold plans; freeze and hash it before any further arm; stop reusing E, F, G, H for
   admission decisions.
3. On that instrument, answer-level arms only, each with an equal-size control: (a) Tier 1 as built in v5,
   against shipped 4.7.28, three runs each: this is the baseline the 93% gate is read from; (b) result
   precision: 3 files against 5 against 10, excerpt 4,000 against 8,000 characters; (c) the caller-side terms
   argument (added beside the question); (d) a product label and "neighbour of" line on every file; (e) an
   answer-check pass for false claims; (f) the need index as 2 of 5 file slots (the A18 form), sized to resolve
   a 5-point difference (about 700 amateur questions), with a latency budget of 2 seconds per call; and the
   same only when the keyword lane's own evidence is weak (a typed decision instead of always adding).
4. Guidance: plans as stored units tied to goals (from rUv's 349 playbooks and from extraction), served by
   goal match with the capability set, on the new guidance set.
5. Only for parts that pass at answer level: whole-corpus extraction (about 25,000 units at 18 a minute) and
   the same rules on whole-corpus questions; then the full rebuild; then the 93% gate with shipped, Tier 1 and
   the admitted parts side by side.
6. Report the edge-order nondeterminism and the content-similarity abstention issue upstream with the
   reproductions (RUN/`candidates/slice/look1-checks.md`, `ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md` 8d).
