---
id: ADR-093
title: The proactive package recommender — "what would rUv do" from package cards, behind a flag
status: Proposed
date: 2026-10-01
updated: 2026-10-01
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [advocacy, hooks, recommendation, cards, evaluation]
supersedes: []
amends: [ADR-040, ADR-052]
---

# ADR-093 — The proactive package recommender

**Status**: Proposed (2026-10-01)

Implementation ships in 4.5, **default off** (`RUVNET_PACKAGE_RECOMMENDER`); see the decision run below.
Revision 2 (same day, below) adds the warm semantic lane; rev 1's lexical lane is now its cold fallback.

## Decision run — all 88 blind prompts on a real host (2026-10-01)

**Rule, fixed before the run:** flip the default ON only if, over all 88 blind prompts on a real host,
family-aware precision ≥ 90%, false firing ≤ 5% and recall ≥ 50%; otherwise stay opt-in.

**Run:** `scripts/recommendation-real-host.mjs --all-blinds --max-load 60 --batch 11`: 88 fresh `claude -p`
sessions (Claude Code 2.1.286), same isolation as the 22-prompt run (no session persistence, no
settings sources, no MCP, no tools, auto-memory off, temp brain home, warm worker with idle-exit off for
the harness only). No batch started above 1-minute load 60; the gate waited six times (21 min in total
before the first batch), and load climbed inside batches as other work ran (per-prompt load is recorded).
No project entry and no `~/.claude.json` entry was created for the run.

| (family-aware, Wilson 95%) | Real host, 88 prompts | Simulated host, same prompts |
|---|---|---|
| Recall | **22/52 = 42.3% [29.9–55.8]** | 26/52 = 50.0% |
| Precision | **22/25 = 88.0% [70.0–95.8]** | 26/27 = 96.3% |
| False firing | **0/36 = 0% [0–9.6]** | 0/36 |
| Agreement, same prompt | 82/88 = 93.2%; 59/65 = 90.8% where both saw a hint | — |

**Outcome: the rule is NOT met (recall 42.3% < 50%, precision 88.0% < 90%). The recommender stays
opt-in (`RUVNET_PACKAGE_RECOMMENDER=1`); the default was not flipped.** The real model is quieter than the
simulated one: it declined 3 hinted needs the simulated host took (e.g. a browser-only vector search, a
prompt-injection need, a demand-forecasting need), and its 3 wrong picks were siblings outside the
accepted product (`@agentic-flow/ephemeral-memory` for a need labelled `agentdb`/`@claude-flow/memory`;
`@claude-flow/memory` for one labelled `ruvector-agent-memory`/`ruvector-temporal-coherence`;
`wifi-densepose-calibration` for WiFi presence). Correction recorded in the run file: the first
parser did not see the closed catalogue's "capability advocacy" copy, so 2 catalogue rows (Q088
agentic-flow, Q141 agentic-qe) were re-derived from the stored answers; `real-host-88.raw.json` keeps the
original, and the harness parser is fixed.

**Hint delivery vs load** (a hint the pipeline would give, actually injected by the real hook):

| 1-min load at the prompt | Delivered |
|---|---|
| 0–60 | 14/14 |
| 60–120 | 19/19 |
| 120–240 | 5/5 |
| ≥ 240 | not sampled in this run (load gate) |

Earlier ungated runs give the busy-laptop end: 13/16 at load 130–190 (22-prompt real-host run) and
64/75 semantic hints inside the 250 ms budget at load 259–345 (`timing-default-budget-load259.json`).
Below roughly load 120 delivery was complete; it degrades to ~80–85% under very heavy load, by falling
back to the lexical lane or silence, never by waiting.

## Revision 3 — products, the core-tier fix, and a real host

### What changed

