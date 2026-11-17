# Set G slice questions (A18): arms D, M, N, L; 65 questions x 3 runs; third use of G slice questions; interim build 1,617 of 9,029 units

Answers joined with a mechanical check and a blind judge grade: 1170 of 1170. Scores are capped 0-10, shown x10. The owner's measure is the share of QUESTIONS graded 8 or above in at least 2 of 3 runs (n = 65 questions, all amateur askers). Build: third use of G slice questions; interim build 1,617 of 9,029 units.

Arm M keeps arm D's result size: 5 files (the keyword lane's first 3 distinct files, then the first 2 distinct need-index files queried with the call's own query text, k = 10, not among those 3; next keyword files fill a shortfall), each with up to 8,000 characters centred on its best keyword-scoring passage for the query (a need file with no matching passage: from its first passage), a need file carrying one extra line `matched need: <sentence>`; HISTORY as D. N (10 files, need files cut to 2,000-5,000 characters) and L (10 keyword files) are shown for reference from A17.

Complete runs per arm: D: 3 (1,2,3); M: 3 (1,2,3); N: 3 (1,2,3); L: 3 (1,2,3).

## Per arm

| arm | answers | mean capped /100 | mean raw /100 | share of answers >=8 | questions >=8 in at least 2 of 3 runs (owner's measure) | false_claim | must_not_claim | grounded | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D 5 keyword files + history (A14.2 answers reused) | 195 | 68.7 | 68.7 | 53.8% (105/195) | 55.4% (36/65) | 22 | 4 | 100.0% (195/195) | 0 |
| M 3 keyword + 2 need-index files (8,000-char excerpts) + history | 195 | 73.2 | 73.2 | 62.6% (122/195) | 60.0% (39/65) | 17 | 5 | 100.0% (195/195) | 0 |
| N 5 keyword + 5 need-index files + history | 195 | 51.1 | 51.3 | 24.6% (48/195) | 23.1% (15/65) | 36 | 7 | 96.9% (189/195) | 0 |
| L 10 keyword files + history (equal-slot control) | 195 | 51.9 | 52.1 | 26.2% (51/195) | 21.5% (14/65) | 29 | 5 | 96.4% (188/195) | 0 |

Arm A has no tools, so every A answer is ungrounded by construction and the R8 cap (3) applies to it.

## By stratum: owner's measure and mean capped /100

| stratum | n | D >=2 of 3 at 8+ | D mean | M >=2 of 3 at 8+ | M mean | N >=2 of 3 at 8+ | N mean | L >=2 of 3 at 8+ | L mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| build-task | 13 | 53.8% (7/13) | 74.6 | 84.6% (11/13) | 81.8 | 23.1% (3/13) | 57.9 | 15.4% (2/13) | 59.7 |
| which-tool | 48 | 58.3% (28/48) | 67.8 | 54.2% (26/48) | 71.6 | 25.0% (12/48) | 50.0 | 25.0% (12/48) | 51.2 |
| troubleshooting | 4 | 25.0% (1/4) | 59.2 | 50.0% (2/4) | 65.0 | 0.0% (0/4) | 41.7 | 0.0% (0/4) | 35.8 |

## Run-to-run spread

| arm | run means capped /100 | run share of answers >=8 |
| --- | --- | --- |
| D | 69.2, 67.5, 69.2 | 53.8, 52.3, 55.4 |
| M | 72.5, 74.3, 72.9 | 60.0, 66.2, 61.5 |
| N | 52.8, 51.8, 48.6 | 27.7, 26.2, 20.0 |
| L | 54.6, 54.2, 47.1 | 32.3, 30.8, 15.4 |

## Paired differences on per-question values (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261117)

| measure | M - D | N - D | L - D | M - L | N - L |
| --- | --- | --- | --- | --- | --- |
| owner's measure (question graded >=8 in >=2 of 3 runs) | +4.6 [-6.2, 16.9] | -32.3 [-44.6, -20.0] | -33.8 [-47.7, -21.5] | +38.5 [26.2, 50.8] | +1.5 [-7.7, 10.8] |
| mean capped score | +4.6 [1.2, 8.5] | -17.6 [-22.5, -12.7] | -16.7 [-22.2, -11.5] | +21.3 [15.7, 26.8] | -0.9 [-4.6, 3.0] |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) |
| --- | --- | --- | --- | --- |
| D | 2.4 | 0 | 0 | 1578 |
| M | 2.3 | 0 | 0 | 9466 |
| N | 5.2 | 0 | 37 | 2117 |
| L | 5.2 | 0 | 43 | 5008 |

