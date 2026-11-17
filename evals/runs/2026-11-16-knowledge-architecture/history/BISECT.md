Updated: 2026-11-17 12:37:42 a.m. EST | Version 1.0.0 (June and July release arms not finished: the machine's load reached 200 to 320 from other jobs; see section 5)
Created: 2026-11-17 12:37:42 a.m. EST

# Bisect: when did the Brain last work better, and what changed?

The owner's statement (2026-11-16, 11:47 p.m.): "it wasn't this bad months ago. it was working much, much
better, so something inherently must have broken". The rule applied: find the last time it worked better,
then diff that window. Measurements are reported with what they counted; numbers that count different things
are kept in separate tables. Citation marks: **[L]** = read or measured by me; **[G:X-n]** = quoted by a
gathering agent in `history/evidence/` file X, item n; **[R]** = this report's reproduction runs, raw rows in
`history/bisect/*.jsonl` (run by a Sonnet agent to fixed instructions; I re-scored the rows I quote).

Two words: **repository-level** = the answer came from the right project; **file-level** = the file that
holds the answer was among the results.

## 1. Short answer (as far as measured so far)

1. **By every repository-level test the project kept, quality did not fall; it rose, partly because the tests
   and the code were fitted to each other.** Routed 63/80 (July 9), 66/80 (August 19), 80/80 (September 9,
   after the grader and the question path were changed), then 48/80 and 50/80 once credit for abstained
   answers and question-specific code were removed.
2. **By the one file-level series that exists (repository named in the question), nothing has moved since it
   began:** 161 to 163 of 182 on every one of 45 nightly bundles from 2026-09-29 to 2026-11-16, while the
   bundle grew from 625 MB to 864 MB.
3. **File-level for problem-style questions was first measured on 2026-09-30 and was already about 2%**
   (4 of 206). Reproduced here on the August 8 release: 0 of 60.
4. **Something did change for the user, sharply, between 2026-07-27 and 2026-07-30 (release 4.0.1):** before,
   every question was searched in every store and always came back with six documents; after, a question is
   answered by a hand-written card, routed by the cards to a few stores, or not searched at all. On the
   August 8 release, 45 of 80 sample questions got "Searched 0 RuvNet repos" and 18 got a card.
5. **Whether the pre-July-30 Brain found the right *file* more often could not be reproduced tonight**
   (section 5): the June and July releases re-read hundreds of documents per question and timed out at 150
   and 300 seconds on a machine whose load was 60 to 320 from other work. A measured bound stands in for it:
   with the vectors as they have been built since June, the gold file is among the 100 nearest pieces of its
   own store for only 7 of 76 development questions (run decision D6, **[L]**). The old path took the nearest
   8 documents per store. So on problem-style questions the old path could not have exceeded roughly one in
   ten on today's stores, whatever it did afterwards. This is an inference from a measurement, not a
   reproduction.
   The records say it found the right *repository* for 47 of 48 questions that named the repository, on 19
   stores, taking about 20 seconds; by late July, on 69 stores, the same design took 91 to 151 seconds and
   timed out for two thirds of cold questions. The first reproduction attempt of the July 27 release timed
   out at 150 seconds on both questions tried.

## 2. Quality over time: repository-level measurements (do not compare with section 3 or 4)

| Date | Release, corpus | Test | Result | What it counted | Citation |
|---|---|---|---|---|---|
| 2026-06-28 | 5 repos, 46,845 chunks | "capability gate", 45 questions | 38/45, then 45/45 with a hand-written concepts store | right project claims a capability | **[G:C-28, C-30]** |
| 2026-06-29 | v0.4.0-dev, 19 repos, 75,509 chunks | 48 "named" questions ("Can ruflo ...?", "Does RuVector ...?") | 47/48 | top hit from the expected repository **or the concepts store** | **[L]** `git show 1bcc60b8:scripts/proof-questions.json`, `prove.mjs:39-42` |
| 2026-06-29 | same | 28 "described" questions | 27/28 (33% before cards) | "all resolved to CARD" | **[G:C-121]** |
| 2026-07-06 | same era | outside re-run of the same proof | 46/48 and 27/28 "with different failing questions" | same | **[G:E-74]** |
| 2026-07-09 | about 24 repos | 120 frozen questions | grounded 100/100, routed 63/80 | cited source from an expected repository | **[L]** `evals/runs/2026-07-09-baseline.md` |
| 2026-07-19 | about 60 repos | the 48 named questions again | 44/48 | as above; 3 lost to a grown gist store | **[L]** memory `REGRESSION-truth-44of48-…` |
| 2026-07-27 | 69 repos | 120 frozen | routed 62/80 | same | **[G:C-106]** |
| 2026-07-28 | 69 repos | Top-100, live tool | grounded 92, routed 79, sufficient 66; "semantic" 69/100; three hours later 100/100 after "rescue repairs" | mixed; fitted | **[G:A-32..36]** |
| 2026-08-19 | 4.0.85-dev, 77 repos | 120 frozen | routed 66/80 | same | **[L]** commit 6107b160 |
| 2026-09-09 | 4.3.x, 184 stores | 120 frozen, grader and path changed | routed 80/80 | alias credit; bounded path | **[L]** `evals/baseline.json`; **[G:D-41]** |
| 2026-09-30 | 4.3.34, 199 stores | same 80, rule now requires "not abstained" | 48/80 (routing itself 80/80) | right repository and the product did not reject its own answer | **[L]** memory `finding-eval-routed-misread-correction-20260930` |
| 2026-10-16 | branch only | same, question-specific code removed | 50/80 (60/80 before removal) | same | **[G:D-93]** |
| 2026-11-15 | 4.7.28, 218 stores | 64 fresh questions with answer keys | right repository in top 6: 84% | repository of a gold file | **[L]** memory `brain-quality-audit-2026-11-15` |
| 2026-11-17 | **reproduction**, 4.0.36 code + its own corpus (Aug 8) | 20 of the 120 frozen questions | 17/20 | a result from an expected repository in the top 5 | **[R]** |

A prior bisect in the record reached the same view of this series: on 2026-09-30 an agent ran the
baseline-era code on a fresh corpus and found "identical per-question results ... so neither 17 retrieval
commits nor corpus growth nor staleness caused it. REAL DEFECT: right repo, weak passage" (**[L]** same
memory entry).

