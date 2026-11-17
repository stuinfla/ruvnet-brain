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
