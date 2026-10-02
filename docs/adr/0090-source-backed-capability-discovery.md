---
id: ADR-090
title: Additive source-verified capability discovery
status: Accepted
date: 2026-09-19
updated: 2026-10-01
updated_source: derived-from-git
reviewed_digest: a6462a1a7d3d
authors: [Stuart Kerr, Codex]
tags: [retrieval, routing, source-grounding, capability-discovery]
relates: [ADR-060, ADR-074]
governs:
  - kb/capability-families.mjs
  - kb/card-lane.mjs
  - kb/forge-ask-all.mjs
  - kb/forge-mcp-all.mjs
  - kb/grounded-response.mjs
  - kb/implementation-evidence.mjs
  - kb/exact-member-proof.mjs
  - kb/source-discovery-intent.mjs
  - kb/identifier-lane.mjs
  - kb/repo-aliases.json
  - tests/unit/capability-family-routing.test.mjs
  - tests/unit/capability-discovery.test.mjs
  - tests/integration/forge-mcp-capability-discovery.test.mjs
  - tests/unit/implementation-truth.test.mjs
  - tests/unit/source-discovery-intent.test.mjs
  - tests/unit/grounding-identifier-recall.test.mjs
  - tests/unit/card-lane.test.mjs
  - tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt
  - tests/fixtures/retrieval/ruflo-cross-project-transfer-reviewed-passage.txt
---

Updated: 2026-09-20 | Version 1.2.3
Created: 2026-09-19

# ADR-090 — Additive source-verified capability discovery

**Status**: Accepted (2026-09-19)

## Context

Broad requests such as “store embeddings in this project without running a server” and “carry
useful learning from one project to another” can be routed to an unrelated store by lexical card
overlap. A curated capability card can also appear conclusive while the current corpus contains no
source that covers the user's requested deployment, persistence, or transfer properties.

The search corpus can contain documentation that describes a capability without proving that a
particular installation or application implements it. The retrieval path must keep those states
separate.

## Decision

1. Capability concepts identify related documentation only. They do not replace primary routing,
   candidate ordering, cross-encoder scores, evidence grades, or implementation verdicts. A separate
   source-discovery response may be used only for an allowlisted positive discovery phrasing; it is
   explicitly labeled as a lead, has no ranked result or grounding receipt, and cannot claim the
   full query is answered.
2. Remove the finite exact-query positive shortcut and family-owner override. The observed holdout
   regression (useful AQE transfer documentation replaced by irrelevant Ruflo guidance) shows why
   recognizing a topic must not override the original search. For non-discovery phrasings, the
   existing card and primary retrieval paths remain authoritative.
3. A shared collector adds `relatedSources` separately to normal, card-hit, and routing-decline
   MCP responses and to CLI output. Supplements never enter ranked results or grounding receipts.
   Text and structured fields contain the same guarded excerpt, with a hash of the returned bytes.
4. Each supplement binds a repository, source path, and independently reviewed full-passage SHA256.
   Read actual source bytes each time; same-size/same-mtime mutation cannot retain approval.
   Changed or absent passages suppress the supplement while primary retrieval proceeds normally.
5. The browser entry documents vector search and IndexedDB persistence; it establishes neither
   native Rust support nor crash recovery. The cross-project entry documents explicit IPFS
   publish/load and includes required `PINATA_API_JWT`; it establishes neither automatic nor
   credential-free offline transfer. Each supplement states these limits, without a fabricated CE.
6. Explicit repository restrictions and named product scope restrict supplements. Ambiguous
   multi-family requests do not receive an arbitrary family's source. OFF is checked before source
   discovery; the discovery lead does not mint a search receipt or claim index health. All queries
   outside the positive discovery contract retain the primary outage/search path.
7. Nightly source changes require independent catalog review, an exact new passage hash, and an
   updated fixture before the supplement can return. Runtime never regenerates its own approval.
   For a query matching exactly one reviewed family, MCP may return this source as a
   `SOURCE-BOUNDED DISCOVERY` lead before card or model retrieval when the source is inside any
   explicit repository scope and the query expresses positive option-finding or conceptual
   cross-project-transfer intent. Assertions, negative/prevention/troubleshooting phrasing,
   implementation details, explicit multi-result, exact-member, and direct built-state queries
   remain on primary retrieval. It stays outside ranked results and grounding receipts and states
   its limits.
   This small catalog is a bounded discovery repair, not proof of corpus-wide advisory completeness.
8. Exact `Owner.member()` queries require a direct concrete class-method declaration parsed from
   supported JavaScript/TypeScript source by Babel. A callsite, class match, nested call, getter,
   setter, overload signature without a body, unsupported language, parse failure, or missing parser
   is insufficient. A positive result proves declaration presence only; it does not prove
   accessibility, call shape, or runtime behavior. A direct exact-member scan may return qualified
   indexed absence for the routed stores; this does not establish global nonexistence. The
   case-folded exact identifier scan widens only;
   RvfStore/RvfDatabase and explicitly qualified Cognitum ruOS have canonical routing aliases.
