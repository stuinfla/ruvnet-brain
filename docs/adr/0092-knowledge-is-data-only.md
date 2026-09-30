---
id: ADR-092
title: Knowledge is data only — build each store once, ship only what changed, never through a code release
status: Proposed
date: 2026-09-29
updated: 2026-09-29
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [corpus, release, simplification, supersession]
supersedes: []
amends: [ADR-085, ADR-086, ADR-091]
---

# ADR-092 — Knowledge is data only

**Status**: Proposed (2026-09-29)

## Owner requirement

"Build it once and lock it down until it changes." Every night the knowledge reflects upstream;
a code release never rebuilds it, never waits on it, and never rolls it back.

## What went wrong (measured 2026-09-29)

- The published corpus zip (`corpus-sha256-b6b7bf54…`) is 1,147 files. 34 are executable
  modules (`forge-update.mjs`, `forge-guard.mjs`, `verify-bundle`, the search modules). The rest,
  1,164 of 1,167 MB, is knowledge.
- Because a knowledge release ships **code into every client**, it must be bound to one approved
  runtime: an approved-runtime pin, byte-equal executables, runtime-equality on the client, seed
  compatibility, coverage sidecars, and a code release that must re-carry the corpus. That binding
  is the source of every failure today:
  - v4.3.36 rejected the fresh corpus for a missing sidecar and shipped August knowledge
    (`scripts/corpus-next-seed.mjs:167`);
  - a nightly could not run until the newest code release was install-verified;
  - a code release and a corpus release block each other.
- Knowledge and code are two products with two lifecycles bolted into one archive.

## Decision

1. **A knowledge release contains data only.** No `.mjs`/`.js`/`.cjs`, no signing trust root,
   no updater. Code reaches a machine only through the code release (npm + the plugin), which
   keeps its one owner approval.
2. **A store is immutable and content-addressed.** Its identity is
   `(repo, upstream commit, embedding model, dimensions, store-format version)`. Its files (the
   `.big.rvf` and its sidecars, passages, symbols, meta, primer) are built once for that identity
   and never rebuilt.
3. **One signed index is the only mutable thing.** `knowledge-index.json` lists every store's
   identity and file digests plus the derived aggregates (capability cards, concepts, L2, gists)
   with their digests. It is signed with the existing signing key and names a
   `storeFormat` version, not a code version.
4. **The nightly does three things:** for each repo, compare upstream HEAD with the index; build
   only stores whose identity changed and rebuild the aggregates only if any input changed;
   upload the new files and a new signed index to the standing knowledge release. No change → no
   upload, no new release.
5. **The client update** fetches the index, verifies its signature with the key shipped *in the
   code*, downloads only files whose digest it does not already hold, verifies each digest, and
   swaps atomically. Private overlays and rollback keep their current behaviour.
6. **Compatibility is `storeFormat`.** A client refuses an index whose `storeFormat` it cannot
   read and says "update the brain" — never silently, never a rollback.
7. **A code release carries no knowledge.** A fresh install gets code from npm and knowledge from
   the index on first run. A code release cannot change, delay, or roll back knowledge.

## Deleted when this ships (not kept alongside)

Corpus generations bound to a runtime; the approved-runtime pin for knowledge; seed resolution
(`corpus-next-seed.mjs`) and the committed bootstrap seed; coverage sidecars as a release
precondition; `protected-release.yml` corpus mode and its five corpus jobs; the release-transaction
receipt scan for knowledge; the knowledge-input no-change digest (replaced by per-store identity);
executables inside the knowledge archive; the code release re-carrying the corpus (ADR-0091 D6).

## Kept

The signing key and signature verification; the owner approval on the code release; the
per-repo builders (`kb/forge-*`); private-store fencing; the recall/retrieval gates, now run
against the index before it is uploaded; the corpus watchdog, now reading the index date.

## Acceptance (each is a test that fails on today's code)

- A code release built after the index is published changes no store byte and no index entry.
- A nightly with no upstream change uploads nothing.
- A nightly with exactly one changed repo uploads exactly that store's files, the changed
  aggregates, and one index.
- A client holding the previous index downloads only the changed files; a tampered file or
  unsigned index is refused and the live corpus is untouched.
- A client whose `storeFormat` is older than the index refuses cleanly and names the fix.
- The knowledge archive/release contains no executable file.

## Migration — CORRECTED by the adversarial review (2026-09-29)

The first draft said one release could migrate. That is wrong. Cross-model review (GPT, read-only,
against the code) found, and each point was re-verified in code:

- `bin/install.mjs:628-668` refuses a staged brain without `forge-mcp-all.mjs` inside the knowledge
  tree, and `kb/forge-update.mjs:1272-1288` takes the single `.zip` on `releases/latest` plus its
  `.sig`. A data-only `latest` would break every v4.3.36 client's update and every fresh install.
- GitHub allows at most 1,000 assets per release; the corpus is 1,147 files. Store files must be
  packed, with reachability-based garbage collection.
- `gh release upload --clobber` deletes before uploading (its own help text), so a mutable index can
  vanish on a failed upload. Publish via draft → verify → promote, or versioned index names.
- A digest proves bytes, not freshness: the signed index needs a monotonic sequence the client keeps
  as a high-water mark, so an older validly-signed index is refused.
- Store identity must include the embedding model revision, pooling and query prefix, the builder
  fingerprint and the selected prose bytes — not only repo, commit, model and dimensions
  (`kb/forge-big.mjs:418-424`, `kb/forge-build.mjs:189-196`).
- `concepts` and `ruv-gists` are whole-aggregate rebuilds today (`scripts/corpus-aggregates.mjs`,
  `scripts/gist-receipts.mjs`); primers and L2 have no input digest.

So the migration is at least two releases:
1. A dual-format client (reads both the zip and the signed index; keeps private-overlay and
   rollback protection), shipped while the zip channel stays `latest`.
2. Once that client is install-verified and most installs have it, the nightly starts publishing
   the index; the zip channel keeps serving older clients for a declared window, then retires.

## Status note (2026-09-29)

The current pipeline works end to end as of today (nightly incremental refresh in 59 minutes; code
releases carry the newest generation once it has its coverage sidecar). This ADR stays Proposed and is
built as its own project, not rushed into a release.
