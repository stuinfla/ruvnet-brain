# Host delivery check, every arm of every answer run

Source: raw stream-json traces of the answering sessions (one file per answer), in the big-data directory. Each tool result is classified from the text the model received: delivered in full; size error ("exceeds maximum allowed tokens"); or replaced by a "persisted-output / Output too large ... saved to file" notice. The answering sessions have no file tool, so an error or notice means the model received no result text (a notice carries a short preview only). Sizes of rejected results are as reported in the message (characters, or KB x 1024); sizes of delivered results are measured.

## Set E

| arm | answers | tool results | delivered in full | size error | replaced by notice | share not delivered | answers with >= 1 undelivered | delivered median / max chars | rejected median / max chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 252 | 0 | 0 | 0 | 0 | n/a (no tool) | 0 (0.0%) | - / - | - / - |
| B | 49 | 259 | 187 | 60 | 12 | 27.8% | 41 (83.7%) | 20,163 / 49,970 | 68,080 / 135,759 |
| C | 252 | 521 | 475 | 0 | 46 | 8.8% | 43 (17.1%) | 47,398 / 52,400 | 51,917 / 53,146 |
| D | 252 | 603 | 603 | 0 | 0 | 0.0% | 0 (0.0%) | 44,592 / 49,482 | - / - |

## Set F

| arm | answers | tool results | delivered in full | size error | replaced by notice | share not delivered | answers with >= 1 undelivered | delivered median / max chars | rejected median / max chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 240 | 0 | 0 | 0 | 0 | n/a (no tool) | 0 (0.0%) | - / - | - / - |
| D | 240 | 564 | 564 | 0 | 0 | 0.0% | 0 (0.0%) | 43,156 / 49,178 | - / - |

## Set G

| arm | answers | tool results | delivered in full | size error | replaced by notice | share not delivered | answers with >= 1 undelivered | delivered median / max chars | rejected median / max chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 195 | 0 | 0 | 0 | 0 | n/a (no tool) | 0 (0.0%) | - / - | - / - |
| D | 195 | 463 | 463 | 0 | 0 | 0.0% | 0 (0.0%) | 44,909 / 49,303 | - / - |
| Q | 195 | 421 | 421 | 0 | 0 | 0.0% | 0 (0.0%) | 45,413 / 50,682 | - / - |
| N | 195 | 1012 | 33 | 191 | 788 | 96.7% | 195 (100.0%) | 48,026 / 51,177 | 59,800 / 62,669 |
| L | 195 | 1008 | 48 | 298 | 662 | 95.2% | 194 (99.5%) | 48,470 / 51,939 | 59,685 / 62,874 |
| M | 195 | 444 | 444 | 0 | 0 | 0.0% | 0 (0.0%) | 41,970 / 49,737 | - / - |

## Set H

| arm | answers | tool results | delivered in full | size error | replaced by notice | share not delivered | answers with >= 1 undelivered | delivered median / max chars | rejected median / max chars |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 120 | 0 | 0 | 0 | 0 | n/a (no tool) | 0 (0.0%) | - / - | - / - |
| D | 120 | 360 | 360 | 0 | 0 | 0.0% | 0 (0.0%) | 44,711 / 49,587 | - / - |
| P | 120 | 296 | 296 | 0 | 0 | 0.0% | 0 (0.0%) | 45,467 / 50,691 | - / - |
| QH | 120 | 321 | 321 | 0 | 0 | 0.0% | 0 (0.0%) | 45,542 / 50,736 | - / - |

Exact error message (first seen): `Error: result (109,504 characters) exceeds maximum allowed tokens. Output has been saved to /Users/stuartkerr/.claude/projects/-private-var-folders-dq-s8kgbs151dz1sjb90t6wyqlw0000gn-T-ka-ans`

Exact file notice (first seen): `<persisted-output> Output too large (50.9KB). Full output saved to: /Users/stuartkerr/.claude/projects/-private-var-folders-dq-s8kgbs151dz1sjb90t6wyqlw0000gn-T-ka-ans-cwd-84Qz0A/1dc52658-05b`

## Rules recomputed on questions where both arms had every result delivered in all runs

Per-question paired difference of the same measure each rule used (capped mean x10 for E and F; guidance success share for H; owner's measure for G), 95% bootstrap interval (10,000 resamples; seed 20261116 for E, F, H; 20261117 for G). "Restricted" keeps only questions with all 3 runs of both arms present and every tool result delivered in full in all those runs; the arm without tools (A) is always clean. Where a rule has extra conditions (false claims not higher, gate), they are not recomputed here: only the stated point-and-interval test is. Reading: "stands" = restricted outcome of the test equals the original and n >= 10; "changes" = outcome differs; "cannot be read" = n < 10 (too few fully delivered questions) or arm absent. The M rows read "not yet" until M is judged.

| rule | all questions: diff [interval] (n) | restricted: diff [interval] (n) | test (all) | test (restricted) | reading |
| --- | --- | --- | --- | --- | --- |
| R9 (E): C minus A, capped points of 100, threshold >= +15 | +50.3 [+46.6, +53.9] (84) | +49.0 [+44.4, +53.3] (61) | met | met | stands |
| R9 (E): D minus A, capped points of 100, threshold >= +15 | +47.7 [+43.3, +52.2] (84) | +47.7 [+43.3, +52.2] (84) | met | met | stands |
| C minus D ablation (E): rule "C - D >= +5 and interval excludes zero" | +2.6 [-0.4, +5.7] (84) | +2.3 [-0.8, +5.6] (61) | not met | not met | stands |
| R9 on F: D minus A, capped points of 100, threshold >= +15 | +54.0 [+49.6, +58.1] (80) | +54.0 [+49.6, +58.1] (80) | met | met | stands |
| A10.3 (H): P minus D, guidance success share, points | +1.7 [-2.5, +6.7] (40) | +1.7 [-2.5, +6.7] (40) | not met | not met | stands |
| A14.2 (G): Q minus D, owner's measure, points | -1.5 [-12.3, +7.7] (65) | -1.5 [-12.3, +7.7] (65) | not met | not met | stands |
| A16 (H): QH minus D, guidance success share, points | -1.7 [-5.8, +1.7] (40) | -1.7 [-5.8, +1.7] (40) | not met | not met | stands |
| A17 (G): N minus D, owner's measure, points | -32.3 [-44.6, -20.0] (65) | n/a (0) | not met | - | cannot be read (n < 10 restricted) |
| A17 (G): L minus D, owner's measure, points | -33.8 [-46.2, -21.5] (65) | n/a (0) | not met | - | cannot be read (n < 10 restricted) |
| A18 (G): M minus D, owner's measure, points | +4.6 [-6.2, +16.9] (65) | +4.6 [-6.2, +16.9] (65) | not met | not met | stands |
| A18 (G): M minus D, mean capped, points of 100 | +4.6 [+1.2, +8.5] (65) | +4.6 [+1.2, +8.5] (65) | not met | not met | stands |

Not tested: whether re-running rejected answers under a larger host limit would change any score; whether results delivered in full but near the limit were silently shortened (delivered sizes are measured from the text received); the false-claim and gate conditions of each rule on the restricted questions.
