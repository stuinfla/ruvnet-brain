# Set H (build-guidance), A10: arms A, D, P; 40 questions x 3 runs

Answers joined with a mechanical check and a blind judge grade: 360 of 360 answers. Score is capped 0-10, shown x10. Guidance success = capped score >= 8 AND capabilities named >= ceil(2/3 of the gold capabilities) AND order_workable (computed in code). Per-question mean over 3 runs is the unit; n = 40 questions.

Complete runs (all 40 questions answered and graded) per arm: A: 3 (1,2,3); D: 3 (1,2,3); P: 3 (1,2,3).

## Per arm

| arm | answers | mean capped /100 | share >=8 | guidance success rate (answers) | questions with guidance success in >=2 of 3 runs | capabilities named (mean share of gold) | order_workable | pitfall_given | false_claim | must_not_claim | grounded | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A no tool | 120 | 18.2 | 0.0% (0/120) | 0.0% (0/120) | 0.0% (0/40) | 8.7% | 2.5% (3/120) | 14.2% (17/120) | 45 | 4 | 0.0% (0/120) | 0 |
| D files + history | 120 | 45.8 | 11.7% (14/120) | 11.7% (14/120) | 10.0% (4/40) | 65.6% | 47.5% (57/120) | 51.7% (62/120) | 35 | 7 | 100.0% (120/120) | 0 |
| P files + history + GUIDE | 120 | 46.8 | 13.3% (16/120) | 13.3% (16/120) | 10.0% (4/40) | 69.7% | 48.3% (58/120) | 63.3% (76/120) | 29 | 6 | 100.0% (120/120) | 0 |

Arm A has no tools, so its answers carry no resolvable reference and the R8 cap (ungrounded -> 3) applies to every A answer by construction; its raw scores are in per-answer.jsonl.

## Run-to-run spread

| arm | run means capped /100 | run guidance success rate | SD of the run success rate (points) |
| --- | --- | --- | --- |
| A | 17.8, 18.3, 18.5 | 0.0, 0.0, 0.0 | 0.0 |
| D | 42.0, 49.5, 45.8 | 12.5, 15.0, 7.5 | 3.8 |
| P | 49.8, 41.8, 48.8 | 15.0, 12.5, 12.5 | 1.4 |

## Paired differences on per-question means (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261116)

| measure | P - D | D - A | P - A |
| --- | --- | --- | --- |
| guidance success | +1.7 [-2.5, 6.7] (runs 1,2,3) | +11.7 [3.3, 20.8] (runs 1,2,3) | +13.3 [5.0, 23.3] (runs 1,2,3) |
| capped score | +1.0 [-2.0, 4.6] (runs 1,2,3) | +27.6 [22.2, 33.3] (runs 1,2,3) | +28.6 [23.4, 34.0] (runs 1,2,3) |
| order_workable | +0.8 [-8.3, 10.8] (runs 1,2,3) | +45.0 [31.7, 58.3] (runs 1,2,3) | +45.8 [33.3, 58.3] (runs 1,2,3) |
| capabilities named (share) | +4.1 [-2.2, 10.6] (runs 1,2,3) | +56.9 [47.2, 66.4] (runs 1,2,3) | +61.0 [51.9, 69.4] (runs 1,2,3) |
| pitfall_given | +11.7 [2.5, 21.7] (runs 1,2,3) | +37.5 [24.2, 51.7] (runs 1,2,3) | +49.2 [35.8, 62.5] (runs 1,2,3) |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) |
| --- | --- | --- | --- | --- |
| A | 0.0 | 120 | 0 | n/a |
| D | 3.0 | 0 | 0 | 2448 |
| P | 2.5 | 0 | 0 | 2367 |
