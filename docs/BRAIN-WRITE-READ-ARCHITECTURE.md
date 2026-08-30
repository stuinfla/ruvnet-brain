# RuvNet Brain — How We Write It, How We Read It, and Exactly What's Going Wrong

Updated: 2026-07-18 (later still) | Author: build session | Status: diagnosis complete; Fix C (hybrid retrieval) SHIPPED, see [ADR-0025](adr/0025-hybrid-retrieval-and-self-retrieval-gate.md); Fixes A/B pending

> Written after the meeting-store exam scored 19/50 cross-repo, then 18/25 when scoped — which
> proved the content is sound and the **retrieval** is the defect. Every claim below is read from the
> actual code (`kb/forge-build.mjs`, `kb/forge-ask.mjs`, `kb/forge-ask-all.mjs`) and the exam evidence,
> not from memory.

---

## TL;DR (the one paragraph)

Writing the brain works. Reading it is tuned for **one shape of content** (code repositories) and **one
shape of question** ("what does repo X do / how is Y implemented"), and it silently fails on a
**different shape** (a meeting transcript; a question like "what did rUv say about Colby" or "what's the
gist ID"). Three concrete mechanisms cause it, all in the READ path, none in the stored content. The
fix is retrieval-layer, not re-encoding. It was never caught because the only exams we ever ran tested
the content the reader was tuned for.

---

## 1. How we WRITE the information (`kb/forge-build.mjs`)

For each repo we:
1. **Walk the whole source tree**, categorize every file into a `kind` (source / crate-src / adr / doc /
   doc-deep / primer-orientation / manifest / example / test …).
2. **Chunk the text** — paragraph-aligned, **~4000 chars (~1000 tokens) per chunk, 400-char overlap**
   (`chunkText`, forge-build.mjs:315-318). Empty chunks are dropped.
3. **Embed every chunk** with a local ONNX model, and write **two variants from the same passages**:
   - **small** = `Xenova/all-MiniLM-L6-v2`, 384-dim → `<name>.rvf`
   - **big** = `Xenova/bge-base-en-v1.5`, 768-dim → `<name>.big.rvf`
   Model weights are **pinned to exact commit SHAs** so an upstream re-publish can't silently shift
   embeddings (forge-ask.mjs:63-66).
4. **Write the sidecars** that make retrieval possible:
   - `<name>.passages.jsonl` — the **FULL untruncated chunk text**, keyed by numeric id. This is the
     source of every answer; the .rvf only stores vectors + ids.
   - `<name>.meta.json` — `id → {path, kind, title, chunk, of}`.
   - `<name>.symbols.json` — `symbol/package → source path`, so code questions can hard-route.
   - `<rvf>.embed.json` — which embedder built this store (so queries embed with the SAME model).

**This half is correct and reproducible.** The meeting rebuild followed it — except it used **~900-char
chunks** (finer, for conversational turns) and packed the whole transcript under **one logical path**
(`ruv-meetings/2026-07-16/raw-transcript`). Hold that fact — it matters in §3.

---

## 2. How we READ it (`kb/forge-ask.mjs` → `kb/forge-ask-all.mjs`)

A single question runs a **two-level pipeline**:

### Level 1 — per store (`searchKb`, forge-ask.mjs)
1. Embed the query with that store's pinned embedder.
2. **Vector search** the HNSW index: `db.query(qv, max(24, k*4))` → up to 24 raw chunk hits
   (forge-ask.mjs:738). *This is pure cosine similarity — no keyword/lexical retrieval over bodies.*
3. **Collapse chunk-hits into documents** keyed by `path`; a document's score = its single best
   chunk's distance (forge-ask.mjs:741-747).
4. **~15 intent heuristics re-score the documents** (forge-ask.mjs:276-830). Every one is
   repo/code/ADR-shaped: PRIMER force-routing for orientation archetypes; crate-name detection;
   symbol routing (identifier→source file); code-vs-design tilt; ADR-id exact match + status parsing;
   crate-overview/metric/maturity boosts; **`lexicalBoost` = query-term overlap in the path + title**;
   LOW_SIGNAL demotion of readmes/tests/benches.
5. **Assemble the full document**: center a **12,000-char window on the matched chunk** and grow
   outward (forge-ask.mjs:640-688). Anything past 12k from the match is dropped.

### Level 2 — across all 68 stores (`searchAll`, forge-ask-all.mjs)
1. Fan out to every store (bounded to 5 concurrent), **pool = 8 candidates each** → ~544 candidates.
2. **ONE cross-encoder rerank** (`rerankPairs`) over the whole pool → a single comparable relevance
   scale (forge-ask-all.mjs:72).
3. **NAME_BOOST +2.0** to a candidate **only if the query literally names its repo** (word-boundary
   match, plus aliases like agent-harness-generator→metaharness) (forge-ask-all.mjs:81-102).
4. Sort by cross-encoder score, return top-k.

---

## 3. What's going wrong — three mechanisms, all in the READ path

### Mechanism A — Cross-store dilution: dense formal docs out-rank the conversation
**Evidence (exam Q22, "what did rUv say about Colby"):** cross-repo top-4 = ruflo/ADR-313,
metaharness/ADR-204, cognitum/RATE_LIMITING, cognitum-trader. The actual meeting transcript — which
contains "6 Anthropic, 4 OpenAI, Colby" — **was not in the top 4.** Scoped to `ruv-meetings`, that same
transcript turn is the #1 hit and answers perfectly.

Why: (1) the **cross-encoder rewards dense topical prose** — a formal ADR about sponsored capacity
looks "more relevant" to an account-limits query than a rambling transcript turn does. (2)
**`lexicalBoost` rewards path+title term overlap** — an ADR's path/title is full of on-topic words;
a transcript chunk's title is a **timestamp** ("turns 29:23–29:59") with zero topical signal, so it
never earns the boost. (3) **NAME_BOOST never fires** — "what did rUv say about Colby" doesn't contain
"meetings", so the meeting store gets no +2.0. Repo questions ("what can SAFLA do") *do* name their
store and get boosted; conversational questions structurally cannot.

**Net: every lever in the reader tilts toward the formal doc and away from the transcript.**

### Mechanism B — Within-store needle miss: the transcript is one giant document
Because all 83 transcript turns share **one path**, step 3 collapses them into **one candidate**, and
step 5 returns a **12,000-char window centered on the topically-matched chunk**. A needle fact (a swarm
ID, the gist hash) that sits far from the topical match is **outside the window and never returned** —
even when you scope directly to the meeting store. That's why 7/25 still failed scoped: the fact is in
the store, but not inside the one window the reader assembled for that query.

### Mechanism C — Exact-string needles are unfindable by design
The reader retrieves by **vector similarity only** (step 2). A gist ID like
`e1008e2a4aa13bf2a991e6aca4028d03` or a flag like `--dangerously-bypass-approvals-and-sandbox` has **no
semantic meaning** — cosine similarity can't rank it, and `lexicalBoost` only checks path/title, never
passage **bodies**. There is **no BM25/keyword index over the text**, so exact-string facts are found
only by luck of the surrounding prose. (Note: `ruflo memory search` ships `-t hybrid` and RVF builds a
full-text sidecar — hybrid retrieval is a known RuVector capability the forge reader simply doesn't use.)

---

## 4. Why these fixes weren't done before (the honest answer)

The read pipeline is **excellent — for the content it was built for.** Every heuristic in §2.4 is
code/ADR/crate-shaped, because until 2026-07-17 **every store in the brain was a code repository.** The
validation battery (v0.5: described 26/28, named 47/48, scenario 7/8, L1–L4) tested exactly that: repo
capability questions that **name the repo** and whose answer **is a formal doc**. Under those
conditions the reader is right, and it scored right.

**The meeting was the first non-repo content ever ingested, and tonight was the first exam to ask
conversational and needle-fact questions.** The gate was real; its question set never exercised this
content shape, so the mismatch stayed invisible. That is the whole story — not a regression, a **blind
spot in what we ever tested.**

---

## 5. What we need to do to fix it

All retrieval-layer, all additive (the existing FIX A–C layers in forge-ask.mjs are the template), **no
re-encoding of content**:

- **Fix A — content-aware store routing. PENDING.** NAME_BOOST must not require literal naming. When a
  query is conversational/person/event-shaped (no crate/ADR/code signal) OR a store is a transcript
  kind, boost that store — symmetric to how code intent already boosts source files. The
  per-store-fair-representation half of this (MMR/diversity, so one store's dense docs can't monopolize
  the reranked pool) is **corrected 2026-08-23**: this used to say `mmrRerank` "was ported... but not
  yet called" — implying it existed as code, just unwired. Checked against `kb/forge-hybrid.mjs`'s real
  exports: `mmrRerank` was **never ported at all**; it was named only in that file's own header comment
  (now fixed, see `tests/unit/forge-hybrid-port-claims.test.mjs`). MMR/diversity re-ranking remains
  fully open, same as the rest of Fix A.
- **Fix B — finer transcript granularity (write-side). PENDING.** Give transcript turns (or small
  groups) their **own paths** so multiple turns surface as separate candidates and needles aren't cut by
  the single 12k window. This is a passage-shaping change in the meeting ingest, not a content change.
  Untouched by tonight's work — Fix C operates on the passages as they already exist, and doesn't help a
  needle fact that's outside the assembled window in the first place.
- **Fix C — hybrid retrieval. SHIPPED, but narrower than first written — corrected 2026-08-23 (see
  ADR-0025's "Outcome").** This item used to describe a *global* hybrid fusion — wired into `getKb()`/
  `searchKb()` in `forge-ask.mjs`, env-gated on `KB_HYBRID=1` — as SHIPPED. That global attempt was
  **reverted** (ADR-0025: no repo-safe gain; `forge-ask.mjs` does not read `KB_HYBRID` and never fuses
  BM25 into its ranking). What actually shipped instead, and remains live today, is **narrower**:
  transcript-scoped BM25 candidate injection in `kb/forge-ask-all.mjs` (only for stores in
  `KB_TRANSCRIPT_STORES`, default `ruv-meetings`), using `tokenize`/`buildCorpusStats`/`bm25Score` from
  `kb/forge-hybrid.mjs`. `hybridScores`/`multiFieldBM25` (the general α-fusion primitives, ADR-082's
  grid-searched defaults) are ported into `kb/forge-hybrid.mjs` and exported but have **zero callers
  anywhere in this repo** — dead code, not live. The self-retrieval MRR lift below was measured before
  the revert and reflects that now-reverted global-hybrid code path, not the scoped fix that actually
  shipped; treat it as historical, not reproducible by re-running today's code with `KB_HYBRID=1` (that
  now refuses — see `kb/self-retrieval-bench.mjs`'s `resolveHybridMode()`). Self-retrieval MRR lift
  measured (2026-07-19, pre-revert): `ruv-meetings` 0.79→0.90, `ruv-gists` 0.05→0.32,
  `ruvector` 0.09→0.33 — confirming IDs/hashes/flags are now findable by exact token, not just luck of
  surrounding prose.

Sequencing note (updated): A and B still recover the bulk of the meeting-transcript failures and remain
untouched; C, which recovers the needle class, is the one that shipped first — it was the
self-contained, purely-read-side, no-ingest-change fix, so it went first opportunistically rather than
strictly in the A→B→C order originally sketched. **Each change is still re-exam'd against the full 50
before it's kept — nothing ships on belief** (tonight's proof was the self-retrieval benchmark, a cheap
corpus-wide proxy; the full human-graded 50-question re-exam against hybrid-on is itself still an open
item — see ADR-0025 §Open Items). Because forge-ask.mjs is the reader for all 68 stores and a live
product, every change is additive and regression-tested against the existing repo battery so we don't
fix meetings and break repos — **corrected 2026-08-23:** this used to credit `KB_HYBRID` defaulting off
for keeping the repo battery unchanged, implying a live switch a reader could flip. There is no such
switch in `forge-ask.mjs` to flip; the shipped repo-capability battery (26/28 described, 47/48 named,
7/8 scenario) is unchanged simply because the scoped Fix C that actually shipped (transcript-scoped BM25
in `forge-ask-all.mjs`, gated on store membership in `KB_TRANSCRIPT_STORES`) never touches non-transcript
stores at all — not because of an env flag defaulting off.

---

## 6. How we guarantee it never drifts again

The exam gate was right; it was **under-scoped**. It now must test **every content shape**, run through
the **same cross-repo path the product uses** (not scoped — scoping hides Mechanism A), and run on a
schedule:

1. **Question banks cover all shapes:** repo-capability (existing) + conversational-recall + needle-fact
   (IDs/flags/hashes) + **cross-store-confusion traps** (the DAA-token-vs-edge-net-token case) +
   **"not in the corpus" hallucination traps** (correct answer = "the brain does not contain this").
2. **Sealed holdout + frozen anchor** per store — a tuned bank can be gamed; a holdout and an unchanging
   anchor catch both over-fitting and rot (a falling anchor score = regression).
3. **Signed scorecard files**, one per store, regenerated by the **nightly** — the Trust Ledger reads
   scores, never assertions.
4. **A store is only ever "trusted" when its scorecard shows a passing score against this full battery.**
   "Loaded correctly" is necessary but not sufficient; "retrieves correctly, measured end-to-end" is the
   bar.

---

### Appendix — key code references
- Write: `kb/forge-build.mjs:315` (chunking ~4000/400), sidecars written per store.
- Read L1: `kb/forge-ask.mjs:738` (vector-only query), `:276-830` (repo/code intent heuristics),
  `:603-612` (lexicalBoost = path+title overlap), `:640-688` (12k centered window).
- Read L2: `kb/forge-ask-all.mjs:36-104` (fan-out, cross-encoder rerank, NAME_BOOST +2.0 on literal
  repo-naming only).
