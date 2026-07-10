<div align="center">

![RuvNet Brain — the answer key for Ruv's code](assets/hero.png)

# 🧠 RuvNet Brain

### 🧠 RuvNet Brain — [![RuvNet Brain version 2.0.0 — updated 2026-07-10 08:15 EDT](https://img.shields.io/badge/version_2.0.0-updated_2026--07--10_08:15_EDT-1E90FF?style=for-the-badge&labelColor=0757BA)](https://github.com/stuinfla/ruvnet-brain/blob/main/plugin/.claude-plugin/plugin.json)

**A portable, source-grounded brain over Reuven Cohen's (rUv's) RuvNet stack — delivered as a Claude Code plugin that makes Claude _use_ the stack instead of fighting it.**

[![plugin version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fstuinfla%2Fruvnet-brain%2Fmain%2Fplugin%2F.claude-plugin%2Fplugin.json&query=%24.version&label=plugin&color=e8a13a&style=flat-square)](plugin/.claude-plugin/plugin.json)
[![installer version](https://img.shields.io/npm/v/ruvnet-brain?label=installer%20%28npm%29&color=2e7d32&style=flat-square)](https://www.npmjs.com/package/ruvnet-brain)
[![download](https://img.shields.io/badge/download-512MB%20brain-2e7d32?style=flat-square)](https://github.com/stuinfla/ruvnet-brain/releases/latest)
[![explainer](https://img.shields.io/badge/▶%20see%20it%20live-isovision.ai%2Fruvnet--brain-e8a13a?style=flat-square)](https://isovision.ai/ruvnet-brain/)
[![license](https://img.shields.io/badge/license-MIT-8ecae6?style=flat-square)](LICENSE)
[![grounded](https://img.shields.io/badge/answers-cited%20rUv%20source-333?style=flat-square)](#testing--proof)
[![coverage](https://img.shields.io/badge/coverage-10%25%20of%20ALL%20source%20·%20honest-b58900?style=flat-square)](#testing--proof)

> **Three independent things version separately here — by design, not drift. Every number below is live (read straight from its real source, never hand-typed), so none of them can go stale:**
> - **`plugin`** (badge above) — the Claude Code plugin itself: SKILL.md, the grounding hooks, the MCP server. Read live from [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json). Updates often — this is where behavior fixes land.
> - **`installer (npm)`** (badge above) — the `npx ruvnet-brain` setup script. Read live from the [npm registry](https://www.npmjs.com/package/ruvnet-brain). Only moves when the installer script itself changes — rare.
> - **Brain Release** (the downloadable 512MB knowledge bundle, linked from the "download" badge above) — always resolves to [`releases/latest`](https://github.com/stuinfla/ruvnet-brain/releases/latest), currently `v0.5.0-dev`. Only moves when the underlying knowledge base is rebuilt — separate again from the two above.
> - **Update an installed brain once:** `npx ruvnet-brain --update` — runs the bundle's own self-updater (backs up first, re-verifies, fails loud instead of half-applying).
> - **Nightly auto-update is OFF by default:** `npx ruvnet-brain --enable-nightly` schedules it (macOS LaunchAgent, 03:47); `npx ruvnet-brain --disable-nightly` removes it; Linux/Windows get the cron line documented in the bundle's `forge-update.mjs`.
> - **Either way, your copy only advances when a new Release is published** — the updater pulls `releases/latest`, so running it between releases is a safe no-op.

<sub>Built by **[Stuart Kerr](https://isovision.ai)** at [Isovision.ai](https://isovision.ai) · free & fair use, to help everyone leverage the high end of agentic coding.</sub>

### [▶ Come see it visually explained](https://isovision.ai/ruvnet-brain/)

<sub>An interactive, animated walkthrough of what you can actually build — **click the preview** to open it.</sub>

[![The RuvNet Brain interactive explainer — click to open the visual walkthrough](assets/explainer-preview.png)](https://isovision.ai/ruvnet-brain/)

</div>

---

## What's new in 2.0

**2.0 is the release where the brain got bigger — and, more importantly, stopped taking its own word for anything.** Every number below regenerates from an artifact on disk; the claims ledger (`node scripts/claims-verify.mjs`) re-checks the advertised ones in CI:

| | v1 (0.x–1.x) | v2.0 |
|---|---|---|
| **Corpus** | 24 repos built | **32 repos** built (of 197 live ruvnet repos), each verified by a live retrieval query |
| **Depth** (flagship `ruvector`) | 18,491 passages · **0** full source bodies | **28,018 passages · 2,996 full bodies** — depth also restored to `agent-harness-generator` (8,896/715), `ruview` (7,434/765), `open-claude-code` (195/69) |
| **Corpus QA gate** | none | every store must prove *embeds correctly + reads correctly* — vector count == passage count, depth floors, a 3-passage self-retrieval round-trip per store — **72/72 store-variants PASS**, wired fail-closed into the nightly publish |
| **Retrieval eval** | 12 frozen questions | **120 frozen, hash-pinned questions** across 5 strata; promotion gated on Wilson lower bounds, fail-closed — it blocked a real release this morning, which is the feature working |
| **Token cost** | 6,183 bytes injected per hook turn · zero self-measurement | **684 bytes (~90% cut)** with an eval-PASS proving zero quality loss · a live token meter measuring real bytes/tokens per prompt class · ~27% faster repeat queries via the KB cache |
| **rUv's gists** | not indexed | **437 gists** indexed with per-chunk freshness/provenance banners, refreshed nightly with cost-disciplined skip |
| **Reliability** | claims were prose | **claims ledger** (5 marketing claims mechanically re-verified in CI) · integration tests in CI incl. Linux · a Windows CI job · an honest coverage denominator (all source files) |
| **Autonomy** | hooks asked questions to an empty room — the #1 real-user complaint | **`/loop` contract** — checkpoint / resume / done-criteria; hooks detect autonomous mode and stop asking — 10 mutation-verified tests |
| **Publishing** | manual npm token · a nightly release PATH bug | **self-renewing npm token** (launchd daemon, proven end-to-end) · PATH bug root-caused and cured |
| **Memory layer** | silent SQLite corruption · searches returning 0 · invisible flywheel patterns | **3 root-caused fixes** (an ABI-mismatched binary falling back to WAL-blind whole-file overwrites; keys that were never scored; a split-store display bug) — plus **6 exact patches queued upstream to ruflo** |

The depth jump wasn't tuning — it was two pipeline root-causes fixed for good: missing `--full` hints, and a day-one `v2/` skip-dir bug that had made two repos undepthable since the first build.

### The scorecard — 8 dimensions, self-scored /100, every deduction evidenced — 2026-07-10 (evening re-score)

| Dimension | v1 (2026-07-09) | v2.0 (current) | Δ | What moved it |
|---|---:|---:|---:|---|
| End-user experience | 54 | 83 | +29 | One-command install now offers nightly self-updates (default yes); the page lives on isovision.ai; publishing renews itself |
| Knowledge corpus | 71 | 88 | +17 | 24→32 verified repos; a 72/72 embeds-and-reads QA gate; full source depth restored — flagship went 0→2,996 source bodies |
| Effectiveness (eval-proven retrieval) | 58 | 88 | +30 | 120-question Wilson-bound gate — it blocked a bad release, then passed the fix *above* the old baseline |
| Acting like rUv | 38 | 72 | +34 | Memory layer root-caused and fixed with proofs; 6 exact patches queued upstream; real multi-agent swarm operations |
| Developer smarter | 62 | 84 | +22 | `/brain-score` runs this same scorecard on any repo; honest tool announcements; per-answer source receipts |
| Token cost efficiency | 41 | 82 | +41 | ~90% smaller per-turn injection, eval-proven free; a live token meter — measured, not guessed |
| Engineering reliability | 61 | 86 | +25 | 312 tests green; a claims ledger re-verifies marketing claims in CI; fail-closed publishing; Windows CI added |
| Safety & privacy | 74 | 82 | +8 | Private-store fence held under full rebuild; secrets never transit chat; autonomy hard fence |
| **Overall** | **55** | **83** | **+28** | — |

These are self-scores under a hard rule: **every deduction requires specific evidence, and a known architectural flaw caps a dimension at ≤70 until the flaw is fixed** — *acting like rUv* spent the morning capped for its memory-layer flaw; the flaw was root-caused and fixed with proofs, the cap lifted, and it re-scored 72. Overall **55 → 83 in two days**, each number regenerating from a stored receipt — and the same scoring that produced these blocked a release mid-day. **That's why they're credible: scores you can trust beat scores that flatter.**

**The honest small print, kept visible:** warm query is ~21 s on the large corpus (it grew with depth; candidate dedup/pruning is the next optimization) · the 8 newest repos are findable by name but don't yet have primers/capability cards for described-need routing (coming) · the Windows CI job is new and unproven until its first green run.

---

## The one thing to understand first

**Reuven Cohen (rUv) builds about nine months ahead of the state of the art.** His RuvNet building blocks — Ruflo, RuVector, AgentDB, agentic-flow, SPARC and ~20 more — are the working prototypes of what becomes mainstream AI tooling three quarters later. This is the actual front edge.

But **Claude was trained on _classical_ software development.** Point it at rUv's stack and it doesn't recognize the work: it drifts, it _doubts real capabilities_ (“ruflo can't edit files,” “RuvNet has no vector DB — use Pinecone”), and it quietly falls back to the patterns it knows (pgvector, LangChain, a hand-rolled cosine loop). A newcomer gets the **worst of both worlds** — a revolutionary toolset with no instruction manual, _and_ an assistant that talks them out of using it.

> **RuvNet Brain is the missing instruction manual.** It reads rUv's real source, hands Claude the _answer key_, and removes Claude's permission to make things up about the stack. Install it once, aim it at any repo, and a newcomer can build ~9 months ahead — without being rUv.

The novelty is **structural grounding, not plain retrieval.** Plain RAG only decides what to _add_ to context. This ships a `UserPromptSubmit` hook that injects a grounding directive on **every** RuvNet-relevant turn — the harness consumes that stdout structurally, so the directive is _always present_, not a decline-able suggestion. It's a **strong, always-on nudge** — Claude is pointed at the real source and told to ground before asserting on every relevant turn — not a hard block on the model's output. **RAG decides what to add; this makes grounding the default the model has to actively argue its way out of.**

---

## The problem it solves

You know the failure mode. You ask Claude to build with Ruflo or RuVector, and instead of reading rUv's actual code it reaches for its training priors: _“let's just use pgvector,” “I'll hand-roll cosine similarity,” “I don't think ruflo can edit files.”_ It skims, it guesses, it doubts tools that work perfectly well — and the result drifts **off** the very stack you chose.

![The drift problem, before and after RuvNet Brain](assets/diagrams/drift-before-after.svg)

<details><summary>ASCII version (for AI / accessibility)</summary>

```
WITHOUT the brain — drift          |   WITH RuvNet Brain — grounded
                                   |
 You: build with Ruflo/RuVector    |    You: the same request
            |                      |              |
            v                      |              v
 Claude falls back to priors       |    Enforcement hook grounds the turn
            |                      |              |
            v                      |              v
 "just use pgvector"               |    search_ruvnet -> cited rUv source
 hand-rolls cosine similarity      |    (whole files, labeled repo + path)
 "ruflo can't edit files"          |              |
            |                      |              v
            v                      |    Builds ON the stack (RVF/HNSW, swarms)
 Drifts OFF the stack              |
```

</details>

---

## Install — one line

```bash
npx ruvnet-brain
```

That single command runs the whole setup, narrating _what it's doing and why_ at each step: it downloads the brain (~512 MB) from the [latest GitHub Release](https://github.com/stuinfla/ruvnet-brain/releases/latest), unpacks it to `~/.cache/ruvnet-brain/kb`, installs its local reader (no cloud calls, no API keys), and wires the Claude Code plugin — the `search_ruvnet` MCP tool + the `UserPromptSubmit` grounding hook — at user scope. The installer and the `search_ruvnet` tool run on **macOS, Linux, and Windows**; the grounding/enforcement **hooks are POSIX shell**, so they fire on macOS, Linux, and Windows-via-WSL/Git-Bash (on native Windows without WSL the search tool still works, but the auto-grounding hooks don't fire — a Node port of the hooks is on the roadmap). It's safe to re-run, and the brain itself always fetches the current Release regardless of which install path you use — you install once; you don't keep re-downloading.

> Want the bleeding-edge installer, even ahead of the last npm publish? `npx github:stuinfla/ruvnet-brain` always runs straight off the latest GitHub commit.

<details><summary>Manual install (what the one-liner automates)</summary>

```bash
claude plugin marketplace add stuinfla/ruvnet-brain
claude plugin install ruvnet-brain@ruvnet-brain --scope user
```

Registers the `search_ruvnet` MCP tool, the grounding skill, and the `UserPromptSubmit` enforcement hook — globally, at user scope. The plugin expects the brain at `~/.cache/ruvnet-brain/kb` (or point `RUVNET_BRAIN_KB` at your own copy). The first install may show a one-time trust prompt for the hook.

</details>

**Then just ask.** _“How does Ruflo orchestrate agent swarms, and what implements it?”_ The hook grounds the turn, Claude calls `search_ruvnet`, and it answers from cited source — down to the function body.

![Install and use, step by step](assets/diagrams/install-and-use.svg)

---

## Staying current — how updates work

You install once. After that, three mechanisms keep you on the current brain without you having to remember an update command.

- **Consent-gated auto-update heartbeat** (the `SessionStart` hook, `plugin/scripts/session-start.sh`). The **first** time the plugin runs on a machine it asks you **once** whether it may keep itself updated in the background — a security-conscious opt-in, because self-update can change the model's own instructions. Your answer is remembered (`~/.cache/ruvnet-brain/.auto-update-pref`) and never asked again. On each session start it does a rate-limited (~15 min) 3s-capped check of the live GitHub `plugin.json`. If a newer plugin version exists **and** you opted in, it downloads it in the background through Claude Code's own trusted marketplace path — but the new version is **staged, not active**: Claude Code only loads plugins at process start, so **this session keeps running the version it started with** until you restart (`claude --continue` brings your conversation right back on the new version). If you declined, it just tells you the command to run. The 512 MB knowledge bundle is handled more conservatively — **detect + notify only**, never auto-applied, because the bundle isn't cryptographically signed yet and applying it would overwrite executable tool files (SEC-0010 #6).

- **Stack watchdog status footer** (the `UserPromptSubmit` hook's always-on Gate 0, `plugin/scripts/ground-ruvnet.sh`). Every response ends with one dim status line — e.g. `🧠 RuvNet Brain v2.0.0 · Ruflo: yes · AgentDB memory: on` — read from **filesystem ground truth**, not impressions. The version shown is always the one **actually loaded in memory** for this session; if a newer version is staged awaiting a restart, the line says so plainly (`… vX staged, restart to load`). So you never have to wonder whether the brain is on, which version is acting, or whether project memory is wired.

- **Nightly publish → `releases/latest` chain** (`scripts/self-update.mjs --publish`, run by the `deploy/com.ruvnet.brain-nightly.plist` LaunchAgent at 03:15). The nightly rebuilds only the repos whose upstream changed, and **if anything was rebuilt** it bumps the product version, cuts a GitHub Release, and advances [`releases/latest`](https://github.com/stuinfla/ruvnet-brain/releases/latest). Plugin and knowledge bundle move under **one** version number, so the heartbeat above picks up both automatically. (The LaunchAgent is not auto-installed — enabling a system scheduler needs explicit owner approval.)

---

## ✨ What the knowledge bundle knows — the stack _down to the code_

Earlier bundles knew only the **docs and architecture**. v0.5 began re-indexing the code-rich repos to **full function bodies**, against each repo's real source layout — so “how is this actually implemented?” returns the implementation, not a summary. The table below is that v0.5 depth jump, kept as the before/after receipt; **2.0 went further still** — flagship `ruvector` alone now carries 28,018 passages and 2,996 full bodies (see [What's new in 2.0](#whats-new-in-20)):

| Repo | Full-body code passages (v0.5) | |
|---|---:|---|
| `agentic-flow` | 296 → **984** | model-routing, ReasoningBank |
| `ruv-fann` | 52 → **779** | ruv-swarm, cuda-wasm, neuro-divergent |
| `qudag` | → **531** | post-quantum crypto core, exchange, MCP |
| `daa` | → **266** | orchestrator, economy, rules, swarm |
| `safla` | 0 → **136** | the metacognitive / self-modification layer |

Plus: the **“take the wheel” behavioral pipeline** (below), a **4-level behavioral test harness**, a build-integrity fix (empty files no longer pollute the index), and the private-store fence that keeps unpublished repos out of the public bundle.

---

## How it works

The expensive work happens **once, at build time**: every covered repo is deep-walked (whole files, full function bodies, plus a symbol index), embedded into **two** vector variants (MiniLM-384 for edge/portability, bge-768 for depth) stored on-disk in **RVF / HNSW**, and distilled into a concepts + capability layer of per-repo primers and cards. That's **128,994 source chunks**. At **query time**, `search_ruvnet` searches every repo's store at once, pools the hits, and runs them through **one cross-encoder rerank** on a common scale — so the truly relevant file wins regardless of which repo it lives in — then returns whole source files, each labeled by repo and path.

![RuvNet Brain architecture pipeline](assets/diagrams/architecture-pipeline.svg)

- **Per-repo RVF stores** — each repo gets its own HNSW graph; the tool queries across them and normalizes.
- **Dual embeddings + cross-encoder** — MiniLM-384 for edge/portability, bge-768 for depth; a single cross-encoder rerank puts every candidate on one comparable scale. (The cross-encoder — a third model reading query+passage together — is the real quality lever, not a fusion of the two embedders.)
- **Concepts / capability layer** — per-repo primers and capability cards let the model ground _capability_ claims and route a described need to the right repo, not just do file lookups.

---

## How it changes Claude's behavior — it takes the wheel

Grounding is **injected every turn, not left to chance.** On a RuvNet-relevant prompt the `UserPromptSubmit` hook injects a directive into context; Claude calls `search_ruvnet`, gets whole source files labeled by repo and path, and answers _from_ them. Because the hook's stdout is consumed by the harness every turn, the directive is _always there_ — a strong grounding nudge on every relevant turn. (It's a nudge, not a hard gate: the hook can't rewrite Claude's output, so it steers rather than blocks — see [ADR-0005](docs/adr/0005-behavioral-grounding-not-lock.md) for exactly what ships.)

![The grounding flow: prompt to cited answer](assets/diagrams/grounding-flow.svg)

And on a **build request**, the brain doesn't wait to be told each step — it runs the process **the way Ruv would**:

> **Propose the architecture first** → one go/no-go → then execute end-to-end: **SPARC** (Spec → Pseudocode → Architecture → Refinement → Completion) · model the domain (**DDD**) and capture **ADRs** · spin up **parallel Ruflo swarms** · persist decisions to **AgentDB** · treat design as a build step (**frontend-design + AI image generation**, never “working but ugly”) · **test → score 1–100 → loop to ≥98** · and it asks for an **API key** when a step needs one instead of silently skipping it.

The downstream effect: Claude **prefers RuvNet building blocks over generic defaults** (RVF/HNSW over pgvector/Pinecone, Ruflo swarms over hand-rolled orchestration) and drives the whole assess → build → verify → score loop rather than answering one question at a time.

---

## Capability-confidence routing

The brain answers **both** kinds of questions. **Name the repo or ask something specific** and it resolves to the right repo (**47/48, 98%**). **Describe a _need_ without naming the repo** — the way a newcomer would — and it still lands the right repo (**26/28, 93%**). That newcomer path used to be the weak spot (**33% before the fix**); adding **capability cards** — a capability-phrased passage per building block — closed the gap.

![Capability-confidence routing](assets/diagrams/capability-routing.svg)

---

## What it covers

32 of rUv's repos in the [ruvnet](https://github.com/ruvnet) org — the reusable **building blocks** you'd actually compose into a system — each deep-walked and embedded in both variants. The core blocks below also carry symbol indexes and capability cards (the 8 newest repos are findable by name; their capability cards are coming).

![The RuvNet stack the brain covers](primer/assets/diagrams/ruvnet-stack.svg)

| Repo | What it gives you | Repo | What it gives you |
|---|---|---|---|
| [`ruflo`](https://github.com/ruvnet/ruflo) | Agent orchestration / swarms | [`ruvector`](https://github.com/ruvnet/ruvector) | RVF + on-disk HNSW vectors |
| [`agentdb`](https://github.com/ruvnet/agentdb) | Agent memory + graph/Cypher | [`rulake`](https://github.com/ruvnet/rulake) | Vector cache layer |
| [`ruview`](https://github.com/ruvnet/ruview) | Camera-free WiFi/CSI sensing (presence, pose, vitals) | [`agentic-flow`](https://github.com/ruvnet/agentic-flow) | Cheap multi-provider model routing |
| [`agenticow`](https://github.com/ruvnet/agenticow) | Copy-on-write agent memory (branch 1M vectors in ~162 B) | [`sparc`](https://github.com/ruvnet/sparc) | 5-phase build methodology |
| [`qudag`](https://github.com/ruvnet/qudag) | Quantum-resistant DAG messaging | [`safla`](https://github.com/ruvnet/safla) | Self-aware feedback loop |
| [`ruv-fann`](https://github.com/ruvnet/ruv-FANN) | Fast neural nets (Rust/WASM) + ruv-swarm | [`daa`](https://github.com/ruvnet/daa) | Decentralized autonomous agents |
| [`synthlang`](https://github.com/ruvnet/synthlang) | Prompt compression (~75% token cut) | [`rupixel`](https://github.com/ruvnet/rupixel) | On-device visual embeddings |
| [`dspy.ts`](https://github.com/ruvnet/dspy.ts) | DSPy-style programmable LLM pipelines in TS | [`fact`](https://github.com/ruvnet/fact) | Fast-Access Cached Tools + circuit breaker |
| [`cve-bench`](https://github.com/ruvnet/cve-bench) | Security-fix benchmark | [`agent-harness-generator`](https://github.com/ruvnet/agent-harness-generator) | Harness scaffolding / metaharness |
| [`rvm`](https://github.com/ruvnet/rvm) | Proof-gated capability microhypervisor | [`rUv-dev`](https://github.com/ruvnet/rUv-dev) · [`open-claude-code`](https://github.com/ruvnet/open-claude-code) | Dev workflow + agent tooling |

> **Not in the public brain:** rUv's private **Cognitum One** repos (seed, v0-appliance, platform-docs) are fenced out of the download by design — verified zero-leak in every build. **Helix** (rUv's local-first health app) is a finished product, not a building block, so it's out too.

---

## Testing & proof

Everything below is **re-runnable** — the proof is the output of a command, not a claim.

```bash
bash scripts/gate.sh                              # the pass/fail routing gate
node scripts/behavioral-l1-l4.mjs                 # the 4-level behavioral harness
node plugin/test/run-tests.mjs                    # full plugin QA over real JSON-RPC
```

| Test | Result | What it proves |
|---|---|---|
| **Named / specific routing** | **47 / 48 (98%)** | name the tool → right repo |
| **Described-need routing** | **26 / 28 (93%)** | describe the need, no name → right repo (was 33% before capability cards) |
| **Context-scenario routing** | **7 / 8 (88%)** | full-scenario prompts route correctly |
| **L1–L4 behavioral harness** | **all pass** | route · deep-recall (returns _code_) · implement (cites the API) · orchestrate (the hook drives the full pipeline) |
| **Plugin QA** | **26 / 26** | manifests, hook firing, MCP `initialize`/`tools/list`, capability battery |
| **Clean-room install** | **3 / 3** | download the published 512 MB bundle fresh → unzip → query → grounded, cited answers |
| **Unit tests** | **257 passing** · 10% of ALL source covered | `npm run test:cov` — the floor fails CI if it slips. 10% is the honest number over every shipped file; the previous "75%" measured a hand-picked 8-file subset |
| **Grounding proof** | `npx ruvnet-brain --doctor` | asks a real question, then checks the cited path really exists in the on-disk store; a citation that doesn't resolve is reported as **NOT grounded** |
| **Held-out eval** | **grounded 100/100** · routed 63/80 | `npm run eval` — 120 frozen, hash-pinned questions across 5 strata, never used for tuning, graded on ground truth, never by a model |

<sub>The suite also carries **169 `it.todo` stubs** — a written backlog, each naming an untested behavior and what it would take to cover. They are deliberately **not** counted as tests: a stub proves nothing, and a number that flatters is worse than no number.</sub>

Two honest residuals, not hidden: one described question (_“route to cheaper models to cut cost”_) still leans `ruflo` over `agentic-flow` (orchestration/cost overlap); one unnamed _“methodology”_ question routes to `synthlang` instead of `sparc`. Proof reports land in [`PROOF.md`](PROOF.md), [`DESCRIBED-PROOF.md`](DESCRIBED-PROOF.md), and [`HELIX-DEMO-NOHELIX.md`](HELIX-DEMO-NOHELIX.md).

### The eval flywheel

Most of the numbers above were tuned against. [`evals/held-out.json`](evals/held-out.json) was not: **120 frozen, hash-pinned questions across 5 strata** (named, described, scenario, adversarial, provenance), phrased the way a newcomer would ask, each with the owning repo chosen **from first principles before the brain ever saw them**. `npm run eval` scores, among other things, two claims — both without asking a model's opinion:

- **grounded** — the cited passage genuinely exists in the on-disk store. A path that doesn't resolve is a *fabricated* citation, and is counted as a failure however plausible it reads.
- **routed** — the citation came from a repo that actually owns the capability.

`npm run eval:gate` fails the build (exit 1) if either score drops below [`evals/baseline.json`](evals/baseline.json) — and also if there is **no baseline at all**, since you cannot promote against nothing. Baselines are only ever written deliberately, with `npm run eval:record`; a baseline that silently follows the code is a ratchet with no teeth.

**Why not let an LLM grade it?** Because on this very repo an LLM panel scored a **zero-citation answer 98/100**. Model-as-judge is blind to the one failure that matters here.

Current baseline (n=120, [`evals/baseline.json`](evals/baseline.json)): **grounded 100/100 · routed 63/80 · abstain 18/20 · banner 20/20**, promotion gated on Wilson lower bounds. The routing misses are recorded, not tuned away — the recurring shapes: `"generate tests and find coverage gaps"` cites agentic-qe's real test generator, which lives *vendored inside the ruflo repo*, so the answer is right and the repo label is a corpus-attribution artifact; `"spend less money on model calls"` cites a genuine `agentic-qe/docs/guides/cheaper-model-eval-lanes.md`, the same cost/orchestration overlap noted above.

**Query it directly (CLI):**

```bash
cd kb
export KB_MODEL_CACHE=/path/to/models-cache
node forge-ask-all.mjs --dir . --q "How does RuVector implement HNSW vector search?" --k 3
```

> Cross-repo answer quality **requires the cross-encoder**, which requires `npm i` in the bundle. Without it, search falls back to raw vectors and ranks poorly.

---

## Honest status

This project versions in the open (see the live badge up top for the exact plugin version; the downloadable knowledge bundle is a separate track) — we don't claim “done,” “complete,” or “zero hallucinations.” Where it stands:

- ✅ **The grounding brain is real and proven** — 32 repos, 128,994 chunks, dual embeddings, cross-encoder rerank, plugin (MCP tool + enforcement hook + skill), all re-runnable.
- ✅ **Code-level depth** — the code-rich repos are indexed to full function bodies; “how is it implemented?” returns the implementation. Verified in the shipped bundle (clean-room 3/3).
- ✅ **Routing holds** — named 47/48, described 26/28, scenario 7/8; behavioral L1–L4 all pass; private stores fenced out of the public bundle (zero-leak verified).
- ⚠️ **Two routing residuals** (above) — surfaced, not hidden.
- ✅ **Published on npm** — `npx ruvnet-brain` (short form); `npx github:stuinfla/ruvnet-brain` always tracks the latest commit if you want it even fresher.
- ⏳ **The fully-autonomous engineering loop** ([ADR-0008](docs/adr/)) — the behavioral hook _drives_ the assess → SPARC → ADR/DDD → QA → score loop; a generalized always-loops-to-≥98 engine is the next phase.

---

## What's in the box

- `kb/` — the brain: per-repo `.rvf` + `.big.rvf` stores, full-passage sidecars, symbol indexes, per-repo primers, the concepts store, and the `forge-*` query tools (CLI + MCP `search_ruvnet`).
- `plugin/` — the Claude Code plugin (MCP server, grounding skill, `UserPromptSubmit` enforcement hook, marketplace manifest, test suite).
- `scripts/` — `gate.sh` (routing gate), `behavioral-l1-l4.mjs` (behavioral harness), `prove.mjs`, `build-bundle.mjs`, `brain-stamp.mjs`.
- `docs/` — [`VISION.md`](docs/VISION.md) (the why), [`adr/`](docs/adr/) (locked decisions incl. ADR-0008), [`DDD.md`](docs/DDD.md).
- `explainer/` — the source of the [live explainer](https://isovision.ai/ruvnet-brain/).
- `SPEC.md` · `PROGRESS.md` — the master spec and the living, timestamped build log.

The brain binaries ship via the [Release](https://github.com/stuinfla/ruvnet-brain/releases/tag/v0.5.0-dev), not git — a fresh clone is lightweight; `npx` fetches the 512 MB bundle.

---

## Links

- **▶ Live explainer:** https://isovision.ai/ruvnet-brain/
- **Download / Release:** https://github.com/stuinfla/ruvnet-brain/releases/tag/v0.5.0-dev
- **rUv's RuvNet org:** https://github.com/ruvnet
- **Built by:** [Stuart Kerr — Isovision.ai](https://isovision.ai)

<div align="center"><sub>MIT licensed · free & fair use · grounded in rUv's real source, cited every time.</sub></div>
