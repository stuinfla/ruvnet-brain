# Look-1 checks (slice result, not a whole-corpus result; 7 stores, 178 slice questions, 1,617 of 9,029 units)

**(1) Coverage.** "Covered" = EVERY file-gold path has a unit. "Not covered" mixes questions where SOME gold file has a unit and
questions where NONE has. The need index holds only files with a unit, so it can only hit through a covered gold file.
Amateurs (lex10 / lex5+need5 / need10 / lex5+recon5[evolved]): all covered n=43: 8 / 21 / 22 / 25; some covered n=32: 5 / 21 /
23 / 20; none covered n=26: 5 / 4 / **0** / 5. need10 hits where no gold file has a unit: none (no bug). The walk reached 2 such
amateur golds through card sources / package READMEs that have no unit (look1_checks.py).

**(2) Leak audit** (leak-audit-look1.json): for the 29 amateur gains of lex5+need5, the need item that ranked the gold file shares
with the question a longest word run of 1-6 words: 8 words: 0; 5+ words: 4 (G2-12, G2-18, F2-07, G3-18; e.g. "at the end it either
worked or" style phrasing). The extraction prompt (run-extract.mjs) is a fixed text plus the unit text only, `claude -p` with no
tools, no settings, no session; no question set is read. Excluding the 8 G4-flagged questions (2 amateurs): amateurs n=99: lex10 18,
lex5+hist3 17, lex5+need5 46, lex5+recon5[evolved] 50 (unchanged).

**(3) Stability cause.** rUv's `GraphDB` returns a node's outgoing edges in a different order in each process (two runs of the same
query: same seeds and scores, different `connected` order); MRAgent's `tagFanout` cuts that list. Sorting adjacency and ties by node
id (`DETERMINISTIC=1`, frozen genomes unchanged): 192/192 identical in three processes for need, recon-default, recon-evolved. It
changes served first-5 for recon-default 71/192, recon-evolved 23/192, need 0: a new build, look 2 only; those runs were not scored.
