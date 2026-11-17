# Was the gold served? (candidate arms C and D; answers by question with gold items)

Gold item = gold file (repo + path, normalised as the rig scorers do) or gold history item (commit sha first 12 hex / issue or PR number). "Served" = it appears in the FILES or HISTORY section of a result the session received (any search) or of the FIRST search. Answers on questions with no gold item are left out of the denominators. Scores: capped score /10; "high" = capped >= 8. Results are tied to sessions by query text (the server is deterministic and each answer row lists its queries; the server log carries no session id).

- D: 476 distinct logged queries; 0 duplicate query strings with differing results.
- D: 0 answers had at least one query string not found in the log (counted on the matched queries only).

## Overall

| arm | group | answers with gold | gold served in any search | gold in the FIRST search | served incl. concept-card sources |
| --- | --- | --- | --- | --- | --- |
| D | all | 240 | 81.3% (195/240) | 62.1% (149/240) | n/a (no cards) |

## By asker

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | amateur | 96 | 75.0% (72/96) | 58.3% (56/96) |
| D | expert | 51 | 98.0% (50/51) | 78.4% (40/51) |
| D | practitioner | 93 | 78.5% (73/93) | 57.0% (53/93) |

## By stratum

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | build-task | 24 | 83.3% (20/24) | 50.0% (12/24) |
| D | cross-repo | 36 | 77.8% (28/36) | 41.7% (15/36) |
| D | design-rationale | 36 | 100.0% (36/36) | 91.7% (33/36) |
| D | history | 36 | 80.6% (29/36) | 55.6% (20/36) |
| D | troubleshooting | 36 | 88.9% (32/36) | 61.1% (22/36) |
| D | which-tool | 72 | 69.4% (50/72) | 65.3% (47/72) |

## 2x2: gold served in any search x score at 8 or above (capped), with the mean capped score /100 in each cell

| arm | gold served | score >= 8 | answers | mean capped /100 | mean raw /100 |
| --- | --- | --- | --- | --- | --- |
| D | yes | yes | 162 | 89.1 | 89.1 |
| D | yes | no | 33 | 55.5 | 55.5 |
| D | no | yes | 12 | 82.5 | 82.5 |
| D | no | no | 33 | 43.0 | 43.0 |

## Same 2x2 with the FIRST search only

| arm | gold in first search | score >= 8 | answers | mean capped /100 |
| --- | --- | --- | --- | --- |
| D | yes | yes | 127 | 89.6 |
| D | yes | no | 22 | 55.0 |
| D | no | yes | 47 | 86.2 |
| D | no | no | 44 | 46.4 |

Answers on questions with no gold item (excluded): D 0.