9. Cascade defaults, CE thresholds, timeouts and default `k` are unchanged.
   **Amended 2026-10-01 (4.5, keyword lane):** the candidate pool is no longer dense-only.
   - **What the lane adds:**
     - Every repository store (not transcript stores) adds up to 8 keyword-matched files
       (`kb/keyword-lane.mjs`, Okapi BM25 over the store's passage sidecar, one best chunk per
       file) that dense retrieval did not already pool.
     - These candidates are judged by the same cross-encoder and are never fused into a score.
     - They ride the cap-exempt `bm25` lane.
   - **Evidence.** All runs used the 4.3.37 corpus, paired against the 4.4 runtime on the same harness;
     outputs are in `evals/runs/2026-10-01-retrieval-4.5/e2e3-f725e0e7/`.
     - Recall gate: 162 → 165/182 (top-1 128 → 129, 0 lost).
     - Off-topic abstain: 19/20 → 19/20.
     - Held-out routed: 48 → 51/80, 4 passes gained and 0 lost.
     - Novice needs, gold or alternative file within 5: 4 → 10/206.
     - Novice needs whose gold file reaches the pool: 13 → 35 of 87 gold-repository searches.
   - **Bounded cost.**
     - Index memory: a compact BM25 index keyed by the sidecar's stat, at most 8 stores / 160 MB of
       sidecar resident (ruvector 162 MB, not the 530 MB a parsed corpus costs).
     - Cold build: 0.6–5.4 s per store.
     - Warm lookup: 1–12 ms per question.
   - **Shipped OFF in 4.5 (decision 2026-10-01): `RUVNET_BRAIN_KEYWORD_LANE=1` turns it on.**
     - Latency, paired warm, 69 need questions, 4.4.1 reader vs E2+E3: +2.1 s median per question
       [1.4–2.9]; p50 13.7 → 15.3 s, p90 20.6 → 26.4 s (+5.9 s [3.7–8.7]).
       Output: `evals/runs/2026-10-01-retrieval-4.5/latency-base-vs-e2e3/`.
     - Ship rule, fixed before trying a mitigation: E2 ships on only if p50 rises by no more than
       1.0 s and the gate gains survive (recall +2 or more, needs gold within 5 at 8/206 or more).
     - **Where the cost comes from.** Building the index at query time. Replaying the same
       questions' store accesses, the lane alone took p50 1.5 s and p90 5.1 s, and over 1 s on 41
       of 65 questions. With a 4000 MB budget it was still p50 1.1 s, because each process builds
       each store once and a question touches new stores. The extra cross-encoder pairs are only
       about 17 of about 224 per question.
     - **A read cap would not fix it.** Capping the lane at 3–4 reads trims pairs but leaves the build.
     - **A "dense is weak" gate would not fix it.** With "weak" meaning the dense pool's best CE is
       below −2:
       - Dense is weak on 167/196 traced need questions, so the gate would still fire on 57/65
         latency questions.
       - The three recall-gate wins came where dense was strong (best dense CE 1.9–5.2), so a
         gate that saves time drops them.
     - **The fix belongs to the corpus build.** It is an index built with the corpus and loaded at
       query time.
     - **Next step: the first 4.6 item**, together with ADR-099 arm A.
       - CI builds the BM25 index with each store and seals it in the bundle.
       - The reader loads it at query time instead of building it.
       - E2 turns on only if both hold on the same paired 69-question latency set:
         - added p50 ≤ +1.0 s;
         - the gains survive (recall ≥ +2, needs gold within 5 ≥ 8/206).
   - **Why it does not breach the rest of this decision.** The lane changes which files the reranker
     reads. It does not change supplements, reviewed passages, capability-family routing, CE scores or
     grounding receipts. A supplement's file can now be retrieved on its own merit by this primary
     lane, without its reviewed-witness provenance (`tests/unit/capability-discovery.test.mjs`).
10. An explicitly named installed multiword store remains a source-search scope when it has no
    capability card. The route records the name but supplies no card mapping or answer; source
    retrieval and implementation-evidence gates remain authoritative.

## Verification boundary

Focused tests cover source hashes, source-verbatim excerpts, scope, additive output, guard behavior,
primary evidence preservation, routing decline, and constrained paraphrases. The original eight
independent questions are now regression cases because their failures informed this repair.
Fresh held-out semantic and actual MCP latency evaluation remain required before claiming general
quality improvement. No universal 98% quality or deployed-runtime claim is made here.

