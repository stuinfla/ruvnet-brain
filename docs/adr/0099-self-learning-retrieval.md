---
id: ADR-099
title: Self-learning newcomer retrieval with rUv's own learning tools
status: Proposed
date: 2026-10-01
updated: 2026-10-01
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [retrieval, learning, sona, reasoningbank, measurement]
supersedes: []
relates: [ADR-060, ADR-090, ADR-092]
---

# ADR-099 — Self-learning newcomer retrieval

**Status**: Proposed (2026-10-01)

Nothing here ships until the ship-gate below passes. Every arm runs behind its own flag, and the flags
default to off.

## Why (measured, `evals/runs/2026-10-01-retrieval-4.5/`)

The novice need set has 206 questions, each written from one gold file. For 87 of them the gold
repository was searched (`abstain-trace.json`, 4.3.37 corpus, production models). For 202 of the 206
the reranker abstained.

- **The gold file never reaches the pool.** Without the keyword lane, the gold file was in the
  store's 64-deep dense pool for 13 of the 87. With the keyword lane (E2), it was there for 35 of the
  87 (`abstain-trace-with-keyword-lane.json`). For 52 it is still absent.
- **In the pool, the reranker scores the answer itself as irrelevant.** For 32 of those 35, the
  cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) scores even the verbatim gold span below 0. Text
  truncation (the 3000-character window) explained 0 cases, chunking 1, and outranking 2.
- **Moving the fixed threshold is not the fix.** The owner rejected it. The measurement agrees.
  `abstain-threshold-sweep` replays the measured runs exactly, and at t = 0 it reproduces 48/80 and
  19/20. At t = −4, confident hits rise 0 → 4/206, but confident wrong-file answers rise 5 → 61/206,
  for a precision of 4/65.

## What rUv ships for this (grounded with search_ruvnet; source paths cited)

