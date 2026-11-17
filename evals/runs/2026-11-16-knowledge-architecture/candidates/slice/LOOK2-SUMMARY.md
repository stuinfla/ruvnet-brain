Updated: 2026-11-17 03:20:00 EST | Version 1.0.0
Created: 2026-11-17 03:20:00 EST

# Look 2 (rules judged here, A8.3): slice result, not a whole-corpus result

7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo); 178 slice questions (E 78, F 35, G 65;
101 amateurs); 47 amateurs with a unit for every gold file, 33 for some, 21 for none; coverage 3,264 of 9,029 units (tiers 1 and 2).
Built 3:04-3:18 a.m. ET (load 14-28) with the frozen look-1 settings plus A15 (adjacency and ties sorted by node id).
Full tables: look2-tables.md. Stage 0: stage0-look2.json. Stability: stability-look2.json.

## Stage 0 (look-2 build)
need stored -> own file rank 1: 99.75% (gate 99) pass. Held-out -> own file within 5: 29.9% (gate 90) FAIL; right package within 5:
63.2%. Crate description -> README rank 1: 34.3% of 324 (gate 95) FAIL; package within 5: 42.6%. Capability definition lands and
reaches README: 79.4% (gate 95) FAIL. Centroid first 304 vs nearest cue 472 of 1,927: FAIL. R19a: of 55 problem-only questions,
28 reached; survival among reached content 27, cue 28, max 28. Operator selftest pass; fusion agreement 70/100.
Stability (A5.13): need 100%, walk default 100%, walk evolved 100% (gate 99) PASS.

## Amateurs (n=101), gold file in served result
lex10 18; lex5+hist3 17; lex5+need5 43; lex5+recon5[evolved] 43; lex5+recon5[default] 46; shipped Brain 1.
Every / some / none gold unit: lex10 11/6/1; lex5+need5 24/18/1; lex5+recon5[evolved] 21/20/2; lex5+recon5[default] 23/20/3.
Excluding the 8 G4-flagged questions (99 amateurs): unchanged (18 / 17 / 43 / 43 / 46 / shipped 1).

## Rule lines (numbers; thresholds as written; every line carries the stage-0 failure flag of G1)
- A6.4 need index (R4c): +24.8 points amateurs (43 vs 18), b=26 c=1, p<0.0001; strata build +1, cross 0, design 0, history 0,
  troubleshooting -4, which-tool +28. Thresholds: met numerically. Stage 0 held-out gate failed (29.9%): "build not sound for that
  element" (G1).
- A6.5 / R13 / A7.15 R19 graph walk, evolved (primary): +24.8 points (43 vs 18), b=26 c=1, p<0.0001; both repositories 13/16 vs
  11/16 (+12.5); strata build +5, cross +2, design -1, history 0, troubleshooting -4, which-tool +24. Thresholds: met numerically;
  stability passed; stage-0 crate and capability gates failed (G1 flag).
- A7.17 R21: evolved 43 vs default 46 on amateurs (-3.0): evolved NOT adopted; default settings ship.
- A5.6 tie rule (both pass): need 43, walk evolved 43, walk default 46.
- A7.16 R20 risk (lane alone): lex10 0.396, need5 0.339, recon5 default 0.380, evolved 0.370, shipped 0.375; walk abstained on 0
  answerable and 0 of 14 not-in-corpus.
- A12.21 landing: cues kept (centroids lower on tuning, stage 0 failed).