1. **Products, derived not typed** (`scripts/package-cards.mjs` `deriveProducts`). Three rules over
   repo + manifest facts: R1 flagship (a package named for its repo, whose family key is the repo, or
   whose manifest is at the repo root), R2 `@scope/cli|core|main|sdk` → the unscoped `scope` package's
   product, R3 a shared family key across repos only when the key is a flagship's or a product the corpus
   names (`## <name>` in the public capability-cards.md). 795 cards → 779 products; 5 span repos
   (aidefence, qudag, rulake, ruv-fann, rudevolution). Every card carries `product` and `canonical`
   (npm over crate, repo-named, no -core/-wasm suffix, shortest). The hint and the lexical lane name the
   canonical install; candidates are de-duplicated by product (the worker returns 8, the hint shows ≤ 4
   products). Scoring has a family-aware mode (`--family`); strict stays the default.
2. **Core tiers.** `agenticow` moved T2 → T1 in `data/registry.tiers.json`: it is published
   (`npm view agenticow version` → 0.2.4), has a corpus store, and 4 needs across the three sets were
   unreachable without it. SIDE EFFECT: the tiers file also sets ingest depth and the tier label in the
   bundle manifest, so agenticow will be ingested at T1 depth (full+L2+primer) on the next corpus build.
   `cognitum-cogs` (1 blind need) was NOT added: `cog-fall-detect` and `cog-health-monitor` do not exist
   on crates.io, and its 127 appliance crates were the largest noise source in rev 1.
3. **Nothing tuned on a blind set.** The floor rule (5th percentile of the nearest card's similarity
   among correctly-judged SELF-set hits) was re-run on the rev-3 pipeline and gave 0.532 again; K, tiers
   and the product rules were fixed before either blind set was scored.

### Measured (corpus 2026-10-01T11:01Z; `evals/runs/2026-10-01-recommender-4.6/rev3/`)

**Simulated host** (Opus agent, prompt + exact hint only), all 88 blind prompts, frozen floor 0.532:

| | Recall | Precision | False firing |
|---|---|---|---|
| Blinds 1+2, strict = family-aware | **26/52 = 50.0% [36.9–63.1]** | **26/27 = 96.3% [81.7–99.3]** | **0/36 [0–9.6]** |
| Blind-1 | 12/24 = 50.0% | 12/13 = 92.3% | 0/16 |
| Blind-2 | 14/28 = 50.0% | 14/14 = 100% | 0/20 |

Hints injected on blind negative prompts: 4/36. (Strict and family-aware coincide because the hint now
names canonical installs, so the judge picks the canonical id.)

