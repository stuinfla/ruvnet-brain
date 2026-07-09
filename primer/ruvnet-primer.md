# The RuvNet Primer — the building blocks, on one page

`Brain version: v1.13.1-dev · Built: 2026-07-08 · Covers: 20/169 repos built @ pinned SHAs (see data/manifest.json)`

> **What this is:** a portable, source-grounded "brain" over the reusable RuvNet building blocks by
> **Reuven Cohen (rUv)**. It ships as a **Claude Code plugin** so your assistant answers from Ruv's real
> source — with citations — instead of guessing. This page is the human map; the brain is the searchable
> bundle. Every claim here is meant to be backed by a real passage — ask the brain to verify it.

---

## What the brain is

- A **portable brain** over **~18 RuvNet building-block repos**, embedded and indexed at pinned SHAs.
- Delivered as a **Claude Code plugin**: **one tool (`search_ruvnet`)** + **one enforcement hook** (a
  UserPromptSubmit grounding directive, so the model can't silently drift) + **one skill**.
- **Installed once at user scope**, then active in **any** repo you open — not tied to one project.
- **Building blocks only.** Reusable infrastructure goes in; end-user apps stay out. **Helix** (a separate
  health app) is **intentionally not in the brain** — the brain carries components you build *with*, not
  finished products.

---

## The building blocks (one line each)

**Core stack**
- **ruflo** — agent orchestration: swarms, hooks, MCP tools, memory.
- **RuVector** — the vector engine: RVF files + HNSW on-disk vector search.
- **AgentDB** — agent memory + graph / Cypher queries.
- **RuLake** — cache-coherent vector cache over RVF.
- **RuView** — camera-free WiFi / CSI sensing: turns ordinary WiFi radio (Channel State Information) into through-wall presence/occupancy detection, pose estimation, fall/gesture recognition, and contactless medical-grade vitals (breathing + heart rate) on ESP32-S3/C6 hardware.

**Method & routing**
- **agentic-flow** — cheap multi-model routing for agents.
- **SPARC** — 5-phase build methodology (Spec → Pseudocode → Architecture → Refinement → Completion).
- **agent-harness-generator / metaharness** — generate and evaluate agent harnesses.

**Specialized**
- **qudag** — quantum-resistant DAG / anonymous comms.
- **safla** — Self-Aware Feedback Loop Algorithm: recursive self-improvement / meta-cognition.
- **ruv-fann** — memory-safe neural nets (FANN, in Rust).
- **synthlang** — high-performance LLM middleware: prompt compression + agentic framework.
- **rupixel** — zero-server, client-side visual retrieval (search pixels/video by meaning).
- **agenticow** — "Git for agent memory": copy-on-write vector branching for multi-agent memory.
- **cve-bench** — SWE-bench-style benchmark for fixing real CVEs (security capability eval).
- **daa** — decentralized autonomous agents.
- **dspy.ts** — declarative, self-improving LLM programs in TypeScript.
- **fact** — Fast-Access Cached Tools (advanced caching — *not* "fast augmented context"; the brain
  corrects that common mis-read from real source).

---

## Why it exists

Claude and Codex **under-cover this Rust-first ecosystem**, so they:
- **drift** — reach for pgvector / Pinecone / hand-rolled cosine instead of RVF + HNSW; and
- **wrongly doubt** real, shipping tools they haven't memorized.

The brain fixes both. It makes the assistant:
- **answer from real source, with citations**;
- **prefer RuvNet building blocks** over training-prior defaults; and
- **work like Ruv** — assess → SPARC → ADR/DDD → QA each step → score → revise.

---

## The proof / confidence concept (honest, exact numbers)

**Re-runnable proof batteries** (`node scripts/prove.mjs`, k=3; `bash scripts/gate.sh` for the gate) now
score ~96–98% **whether the question names the tool or just describes the need**:

| When the question… | Score | |
|---|---|---|
| **names a repo or is specific** (helix-free; tuned, held-out, cross-repo, implementation, coverage) | **47/48** | **98%** |
| **is by-description only** (newcomer phrasing, no repo names) | **27/28** | **96%** |
| **Helix-context demo** (`HELIX-DEMO-NOHELIX.md`) | **7/8** | **88%** (up from 1/8) |

- The by-description path **was 33% before the fix** and is now **96% after** adding **capability cards** —
  a capability-phrased passage per building block that lets a described need route to the right repo without
  naming it. Artifacts: `PROOF.md`, `DESCRIBED-PROOF.md`, `HELIX-DEMO-NOHELIX.md`.
- Two honest residuals, not hidden: one described question (*"route to cheaper models to cut cost"*) still
  routes to **ruflo** instead of **agentic-flow** (orchestration/cost overlap); one Helix question (an unnamed
  *"methodology"* ask) routes to **synthlang** instead of **sparc**.
- The **421 MB bundle** (`dist/ruvnet-brain.zip`) was **acceptance-tested as a fresh consumer** — extracted
  on its own, `npm i`, queried, **3/3 grounded** — so it runs off the dev machine, not just on it.

**The guarantee is narrow and true:** grounded, non-drifting, cited answers over this corpus **whether the
target is named (47/48) or only described (27/28)**, with the two residuals above named honestly; and
**no autonomous builder yet**. Nothing here is "done" or "complete" — it's a verified floor you can re-run.

---

## How to use it

1. **Install the plugin** (once, user scope — active everywhere):
   ```
   claude plugin marketplace add stuinfla/ruvnet-brain && \
     claude plugin install ruvnet-brain@ruvnet-brain --scope user
   ```
2. **Open any repo and ask.** The hook grounds the turn; the model calls `search_ruvnet` and answers from
   cited source. Example: *"How does ruflo persist agent memory, and what implements it?"*
3. **Pull in an uncovered repo on demand** (any of the ~169 catalogued, or any rUv repo):
   ```
   node scripts/ingest-repo.mjs --name <repo>
   ```
   It clones, embeds both vector variants, builds symbols, and is searchable with no restart.

---

> **Stay honest:** every number above is re-runnable. If the brain can't ground a claim, it should say so —
> that refusal *is* the product. Re-run `scripts/prove.mjs` and check the output yourself.