## 3. Quality over time: file-level, repository named in the question

| Date | Corpus | Test | Result | Citation |
|---|---|---|---|---|
| 2026-09-15 | 4.3.25, 196 stores | 194 human questions, one per repository, repository given | 176/194 top 5; 139/194 top 1 | **[G:C-179]** |
| 2026-09-15 | same | same, with and without the identifier lane, top 10 | 183/194 vs 177/194 | **[G:A-43]** |
| 2026-09-29 to 2026-11-16 | 45 nightly bundles, 625 MB to 864 MB | 182 questions, repository given, top 5 | **161 to 163 of 182 every night**; top 1: 127 to 129 | **[L]** each bundle's `ruvnet-brain.zip.recall.json` |
| same 45 nights | same | 80 machine-written questions, repository given | 46 or 47 of 80 | **[L]** `…accuracy.json` |
| same 45 nights | same | the same 80, whole corpus, **evaluator path that still searches everything** | 43 or 44 of 80 | **[L]** `…accuracy.json` |

Corpus growth of 38% in seven weeks moved none of these. The whole-corpus row uses the old
search-everything fallback (`allowFullCorpus` left at its default), which the product's own tool has not used
since 2026-07-30; so it is a measurement of the old path on today's corpus: about 54% on questions written
from the files.

## 4. Quality over time: file-level, problem-style questions through the real tool (what the owner means)

