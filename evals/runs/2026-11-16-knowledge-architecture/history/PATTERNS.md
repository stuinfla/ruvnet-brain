Updated: 2026-11-17 12:21:10 a.m. EST | Version 1.0.0
Created: 2026-11-17 12:21:10 a.m. EST

# Recurring patterns in how the search strategy was chosen and judged

Each pattern lists the evidence and what it cost. Citation marks as in HISTORY.md: **[L]** = read by me,
**[G:X-n]** = quoted by a gathering agent in `history/evidence/` file X, item n. These are patterns in the
record, not judgments of people; most were found and written down by the project itself, one at a time.

## 1. The tests measured "right repository", the user needs "right file"

- The 120-question release gate passes a question when the cited source is from an expected repository
  (`expectRepo`, with the catch-all `concepts` store often accepted). No question has a gold file.
  **[L]** `evals/held-out.json`; `scripts/eval-brain.mjs:83-88`.
- The first-commit proof ("named 47/48, by-description 27/28") scored which card or repository answered
  **[G:C-121]**.
- The nightly file-level check asks 182 questions **with the repository given** (`repositoryScope:
  "explicit"`), and says of itself: "Unscoped (whole-corpus) discovery was NOT measured." **[L]** nightly
  `ruvnet-brain.zip.recall.json`.
- The first test that asked a problem in a newcomer's words and checked the file was run on 2026-09-30: 4 of
  206 (**[L]** `docs/adr/0099-self-learning-retrieval.md:20-35`). Three months of releases preceded it.
- On one and the same build: repository right in the top 6 for 84%, exact file for 11% (**[L]** memory
  `brain-quality-audit-2026-11-15`).
- **Cost.** "Routed 100%" (2026-09-09) and "gold file in the top 5 for 3.5%" (2026-11-15) describe the same
  product family and were never plotted on the same axis.

## 2. Gates that could not fail, or that passed by luck

- `scripts/gate.sh` "always exits 0 — the gate can't fail" (outside review, 2026-07-06) **[G:E-73]**.
- The retrieval canary (recall@10 ≥ 0.98 on about 19 stores) "is a coin flip ... earlier releases passed by
  sample luck" (**[L]** memory `finding-canary-gate-unsound-and-census-coupling-20260930`).
- The self-retrieval benchmark printed `mode=HYBRID` while running meaning-search only, "an unfalsifiable
  witness" (**[L]** `docs/adr/0025-…:179-187`).
- The corpus-QA self-retrieval check was widened to "found anywhere in the top 500" after six red nights
  (**[L]** `docs/adr/0064-…`).
- The "retrieval accuracy" receipt has read `state: FAIL` (89 of 160 against a 19-of-20 threshold) on every
  one of 45 nightly bundles from 2026-09-29 to 2026-11-16 and is marked "diagnostic", so nothing stops
  (**[L]** receipts).
- A test fixture's oracle "had copied the detector's own regex, so the numbers only proved self-consistency"
  **[G:E-133]**.

## 3. When a gate failed, the gate changed

