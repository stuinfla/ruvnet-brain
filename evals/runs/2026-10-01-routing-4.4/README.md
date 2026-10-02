# Routing 4.4: tie-break, metadata index, and the rUv misroute (2026-10-01)

These are measurements only. Corpus: `ruvnet-brain.zip` v4.3.37 data (`scratchpad/latest/kb`). Baseline runtime: `cb656e47`. That commit is the
4.3.40 code with the planner moved into `planSourceRoute`, and the routing it produces is identical. Final runtime: `87e44fbe`. Intervals are 95% Wilson. `8c17b7f9`, measured only in the latency section, adds the build-keyed identifier-scan cache on top of `87e44fbe`. It changes no route or result within a single KB build.

## Route only (`scripts/route-gold-rank.mjs`, no model)

| Set | Baseline | Final |
|---|---|---|
| 206 novice needs (3 repos), gold in top 3 | 42/206 20.4% [15.4-26.4] | 83/206 40.3% [33.8-47.1] |
| 206 needs, gold in top 5 | 42/206 20.4% [15.4-26.4] | 87/206 42.2% [35.7-49.1] |
| 206 needs, gold at 1 | 22/206 10.7% [7.2-15.6] | 45/206 21.8% [16.8-28.0] |
| 206 needs, mean stores opened | 2.209 | 3.194 |
| 182 recall-fixture questions with store identity stripped (182 stores), gold in top 3 | 74/182 40.7% [33.8-47.9] | 85/182 46.7% [39.6-53.9] |
| same, gold in top 5 | 75/182 41.2% [34.3-48.5] | 88/182 48.4% [41.2-55.6] |
| held-out named/described/scenario (27 stores), gold at 1 | 80/80 | 80/80 |
| off-topic (20), router declined | 15/20 | 15/20 |

- **Paired changes on the 206 needs.** 45 questions gained gold in the top 3. 4 lost it, but those 4 moved to rank 4 or 5, and none lost gold in the top 5.
- **Paired changes on the 182 stripped questions.** 13 gained gold in the top 3 and 2 moved from rank 3 to rank 4 or 5. One question became newly declined: fireflies-webook, which the old code routed to ruv-gists, a wrong store.
- **The index matches the old scan.** Run with the old tie rule (variant v0), the index gave routes identical to the per-entry scan on 306 of 306 questions.
- **Variants measured on the 206 needs, gold in the top 3:**
  - top-1 by entries-at-top: 61/206
  - up to 3 ties, broken by name: 60/206
  - up to 3 ties without card stores: 76/206 (2.08 stores opened)
  - shipped (up to 3 ties by entries-at-top, plus the card stores): 83/206

## Full path (models), baseline vs final, same harness and corpus, gated at 1-minute load < 60

| Check | Baseline | Final |
|---|---|---|
| Recall gate (`repo-recall` via `recall-driver`) | top-5 162/182, top-1 128 | top-5 162/182, top-1 128 (0 rank changes) |
| Off-topic abstain (`eval-brain --strata adversarial`) | 19/20 [76.4-99.1] | 19/20 [76.4-99.1] (same a-12) |
| Held-out (`eval-brain`) routed | 48/80 [49.0-70.0] | 48/80 [49.0-70.0] (0 pass flips; grounded 100/100, banner 18/20) |
| 206 needs (`measure-need-set`, k 5): repo at 1 | not re-run here | 55/206 26.7% [21.1-33.1] |
| 206 needs: exact file within 5 | not re-run here | 3/206 1.5% [0.5-4.2] |
| 206 needs: abstained | not re-run here | 201/206 |
| 206 needs: gold repo searched | not re-run here | 87/206 |
| 206 needs: latency | not re-run here | p50 20.5 s, p90 33.9 s (concurrency 2, under load) |

The final run's `adversarial.json` and `heldout.json` were byte-identical to the baseline's: sha256 `bb7d3e7c…` and `0b98b855…`. Only the baseline copies are kept, because `single-source:check` A2 refuses duplicate files.

The 206-need baseline for the full path is the need-baseline agent's run, recorded in `data/need-set/experiments/2026-09-30-record.json` on that branch: repo at 1 30/206 and exact file 0/206. It was taken on older code at concurrency 4, so it is a reference rather than a paired measurement.