**Real host** (`scripts/recommendation-real-host.mjs`): 22 fresh `claude -p` sessions, Claude Code
2.1.286, the user's own login, `--no-session-persistence --setting-sources '' --strict-mcp-config
--tools ''`, this checkout's UserPromptSubmit runtime as the only hook, auto-memory disabled, a warm
worker in a temp brain home; stratified from the blinds (12 needs, 4 negatives with a hint — all there
were above the floor — 6 prompts expected to get no hint):

| | Value |
|---|---|
| Recall (family-aware) | 8/14 = 57.1% [32.6–78.6] |
| Precision (family-aware) | 8/9 = 88.9% [56.5–98.0] |
| False firing | 0/8 [0–32.4] |
| Hint actually delivered where the pipeline would hint | 13/16 = 81.3% (load ~130–190) |
| Agreement with the simulated host, same prompts | 19/22 = 86.4%; 16/17 = 94.1% where both saw a hint |

The one wrong real-host recommendation named `wifi-densepose-calibration` for a WiFi presence need
labelled with two RuView-adjacent crates. One apparent false firing was a parser artefact ("write the
migration" matched the short name of `@claude-flow/migration`); the parser now requires a scoped/
hyphenated id or a sentence that names rUv, re-derived on the stored answers (`real-host.raw.json` keeps
the original). Writes to the user's ~/.claude: the first smoke run created one empty
`projects/<temp-cwd>/memory` directory (auto-memory), which I removed; the harness now disables
auto-memory, and the 22-session run created no project entry and no `~/.claude.json` entry.

**Latency at the shipped defaults** (250 ms budget, floor 0.532), 161 paired cold hook runs at load
259–345: added p50 110 ms, p90 275 ms, max 550 ms; 64 of 75 expected semantic hints delivered (11 fell
back to the lexical lane or silence inside the budget).

### Verdict against the default-ON bar (recall ≥ 50%, precision ≥ 90% family-aware, false firing ≤ 5%, p90 ≤ 300 ms)

- On the pre-registered measurement (all 88 blind prompts, simulated host): **met** — recall exactly
  50.0% (lower bound 36.9%), precision 96.3%, false firing 0/36, p90 275 ms at load ≥ 259.
- On the real host (n = 22): recall 57.1%, false firing 0/8, but precision **8/9 = 88.9%** — one wrong
  pick, below 90% at the point estimate; the interval is too wide to decide either way.
- Recall sits exactly on the line with a wide interval; a different judge run could land either side.
- Delivery under heavy load is 81–85%: the hook stays silent rather than slow, so recall in the field
  depends on machine load.

## Revision 2 — the meaning-based lane in the already-warm worker

### Options evaluated

| Option | What | Verdict, with the evidence |
|---|---|---|
| (a) | The warm search worker (`kb/forge-mcp-all.mjs`, bge-base embedder already loaded) exposes a private local endpoint; the hook asks it within a budget | **Chosen.** Warm query 25–76 ms p50 in-process; end-to-end hook added latency below. Reuses the worker's own `embed()` (forge-ask) and `@ruvector/rvf` `db.query()` — no second embedder, no hand-rolled cosine |
| (b) | Attach the recommendation to `search_ruvnet` output or Stop-time grounding | **Rejected.** The typesafe miss happened because the model never searched; Stop-time is after the answer. It cannot fire on the turn that needs it |
| (c) | Embed the package cards at corpus build time into an `.rvf` the reader loads once | **Adopted as the index for (a)** — but built at RELEASE time beside the card snapshot (`plugin/scripts/package-cards.rvf`, 2.6 MB, 848 vectors), not in the nightly corpus, because sealing a new file into the corpus bundle changes the sealed inputs' contract (the selection receipt is the allowlist; `capability-cards.md` is already a sealed input of `concepts`) |

### Decision (rev 2)

1. **Index.** `kb/package-cards-index.mjs` embeds each card in the T0+T1 tiers of
   `data/registry.tiers.json` (496 cards; a pre-existing repo rule, not chosen against the eval) with
   the corpus's own bge-base passage config, twice when the package directory has a README (manifest
   line = what it is; README excerpt = what it is for). `package-cards.rvf.meta.json` binds the vectors
   to the exact card bytes AND the exact `.rvf` bytes (sha256 each); a mismatch is refused before the
   native reader opens anything, never mis-mapped.
2. **Endpoint.** `kb/recommend-endpoint.mjs`, started by the worker's `brain/warmup` ONLY when
   `RUVNET_PACKAGE_RECOMMENDER` is on. Unix socket (named pipe on Windows) in a 0700 `run/` dir under the
   Brain cache, a 0600 descriptor with a random token every request must carry, 8 KiB request cap, k ≤ 10.
   Dead workers' descriptors are swept; SIGTERM cleans up. The worker opens only a directory that looks
   like the plugin's card snapshot, holds one index at a time, never caches a failed open, and compares
   the token in constant time. Endpoint traffic does NOT reset the worker's idle-exit clock (#122): when
   the worker retires (15 min without a search, or the shell's 30-min idle kill) the hook falls back to
   the lexical lane. The hook trusts a descriptor only when `run/` and the file are private to the user,
   the schema and pid match, the pid is ours and alive, and the socket lies inside `run/` (POSIX; on
   Windows the per-process token is the only guard).
3. **The hook does not pick; the model does.** On a design/diagnosis prompt the catalogue did not
   match, the hook asks the warm worker (250 ms budget, counted from the hook's own start, env override
   clamped to 1 s) for the 4 nearest cards and, if the nearest clears cosine **0.532** (the 5th percentile
   of top-1 similarity among correct self-set hits — chosen on the self set only), injects them with
   one instruction: mention at most ONE, only if it materially fits, else say nothing. Measured below:
   the embedding finds candidates (blind recall@4 well above recall@1) and the model judges fit far
   better than any similarity threshold did.
4. **Cold fallback.** No live endpoint, a refused connection, or no answer inside the budget → rev 1's
   lexical lane (fast, 0 blind false firings) or silence. Never slower than the budget.
5. **Session policy.** ONE candidate set per session until a real host run shows the model stays quiet
   on negatives. A package offered or dismissed is dropped from later sets. A set resolves only when the
   user names a full package id or a distinctive short name — never on a bare "ok"/"no", never on a
   common word (`memory`, `router`, `server`…). The ledger row is the set's top id: APPLIED means the
   user took one of the set.
7. **Default-off costs nothing.** With the flag off the route does not import the matcher, the card
   reader or the socket client (they are dynamically imported only when the flag is on), reads no
   state file for a prompt no lane wants, and the worker starts no endpoint.
6. **Freshness.** Cards and their RVF ship as a snapshot. `node scripts/package-cards.mjs --check`
   detects drift against an installed corpus; `--max-age-days 14` fails a stale snapshot at release.

### Measured (2026-10-01, corpus 2026-10-01T11:01Z)

Sets: self-authored 73 (used for every choice), blind-1 40 (written by an agent that never saw the
matcher), blind-2 48 (a second, independent agent; added for rev 2). Thresholds/parameters were chosen on
the self set ONLY; the shipped config was frozen before either blind set was scored.

**Retrieval ceilings (semantic, before any gating):** top-1 correct on blinds 8/24 and 8/28; top-3
12/24 and 14/28. No similarity threshold can reach 50% recall from top-1 — measured sweeps on the self
set gave ≤ 22/47 at ≤ 5% false firing; the pre-registered threshold configs scored 8/24 and 7/28 on the
blinds with 2 false firings. The cross-encoder rerank did not raise top-1 (ce@1 = sem@1) and costs
130–260 ms. Those are why the model judges instead.

**The shipped pipeline end to end** (`scripts/recommendation-e2e.mjs`: real worker + real hook per
prompt, budget raised to isolate quality; then an Opus agent that saw only the prompt and the exact
injected hint decided what it would say; `scripts/recommendation-judge-score.mjs`, Wilson 95%):

| Set | Recall | Precision | False firing | Wrong package |
|---|---|---|---|---|
| **Blinds 1+2 (52 needs, 36 negatives)** | **27/52 = 51.9% [38.7–64.9]** | **27/31 = 87.1% [71.1–94.9]** | **0/36 = 0% [0–9.6]** | 4 |
| Blind-1 | 14/24 = 58.3% [38.8–75.5] | 14/16 = 87.5% | 0/16 | 2 |
| Blind-2 | 13/28 = 46.4% [29.5–64.2] | 13/15 = 86.7% | 0/20 | 2 |
| Self (tuning set) | 34/47 = 72.3% | 34/34 = 100% | 0/26 | 0 |
| **Blinds 1+2 with the shipped 0.532 floor** | **22/52 = 42.3% [29.9–55.8]** | **22/25 = 88.0% [70.0–95.8]** | **0/36** | 3 |

The floor row applies the frozen floor to the same judged run (a prompt whose nearest card is below
the floor gets no hint, so the judge's pick for it is void): it cuts hints injected on blind NEGATIVE
prompts from 16/36 [29.5–60.4%] to 4/36 [4.4–25.3%] — less context noise on prompts that need nothing —
at a cost of 5 correct recommendations. `semantic-quality/similarity-floor-0.532.txt`.

Of the 4 blind "wrong packages", 3 name the same product as an accepted id under a different package
(`@ruvnet/ruview` for a RuView presence need labelled with two RuView crates; `@claude-flow/cli` for a
swarm need labelled `ruflo`/`claude-flow`; `aidefence-core` for a prompt-leak need labelled
`@claude-flow/aidefence`). Counting those as correct would give 30/31 = 96.8% — reported here, NOT used as
the headline; the labels were not changed.

**Added prompt latency** (paired cold hook runs, flag off vs on, warm worker, default 250 ms budget,
161 prompts each; `semantic-latency/`). The machine never held load < 60 for a whole run (other agents):

| Run | Load (1-min) | Added p50 | Added p90 | Added max | Semantic answers inside budget |
|---|---|---|---|---|---|
| 1 | 153 at end | 72.3 ms | 255.5 ms | 1,027 ms | 102 of 111 (9 fell back) |
| 2 | < 60 at start, 192 at end | 58.3 ms | 243.1 ms | 2,642 ms | 103 of 111 |

p90 ≤ 300 ms held in both. The max is a scheduler stall at load ~190 (flag-off runs stalled too: flag-off
p90 519 ms in run 2), not the socket wait, which the budget bounds. These runs predate the fixes that start
the budget at the hook's own start and stop loading the matcher when the flag is off; they were not re-run.

### Verdict against the bar (recall ≥ 50%, false firing ≤ 5%, precision ≥ 90%, added p90 ≤ 300 ms)

- False firing (what the model SAID on negatives): **met** — 0/36 with or without the floor.
- Recall ≥ 50%: **met only without the floor** (51.9% pooled point estimate; blind-2 alone 46.4%; the
  interval 38.7–64.9 does not establish it). **With the shipped floor: 42.3% — not met.**
- Precision ≥ 90%: **not met strictly** (87.1% / 88.0%); met only under the same-product adjudication.
- Added p90 ≤ 300 ms: **met** in both runs (243–256 ms), at load far above 60.
- The judge is an Opus agent standing in for the host; no real Claude Code or Codex session was run.
- Adversarial Opus review of the full diff (2026-10-01): two High (no similarity floor; candidate sets
  corrupting the ledger) and four Medium findings — all fixed above, each with a red/green test.

**Recommendation: keep the flag default OFF for 4.5.0; offer it as an opt-in.** The bar is not met
strictly. Defaulting on needs (1) one real-host run of the blind sets, (2) a product-family map so
`aidefence-core`/`@claude-flow/aidefence` or `@claude-flow/cli`/`claude-flow` count as one product, which
would lift precision past 90% on these runs, and (3) agenticow promoted into T0/T1 in
`data/registry.tiers.json` (two blind needs were unreachable because it is T2).

## Owner requirement

On 2026-09-30 the owner had to name `@ruvector/typesafe` himself. The Brain held that package's
manifest (`ruvector/npm/packages/typesafe/package.json`, confirmed with `search_ruvnet`) and said
nothing, because nothing on the prompt path could reach a package that a person had not hand-written
into a list. The requirement: on a design or diagnosis prompt, name the ONE rUv package that fits,
with its source path, unprompted — and stay silent otherwise.

## What exists today (read before deciding)

| Piece | File | What it does | Why it cannot do this job alone |
|---|---|---|---|
| Delivery chokepoint | `plugin/scripts/unprompted-runtime.mjs` | Sole writer of unprompted bytes; applies the 1–5 dial (ADR-052) and the DismissalLedger; records OFFERED | Correct as is — reused unchanged |
| Recommendation producer | `plugin/scripts/advocacy-route.mjs` | Lexical matcher, session cap 1, persist-before-speak, lifecycle (applied/dismissed/ignored) | Matches only the catalogue below |
| Closed catalogue | `plugin/scripts/advocacy-catalog.mjs` | 7 intents → 7 building blocks, two-cue rule | Closed by design; grows only by hand |
| Repo cards + fast lane | `kb/capability-cards.md`, `kb/card-lane.mjs` | One card per REPOSITORY; zero-ML overlap gate for `search_ruvnet` | Repo granularity: the ruvector card cannot say "typed decisions" or "BM25 + ANN fusion"; and the plugin cannot import `kb/` (issue #32) |
| Manifest passages | `<kb>/<store>.passages.jsonl` | The corpus already ingests every `package.json` and `Cargo.toml` as a passage with path, description, keywords | Nobody reads them as cards |

`capability-cards.md` is also a **sealed input of the derived `concepts` store** (`kb/forge-update.mjs`
~667), so adding ~800 package sections to it would change corpus receipts. Package cards therefore
live in their own file.

## Decision

1. **Package cards, derived, not written.** `scripts/package-cards.mjs` reads the manifest passages of
   every PUBLIC store (a `## <store>` card in `kb/capability-cards.md`, minus `kb/PRIVATE-STORES.json`)
   and emits one card per installable package: id, kind (npm|crate), description, keywords, `source`
   (`<store>/<path>`), `sourceSha256` of the passage. It drops examples/tests/vendored copies,
   per-platform binaries and description-less manifests, prefers the scope owner
   (`kb/package-owners.json`) over vendored copies, and collapses a family (`@ruvector/gnn`,
   `-wasm`, `-node`, crate) into one card with `variants`. Every word on a card is copied from a
   manifest — the same grounding line `scripts/card-from-source.mjs` draws. Measured on corpus
   2026-10-01T11:01Z: 1,703 manifest passages in 175 public stores → **795 cards**; all seven packages
   the 4.5 plan names are present.
