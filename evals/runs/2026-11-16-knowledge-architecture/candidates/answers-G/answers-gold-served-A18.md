# Was the gold served? (candidate arms C and D; answers by question with gold items)

Gold item = gold file (repo + path, normalised as the rig scorers do) or gold history item (commit sha first 12 hex / issue or PR number). "Served" = it appears in the FILES or HISTORY section of a result the session received (any search) or of the FIRST search. Answers on questions with no gold item are left out of the denominators. Scores: capped score /10; "high" = capped >= 8. Results are tied to sessions by query text (the server is deterministic and each answer row lists its queries; the server log carries no session id).

- D: 753 distinct logged queries; 0 duplicate query strings with differing results.
- D: 0 answers had at least one query string not found in the log (counted on the matched queries only).
- M: 384 distinct logged queries; 0 duplicate query strings with differing results.
- M: 0 answers had at least one query string not found in the log (counted on the matched queries only).
- N: 945 distinct logged queries; 0 duplicate query strings with differing results.
- N: 1 answers had at least one query string not found in the log (counted on the matched queries only).
- L: 932 distinct logged queries; 0 duplicate query strings with differing results.
- L: 6 answers had at least one query string not found in the log (counted on the matched queries only).

## Overall

| arm | group | answers with gold | gold served in any search | gold in the FIRST search | served incl. concept-card sources |
| --- | --- | --- | --- | --- | --- |
| D | all | 195 | 47.2% (92/195) | 31.3% (61/195) | n/a (no cards) |
| M | all | 195 | 69.2% (135/195) | 55.4% (108/195) | n/a (no cards) |
| N | all | 195 | 86.2% (168/195) | 68.7% (134/195) | n/a (no cards) |
| L | all | 195 | 73.8% (144/195) | 43.6% (85/195) | n/a (no cards) |

## By asker

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | amateur | 195 | 47.2% (92/195) | 31.3% (61/195) |
| M | amateur | 195 | 69.2% (135/195) | 55.4% (108/195) |
| N | amateur | 195 | 86.2% (168/195) | 68.7% (134/195) |
| L | amateur | 195 | 73.8% (144/195) | 43.6% (85/195) |

## By stratum

| arm | group | answers with gold | gold served in any search | gold in the FIRST search |
| --- | --- | --- | --- | --- |
| D | build-task | 39 | 53.8% (21/39) | 33.3% (13/39) |
| D | troubleshooting | 12 | 41.7% (5/12) | 0.0% (0/12) |
| D | which-tool | 144 | 45.8% (66/144) | 33.3% (48/144) |
| M | build-task | 39 | 92.3% (36/39) | 66.7% (26/39) |
| M | troubleshooting | 12 | 33.3% (4/12) | 0.0% (0/12) |
| M | which-tool | 144 | 66.0% (95/144) | 56.9% (82/144) |
| N | build-task | 39 | 100.0% (39/39) | 84.6% (33/39) |
| N | troubleshooting | 12 | 50.0% (6/12) | 16.7% (2/12) |
| N | which-tool | 144 | 85.4% (123/144) | 68.8% (99/144) |
| L | build-task | 39 | 89.7% (35/39) | 53.8% (21/39) |
| L | troubleshooting | 12 | 58.3% (7/12) | 8.3% (1/12) |
| L | which-tool | 144 | 70.8% (102/144) | 43.8% (63/144) |

## 2x2: gold served in any search x score at 8 or above (capped), with the mean capped score /100 in each cell

| arm | gold served | score >= 8 | answers | mean capped /100 | mean raw /100 |
| --- | --- | --- | --- | --- | --- |
| D | yes | yes | 71 | 85.8 | 85.8 |
| D | yes | no | 21 | 61.0 | 61.0 |
| D | no | yes | 34 | 85.0 | 85.0 |
| D | no | no | 69 | 45.4 | 45.4 |
| M | yes | yes | 109 | 86.6 | 86.6 |
| M | yes | no | 26 | 63.8 | 63.8 |
| M | no | yes | 13 | 86.2 | 86.2 |
| M | no | no | 47 | 43.8 | 43.8 |
| N | yes | yes | 47 | 86.2 | 86.2 |
| N | yes | no | 121 | 40.8 | 41.1 |
| N | no | yes | 1 | 80.0 | 80.0 |
| N | no | no | 26 | 34.2 | 35.0 |
| L | yes | yes | 49 | 86.7 | 86.7 |
| L | yes | no | 95 | 44.7 | 44.7 |
| L | no | yes | 2 | 80.0 | 80.0 |
| L | no | no | 49 | 30.0 | 30.4 |

## Same 2x2 with the FIRST search only

| arm | gold in first search | score >= 8 | answers | mean capped /100 |
| --- | --- | --- | --- | --- |
| D | yes | yes | 47 | 85.7 |
| D | yes | no | 14 | 57.9 |
| D | no | yes | 58 | 85.3 |
| D | no | no | 76 | 47.4 |
| M | yes | yes | 90 | 86.4 |
| M | yes | no | 18 | 63.3 |
| M | no | yes | 32 | 86.9 |
| M | no | no | 55 | 46.9 |
| N | yes | yes | 42 | 86.7 |
| N | yes | no | 92 | 41.0 |
| N | no | yes | 6 | 81.7 |
| N | no | no | 55 | 37.5 |
| L | yes | yes | 35 | 87.7 |
| L | yes | no | 50 | 47.6 |
| L | no | yes | 16 | 83.8 |
| L | no | no | 94 | 35.5 |

Answers on questions with no gold item (excluded): D 0, M 0, N 0, L 0.