## Warm latency, paired (`latency-warm-abc/`)

The test ran in one process, which is the MCP worker's regime, and called `searchAll` with k 6 and `allowFullCorpus` false. It used every 3rd novice need, so n = 69 across all 3 repos. Every question went to all three arms back to back, the arm order rotated per question, and each question waited for 1-minute load < 60 (the observed range was 30–60). Intervals are 95% paired bootstrap intervals (2000 resamples, seeded) from `summary-paired.json`.

The three arms:
- **A:** baseline `cb656e47`.
- **B:** final `8c17b7f9`.
- **C:** final code with the old top-1-by-name metadata route, so it has the index cache and the old store count.

| Arm | p50 | p90 | Stores per question |
|---|---|---|---|
| A, baseline | 9587 ms | 16228 ms | 2.32 |
| C, cache only | 7174 ms | 11758 ms | 2.32 |
| B, final | 10825 ms | 18034 ms | 3.29 |

| Paired delta | p50 | p90 | Median of per-question differences |
|---|---|---|---|
| C − A (the index cache) | −2413 ms [−3307, −1578] | −4470 ms [−6387, −402] | −2238 ms [−2524, −1951]; C faster on 61/69 |
| B − C (the extra stores) | +3651 ms [+2023, +4679] | +6275 ms [+1839, +7465] | +3006 ms [+323, +5191]; B faster on 17/69 |
| B − A (net) | +1238 ms [−364, +2053] | +1806 ms [−1055, +4309] | +453 ms [−271, +2447]; B faster on 31/69 |

- **The cost of searching about one more store is about +3.0 s per question at the median.** The index cache saves about 2.2 s. At n = 69 the net change versus the baseline is not distinguishable from zero.
- **Arm C changed latency only.** Its top-1 result was identical to A's on 69/69 questions.
- **A first, unbounded attempt over all 206 questions was stopped** by the 2-hour background limit at 22/206. Its rows were held in memory, so they were lost, and none of its numbers are used here.

## Review fixes (2026-10-01, after the adversarial review)

- **The rUv rule now requires an authorship shape** (`ruvAuthorshipIntent`). Probes are in `ruv-probe-review.jsonl`. The 11 product questions, including the review's 6, no longer route to ruv-gists alone. All 10 provenance questions route to ruv-gists first.
- **Routing is unchanged on the measurement sets.** Route-only, `route-review-fixes-kb4337.json` against `route-final-87e44fbe-kb4337.json` gives 0 route changes on 488 questions: 206 needs, 182 stripped, 80 held-out and 20 off-topic. The numbers are unchanged: needs gold in top 3 83/206 [33.8–47.1], stripped 85/182 [39.6–53.9], held-out 80/80, off-topic declined 15/20.
- **Router metadata index memory.** `node --expose-gc scripts/route-index-memory.mjs --kb <kb>` was run twice per code version on 199 stores.
  - Per-store `Map<token, Uint32Array>`: 162.5 MB retained (heap 154.6 MB, array buffers 7.9 MB).
  - Compact CSR with one token dictionary per directory build: 43.9 MB retained (heap 28.5 MB, array buffers 15.5 MB).
  - Cold build is 2.2–2.5 s for both, and a warm call is 2–3 ms for both.
  - At most 2 KB directories are indexed (LRU).
- **Identifier-scan cache.** The key now adds a fingerprint of every `.passages.jsonl` file (name, dev, inode, mtime, size), so overlay and ingest writes that skip manifest.json are seen. The cache is LRU-bounded at 64 entries.
- **The latency harness is committed.** `node scripts/route-latency-warm.mjs --summarize latency-warm-abc/rows.jsonl --arms A_base,C_final_oldroute,B_final` reproduces `summary-paired.json` exactly. The latency rows were measured before the compact index. It changes memory, not the warm call time (2–3 ms either way).

## rUv probes (`ruv-probe-after.jsonl`)

- **Before the fix,** 5 of 6 product questions that mention rUv routed to ruv-gists alone.
- **After the fix,** those 5 route to agentdb, ruvector, ruv-fann, ruview and agentic-flow. All 7 provenance probes still route to ruv-gists.