2. **A lexical lane over those cards, in the hook.** `plugin/scripts/package-recommender.mjs`: the
   card lane's tokenizer (copied; parity held by test), a light stemmer, IDF weighting (800 cards share
   "vector", "search", "rust"), a short list of ordinary-language → manifest-language expansions that
   never name a package, and five gates — overlap ≥ 2, a name/keyword hit (or overlap ≥ 3), IDF score
   ≥ 7, coverage ≥ 0.15, and a **1.25× margin over the best card of another family**. A near-tie is
   silence. A prompt that is not design- or diagnosis-shaped is silence.
3. **Through the existing chokepoint, unchanged.** `advocacy-route.decide()` consults the package lane
   ONLY when the closed catalogue is silent AND `RUVNET_PACKAGE_RECOMMENDER` is an explicit opt-in
   (`1|on|true|yes`). The candidate is an ordinary advocacy candidate: finding id
   `recommend:pkg:<package>`, severity `normal`, observation hash over the package id. The dial, the
   DismissalLedger, the OFFERED record, the session cap (1 across both lanes) and the
   accept/decline lifecycle ("use typesafe") all apply as they do today. Copy is ONE line naming the
   package, its manifest description, and its source path, and tells the model to confirm with
   `search_ruvnet` before building.
4. **Card source precedence**: `RUVNET_PACKAGE_CARDS` → `<RUVNET_BRAIN_KB>/package-cards.json` (the
   bundle copy, phase 2) → `plugin/scripts/package-cards.json` (the shipped snapshot). A card file
   with the wrong schema is skipped; none readable → silence.

