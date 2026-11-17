# Set H (build-guidance), A16: arms D, QH; 40 questions x 3 runs

Answers joined with a mechanical check and a blind judge grade: 480 of 480 answers. Score is capped 0-10, shown x10. Guidance success = capped score >= 8 AND capabilities named >= ceil(2/3 of the gold capabilities) AND order_workable (computed in code). Per-question mean over 3 runs is the unit; n = 40 questions.

Complete runs (all 40 questions answered and graded) per arm: D: 3 (1,2,3); QH: 3 (1,2,3).

## Per arm

| arm | answers | mean capped /100 | share >=8 | guidance success rate (answers) | questions with guidance success in >=2 of 3 runs | capabilities named (mean share of gold) | order_workable | pitfall_given | false_claim | must_not_claim | grounded | truncated by turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D files + history (reused from A10) | 120 | 45.8 | 11.7% (14/120) | 11.7% (14/120) | 10.0% (4/40) | 65.6% | 47.5% (57/120) | 51.7% (62/120) | 35 | 7 | 100.0% (120/120) | 0 |
| QH files + history + CAPABILITIES (fixed per question) | 120 | 47.6 | 10.0% (12/120) | 10.0% (12/120) | 7.5% (3/40) | 68.2% | 49.2% (59/120) | 61.7% (74/120) | 26 | 3 | 100.0% (120/120) | 0 |

Label: second use of set H; interim build 1,617 of 9,029 units. The CAPABILITIES section is fixed per question (computed once from the original question, `section_text` of capabilities-section.H.jsonl), returned unchanged on every search call; it is not recomputed per search query. Arm D rows and grades are the A10 ones, reused.

## Run-to-run spread

| arm | run means capped /100 | run guidance success rate | SD of the run success rate (points) |
| --- | --- | --- | --- |
| D | 42.0, 49.5, 45.8 | 12.5, 15.0, 7.5 | 3.8 |
| QH | 47.0, 46.3, 49.5 | 10.0, 7.5, 12.5 | 2.5 |

## Paired differences on per-question means (points out of 100; 95% bootstrap interval, 10,000 resamples of questions, seed 20261116)

| measure | QH - D |
| --- | --- |
| guidance success | -1.7 [-5.8, 1.7] (runs 1,2,3) |
| capped score | +1.8 [-0.9, 4.7] (runs 1,2,3) |
| order_workable | +1.7 [-8.3, 12.5] (runs 1,2,3) |
| capabilities named (share) | +2.6 [-4.9, 10.8] (runs 1,2,3) |
| pitfall_given | +10.0 [0.8, 20.8] (runs 1,2,3) |

## Tool use

| arm | mean searches per answer | answers with 0 searches | answers with more than 6 calls | mean latency per call (ms) |
| --- | --- | --- | --- | --- |
| D | 3.0 | 0 | 0 | 2448 |
| QH | 2.7 | 0 | 0 | 1881 |

# A16.2 rule for the capability section on set H (arm QH); second use of set H; interim build 1,617 of 9,029 units

Rule fixed before the section existed (A16.2): QH minus D on guidance success >= +10 points, the 95% bootstrap interval excludes zero, and false claims do not rise.

| measure | value |
| --- | --- |
| QH - D guidance success (points) | -1.7 [-5.8, 1.7] (runs 1,2,3) |
| >= +10 | false |
| interval excludes zero | false |
| false claims QH vs D | 26 vs 35 (not higher) |
| **A16.2 rule** | **not met** |

Share of questions with guidance success in at least 2 of 3 runs (the owner's measure, reported against 93% and 98%): D 10.0% (4/40); QH 7.5% (3/40).

## Arm QH: did the CAPABILITIES section carry the gold capabilities? (gold capability name = text before the first " (" of the gold capability, matched in the section text, fixed for the question)

| reading | mean share of gold capabilities present | answers with at least 1 present | answers with at least 2/3 present |
| --- | --- | --- | --- |
| exact name substring | 5.2% | 15.0% (18/120) | 0.0% (0/120) |
| all name words present (looser) | 16.7% | 37.5% (45/120) | 12.5% (15/120) |

2x2: section carried at least 2/3 of the gold capabilities (looser reading) x guidance success, QH answers

| section carried >= 2/3 | guidance success | answers | mean capped /100 |
| --- | --- | --- | --- |
| yes | yes | 0 | n/a |
| yes | no | 15 | 51.3 |
| no | yes | 12 | 80.8 |
| no | no | 93 | 42.7 |

Same 2x2 on the exact-name reading

| section carried >= 2/3 | guidance success | answers | mean capped /100 |
| --- | --- | --- | --- |
| yes | yes | 0 | n/a |
| yes | no | 0 | n/a |
| no | yes | 12 | 80.8 |
| no | no | 108 | 43.9 |

What I did not test: second use of set H, so a pass would need confirmation on a new guidance set; the section is fixed per question, not recomputed per search; interim build; no setting was tuned on H. Arm D answers and grades are those of A10, reused unchanged.
