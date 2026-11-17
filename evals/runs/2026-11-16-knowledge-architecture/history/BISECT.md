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
