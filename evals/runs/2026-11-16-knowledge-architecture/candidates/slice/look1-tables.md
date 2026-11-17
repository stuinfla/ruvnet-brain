# Slice scores (look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged))

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

Cell = questions with a gold item in the served result / questions scored. Systems: lex10 = lexical lane, first 10 files; lex5+hist3 = lexical 5 files + history 3 items; lex5+need5 = lexical 5 + next 5 distinct need-index files; lex5+recon5[g] = lexical 5 + next 5 distinct files of the reconstruction (graph-hop) lane with genome g; need5/10, recon5/10 = the lane alone; shipped = the shipped Brain's returned files (scored only where a shipped result exists: n differs); lex*(7 stores) = sensitivity, lexical lane filtered to the 7 slice stores.

### AMATEURS FIRST: amateur askers, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | all sets (n=101) | E (n=24) | F (n=12) | G (n=65) |
|---|---|---|---|---|
| lex10 | 18/101 (17.8%) | 9/24 (37.5%) | 4/12 (33.3%) | 5/65 (7.7%) |
| lex5+hist3 | 17/101 (16.8%) | 8/24 (33.3%) | 4/12 (33.3%) | 5/65 (7.7%) |
| lex5+need5 | 46/101 (45.5%) | 10/24 (41.7%) | 8/12 (66.7%) | 28/65 (43.1%) |
| need5 | 38/101 (37.6%) | 5/24 (20.8%) | 8/12 (66.7%) | 25/65 (38.5%) |
| need10 | 45/101 (44.6%) | 7/24 (29.2%) | 9/12 (75.0%) | 29/65 (44.6%) |
| lex5+recon5[default] | 45/101 (44.6%) | 15/24 (62.5%) | 9/12 (75.0%) | 21/65 (32.3%) |
| recon5[default] | 38/101 (37.6%) | 12/24 (50.0%) | 8/12 (66.7%) | 18/65 (27.7%) |
| recon10[default] | 41/101 (40.6%) | 14/24 (58.3%) | 8/12 (66.7%) | 19/65 (29.2%) |
| lex5+recon5[evolved] | 50/101 (49.5%) | 14/24 (58.3%) | 8/12 (66.7%) | 28/65 (43.1%) |
| recon5[evolved] | 44/101 (43.6%) | 10/24 (41.7%) | 8/12 (66.7%) | 26/65 (40.0%) |
| recon10[evolved] | 44/101 (43.6%) | 10/24 (41.7%) | 8/12 (66.7%) | 26/65 (40.0%) |
| lex10(7 stores) | 19/101 (18.8%) | 9/24 (37.5%) | 4/12 (33.3%) | 6/65 (9.2%) |
| lex5(7 stores)+need5 | 46/101 (45.5%) | 10/24 (41.7%) | 8/12 (66.7%) | 28/65 (43.1%) |
| shipped | 1/101 (1.0%) | 1/24 (4.2%) | 0/12 (0.0%) | 0/65 (0.0%) |

