Updated: 2026-11-17 12:21:10 a.m. EST | Version 1.0.0
Created: 2026-11-17 12:21:10 a.m. EST

# Version table: every embedding, chunking and search recipe the Brain has had

One row per recipe, oldest first. "Recipe" = how knowledge was cut up, which model turned it into vectors,
what text the model was given, how stores were laid out, how a question was routed, and which checks judged
it. Citation marks: **[L]** = I read the item myself; **[G:X-n]** = quoted by a gathering agent in
`history/evidence/` file X, item n (A project memory, C documents, D git history, E story), not re-read by
me. Detail and quotations are in HISTORY.md; the exact present recipe with line numbers is in
CURRENT-EMBEDDING-STRATEGY.md.

Two things never changed in any shipped version and are therefore not repeated in every row:
**chunks of up to 4,000 characters with 400 overlap**, and **the 8-bit build of each model**
(**[L]** `git show 1bcc60b8:kb/forge-build.mjs` lines 308-310; `kb/forge-corpus.mjs:11-12` today;
**[G:D]** constant-history table: "4000 chars / 400 overlap, unchanged in HEAD").

| # | Dates and release | Embedder(s): model, size, pooling | Text given to the embedder | Stores and index | How a question travels | Re-ordering and cut-offs | Checks that judged it | Who or what decided; evidence at the time | Why it was replaced |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 2026-06-13/14. The `rvf-kb-forge` skill (before the repository) | small: all-MiniLM-L6-v2, 384 numbers, mean pooling; optional big: bge-base-en-v1.5, 768, CLS pooling, question prefix | pieces of about 4,000 characters; ordinary source files only as their opening comment | one store per repository | search one store; return whole documents up to 12,000 characters | none specified beyond distance | "avg ≥98 AND min ≥95" on a tuned and a held-out set, graded by an LLM | an agent, porting scripts from the Cognitum knowledge bases. Evidence: none; "NOT executed end-to-end" (**[L]** skill lines 73-92, 224-256) | not replaced: it became row 1 |
| 1 | 2026-06-28. Bundle v0.3.0-dev, 5 repositories, 46,845 chunks, 268 MB | both models for every repository | small build: `title — path` header + chunk; big build: the bare chunk (**[L]** first-commit `forge-build.mjs:336,379`, `forge-big.mjs:85`) | 5 stores × 2 variants + a hand-written "concepts" store | every store searched; the big variant used when present | cross-encoder reranker (ms-marco-MiniLM-L-6-v2) added this day | 12 questions on one repository; 45-question "capability gate"; LLM panels from three vendors | agent with owner directive "maximize for effectiveness" (ADR-0004). Evidence: small 49.5/81.8 vs big 31.6/68.0 ("not comparable"); reranker +10 points (**[L]** `PROGRESS.md:1176-1205`) | grown into row 2 |
| 2 | 2026-06-29, 10:36 p.m. First commit 1bcc60b8, v0.4.0-dev: 19 repositories, 75,509 chunks, 421 MB | as row 1 | as row 1 | 19 stores × 2 + concepts store holding primers and capability cards | every store, best 8 documents each; one reranker pass over all; top 6 returned (**[G:D]** constant table: pool 8, top-k 6) | reranker; +2.0 when the question names the repository | "named 47/48, by-description 27/28 (was 33%)": right repository or card (**[L]** commit message; **[G:C-121]**) | agent. Evidence: those two batteries | never formally replaced; later rows change the path around it |
| 3 | 2026-07-07 (0a90a380) | same models, now pinned to exact Hugging Face revisions | same | same | same | same | same | agent; reason: reproducibility **[G:D-4]** | still in force |
| 4 | 2026-07-09/10. v2.0.0: 32 repositories, 128,994 chunks | same | same; full source bodies restored for some stores after two build faults were found (**[G:A-9]**, **[G:E-86]**) | 32 stores | same | abstain when the top reranker score is below 0 (pinned, **[G:D]**) | new: 120 frozen questions scored at repository level; first result routed 63/80 (**[L]** `evals/runs/2026-07-09-baseline.md`) | agent, "directed by Stuart Kerr" (ADR-0011). Evidence: 12-question set was too small (interval 55% to 95%) **[G:D-5]** | gate still exists; edited 2026-07-30 and 2026-09-09 |
| 5 | 2026-07-19 (57354dd1), v3.4.x | same | same; meeting transcripts given one path per passage | repositories as before + private transcript store | same, plus a keyword (BM25) lane for transcript stores only | same | meeting exam 3/28 to 25/28; named battery 44/48 unchanged (**[L]** ADR-0025) | agent. A global keyword+meaning mix was built, measured 40/48, and reverted | transcript lane still in force |
| 6 | 2026-07-20 (2906422f) | same | same | same | same | results scored below 0 are withheld; confidence grade: strong ≥ 6.0, ok ≥ 4.0 | six example queries **[G:D-17]** | agent, after a user misread weak results | still in force (`kb/forge-ask-all.mjs:3055-3086` **[L]**) |
| 7 | 2026-07-27 to 07-30. v3.9.85 to **v4.0.1**: 69 repositories, about 150,000 chunks; download 806 MB to 469 MB | **bge-base only**; the MiniLM build retired 2026-07-28 (3760c32d, no message) | bare chunk only (the header-carrying build was the one retired) | one store per repository, big variant only | **new path**: (1) a card lane answers from hand-written cards before any search (2f9726d0, 07-27); (2) a card router picks a few stores (859a16de, 07-28); (3) if it cannot, no search runs (453ae584, 07-30) | as row 6; two reranker shortcuts measured and left off | card lane: 19 capability questions, repository level; Top-100 benchmark 69 to 100 of 100 after "rescue repairs" (**[G:A-33..36]**); frozen set edited 07-30 (**[G:D-33]**) | agent. Evidence: speed (19.6 s to 0.25 s); search had reached 91 to 151 s and 68% of cold queries timed out (**[G:C-92, C-110]**). Retirement of MiniLM: non-duplication and footprint (ADR-0004 update, **[L]**). Route-or-refuse: no reason recorded (**[L]** commit) | in force today |
| 8 | 2026-09-07 to 09-11. v4.3.10 to 4.3.21: 184 stores | same | same | same | same, plus an exact-token "identifier lane" (b2624e5f) and a 20-second limit on the command-line entry point (a84f1b50; the MCP tool handler passes none) | per-store pool 8 to 64 (c5eb2abc, no message); pair cap 408 on the unrouted path only | evaluation moved onto the bounded path, alias credit, baseline re-recorded 80/80 (ccaea57a, no message); identifier lane A/B 0.9433 vs 0.9124 at repository-given recall@10 (**[G:A-43]**) | agent. Evidence: "top-1 cited document was wrong ... in 8 of 9 cases" **[G:D-42]** | in force |
| 9 | 2026-09-15 to 09-29. v4.3.25 to 4.3.36: 196, then 182 public stores; nightly corpus releases begin | same | same | same | same | same | owner's 95%-per-repository criterion measured 59.0% and demoted; replaced by 176/194, then 162/182, with the repository given (**[G:C-175]**; receipts **[L]**); 2026-09-19 grader stops crediting abstained answers: 48/80 | owner asked for it to be unblocked ("rip them out"); agents chose the replacement gate | in force; unchanged numbers every night since |
| 10 | 2026-10-01/02. v4.4.0 to 4.5.x: 199 to 206 stores, 171,869 chunks | same | same | same | router tie-break by file metadata; store-name rule for identifiers; keyword lane for repositories added **switched off**; learned judge added **switched off** | same | first newcomer test: right file in top 5 for 4 of 206; recall gate 162/182; keyword lane on: 165/182 and 10/206, +2.1 s (**[L]** ADR-0099; `kb/keyword-lane.mjs:1-36`) | owner + agent (ADR-0099, Proposed). Owner rejected moving the abstain cut-off | in force |
| 11 | 2026-10-31 to today. **v4.7.28**: 218 stores, 187,117 passages, 906 MB zipped | bge-base-en-v1.5, 768, CLS, 8-bit, question prefix | bare chunk; half of all tokens fall outside the model's 512-token window (run decision D4) | one store per repository | card lane, then card router, then search or refusal | reranker reads the first 3,000 characters; below-zero results dropped | nightly: 161-163 of 182 (repository given); 89 of 160 "diagnostic" FAIL; through the real tool with answer keys: 4 of 113 and 8 of 164 (**[L]** receipts; `DECISIONS.md` D3, D7) | no decision since row 10 | under review |
| 12 | 2026-11-15. Pilot "v2", **not shipped** | same embedder "unchanged by decision" | symbol or heading pieces of at most 480 tokens, with a `repo › path › symbol` header | 10 stores, vectors per store; one global keyword index (SQLite FTS5 with rUv's Lucene analyzer) | no router; keyword lane + summaries with newcomer questions, fused by rank | no reranker ("flat, ~7 s") | 113 development questions with answer keys; answer-level 82.6 of 100 | an agent lead; evidence in `RECIPE.md` (**[L]**); chunk size not tested | superseded by row 13 |
| 13 | 2026-11-16. Knowledge-architecture candidate, **not shipped, not final** | undecided; screen of other embedders unfinished; owner direction D15 holds | as row 12 | 24 stores keyword; history store (commits, issues) for 6 repositories | no router, no card answers; results in sections: files + history | none | rules fixed in advance; blind sets E (164) and F (80); answers 73.1 to 75.7 of 100 vs 25.4 with no tool | an agent lead under pre-registered rules (**[L]** `DECISIONS.md`, `PREREGISTRATION.md`) | open |

## What the table shows at a glance

- The **model and the cutting** (rows 0 to 11) came from a template and one weekend's 12-question test, and
  were never changed.
- The **text given to the model** differed between the two builds from the first day and nobody recorded it:
  only the small build put the title and path in front. The reader used the big (bare-text) build whenever a
  store had one (`kb/forge-ask-all.mjs:5-6`, `kb/forge-ask.mjs:77-80` **[L]**), so the header vectors were
  mostly not the ones being searched even before the small build was retired on 2026-07-28.
- The **path a question takes** changed completely between 2026-07-27 and 2026-07-30 (row 7), for speed.
- The **checks** changed more often than the recipe, and until 2026-10-01 none asked for the right file
  without naming the repository.

## What I could not find

- A stated reason for the route-or-refuse change (453ae584), the pool change (c5eb2abc), or the retirement
  commit itself (3760c32d); the commit messages are empty. Issue threads were not read.
- The exact store and passage counts of rows 3, 5, 6 and 8 at the moment of each change (counts shown are the
  nearest recorded).
- Whether row 2's reader used the small or the big variant for each store in practice beyond the code's rule
  "big when present".