### Phases

- **P1 (this branch):** generator, snapshot, matcher, flag default-off, eval sets, tests.
- **P2 (not built):** seal `package-cards.json` into the nightly corpus bundle (`build-bundle.mjs`
  selection + receipt) so cards refresh nightly with the corpus; until then the snapshot is refreshed
  by `node scripts/package-cards.mjs --write` and `--check` detects drift. P2 is deliberately unbuilt
  while the recommender is default-off: it changes sealed corpus inputs.
- **P3 (gated on the numbers below):** a semantic lane — see Alternatives B.

## Alternatives compared

| | Approach | Recall on a blind set | False firings | Hook cost | Verdict |
|---|---|---|---|---|---|
| A | Grow the closed catalogue by hand | High for what is listed, 0 for the rest | Low | ~0 | The failure this ADR exists for: typesafe was never listed |
| **B** | **Embed prompt + cards in the hook** | Not measured | Not measured | Embedder cold init ~3 s (measured, advocacy-route header) vs 3 s hook timeout | Dead on arrival in the hook. Viable only with a WARM embedder (the MCP server process) and the hook reading its answer — a P3 design, needs its own ADR |
| C | Repo-level `card-lane.answerFromCards` on the prompt | Not measured here; repo granularity cannot name a package | Repo cards include ~100 auto-derived cards of small repos | Low | Wrong granularity; also refuses scoped-package text by design |
| D | Model-side only: SKILL.md tells the model to call `search_ruvnet` | Depends on the model; Codex called it 0/6 times (2026-09-10, advocacy-route header) | n/a | 0 | Already in place; it is what failed for typesafe |
| **E** | **Package cards + lexical lane in the hook (chosen for P1)** | **5/24 = 20.8% (blind)** | **0/16 (blind)** | **+11.5 ms p50** | High precision, low recall; shippable only as opt-in |

