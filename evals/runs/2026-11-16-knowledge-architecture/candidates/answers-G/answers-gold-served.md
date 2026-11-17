# Was the gold served? (candidate arms C and D; answers by question with gold items)

Gold item = gold file (repo + path, normalised as the rig scorers do) or gold history item (commit sha first 12 hex / issue or PR number). "Served" = it appears in the FILES or HISTORY section of a result the session received (any search) or of the FIRST search. Answers on questions with no gold item are left out of the denominators. Scores: capped score /10; "high" = capped >= 8. Results are tied to sessions by query text (the server is deterministic and each answer row lists its queries; the server log carries no session id).

- D: 753 distinct logged queries; 0 duplicate query strings with differing results.
- D: 0 answers had at least one query string not found in the log (counted on the matched queries only).
- Q: 753 distinct logged queries; 0 duplicate query strings with differing results.
- Q: 0 answers had at least one query string not found in the log (counted on the matched queries only).

## Overall

| arm | group | answers with gold | gold served in any search | gold in the FIRST search | served incl. concept-card sources |
| --- | --- | --- | --- | --- | --- |
| D | all | 195 | 47.2% (92/195) | 31.3% (61/195) | n/a (no cards) |
| Q | all | 195 | 45.6% (89/195) | 34.4% (67/195) | n/a (no cards) |

## By asker

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | amateur | 195 | 47.2% (92/195) | 31.3% (61/195) |
| Q | amateur | 195 | 45.6% (89/195) | 34.4% (67/195) |

## By stratum

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | build-task | 39 | 53.8% (21/39) | 33.3% (13/39) |
| D | troubleshooting | 12 | 41.7% (5/12) | 0.0% (0/12) |
| D | which-tool | 144 | 45.8% (66/144) | 33.3% (48/144) |
| Q | build-task | 39 | 61.5% (24/39) | 48.7% (19/39) |
| Q | troubleshooting | 12 | 41.7% (5/12) | 8.3% (1/12) |
| Q | which-tool | 144 | 41.7% (60/144) | 32.6% (47/144) |

## 2x2: gold served in any search x score at 8 or above (capped), with the mean capped score /100 in each cell

| arm | gold served | score >= 8 | answers | mean capped /100 | mean raw /100 |
| --- | --- | --- | --- | --- | --- |
| D | yes | yes | 71 | 85.8 | 85.8 |
| D | yes | no | 21 | 61.0 | 61.0 |
| D | no | yes | 34 | 85.0 | 85.0 |
| D | no | no | 69 | 45.4 | 45.4 |
| Q | yes | yes | 68 | 86.3 | 86.3 |
| Q | yes | no | 21 | 58.6 | 58.6 |
| Q | no | yes | 39 | 85.1 | 85.1 |
| Q | no | no | 67 | 45.7 | 45.7 |

## Same 2x2 with the FIRST search only

| arm | gold in first search | score >= 8 | answers | mean capped /100 |
| --- | --- | --- | --- | --- |
| D | yes | yes | 47 | 85.7 |
| D | yes | no | 14 | 57.9 |
| D | no | yes | 58 | 85.3 |
| D | no | no | 76 | 47.4 |
| Q | yes | yes | 53 | 86.0 |
| Q | yes | no | 14 | 56.4 |
| Q | no | yes | 54 | 85.7 |
| Q | no | no | 74 | 47.3 |

Answers on questions with no gold item (excluded): D 0, Q 0.
