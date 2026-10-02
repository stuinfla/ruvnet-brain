# Routing 4.4.1: curly apostrophes (2026-10-01)

**The change.** Phones and word processors often type U+2019 for the apostrophe in "rUv's"; U+2018 and U+02BC also turn up. `normalizeApostrophes` (`kb/card-lane.mjs`) now folds all three to a straight apostrophe before the router reads a possessive or a contraction. That covers:
- the rUv provenance rule (`ruvAuthorshipIntent`)
- card phrase normalisation ("agent's scaffolding", "each other's context", "what's uncovered")
- the source-card negation guard ("can't", "doesn't")
- version intent ("what's new")

**Tests.** Every rUv routing case in `tests/unit/forge-ask-all.test.mjs` now runs with a straight apostrophe and with each curly form. That covers 11 product negatives, including the 6 from the 4.4 review, and 8 provenance positives. `tests/unit/apostrophe-normalization.test.mjs` pins the normaliser itself and each reader. Removing the normalisation from any reader turns its tests red.

**Route only, no model.** Corpus: 4.3.37 data. Command: `node scripts/route-gold-rank.mjs --kb <kb> [--impl <release kb/forge-ask-all.mjs>] --needs <need-set-v1.json> --recall-fixture data/retrieval-query-evidence.json --heldout evals/held-out.json`.
- **Baseline** is `origin/release/4.4.0` (1363b416), in `route-release-4.4.0-kb4337.json`. **Fix** is 9255be4e, in `route-9255be4e-kb4337.json`.
- **0 route changes on 488 questions:** 206 needs, 182 name-stripped, 80 held-out and 20 off-topic.
- The figures are identical in both runs:

| Set | Gold in top 3 | Gold in top 5 | Other |
|---|---|---|---|
| 206 needs | 83/206 [33.8–47.1] | 87/206 | |
| 182 name-stripped | 85/182 [39.6–53.9] | 88/182 | |
| 80 held-out | 80/80 | | |
| 20 off-topic | | | 15/20 declined |

- **The ms/question figures differ between the two runs** (about 200 versus 300–770 ms). The two runs were sequential, under different machine load. This was not a paired latency measurement; the change itself is one regex replace per read.
