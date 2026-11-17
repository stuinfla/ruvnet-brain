# Slice scores (look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run))

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

Cell = questions with a gold item in the served result / questions scored. Systems: lex10 = lexical lane, first 10 files; lex5+hist3 = lexical 5 files + history 3 items; lex5+need5 = lexical 5 + next 5 distinct need-index files; lex5+recon5[g] = lexical 5 + next 5 distinct files of the reconstruction (graph-hop) lane with genome g; need5/10, recon5/10 = the lane alone; shipped = the shipped Brain's returned files (scored only where a shipped result exists: n differs); lex*(7 stores) = sensitivity, lexical lane filtered to the 7 slice stores.

### AMATEURS FIRST: amateur askers, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | all sets (n=101) | E (n=24) | F (n=12) | G (n=65) |
|---|---|---|---|---|
| lex10 | 18/101 (17.8%) | 9/24 (37.5%) | 4/12 (33.3%) | 5/65 (7.7%) |
| lex5+hist3 | 17/101 (16.8%) | 8/24 (33.3%) | 4/12 (33.3%) | 5/65 (7.7%) |
| lex5+need5 | 43/101 (42.6%) | 11/24 (45.8%) | 8/12 (66.7%) | 24/65 (36.9%) |
| need5 | 38/101 (37.6%) | 9/24 (37.5%) | 8/12 (66.7%) | 21/65 (32.3%) |
| need10 | 45/101 (44.6%) | 10/24 (41.7%) | 9/12 (75.0%) | 26/65 (40.0%) |
| lex5+recon5[default] | 46/101 (45.5%) | 16/24 (66.7%) | 9/12 (75.0%) | 21/65 (32.3%) |
| recon5[default] | 41/101 (40.6%) | 15/24 (62.5%) | 8/12 (66.7%) | 18/65 (27.7%) |
| recon10[default] | 42/101 (41.6%) | 16/24 (66.7%) | 8/12 (66.7%) | 18/65 (27.7%) |
| lex5+recon5[evolved] | 43/101 (42.6%) | 14/24 (58.3%) | 9/12 (75.0%) | 20/65 (30.8%) |
| recon5[evolved] | 39/101 (38.6%) | 12/24 (50.0%) | 9/12 (75.0%) | 18/65 (27.7%) |
| recon10[evolved] | 39/101 (38.6%) | 12/24 (50.0%) | 9/12 (75.0%) | 18/65 (27.7%) |
| lex10(7 stores) | 19/101 (18.8%) | 9/24 (37.5%) | 4/12 (33.3%) | 6/65 (9.2%) |
| lex5(7 stores)+need5 | 43/101 (42.6%) | 11/24 (45.8%) | 8/12 (66.7%) | 24/65 (36.9%) |
| shipped | 1/101 (1.0%) | 1/24 (4.2%) | 0/12 (0.0%) | 0/65 (0.0%) |