- **`@ruvector/sona` 0.1.8** (`ruvector/crates/sona/README.md`).
  - `SonaEngine` provides `beginTrajectory`, `addTrajectoryStep`, `endTrajectory`,
    `applyMicroLora`, `forceLearn`, `findPatterns` and `getStats`. MicroLoRA is rank 1–2, BaseLoRA
    rank 8–16, with EWC++ against forgetting.
  - **Installability, checked live 2026-10-01.**
    - The npm optionalDependencies publish native bindings for linux-x64-gnu/musl, linux-arm64-gnu,
      darwin-x64, darwin-arm64, win32-x64-msvc and win32-arm64-msvc. `npm view` confirmed
      linux-x64-gnu, darwin-arm64 and win32-x64-msvc at 0.1.8.
    - `npm install @ruvector/sona@0.1.8` and a real smoke run worked on darwin-arm64.
    - Measured there under load average ~200: `applyMicroLora` took ~415 µs/op on a 384-d vector, and
      `forceLearn` returned "1 trajectories -> 1 patterns".
    - **Not run:** linux-x64 and win32. That run is required before shipping, on the customer-canary
      hosts.
  - **What MicroLoRA can learn, read from the source** (`ruvector/crates/sona/src/lora.rs`
    `accumulate_gradient` and `src/types.rs` `estimate_gradient`).
    - The update is `grad_up += gradient_estimate * quality`, applied to the up-projection only.
    - `gradient_estimate` is a REINFORCE estimate over the trajectory's step activations,
      `(reward − baseline) · activation`. With no steps, it is the query embedding itself.
    - So a rank-2 adapter can learn a shift along at most two directions, scaled by the fixed
      down-projection of the query. That is a **global** correction (for example, "newcomer phrasing →
      documentation phrasing"), not a per-question mapping. Whether that is enough is an empirical
      question (arm B below).
  - **The adapter is not the identity before training.** In the darwin smoke run an untrained
    `applyMicroLora` already changed the vector. The adapter must therefore be bypassed entirely
    until it has learned, and whenever the kill-switch is set.
- **ReasoningBank** (`agentic-flow/bench/agents/reasoningbank-agent.js`,
  `agentic-flow/agentic-flow/src/reasoningbank/index.ts`).
  - It runs RETRIEVE → JUDGE → DISTILL → CONSOLIDATE.
  - JUDGE is **LLM-as-judge** (`agentic-flow/agentic-flow/src/reasoningbank/core/judge.ts`). It
    needs an `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_GEMINI_API_KEY`, and otherwise falls
    back to a heuristic.
  - An LLM call per search on a customer machine is not acceptable: it costs money, needs keys and
    leaks the question. So this ADR adopts the JUDGE **role** with a local learned classifier (arm C),
    trained offline. CONSOLIDATE is adopted as nightly local consolidation (arm D).
- **AgentDB `NightlyLearner.consolidateEpisodes`** (`agentdb/docs/ATTENTION_INTEGRATION.md`):
  episodic consolidation and causal-edge discovery. It is a candidate for arm D.
- **`ruvector-gnn-rerank`** (`ruvector/docs/adr/ADR-194-gnn-rerank.md`) is not applicable. It is
  Rust-only on a research branch, and it smooths noisy vector scores among candidates already in the
  pool, which addresses neither cause.

## Decision (proposed)

Four arms, each behind its own flag. E3 (quoted-claim merge) stays in. E2 (keyword lane) ships off
in 4.5 behind `RUVNET_BRAIN_KEYWORD_LANE=1`, because its query-time index build costs +2.1 s median
per question (ADR-090 §9). The pool-reach numbers below that use E2 describe the flag-on reader.

**A. Self-supervised entry points ("doc2query"), built once in CI, never on customer machines.**
- For each document, generate N newcomer-style questions and index them as extra vectors that point
  to that document. This attacks the 52/87 "never reaches the pool" cause.
- Under ADR-092 this is corpus data, built once per store change.
- Generation must not see the held-out needs. It uses the same leak rules as the need-set producer:
  no product names, and at most 3 shared consecutive words.

**B. Query-side SONA MicroLoRA.**
- `applyMicroLora(queryEmbedding)` runs before the HNSW search.
- **Bootstrap:** trained from the arm-A pairs (synthetic question → file), shipped with the corpus.
- **Local learning:** each search is a trajectory. Quality comes from the grounding receipts the
  hooks already write: a cited or used source is good; ignored or immediately re-searched is bad.
  This data stays local.
- **Safeguards:**
  - EWC++ guards against forgetting.
  - A shadow evaluation on the frozen recall-gate fixture runs before any learned update is applied.
    An update that drops the recall gate is discarded.
  - `RUVNET_BRAIN_SONA=0` is a hard kill-switch.
- **Fallback:** if a platform binding is missing, use the WASM build or `ruvector-learning-wasm`
  (`MicroLoRAEngine`). LoRA is never hand-rolled.

**C. Learned abstain (the JUDGE role, local).**
- A small model replaces the fixed 0 threshold. Its features are already computed: top cross-encoder
  logit, margin to the next, lexical overlap, router confidence and card match.
- It is trained on the need-set **train** split plus arm-A pairs.
- The operating point is chosen to cap confident-wrong answers. The target is **precision ≥ 0.8** on
  confident answers, measured on held-out.

**D. Nightly local consolidation.** CONSOLIDATE / `NightlyLearner` deduplicates and prunes the local
trajectories and patterns, and runs the EWC++ consolidation.

## Evaluation and ship-gate

- **The frozen split.** `need-set-v1.split.json` holds 103 train and 103 held-out needs, stratified by
  repository; it is produced by `scripts/oracle/need-set-split.mjs` on contentHash `fe0e876e…`.
  Learning sees train only.
- **Measured on held-out:** gold in top 5, confident hits, confident wrong, abstains.
- **Also measured:**
  - recall gate (≥ 162/182)
  - off-topic abstain (≥ 19/20)
  - held-out routed (≥ 48/80)
  - paired warm latency p50/p90 deltas
  - resident memory
- **The ship-gate:**
  - held-out confident hits rise with a Wilson lower bound above the baseline's upper bound;
  - confident-wrong answers stay at or below the precision target;
  - no gate regresses.
- Heavy runs start only at 1-minute load below 60.

## Where 4.5 left each arm, and the next step (4.6)

Measured 2026-10-01; outputs are in `evals/runs/2026-10-01-retrieval-4.5/`.

- **E3 (quoted-claim merge) and the store-name identifier rule: ON.**
  - **The rule:** a deployed store's key or alias never widens the route and never adds
    identifier candidates in another store.
  - **What it fixes:** the capability battery's "RuVector HNSW vector search overview" question
    is no longer answered from agentdb.
  - **The first version over-reached.** It dropped store names everywhere (e11b8838):
    - With E2 off, the recall gate lost "In LatentMesh ADR-001, …": 161 vs 162/182
      (`final-a2adf94a/`). Dense never pools that ADR, and the identifier lane had reached
      it through the store name.
    - With E2 on, the keyword lane had masked the loss.
  - **The shipped rule** keeps a store's own name as an identifier while that store is searched
    (ba9af6f7).
  - **Shipped reader vs the 4.4.1 base** (`final-5127bc53/`, `latency-base-vs-shipped/`):
    - recall gate: 162/182, the same per-store hit set;
    - off-topic and held-out: byte-identical outputs;
    - capability battery: 58/58;
    - paired warm latency, n=69: +32 ms median per question [−102, +85], p50 +18 ms
      [−562, +417]; faster on 34/69.
- **E2 (keyword lane): OFF, behind `RUVNET_BRAIN_KEYWORD_LANE=1`** (ADR-090 §9).
  - Gains with the lane on:
    - recall gate 162 → 165/182;
    - held-out routed 48 → 51/80;
    - needs gold or alternative within 5: 4 → 10/206.
  - Cost: +2.1 s median paired [1.4–2.9] and +5.9 s at p90.
  - Almost all of the cost is the query-time index build: the lane alone takes p50 1.5 s and
    p90 5.1 s (`e2-mitigation/`).
- **Arm C (learned judge): OFF; v1 failed.**
  - The eight trace features cannot separate the gold file from its neighbours.
  - No threshold reaches the 0.8 precision target on train, so the judge abstains on all
    103 held-out needs (0 confident hits).
  - Replayed on the recall gate, it drops gold within 5 from 165 to 154/182
    (`judge-report-v1.json`).
- **Arm A (doc2query): measured, not productized.**
  - 15,357 generated questions cover the 5,259 markdown files of ruflo, ruvector and ruview.
  - Held-out needs whose gold repository is searched: the gold file reaches the pool for
    17/43 [26.4–54.4%] with dense + keyword, and 28/43 [50.2–77.6%] once the entry lane is added
    (+11). Train goes 18/44 → 31/44 (`doc2query-reach.json`).
  - This measures pool reach only. Answer quality has not been measured.
- **Arm B (SONA MicroLoRA):** the harness is committed (`scripts/oracle/sona-query-adapter-eval.mjs`)
  but has not been run.
- **Arm D (nightly consolidation):** not started.

**Next step (4.6), in order:**

1. **Build the BM25 keyword index with the corpus and load it at query time.**
   - The index is built in CI with the stores and sealed with them, so customer machines never
     build it.
   - It turns E2 on if both hold on the same paired 69-question latency set:
     - added p50 ≤ +1.0 s;
     - the gate gains hold (recall ≥ +2, needs gold within 5 ≥ 8/206).
2. **Arm A in the product.**
   - A doc2query entry lane over CI-built entry indexes, behind its own flag.
   - Measured end to end on held-out answers, not just pool reach, under the same latency rule.
3. Arm B's experiment, then arm D.

## Alternatives considered

| Alternative | Why not (now) |
|---|---|
| Move the fixed abstain threshold | Measured above: confident wrong-file answers grow about 14× faster than hits (+56 vs +4 at t = −4). The owner rejected it. |
| Swap or fine-tune the cross-encoder or embedder | Not a rUv tool. Large model downloads on every install. No measurement yet that a different off-the-shelf model separates novice needs better. |
| ReasoningBank JUDGE as-is (LLM per query) | Needs API keys and money per search, and leaks the question off-machine. |
| `ruvector-gnn-rerank` (ADR-194) | Rust-only research branch, and it reranks within the pool, so it cannot fix either measured cause. |
| Deeper dense pool (E2w, pool 160) | Measured: 0 gained of 206; p50 latency 14.9 → 25.0 s. |
| Do nothing beyond E2 + E3 | E2 lifts pool reach from 13 to 35 of 87, but calibration still abstains on 32/35. |

## Open risks

- **Capacity.** Rank-2 MicroLoRA capacity may be too small for a per-domain shift (arm B can fail
  cleanly; the shadow-evaluate rule keeps it off).
- **Generation cost and quality.** Arm A needs an LLM in CI for every store change, which is budgeted
  and owned by the corpus pipeline. Its synthetic questions must be checked for leakage into held-out.
- **Receipt quality as a learning signal.** "Cited" is not "correct". Arm B's quality signal is noisy
  and must be shadow-evaluated, never trusted.
