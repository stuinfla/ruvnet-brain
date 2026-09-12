# DDD-0021 — The Corpus Supply Chain bounded context

Updated: 2026-09-13

Governs **ADR-084** (the three user invariants) and **ADR-085** (the nightly corpus release channel).

**Status**: Proposed (2026-09-13)

---

## Purpose and boundary

Every prior currency mechanism in this project measured **what the pipeline itself last recorded**,
never **what rUv's live org actually contains right now**. That gap is why the corpus could go
23 days stale while every internal receipt read PASS. This context exists to hold exactly one
responsibility, drawn as a boundary against its neighbors: **decide, every night and without a
human, whether the installed corpus matches the live rUv org, and if not, close the gap — never
report closure it did not achieve.**

It is deliberately narrow. It does **not** own:
- **Verification/acceptance evidence** (DDD-0018, Whole-product integrity) — that context defines
  what evidence strength means and how a `ProductIntegrityCase` is built; this context supplies one
  input to it (a coverage receipt), it does not judge its own sufficiency.
- **Release identity and code publication** (ADR-058, release-authority) — this context publishes
  **corpus content only**; it has no authority over npm version, plugin version, or a code tag, and
  every mechanism it uses must fail closed rather than acquire that authority by accident.
- **Retrieval quality** (corpus-qa / ADR-064) — a store being present and current is this context's
  concern; whether a query ranks the right passage is not.
- **Consumption on the customer's machine** (DDD-0003, Updating) — this context ends at "a corpus
  release exists and is discoverable via `releases/latest`"; how a customer's `forge-update.mjs`
  decides it is behind and applies the update belongs to the Updating context, which ADR-085 confirms
  needs no change to consume this context's output.

## Aggregate root: `CorpusSupplyRun`

One `CorpusSupplyRun` per nightly attempt. It is the only thing in this context that can be "current"
or "incomplete" — no individual store, repo, or gist carries that judgment alone; it is only true or
false of the run that measured them.

```
CorpusSupplyRun
  runId               deterministic from (date, source SHA)
  liveOrgSnapshot      { repos: [...], gists: [...] }   -- fetched fresh, never cached across runs
  priorCoverage        the coverage this run is compared against (yesterday's, or the seed's)
  ingested             repos/gists newly pulled in this run (were entirely absent before)
  rebuilt              stores whose upstream SHA moved and were re-embedded this run
  excluded             { name, reason }[] — the ONLY legitimate way a repo/gist is absent: named,
                       with a reason (fork / archived / empty), never silent
  incomplete           { name, reason: 'deferred' }[] — work identified but not finished this run,
                       carried to tomorrow's liveOrgSnapshot comparison; NEVER conflated with excluded
  publishedRelease     the corpus-only GitHub Release this run produced, or null if it failed
                       before publication
```

**Invariant: `liveOrgSnapshot` is fetched fresh every run.** A `CorpusSupplyRun` that reuses a cached
org listing cannot detect a brand-new repo and is not a `CorpusSupplyRun` — this is the exact defect
this context exists to close (measured 2026-09-12: 15 repos, `rultra`/`ruClip`/`rGi` newest, absent
because nothing after the retired 2026-08-22 nightly ever re-listed the org).

**Invariant: `incomplete` is never silently dropped.** A run that cannot finish must carry its
`incomplete` set forward and its receipt must say `"incomplete": N` by name — a `CorpusSupplyRun`
that reports success while `incomplete` is non-empty is a contradiction the type system of this
document forbids, even though nothing mechanical stops a careless implementation from writing it.
(This is precisely why ADR-084's Invariant 1 command reads the coverage artifact, not this run's own
self-report — a self-report can lie about itself; a fresh live-org diff cannot.)

## Entities and value objects

- **`LiveOrgSnapshot`** — the result of enumerating `github.com/ruvnet` fresh: every repo (with
  `pushed_at`/HEAD sha), every gist (with `updated_at`/revision). Read-only, produced once per run,
  never mutated.
- **`CoverageRow`** (owned by DDD-0018/ADR-069, referenced here) — one repo or gist's
  `artifact.sourceCommit` vs `upstream.sha`. This context WRITES rows; it does not define what
  `CURRENT` means beyond that comparison.
- **`SealedCorpusSeed`** — the immutable input a run starts from (`data/corpus-seed.json`, currently
  `v4.2.1-dev`, sealed 2026-08-21). A `CorpusSupplyRun` diffs against the *live org*, not against the
  seed's age — the seed is provenance, not a freshness bound.
- **`CorpusRelease`** — a GitHub Release tagged `corpus-sha256-<digest>`, carrying only corpus bundle +
  manifest + receipts, whose `SOURCE.json.brainVersion` is pinned to the currently-shipped code
  version (ADR-085's hard constraint — a corpus release that drifts `brainVersion` gets rejected by a
  fresh install, by design, and must never be allowed to drift it).

## Context map