### A14.1 PACKAGE-LEVEL hit (descriptive, no rule): amateurs, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | all sets (n=101) | E (n=24) | F (n=12) | G (n=65) |
|---|---|---|---|---|
| lex10 | 38/101 (37.6%) | 15/24 (62.5%) | 6/12 (50.0%) | 17/65 (26.2%) |
| lex5+hist3 | 29/101 (28.7%) | 13/24 (54.2%) | 5/12 (41.7%) | 11/65 (16.9%) |
| lex5+need5 | 59/101 (58.4%) | 19/24 (79.2%) | 9/12 (75.0%) | 31/65 (47.7%) |
| need5 | 55/101 (54.5%) | 17/24 (70.8%) | 9/12 (75.0%) | 29/65 (44.6%) |
| need10 | 65/101 (64.4%) | 17/24 (70.8%) | 11/12 (91.7%) | 37/65 (56.9%) |
| lex5+recon5[default] | 62/101 (61.4%) | 20/24 (83.3%) | 10/12 (83.3%) | 32/65 (49.2%) |
| recon5[default] | 56/101 (55.4%) | 18/24 (75.0%) | 9/12 (75.0%) | 29/65 (44.6%) |
| recon10[default] | 59/101 (58.4%) | 20/24 (83.3%) | 10/12 (83.3%) | 29/65 (44.6%) |
| lex5+recon5[evolved] | 64/101 (63.4%) | 21/24 (87.5%) | 11/12 (91.7%) | 32/65 (49.2%) |
| recon5[evolved] | 59/101 (58.4%) | 19/24 (79.2%) | 11/12 (91.7%) | 29/65 (44.6%) |
| recon10[evolved] | 59/101 (58.4%) | 19/24 (79.2%) | 11/12 (91.7%) | 29/65 (44.6%) |
| lex10(7 stores) | 42/101 (41.6%) | 16/24 (66.7%) | 6/12 (50.0%) | 20/65 (30.8%) |
| lex5(7 stores)+need5 | 61/101 (60.4%) | 19/24 (79.2%) | 9/12 (75.0%) | 33/65 (50.8%) |
| shipped | 9/101 (8.9%) | 2/24 (8.3%) | 3/12 (25.0%) | 4/65 (6.2%) |

### A14.1 PACKAGE-LEVEL hit (descriptive): all askers, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | all (n=178) | E (n=78) | F (n=35) | G (n=65) |
|---|---|---|---|---|
| lex10 | 108/178 (60.7%) | 66/78 (84.6%) | 25/35 (71.4%) | 17/65 (26.2%) |
| lex5+hist3 | 95/178 (53.4%) | 60/78 (76.9%) | 24/35 (68.6%) | 11/65 (16.9%) |
| lex5+need5 | 131/178 (73.6%) | 69/78 (88.5%) | 31/35 (88.6%) | 31/65 (47.7%) |
| need5 | 107/178 (60.1%) | 51/78 (65.4%) | 27/35 (77.1%) | 29/65 (44.6%) |
| need10 | 125/178 (70.2%) | 57/78 (73.1%) | 31/35 (88.6%) | 37/65 (56.9%) |
| lex5+recon5[default] | 134/178 (75.3%) | 70/78 (89.7%) | 32/35 (91.4%) | 32/65 (49.2%) |
| recon5[default] | 103/178 (57.9%) | 52/78 (66.7%) | 22/35 (62.9%) | 29/65 (44.6%) |
| recon10[default] | 109/178 (61.2%) | 56/78 (71.8%) | 24/35 (68.6%) | 29/65 (44.6%) |
| lex5+recon5[evolved] | 135/178 (75.8%) | 71/78 (91.0%) | 32/35 (91.4%) | 32/65 (49.2%) |
| recon5[evolved] | 109/178 (61.2%) | 55/78 (70.5%) | 25/35 (71.4%) | 29/65 (44.6%) |
| recon10[evolved] | 109/178 (61.2%) | 55/78 (70.5%) | 25/35 (71.4%) | 29/65 (44.6%) |
| lex10(7 stores) | 114/178 (64.0%) | 68/78 (87.2%) | 26/35 (74.3%) | 20/65 (30.8%) |
| lex5(7 stores)+need5 | 133/178 (74.7%) | 69/78 (88.5%) | 31/35 (88.6%) | 33/65 (50.8%) |
| shipped | 32/178 (18.0%) | 17/78 (21.8%) | 11/35 (31.4%) | 4/65 (6.2%) |

