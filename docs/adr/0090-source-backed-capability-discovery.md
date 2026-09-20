---
id: ADR-090
title: Additive source-verified capability discovery
status: Accepted
date: 2026-09-19
updated: 2026-09-20
reviewed_digest: 0be7e2e73218
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
9. Pool size, cascade defaults, CE thresholds, timeouts and default `k` are unchanged.
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