### A14.1 PACKAGE-LEVEL hit (descriptive, no rule): amateurs, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | all sets (n=101) | E (n=24) | F (n=12) | G (n=65) |
|---|---|---|---|---|
| lex10 | 38/101 (37.6%) | 15/24 (62.5%) | 6/12 (50.0%) | 17/65 (26.2%) |
| lex5+hist3 | 29/101 (28.7%) | 13/24 (54.2%) | 5/12 (41.7%) | 11/65 (16.9%) |
| lex5+need5 | 67/101 (66.3%) | 19/24 (79.2%) | 9/12 (75.0%) | 39/65 (60.0%) |
| need5 | 58/101 (57.4%) | 12/24 (50.0%) | 9/12 (75.0%) | 37/65 (56.9%) |
| need10 | 70/101 (69.3%) | 15/24 (62.5%) | 12/12 (100.0%) | 43/65 (66.2%) |
| lex5+recon5[default] | 66/101 (65.3%) | 22/24 (91.7%) | 10/12 (83.3%) | 34/65 (52.3%) |
| recon5[default] | 58/101 (57.4%) | 18/24 (75.0%) | 9/12 (75.0%) | 31/65 (47.7%) |
| recon10[default] | 59/101 (58.4%) | 18/24 (75.0%) | 10/12 (83.3%) | 31/65 (47.7%) |
| lex5+recon5[evolved] | 73/101 (72.3%) | 21/24 (87.5%) | 10/12 (83.3%) | 42/65 (64.6%) |
| recon5[evolved] | 65/101 (64.4%) | 16/24 (66.7%) | 10/12 (83.3%) | 39/65 (60.0%) |
| recon10[evolved] | 65/101 (64.4%) | 16/24 (66.7%) | 10/12 (83.3%) | 39/65 (60.0%) |
| lex10(7 stores) | 42/101 (41.6%) | 16/24 (66.7%) | 6/12 (50.0%) | 20/65 (30.8%) |
| lex5(7 stores)+need5 | 67/101 (66.3%) | 19/24 (79.2%) | 9/12 (75.0%) | 39/65 (60.0%) |
| shipped | 9/101 (8.9%) | 2/24 (8.3%) | 3/12 (25.0%) | 4/65 (6.2%) |

### A14.1 PACKAGE-LEVEL hit (descriptive): all askers, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | all (n=178) | E (n=78) | F (n=35) | G (n=65) |
|---|---|---|---|---|
| lex10 | 108/178 (60.7%) | 66/78 (84.6%) | 25/35 (71.4%) | 17/65 (26.2%) |
| lex5+hist3 | 95/178 (53.4%) | 60/78 (76.9%) | 24/35 (68.6%) | 11/65 (16.9%) |
| lex5+need5 | 140/178 (78.7%) | 70/78 (89.7%) | 31/35 (88.6%) | 39/65 (60.0%) |
| need5 | 103/178 (57.9%) | 46/78 (59.0%) | 20/35 (57.1%) | 37/65 (56.9%) |
| need10 | 121/178 (68.0%) | 54/78 (69.2%) | 24/35 (68.6%) | 43/65 (66.2%) |
| lex5+recon5[default] | 138/178 (77.5%) | 72/78 (92.3%) | 32/35 (91.4%) | 34/65 (52.3%) |
| recon5[default] | 107/178 (60.1%) | 53/78 (67.9%) | 23/35 (65.7%) | 31/65 (47.7%) |
| recon10[default] | 111/178 (62.4%) | 55/78 (70.5%) | 25/35 (71.4%) | 31/65 (47.7%) |
| lex5+recon5[evolved] | 144/178 (80.9%) | 71/78 (91.0%) | 31/35 (88.6%) | 42/65 (64.6%) |
| recon5[evolved] | 114/178 (64.0%) | 53/78 (67.9%) | 22/35 (62.9%) | 39/65 (60.0%) |
| recon10[evolved] | 114/178 (64.0%) | 53/78 (67.9%) | 22/35 (62.9%) | 39/65 (60.0%) |
| lex10(7 stores) | 114/178 (64.0%) | 68/78 (87.2%) | 26/35 (74.3%) | 20/65 (30.8%) |
| lex5(7 stores)+need5 | 140/178 (78.7%) | 70/78 (89.7%) | 31/35 (88.6%) | 39/65 (60.0%) |
| shipped | 32/178 (18.0%) | 17/78 (21.8%) | 11/35 (31.4%) | 4/65 (6.2%) |