### A15: amateurs split by coverage (every / some / no gold file has a unit)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | every (n=47) | some (n=33) | none (n=21) |
|---|---|---|---|
| lex10 | 11/47 (23.4%) | 6/33 (18.2%) | 1/21 (4.8%) |
| lex5+hist3 | 10/47 (21.3%) | 6/33 (18.2%) | 1/21 (4.8%) |
| lex5+need5 | 24/47 (51.1%) | 18/33 (54.5%) | 1/21 (4.8%) |
| need5 | 22/47 (46.8%) | 16/33 (48.5%) | 0/21 (0.0%) |
| need10 | 24/47 (51.1%) | 21/33 (63.6%) | 0/21 (0.0%) |
| lex5+recon5[default] | 23/47 (48.9%) | 20/33 (60.6%) | 3/21 (14.3%) |
| recon5[default] | 19/47 (40.4%) | 20/33 (60.6%) | 2/21 (9.5%) |
| recon10[default] | 19/47 (40.4%) | 21/33 (63.6%) | 2/21 (9.5%) |
| lex5+recon5[evolved] | 21/47 (44.7%) | 20/33 (60.6%) | 2/21 (9.5%) |
| recon5[evolved] | 19/47 (40.4%) | 19/33 (57.6%) | 1/21 (4.8%) |
| recon10[evolved] | 19/47 (40.4%) | 19/33 (57.6%) | 1/21 (4.8%) |
| lex10(7 stores) | 12/47 (25.5%) | 6/33 (18.2%) | 1/21 (4.8%) |
| lex5(7 stores)+need5 | 24/47 (51.1%) | 18/33 (54.5%) | 1/21 (4.8%) |
| shipped | 1/47 (2.1%) | 0/33 (0.0%) | 0/21 (0.0%) |

### All askers, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | all (n=178) | E (n=78) | F (n=35) | G (n=65) |
|---|---|---|---|---|
| lex10 | 76/178 (42.7%) | 50/78 (64.1%) | 21/35 (60.0%) | 5/65 (7.7%) |
| lex5+hist3 | 68/178 (38.2%) | 45/78 (57.7%) | 18/35 (51.4%) | 5/65 (7.7%) |
| lex5+need5 | 101/178 (56.7%) | 50/78 (64.1%) | 27/35 (77.1%) | 24/65 (36.9%) |
| need5 | 65/178 (36.5%) | 23/78 (29.5%) | 21/35 (60.0%) | 21/65 (32.3%) |
| need10 | 77/178 (43.3%) | 28/78 (35.9%) | 23/35 (65.7%) | 26/65 (40.0%) |
| lex5+recon5[default] | 108/178 (60.7%) | 59/78 (75.6%) | 28/35 (80.0%) | 21/65 (32.3%) |
| recon5[default] | 73/178 (41.0%) | 35/78 (44.9%) | 20/35 (57.1%) | 18/65 (27.7%) |
| recon10[default] | 77/178 (43.3%) | 39/78 (50.0%) | 20/35 (57.1%) | 18/65 (27.7%) |
| lex5+recon5[evolved] | 102/178 (57.3%) | 54/78 (69.2%) | 28/35 (80.0%) | 20/65 (30.8%) |
| recon5[evolved] | 71/178 (39.9%) | 33/78 (42.3%) | 20/35 (57.1%) | 18/65 (27.7%) |
| recon10[evolved] | 71/178 (39.9%) | 33/78 (42.3%) | 20/35 (57.1%) | 18/65 (27.7%) |
| lex10(7 stores) | 78/178 (43.8%) | 51/78 (65.4%) | 21/35 (60.0%) | 6/65 (9.2%) |
| lex5(7 stores)+need5 | 103/178 (57.9%) | 51/78 (65.4%) | 28/35 (80.0%) | 24/65 (36.9%) |
| shipped | 8/178 (4.5%) | 4/78 (5.1%) | 4/35 (11.4%) | 0/65 (0.0%) |

