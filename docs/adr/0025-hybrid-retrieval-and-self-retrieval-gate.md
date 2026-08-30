---
id: ADR-025
title: Meeting-recall fix — unique-path chunking + transcript-scoped BM25 candidates (global hybrid reverted; scoped hybrid shipped)
status: Accepted
date: 2026-07-18
updated: 2026-08-23
authors: [Stuart Kerr, Claude Code]
tags: [retrieval, hybrid, bm25, self-retrieval, flywheel, forge-ask]
supersedes: []
relates: [ADR-0003, ADR-0004]
---

**Status**: Accepted (shipped 2026-07-19)

Shipped, but NOT the way first written. The *global* hybrid /
query-router / store-routing attempt was reverted (no repo-safe gain — see the Outcome table). The fix
that actually shipped is **narrower and verified**: (1) every meeting passage gets a **unique path**
(`scripts/ingest-meeting.mjs`) so `forge-ask.mjs` doc-collapse no longer crushes 317 segments into 4
windows; (2) `kb/forge-ask-all.mjs` adds **transcript-scoped BM25 candidates** (only for stores in
`KB_TRANSCRIPT_STORES`, default `ruv-meetings`) into the pool the ONE global cross-encoder already
reranks. Repo stores are untouched.

**Verified result (strict 5-grader, 2026-07-19):** meeting recall **3/28 → 25/28**; named repo battery
**44/48 → 44/48 (identical, zero regression)**. Root cause was doc-collapse + facts buried in rambling
turn-chunks (dense buried answers past rank 40; BM25 found them — 876→#4, meta-wrapper→#1, DDoS→#5 — and
the cross-encoder promoted them from the pool). Grounded in cognitum-learn's dense+BM25+reranker design
(`cognitum-learn/docs/ddd/DDD-001-bounded-contexts.md`). Open: on-screen-only facts (a version rUv showed
but didn't say) still need a `learn`-style frame-captioning pass — tracked separately, not in this ADR.

## Outcome (2026-07-19) — what the strict re-grade actually showed

Measured with one consistent 5-grader rubric on a warm in-process engine (`scratchpad/exam/warm-exam.mjs`):

| Config | Repo (named battery) | Meeting recall (50Q) | "What did rUv say" block |
|---|---|---|---|
| Dense (production) | 44/48 | 16/50 | 0/10 |
| Store-routing (`ruv-meetings`→hybrid) | 44/48 | 16/50 (neutral) | 0/10 |
| Query router | 44/48 | ~16/50 | — |
| Global hybrid (xhybrid) | **40/48** ↓ | 20/50 | 2/10 |

- No config is a **repo-safe** meeting-recall gain: xhybrid's +4 meeting costs −4 repo.
- The earlier "32/50" and "49/50" were **grader leniency** — the honest strict number is **16/50**.
- **Root cause (proven by grep of `ruv-meetings.passages.jsonl`):** the missing facts ARE in the corpus
  (`876`, `e1008e2a`, `meta-wrapper.md`, `DDoS`, `--dangerously-bypass`, `Thibaultjaigu`). So the
  failure is **not** ranking/fusion and **not** missing data — transcript chunks simply don't *surface*
  for conceptual questions (poor dense match; BM25 can't match a token the question doesn't contain).
- **The real fix is UPSTREAM chunking**, tracked as its own future work: re-chunk transcripts into
  fact-dense / QA-shaped passages, or synthesize a per-segment fact-summary layer that embeds well
  against conceptual questions. Validate the same strict way before shipping.
- Kept as research record: `kb/forge-hybrid.mjs`, `kb/self-retrieval-bench.mjs`, this ADR, and
  `scratchpad/exam/` (warm exam + grader pipeline). Reverted code backed up in
  `scratchpad/retrieval-work-backup/`.

---

_Original ADR text (the plan as written 2026-07-18, before the strict re-grade disproved the lift):_

## Context

`docs/BRAIN-WRITE-READ-ARCHITECTURE.md` (written earlier the same night, after the meeting-store exam
scored 19/50 cross-repo) diagnosed **Mechanism C**: the forge reader retrieved by **dense cosine
similarity only** — `db.query(qv, ...)` in `forge-ask.mjs`, no lexical/keyword pass over passage bodies
at all. Exact-string needles (a gist ID like `e1008e2a4aa13bf2a991e6aca4028d03`, a flag like
`--dangerously-bypass-approvals-and-sandbox`) have no semantic embedding neighborhood a cosine search
can exploit, so they were findable only by luck of surrounding prose. That §5 doc named this **Fix C —
hybrid retrieval** as a planned, not-yet-built fix. This ADR records that it has now shipped, plus the
benchmark adopted to prove any future retrieval change is a real improvement, not a vibe.

**The defect, precisely:** the read path was **dense-only**. No component of the ranking score in
`forge-ask.mjs` before tonight considered token overlap in the passage **body** — `lexicalBoost` only
ever looked at path + title, never the text itself.

## Decision

### 1. Adopt rUv's shipped hybrid-retrieval method — not a hand-roll

`kb/forge-hybrid.mjs` is a direct port of rUv's tested implementation and his grid-searched tuned
defaults, grounded in:

- **`ruflo/v3/@claude-flow/cli/src/memory/hybrid-retrieval.ts`** — `bm25Score` (Okapi BM25, k1=1.5,
  b=0.75), min-max `normalise`, `hybridScores` (linear fusion `α·cosineNorm + (1-α)·bm25Norm`),
  `multiFieldBM25` (subject/title weighted over body), and `mmrRerank` (diversity re-ranking — ported
  function exists, **not yet wired into `forge-ask.mjs`**, see Open Items).
- **ruflo ADR-082** (Accepted, ruflo 3.10.22) — the grid-searched defaults this port carries forward:
  **α = 0.5**, **subjectWeight = 2.0**, **mmrLambda = 0.7**. ADR-082 measured nDCG@3 0.900 → 0.963 and
  found "BM25 carries more discriminating power than the cosine on small corpora" — exactly this
  project's regime (per-repo stores, hundreds to low thousands of passages each, not millions).

Implementation in `forge-ask.mjs` (env-gated on `KB_HYBRID`, see Env knobs below):

- **`getKb()`**: when hybrid is on, build BM25 corpus stats (`buildCorpusStats`) plus per-passage
  `{subj, body}` token sets once per store load, cached alongside the existing `byId`/`byPath` maps.
- **`searchKb()`**: (1) **BM25 needle-injection** — score every passage body against the query tokens,
  pull the top-scoring documents into the candidate pool so an exact-string fact the dense window
  missed can still compete; (2) **per-document fusion** — cosine (from best dense distance) and
  multi-field BM25 (title weighted `subjectWeight`× over body) are each min-max normalized across the
  candidate set and blended at `α` into `hybridByPath`; (3) the **effective distance** used for final
  ranking becomes `base = hybridByPath ? (1 - hybridNorm) : d.bestDistance` — hybrid replaces pure dense
  distance as the base score when it's on, with the existing intent-adjustment terms (demotion penalty,
  lexical boost, substance boost, etc.) still applied on top, unchanged.