## Measurements (2026-10-01, snapshot corpus 2026-10-01T11:01:11Z)

Eval sets: `evals/recommendation-eval.v1.json` (73 prompts written by the implementer BEFORE tuning:
31 design, 16 diagnosis, 16 off-topic, 10 no-fit; split dev/heldout) and
`evals/recommendation-eval.blind.v1.json` (40 prompts written by a separate agent that never saw the
matcher: 14 design, 10 diagnosis, 8 off-topic, 8 adversarial no-fit). No prompt is copied from a
session. Wilson 95% intervals. Raw rows: `evals/runs/2026-10-01-recommender-4.6/`.

Gates v1 were tuned on `dev` only, then frozen and run once on `heldout` and once on `blind`. The blind
run exposed two prompt-shape defects (an unconditional "ok …" opener rule silenced dictated prompts;
"forgotten"/"problem" were not diagnosis cues); gates v2 fixed only those. **v2's blind number is
therefore post-hoc**; the clean blind number is v1's.

| Set | Gates | Recall (positives) | Precision (all firings) | False firing (negatives) | Wrong package |
|---|---|---|---|---|---|
| dev (tuned on) | v2 | 20/24 = 83.3% [64.1–93.3] | 20/20 = 100% [83.9–100] | 0/13 = 0% [0–22.8] | 0 |
| heldout (same author) | v2 | 12/23 = 52.2% [33.0–70.8] | 12/14 = 85.7% [60.1–96.0] | 1/13 = 7.7% [1.4–33.3] | 1 |
| **blind, clean** | **v1** | **4/24 = 16.7% [6.7–35.9]** | **4/4 = 100% [51.0–100]** | **0/16 = 0% [0–19.4]** | 0 |
| blind, post-hoc | v2 | 5/24 = 20.8% [9.2–40.5] | 5/5 = 100% [56.6–100] | 0/16 = 0% [0–19.4] | 0 |
| all 113 | v2 | 37/71 = 52.1% [40.7–63.3] | 37/39 = 94.9% [83.1–98.6] | 1/42 = 2.4% [0.4–12.3] | 1 |