### By asker

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | amateur (n=101) | practitioner (n=46) | expert (n=31) |
|---|---|---|---|
| lex10 | 18/101 (17.8%) | 33/46 (71.7%) | 25/31 (80.6%) |
| lex5+hist3 | 17/101 (16.8%) | 29/46 (63.0%) | 22/31 (71.0%) |
| lex5+need5 | 43/101 (42.6%) | 32/46 (69.6%) | 26/31 (83.9%) |
| need5 | 38/101 (37.6%) | 14/46 (30.4%) | 13/31 (41.9%) |
| need10 | 45/101 (44.6%) | 16/46 (34.8%) | 16/31 (51.6%) |
| lex5+recon5[default] | 46/101 (45.5%) | 36/46 (78.3%) | 26/31 (83.9%) |
| recon5[default] | 41/101 (40.6%) | 18/46 (39.1%) | 14/31 (45.2%) |
| recon10[default] | 42/101 (41.6%) | 19/46 (41.3%) | 16/31 (51.6%) |
| lex5+recon5[evolved] | 43/101 (42.6%) | 34/46 (73.9%) | 25/31 (80.6%) |
| recon5[evolved] | 39/101 (38.6%) | 19/46 (41.3%) | 13/31 (41.9%) |
| recon10[evolved] | 39/101 (38.6%) | 19/46 (41.3%) | 13/31 (41.9%) |
| lex10(7 stores) | 19/101 (18.8%) | 33/46 (71.7%) | 26/31 (83.9%) |
| lex5(7 stores)+need5 | 43/101 (42.6%) | 33/46 (71.7%) | 27/31 (87.1%) |
| shipped | 1/101 (1.0%) | 2/46 (4.3%) | 5/31 (16.1%) |

### By stratum

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | build-task (n=20) | cross-repo (n=16) | design-rationale (n=27) | history (n=1) | troubleshooting (n=24) | which-tool (n=90) |
|---|---|---|---|---|---|---|
| lex10 | 3/20 (15.0%) | 10/16 (62.5%) | 25/27 (92.6%) | 0/1 (0.0%) | 14/24 (58.3%) | 24/90 (26.7%) |
| lex5+hist3 | 3/20 (15.0%) | 10/16 (62.5%) | 21/27 (77.8%) | 0/1 (0.0%) | 10/24 (41.7%) | 24/90 (26.7%) |
| lex5+need5 | 4/20 (20.0%) | 10/16 (62.5%) | 25/27 (92.6%) | 0/1 (0.0%) | 10/24 (41.7%) | 52/90 (57.8%) |
| need5 | 2/20 (10.0%) | 2/16 (12.5%) | 14/27 (51.9%) | 0/1 (0.0%) | 2/24 (8.3%) | 45/90 (50.0%) |
| need10 | 4/20 (20.0%) | 5/16 (31.2%) | 17/27 (63.0%) | 0/1 (0.0%) | 2/24 (8.3%) | 49/90 (54.4%) |
| lex5+recon5[default] | 6/20 (30.0%) | 13/16 (81.2%) | 24/27 (88.9%) | 0/1 (0.0%) | 11/24 (45.8%) | 54/90 (60.0%) |
| recon5[default] | 4/20 (20.0%) | 4/16 (25.0%) | 14/27 (51.9%) | 0/1 (0.0%) | 4/24 (16.7%) | 47/90 (52.2%) |
| recon10[default] | 4/20 (20.0%) | 5/16 (31.2%) | 15/27 (55.6%) | 0/1 (0.0%) | 5/24 (20.8%) | 48/90 (53.3%) |
| lex5+recon5[evolved] | 8/20 (40.0%) | 12/16 (75.0%) | 24/27 (88.9%) | 0/1 (0.0%) | 10/24 (41.7%) | 48/90 (53.3%) |
| recon5[evolved] | 5/20 (25.0%) | 5/16 (31.2%) | 15/27 (55.6%) | 0/1 (0.0%) | 3/24 (12.5%) | 43/90 (47.8%) |
| recon10[evolved] | 5/20 (25.0%) | 5/16 (31.2%) | 15/27 (55.6%) | 0/1 (0.0%) | 3/24 (12.5%) | 43/90 (47.8%) |
| lex10(7 stores) | 3/20 (15.0%) | 11/16 (68.8%) | 25/27 (92.6%) | 0/1 (0.0%) | 14/24 (58.3%) | 25/90 (27.8%) |
| lex5(7 stores)+need5 | 4/20 (20.0%) | 10/16 (62.5%) | 25/27 (92.6%) | 0/1 (0.0%) | 12/24 (50.0%) | 52/90 (57.8%) |
| shipped | 0/20 (0.0%) | 1/16 (6.2%) | 4/27 (14.8%) | 0/1 (0.0%) | 3/24 (12.5%) | 0/90 (0.0%) |