## Searches, payload and gold served (gold-served.jsonl rebuilt for these arms)

| arm | mean searches per answer | payload characters per search call (median) | gold served in any search | gold in the FIRST search | share at 8+ when gold served | share at 8+ when gold not served |
| --- | --- | --- | --- | --- | --- | --- |
| D | 2.4 | 43639 | 47.2% (92/195) | 31.3% (61/195) | 77.2% (71/92) | 33.0% (34/103) |
| M | 2.3 | 40952 | 69.2% (135/195) | 55.4% (108/195) | 80.7% (109/135) | 21.7% (13/60) |
| N | 5.2 | 58950 | 86.2% (168/195) | 68.7% (134/195) | 28.0% (47/168) | 3.7% (1/27) |
| L | 5.2 | 59635 | 73.8% (144/195) | 43.6% (85/195) | 34.0% (49/144) | 3.9% (2/51) |

# A18 rule line (third use of G slice questions; interim build 1,617 of 9,029 units)

Rule fixed before the result (A18): serving two need-index files inside a 5-file result is admitted if the share of questions graded 8 or above in at least 2 of 3 runs is at least 10 points higher for M than for D, the 95% bootstrap interval excludes zero, and false claims are not higher. The owner's gate (93%) is read from the same table.

| measure | value |
| --- | --- |
| M - D on the owner's measure (points) | +4.6 [-6.2, 16.9] |
| >= +10 | false |
| interval excludes zero | false |
| false claims M vs D | 17 vs 22 (not higher) |
| **A18 rule** | **not met** |

Owner's measure by arm: D 55.4% (36/65); M 60.0% (39/65); N 23.1% (15/65); L 21.5% (14/65) (gate 93%).

Not tested: third use of the G slice questions, so a pass needs confirmation on new questions; interim build, to be repeated on the final build (A14.3).
## Host delivery check

Source: raw stream-json traces of the answering sessions (one file per answer). Each tool result is classified from the text the model received: full text; a size error ("exceeds maximum allowed tokens"); or replaced by a "persisted-output / Output too large ... saved to file" notice. The answering sessions have no file-reading tool, so an error or notice means the model got no result text (a notice carries a short preview only).

| arm | answers | tool results | full | size error | replaced by file notice | share not delivered in full | answers with >= 1 undelivered result | median result size (chars, as reported or measured) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D | 195 | 463 | 463 | 0 | 0 | 0.0% | 0 (0.0%) | 44,909 |
| N | 195 | 1012 | 33 | 191 | 788 | 96.7% | 195 (100.0%) | 59,800 |
| L | 195 | 1008 | 48 | 298 | 662 | 95.2% | 194 (99.5%) | 59,684 |
| M | 195 | 444 | 444 | 0 | 0 | 0.0% | 0 (0.0%) | 41,970 |

Exact error message (first seen): `Error: result (59,674 characters across 1,936 lines) exceeds maximum allowed tokens. Output has been saved to /Users/stuartkerr/.claude/projects/-private-var-fo`

Exact file notice (first seen): `<persisted-output> Output too large (58.5KB). Full output saved to: /Users/stuartkerr/.claude/projects/-private-var-folders-dq-s8kgbs151dz1sjb90t6wyqlw0000gn-T-ka-ans-cwd-RWNcph/08c9bbc5-f719-4025-b25`

Quality restricted to answers where every tool result was delivered in full (clean), against answers with at least one undelivered result:

| arm | clean answers | mean capped (clean) | share at 8+ (clean) | affected answers | mean capped (affected) | share at 8+ (affected) | owner's measure, questions with all 3 runs clean (n) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D | 195 | 6.87 | 53.8% | 0 | n/a | n/a | 55.4% (36/65) |
| N | 0 | n/a | n/a | 195 | 5.11 | 24.6% | n/a (0) |
| L | 1 | 9.00 | 100.0% | 194 | 5.18 | 25.8% | n/a (0) |
| M | 195 | 7.32 | 62.6% | 0 | n/a | n/a | 60.0% (39/65) |

Not tested: whether a larger host limit would raise the score (the same sessions were not re-run with a higher limit); the persisted file was not readable by the model (no file tool), as in every arm.