The one false firing (heldout H10, "migrate the cron job to a github action") named `ruvdrone` on
"github action"; the one wrong package (heldout D10, GNN rerank) named `@ruvector/postgres-cli`, whose
description lists GNN layers. A v2 candidate that added "can we/can you" as a design cue raised blind
recall nothing and produced two blind false firings (a git-branch chore and a CI-cache request); it was
reverted.

**Why recall is low, from the rows:** most blind misses are vocabulary, not gating — "a throwaway copy
of what it knows" vs "copy-on-write branching", "talk it into ignoring its rules" vs "prompt
injection", "the same question worded differently" vs "semantic query cache". A lexical lane cannot
bridge paraphrase without a hand-grown synonym table, and a hand-grown table is the closed catalogue
again. All 19 blind v2 misses were silences, none a wrong package: 6 overlap (fewer than two shared
words), 7 coverage, 4 margin (two families tied), 1 no strong token, 1 not design/diagnosis-shaped.

**Added latency per prompt** (`scripts/recommendation-latency.mjs`): cold `node advocacy-route.mjs`
per prompt, flag off vs on interleaved, 226 paired runs on darwin arm64 16 vCPU, node v24.18.0, load
average ~60 (other agents running): **added p50 11.5 ms [9.3–13.2], p90 36.7 ms [32.0–67.3]**
(bootstrap 95%); absolute flag-on p50 160 ms, p90 244 ms, inside the producer's 1,500 ms budget and the
runtime's 2,000 ms deadline under a 3,000 ms hook timeout. Flag OFF: an A/B of the module import alone
showed no detectable difference (paired p50 −14 ms, noise-dominated at load ~255).
In-process: index load 11–19 ms (cards ship pre-tokenized, `TOKENIZER_VERSION`), one decision 5–7 ms.