### A15: all askers split by coverage (every / some / no gold file has a unit)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | every (n=74) | some (n=57) | none (n=47) |
|---|---|---|---|
| lex10 | 33/74 (44.6%) | 23/57 (40.4%) | 20/47 (42.6%) |
| lex5+hist3 | 29/74 (39.2%) | 23/57 (40.4%) | 16/47 (34.0%) |
| lex5+need5 | 49/74 (66.2%) | 36/57 (63.2%) | 16/47 (34.0%) |
| need5 | 41/74 (55.4%) | 24/57 (42.1%) | 0/47 (0.0%) |
| need10 | 45/74 (60.8%) | 32/57 (56.1%) | 0/47 (0.0%) |
| lex5+recon5[default] | 47/74 (63.5%) | 41/57 (71.9%) | 20/47 (42.6%) |
| recon5[default] | 39/74 (52.7%) | 28/57 (49.1%) | 6/47 (12.8%) |
| recon10[default] | 39/74 (52.7%) | 29/57 (50.9%) | 9/47 (19.1%) |
| lex5+recon5[evolved] | 45/74 (60.8%) | 39/57 (68.4%) | 18/47 (38.3%) |
| recon5[evolved] | 38/74 (51.4%) | 28/57 (49.1%) | 5/47 (10.6%) |
| recon10[evolved] | 38/74 (51.4%) | 28/57 (49.1%) | 5/47 (10.6%) |
| lex10(7 stores) | 34/74 (45.9%) | 23/57 (40.4%) | 21/47 (44.7%) |
| lex5(7 stores)+need5 | 49/74 (66.2%) | 36/57 (63.2%) | 18/47 (38.3%) |
| shipped | 5/74 (6.8%) | 0/57 (0.0%) | 3/47 (6.4%) |

### Both repositories present, cross-repo slice questions with gold in 2+ repositories (n=16)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| system | both present |
|---|---|
| lex10 | 11/16 |
| lex5+hist3 | 9/16 |
| lex5+need5 | 11/16 |
| need5 | 7/16 |
| need10 | 13/16 |
| lex5+recon5[default] | 14/16 |
| recon5[default] | 8/16 |
| recon10[default] | 9/16 |
| lex5+recon5[evolved] | 13/16 |
| recon5[evolved] | 10/16 |
| recon10[evolved] | 10/16 |
| lex10(7 stores) | 14/16 |
| lex5(7 stores)+need5 | 12/16 |
| shipped | 1/16 |

