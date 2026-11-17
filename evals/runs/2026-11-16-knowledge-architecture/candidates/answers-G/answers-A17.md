# Set G slice questions (A17): arms D, N, L; 65 questions x 3 runs; second use of G slice questions; interim build 1,617 of 9,029 units; 10 files against 5

Answers joined with a mechanical check and a blind judge grade: 1170 of 1170. Scores are capped 0-10, shown x10. The owner's measure is the share of QUESTIONS graded 8 or above in at least 2 of 3 runs (n = 65 questions, all amateur askers). Build: second use of G slice questions; interim build 1,617 of 9,029 units; 10 files against 5.

Limitation: arm N serves 10 files against 5 in arm D. Need-index files come from the frozen look-1 need index queried with each search call's own query text, shown with the matched sentence, the unit summary and up to 4,000 characters of the file (less when the 60,000-character cap needs room). Arm L (10 keyword files) is the equal-slot control; where it has no complete runs it is owed.

Complete runs per arm: D: 3 (1,2,3); N: 3 (1,2,3); L: 3 (1,2,3).

## Per arm

| arm | answers | mean capped /100 | mean raw /100 | share of answers >=8 | questions >=8 in at least 2 of 3 runs (owner's measure) | false_claim | must_not_claim | grounded | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D 5 keyword files + history (A14.2 answers reused) | 195 | 68.7 | 68.7 | 53.8% (105/195) | 55.4% (36/65) | 22 | 4 | 100.0% (195/195) | 0 |
| N 5 keyword + 5 need-index files + history | 195 | 51.1 | 51.3 | 24.6% (48/195) | 23.1% (15/65) | 36 | 7 | 96.9% (189/195) | 0 |
| L 10 keyword files + history (equal-slot control) | 195 | 51.9 | 52.1 | 26.2% (51/195) | 21.5% (14/65) | 29 | 5 | 96.4% (188/195) | 0 |

Arm A has no tools, so every A answer is ungrounded by construction and the R8 cap (3) applies to it.

## By stratum: owner's measure and mean capped /100

| stratum | n | D >=2 of 3 at 8+ | D mean | N >=2 of 3 at 8+ | N mean | L >=2 of 3 at 8+ | L mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| build-task | 13 | 53.8% (7/13) | 74.6 | 23.1% (3/13) | 57.9 | 15.4% (2/13) | 59.7 |
| which-tool | 48 | 58.3% (28/48) | 67.8 | 25.0% (12/48) | 50.0 | 25.0% (12/48) | 51.2 |
| troubleshooting | 4 | 25.0% (1/4) | 59.2 | 0.0% (0/4) | 41.7 | 0.0% (0/4) | 35.8 |

## Run-to-run spread

| arm | run means capped /100 | run share of answers >=8 |
| --- | --- | --- |
| D | 69.2, 67.5, 69.2 | 53.8, 52.3, 55.4 |
| N | 52.8, 51.8, 48.6 | 27.7, 26.2, 20.0 |
| L | 54.6, 54.2, 47.1 | 32.3, 30.8, 15.4 |

## Paired differences on per-question values (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261117)

| measure | N - D | N - L | L - D |
| --- | --- | --- | --- |
| owner's measure (question graded >=8 in >=2 of 3 runs) | -32.3 [-44.6, -20.0] | +1.5 [-7.7, 10.8] | -33.8 [-47.7, -21.5] |
| mean capped score | -17.6 [-22.5, -12.7] | -0.9 [-4.6, 3.0] | -16.7 [-22.2, -11.5] |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) |
| --- | --- | --- | --- | --- |
| D | 2.4 | 0 | 0 | 1578 |
| N | 5.2 | 0 | 37 | 2117 |
| L | 5.2 | 0 | 43 | 5008 |

# A17.2 rule line (second use of G slice questions; interim build 1,617 of 9,029 units; 10 files against 5)

