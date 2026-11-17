Updated: 2026-11-17 00:42:00 EST | Version 1.0.0
Created: 2026-11-17 00:42:00 EST

# Note to the owner: the embedding recipe, in one page

**What the Brain does today (4.7.28).** It cuts each repository into pieces of up to 4,000 characters. It turns
each piece into 768 numbers with a model called bge-base-en-v1.5, run with compressed 8-bit weights. It puts no
title or file path in front of the text. The model reads only about the first half of a typical piece, so half
of all the text is never seen. Ordinary source files are stored as their opening comments only. A question
first meets hand-written cards, which may answer it without any search, then a router that may refuse to
search, then search, then a second model that drops results it scores below zero. The full detail, with the line
of code for every value, is `EMBEDDING-RECIPE.md`.

**Why it was chosen, honestly.** It was not chosen by measurement. The cutting came from a template an agent
wrote two weeks before the first commit, which said itself it had never been run. The model was picked under
your "maximize for effectiveness" directive, on 12 questions in one repository, where the smaller model actually
scored higher and the comparison was marked not comparable. The benchmark promised in ADR-0004 was never run.
The 8-bit weights were a library default. The one build that put a title and path in front of the text was
retired in July to halve the download. The cards, router and refusal were added in late July for speed, when a
search took one and a half to two and a half minutes.

**What the measurements now show.** The right file is in the top five for 4 of 113 development questions and 8
of 164 blind questions, although the file is in the index for 110 of 113. With the same model and better pieces,
26 of 76 instead of 3. Keyword search over better pieces finds 78 of 164 blind questions. The current vectors add
nothing to keyword search on three separate question sets. A store of commits and issues finds history questions
nothing else finds. With keyword search and history, answers score 73.1 of 100 (75.7 with cards, which were not adopted), against 25.4 with no tool.
People who describe only their problem, in everyday words, are still served poorly. On 120 new questions
written that way (set G), keyword search finds the right file in the top five for 15, and the current vectors
for 12. The project's earlier
"96 to 98%" numbers counted the right repository or card, not the right file. No file-level test of this kind
existed before 30 September.

**What is proposed, and what is unproven.** For v5: store short "cue" sentences in everyday words and one-line
capability descriptions, put the vectors on those, link problem to capability to package to file, and walk those
links with rUv's own graph operator; keep keyword search and history; add a reranker that reorders but never cuts
off; return answers in sections; say "nothing matches" as a real answer. Because the Brain must guide, not only answer, a third measure is
registered: on build-goal questions (set H), an answer counts only if it scores 8 or above, names at least two
thirds of the right tools, and puts the steps in a workable order. There is no embedding model made by rUv
for finding documents, so the model is a small standard one he recommends. None of this is measured on this
corpus yet. The tests are running or paused, with rules fixed before the results. Nothing measured supports a
figure above 62% of answers at 8 of 10 or better, and today's question sets are too small to tell 93% from 98%.

**What this folder guarantees from now on.** One page (`EMBEDDING-RECIPE.md`) says what ships, with a version
table of every past recipe and why each changed. A test (`tests/unit/embedding-recipe-record.test.mjs`) fails
if any recipe constant in the code (model, revision, size, pooling, weights, prefix, chunk size, overlap, chunker,
reranker, default results, file name) differs from the page, or changes without a new version row and a new
entry in `DECISIONS.md`. Once these files are committed, the test is in the release qualification list, so a release cannot change one of
those 14 constants without the page changing too. Other parts of the recipe (card thresholds, pool size,
pruning, routing) are described on the page but not guarded by the test. What it does not guarantee: that the line numbers and the prose stay current. Those are checked
by people. The rule is recorded in ADR-109, which is Proposed and waiting for your decision.