## Upstream currency check (2026-10-01)

`ruvnet_registry_latest`: ruvector 0.3.3, ruflo 3.49.0, agentic-flow 2.1.3, agentic-qe 3.14.6.
`npm search @ruvector` returned 134 packages; 50 are carded (as a lead or a family variant), most of
the rest are per-platform binaries, and **16 non-platform packages have no card** — e.g.
`@ruvector/rvlite`, `@ruvector/rabitq-wasm`, `@ruvector/acorn-wasm`, `@ruvector/edge`,
`@ruvector/edge-net`, `@ruvector/learning-wasm`. None of the 16 has a manifest passage in the corpus at
all (their `package.json` is build output, not committed source), so this is corpus coverage, not a
generator filter. Four carded packages trail npm (`@ruvector/core` 0.1.17 vs 0.1.32,
`@ruvector/attention` 0.1.4 vs 2.2.2, `@ruvector/node`, `@ruvector/rvdna`); cards carry the corpus
version, never claim "latest". Closing the 16 is a P2 question: card from registry metadata
(description/keywords, cited to the registry) where the corpus has no manifest.

## Recommendation (rev 1, lexical lane only — superseded by the rev 2 verdict above): do NOT default it on yet

Precision and false firings meet the bar (0 false firings on 16 blind negatives, upper bound 19.4%;
100% precision on blind firings, n=4–5). Recall does not: **about one in five real needs** on the
blind set. Defaulting it on would be honest (it rarely speaks wrongly) but would not deliver the
owner's requirement — it would still have missed most paraphrased typesafe-class needs. Turn it on by
default when a blind set of ≥ 40 positives shows recall ≥ 50% with false firing ≤ 5% (upper Wilson
bound ≤ 15%), which needs P3: a warm semantic lane fed by these same cards. Until then it is useful
opt-in for owners who want the extra hits and accept the silence.

## What was NOT tested

- A real host session (`claude -p --include-hook-events`) showing the model relaying the line — the
  tests prove CANDIDATE DELIVERED at the runtime boundary, not USER SAW IT.
- Windows/Linux latency; the 2-vCPU CI runner.
- The full runtime with anticipate.sh and lesson-hooks as co-producers (tests inject only the route
  through `RUVNET_UNPROMPTED_PRODUCERS`, because those producers read the real machine).
- Accept (as opposed to decline) for a package offer; the decline path, the ledger rows and `--summary` are tested.
- Nightly freshness (P2 is unbuilt; the snapshot is as old as its last `--write`).
- Full repository suites under an isolated HOME (the agent sandbox refused HOME/GIT_CONFIG overrides);
  focused suites ran with every writable path redirected to temp dirs.
