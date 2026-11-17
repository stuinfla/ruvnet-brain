# Answer-level measurement: arms A, B, C, D, 84 questions x 3 runs

Answers joined with a mechanical check and a blind judge grade: 756 of 805 answers. Scores are 0-10 per answer; tables show x10 (out of 100). Per-question mean of the 3 runs is the unit; n = 84 questions.

Complete runs (all 84 questions answered and graded) per arm: A: 3 (1,2,3); B: 0 (-); C: 3 (1,2,3); D: 3 (1,2,3). 49 graded answers from incomplete runs are in per-answer.jsonl but excluded from these tables. R8: an arm with fewer than 3 complete runs supports no answer-level claim; its numbers are shown for information.

## Per arm

| arm | answers | mean raw /100 | mean capped /100 | share >=8 raw | share >=8 capped | grounded rate | false_claim | must_not_claim | says does-not-exist (not-in-corpus) | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A no-brain | 252 | 28.8 | 25.4 | 3.6% | 1.2% | 0.4% (1/252) | 29 | 3 | 7/36 | 0 |
| C candidate | 252 | 75.7 | 75.7 | 61.9% | 61.9% | 100.0% (252/252) | 15 | 6 | 36/36 | 0 |
| D candidate, no concepts | 252 | 73.1 | 73.1 | 59.1% | 59.1% | 99.6% (251/252) | 29 | 3 | 35/36 | 0 |

Shares at 8 or above are over answers (not per-question means). Grounded = at least one cited reference resolved by code.

## Paired differences on per-question means (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261116)

### overall and by stratum: capped

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| overall | 84 | +50.3 [46.5, 54.0] (runs 1,2,3) | +47.7 [43.2, 52.1] (runs 1,2,3) | n/a | +2.6 [-0.4, 5.7] (runs 1,2,3) | n/a |
| troubleshooting | 12 | +53.3 [48.1, 58.1] (runs 1,2,3) | +52.5 [43.9, 60.0] (runs 1,2,3) | n/a | +0.8 [-2.5, 5.3] (runs 1,2,3) | n/a |
| history | 12 | +56.7 [48.6, 63.9] (runs 1,2,3) | +62.2 [55.0, 68.3] (runs 1,2,3) | n/a | -5.6 [-11.9, 0.6] (runs 1,2,3) | n/a |
| design-rationale | 12 | +56.9 [49.2, 63.9] (runs 1,2,3) | +59.7 [51.7, 66.1] (runs 1,2,3) | n/a | -2.8 [-10.0, 6.1] (runs 1,2,3) | n/a |
| cross-repo | 12 | +46.1 [32.8, 58.1] (runs 1,2,3) | +41.9 [30.6, 52.5] (runs 1,2,3) | n/a | +4.2 [-1.1, 11.1] (runs 1,2,3) | n/a |
| build-task | 12 | +48.6 [38.9, 58.3] (runs 1,2,3) | +38.9 [26.1, 51.7] (runs 1,2,3) | n/a | +9.7 [-2.2, 21.9] (runs 1,2,3) | n/a |
| which-tool | 12 | +43.9 [31.9, 54.4] (runs 1,2,3) | +36.9 [21.9, 51.4] (runs 1,2,3) | n/a | +6.9 [-0.8, 16.1] (runs 1,2,3) | n/a |
| not-in-corpus | 12 | +46.7 [36.9, 56.4] (runs 1,2,3) | +41.9 [31.1, 52.8] (runs 1,2,3) | n/a | +4.7 [0.6, 9.4] (runs 1,2,3) | n/a |

### overall and by stratum: raw

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| overall | 84 | +46.9 [42.4, 51.1] (runs 1,2,3) | +44.3 [39.2, 49.2] (runs 1,2,3) | n/a | +2.6 [-0.4, 5.7] (runs 1,2,3) | n/a |
| troubleshooting | 12 | +45.0 [36.7, 52.2] (runs 1,2,3) | +44.2 [34.4, 52.8] (runs 1,2,3) | n/a | +0.8 [-2.5, 5.3] (runs 1,2,3) | n/a |
| history | 12 | +54.7 [46.9, 62.2] (runs 1,2,3) | +60.3 [53.1, 66.9] (runs 1,2,3) | n/a | -5.6 [-11.9, 0.6] (runs 1,2,3) | n/a |
| design-rationale | 12 | +55.6 [47.8, 62.8] (runs 1,2,3) | +58.3 [48.1, 65.8] (runs 1,2,3) | n/a | -2.8 [-10.0, 6.1] (runs 1,2,3) | n/a |
| cross-repo | 12 | +46.1 [32.8, 58.1] (runs 1,2,3) | +41.9 [30.6, 52.5] (runs 1,2,3) | n/a | +4.2 [-1.1, 11.1] (runs 1,2,3) | n/a |
| build-task | 12 | +48.1 [37.8, 58.1] (runs 1,2,3) | +38.3 [25.3, 51.1] (runs 1,2,3) | n/a | +9.7 [-2.2, 21.9] (runs 1,2,3) | n/a |
| which-tool | 12 | +43.9 [31.9, 54.4] (runs 1,2,3) | +36.9 [21.9, 51.4] (runs 1,2,3) | n/a | +6.9 [-0.8, 16.1] (runs 1,2,3) | n/a |
| not-in-corpus | 12 | +35.0 [18.9, 50.0] (runs 1,2,3) | +30.3 [11.9, 46.7] (runs 1,2,3) | n/a | +4.7 [0.6, 9.4] (runs 1,2,3) | n/a |

