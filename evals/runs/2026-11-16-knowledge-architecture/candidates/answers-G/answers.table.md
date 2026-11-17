# Set G slice questions (A14.2): arms A, D, Q; 65 questions x 3 runs; interim build, 1,617 of 9,029 units

Answers joined with a mechanical check and a blind judge grade: 585 of 585. Scores are capped 0-10, shown x10. The owner's measure is the share of QUESTIONS graded 8 or above in at least 2 of 3 runs (n = 65 questions, all amateur askers). Build: interim build, 1,617 of 9,029 units.

Honesty note: the CAPABILITIES section in arm Q is fixed per question (computed once from the original question text by the slice builder, `section_text`), returned unchanged on every search call of that question; it is not recomputed from the model's own search queries.

Complete runs per arm: A: 3 (1,2,3); D: 3 (1,2,3); Q: 3 (1,2,3).

## Per arm

| arm | answers | mean capped /100 | mean raw /100 | share of answers >=8 | questions >=8 in at least 2 of 3 runs (owner's measure) | false_claim | must_not_claim | grounded | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A no tool | 195 | 23.1 | 25.4 | 0.0% (0/195) | 0.0% (0/65) | 35 | 1 | 1.5% (3/195) | 0 |
| D files + history | 195 | 68.7 | 68.7 | 53.8% (105/195) | 55.4% (36/65) | 22 | 4 | 100.0% (195/195) | 0 |
| Q files + history + CAPABILITIES (fixed per question) | 195 | 69.1 | 69.1 | 54.9% (107/195) | 53.8% (35/65) | 21 | 8 | 100.0% (195/195) | 0 |

Arm A has no tools, so every A answer is ungrounded by construction and the R8 cap (3) applies to it.

## By stratum: owner's measure and mean capped /100

| stratum | n | A >=2 of 3 at 8+ | A mean | D >=2 of 3 at 8+ | D mean | Q >=2 of 3 at 8+ | Q mean |
| --- | --- | --- | --- | --- | --- | --- | --- |
| build-task | 13 | 0.0% (0/13) | 24.6 | 53.8% (7/13) | 74.6 | 69.2% (9/13) | 76.2 |
| which-tool | 48 | 0.0% (0/48) | 22.4 | 58.3% (28/48) | 67.8 | 50.0% (24/48) | 67.6 |
| troubleshooting | 4 | 0.0% (0/4) | 26.7 | 25.0% (1/4) | 59.2 | 50.0% (2/4) | 64.2 |

## Run-to-run spread

| arm | run means capped /100 | run share of answers >=8 |
| --- | --- | --- |
| A | 23.1, 23.5, 22.6 | 0.0, 0.0, 0.0 |
| D | 69.2, 67.5, 69.2 | 53.8, 52.3, 55.4 |
| Q | 70.0, 66.5, 70.9 | 55.4, 50.8, 58.5 |

## Paired differences on per-question values (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261117)

| measure | Q - D | D - A | Q - A |
| --- | --- | --- | --- |
| owner's measure (question graded >=8 in >=2 of 3 runs) | -1.5 [-12.3, 7.7] | +55.4 [43.1, 67.7] | +53.8 [41.5, 66.2] |
| mean capped score | +0.5 [-2.7, 3.5] | +45.6 [40.4, 50.5] | +46.1 [41.0, 50.9] |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) |
| --- | --- | --- | --- | --- |
| A | 0.0 | 195 | 0 | n/a |
| D | 2.4 | 0 | 0 | 1578 |
| Q | 2.2 | 0 | 0 | 1550 |