### A15: amateurs split by coverage (every / some / no gold file has a unit)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | every (n=43) | some (n=32) | none (n=26) |
|---|---|---|---|
| lex10 | 8/43 (18.6%) | 5/32 (15.6%) | 5/26 (19.2%) |
| lex5+hist3 | 8/43 (18.6%) | 5/32 (15.6%) | 4/26 (15.4%) |
| lex5+need5 | 21/43 (48.8%) | 21/32 (65.6%) | 4/26 (15.4%) |
| need5 | 19/43 (44.2%) | 19/32 (59.4%) | 0/26 (0.0%) |
| need10 | 22/43 (51.2%) | 23/32 (71.9%) | 0/26 (0.0%) |
| lex5+recon5[default] | 20/43 (46.5%) | 20/32 (62.5%) | 5/26 (19.2%) |
| recon5[default] | 16/43 (37.2%) | 20/32 (62.5%) | 2/26 (7.7%) |
| recon10[default] | 16/43 (37.2%) | 20/32 (62.5%) | 5/26 (19.2%) |
| lex5+recon5[evolved] | 25/43 (58.1%) | 20/32 (62.5%) | 5/26 (19.2%) |
| recon5[evolved] | 23/43 (53.5%) | 19/32 (59.4%) | 2/26 (7.7%) |
| recon10[evolved] | 23/43 (53.5%) | 19/32 (59.4%) | 2/26 (7.7%) |
| lex10(7 stores) | 9/43 (20.9%) | 5/32 (15.6%) | 5/26 (19.2%) |
| lex5(7 stores)+need5 | 21/43 (48.8%) | 21/32 (65.6%) | 4/26 (15.4%) |
| shipped | 0/43 (0.0%) | 0/32 (0.0%) | 1/26 (3.8%) |

### All askers, by set

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | all (n=178) | E (n=78) | F (n=35) | G (n=65) |
|---|---|---|---|---|
| lex10 | 76/178 (42.7%) | 50/78 (64.1%) | 21/35 (60.0%) | 5/65 (7.7%) |
| lex5+hist3 | 68/178 (38.2%) | 45/78 (57.7%) | 18/35 (51.4%) | 5/65 (7.7%) |
| lex5+need5 | 101/178 (56.7%) | 48/78 (61.5%) | 25/35 (71.4%) | 28/65 (43.1%) |
| need5 | 56/178 (31.5%) | 16/78 (20.5%) | 15/35 (42.9%) | 25/65 (38.5%) |
| need10 | 64/178 (36.0%) | 19/78 (24.4%) | 16/35 (45.7%) | 29/65 (44.6%) |
| lex5+recon5[default] | 106/178 (59.6%) | 58/78 (74.4%) | 27/35 (77.1%) | 21/65 (32.3%) |
| recon5[default] | 65/178 (36.5%) | 30/78 (38.5%) | 17/35 (48.6%) | 18/65 (27.7%) |
| recon10[default] | 71/178 (39.9%) | 34/78 (43.6%) | 18/35 (51.4%) | 19/65 (29.2%) |
| lex5+recon5[evolved] | 108/178 (60.7%) | 56/78 (71.8%) | 24/35 (68.6%) | 28/65 (43.1%) |
| recon5[evolved] | 71/178 (39.9%) | 30/78 (38.5%) | 15/35 (42.9%) | 26/65 (40.0%) |
| recon10[evolved] | 71/178 (39.9%) | 30/78 (38.5%) | 15/35 (42.9%) | 26/65 (40.0%) |
| lex10(7 stores) | 78/178 (43.8%) | 51/78 (65.4%) | 21/35 (60.0%) | 6/65 (9.2%) |
| lex5(7 stores)+need5 | 103/178 (57.9%) | 49/78 (62.8%) | 26/35 (74.3%) | 28/65 (43.1%) |
| shipped | 8/178 (4.5%) | 4/78 (5.1%) | 4/35 (11.4%) | 0/65 (0.0%) |

