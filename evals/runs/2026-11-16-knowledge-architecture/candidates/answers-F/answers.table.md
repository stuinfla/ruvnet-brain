# Answer-level measurement: arms A, B, C, D, 84 questions x 3 runs

Answers joined with a mechanical check and a blind judge grade: 480 of 480 answers. Scores are 0-10 per answer; tables show x10 (out of 100). Per-question mean of the 3 runs is the unit; n = 84 questions.

Complete runs (all 84 questions answered and graded) per arm: A: 3 (1,2,3); B: 0 (-); C: 0 (-); D: 3 (1,2,3). 0 graded answers from incomplete runs are in per-answer.jsonl but excluded from these tables. R8: an arm with fewer than 3 complete runs supports no answer-level claim; its numbers are shown for information.

## Per arm

| arm | answers | mean raw /100 | mean capped /100 | share >=8 raw | share >=8 capped | grounded rate | false_claim | must_not_claim | says does-not-exist (not-in-corpus) | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A no-brain | 240 | 27.3 | 23.8 | 0.0% | 0.0% | 0.0% (0/240) | 35 | 0 | 0/0 | 0 |
| D candidate, no concepts | 240 | 77.8 | 77.8 | 72.5% | 72.5% | 100.0% (240/240) | 16 | 0 | 0/0 | 0 |

Shares at 8 or above are over answers (not per-question means). Grounded = at least one cited reference resolved by code.

## Paired differences on per-question means (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261116)

### overall and by stratum: capped

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| overall | 80 | n/a | +54.0 [49.6, 58.1] (runs 1,2,3) | n/a | n/a | n/a |
| which-tool | 24 | n/a | +52.1 [42.9, 60.0] (runs 1,2,3) | n/a | n/a | n/a |
| troubleshooting | 12 | n/a | +54.4 [41.9, 63.3] (runs 1,2,3) | n/a | n/a | n/a |
| design-rationale | 12 | n/a | +61.1 [54.4, 66.9] (runs 1,2,3) | n/a | n/a | n/a |
| cross-repo | 12 | n/a | +60.0 [51.1, 66.9] (runs 1,2,3) | n/a | n/a | n/a |
| build-task | 8 | n/a | +47.5 [32.1, 61.3] (runs 1,2,3) | n/a | n/a | n/a |
| history | 12 | n/a | +48.9 [36.1, 59.2] (runs 1,2,3) | n/a | n/a | n/a |

### overall and by stratum: raw

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| overall | 80 | n/a | +50.5 [45.9, 54.9] (runs 1,2,3) | n/a | n/a | n/a |
| which-tool | 24 | n/a | +51.5 [42.4, 59.6] (runs 1,2,3) | n/a | n/a | n/a |
| troubleshooting | 12 | n/a | +46.1 [34.2, 56.4] (runs 1,2,3) | n/a | n/a | n/a |
| design-rationale | 12 | n/a | +54.2 [44.4, 62.8] (runs 1,2,3) | n/a | n/a | n/a |
| cross-repo | 12 | n/a | +60.0 [51.1, 66.9] (runs 1,2,3) | n/a | n/a | n/a |
| build-task | 8 | n/a | +42.1 [25.0, 58.8] (runs 1,2,3) | n/a | n/a | n/a |
| history | 12 | n/a | +45.6 [33.1, 56.7] (runs 1,2,3) | n/a | n/a | n/a |

### by asker: capped

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| amateur | 32 | n/a | +48.4 [40.6, 55.5] (runs 1,2,3) | n/a | n/a | n/a |
| expert | 17 | n/a | +63.9 [59.4, 67.6] (runs 1,2,3) | n/a | n/a | n/a |
| practitioner | 31 | n/a | +54.4 [47.4, 60.3] (runs 1,2,3) | n/a | n/a | n/a |

### by asker: raw