### by asker: capped

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| amateur | 31 | +45.5 [39.1, 51.5] (runs 1,2,3) | +40.8 [33.1, 48.1] (runs 1,2,3) | n/a | +4.7 [-0.8, 10.9] (runs 1,2,3) | n/a |
| expert | 17 | +50.6 [40.8, 60.0] (runs 1,2,3) | +49.6 [37.8, 60.6] (runs 1,2,3) | n/a | +1.0 [-4.1, 6.1] (runs 1,2,3) | n/a |
| practitioner | 36 | +54.4 [49.9, 58.7] (runs 1,2,3) | +52.9 [47.4, 57.9] (runs 1,2,3) | n/a | +1.5 [-2.8, 6.0] (runs 1,2,3) | n/a |

### by asker: raw

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| amateur | 31 | +41.3 [33.9, 48.3] (runs 1,2,3) | +36.6 [27.8, 44.7] (runs 1,2,3) | n/a | +4.7 [-0.8, 10.9] (runs 1,2,3) | n/a |
| expert | 17 | +49.2 [38.2, 59.4] (runs 1,2,3) | +48.2 [35.7, 59.8] (runs 1,2,3) | n/a | +1.0 [-4.1, 6.1] (runs 1,2,3) | n/a |
| practitioner | 36 | +50.6 [45.0, 56.0] (runs 1,2,3) | +49.2 [42.7, 55.2] (runs 1,2,3) | n/a | +1.5 [-2.8, 6.0] (runs 1,2,3) | n/a |

### by whether a concept card covers the question gold (card_covered, set E, rigC per-question.jsonl): capped

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| card_covered = true | 46 | +47.3 [41.8, 52.8] (runs 1,2,3) | +42.0 [35.6, 48.4] (runs 1,2,3) | n/a | +5.3 [0.4, 10.3] (runs 1,2,3) | n/a |
| card_covered = false | 38 | +53.9 [49.1, 58.4] (runs 1,2,3) | +54.6 [49.2, 59.7] (runs 1,2,3) | n/a | -0.7 [-3.7, 2.2] (runs 1,2,3) | n/a |

### by whether a concept card covers the question gold (card_covered, set E, rigC per-question.jsonl): raw

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| card_covered = true | 46 | +46.8 [41.4, 52.2] (runs 1,2,3) | +41.5 [35.0, 48.0] (runs 1,2,3) | n/a | +5.3 [0.4, 10.3] (runs 1,2,3) | n/a |
| card_covered = false | 38 | +47.0 [40.0, 53.6] (runs 1,2,3) | +47.7 [39.5, 55.0] (runs 1,2,3) | n/a | -0.7 [-3.7, 2.2] (runs 1,2,3) | n/a |

## By stratum, mean /100 (capped; raw in brackets)

| stratum | n | A | C | D |
| --- | --- | --- | --- | --- |
| troubleshooting | 12 | 27.5 [35.8] | 80.8 [80.8] | 80.0 [80.0] |
| history | 12 | 26.4 [28.3] | 83.1 [83.1] | 88.6 [88.6] |
| design-rationale | 12 | 26.7 [28.1] | 83.6 [83.6] | 86.4 [86.4] |
| cross-repo | 12 | 21.4 [21.4] | 67.5 [67.5] | 63.3 [63.3] |
| build-task | 12 | 20.8 [21.4] | 69.4 [69.4] | 59.7 [59.7] |
| which-tool | 12 | 23.3 [23.3] | 67.2 [67.2] | 60.3 [60.3] |
| not-in-corpus | 12 | 31.7 [43.3] | 78.3 [78.3] | 73.6 [73.6] |

## By knowledge_type, mean /100 (capped; raw in brackets)

