# A10.3 rule for the guidance layer (arm P: GUIDE section = author-written playbooks and need rows, A11.3)

Rule fixed before H existed: P minus D on guidance success >= +10 points, the 95% bootstrap interval excludes zero, and false claims do not rise.

| measure | value |
| --- | --- |
| P - D guidance success (points) | +1.7 [-2.5, 6.7] (runs 1,2,3) |
| >= +10 | false |
| interval excludes zero | false |
| false claims P vs D | 29 vs 35 (not higher) |
| **A10.3 rule** | **not met** |

Share of questions with guidance success in at least 2 of 3 runs (the owner's measure, reported against 93% and 98%): A 0.0% (0/40); D 10.0% (4/40); P 10.0% (4/40).

## Arm P: did the GUIDE section carry the gold capabilities? (gold capability name = text before the first " (" of the gold capability, matched in the GUIDE text of every search the answer made)

| reading | mean share of gold capabilities present | answers with at least 1 present | answers with at least 2/3 present |
| --- | --- | --- | --- |
| exact name substring | 5.1% | 14.2% (17/120) | 0.0% (0/120) |
| all name words present (looser) | 18.3% | 45.0% (54/120) | 5.0% (6/120) |

2x2: GUIDE carried at least 2/3 of the gold capabilities (looser reading) x guidance success, P answers

| GUIDE carried >= 2/3 | guidance success | answers | mean capped /100 |
| --- | --- | --- | --- |
| yes | yes | 0 | n/a |
| yes | no | 6 | 36.7 |
| no | yes | 16 | 80.6 |
| no | no | 98 | 41.8 |

Same 2x2 on the exact-name reading

| GUIDE carried >= 2/3 | guidance success | answers | mean capped /100 |
| --- | --- | --- | --- |
| yes | yes | 0 | n/a |
| yes | no | 0 | n/a |
| no | yes | 16 | 80.6 |
| no | no | 104 | 41.5 |

What I did not test: the selection rule was frozen as written by the lead and nothing was tuned on H; playbooks and need rows come from `authored.jsonl` (the scan of the seven slice stores), not a file named `playbooks.json`, which did not exist when the job started.