```
                    ┌─────────────────────────┐
                    │   Corpus Supply Chain    │  (this context)
                    │  CorpusSupplyRun         │
                    └───────────┬─────────────┘
                                │ produces
                                ▼
   LiveOrgSnapshot ──diff──▶ CoverageRow[] ──seals──▶ CorpusRelease
        ▲                        │                         │
        │ reads                 │ feeds                    │ discovered via releases/latest
        │                        ▼                         ▼
  github.com/ruvnet      Whole-product integrity      Updating context
  (external, live)       (DDD-0018 — evidence)        (DDD-0003 — customer
                                                        forge-update.mjs;
                                                        UNCHANGED by this context)
                                │
                                ▼
                    Console (scope.html / /api/scope)
                    renders CoverageRow[] for a human,
                    sorted by recency, searchable
```

Two upstream dependencies this context must never assume are free: the GitHub API (rate limits,
outages — a listing it cannot fetch is not an empty listing, per ADR-020's ingestion invariant) and
the local ONNX embedder (must run from the warm model cache; never an embedding API — zero
out-of-pocket is a hard constraint on this context, not a preference).

## Commands

- `EnumerateLiveOrg` — fetch every repo + gist from the live org; fail loud (not "0 new") on a
  listing the API refused.
- `IngestMissing(repo | gist)` — a name absent from `priorCoverage` entirely; produces a new
  `CoverageRow`.
- `RebuildChanged(repo | gist)` — a name present but `upstream.sha` moved; re-embeds, produces an
  updated `CoverageRow`.
- `ExcludeByPolicy(name, reason)` — the only sanctioned way to drop a name from the run without it
  becoming `incomplete`.
- `SealCorpusRelease(run)` — the ADR-085 mechanism: `release.mjs --corpus-seed` inside the one
  workflow whose identity check (`GITHUB_WORKFLOW === 'protected-release'`) permits it.

## Domain events

- `LiveOrgEnumerated { repoCount, gistCount, at }`
- `RepoIngested { name, sourceCommit }` / `RepoRebuilt { name, fromSha, toSha }`
- `RepoExcluded { name, reason }`
- `RunLeftIncomplete { names, reason: 'wall-clock-budget' }` — MUST fire whenever `incomplete` is
  non-empty; a run has no silent way to end without one of `CorpusReleased` or `RunLeftIncomplete`
  (both may fire on the same run — a partial success still publishes what it finished).
- `CorpusReleased { tag, digest, brainVersion, storeCount }`
- `CorpusSupplyRunFailed { phase, reason }` — carries the reason (ADR-064's lesson: an escalation
  without a reason is the same failure as no escalation).

## Policies

### Completeness is measured against the live org, never against the pipeline's own history

A `CorpusSupplyRun` that only re-checks names already in `priorCoverage` cannot discover a new repo
and therefore cannot be complete, by definition, regardless of how many stores it successfully
rebuilds. `EnumerateLiveOrg` is not optional and not cacheable across runs.

### A corpus release must never become a code release

`SealCorpusRelease` binds `brainVersion` to the *currently shipped* code version, read from that
version's own `plugin.json` — never from the seed's frozen value, and never bumped by this context.
If the shipped code version changes, that is Release Authority's decision (ADR-058), made separately,
by a human, through the existing gated path. This context has no write access to that decision and no
mechanism in it may acquire one.

### Silence is never evidence of completeness

Mirrors ADR-064's corpus-QA lesson at supply-chain scope: a run that says nothing about 15 repos is
not a run that covered them. Every name this context knows about (from `EnumerateLiveOrg`) must end
the run in exactly one of `ingested`, `rebuilt`, `excluded` (with reason), or `incomplete` (with
reason) — a name that appears in none of the four is the defect this whole document exists to make
structurally impossible to ship unnoticed.

## Failure semantics

- `EnumerateLiveOrg` failing (API error, not empty result) **fails the entire run** — a `0 new repos`
  result from a listing that could not be fetched is indistinguishable from real completeness unless
  the fetch failure is fatal, per ADR-020.
- A single repo's `RebuildChanged` failing does not fail the run; it moves that repo to `incomplete`
  with the real error, and the run continues (bounded per-repo failure, per the owner's own
  "keep going on non-fatal per-repo failures" instruction this session).
- `SealCorpusRelease` failing after a fully successful build means the run's `CoverageRow[]` are
  real and current on disk, but `publishedRelease` is null — the receipt must say so plainly rather
  than imply the corpus reached customers when it did not leave this machine.

## Acceptance

A `CorpusSupplyRun` satisfies this context's contract when, and only when:
1. `LiveOrgSnapshot` was fetched within this run (not reused), and its repo/gist counts are logged.
2. Every name in that snapshot resolves to exactly one of `ingested` / `rebuilt` / `excluded` /
   `incomplete` — verified by `node scripts/source-coverage.mjs --check`, which is the independent,
   external command that re-derives this from disk rather than trusting the run's self-report.
3. If `incomplete` is non-empty, `RunLeftIncomplete` fired and named every entry.
4. `publishedRelease`, if non-null, carries a `brainVersion` equal to the currently shipped code
   version (ADR-085's hard constraint) — checked by the existing fresh-install validator, which must
   reject any release where this is false.

Anything short of all four is not a completed `CorpusSupplyRun` — it is unfinished work that must
say so, in its own receipt, the same night it happens.
