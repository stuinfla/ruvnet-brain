Updated: 2026-11-16 23:58:00 EST | Version 0.1.0
Created: 2026-11-16 23:55:00 EST

# Shipped brain vs the candidate recipe, side by side

DRAFT: set F (shipped run in progress) and the worked examples are pending.

## What is compared

- **Shipped**: RuvNet Brain 4.7.28, asked through its real server (tool `search_ruvnet`). It returns 0 to 6
  files. "Found" means a gold file (or gold history item) is anywhere in what it returned.
- **Candidate**: rebuilt passages with one lexical (word-matching) lane, `v2-bm25`, over 24 stores, served as
  FILES (first 5 distinct files) plus HISTORY (first 3 distinct items of lane `history-bm25`: commits, issues,
  pull requests, comments). "Found" means a gold item is in those 5 + 3. Concept cards are not part of it.

Every number is a count of questions read from the file named next to it (paths relative to this folder).
Scripts and outputs written for this document are in `candidates/sbs/`.

## 1. Retrieval: is the gold in what the user gets?

### Dev set (exam2 dev, 113 questions; not blind)

Sources: shipped `baseline-v1/v1-dev.jsonl`; candidate `candidates/sbs/dev-v2-bm25.jsonl` and
`dev-history-bm25.jsonl` (MISSING RUN 1, done here with rigE's scripts copied unchanged); all three scored with
rigE's scorer into `candidates/sbs/dev-per-question.jsonl`; table from `candidates/sbs/sbs_analysis.py`.
Dev has no asker field; it has `kind` (4 values) and `persona` (2 values), both shown.

DEV-TABLE

Notes. Dev gold is files only, so the history section cannot score here. The shipped dev run went through the
inner reader (`kb/forge-mcp-all.mjs`); E and F went through the outer plugin server. Its recorded answer text
stops at 400 characters, so "insufficient evidence" on dev is a lower bound. Rig A's earlier 40 of 76 on the
pilot subset used a 10-store index; this run uses the 24-store index, which gives 38 of 76.

### Set E (164 blind questions)

Sources: `candidates/rigE/per-question.jsonl` (lane `shipped` from `rigE/shipped-raw.jsonl`; lanes `v2-bm25`
and `history-bm25`). Strata (kinds of question), then askers.

E-TABLE

Notes. Shipped finds 9 here, not the 8 in DECISIONS D7, because D7 counted the top 5 and this counts all it
returned: E3-13 had the gold at rank 6. Four not-in-corpus questions (E4-27 to E4-30) have no gold item, so they
can only fall in "neither".

### Set F (80 blind questions, gold found without keyword search)

F-TABLE

### Paired counts (same question, both systems)

PAIRED-TABLE

Every question only the shipped server found, the candidate also had in its list, just below the cut: dev X1-38
(candidate file rank 9), X2-47 (9), X2-16 (20), X5-26 (8); E2-34 (6). Ranks from `files_rank` in
`candidates/sbs/sbs-per-question.jsonl`. SHIPPED-ONLY-F

## 2. Answer level

Source: `candidates/answers/per-answer.jsonl` (snapshot read at 11:50 p.m.), recomputed by
`candidates/sbs/sbs_answers.py`; the overall rows match `candidates/answers/answers.table.md`. Score out of 100,
after the mechanical citation and false-claim caps; the unit is the mean of a question's runs. Arm D is the
candidate (files + history). Arm C adds concept cards and is shown only for reference.

ANSWER-TABLE

Caveat: the shipped arm (B) rests on 49 questions and one run; the rule set in advance (R8) needs three complete
runs, so B supports no claim. Cells with n under 10 are a handful of questions. The right-hand three columns
compare the other arms on exactly B's 49 questions, run 1.

Set F at answer level (`candidates/answers-F/`): ANSWERS-F

## 3. Worked examples

PENDING

## 4. What these examples show

PENDING
