Updated: 2026-11-17 00:49:11 EST | Version 1.0.0
Created: 2026-11-17 00:49:04 EST

# RuVector deep dive: what it is for, what it can do, and the design it points to

Written for the owner. Nothing in the product was edited, committed or scored. No E or F question was read.

## The answer in one page

**Which embedding model?** For the design recommended here, a small one: `BAAI/bge-small-en-v1.5` (384
numbers per vector, MIT licence, 34 to 133 MB), with `all-MiniLM-L6-v2` as the screened alternate. The final
pick is decided by a screen on the task it will actually do (rule R4b).

**Is it RuVector-native?** No, and nothing is. rUv has not trained an embedding model for finding documents;
every rUv surface wraps a stock model or falls back to a word-hash. `bge-small` is the model RuVector's own
core names "default, recommended for `.rvf` packs", and it is the base of rUv's one fine-tune. What is
RuVector-native is everything around the model: the store, the typed graph, the walk, the evolved settings,
the branch, the proof, and a training pipeline that can make the model the Brain's own (recipe 3).

**What is the hybrid design that could reach the amateurs?** rUv's own memory pattern, applied to this corpus.
He calls it reconstruction: "Follow Cue, Tag, and Content associations instead of retrieving one flat chunk".
- Short **cue** sentences written the way people ask (problems, goals, symptoms) carry the vectors.
- Cues link to **tags**: the capability, its family in a hierarchy, the package, the decision behind it.
- Tags link to **content**: the files, passages and history the lead's run already stores.
- A question lands on cues and walks the links. Files that several paths agree on rise. It stops early when
  the evidence is strong and says "nothing in rUv's work matches" when it is weak.
- The settings of the walk are tuned by rUv's evolutionary loop on training questions and judged on unseen
  ones. Confirmed answers lay shortcut links, on a branch that can be dropped. The keyword lane stays for
  people who already know the words.

**Why it might work where every lane so far has not.** An amateur's sentence never resembles a source file.
It can resemble another everyday sentence. After that first match the search follows links, which need no
shared words. The lead's own data already lean this way: on the development set, text written as newcomer
questions finds 22 of 35 novice answers where the keyword lane finds 12.

**What is not known.** No part of this design has been scored on this corpus. rUv's own numbers for it come
from a simulation with made-up data (I re-ran it: 14 of 14 tests pass; accuracy 50% to 70%, wrong-but-confident
answers 17% to 3%). My estimate for amateurs is 50 to 65% with the right source in the result, against about
30% today, and the range is wide. Whether layers on top take that toward 98% is exactly what the proposed
experiments measure; it is neither promised nor ruled out here.

## What to read, in order

| File | What it is |
|---|---|
| `ORIGIN-AND-PHILOSOPHY.md` | Where RuVector came from, what it is for in rUv's words, his principles and vocabulary, what he has corrected, and what a "vector database" reading misses |
| `CAPABILITY-MAP.md` | Every capability in one line, grouped by purpose, with maturity; twelve surprises; the question list written before asking the Brain |
| `04-DESIGN-THE-RUV-WAY.md` | The design: units, links, query path, learning, size, nightly update, three recipes with predicted gains, experiments |
| `SURVEY-2025-2026.md` | Dated survey: what rUv shipped by month, and what the wider field shipped, with sources |
| `WHAT-2024-THINKING-MISSES.md` | The eight ideas in the recipe that exist only because of 2026 capabilities |
| `AMENDMENT-A4-PROPOSED.md` | The pre-registered rules handed to the lead (sent 12:07 a.m. ET) |
| `01-CAPABILITY-CATALOG.md` | The evidence table behind the map: file and line, maturity, what was verified |
| `02-NATIVE-EMBEDDING-OPTIONS.md` | Embedders per rUv surface, what rUv measured, candidates, sizes and licences |
| `03-NOVEL-STRATEGIES.md` | First-pass strategies U1-U9 (graph hop, hyperbolic hierarchy, need index, link prediction, learning on a branch, re-ordering, typed abstention, one-per-system, stability). Still valid as experiments; the design above places them in rUv's frame |
| `05-WHAT-RIPS.md` | What the Brain hand-rolls that rUv ships or has fixed; what to keep; defects to report |
| `BRAIN-QUESTION-LOG.md` | Every question asked of `search_ruvnet`, what came back, the lead it opened |
| `raw/A` to `raw/G3` | Nine readers' notes with file and line |
| `probes/`, `analysis/` | The SONA probe, the MRAgent run, the recount of the lead's lanes by asker |

## How the work was done, and where it fell short of the brief

- Source: RuVector at the current upstream head `979c31ac` (the older full clone is 623 commits behind and was
  used only for history), plus the sibling clones. Nine Sonnet readers on disjoint sets; I re-checked what the
  conclusions rest on and marked the rest as readers' reports.
- The tree walk asked for 15 minutes of my own wall-clock. My own walk ran from 11:55 p.m. to about 12:04 a.m.
  ET (roughly 9 minutes of fast listing and header reading across all 201 crates, the ADR index, examples, npm
  packages, research folders and neighbours), alongside about 25 reader-minutes on the same trees. The map was
  written at 12:00 a.m. and extended after a second walk. It is shorter than asked in my own minutes.
- Ran: the SONA Node probe, the MRAgent tests and benchmark, both in scratch on made-up or bundled data. One
  probe re-run pushed the one-minute load to 61 briefly (11:42 p.m.); nothing heavy ran after that.
- The question loop against the Brain ran four rounds and 53 logged questions (4 mine, 49 by three readers
  with fresh contexts, because each answer is 10 to 90 KB). It did **not** reach a round with nothing new: the
  last four questions each still found something, the strongest being rUv's router measurement of 10 November
  2026 (nearest centroid 62.8% against 25.7%), which changed the design's landing step. Informed questions got
  the right source first for 21 of 42; naive ones for 1 of 7. Eleven retrieval defects are in the log.
- Not done: no Rust crate was compiled; no candidate was scored on D, E or F; about 440 gists outside the
  memory and vector topics were not read; issues, talks and posts were not mined.