A second, unrelated but adjacent defensive fix landed in the same file: `symbolRoute`'s `push` helper
used to do `if (m) for (const p of m)`, which throws `"m is not iterable"` whenever a `symbols.json`
entry is a single string path rather than an array — silently collapsing that store's candidate pool
for the query. Found via the Q46 exam failure. Fixed to branch on `Array.isArray(m)` vs `typeof m ===
'string'`.

### 2. Adopt the self-retrieval benchmark as the flywheel gate

`kb/self-retrieval-bench.mjs` implements rUv's **self-supervised retrieval benchmark** — grounded in
**`ruv-gists/f8e2851f` (`ruflo-3.24.0-flywheel.md`)**: *"a self-supervised retrieval benchmark (can
retrieval find a document from its own content?)"*, which rUv used to demonstrate 0.496 → 0.758 → 0.847
over the course of his own flywheel iterations. This is deliberately **not** the 50 hand-written exam
questions — that set stays as the small, human-labeled anchor that catches regressions a synthetic
metric can miss. The self-retrieval bench instead **auto-generates** queries from the corpus itself (a
~14-word fragment from the *middle* of a sampled passage — not the opening, which would make the query
near-identical to the target and trivially easy), runs the real reader, finds the rank of the source
document among the results, and scores mean reciprocal rank (MRR) over the sample. It scales to
thousands of probes across every store with zero hand-authoring, $0 cost, no LLM, no network — standard
IR self-retrieval evaluation (cf. Thakur/BEIR), not a reinvented metric.

This is the method used to measure the hybrid lift below, and is intended going forward as the
**cheap, always-available first gate**: run it hybrid-off vs hybrid-on (or before/after any retrieval
change) before spending exam budget on the expensive, human-graded 50-question run.

## Measured lift

Self-retrieval MRR, dense-only vs hybrid on, sampled per store:

| Store | Dense-only MRR | Hybrid MRR |
|---|---:|---:|
| `ruv-meetings` | 0.79 | **0.90** |
| `ruv-gists` | 0.05 | **0.32** |
| `ruvector` | 0.09 | **0.33** |