| knowledge_type | n | A | C | D |
| --- | --- | --- | --- | --- |
| absence | 12 | 31.7 [43.3] | 78.3 [78.3] | 73.6 [73.6] |
| agentic-learning | 14 | 23.1 [24.3] | 77.9 [77.9] | 76.2 [76.2] |
| architecture | 2 | 21.7 [21.7] | 68.3 [68.3] | 75.0 [75.0] |
| capability | 3 | 23.3 [23.3] | 55.6 [55.6] | 38.9 [38.9] |
| concept | 4 | 26.7 [26.7] | 73.3 [73.3] | 69.2 [69.2] |
| history | 11 | 26.1 [28.2] | 81.8 [81.8] | 87.9 [87.9] |
| how-it-works | 4 | 20.0 [20.0] | 73.3 [73.3] | 67.5 [67.5] |
| integration | 10 | 22.3 [23.0] | 66.7 [66.7] | 63.3 [63.3] |
| rationale | 2 | 30.0 [30.0] | 93.3 [93.3] | 93.3 [93.3] |
| storage-retrieval-technique | 7 | 23.8 [23.8] | 78.6 [78.6] | 80.0 [80.0] |
| tool-choice | 6 | 22.2 [22.8] | 67.8 [67.8] | 53.9 [53.9] |
| troubleshooting | 9 | 28.9 [39.6] | 81.1 [81.1] | 78.9 [78.9] |

## By asker, mean /100 (capped; raw in brackets)

| asker | n | A | C | D |
| --- | --- | --- | --- | --- |
| amateur | 31 | 26.8 [31.0] | 72.3 [72.3] | 67.5 [67.5] |
| expert | 17 | 26.7 [28.0] | 77.3 [77.3] | 76.3 [76.3] |
| practitioner | 36 | 23.6 [27.3] | 78.0 [78.0] | 76.5 [76.5] |

## Run-to-run spread

| arm | questions whose capped score differs between runs (of 84) | questions whose raw score differs | run means capped (complete runs) | SD of arm mean across runs, capped | run means raw | SD raw |
| --- | --- | --- | --- | --- | --- | --- |
| A no-brain | 28 | 38 | 26.0, 24.9, 25.4 | 0.5 | 29.0, 28.3, 29.0 | 0.4 |
| C candidate | 56 | 56 | 75.2, 74.8, 77.1 | 1.3 | 75.2, 74.8, 77.1 | 1.3 |
| D candidate, no concepts | 59 | 59 | 73.3, 73.6, 72.5 | 0.6 | 73.3, 73.6, 72.5 | 0.6 |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) | median (ms) | p90 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| A no-brain | 0.0 | 252 | 0 | n/a | n/a | n/a |
| C candidate | 2.1 | 0 | 0 | 1841 | 1468 | 3098 |
| D candidate, no concepts | 2.4 | 0 | 0 | 1860 | 1513 | 3727 |

Latency per call is the gap between the stream event that shows the tool call and the one that shows its result (arrival times, includes harness overhead; machine load was uncontrolled).

## Judge consistency re-check (answers already judged in batch 1, re-judged blind in batch 2 with the same prompt)

| arm | n | same score | within 1 point | mean shift (re-judge minus first) | raw first mean | raw re-judge mean |
| --- | --- | --- | --- | --- | --- | --- |
| A | 30 | 27 | 30 | +0.0 | 3.0 | 3.0 |
| C | 30 | 26 | 30 | -0.1 | 7.6 | 7.5 |
| all | 60 | 53 | 60 | -0.1 | 5.3 | 5.3 |

<!-- B-PARTIAL-START -->
## Arm B, partial run 1, for information (R8: no claim)

Rests on 49 of 84 questions, run 1 only (one run per question; R8 needs 3 runs per arm, so this supports no answer-level claim). Every comparison uses run 1 of each arm on exactly these 49 questions; bootstrap: 10,000 resamples of these questions, seed 20261116. B answers written so far: 49.

| measure | value |
| --- | --- |
| questions (n) | 49 |
| B mean raw /100 | 60.8 |
| B mean capped /100 | 60.8 |
| share at 8 or above (raw / capped) | 38.8% / 38.8% |
| grounded rate | 100.0% (49/49) |
| false_claim answers | 7 |
| must_not_claim answers | 1 |
| says does-not-exist on not-in-corpus | 3/3 |
| tool results "NO SEARCH WAS RUN" (declined): results / answers | 7 of 259 / 7 of 49 |
| tool results INSUFFICIENT_EVIDENCE: results / answers | 37 of 259 / 23 of 49 |
| tool results flagged thin or weak coverage: results / answers | 103 of 259 / 44 of 49 |
| searches per answer | 5.3 |
| latency per call mean / median / p90 (ms) | 33644 / 18262 / 90616 |
| answers truncated by the turn limit | 0 |

Same questions, run 1, mean raw / capped /100 for the other arms: A 26.5 / 25.1; C 75.1 / 75.1; D 76.9 / 76.9

| paired difference, points out of 100 [95% interval] | capped | raw |
| --- | --- | --- |
| B - A | +35.7 [27.8, 43.5] | +34.3 [26.3, 42.2] |
| C - B | +14.3 [4.9, 23.9] | +14.3 [4.9, 23.9] |
| D - B | +16.1 [6.3, 26.1] | +16.1 [6.3, 26.1] |

<!-- B-PARTIAL-END -->
