# Shipped 4.7.28 (arm B) at answer level on the G slice questions, one run, information only

Arm B exactly as run on E: shipped server `.claude/plugins/cache/ruvnet-brain/ruvnet-brain/4.7.28/mcp/server.mjs`, self-update timer disabled (RUVNET_CORPUS_CHECK_INTERVAL_MS), same prompt, answerer, blind judge and mechanical caps; other shipped tools denied; stores not opened for writing. One run, answering parallelism 2, hard stop 5:20 a.m. ET. Comparison is arm D run 1 on the same questions. No rule is attached.

Answers completed: 65 of 65; answers joined with a mechanical check and a judge grade: 65.

| measure | arm B (shipped) | arm D run 1 (same questions) | B - D, paired per question [95% bootstrap, 10,000 resamples, seed 20261117], one run, information only |
| --- | --- | --- | --- |
| mean capped score /100 | 56.5 | 69.2 | -12.8 [-18.9, -6.9] (n = 65) |
| share of answers at 8 or above | 30.8% (20/65) | 53.8% (35/65) | -23.1 [-35.4, -10.8] points |
| false claims | 11 of 65 | 5 of 65 | - |
| must-not-claim hits | 1 | 1 | - |
| searches per answer | 4.8 | 2.5 | - |
| answers with a refusal / "insufficient evidence" style reply (pattern match on the answer text, see below) | 53 of 65 | not computed | - |
| answers matching the strict refusal pattern (insufficient / nothing found) | 5 of 65 | not computed | - |
| grounded (mechanical check) | 100.0% (65/65) | - | - |

## Host delivery for the shipped results

| tool results | delivered in full | size error | replaced by file notice | answers with >= 1 undelivered | delivered median chars | rejected median chars |
| --- | --- | --- | --- | --- | --- | --- |
| 312 | 226 | 65 | 21 | 49 of 65 | 19,349 | 69,362 |

Strict pattern: `insufficient evidence|not enough evidence|no (relevant |matching )?(results|evidence|sources) (were )?(found|returned)|nothing (relevant )?(was )?found|(could not|couldn't|did not|didn't) find (any|anything)`; matched ids: G2-12, G2-16, G2-22, G3-02, G3-16.

Broad pattern (matches ordinary hedging such as "could not confirm X"; over-counts refusals) (case-insensitive): `insufficient evidence|not enough evidence|no (relevant |matching )?(results|evidence|sources)|(could not|couldn't|did not|didn't|unable to|cannot|can't) (find|locate|confirm|verify)|not (found )?in the (indexed )?(corpus|knowledge)|nothing (in|about)`. It is a text match, not a judgement; matched ids: G1-02, G1-04, G1-05, G1-06, G1-08, G1-07, G1-09, G1-10, G1-12, G1-11, G1-14, G1-15, G1-16, G1-18, G1-17, G1-19, G1-20, G1-22, G2-04, G1-23, G2-07, G2-08, G2-09, G2-10, G2-12, G2-11, G2-13, G2-14, G2-15, G2-16, G2-19, G2-20, G2-21, G2-22, G2-36, G3-01, G3-02, G2-38, G3-04, G3-05, G3-06, G3-07, G3-08, G3-09, G3-10, G3-11, G3-12, G3-13, G3-16, G3-18, G3-17, G3-20, G3-19.

Not tested: one run only (no run-to-run spread); the shipped server returns different result shapes from arm D, so the difference is not attributable to any single component; answers still in flight at the hard stop are not included.