| Date | Release, corpus | Test | Right file in top 5 | Other counts | Citation |
|---|---|---|---|---|---|
| 2026-09-30 / 10-01 | 4.3.37 to 4.4.1, 199 stores | 206 newcomer "need" questions | 4/206 (first run 0/206) | abstained 201 or 202; right repository within k 56/206 | **[L]** ADR-0099:20-35; **[G:A-51, B-4]** |
| 2026-10-01 | same, keyword lane switched on | same | 10/206 | +2.1 s | **[L]** ADR-0099 |
| 2026-11-15 | 4.7.28, 218 stores | 113 development questions with answer keys | 4/113 (top 6) | 15 refused without searching | **[L]** `DECISIONS.md` D0, D3 |
| 2026-11-16 | 4.7.28 | 164 blind questions (set E) | 8/164 | refused 19; "insufficient evidence" 90; one file only 120 | **[L]** `DECISIONS.md` D7 |
| 2026-11-17 | **reproduction**: 4.0.36 code + its own corpus (2026-08-08) | 60 questions sampled from D, E, F | **0/60** | "Searched 0 RuvNet repos" 45 of 80; card answer 18 of 80; right repository in top 5 for 12 of 60; median 8 ms | **[R]** `bisect/v4.0.36.jsonl` |
| 2026-11-17 | **reproduction**: 4.7.28 code + corpus of 2026-11-16 (partial, 54 of 80 asked) | 24 D + 24 E + 6 F | 3/54 | right repository in top 5: 27/54; amateurs 0/24 | **[R]** |

No measurement of this kind exists before 2026-09-30. That is the central fact: for the first three months
nobody asked a problem-style question and checked the file.

Caveat for old releases: the answer keys were written against today's source. An old corpus may lack the
repository or the file. Section 5 reports "gold present in that corpus" beside each result.

## 5. Reproduction of old releases (status)

