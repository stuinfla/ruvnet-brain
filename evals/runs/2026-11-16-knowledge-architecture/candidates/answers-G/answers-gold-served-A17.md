# Was the gold served? (candidate arms C and D; answers by question with gold items)

Gold item = gold file (repo + path, normalised as the rig scorers do) or gold history item (commit sha first 12 hex / issue or PR number). "Served" = it appears in the FILES or HISTORY section of a result the session received (any search) or of the FIRST search. Answers on questions with no gold item are left out of the denominators. Scores: capped score /10; "high" = capped >= 8. Results are tied to sessions by query text (the server is deterministic and each answer row lists its queries; the server log carries no session id).

- D: 753 distinct logged queries; 0 duplicate query strings with differing results.
- D: 0 answers had at least one query string not found in the log (counted on the matched queries only).
- N: 945 distinct logged queries; 0 duplicate query strings with differing results.
- N: 1 answers had at least one query string not found in the log (counted on the matched queries only).

## Overall

| arm | group | answers with gold | gold served in any search | gold in the FIRST search | served incl. concept-card sources |
| --- | --- | --- | --- | --- | --- |
| D | all | 195 | 47.2% (92/195) | 31.3% (61/195) | n/a (no cards) |
| N | all | 195 | 86.2% (168/195) | 68.7% (134/195) | n/a (no cards) |

## By asker

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | amateur | 195 | 47.2% (92/195) | 31.3% (61/195) |
| N | amateur | 195 | 86.2% (168/195) | 68.7% (134/195) |

## By stratum

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | build-task | 39 | 53.8% (21/39) | 33.3% (13/39) |
| D | troubleshooting | 12 | 41.7% (5/12) | 0.0% (0/12) |
| D | which-tool | 144 | 45.8% (66/144) | 33.3% (48/144) |
| N | build-task | 39 | 100.0% (39/39) | 84.6% (33/39) |
| N | troubleshooting | 12 | 50.0% (6/12) | 16.7% (2/12) |
| N | which-tool | 144 | 85.4% (123/144) | 68.8% (99/144) |

## 2x2: gold served in any search x score at 8 or above (capped), with the mean capped score /100 in each cell

| arm | gold served | score >= 8 | answers | mean capped /100 | mean raw /100 |
| --- | --- | --- | --- | --- | --- |
| D | yes | yes | 71 | 85.8 | 85.8 |
| D | yes | no | 21 | 61.0 | 61.0 |
| D | no | yes | 34 | 85.0 | 85.0 |
| D | no | no | 69 | 45.4 | 45.4 |
| N | yes | yes | 47 | 86.2 | 86.2 |
| N | yes | no | 121 | 40.8 | 41.1 |
| N | no | yes | 1 | 80.0 | 80.0 |
| N | no | no | 26 | 34.2 | 35.0 |

## Same 2x2 with the FIRST search only

| arm | gold in first search | score >= 8 | answers | mean capped /100 |
| --- | --- | --- | --- | --- |
| D | yes | yes | 47 | 85.7 |
| D | yes | no | 14 | 57.9 |
| D | no | yes | 58 | 85.3 |
| D | no | no | 76 | 47.4 |
| N | yes | yes | 42 | 86.7 |
| N | yes | no | 92 | 41.0 |
| N | no | yes | 6 | 81.7 |
| N | no | no | 55 | 37.5 |

Answers on questions with no gold item (excluded): D 0, N 0.