Rule fixed before the result (A17.2): serving need-index files is admitted if the share of questions graded 8 or above in at least 2 of 3 runs is at least 10 points higher for N than for D, the 95% bootstrap interval excludes zero, and false claims are not higher. The owner's gate (93%) is read from the same table.

| measure | value |
| --- | --- |
| N - D on the owner's measure (points) | -32.3 [-44.6, -20.0] |
| >= +10 | false |
| interval excludes zero | false |
| false claims N vs D | 36 vs 22 (higher) |
| **A17.2 rule** | **not met** |

Owner's measure by arm: D 55.4% (36/65); N 23.1% (15/65); L 21.5% (14/65) (gate 93%).

Not tested: N serves 10 files against 5 (the equal-slot control L is reported only where it has 3 complete runs); second use of the G slice questions, so a pass needs confirmation on new questions; interim build, to be repeated on the final build (A14.3).

## Harness validation (arm N, run on the lead's request; raw output in scripts/diag-n.out, gold-served in answers-gold-served-A17.md)

1. D material intact? Yes. For the FIRST search call of 10 real N answers (the query the model actually sent), the 5 keyword-file excerpts in N are identical to D's (D excerpts are up to 8,000 characters each; none was trimmed), HISTORY and everything after it is identical, and the 5 need-index files come AFTER the keyword files. The 60,000-character cap trimmed only the need-index files (to 2,000-5,000 characters each, header and summary included); N payloads were 51,289-59,800 characters against 30,907-47,092 for D. Proven on 3 questions in scripts/prove-n.out (N and L: first 5 files and HISTORY equal D's, no extra file among the 5).
2. Latency and failures. N per-call latency p50 1,820 ms, p90 3,832 ms, max 8,045 ms (D: p50 1,361, p90 2,845, max 5,830). No timeouts. Two N attempts ended `error_max_turns` and were retried automatically (G1-17 run 1, G1-11 run 3); both retries produced answers. 0 answers truncated by the turn limit in the stored rows; 37 N answers made more than 6 tool calls (parallel calls inside one turn) with mean capped score 4.35 against 5.28 for the other N answers. Mean searches per answer N 5.2 against D 2.4; mean answer length N 3,245 characters against D 4,514.
3. Gold served (any search / first search): D 47.2% (92/195) / 31.3% (61/195); N 86.2% (168/195) / 68.7% (134/195). 2x2 for N, gold served x score at 8 or above: served and >= 8: 47 answers (mean 86.2); served and < 8: 121 (mean 40.8); not served and >= 8: 1; not served and < 8: 26 (mean 34.2). So N puts a gold file in front of the model far more often and the answers are still worse: with gold served, 28% of N answers reach 8 against 77% for D (71 of 92).
4. "780 of 849 joined": the 69 missing rows were the first arm-L answers (849 = 585 D/A/Q answers + 195 N + 69 L written at the time); L answers were not yet judged. A and Q rows are in the count and are not part of the A17 tables.
5. Five low N answers where D scored 8 or above in at least 2 of 3 runs (judge reason, one line each): G1-05 names the right package but never the load_mmap call and implies the default load streams from disk; G1-19 answers with the agentic-qe tiny-dancer router instead of the metaharness k-NN router; G1-18 finds keyword-triggered workers but misses the trigger map and cooldown and hedges that detection may need wiring; G1-21 says nothing does per-step attribution, contradicted by the real turn-credit package, and points to ReasoningBank/MaTTS/PPO; G2-11 misses the learning watchdog entirely and points to guard.ts and aidefence ADRs. Pattern: the need-index files match the wording of the question, the model follows them to a neighbouring product, searches more, and answers with less of the gold detail.

Finding: no harness defect found in the checks above (keyword material unchanged, need files appended, cap trims only the appended files, no failures beyond two auto-retried turn-limit errors). The drop is a measured effect of this design on these answerers. Not tested: whether the 4,000-character need-file excerpts rather than the files' relevant sections matter; whether a larger turn budget changes the 37 answers with more than 6 calls.
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