## Currency log
| 2026-10-01 | Currency review (4.5, after merging release-integ-4.5 2b2ec6a9): decision unchanged. In `kb/forge-ask-all.mjs`, a deployed store's key or alias still never widens the route or adds identifier candidates in another store, and it is again an identifier while its own store is searched. That restores the recall-gate question "In LatentMesh ADR-001". `kb/forge-mcp-all.mjs` only adds the flag-gated recommender endpoint at warmup. Discovery supplements and §9 are unchanged. reviewed_digest a6462a1a7d3d. | Reviewed `kb/forge-ask-all.mjs` and `kb/forge-mcp-all.mjs` against `evals/runs/2026-10-01-retrieval-4.5/final-a2adf94a/omitted.json`. |
| 2026-10-01 | Reviewed and amended §9 (4.5): the first 4.6 item is now explicit. CI builds the BM25 index with each store and the reader loads it, never builds it. E2 turns on only if added p50 is at most +1.0 s and the gains survive (recall +2 or more, needs gold within 5 at 8/206 or more) on the same paired 69-question set. Code is unchanged since the previous row. reviewed_digest af4418a4d6d5. | Reviewed `kb/forge-ask-all.mjs` and `kb/keyword-lane.mjs` against `evals/runs/2026-10-01-retrieval-4.5/e2-mitigation/cost-sim.jsonl`. |
| 2026-10-01 | Amended and reviewed §9 (4.5): the keyword lane ships off and RUVNET_BRAIN_KEYWORD_LANE=1 turns it on. Paired warm latency cost +2.1 s median per question [1.4-2.9] and +5.9 s at p90. Almost all of it is the query-time index build: the lane alone took p50 1.5 s and p90 5.1 s. Neither a dense-weak gate nor a read cap recovers that time without losing the gate gains. The deferred fix is an index built with the corpus. reviewed_digest 7af07f8b7386. | Reviewed `kb/keyword-lane.mjs` and `kb/forge-ask-all.mjs` against `evals/runs/2026-10-01-retrieval-4.5/e2-mitigation/gate-analysis.txt` and `evals/runs/2026-10-01-retrieval-4.5/e2-mitigation/cost-sim.jsonl`. |
| 2026-10-01 | Currency review (4.5 merge of 4.4.1): decision unchanged. In `kb/forge-ask-all.mjs`, a deployed store's key or alias is no longer an identifier for widening or boosting. This fixes "RuVector HNSW vector search overview" answering from agentdb. Discovery supplements and the amended §9 keyword lane are unchanged. reviewed_digest d0219ff74a7b. | Reviewed `kb/forge-ask-all.mjs` against `evals/runs/2026-10-01-retrieval-4.5/capability-battery/npm-test-candidate-on-4.4.0.out`. |
| 2026-10-01 | Amended §9 (4.5): repository stores add up to 8 keyword-matched files per question through the cap-exempt bm25 lane (`kb/keyword-lane.mjs`). Measured paired on the 4.3.37 corpus: recall 162 → 165/182 with 0 lost; off-topic 19/20 unchanged; held-out routed 48 → 51/80 with 0 lost; needs gold or alternative within 5 went 4 → 10/206. Supplements, reviewed passages and family routing are unchanged. `kb/forge-ask-all.mjs` also merges the quoted-claim flag onto already-pooled files (E3), and wires the learned judge, which stays off without trained weights (ADR-099). reviewed_digest c0c016b2aecb. | Reviewed `kb/forge-ask-all.mjs` and `kb/keyword-lane.mjs` against `evals/runs/2026-10-01-retrieval-4.5/e2e3-f725e0e7/recall.json`. |
| 2026-10-01 | Currency review (4.4 routing and 4.4.1 apostrophes): decision unchanged. In `kb/forge-ask-all.mjs`, the source route planner is exported, up to 3 tied metadata stores are kept, rUv provenance needs an authorship shape and curly apostrophes are folded. In `kb/card-lane.mjs`, phrase normalisation folds curly apostrophes. `kb/identifier-lane.mjs` scans are cached per KB build and sidecar fingerprint. Discovery supplements, reviewed passages and capability-family routing are untouched. reviewed_digest a5bac6a4e60f. | Reviewed `kb/forge-ask-all.mjs`, `kb/card-lane.mjs` and `kb/identifier-lane.mjs` against `evals/runs/2026-10-01-routing-4.4/README.md` and `evals/runs/2026-10-01-routing-4.4.1/README.md`. |

| 2026-09-19 | Reviewed current source and normative claims; the detailed September 19 findings below retain their stated runtime limitations. reviewed_digest 9e737a426e6a. | `kb/capability-families.mjs`, `kb/card-lane.mjs`, `kb/forge-ask-all.mjs`; source consistency review only, no new deployment or acceptance claim. |