### By asker

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | amateur (n=101) | practitioner (n=46) | expert (n=31) |
|---|---|---|---|
| lex10 | 18/101 (17.8%) | 33/46 (71.7%) | 25/31 (80.6%) |
| lex5+hist3 | 17/101 (16.8%) | 29/46 (63.0%) | 22/31 (71.0%) |
| lex5+need5 | 46/101 (45.5%) | 31/46 (67.4%) | 24/31 (77.4%) |
| need5 | 38/101 (37.6%) | 10/46 (21.7%) | 8/31 (25.8%) |
| need10 | 45/101 (44.6%) | 11/46 (23.9%) | 8/31 (25.8%) |
| lex5+recon5[default] | 45/101 (44.6%) | 34/46 (73.9%) | 27/31 (87.1%) |
| recon5[default] | 38/101 (37.6%) | 15/46 (32.6%) | 12/31 (38.7%) |
| recon10[default] | 41/101 (40.6%) | 16/46 (34.8%) | 14/31 (45.2%) |
| lex5+recon5[evolved] | 50/101 (49.5%) | 34/46 (73.9%) | 24/31 (77.4%) |
| recon5[evolved] | 44/101 (43.6%) | 16/46 (34.8%) | 11/31 (35.5%) |
| recon10[evolved] | 44/101 (43.6%) | 16/46 (34.8%) | 11/31 (35.5%) |
| lex10(7 stores) | 19/101 (18.8%) | 33/46 (71.7%) | 26/31 (83.9%) |
| lex5(7 stores)+need5 | 46/101 (45.5%) | 32/46 (69.6%) | 25/31 (80.6%) |
| shipped | 1/101 (1.0%) | 2/46 (4.3%) | 5/31 (16.1%) |

### By stratum

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | build-task (n=20) | cross-repo (n=16) | design-rationale (n=27) | history (n=1) | troubleshooting (n=24) | which-tool (n=90) |
|---|---|---|---|---|---|---|
| lex10 | 3/20 (15.0%) | 10/16 (62.5%) | 25/27 (92.6%) | 0/1 (0.0%) | 14/24 (58.3%) | 24/90 (26.7%) |
| lex5+hist3 | 3/20 (15.0%) | 10/16 (62.5%) | 21/27 (77.8%) | 0/1 (0.0%) | 10/24 (41.7%) | 24/90 (26.7%) |
| lex5+need5 | 6/20 (30.0%) | 10/16 (62.5%) | 21/27 (77.8%) | 0/1 (0.0%) | 10/24 (41.7%) | 54/90 (60.0%) |
| need5 | 4/20 (20.0%) | 1/16 (6.2%) | 4/27 (14.8%) | 0/1 (0.0%) | 0/24 (0.0%) | 47/90 (52.2%) |
| need10 | 5/20 (25.0%) | 1/16 (6.2%) | 4/27 (14.8%) | 0/1 (0.0%) | 0/24 (0.0%) | 54/90 (60.0%) |
| lex5+recon5[default] | 7/20 (35.0%) | 11/16 (68.8%) | 23/27 (85.2%) | 0/1 (0.0%) | 12/24 (50.0%) | 53/90 (58.9%) |
| recon5[default] | 5/20 (25.0%) | 1/16 (6.2%) | 10/27 (37.0%) | 0/1 (0.0%) | 3/24 (12.5%) | 46/90 (51.1%) |
| recon10[default] | 5/20 (25.0%) | 2/16 (12.5%) | 12/27 (44.4%) | 0/1 (0.0%) | 3/24 (12.5%) | 49/90 (54.4%) |
| lex5+recon5[evolved] | 10/20 (50.0%) | 12/16 (75.0%) | 22/27 (81.5%) | 0/1 (0.0%) | 11/24 (45.8%) | 53/90 (58.9%) |
| recon5[evolved] | 7/20 (35.0%) | 3/16 (18.8%) | 12/27 (44.4%) | 0/1 (0.0%) | 2/24 (8.3%) | 47/90 (52.2%) |
| recon10[evolved] | 7/20 (35.0%) | 3/16 (18.8%) | 12/27 (44.4%) | 0/1 (0.0%) | 2/24 (8.3%) | 47/90 (52.2%) |
| lex10(7 stores) | 3/20 (15.0%) | 11/16 (68.8%) | 25/27 (92.6%) | 0/1 (0.0%) | 14/24 (58.3%) | 25/90 (27.8%) |
| lex5(7 stores)+need5 | 6/20 (30.0%) | 10/16 (62.5%) | 21/27 (77.8%) | 0/1 (0.0%) | 12/24 (50.0%) | 54/90 (60.0%) |
| shipped | 0/20 (0.0%) | 1/16 (6.2%) | 4/27 (14.8%) | 0/1 (0.0%) | 3/24 (12.5%) | 0/90 (0.0%) |