| Date | Gate | What changed | Citation |
|---|---|---|---|
| 2026-06-28 | STRICT score (the #1 document answers alone) | "DECISION TAKEN: REAL-USE is the gate of record; STRICT is a diagnostic", on the day STRICT read 35 to 56 | **[L]** `PROGRESS.md:1187-1195` |
| 2026-07-30 | "Frozen; do not tune" 120 questions | two questions rewritten, frozen hash re-pinned 20 minutes later, no message | **[G:D-33, D-34]** |
| 2026-08-06 | nightly self-retrieval | top 10 became top 500 | **[L]** ADR-0064 |
| 2026-09-09 | held-out routing | alias credit added, question path changed to bounded, baseline re-recorded 66 to 80 of 80, no message | **[G:D-41]**; **[L]** code |
| 2026-09-15 | owner's 95% per-repository criterion (measured 59.0%) | replaced by 176 of 194 with the repository given; "a declared REDUCTION in release requirements" | **[G:C-175]** |
| 2026-09-15+ | the 176-hit ratchet | oracle cut from 194 to 182 stores and the ratchet withdrawn | **[G:D item 18 in agent summary]** |

Two changes went the other way and deserve credit: 2026-09-19 (850570c6) stopped passing answers the product
had itself scored irrelevant, which turned 80/80 into 48/80; and 2026-10-16 (branch only) removed code written
for specific test questions, which turned 60/80 into 50/80.

## 4. Test questions written from the answer, by the builder

- 2026-06-28: "CAVEATS: 1 repo so far; I authored the Qs (mild bias ...)" **[G:D-1]**.
- The 206 newcomer questions were "each written from one gold file" (**[L]** ADR-0099:22).
- rvf-expert-kb's 98% gate uses questions an LLM writes from the stored passages (**[L]** skill, line 26).
- The 182/194 fixture was "committed before this gate existed", yet "a pre-existing fixture can still be
  cherry-picked after the scores are known" **[G:C-177]**.
- The first sets with gold found from source by authors who never saw retrieval output, and re-verified
  mechanically, are the exam2 set (2026-11-15) and sets E and F (2026-11-16).

## 5. Fitting the product to the test questions

- About a dozen functions in the shipped reader recognise the wording of particular benchmark questions and
  force a list of repositories (**[L]** `kb/forge-ask-all.mjs:309-467, 3281-3443`). On the unshipped branch:
  "Every removed predicate and rewrite matched only frozen eval questions ... and none of the 100 unseen
  questions" **[G:D-93]**.
- "held-out eval contaminated by ~40 phrase rewrites (card-lane.mjs:138-247)" (**[L]** audit memory).
- The Top-100 benchmark went 69 to 100 of 100 in about three hours "after targeted rescue repairs"
  **[G:A-33 to A-36]**; its accepted-synonym lists were widened two days later **[G:D-33]**.
- The eval folder itself was indexed: "233 passages from evals/, including held-out.json, so out-of-corpus
  eval questions retrieved their own answer key" **[G:D-83]**.
- Hand-written cards closed tests retrieval could not: capability gate 38 to 45 of 45 with a concepts store
  **[G:C-30]**; by-description 33% to 96% with cards. The cards later answered "built" for things that were
  not (**[L]** memory `incident-hallucinated-built-state-…`).

## 6. Defaults that were inherited and never revisited

| Default | Came from | First questioned | Citation |
|---|---|---|---|
| 4,000-character chunks, 400 overlap | rvf-kb-forge skill, 2026-06-14, "NOT executed end-to-end" | 2026-11-15 | **[L]** skill; `kb/forge-corpus.mjs:11-12` |
| 8-bit model weights (`quantized: true`) | the library's usual example | 2026-11-16 (batch-order instability noted) | **[L]** `kb/forge-big.mjs:121`; run `ARCHITECTURE.md` §4 |
| Source files = opening comment only | forge skill | 2026-07-10 (found), 2026-11-15 (measured: "51% comment-only, 15% dropped") | **[L]** `kb/forge-corpus.mjs:245-271`; audit memory |
| Skip every folder named `v2` | forge skill | 2026-07-10; still present | **[L]** `kb/forge-corpus.mjs:16` |
| Reranker `ms-marco-MiniLM-L-6-v2` and its zero line | forge skill; rUv ADR-080 | 2026-10-01 | **[L]** ADR-0099 |
| Reranker reads 3,000 characters | early code | 2026-09-30 | **[L]** `kb/forge-rerank.mjs:133` |
| One index per repository | ADR-0006 (rebuild cost) | 2026-11-15 | **[L]** ADR-0006 |
| rUv's fusion weight α = 0.5 | ruflo ADR-082, tuned on his commit corpus | 2026-07-18 (this corpus wanted 0.3) | **[L]** memory `grid-search-alpha03-…` |

## 7. Decisions made on a corpus, a question set or a regime unlike today's

- Embedder and reranker: 12 questions, one repository, 9,648 chunks (**[L]** `PROGRESS.md:1176-1205`). Today:
  218 stores, 187,117 passages.
- Card lane: 19 capability questions, 32 cards (**[L]** commit 2f9726d0). Today 185 cards, 134 of them
  auto-derived placeholders (run decision D4).
- Evidence-grade thresholds: six example queries **[G:D-17]**.
- Global hybrid rejected on 48 questions that name their repository, with an un-stemmed BM25 (**[L]**
  ADR-0025). In the regime it was designed for (a Lucene-grade analyzer, questions that do not name the
  repository) it was the strongest lane in November.
- The 140-word-chunk result (96 to 98%) is on spoken transcripts of one expert (**[L]** rvf-expert-kb).
- Corpus growth changed results at least twice without any code change: 2026-07-19 ("ruv-gists grew to 527
  docs this week and now DILUTES cross-repo routing", 47 to 44 of 48) and the concepts store dilution of
  2026-06-29 **[G:E-49]**.

## 8. The right diagnosis was written down and not built

- 2026-07-19: "The real fix is UPSTREAM chunking ... or a per-segment fact-summary layer" (**[L]**
  ADR-0025:47-49). Not built.
- 2026-07-18: content-aware routing and finer passages, "PENDING" (**[L]**
  `docs/BRAIN-WRITE-READ-ARCHITECTURE.md:126-145`). Not built.
- 2026-07-18: "our brain reader ... uses NONE of rUv's hybrid/MMR/RRF/flywheel. The brain REINVENTED retrieval
  instead of using rUv's shipped s[tack]" **[G:A-17]**. Partly ported, then reverted.
- 2026-10-01: keyword index built with the corpus; newcomer questions per document; learned query adapter
  (**[L]** ADR-0099:180-191). None in 4.7.28.
- 2026-06-27: code-aware embedder bake-off (**[G:C-15]**). First embedder comparison: 2026-11-16.
- Project memory, 2026-11-15: "we solved this before on paper and never shipped it" (**[L]**).
- What took the time instead (from STORY.md): release machinery, update safety, hooks, footprint, CI, and
  the tests of those.

## 9. Speed fixes that removed the search

- Problem: by late July a search across 69 stores took 91 to 151 s and "82 of the 120 recorded cold queries
  (68.3%) already exceed the 120s proxy timeout" **[G:C-92, C-110]**; an outside user's unscoped search used
  17 GB **[G:E-110]**.
- Fixes that kept the search and cost little (pool cap, cascade) were measured and left off (2026-07-27).
- Fixes that shipped: answer from a card without searching (2026-07-27); search only the stores a card
  router picks, else refuse (2026-07-30); drop results the reranker scores below zero (2026-07-20); a
  20-second limit on the command-line path (2026-09-11; the MCP tool's own limit is the parent's 240 s call
  timeout).
- Measured effect on the August release in this report's reproduction: 45 of 80 sample questions got
  "Searched 0 RuvNet repos", 18 were answered by a card, median response 8 ms (BISECT.md).
- The keyword lane, which gained on every measure in October, was shipped off for adding 2.1 s.

## 10. Reasons missing from the decisions that mattered most

Commits with an empty message body that changed search behaviour or its judge: 3760c32d (retire the 384
build), 453ae584 (route or refuse; 119 files), 40456752 and 14f654e2 (edit the frozen set), c5eb2abc (pool 8
to 64), ccaea57a (bounded evaluation, baseline 80/80). **[L]** for 453ae584 and 3760c32d; **[G:D]** for the
rest.

## 11. Scores from graders that later proved lenient, and self-scores above independent ones

- "The earlier '32/50' and '49/50' were grader leniency — the honest strict number is 16/50" (**[L]**
  ADR-0025:42).
- A model panel gave 98 to an article with no citations (**[L]** `PROGRESS.md:1228-1233`).
- Self-score 44, independent 31 (2026-09-11) **[G:C-151]**; self "83" against independent 53 and 38
  (2026-07-27) **[G:C-103]**.
- 2026-11-16: an LLM judge alone gave a fluent answer that cites nothing 8 of 10 until a mechanical citation
  cap was added (run decision D12).

## 12. Harness errors read as product results (in both directions)

- 2026-09-15: "a wrong --kb path and an unresolved @xenova/transformers EACH produced a clean-looking 0/194"
  **[G:E-205]**; the first 59% run "omitted the asymmetric BGE query prefix" **[G:A-41]**.
- 2026-07-22: "I nearly reported a broken brain ... KB_MODEL_CACHE was unset" **[G:E-127]**.
- 2026-07-12: the whole brain was dark and the tool reported "(no results)" **[G:E-94]**.
- 2026-11-16: `search_ruvnet` was down for the whole run because a system update removed a library (run
  decision D5).

## 13. "rUv ships it" was invoked both to adopt and to dismiss, without checking the regime

- Adopted without re-tuning: α = 0.5, the L-6 reranker.
- Dismissed: "Swap or fine-tune the cross-encoder or embedder | Not a rUv tool" (**[L]** ADR-0099:198),
  although every embedder in rUv's stack is an off-the-shelf model he wraps and he records "A/B your corpus".
- Left untried although rUv ships them: the Lucene-style analyzer (`lucene-bm25.ts`, first used
  2026-11-15), reciprocal-rank fusion, MMR (never ported), labels and paths first in the embedded text
  (ruflo ADR-076; the Brain's shipped build embeds no header), SONA query adaptation (harness written, never
  run), the query-time 1-bit path for memory (RaBitQ).
- The owner's rule (2026-07-21) asks for four checks before "X does not work": designed regime, tuning, right
  component, sound harness. Applied to past verdicts:

| Verdict in the record | Designed regime? | Tuned? | Right component? | Sound harness? |
|---|---|---|---|---|
| Global hybrid gives no gain (2026-07-19) | no (questions name the repository) | partly (α re-tuned on 20 samples) | no (un-stemmed BM25, not the Lucene analyzer) | repository-level battery |
| Meaning vectors add nothing to keyword search (2026-11-16) | yes for file-finding; amateurs are where they tie | no (one embedder, 8-bit, no query adaptation) | open (embedder screen unfinished) | blind sets, sound |
| Learned judge failed (2026-10-01) | yes | one version | own classifier, not rUv's | train/held-out split, sound |
| Reranker flat (2026-11-15) | no (MS-MARCO passages, not long code documents) | no | rUv's ADR-016 found a different reranker (mxbai) did not hurt where L-6 did | development set |
| Graph expansion adds nothing (2026-11-16) | one-hop only | no | hand-built edges, not a RuVector graph component | blind set |
| Concept cards fail (2026-11-16) | cards covered a quarter to a half of gold | no | n/a | pre-registered, sound |
| SONA query adaptation | never run | | | |
| doc2query newcomer questions | reach measured; answers never measured | | | |

## What I could not check

- Whether the six empty-message commits have reasons recorded elsewhere (issue threads were not read).
- The unshipped branch `deepdive/essence` was not read by me; its commits are quoted from evidence file D.
