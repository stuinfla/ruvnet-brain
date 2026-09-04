---
id: ADR-076
title: Citation-header rank hijacking needs a structural fix, not another parser patch
status: Proposed
date: 2026-09-03
updated: 2026-09-03
authors: [Claude Code]
tags: [security, grounding, citation-binding, dream-cycle]
supersedes: []
relates: [ADR-002, ADR-025]
governs: []
---

# ADR-076 — Citation-header rank hijacking needs a structural fix, not another parser patch

## Status

**Status**: Proposed (2026-09-03, Dream Cycle nightly routine, `stuinfla/ruvnet-brain#236`)

## Context

`kb/verify-citation.mjs`'s `parseCitations()` turns `forge-ask-all.mjs`'s printed, human-readable
citation-block stdout into structured citations, which `verifyGrounding()` then checks against the
real store files on disk. On 2026-08-28, PR #186 fixed a citation-block spoofing defect: a
retrieved document's own dumped body could contain text shaped like the reader's citation-block
format, and the pre-fix parser would parse it as an extra, fabricated citation. The fix bounded each
citation's `path`/`title` extraction to its own span and required strictly sequential ranks
(`#1, #2, …`, no gaps or repeats).

That fix's own security review named an unclosed residual case: *"a maximally adversarial document
predicting the exact next expected rank would still be accepted."* Tonight's Dream Cycle
(2026-09-03) reproduced this residual case directly against unmodified `main` and found it requires
**less** than the review implied: an attacker does not need to predict an absolute rank at all, only
a fixed **relative** offset (+1 from wherever their own document happens to be retrieved), which is
always computable and can be pre-authored into an indexed document before that document is ever
retrieved. See `docs/dream-cycle/2026-09-03-grounding-quality-report.md` and the two runnable
repros in `docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-{a,b}.mjs`:

- Repro A: an attacker-controlled document (real, genuinely retrieved at rank N) embeds a header
  claiming rank N+1 inside its own dumped body. `parseCitations()` accepts it; the real citation at
  rank N+1 (a different, legitimate document) never appears in the parsed output at all.
- Repro B: the same hijack, but the fake rank-N+1 citation's path resolves to a real passage the
  attacker's own store carries, so `verifyGrounding()` can be made to report `grounded: true` off
  citations the retriever never actually surfaced as the true next-ranked hit.

## Why a parser-only patch cannot close this

The sequential-rank + bounded-span fix (PR #186) closes the *unintentional* case — generic
illustrative text that happens to look like the format, as this very file's own pre-fix header
comment did. It cannot close the *intentional* case, because nothing in the wire format is secret:
`forge-ask-all.mjs`'s output format is documented in this repo's own source (this file's header
comment, and `forge-ask-all.mjs` itself). Any further hardening restricted to `verify-citation.mjs`
alone — e.g. also requiring the `chars:`/`chunks:`/`----- full document -----` trailer to
immediately follow a candidate header — raises the cost of forging a look-alike by a fixed, small
amount, but a party who has read the format can always reproduce it byte-for-byte. Closing this for
real requires the reader (`forge-ask-all.mjs`) to cooperate, not just the parser.

## Decision

**Not decided yet — this ADR exists to force the decision, not to make it.** Two directions were
identified; implementation is deliberately deferred to a future dedicated PR, not attempted as
tonight's nightly candidate, because:

- Both directions change `forge-ask-all.mjs`'s citation *output* format, which its own docstring
  says at least three other consumers also parse (`kb/forge-mcp.mjs`, `kb/forge-mcp-all.mjs`,
  `kb/card-lane.mjs`) — the true blast radius of a format change is not established by tonight's
  research, and this repo's own convention treats an unestablished blast radius as disqualifying for
  a "tiny, bounded" nightly candidate.
- This repo's Dream Cycle ledger (`docs/dream-cycle/LEDGER.md`) currently shows zero of the recent
  `dream/*` candidate PRs merged since 2026-08-31 — adding a cross-cutting, multi-consumer format
  change to that backlog without owner sign-off on direction first would very likely become one more
  unreviewed PR, not a shipped fix.

### Option A — per-query unguessable token

`forge-ask-all.mjs` generates a fresh random token once per `searchAll()` invocation, prints it once
in a banner before any citation block, and includes it in every citation header
(`#${i+1} tok=${token} repo=${r.repo} ...`). `verify-citation.mjs`'s `parseCitations()` trusts only
the token from the *first* occurrence in the stream (printed before any retrieved/untrusted content
can appear) and rejects any header whose token doesn't match. Since the token is generated fresh
per query, no document indexed before the query was issued can embed the correct token — this
closes the gap outright, not just raises the cost. Smallest conceptual change of the two options,
but still touches the reader's output format and every consumer that parses it.

**Trade-off**: needs auditing all consumers of the citation-block text format before landing, to
confirm none of them break on an added field or reject an unrecognized token they don't expect.

### Option B — structured (JSON) citation transport

Replace the human-readable, delimited citation-block text with a structured format (e.g. one JSON
object per line, or a single JSON array) that `verify-citation.mjs` decodes directly instead of
regex-parsing printed text. This is the fix the 2026-08-28 security review named as "the deeper
architectural fix this repo's reader/verifier boundary should eventually consider," and is also the
direction LangChain, LlamaIndex, and Sakana AI Scientist's pipelines already take (C-grade, general
design knowledge, not independently re-verified beyond that framing). Closes the gap by construction
(no delimiter text for retrieved content to imitate at all) and is more robust long-term, but is a
larger, more invasive change across every consumer of the current text format, including any
human-facing terminal output that currently benefits from the readable format.

## Consequences (if adopted, either option)

- `kb/verify-citation.mjs`'s `parseCitations()` gains a real defense against a document that can get
  itself indexed and later retrieved, instead of only the current defense-in-depth against
  accidental format collisions.
- Whichever option is chosen, the two repro scripts in `docs/dream-cycle/evidence/` should be
  promoted into `tests/unit/verify-citation.test.mjs` as real, permanently-enforced regression
  tests (deliberately NOT added to the suite by this ADR itself, so as not to ship a permanently-red
  assertion with no accompanying fix — see the nightly report's Security Review section).
- Until one option ships, `verifyGrounding()`'s `grounded: true` verdict should be understood to
  carry this residual risk for any answer whose citations were assembled from stores containing
  content this repo does not fully control the provenance of (ingested repos, gists, transcripts).

## Alternatives considered

**Do nothing, re-flag it again next relevant night.** Rejected: the 2026-08-28 review already did
exactly this once; repeating the same flag without new evidence is the "rediscover a failed
direction" anti-pattern this repo's own nightly routine is supposed to avoid. Tonight's contribution
is the concrete reproduction proving the case is easier to trigger than previously characterized —
that new evidence is the reason this is now an ADR instead of a repeated one-line mention.

**Attempt Option A tonight anyway, as a "small" fix.** Rejected: the consumer blast radius is
genuinely unknown without auditing `forge-mcp.mjs`/`forge-mcp-all.mjs`/`card-lane.mjs` first, which
is itself real work beyond a tiny nightly candidate, and this repo's own learning signal (zero
recent merges) argues for not adding to the backlog speculatively.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-03 | ADR created. Status: Proposed. | Dream Cycle nightly routine, `docs/dream-cycle/2026-09-03-grounding-quality-report.md`. |