### Paired exact McNemar (b = treatment hit, control miss; c = reverse; two-sided)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| comparison | group | n | treatment | control | b | c | p |
|---|---|---|---|---|---|---|---|
| lex5+need5 vs lex10 | amateurs | 101 | 43 | 18 | 26 | 1 | 0.0000 |
| lex5+need5 vs lex10 | all | 178 | 101 | 76 | 31 | 6 | 0.0000 |
| lex5+recon5[default] vs lex10 | amateurs | 101 | 46 | 18 | 28 | 0 | 0.0000 |
| lex5+recon5[default] vs lex10 | all | 178 | 108 | 76 | 36 | 4 | 0.0000 |
| lex5+recon5[evolved] vs lex10 | amateurs | 101 | 43 | 18 | 26 | 1 | 0.0000 |
| lex5+recon5[evolved] vs lex10 | all | 178 | 102 | 76 | 32 | 6 | 0.0000 |
| lex5+need5 vs lex5+hist3 | amateurs | 101 | 43 | 17 | 26 | 0 | 0.0000 |
| lex5+need5 vs lex5+hist3 | all | 178 | 101 | 68 | 33 | 0 | 0.0000 |
| lex5+recon5[default] vs lex5+hist3 | amateurs | 101 | 46 | 17 | 29 | 0 | 0.0000 |
| lex5+recon5[default] vs lex5+hist3 | all | 178 | 108 | 68 | 40 | 0 | 0.0000 |
| lex5+recon5[evolved] vs lex5+hist3 | amateurs | 101 | 43 | 17 | 26 | 0 | 0.0000 |
| lex5+recon5[evolved] vs lex5+hist3 | all | 178 | 102 | 68 | 34 | 0 | 0.0000 |
| lex5+need5 vs shipped | amateurs | 101 | 43 | 1 | 42 | 0 | 0.0000 |
| lex5+need5 vs shipped | all | 178 | 101 | 8 | 94 | 1 | 0.0000 |
| lex5+recon5[default] vs shipped | amateurs | 101 | 46 | 1 | 45 | 0 | 0.0000 |
| lex5+recon5[default] vs shipped | all | 178 | 108 | 8 | 101 | 1 | 0.0000 |
| lex5+recon5[evolved] vs shipped | amateurs | 101 | 43 | 1 | 42 | 0 | 0.0000 |
| lex5+recon5[evolved] vs shipped | all | 178 | 102 | 8 | 95 | 1 | 0.0000 |

### Rule lines (numbers only)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

- lex5+need5 vs lex10, A6.4 / A5.4 (R4c): +10 points amateurs, exact McNemar p < 0.05, no stratum down 5 or more questions: amateurs 43/101 vs 18/101 = +24.8 points, b=26 c=1 p=0.0000; per-stratum change in questions: build-task +1, cross-repo +0, design-rationale +0, history +0, troubleshooting -4, which-tool +28; both repositories present on cross-repo 11/16 vs 11/16 = +0.0 points
- lex5+recon5[evolved] vs lex10, A6.5 / A5.6 (R13) and A7.15 (R19): +10 points amateurs, p < 0.05, both-repositories +10 points on cross-repo, no stratum down 5 or more: amateurs 43/101 vs 18/101 = +24.8 points, b=26 c=1 p=0.0000; per-stratum change in questions: build-task +5, cross-repo +2, design-rationale -1, history +0, troubleshooting -4, which-tool +24; both repositories present on cross-repo 13/16 vs 11/16 = +12.5 points
- A7.17 (R21) evolved vs default on amateurs: lex5+recon5[evolved] 43/101 vs lex5+recon5[default] 46/101 = -3.0 points (rule: evolved adopted at +5)

### Abstention and risk-adjusted utility (A7.16 / R20); lane alone, its own section

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 74 with a unit for (every) gold file; look 2 (rules judged here; A15 deterministic order; stage 0 per FROZEN look-2 run), coverage 3264 units of 9029_

| lane | answerable n | gold served | abstained (wrong abstain) | served without gold | not-in-corpus n | abstained there | risk score |
|---|---|---|---|---|---|---|---|
| lex10 | 178 | 76 | 0 | 102 | 14 | 0 | 0.396 |
| need5 | 178 | 65 | 0 | 113 | 14 | 0 | 0.339 |
| recon5[default] | 178 | 73 | 0 | 105 | 14 | 0 | 0.380 |
| recon5[evolved] | 178 | 71 | 0 | 107 | 14 | 0 | 0.370 |
| shipped | 178 | 8 | 126 | 44 | 14 | 1 | 0.375 |