| Date | Review |
|---|---|
| 2026-09-19 | Supersedes the earlier same-day template/candidate mechanism with additive, separately labeled documentation. Independent MCP review found one owner-routing regression and little generalization; revised behavior preserves primary search and all evidence grades. Source review and focused tests only; live qualification pending. |
| 2026-09-19 | Reviewed retrieval integration: preserve existing same-path evidence instead of replacing it with a short catalog excerpt; preserve source order in the catalog excerpt. No OFF/scope or cascade-default changes, and no latency or installed-runtime claim. | `kb/forge-ask-all.mjs`; `tests/unit/capability-discovery.test.mjs`; reviewed_digest 517fc91452d5. |
| 2026-09-20 | Exact member declarations now use the production Babel parser for supported JavaScript/TypeScript, fail closed on parse errors or missing parser, and report only declaration presence. Runtime dependency added to the KB package; bundle module-graph traversal includes the helper. Focused unit tests only; release packaging and installed runtime remain unqualified. | `kb/exact-member-proof.mjs`, `kb/implementation-evidence.mjs`, `kb/package.json`, `tests/unit/implementation-truth.test.mjs`; reviewed_digest 0be7e2e73218. |
| 2026-09-20 | Added a narrowly allowlisted, source-only MCP discovery response for two reviewed families after independent MCP testing showed the normal candidate route could return irrelevant sources or exceed the host window. It has empty ranked results, no grounding receipt, and only applies to positive discovery phrasings; assertion, prevention, troubleshooting, API, and explicit multi-result cases retain primary retrieval. Independent review and focused MCP/intention tests passed; broader retrieval quality remains unqualified. | `kb/source-discovery-intent.mjs`, `kb/forge-mcp-all.mjs`, `tests/unit/source-discovery-intent.test.mjs`, `tests/integration/forge-mcp-capability-discovery.test.mjs`; reviewed_digest 0be7e2e73218. |

| 2026-09-19 | Generalized broad-family discovery without broadening the exact no-rerank allowlist: a matching query can add one independently reviewed, SHA-bound passage as a candidate in the normal rerank/evidence path. Curated cards cannot return early for a family query. Changed hashes fail closed; original query text and qualifiers are preserved. Focused unit tests only; no latency, held-out recall, or installed-runtime claim. | Reviewed the scoped `searchAll` handoff, witness injection, source hash check, card-lane bypass, and focused capability-discovery tests. |
| 2026-09-19 | Exact `Owner.member()` questions now require relevant implementation source declaring that exact member before implementation is reported proven; a class match or callsite alone leaves a qualified insufficient-evidence result. Exact identifiers are matched case-insensitively so normalized PascalCase symbols reach the existing widened-only scan. Added exact `RvfStore`/`RvfDatabase` owner aliases and a full Cognitum ruOS disambiguator; bare `ruos` remains the ruvnet desktop-control owner. Focused unit tests only; no MCP runtime or global absence claim. | Reviewed `kb/implementation-evidence.mjs`, `kb/identifier-lane.mjs`, `kb/repo-aliases.json`, `kb/card-lane.mjs`, and the focused evidence/router/scanner tests. |
| 2026-09-19 | Removed capability-family guesses from the card router after a reviewed cross-project paraphrase showed the override could replace its existing `codex-one` owner with `ruflo`. The card router retains its baseline owner selection; the family matcher has no authority to replace that source route. Existing reviewed-source discovery remains separately governed. | Reviewed `kb/card-lane.mjs` and `tests/unit/capability-family-routing.test.mjs`; baseline fixture continues to route to `codex-one`. |
| 2026-09-19 | Explicit named stores without curated cards now remain source-search scopes and are recorded in `namedRepos`; no card answer is created. Exact member proof requires a direct top-level declaration with a body. An exact-member index miss returns qualified insufficiency, never global nonexistence. Focused tests: 217 passed. One bounded CLI run on the 2026-09-19 archive returned the qualified miss in 9.25s; its older alias registry routed four stores, so this is not installed-MCP or broad-latency qualification. | Reviewed `kb/card-lane.mjs`, `kb/forge-ask-all.mjs`, `kb/identifier-lane.mjs`, `kb/implementation-evidence.mjs` and focused router, identifier, implementation, and orchestration tests. |
| 2026-09-19 | Reviewed the exact query-template allowlist, passage-hash gate, excerpt construction, and MCP default-`k` route. Independent source review pinned the approved passage hashes in this ADR's governed implementation. A same-size, same-mtime passage mutation is rejected. reviewed_digest fe7a22ebf299. | Reviewed `kb/capability-families.mjs`, `kb/forge-ask-all.mjs`, `kb/forge-mcp-all.mjs`, and `tests/unit/capability-discovery.test.mjs`; confirmed changed or missing source passages fail closed. |