| group | n questions | C - A | D - A | B - A | C - D | C - B |
| --- | --- | --- | --- | --- | --- | --- |
| amateur | 32 | n/a | +46.1 [37.9, 53.6] (runs 1,2,3) | n/a | n/a | n/a |
| expert | 17 | n/a | +56.5 [48.4, 63.5] (runs 1,2,3) | n/a | n/a | n/a |
| practitioner | 31 | n/a | +51.8 [44.6, 58.1] (runs 1,2,3) | n/a | n/a | n/a |

## By stratum, mean /100 (capped; raw in brackets)

| stratum | n | A | D |
| --- | --- | --- | --- |
| which-tool | 24 | 22.9 [23.5] | 75.0 [75.0] |
| troubleshooting | 12 | 26.7 [35.0] | 81.1 [81.1] |
| design-rationale | 12 | 25.6 [32.5] | 86.7 [86.7] |
| cross-repo | 12 | 20.8 [20.8] | 80.8 [80.8] |
| build-task | 8 | 21.3 [26.7] | 68.8 [68.8] |
| history | 12 | 25.6 [28.9] | 74.4 [74.4] |

## By knowledge_type, mean /100 (capped; raw in brackets)

| knowledge_type | n | A | D |
| --- | --- | --- | --- |
| agentic-learning | 5 | 24.7 [24.7] | 58.7 [58.7] |
| capability | 2 | 25.0 [25.0] | 61.7 [61.7] |
| history | 12 | 25.6 [28.9] | 74.4 [74.4] |
| how-it-works | 7 | 21.4 [27.6] | 67.1 [67.1] |
| integration | 12 | 20.8 [20.8] | 80.8 [80.8] |
| rationale | 12 | 25.6 [32.5] | 86.7 [86.7] |
| storage-retrieval-technique | 4 | 22.5 [22.5] | 74.2 [74.2] |
| tool-choice | 14 | 21.9 [22.9] | 83.3 [83.3] |
| troubleshooting | 12 | 26.7 [35.0] | 81.1 [81.1] |

## By asker, mean /100 (capped; raw in brackets)

| asker | n | A | D |
| --- | --- | --- | --- |
| amateur | 32 | 23.4 [25.7] | 71.9 [71.9] |
| expert | 17 | 25.3 [32.7] | 89.2 [89.2] |
| practitioner | 31 | 23.3 [25.9] | 77.7 [77.7] |

## Share of answers at 8 or above (capped), by asker x arm; and questions with at least 2 of 3 runs at 8 or above