### A15: all askers split by coverage (every / some / no gold file has a unit)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | every (n=57) | some (n=49) | none (n=72) |
|---|---|---|---|
| lex10 | 18/57 (31.6%) | 17/49 (34.7%) | 41/72 (56.9%) |
| lex5+hist3 | 17/57 (29.8%) | 17/49 (34.7%) | 34/72 (47.2%) |
| lex5+need5 | 33/57 (57.9%) | 34/49 (69.4%) | 34/72 (47.2%) |
| need5 | 29/57 (50.9%) | 27/49 (55.1%) | 0/72 (0.0%) |
| need10 | 32/57 (56.1%) | 32/49 (65.3%) | 0/72 (0.0%) |
| lex5+recon5[default] | 33/57 (57.9%) | 34/49 (69.4%) | 39/72 (54.2%) |
| recon5[default] | 27/57 (47.4%) | 27/49 (55.1%) | 11/72 (15.3%) |
| recon10[default] | 27/57 (47.4%) | 27/49 (55.1%) | 17/72 (23.6%) |
| lex5+recon5[evolved] | 36/57 (63.2%) | 33/49 (67.3%) | 39/72 (54.2%) |
| recon5[evolved] | 32/57 (56.1%) | 26/49 (53.1%) | 13/72 (18.1%) |
| recon10[evolved] | 32/57 (56.1%) | 26/49 (53.1%) | 13/72 (18.1%) |
| lex10(7 stores) | 19/57 (33.3%) | 17/49 (34.7%) | 42/72 (58.3%) |
| lex5(7 stores)+need5 | 33/57 (57.9%) | 34/49 (69.4%) | 36/72 (50.0%) |
| shipped | 1/57 (1.8%) | 0/49 (0.0%) | 7/72 (9.7%) |

### Both repositories present, cross-repo slice questions with gold in 2+ repositories (n=16)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| system | both present |
|---|---|
| lex10 | 11/16 |
| lex5+hist3 | 9/16 |
| lex5+need5 | 15/16 |
| need5 | 9/16 |
| need10 | 11/16 |
| lex5+recon5[default] | 16/16 |
| recon5[default] | 7/16 |
| recon10[default] | 7/16 |
| lex5+recon5[evolved] | 14/16 |
| recon5[evolved] | 7/16 |
| recon10[evolved] | 7/16 |
| lex10(7 stores) | 14/16 |
| lex5(7 stores)+need5 | 15/16 |
| shipped | 1/16 |

