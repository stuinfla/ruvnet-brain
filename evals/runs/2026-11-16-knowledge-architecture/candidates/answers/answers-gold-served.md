# Was the gold served? (candidate arms C and D; answers by question with gold items)

Gold item = gold file (repo + path, normalised as the rig scorers do) or gold history item (commit sha first 12 hex / issue or PR number). "Served" = it appears in the FILES or HISTORY section of a result the session received (any search) or of the FIRST search. Answers on questions with no gold item are left out of the denominators. Scores: capped score /10; "high" = capped >= 8. Results are tied to sessions by query text (the server is deterministic and each answer row lists its queries; the server log carries no session id).

- C: 413 distinct logged queries; 0 duplicate query strings with differing results.
- C: 0 answers had at least one query string not found in the log (counted on the matched queries only).
- D: 469 distinct logged queries; 0 duplicate query strings with differing results.
- D: 0 answers had at least one query string not found in the log (counted on the matched queries only).

## Overall

| arm | group | answers with gold | gold served in any search | gold in the FIRST search | served incl. concept-card sources |
| --- | --- | --- | --- | --- | --- |
| C | all | 240 | 72.5% (174/240) | 57.1% (137/240) | 87.9% (211/240) |
| D | all | 240 | 72.5% (174/240) | 56.3% (135/240) | n/a (no cards) |

## By asker

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| C | amateur | 87 | 54.0% (47/87) | 46.0% (40/87) |
| C | expert | 48 | 91.7% (44/48) | 64.6% (31/48) |
| C | practitioner | 105 | 79.0% (83/105) | 62.9% (66/105) |
| D | amateur | 87 | 58.6% (51/87) | 51.7% (45/87) |
| D | expert | 48 | 89.6% (43/48) | 66.7% (32/48) |
| D | practitioner | 105 | 76.2% (80/105) | 55.2% (58/105) |

## By stratum

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| C | build-task | 36 | 66.7% (24/36) | 50.0% (18/36) |
| C | cross-repo | 36 | 77.8% (28/36) | 58.3% (21/36) |
| C | design-rationale | 36 | 91.7% (33/36) | 75.0% (27/36) |
| C | history | 36 | 83.3% (30/36) | 66.7% (24/36) |
| C | not-in-corpus | 24 | 62.5% (15/24) | 62.5% (15/24) |
| C | troubleshooting | 36 | 75.0% (27/36) | 63.9% (23/36) |
| C | which-tool | 36 | 47.2% (17/36) | 25.0% (9/36) |
| D | build-task | 36 | 61.1% (22/36) | 41.7% (15/36) |
| D | cross-repo | 36 | 86.1% (31/36) | 61.1% (22/36) |
| D | design-rationale | 36 | 88.9% (32/36) | 77.8% (28/36) |
| D | history | 36 | 91.7% (33/36) | 58.3% (21/36) |
| D | not-in-corpus | 24 | 62.5% (15/24) | 58.3% (14/24) |
| D | troubleshooting | 36 | 75.0% (27/36) | 63.9% (23/36) |
| D | which-tool | 36 | 38.9% (14/36) | 33.3% (12/36) |

## 2x2: gold served in any search x score at 8 or above (capped), with the mean capped score /100 in each cell

| arm | gold served | score >= 8 | answers | mean capped /100 | mean raw /100 |
| --- | --- | --- | --- | --- | --- |
| C | yes | yes | 125 | 89.0 | 89.0 |
| C | yes | no | 49 | 53.3 | 53.3 |
| C | no | yes | 22 | 83.2 | 83.2 |
| C | no | no | 44 | 57.5 | 57.5 |
| D | yes | yes | 125 | 89.7 | 89.7 |
| D | yes | no | 49 | 53.3 | 53.3 |
| D | no | yes | 15 | 82.7 | 82.7 |
| D | no | no | 51 | 48.2 | 48.2 |

## Same 2x2 with the FIRST search only

| arm | gold in first search | score >= 8 | answers | mean capped /100 |
| --- | --- | --- | --- | --- |
| C | yes | yes | 98 | 89.3 |
| C | yes | no | 39 | 53.8 |
| C | no | yes | 49 | 85.7 |
| C | no | no | 54 | 56.3 |
| D | yes | yes | 99 | 89.6 |
| D | yes | no | 36 | 52.5 |
| D | no | yes | 41 | 87.3 |
| D | no | no | 64 | 49.7 |

Answers on questions with no gold item (excluded): C 12, D 12.