| asker | n questions | A answers >=8 | D answers >=8 | A questions with >=2 of 3 runs >=8 | D questions with >=2 of 3 runs >=8 |
| --- | --- | --- | --- | --- | --- |
| amateur | 32 | 0.0% (0/96) | 59.4% (57/96) | 0.0% (0/32) | 53.1% (17/32) |
| expert | 17 | 0.0% (0/51) | 92.2% (47/51) | 0.0% (0/17) | 94.1% (16/17) |
| practitioner | 31 | 0.0% (0/93) | 75.3% (70/93) | 0.0% (0/31) | 77.4% (24/31) |
| stratum: which-tool | 24 | 0.0% (0/72) | 65.3% (47/72) | 0.0% (0/24) | 62.5% (15/24) |
| stratum: troubleshooting | 12 | 0.0% (0/36) | 80.6% (29/36) | 0.0% (0/12) | 75.0% (9/12) |
| stratum: design-rationale | 12 | 0.0% (0/36) | 86.1% (31/36) | 0.0% (0/12) | 83.3% (10/12) |
| stratum: cross-repo | 12 | 0.0% (0/36) | 80.6% (29/36) | 0.0% (0/12) | 83.3% (10/12) |
| stratum: build-task | 8 | 0.0% (0/24) | 45.8% (11/24) | 0.0% (0/8) | 50.0% (4/8) |
| stratum: history | 12 | 0.0% (0/36) | 75.0% (27/36) | 0.0% (0/12) | 75.0% (9/12) |
| amateur x which-tool | 17 | 0.0% (0/51) | 56.9% (29/51) | 0.0% (0/17) | 52.9% (9/17) |
| expert x which-tool | 2 | 0.0% (0/6) | 100.0% (6/6) | 0.0% (0/2) | 100.0% (2/2) |
| practitioner x which-tool | 5 | 0.0% (0/15) | 80.0% (12/15) | 0.0% (0/5) | 80.0% (4/5) |
| amateur x troubleshooting | 4 | 0.0% (0/12) | 66.7% (8/12) | 0.0% (0/4) | 50.0% (2/4) |
| expert x troubleshooting | 1 | 0.0% (0/3) | 100.0% (3/3) | 0.0% (0/1) | 100.0% (1/1) |
| practitioner x troubleshooting | 7 | 0.0% (0/21) | 85.7% (18/21) | 0.0% (0/7) | 85.7% (6/7) |
| expert x design-rationale | 8 | 0.0% (0/24) | 95.8% (23/24) | 0.0% (0/8) | 100.0% (8/8) |
| practitioner x design-rationale | 4 | 0.0% (0/12) | 66.7% (8/12) | 0.0% (0/4) | 50.0% (2/4) |
| amateur x cross-repo | 1 | 0.0% (0/3) | 33.3% (1/3) | 0.0% (0/1) | 0.0% (0/1) |
| expert x cross-repo | 4 | 0.0% (0/12) | 91.7% (11/12) | 0.0% (0/4) | 100.0% (4/4) |
| practitioner x cross-repo | 7 | 0.0% (0/21) | 81.0% (17/21) | 0.0% (0/7) | 85.7% (6/7) |
| amateur x build-task | 3 | 0.0% (0/9) | 44.4% (4/9) | 0.0% (0/3) | 33.3% (1/3) |
| practitioner x build-task | 5 | 0.0% (0/15) | 46.7% (7/15) | 0.0% (0/5) | 60.0% (3/5) |
| amateur x history | 7 | 0.0% (0/21) | 71.4% (15/21) | 0.0% (0/7) | 71.4% (5/7) |
| expert x history | 2 | 0.0% (0/6) | 66.7% (4/6) | 0.0% (0/2) | 50.0% (1/2) |
| practitioner x history | 3 | 0.0% (0/9) | 88.9% (8/9) | 0.0% (0/3) | 100.0% (3/3) |
| all | 80 | 0.0% (0/240) | 72.5% (174/240) | 0.0% (0/80) | 71.3% (57/80) |

## Run-to-run spread

| arm | questions whose capped score differs between runs (of 84) | questions whose raw score differs | run means capped (complete runs) | SD of arm mean across runs, capped | run means raw | SD raw |
| --- | --- | --- | --- | --- | --- | --- |
| A no-brain | 13 | 26 | 23.4, 23.8, 24.3 | 0.4 | 26.5, 27.1, 28.3 | 0.9 |
| D candidate, no concepts | 47 | 47 | 77.6, 77.0, 78.9 | 1.0 | 77.6, 77.0, 78.9 | 1.0 |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) | median (ms) | p90 (ms) |
| --- | --- | --- | --- | --- | --- | --- |
| A no-brain | 0.0 | 240 | 0 | n/a | n/a | n/a |
| D candidate, no concepts | 2.4 | 0 | 0 | 3155 | 2814 | 5628 |

Latency per call is the gap between the stream event that shows the tool call and the one that shows its result (arrival times, includes harness overhead; machine load was uncontrolled).

## Judge consistency re-check (answers already judged in batch 1, re-judged blind in batch 2 with the same prompt)

| arm | n | same score | within 1 point | mean shift (re-judge minus first) | raw first mean | raw re-judge mean |
| --- | --- | --- | --- | --- | --- | --- |
| A | 12 | 12 | 12 | +0.0 | 3.0 | 3.0 |
| C | 9 | 9 | 9 | +0.0 | 7.6 | 7.6 |
| all | 30 | 28 | 30 | -0.1 | 5.6 | 5.5 |
