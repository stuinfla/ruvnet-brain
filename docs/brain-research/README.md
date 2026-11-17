Updated: 2026-11-17 00:42:00 EST | Version 1.0.0
Created: 2026-11-17 00:42:00 EST

# Brain research: how the Brain stores and finds knowledge

The permanent record of the Brain's embedding and search recipe: what ships, how it got that way, every
decision and experiment, and what is proposed next. Requested by the owner on 2026-11-17 so that the recipe
never again has to be reconstructed from the history. The rule that keeps it current is ADR-109.

## What the Brain is for

The owner's statement of purpose: the Brain must not only find and answer, it must **guide and drive**. A
newcomer who states a goal should get the right workflow, the right combination of tools, the order of steps,
the pitfalls, and the way rUv himself builds, so that people who do not know this stack can build like its
author. Advanced engineers must still be served.

So the research measures three things, each with its own rules fixed in advance:
1. **Finding**: the right source reaches the model that writes the answer.
2. **Answering**: a blind judge grades the answer 8 of 10 or better.
3. **Guiding**: a new "build-guidance" question set H (pre-registration amendment A10, file hash
   `8bde58a6…`). Success for one answer = a score of 8 or above, at least two thirds of the right capabilities
   named, and the steps in a workable order. Set H has not been written or scored yet.

## Where we are today (2026-11-17, 12:35 a.m. Eastern)

The Brain 4.7.28 ships recipe R3, unchanged since 2026-07-28: 4,000-character pieces embedded with
bge-base-en-v1.5 (768 numbers, 8-bit weights, no header), with cards, a router and a reranker in front of the
search. Measured on blind questions, it returns the right file in the top five for 8 of 164. Keyword search over
rebuilt pieces plus a history store does far better (78 of 164 files; answers 73.1 of 100, or 75.7 with cards that
were not adopted, against 25.4 with no tool), but people who describe only their problem are still served poorly (on 120 amateur questions, set G,
keyword search finds the right file in the top 5 for 15). The v5 rewrite will replace this
recipe; its proposal (cue sentences, a problem-to-capability-to-file graph walked by rUv's own operator, keyword
and history lanes, a reranker that only reorders, typed abstention) is under test and nothing in it is decided.

## Reading order

1. `OWNER-NOTE.md`: one page, plain language: what ships, why, what is known, what is next.
2. `EMBEDDING-RECIPE.md`: the single current-truth page for the shipped recipe, with `file:line` for every
   value, its weaknesses, a version table and the proposal (clearly marked not in force).
3. `STORY.md`: dated chapters from rUv's own path to RuVector to today, with a one-screen flow line.
4. `DECISIONS.md`: append-only decision log.
5. `EXPERIMENTS.md`: append-only experiment log, with the rule fixed beforehand for each.

## Which file holds what

- **Shipped truth:** this directory, in particular `EMBEDDING-RECIPE.md` sections (a) to (e) and (g).
- **The proposal and its raw evidence:** the run folder `evals/runs/2026-11-16-knowledge-architecture/`
  (`REPLAN.md`, `PREREGISTRATION.md` and its `.sha256`, `DECISIONS.md`, `candidates/`, `ruvector-deepdive/`,
  `history/`, `SURVEY-2026.md`). Every number on these pages names the file it comes from there.

## What is checked automatically, and what is not

`tests/unit/embedding-recipe-record.test.mjs` (listed in `scripts/release-qualification-contract.mjs`, source
suite, as `embedding-recipe-record`) reads every recipe constant from the code at every place it is defined and
fails if the code sites disagree, if the block in `EMBEDDING-RECIPE.md` section (g) differs, or if a constant
changes without a new recipe version, version-table row and `DECISIONS.md` entry. It guards those constants
only. The `file:line` citations and the prose are checked by people when the recipe changes. For v5, its
builders replace the `RECIPE_SOURCES` list at the top of the test and the block; nothing else in the test
changes.

## Files

| File | One line |
|---|---|
| `README.md` | this index |
| `OWNER-NOTE.md` | the owner's one-page summary |
| `EMBEDDING-RECIPE.md` | current shipped recipe (4.7.28), tables, weaknesses, version table, proposal, checked constants |
| `STORY.md` | the story in dated chapters |
| `DECISIONS.md` | every decision, append-only |
| `EXPERIMENTS.md` | every experiment, append-only |
