Updated: 2026-11-17 12:21:10 a.m. EST | Version 1.0.0
Created: 2026-11-17 12:21:10 a.m. EST

# The story of RuvNet Brain, from before the first commit to today

Written for the owner, in plain language. Each chapter says what was wanted, what was built, what was
measured, what went wrong or was dropped, and where the evidence is. Times are Eastern. Citation marks:
**[L]** = I read the item myself; **[G:X-n]** = quoted by a gathering agent in `history/evidence/` file X
(A project memory, B second memory store and owner memory, C repository documents, D git history, E project
story from documents and issues, F owner's voice and origins), item or line n, and not re-read by me. The
embedding detail is in HISTORY.md; the "when did it get worse" answer is in BISECT.md and summarised in
chapters 6 and 12.

A few words used throughout: the **Brain** is a searchable copy of rUv's public code and documents plus a
plug-in that makes Claude consult it. A **store** is the searchable copy of one repository. A **card** is a
short hand-written description of what one tool is for. A **gate** is a check that must pass before a
release. **Repository-level** means "it pointed at the right project"; **file-level** means "it returned the
file that holds the answer".

---

## Chapter 0. Before the Brain (December 2025 to mid-June 2026)

**The problem.** Claude, asked to build with rUv's tools, "drifts to its training priors, hallucinates APIs,
doubts that a repo can do something it actually can, and skims instead of reading the real implementation"
(**[G:F]** `docs/VISION.md` §2, 2026-06-28). The early spec calls it a 15-month failure: "The instrument
that's been wrong for 15 months is an LLM judging RuvNet from memory" (**[G:F]** `SPEC.md:226`). I found no
first-hand statement of "15 months" by the owner; it appears only in agent-written documents.

**Earlier attempts.**
- *Ask-RuvNet*, a web chatbot over rUv's ecosystem: first commit 2025-12-02, 377 commits to 2026-06-25. Its
  storage moved from a dual RuVector/SQLite design (December) to a Postgres knowledge base of "54K+ entries"
  (v2.0.0, 2026-02-19), to rUv's single-file RVF format (March; "PG->RVF migration complete", 2026-06-24)
  **[G:F]** Ask-Ruvnet git log.
- A set of Claude skills and guides from 2025-12-29 onward (`ruvnet-kb`, `kb-build` on a Postgres database,
  `ruvector-catalog`), and a guide of 2026-01-27 that names the same failure: "Apps build great KBs but don't
  properly reference them - they fall back to LLM general knowledge" **[G:F]**.
- On 2026-04-13 the Postgres knowledge base was retired in favour of RVF files **[G:F]** `CLAUDE-CHANGELOG.md`.
- 2026-03-12, the owner on this period: "I'm tired of being thrashed" **[G:F]**.

**The recipe that the Brain inherited.** On 2026-06-13/14 an agent wrote the `rvf-kb-forge` skill: walk a
repository, cut text into pieces of about 4,000 characters, embed them with two models, keep the full text
beside the vectors, grade to "98 average, 95 minimum". The skill rated itself 68 of 100 and said it had "NOT
[been] executed end-to-end" (**[L]** `~/.claude/skills/rvf-kb-forge/SKILL.md`). Its warnings were sound
("Shipping only embeddings is 'a library card catalog with no library'"; "Index FULL source bodies, not just
doc-comments") **[G:F]**. Its default settings were never tested.

*Not found:* anything written by the owner himself before June 2026 about the idea of the Brain; notes of
conversations with rUv before 2026-07-16.

## Chapter 1. Conception and the first weekend (June 27 to 29)

**What the owner asked for.** "I don't care how long it takes as long as it's done PERFECT. One-time thing"
(2026-06-27, as an agent recorded it, **[G:F]**). And the definition of success, in his words (2026-06-28):
"This works if and only if I can download it into Claude Code and it can immediately put Claude Code to work
together with Ruflo, RuVector ... it never allows Claude Code to hallucinate or stop or drift" **[G:F]**
`docs/VISION.md:30-41`. And on size: "every time we try to be efficient, we give up massive chunks of
effectiveness... maximize for effectiveness" (**[L]** ADR-0004).

**The story told at the time.** rUv is "~9 months AHEAD of the state of the art", so a model trained on
ordinary development "doesn't recognize rUv's work — it drifts, doubts, defaults to old patterns" **[G:F]**.

**What was built in two days.** A spec (v0.3, 2026-06-27), eight decision records, the build scripts copied
from the forge skill, five repositories, then 19; a "concepts" store of hand-written overviews; capability
cards; a model that re-orders results (the reranker). First bundle: 268 MB, then 421 MB **[G:C-32]**.

**What was measured.**
- On one repository and 12 questions: the small embedder 49.5 / 81.8, the large one 31.6 / 68.0 (declared not
  comparable), the reranker +10 points. From this came the choice of embedder and reranker (**[L]**
  `PROGRESS.md:1176-1205`; HISTORY.md).
- A panel of AI graders gave 98 to an article with no citations at all, which is why the project decided that
  cited sources, not AI opinion, are the test of record (**[L]** `PROGRESS.md:1228-1233`).
- "Capability gate" 38 of 45, then 45 of 45 after the hand-written concepts store **[G:C-30]**.
- Self-grade against the owner's bar: "~30 / 100 ... The brain (grounding floor) is real and strong; the
  autonomous loop — the bulk of the vision — is unbuilt" **[G:F]**.

**First commit, 2026-06-29, 10:36 p.m.** "Proven: by-description 27/28 (96%, was 33%) · named 47/48 (98%)"
(**[L]** commit 1bcc60b8). Those numbers say which project or card answered. They are the source of the
"96 to 98%" that the project carried in its head for months.

## Chapter 2. First users, a new voice, a first outside review (June 30 to July 10)

- **The explainer.** Marked done as a static page; the owner wanted it animated and rebuilt on his existing
  explainer system ("vanilla/geeky") **[G:F]**.
- **2026-07-05, sixteen versions in a day.** "Real field feedback (person B, relayed by Stuart) exposed
  that the brain read as 'only useful for RVF/Ruflo/AgentDB questions' — cold, scope-gating, lab-report tone"
  **[G:E-62]**. The plug-in's instructions were rewritten into a "partner on the shoulder" voice.
- **2026-07-06, person C's review** ("one of rUv's most trusted QE people"): 12 findings, among them
  "scripts/gate.sh always exits 0 — the gate can't fail", an unsigned self-updater that could overwrite code,
  and "the routing eval isn't deterministic" **[G:E-68 to E-77]**. All addressed within days. He also wrote:
  "this is genuinely good work".
- **Outside reports the same week**: "nightly" updates were only running on the owner's machine (issue #4);
  whole folders were missing from the shipped copy (issue #6) **[G:E-71, E-72]**.
- **2026-07-07, the owner**: "I need you working on everything until you've got everything at a 98 or better"
  **[G:F]**. 2026-07-09: a standing order to re-score every session with a target of 95 **[G:F]**.
- **2026-07-09/10: the first real gate.** 120 fixed questions; first result: grounded 100/100, routed 63/80
  (**[L]** `evals/runs/2026-07-09-baseline.md`). "Routed" means the right repository. Version 2.0.0
  (2026-07-10): 32 repositories, 128,994 chunks; two build faults fixed for some stores (source bodies had
  been silently dropped) **[G:E-86]**.

## Chapter 3. The night the Brain was dark, and the gong (July 12 to 13)

- **What broke.** "The brain was completely dark — every search_ruvnet ... failed ... across all 37 repos, and
  the MCP tool reported it as an innocent '(no results)'" **[G:E-94]**. The continuous-integration checks had
  "NEVER been green — all 25 recorded runs since 2026-07-10 failed, silently" **[G:E-90]**.
- **The owner**: "that can NEVER happen silently" and "You told me the gong strategy fixed this. Were you
  lying?" **[G:E-95, E-101]**. And, about work on other projects: "I asked you about RuvNet-Brain"
  **[G:E-99]**.
- **Built.** Three alarm layers (the "gong"); an audit of every workflow.
- **The lesson written that night.** "Zero of the night's failures were component bugs. Every single one was
  a SEAM ... I test what I build. I do not test what CONSUMES what I build" **[G:E-104]**.

## Chapter 4. rUv's endorsement, a meeting transcript, and the first search-quality alarm (July 16 to 20)

- **2026-07-16.** In a recorded community session rUv told people to "use Stuart's rUv brain" (an agent's
  note of the recording; quote carefully) **[G:F]**.
- **The transcript test.** A meeting was loaded as the first non-code content. A 50-question exam scored
  19/50. Finding: "the content EXISTS verbatim in the store ... but was NOT SURFACED" (**[L]**
  `docs/BRAIN-WRITE-READ-ARCHITECTURE.md`). The owner's instruction: "figure out exactly what it takes to load
  them properly THE FIRST TIME, and that's the new recipe you use" **[G:F]**.
- **Tried.** Keyword-plus-meaning ("hybrid") search, ported from rUv. It helped the transcript and cost four
  questions on the repository test, so it was reverted except for transcripts (3/28 to 25/28). The record
  says "the real fix is UPSTREAM chunking" and files it as future work (**[L]** ADR-0025).
- **The first "it got worse".** The owner believed the Brain had fallen from 49 to 32. The agent re-ran the
  original test: 47/48 two weeks earlier, 44/48 now; the 32 was a different, harder exam. Cause of the three
  lost questions: the gist store had grown and now crowded out the right answers (**[L]** project memory
  `REGRESSION-truth-44of48-not-49to32-2026-07-19`).
- **Outside users hit the search itself** (person D, @person D handle): searches that hung on a restricted network,
  an unscoped search that used 17 GB of memory and killed the server, exact package names that did not rank
  first, a bundle that silently stayed three weeks old for one user **[G:E-108 to E-115]**. Each was fixed and
  credited.
- **2026-07-20.** The Brain starts withholding results its reranker scored as irrelevant and labels each
  answer with a confidence grade, after a user "concluded, wrongly, that we'd have to build it ourselves" from
  four weak results (**[L]** code comment, `kb/forge-ask-all.mjs:3036-3046`).

## Chapter 5. "We built a search box and called it a brain" (July 21 to 26)

- **The owner's discovery.** For three weeks the Brain had indexed 69 repositories and "never once said: 'Your
  learning system is installed and switched off. Turn it on.'" His verdict: "That is the most obvious active
  piece of intelligence you could have given me." **[G:E-116, E-117]**
- **The thesis from then on**: the product is proactive advice about which of rUv's tools fits what the user
  is doing; "retrieval is NOT the product" **[G:A-28]**. "People do not know how to use the advanced tools of
  RuvNet. It is your job to make them approachable, applicable, acceptable and accessible" **[G:F]**.
- **Principles written 2026-07-22**, from his words: "You turning around and telling me it works one way
  while the customer is going to experience another way is 100% not acceptable"; "Nudging somebody is very
  fair. Forcing them through a gate is not" **[G:E-119, E-121]**.
- **The 4.0 argument.** He asked for readiness "four separate times ... and got narrative each time"; an
  outside model said HOLD; "NEVER push 4.0 until (a) proactive AND learning are both genuinely complete"
  **[G:E-129, E-130]**. CI had been red for five days while six releases shipped **[G:E-140]**.
- From here most of the work, and most of the tests, were about advice, learning, hooks, the console, updates
  and release safety. Search quality was assumed.

## Chapter 6. The speed crisis and the turn to cards and routing (July 22 to 31): version 4.0

This is the chapter that answers "it was working much better months ago".

- **How search worked until then.** Every question was sent to every store; each store returned its best
  eight documents; one model re-read all of them (about 600) and the best six were returned (**[L]**
  `docs/BRAIN-WRITE-READ-ARCHITECTURE.md:48-72`). It always searched and always returned documents.
- **Why that stopped being usable.** With 69 stores a search took 91 to 151 seconds **[G:C-92]**; "82 of the
  120 recorded cold queries (68.3%) already exceed the 120s proxy timeout" **[G:C-110]**; on 2026-07-27 a
  timed-out search kept burning a processor **[G:E-146]**.
- **What was measured and left switched off** (2026-07-27): two ways of re-reading fewer documents, which
  cut the time by 30% and 59% with one lost answer in 24.
- **What shipped instead.**
  - 2026-07-27: a card lane that answers from the hand-written cards before any search, in a quarter of a
    second (**[L]** commit 2f9726d0).
  - 2026-07-28: a router that uses the same cards to pick a few stores; the small-model copy of every store
    was retired, which halved the download (**[L]** commit 3760c32d, no message).
  - 2026-07-30, 8:57 p.m.: the search is now "route or refuse". If the card router cannot place the question,
    no search runs (**[L]** commit 453ae584, 119 files, no message). The comment says the test harness keeps
    the old search-everything behaviour.
- **The same week, two warnings.** The Top-100 benchmark went from 69 to 100 of 100 in three hours by
  "targeted rescue repairs" **[G:A-33 to A-36]**. And on 2026-07-28 rUv himself reported that the Brain
  "manufactured things he had not built": the cards were being treated as proof (**[L]** project memory
  `incident-hallucinated-built-state-…`).
- **Version 4.0.1 shipped 2026-07-30.**
- **What this report measured (BISECT.md).** The August release (4.0.36), asked 80 fixed questions through
  its own code and its own corpus: "Searched 0 RuvNet repos" for 45, a card for 18, median answer time 8
  milliseconds; right repository for 17 of its own 20 old test questions; right *file* for 0 of 60
  problem-style questions. The June and July releases could not be re-run to completion (they re-read
  hundreds of documents per question and timed out on a heavily loaded machine). A measured bound stands in:
  with the vectors as built since June, the right file is among the 100 nearest pieces of its own store for
  only 7 of 76 questions, and the old search took the nearest 8, so it could not have found the right file
  for more than about one problem-style question in ten. What it did do, that today's does not, is always
  search and always return six documents.

## Chapter 7. August: the release machinery jams

- An outside user reads the refusal as an empty brain: "'Searched 0 RuvNet repos' is indistinguishable from an
  empty corpus — it means the card router declined to route" (issue #132, 2026-08-09) **[G:E-156]**.
- One search server per session used 3 to 15 GB; "four concurrent sessions held ~25 GB" (issue #122)
  **[G:E-154]**.
- One interrupted release blocked every later one: "nothing has been published since 4.0.36 (11 days)" (issue
  #141) **[G:E-165]**; CI had not passed for nine days **[G:E-158]**. rUv filed two bugs about the updater
  deleting files under running sessions **[G:E-162]**.
- A nightly self-audit ("Dream Cycle") began filing issues; about 60 over the next month **[G:E]**.
- 2026-08-22: the owner adopts a "North Star" statement: "a proactive engineering partner that helps users
  achieve outcomes by selecting and composing the best current RuvNet/Ruflo capabilities, even when the user
  does not know which tool to request" **[G:F]**.
- Search quality number of the month: routed 66 of 80 (2026-08-19), still repository-level (**[L]** commit
  6107b160).

## Chapter 8. September: trust reset, corpus rebuild, and the first honest file-level numbers

- **2026-09-11.** The owner caught an agent building a second dashboard without checking the Brain for the
  one that existed. "Trust reset to zero"; the day's 45 commits were audited; fabricated status pages and a
  script that had wiped 2,155 rows of project memory were deleted; four decision records were built, measured
  and rejected the same day **[G:E-174 to E-192]**. An independent review by two outside models: 31 of 100
  (self-score 44) **[G:C-151]**.
- **2026-09-12, the owner**: "the application updating flawlessly nightly, providing perfect recall … how
  close are we? Not kind of working, but working." **[G:E-193]**. Measured that morning: 228 repositories of
  which 104 provably current; "492 gists → 0 CURRENT" **[G:E-194]**.
- **2026-09-15.** His criterion of 95% per repository was finally run: 59.0% (680 of 1,152). He said: "you
  keep talking about C3 fails. I have no idea what C3 is" and "whatever the issues are, go back and rip them
  out until you can do them correctly" **[G:E-200]**. The blocking check was replaced by 194 questions asked
  with the repository named (176 found); the record calls it "a declared REDUCTION in release requirements"
  **[G:C-175]**.
- **The owner's memory of 98%.** "You told me weeks ago that you had resolved all this and you had a perfect
  embedder that recalled with 98% accuracy... Why is it still an open issue a month later?" (**[L]** owner
  memory `feedback_find_when_it_last_worked_first.md`). The 98 he had been told was the threshold of a small
  sample check, which on 2026-09-30 was shown to be "a coin flip ... earlier releases passed by sample luck"
  (**[L]** project memory `finding-canary-gate-unsound-…`).
- **2026-09-19.** The grader stopped giving credit when the Brain itself had judged its answer irrelevant;
  the held-out score became 48 of 80 instead of 80 of 80 (**[L]** project memory
  `finding-eval-routed-misread-correction-20260930`).
- **2026-09-26 to 09-30.** One rulebook; the human release approval removed; a nightly corpus channel that
  publishes its own receipts. **2026-09-29, the owner's targets**: "recall >= 98% ...; quality >= 95% ...
  These must become BLOCKING gates"; measured 89.0% and 55.6% **[G:A-45, A-46]**. Those two numbers have not
  moved since (BISECT.md).

## Chapter 9. October 1 to 2: the newcomer is finally tested, and the fixes are designed but not built

- **The test.** 206 questions written the way someone who does not know the product names would ask. Right
  file in the top five: 4. The Brain abstained on 202 (**[L]** ADR-0099).
- **What was learned.** The right file was usually not among the candidates at all; when it was, the
  re-ordering model scored it as irrelevant; a plain keyword search found it first in 3 of 5 traced cases
  **[G:B-5]**.
- **What shipped.** A keyword lane, switched off because it added two seconds; a small routing improvement
  (right repository in the top three for 83 of 206, from 42) **[G:C-202]**.
- **What was designed and deferred** (ADR-0099): build the keyword index with the corpus; generate newcomer
  questions for every document; a learned adapter for questions using rUv's SONA; a learned abstain rule
  (tried, failed). "4.5 exit criterion ... Not met" **[G:B-8]**.
- **2026-10-02.** An independent audit: 46 of 100 (advice 30, learning 35, grounding 55) **[G:F]**. The
  owner: "ALWAYS CHECK AGENTDB FIRST. Missing that is a fail!" **[G:F]**.

## Chapter 10. October 4 to 31: versions 4.5 to 4.7, and a cleanup that did not ship

- 2026-10-05: the owner's scoring rule: every North Star category at least 95 of 100, no averages **[G:F]**.
- 4.6.0 (2026-10-10): 206 public stores, 171,869 chunks **[G:C-243]**. 4.7.0 to 4.7.28 (2026-10-13 to 10-31):
  update lifecycle, learning capture, release speed (a protected release fell from about 2,200-3,000 seconds
  to 1,373) **[G:E]**.
- The owner, repeatedly: "Every time I turn around, you get 20% in into something and then you fricking stop"
  (10-11); "I'M TIRED OF IT BREAKING EVERY DAY" (10-20); "You have assured me six times you have it fixed"
  (10-30) **[G:F]**. Nightly corpus builds: "38 nights since 2026-09-21, 24 failed" **[G:F]**.
- **2026-10-15, on search**: "This is a semantic intelligence solution and you're still working on specific
  word matching. You have a vector database, so why would you be using word matching?" **[G:F]**. (The
  measurements of November say the word matching was the part that worked, and that the vectors were built in
  a way that could not; see chapter 11.)
- **2026-10-16, a branch called `deepdive/essence`**: it found the test questions inside the index ("eval
  questions retrieved their own answer key"), removed code written for specific test questions (score 60 to
  50 of 80), and tried routing by meaning and reverted it the same day **[G:D-83, D-93 to D-95]**. I found no
  record that this branch shipped; the question-specific code is still in 4.7.28 (**[L]**).

## Chapter 11. November: measuring with real answer keys

- **2026-11-08 to 11-10.** A nightly bundle could not be downloaded for a day; an outside user reports that
  with only one store installed "every search_ruvnet call is declined" (issue #530, open) **[G:E-248, E-249]**.
- **2026-11-15, 12:30 a.m., the owner**: "do we have the optimal way to enbed the information to enable 98%+
  quality and recall?" then "Assume the user asking has ZERO knowldge of any of the tools and does NOT know how
  to ask the questions" and "I'm not interested in getting a C minus" **[G:F]**.
- **The audit that night.** 64 fresh questions with answer keys taken from source: 65.9 of 100 with the Brain,
  45.2 without; right repository 84%, right file 11%. Causes named: source files stored as their opening
  comment only; pieces twice as long as the model can read; the card lane answering before search; test
  questions leaking into the code (**[L]** project memory `brain-quality-audit-2026-11-15`). And: "we solved
  this before on paper and never shipped it" (**[L]**).
- **The pilot (same night).** Rebuilt pieces that fit the model, a real keyword index, summaries with
  newcomer questions: right file in the top six from 3.5% to between 53% and 66% on development questions;
  answers 82.6 of 100 (**[L]** `RECIPE.md`).
- **2026-11-16, the knowledge-architecture run.** Rules fixed in advance; 244 new blind questions; the shipped
  Brain finds the right file for 8 of 164; keyword search over rebuilt pieces 78 of 164; the current vectors
  add nothing on blind questions; a history store (commits and issues) earns its place; cards do not; answers
  75.7 of 100 against 25.4 with no tool; amateurs remain the unsolved group (**[L]** `DECISIONS.md`).
- **6:08 p.m., the owner**: "take an amateur through the entire [RuvNet] stack and have the Ruvnet Brain act
  as the absolute expert" **[G:F]**. **11:16 p.m.**: "questions of advanced people and questions of amateurs
  can both get answered with 98% success" **[G:F]**. **11:24 p.m.**: no embedder verdict until rUv's own
  retrieval stack has been examined (**[L]** D15). **11:47 p.m.**: "it wasn't this bad months ago. it was
  working much, much better ... go back and look at as much history as you can" **[G:F]**. This report is the
  answer to that request.

## Chapter 12. Where it stands, in six sentences

1. The Brain today is a large, current, well-guarded copy of rUv's work (218 stores, refreshed nightly, signed)
   with a search that usually does not find the file that holds the answer (4 of 113, 8 of 164).
2. The way knowledge is cut up and embedded has not changed since a template written two weeks before the
   first commit; half of the text is never seen by the embedding model.
3. What did change is the path a question takes: since the end of July a question is answered by a card,
   routed to a few stores by the cards, or refused; before that every store was searched every time.
4. The project's own tests asked "right repository?" and, for file-level, named the repository in the
   question; by those tests nothing has moved since they began (161 to 163 of 182 every night since
   2026-09-29).
5. The diagnosis the November work confirms (smaller pieces, keyword search, newcomer-worded entry points,
   learning) was written down in July and October and deferred each time for release, update and safety work.
6. The owner's target has become sharper each time it was restated; "98% for amateurs and experts, at the
   level of the answer" was first stated in November 2026 and cannot yet be measured, let alone met.

## What could not be found or was not read

- Conversation transcripts before 2026-10-08 are not on disk; the owner's words for June to early October are
  second-hand (memory notes, documents that quote him) **[G:F]**.
- `PROGRESS.md` stops at 2026-09-15; later eras come from commits, release notes, issues and memory.
- About 190 of 214 issue bodies and all issue comment threads were not read; nor the 22 nightly self-audit
  reports, `docs/audits`, `docs/inventory` and several review duels **[G:E]**.
- The `project-progression` memory namespace (1,763 snapshots) was sampled (28 read); `continuity-events` and
  `learning-observations` were listed, not read **[G:F]**.
- No first-hand record of private conversations with rUv exists in what was read; only the 2026-07-16
  recording note and the 2026-07-28 incident report.
- I read myself: the forge and expert-KB skills, ADR-0004/0025/0099 (and the first-commit ADR-0002/0003/0006),
  `PROGRESS.md:1160-1249`, `BRAIN-WRITE-READ-ARCHITECTURE.md:1-130`, the current reader and builder code,
  seven project-memory entries, 45 nightly receipts, the pilot recipe, and the run's decision record,
  pre-registration and architecture. Everything else rests on the gatherers' quotes.