The gists and ruvector stores are exactly the content shape hybrid was built for — dense, mixed-content
corpora full of exact-string identifiers (gist hashes, crate/symbol names) that cosine similarity alone
essentially cannot rank. The 3-6x MRR lift there is the direct, expected payoff of the BM25 half. The
meeting store's smaller relative gain (already reasonably servable by dense search, being coherent
natural-language transcript) still improves meaningfully, consistent with ADR-082's framing that BM25
adds real discriminating power on top of cosine rather than only rescuing pathological cases.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `KB_HYBRID` | off (`'1'` or `'true'` to enable) | Gates the entire hybrid path — BM25 stats build in `getKb()`, needle-injection + fusion in `searchKb()`. Off = byte-identical to the pre-hybrid dense-only behavior. |
| `KB_ALPHA` | `0.5` | Fusion weight — `hybrid = α·cosineNorm + (1-α)·bm25Norm`. ADR-082's grid-searched default. |
| `KB_SUBJECT_W` | `2.0` | Title/subject weight in `multiFieldBM25` relative to body (weight 1.0). ADR-082's grid-searched default (rUv's own hybrid-retrieval.ts default is 3.0; ADR-082 tuned it down to 2.0 for its corpus — carried forward as-is here, not re-tuned for this corpus; see Open Items). |

## Open items (deliberately not done tonight)

1. **MMR wiring — corrected 2026-08-23.** This item previously said `hybridScores`/`bm25Score`/
   `multiFieldBM25` "are ported and live" and that `mmrRerank` was "not yet called" — implying all four
   existed as code, just unwired. Checked against `kb/forge-hybrid.mjs`'s real exports tonight: only
   `bm25Score` (via `tokenize`/`buildCorpusStats`) is actually live, through `forge-ask-all.mjs`'s
   `KB_TRANSCRIPT_STORES`-scoped candidate pool. `hybridScores` and `multiFieldBM25` ARE ported (they
   exist, exported) but have **zero callers anywhere in this repo** — dead code, not "live". `mmrRerank`
   was **never ported at all**; it was named only in this file's own header comment (now fixed) as
   something the port covers. Candidate pools can currently still be dominated by near-duplicate chunks
   from the same document region — MMR diversity re-ranking remains genuinely unimplemented future work,
   the direct continuation of §5 Fix A's "guarantee per-store fair representation" idea from
   `BRAIN-WRITE-READ-ARCHITECTURE.md`. A new test, `tests/unit/forge-hybrid-port-claims.test.mjs`, binds
   this file's own "what the port covers" comment to its real exports going forward.
2. **Cross-encoder rerank interaction untested.** `forge-ask-all.mjs`'s Level-2 cross-encoder rerank
   runs on top of whatever Level-1 `searchKb` returns; hybrid changes what surfaces into that pool, but
   the cross-store rerank behavior with hybrid on has not been separately measured (Mechanism A from
   the architecture doc — cross-store dilution — is a Level-2 concern hybrid does not address).
3. **No nightly gate yet.** The self-retrieval benchmark is a script (`node
   self-retrieval-bench.mjs --all --samples N`), not wired into the nightly publish or CI. §6 of
   `BRAIN-WRITE-READ-ARCHITECTURE.md` calls for exactly this ("signed scorecard files … regenerated by
   the nightly"); the self-retrieval MRR belongs there as the cheap always-on gate, with the 50-question
   human anchor as the periodic, more expensive companion check.
4. **No grid search performed on this corpus.** `α=0.5`/`subjectWeight=2.0`/`mmrLambda=0.7` are rUv's
   own tuned values for his corpus (ruflo ADR-082), ported as sane, cited defaults — not re-derived by a
   grid search against this KB's own stores. The measured lift above confirms they help; it does not
   confirm they're optimal here. `KB_ALPHA`/`KB_SUBJECT_W` are exposed as env vars specifically so a
   future grid search can sweep them without a code change.
5. **`KB_HYBRID` defaults off — corrected 2026-08-23.** This previously implied `forge-ask.mjs` reads
   `KB_HYBRID` and defaults it off. It does not read that variable at all — the global-hybrid path it
   once gated was reverted (see "Outcome" above). The only remaining `KB_HYBRID` reference in this repo
   is `kb/self-retrieval-bench.mjs`'s console label, which (until tonight) silently printed `mode=HYBRID`
   when the flag was set even though the benchmark's underlying `searchKb()` call is dense-only either
   way — an unfalsifiable witness. That script now refuses (`resolveHybridMode()`, tested) instead of
   mislabeling. "Turn hybrid on by default" therefore has no live switch to flip yet; it is blocked on
   items 1–4 above (wiring, cross-encoder interaction, the nightly gate, a grid search), not merely a
   flag flip.

## Consequences

- The dense-only defect named in `BRAIN-WRITE-READ-ARCHITECTURE.md` §5 Fix C is closed: passage bodies
  are now searchable by exact token, not just by embedding proximity.
- The self-retrieval benchmark gives every future retrieval change a **cheap, corpus-wide, zero-cost
  regression signal** distinct from the expensive human-graded 50-question exam — the two are
  complementary, not redundant (synthetic breadth vs human-judged correctness).
- Because `KB_HYBRID` defaults off and every change is additive (fusion only replaces the base distance
  when the flag is on; the intent-adjustment terms are unchanged), the existing repo-capability exam
  battery (26/28 described, 47/48 named, 7/8 scenario) is not at risk from this change being present in
  the code — it simply isn't exercised unless explicitly enabled.