Method: seven historical bundles were downloaded from the project's own GitHub releases into a scratch
folder outside the repository (`~/RVF-KnowledgeBases/ruvnet-brain-bisect-20261116/`). Each bundle carries its
own reader code and its own corpus, so each arm is that release answering through its own `search_ruvnet`
handler. The same fixed questions (80: 24 development, 24 from blind set E, 12 from blind set F, 20 from the
repository's old held-out set; seed and hash in `sample/questions.json`) go to each. Every process runs with
a fake home folder so the live installation is never touched. One process at a time, low priority.

| Arm | Release date | Status at 12:32 a.m. | Result |
|---|---|---|---|
| v4.0.36 | 2026-08-08 | done, 80 questions | file top-5: 0/60 (gold file present in that corpus for 48 of the 60: 0/48); right repository in top 5: 12/60; on the old held-out questions 17/20; no search for 45; card 18; median 8 ms |
| corpus of 2026-11-16 with 4.7.28 code | 2026-11-16 | stopped at 54 questions (purpose: check the harness against the known 4/113 and 8/164; it agrees) | file top-5: 3/54 (D 1/24, E 2/24, F 0/6); amateurs 0/24; right repository in top 5: 27/54; card 7; no search 2; median 16.8 s; one result returned for 36 of 54 |
| v3.9.85-dev | 2026-07-27, last before the turn | 2 questions asked: both timed out at 150 s (low priority, 2 stores at a time, load about 60). Re-queued: 12 questions, 600 s limit | NOT FINISHED |
| v0.4.0-dev | 2026-06-29, first release, 19 stores | 1 question asked: timed out at 300 s while the machine's load was 200 to 320 (other jobs). Re-queued under a load limit | NOT FINISHED |
| v3.3.1 | 2026-07-17 | queued, 12 questions | NOT RUN |
| v4.3.21, v4.5.5 | 2026-09-10, 2026-10-04 | queued | NOT RUN |
| today's code on the August corpus; August code on today's corpus | | queued last | NOT RUN |

The agent running these continues under a load limit and writes its tables to `history/bisect/RESULTS.md`
and its method to `history/bisect/SETUP-LOG.md`. Until those arms exist, hypotheses H2 and H3 below are
answered from records and from the bound in section 1, point 5, not from a reproduction.

### What each release's own code does, and what each corpus held (read and counted from the bundles by the bisect agent; line numbers are in that bundle's files)

| Release | Stores | Passages | Median passage (characters) | Gold file present, of 60 | Card lane before search | No route, no search | Documents per store | Low scores dropped |
|---|---|---|---|---|---|---|---|---|
| v0.4.0-dev (06-29) | 20 | 75,163 | 3,702 | 32 | no | no: every store searched (`forge-ask-all.mjs:36`) | 8 | no |
| v3.3.1 (07-17) | 53 | 132,135 | 3,675 | 45 | no | no | 8 | no |
| v3.9.85-dev (07-27) | 62 | 150,165 | 3,640 | 45 | no | no | 8 | yes (`:327`) |
| v4.0.36 (08-08) | 62 | 136,587 | 3,689 | 48 | yes (`forge-mcp-all.mjs:291`) | yes (`:339`) | 8 | yes |
| v4.3.21 (09-10) | 184 | 146,974 | 3,595 | 48 | yes | yes | 64 | yes |
| v4.5.5 (10-04) | 199 | 162,680 | 3,587 | 54 | yes | yes | 64 | yes, except when the question names the repository |
| corpus of 11-16 (4.7.28) | 210 | 176,587 | 3,538 | 58 | yes | yes | 64 | same |

Three things this table settles. The piece size never changed (about 3,600 characters at every date). The
two releases on either side of the turn (v3.9.85-dev and v4.0.36) hold the same 62 stores, so the difference
between them is the path, not the corpus. And an old corpus can be asked only about half to three quarters of
today's answer keys (32 to 48 of 60), which limits any old-release comparison.

Status of the old-release arms at 1:17 a.m.: v0.4.0-dev, 3 of 3 questions timed out at 300 s (one store at a
time, lowest priority, machine load 25 to 60); v3.9.85-dev, 2 of 2 timed out at 150 s. They need a quiet
machine and normal priority to finish; that was not available tonight.

## 6. The diff window: 2026-07-27 to 2026-07-30

What changed in four days (all **[L]**, by reading the commits):

| When | Commit | Change | Stated reason | Evidence in the commit |
|---|---|---|---|---|
| 07-27, 8:26 p.m. | 2f9726d0 | a keyword match against hand-written cards answers **before** any search | search cost 19.6 s warm, 73 s cold | "19/19 (100%) answered correctly by repo" on the plug-in's capability questions |
| 07-28, 10:43 a.m. | 3760c32d | the MiniLM-384 copy of every store is retired; only bge-768 remains | none in the commit; ADR-0004 update: non-duplication, footprint | none. Side effect: the retired build was the only one that embedded `title — path` before each piece |
| 07-28, 9:52 p.m. | 859a16de | a router built on the cards chooses which stores to search | subject line only | not read |
| 07-30, 8:57 p.m. | 453ae584 | the tool calls search with `allowFullCorpus: false`: no route, no search ("Refuse quickly instead of fanning out to every store"); the evaluator keeps the old behaviour | none (empty message; 119 files, 12,200 lines) | none |
| 07-30, 11:39 p.m. | 40456752, 14f654e2 | two "frozen" test questions rewritten; frozen hash re-pinned | none | **[G:D-33, D-34]** |

Earlier, same month: 2026-07-20 (2906422f), results the reranker scored below zero are withheld (**[G:D-17]**).
Later additions on the same path: pool 8 to 64 (2026-09-07); a 20-second limit on the command-line entry point (2026-09-11; the MCP tool handler passes no such limit).

Why it was done: the search-everything design did not survive growth. 19 stores in June, 69 by 2026-07-22;
three sample searches took 91, 122 and 151 seconds; "82 of the 120 recorded cold queries (68.3%) already
exceed the 120s proxy timeout" (**[G:C-92, C-110]**); an outside user's unscoped search used 17 GB
(**[G:E-110]**). Two cheaper fixes that kept the search (re-read fewer documents) were measured that week
and left switched off.

What users then saw: "'Searched 0 RuvNet repos' is indistinguishable from an empty corpus" (issue #132,
2026-08-09, **[G:E-156]**); "every search_ruvnet call is declined" with one store installed (issue #530,
2026-11-10, open, **[G:E-249]**).

## 7. Hypotheses, each tested or marked untested

| Hypothesis | Test | Result so far |
|---|---|---|
| H1. It was never better at file level; earlier confidence came from repository-level tests on questions that named the repository, on a small corpus | sections 2 to 4; the old test files; the 7-of-76 bound | Supported for August onward by reproduction (0/60 on 4.0.36). For June and July: supported by the bound (at most about one in ten) and by the old tests being repository- or card-level (**[L]**); not reproduced |
| H2. The July 27-30 change (cards first, route or refuse) took away results the user used to get | 4.0.36 arm vs v3.9.85-dev arm | 4.0.36: no search for 45 of 80, a card for 18. The release before it always searched (code, **[L]**) but could not be run to completion tonight |
| H3. Corpus growth diluted results | nightly series; v0.4.0-dev arm; cross arms | Repository-named file-level: flat from 625 to 864 MB. One recorded dilution: gist store, 47 to 44 of 48 (July). Small-corpus arm not finished |
| H4. Retiring the MiniLM build removed the only header-carrying vectors | compare v3.9.85-dev (both builds in bundle) with later arms | Untested directly: the reader preferred the big build when present even before the retirement (**[L]** `forge-ask.mjs` rule), so the header build was probably not being read for most stores. Stated as a finding about the record, not as the cause |
| H5. The identifier lane (2026-09-11) broke retrieval, as believed on 2026-09-15 | A/B at the time | Refuted then: 183 vs 177 of 194 (**[G:A-43]**) |
| H6. Chunking or the embedder changed | git history | Neither changed in any shipped release (VERSION-TABLE.md) |

## 8. The owner's earlier "it regressed" moments, and what each turned out to be

| Date | What he said or believed | What the check showed | Citation |
|---|---|---|---|
| 2026-07-19 | the Brain fell from 49 to 32 | same test: 47 then 44 of 48; the 32 was a new, harder exam (meeting transcript); cause of the 3: gist store growth | **[L]** memory `REGRESSION-truth-…` |
| 2026-09-15 | "You told me weeks ago ... you had a perfect embedder that recalled with 98% accuracy... Why is it still an open issue a month later?" | 0.98 was the pass mark of a 19-question sample check; on 2026-09-30 that check was shown to be "a coin flip ... earlier releases passed by sample luck"; whole-set recall was 89% | **[L]** owner memory `feedback_find_when_it_last_worked_first.md`; memory `finding-canary-gate-unsound-…` |
| 2026-10-12 | "it wasn't working last month in September, but then you supposedly fixed it all" | not traced | **[G:F]** |
| 2026-10-15 | "you're still working on specific word matching ... You have a vector database" | in November the word matching was the strongest lane and the vectors, as built, added nothing | **[G:F]**; `DECISIONS.md` D7, D10 |
| 2026-11-16 | "it wasn't this bad months ago" | this file | **[G:F]** |

## 9. How information was stored and searched when the recorded scores were highest (June 29 to mid-July)

For borrowing, with the caution that those scores were repository-level:

- **Stores:** 19 to 37, one per repository, plus a small hand-written "concepts" store (primers and
  capability cards) that was searched like any other store.
- **Cutting and models:** the same 4,000-character pieces; two vector copies of every store, MiniLM-384 with a
  `title — path` header and bge-768 without.
- **Search:** every store, every time; the best 8 documents from each; one reranker pass over all of them;
  top 6 returned; +2.0 when the question named the repository. No card shortcut, no router, no refusal, no
  dropping of low-scored results (until 2026-07-20), no time limit.
- **What is worth borrowing, and what the run already borrowed:** (1) *always search, never refuse* (the
  run's design has no router and no card answers); (2) *hand-written cards as candidates inside the search*,
  not as a gate in front of it; (3) *a title and path in front of the embedded text*. What is not worth
  borrowing: re-reading 600 documents per question, which is what made it too slow to keep.

## 10. What could not be reproduced or established

- Any release between 2026-08-09 and 2026-09-03 has no bundle of its own (releases in that span reused
  earlier bundles); corpus-only nightly bundles start 2026-09-29.
- Old arms run on today's machine under load, at low priority; their timings are not the timings users saw.
- Answer keys are today's; "gold present in that corpus" limits how many questions an old corpus can be
  fairly asked.
- I did not read the 119-file diff of 453ae584 beyond the search path; a reason for it may exist in an issue
  or a session record that was not found.

## Arms finished 2026-11-17

Run between 3:27 a.m. and 4:58 a.m. ET on 2026-11-17, **[R]**, by the same harness (`tools/ask-arm.mjs` in the
scratch folder): each release's own `forge-mcp-all.mjs` as a stdio MCP server, `search_ruvnet {query}` only,
its own corpus, fake home folder, the same 80-question sample and the same scoring (`norm.mjs`; file-level =
a gold file among the first five results; sets D, E, F carry file gold, set H only an expected repository).
Settings for both arms: one question at a time, one arm at a time, 600 s per question, reader store
concurrency 2 (the harness sets it), reader at nice 19 except where the June arm says nice 0, the 1-minute load checked before every question and the run paused 60 s
while it was above 40. Isolation was checked during a running question of each arm: `lsof` on the reader
process listed no path containing `ruvnet-brain` outside the scratch folder, and the v3.9.85-dev reader wrote
its state file into the fake home. Order: the first 3 questions of each set, then the first 10 of each set
(the same 40-question subset as section 5's settings), then the rest; v3.9.85-dev was stopped at the 40-question
boundary so that the June arm could have the remaining time. Rows: `history/bisect/v3.9.85-dev.jsonl`,
`history/bisect/v0.4.0-dev.jsonl` (each row carries the load before the question); the earlier 300 s attempt
of the June arm is kept as `history/bisect/v0.4.0-dev-300s-timeout-attempt.jsonl`.

### v3.9.85-dev (2026-07-27, last release before the cards-first change)

| Measure | Value |
|---|---|
| Questions asked | 40 (D 10, E 10, F 10, H 10) |
| Answered | 40 |
| Timed out (600 s) / errors | 0 / 0 |
| Right file in the first five (D+E+F) | **0 of 30** (D 0/10, E 0/10, F 0/10); gold file present in that corpus for 21 of the 30: 0 of 21 |
| Right repository in the first five (D+E+F) | 7 of 30 |
| Old held-out questions (H), expected repository in the first five | 7 of 10 |
| By asker group (D+E+F) | novice/amateur: file 0 of 18, repository 2 of 18; all other askers: file 0 of 12, repository 5 of 12 |
| Stores searched per question | 62 of 62, every question |
| Results returned | 1 result for 35 of 40; 3, 4 or 6 for the other 5 (results the reranker scored below zero are dropped, `forge-ask-all.mjs:327`) |
| Card answers / no search | 0 / 0 |
| Median seconds per question | 45.0 (load before a question: 17.8 to 39.9; nice 19) |
| Vector build read | the `.big` (bge-768) build for all 62 stores: the reader picks `.big` whenever it exists (`forge-ask.mjs:79`) and the all-store search passes no variant (`forge-ask-all.mjs:141`); the MiniLM build with the title-and-path header was present for 60 stores and not read |

### v0.4.0-dev (2026-06-29, first release, 20 stores)

| Measure | Value |
|---|---|
| Questions asked | 6 (D 3, E 3; the run reached its 4:55 a.m. stop before F and H) |
| Answered | 3 |
| Timed out (600 s) / errors | 3 / 0. The first 2 questions ran at the harness's usual low priority (nice 19, load 23.8 and 34.5) and both timed out; the next 4 ran at normal priority (nice 0, load 22.2 to 36.5): 3 answered, 1 timed out |
| Right file in the first five (D+E) | **0 of 6** (the 3 timeouts count as misses); of the 3 answered, 0 of 3; gold file present in that corpus for 5 of the 6 |
| Right repository in the first five (D+E) | 0 of 6 (one answered question had the gold repository at rank 6) |
| By asker group | novice/amateur: file 0 of 6, repository 0 of 6; no other asker group was reached |
| Stores searched per answered question | 20 of 20 |
| Results returned | 6 for each answered question |
| Seconds per answered question | 285, 542, 543 (median 542) |
| Why it is slow (watched with `lsof` during a question) | the reader goes through the 20 stores one after another and for each one re-reads that store's whole passage file (453 MB across the bundle) and metadata (48 MB) before its vector query (`forge-ask-all.mjs:36-48`, `forge-ask.mjs:578`); at nice 19 it took 40 to 80 s per store |

The arm did not crash; it is too slow to finish more than a few questions in the time available on this machine
under this load. Six questions do not support a rate.

### Comparison on the same question IDs

| Release | Questions (same IDs) | Right file in first five | Right repository in first five, D+E+F | H: expected repository | Zero results | Card answers | Median s |
|---|---|---|---|---|---|---|---|
| v3.9.85-dev (07-27) | 40 | 0 of 30 | 7 of 30 | 7 of 10 | 0 | 0 | 45.0 |
| v4.0.36 (08-08), same 40 IDs from its finished 80 | 40 | 0 of 30 | 0 of 30 | 9 of 10 | 28 ("Searched 0 RuvNet repos") | 8 | 0.008 |
| 4.7.28 code + 11-16 corpus, the 26 of these IDs it was asked before it was stopped | 26 (D 10, E 10, F 6; no H) | 0 of 26 | 8 of 26 | not asked | 0 | 2 | 21.0 |

On the 6 IDs the June arm was asked (X6-07, X6-04, X4-18, E1-01, E1-05, E1-16):

| Release | Asked | Answered | Right file in first five | Right repository in first five | Median s (answered) |
|---|---|---|---|---|---|
| v0.4.0-dev (06-29) | 6 | 3 | 0 of 6 | 0 of 6 | 542 |
| v3.9.85-dev (07-27) | 6 | 6 | 0 of 6 | 0 of 6 | 49.4 |
| v4.0.36 (08-08) | 6 | 6 (5 with zero results, 1 card) | 0 of 6 | 0 of 6 | 0.013 |
| 4.7.28 code + 11-16 corpus | 6 | 6 (2 card) | 0 of 6 | 0 of 6 | 20.7 |

For scale, the shipped 4.7.28 numbers already in this document were measured on other question sets and are not
the same IDs: 4 of 113 development questions (top 6) and 8 of 164 blind questions (set E); the partial
reproduction of 4.7.28 above section 5 gave 3 of 54. The finished v4.0.36 arm on all 80: 0 of 60 files, 12 of 60
repositories, 17 of 20 on H.

### What H2, H3 and H4 can now say

- **H2 (the July 27-30 change took away results the user used to get).** Measured on the same 40 questions:
  the release before the change searched all 62 stores for 40 of 40 and returned at least one result for
  40 of 40; the release after it returned zero results for 28 of 40 and a card for 8. The right repository was
  in the first five for 7 of 30 problem-style questions before and 0 of 30 after; the right file for 0 of 30
  before and 0 of 30 after. Under these conditions the change removed repository-level results; no file-level
  result existed on these 30 questions to remove. On the 10 old held-out questions the later release scored
  9 of 10 against 7 of 10.
- **H3 (corpus growth diluted results).** Not answered by a reproduction. On the June corpus (20 stores) the June reader found the right file for
  0 of 6 questions it was asked (3 answered, 3 timed out), and the right repository for 0 of 6; on the same 6 IDs
  the July 27 arm (62 stores) got 0 of 6 files and 0 of 6 repositories, v4.0.36 got 0 of 6 and 0 of 6,
  and 4.7.28 got 0 of 6 and 0 of 6. Six questions, three of them timeouts, cannot
  separate a small-corpus effect from zero. The repository-named nightly series (section 3) remains the only
  growth measurement: flat from 625 to 864 MB.
- **H4 (retiring the MiniLM build removed the only header-carrying vectors).** Measured by reading the
  July 27 reader and by the arm: with both builds in the bundle for 60 of 62 stores, `search_ruvnet` read the
  bge-768 build for every store, and found the right file for 0 of 30. The MiniLM header build was therefore
  not on the tool's path on July 27, the day before it was retired; its retirement cannot have changed what
  this tool returned. Whether the header build would have found more files was not measured.
