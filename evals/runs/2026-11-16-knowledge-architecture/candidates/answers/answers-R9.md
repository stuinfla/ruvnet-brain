# R9 line: brain minus no-brain against the 15-point threshold (points out of 100, per-question means of 3 runs, n = 84 questions)

| score | comparison | difference | 95% bootstrap interval | threshold | point estimate >= 15 |
| --- | --- | --- | --- | --- | --- |
| capped | C - A (runs 1,2,3; 3 of 3) | +50.3 | [46.5, 54.0] | 15 | met |
| capped | D - A (runs 1,2,3; 3 of 3) | +47.7 | [43.2, 52.1] | 15 | met |
| capped | B - A | n/a | n/a | 15 | n/a (no complete run for both arms) |
| raw | C - A (runs 1,2,3; 3 of 3) | +46.9 | [42.4, 51.1] | 15 | met |
| raw | D - A (runs 1,2,3; 3 of 3) | +44.3 | [39.2, 49.2] | 15 | met |
| raw | B - A | n/a | n/a | 15 | n/a (no complete run for both arms) |

Every arm has the no-brain baseline (arm A: same model, same prompt apart from the tool sentence, no tools).

Rule fixed before the D result: "cards stay only if C minus D >= +5 points and the 95% interval excludes zero".

| score | C - D | 95% interval | >= +5 | interval excludes zero | rule |
| --- | --- | --- | --- | --- | --- |
| capped | +2.6 | [-0.4, 5.7] | no | no | not met |
| raw | +2.6 | [-0.4, 5.7] | no | no | not met |