### Paired exact McNemar (b = treatment hit, control miss; c = reverse; two-sided)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| comparison | group | n | treatment | control | b | c | p |
|---|---|---|---|---|---|---|---|
| lex5+need5 vs lex10 | amateurs | 101 | 46 | 18 | 29 | 1 | 0.0000 |
| lex5+need5 vs lex10 | all | 178 | 101 | 76 | 33 | 8 | 0.0001 |
| lex5+recon5[default] vs lex10 | amateurs | 101 | 45 | 18 | 28 | 1 | 0.0000 |
| lex5+recon5[default] vs lex10 | all | 178 | 106 | 76 | 34 | 4 | 0.0000 |
| lex5+recon5[evolved] vs lex10 | amateurs | 101 | 50 | 18 | 33 | 1 | 0.0000 |
| lex5+recon5[evolved] vs lex10 | all | 178 | 108 | 76 | 38 | 6 | 0.0000 |
| lex5+need5 vs lex5+hist3 | amateurs | 101 | 46 | 17 | 29 | 0 | 0.0000 |
| lex5+need5 vs lex5+hist3 | all | 178 | 101 | 68 | 33 | 0 | 0.0000 |
| lex5+recon5[default] vs lex5+hist3 | amateurs | 101 | 45 | 17 | 28 | 0 | 0.0000 |
| lex5+recon5[default] vs lex5+hist3 | all | 178 | 106 | 68 | 38 | 0 | 0.0000 |
| lex5+recon5[evolved] vs lex5+hist3 | amateurs | 101 | 50 | 17 | 33 | 0 | 0.0000 |
| lex5+recon5[evolved] vs lex5+hist3 | all | 178 | 108 | 68 | 40 | 0 | 0.0000 |
| lex5+need5 vs shipped | amateurs | 101 | 46 | 1 | 45 | 0 | 0.0000 |
| lex5+need5 vs shipped | all | 178 | 101 | 8 | 95 | 2 | 0.0000 |
| lex5+recon5[default] vs shipped | amateurs | 101 | 45 | 1 | 44 | 0 | 0.0000 |
| lex5+recon5[default] vs shipped | all | 178 | 106 | 8 | 99 | 1 | 0.0000 |
| lex5+recon5[evolved] vs shipped | amateurs | 101 | 50 | 1 | 49 | 0 | 0.0000 |
| lex5+recon5[evolved] vs shipped | all | 178 | 108 | 8 | 102 | 2 | 0.0000 |

### Rule lines (numbers only)

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

- lex5+need5 vs lex10, A6.4 / A5.4 (R4c): +10 points amateurs, exact McNemar p < 0.05, no stratum down 5 or more questions: amateurs 46/101 vs 18/101 = +27.7 points, b=29 c=1 p=0.0000; per-stratum change in questions: build-task +3, cross-repo +0, design-rationale -4, history +0, troubleshooting -4, which-tool +30; both repositories present on cross-repo 15/16 vs 11/16 = +25.0 points
- lex5+recon5[evolved] vs lex10, A6.5 / A5.6 (R13) and A7.15 (R19): +10 points amateurs, p < 0.05, both-repositories +10 points on cross-repo, no stratum down 5 or more: amateurs 50/101 vs 18/101 = +31.7 points, b=33 c=1 p=0.0000; per-stratum change in questions: build-task +7, cross-repo +2, design-rationale -3, history +0, troubleshooting -3, which-tool +29; both repositories present on cross-repo 14/16 vs 11/16 = +18.8 points
- A7.17 (R21) evolved vs default on amateurs: lex5+recon5[evolved] 50/101 vs lex5+recon5[default] 45/101 = +5.0 points (rule: evolved adopted at +5)

### Abstention and risk-adjusted utility (A7.16 / R20); lane alone, its own section

_slice result, not a whole-corpus result: 7 stores (agenticow, RuLake, agentdb, agentic-flow, metaharness, RuVector, ruflo), 178 slice questions, 57 with a unit for (every) gold file; look 1 (interim, A8.3; stage 0 failed for need index and graph lane: flagged), coverage 1617 units of 9029_

| lane | answerable n | gold served | abstained (wrong abstain) | served without gold | not-in-corpus n | abstained there | risk score |
|---|---|---|---|---|---|---|---|
| lex10 | 178 | 76 | 0 | 102 | 14 | 0 | 0.396 |
| need5 | 178 | 56 | 0 | 122 | 14 | 0 | 0.292 |
| recon5[default] | 178 | 65 | 0 | 113 | 14 | 0 | 0.339 |
| recon5[evolved] | 178 | 71 | 0 | 107 | 14 | 0 | 0.370 |
| shipped | 178 | 8 | 126 | 44 | 14 | 1 | 0.375 |
