Updated: 2026-11-16 23:22:00 EST | Version 1.1.0
Created: 2026-11-16 21:45:00 EST

# RuvNet Brain: target knowledge architecture and ingestion plan

> **Status at 12:10 a.m. ET, 2026-11-17: superseded in part.** By owner direction the target design is being
> redrawn around RuVector's own memory design. Read `../REPLAN.md` and
> `../ruvector-deepdive/04-DESIGN-THE-RUV-WAY.md` for the design now proposed (cue, tag, content; reconstruction
> by traversal; typed abstention; evolved settings). Sections 1, 2, 5 and 7 below remain correct as
> measurements, ingestion plan and defects. Section 3 is no longer the target; section 4's verdict is open by
> owner order (the pending rows will be filled when the paused screen resumes).

Status: a design with a measurement behind each part, written during the 2026-11-16 run. Nothing here is built
into the product, committed or shipped. Evidence paths are relative to
`evals/runs/2026-11-16-knowledge-architecture/`. Every decision, with what was rejected and why: `DECISIONS.md`.
Kinds of knowledge and the taxonomy: `ontology/ONTOLOGY.md`. Rules fixed in advance: `PREREGISTRATION.md`.

Question sets used: D = 113 development questions (76 inside the ten pilot stores; not blind). E = 164 blind
questions by four authors. F = 80 blind questions by two further authors who found gold without keyword
search. The 237 sealed exam2 questions were not opened.

## 1. What is wrong today

| Measured on the shipped product (4.7.28) | Value | Evidence |
|---|---|---|
| Gold file in the top 5, D | 4 of 113 | `baseline-v1/` |
| Gold file in the top 5, E | 8 of 164 | `candidates/rigE/` |
| Refused to search / "insufficient evidence" / one file only (of 164) | 19 / 90 / 120 | same |
| Passages longer than the embedder's window; tokens never embedded | 73.7%; 50.0% | `inventory/knowledge-type-census.json` |
| Gold file's path present in the shipped stores | 110 of 113 | `baseline-v1/gold-indexed.json` |
| Commits, issues, relationships, reasons, corrections, public talks | not stored | census |
| Answer level, 49 questions, one run, for information only | 60.8 of 100; 5.3 searches per answer; 34 s per search | `candidates/answers/` |

The files are there and are not found on the first page. Causes, each measured: chunks twice the embedder's
window with no path header; most source files indexed only by their opening comments; no lexical lane; a
router that declines; one result returned most of the time; whole kinds of knowledge never ingested.

## 2. What the measurements admit, and what they do not

| Part | Verdict | Evidence (top-5 gold unless stated) |
|---|---|---|
| Rebuilt passages: symbol and heading chunks inside the embedder window, path header first | ADOPT | same embedder, D: 3 -> 26 of 76 (rule R2 met) |
| Lexical lane over all passages (SQLite FTS5, rUv's Lucene analyzer, identifier splitting) | ADOPT, the backbone | D 40 of 76; E 78 of 164 against 8 shipped; F 41 of 68, and still ahead of dense by 26 points when gold was found without keyword search (rule C3 met) |
| History store (commits, owner-written issues / PRs / comments, releases) as its own result section | ADOPT | finds 17 of 21 (E) and 8 of 12 (F, rule C2 met); no other lane finds more than 1 |
| Current dense vectors fused into the file ranking | DO NOT ADOPT | fused against lexical alone: D +6, E 37 against 45 of 80, F 39 against 41 of 68 |
| A different embedder | see section 4 | two-stage screen |
| File-section summaries with newcomer questions | KEEP BUILDING, not yet admitted | D: novice 13 -> 20 of 35, and 29 of 36 where a unit exists; lowers E when it covers 9 of 24 stores. Needs full coverage, then rule R4 again |
| Concept cards as a retrieval section | DO NOT ADOPT YET | post hoc gain on E (66 against 45 of 82 where a card covers gold) failed its pre-registered confirmation on F (52 against 46 of 80, p = 0.15; all of it from history) |
| Concept cards in the served answer context | DO NOT ADOPT YET | answer level, with cards 75.7, without 73.1: +2.6 [-0.4, 5.7], rule not met; +5.3 [0.4, 10.3] where a card covers the gold; false claims 15 against 29 |
| Rank fusion across unlike units (cards, facts, history, files) | REJECT | harmful three times (facts lane 2026-11-15; cards on D; history on E) |
| Graph expansion at query time | REJECT | 75.6% against 75.0% |
| Glossary query expansion | REJECT | 62 against 78 of 164 |
| Reranker / router gate before search | REJECT (already measured in ADR-0099 and on 2026-11-15) | not re-tested today |

Answer level (84 questions of E, 3 runs per arm, Sonnet answers, Opus judge blind to arm, mechanical citation
check first, judge calibration gate passed 18 of 20): no tool 25.4 of 100; files + history 73.1; files +
history + cards 75.7. Files + history against no tool: +47.7 points [43.2, 52.1].

What nothing tested today solves: the amateur who knows only the problem. On F, lexical 10 of 32, dense 9 of
32, fused 12 of 32; which-tool questions 9 to 11 of 24. At answer level amateurs reach 72.3 (with up to six
searches). This is where summaries, cards and a better embedder have to prove themselves, each at full
coverage.

## 3. The architecture

Principle 1: store each kind of knowledge as the unit it naturally is (ontology table 2). Principle 2: every
unit carries its standing (implemented, measured, decided, corrected, negative, claimed, planned, instructing,
speculative, hostile, spoken), date, supersession links, maturity with evidence, privacy flag, and source paths
that resolve to real files. Principle 3: unlike units are shown in separate sections with their own budgets,
never rank-fused. Principle 4: a derived layer is switched on only when it covers the whole corpus and has
passed a rule fixed in advance on questions it has not seen.

| # | Store | Unit | Built by | State after this run |
|---|---|---|---|---|
| S1 | Passages + lexical index | symbol / heading chunk, path header | deterministic chunker (branch `worktree-agent-a00e59ae16c567ff6`) | admitted; 24 stores built in scratch (880,493 passages) |
| S2 | History | commit, owner-written issue / PR / comment, release note | hosting API, read-only | admitted; 6 repositories built in scratch (52,191 passages) |
| S3 | Passage vectors | same chunks as S1 | embedder of section 4 | not admitted with the current embedder |
| S4 | Unit summaries + newcomer questions | one per file section | Sonnet, every claim with source lines | build for all stores, then test |
| S5 | Concept cards, interplay stories, rationale notes, claim and correction records | one per concept / decision / measured claim | extraction with verbatim quotes, evidence-checked | 726 cards, 61 stories from about 300 of 5,243 units; build for all units, then test |
| S6 | Graph, glossary, habits, timeline | typed edges with quotes; manifest dependency edges; everyday-word bridges; reasoning habits | mechanical + extraction | 2,066 manifest edges, 689 quoted relations, 420 bridges, 69 habits, 57 timeline entries: reference data; no retrieval role admitted |

Served result today's evidence supports: FILES (top 5 from the lexical lane, up to 8,000 characters centred on
the best passage of each) + HISTORY (top 3) + one closing line with the authority order (implemented >
measured > corrected or negative > decided > claimed > planned > speculative), under the host's cap of about
25,000 tokens. No router decides whether to search. No card may answer in place of a search. Hostile fixtures
are never served. Measured per search: 1.8 s.

## 4. The embedding question

What is settled:
- The shipped vectors fail for reasons that are not the model: half the tokens fall outside its window and no
  header is embedded. Same model, new chunks: 3 -> 26 of 76.
- With new chunks the current model's dense lane is the weakest lane on every set (D 25 of 76, E 24 of 80,
  F 23 of 68) and adds nothing to the lexical lane on blind questions.
- The 8-bit model's output depends on batch composition: re-embedding the same passages gave the same five
  files for 28 of 76 questions. Any vector lane needs fixed batching or full-precision weights.

The screen (rule R1, amendments A1 and A3; `candidates/rig/rigB-R1.md`, `rigB-R1-final.md`): each candidate
re-ranks a pool that can only flatter it. Dev-pilot results so far (n = 76; candidate against the re-embedded
incumbent control):

| Model | Dense top 5 | Fused, equal weights | Fused, lexical weight 2 |
|---|---|---|---|
| incumbent control (bge-base-en-v1.5) | 25 | 42 | 45 |
| snowflake-arctic-embed-m-v1.5 | 36 (+14.5 points, p = 0.019) | 48 (+7.9, p = 0.21) | 46 (+1.3) |
| gte-modernbert-base | 42 (+22.4, p = 0.0001) | 51 (+11.8, p = 0.012) | 49 (+5.3, p = 0.22) |
| nomic-embed-text-v1.5, jina-v2-base-code, bge-large-en-v1.5, embeddinggemma-2 | EMBEDDER-ROWS-PENDING | | |

EMBEDDER-VERDICT-PENDING

## 5. Ingestion plan, per source

| Source | Volume (measured) | Route | Goes into | Standing / notes |
|---|---|---|---|---|
| Repository trees | 207 non-fork repositories, 198 already have stores | existing CI corpus build with the new chunker; index source bodies, stop skipping folders named `v2` | S1, S4 | code = implemented; READMEs = claimed until matched to code |
| Decision records | about 1,900 ADRs; one repository has 27 numbers shared by 61 files | extraction per ADR, identified by slug | S5, edges into S6 | decided, with status; superseded records flagged |
| Benchmarks, audits, post-mortems, corrections | about 750 | extraction to claim / correction records linked by supersession | S5 | the correction is stored with, and ranked above, the claim |
| Commits, issues, PRs, release notes | 6 repositories done: 18,949 commits, owner-written issues, PRs and comments, 2,170 release notes = 52,191 passages; 396 API calls | hosting API, read-only; owner-written text only (other people's text is not stored) | S2 | extend to the top 25 repositories (3,848 issues, 6,518 PRs, 2,498 releases); nightly delta by date |
| Gists | 517 listed, passages for 433 today | existing gist pipeline; find why 84 have none | S1, S4, S5 | essays = speculative where they are; two gists are prompt-injection fixtures: flag hostile, never serve |
| Package manifests | 1,450 manifests, 1,148 packages, 2,066 edges | mechanical parse | S6 | vendored duplicates resolved to the shallowest path |
| Package registries | 795 package cards built from an older corpus | rebuild from the registries | S5 | version facts are dated |
| ruv.io | 107 sitemap URLs; the store is built from the site's repository | keep building from the repository (robots allows a crawl; not needed) | S1, S4 | claimed / announcing |
| x.ruv.io | a service descriptor, not content | index the manifest, onboarding, registry and tool descriptions only | S1 | relay and channel data is third-party: not ingested |
| Meetings and call transcripts | 1 indexed (317 passages); 2 more on disk (Aug 14 weekly; Jun 26 hackerspace) | `scripts/ingest-meeting.mjs --append`, private fence | private S1 + habits in S6 | spoken; rUv's turns only; other speakers never quoted by name; never bundled |
| Public videos (YouTube, ruv.io/live) | not measured: no channel URL on this machine | once the channel URL is known: list videos, take captions per video with the installed `watch` tooling where the site's terms allow, or use transcripts rUv supplies | new store "talks": speaker turns into S1, summaries into S4, habits into S6 | spoken, dated; owner decision 1 |
| X posts | no archive on disk; robots forbids crawling; the API bills per post read | the account owner's archive export (free, complete, lawful). Nothing else | new store "posts": one unit per post or thread, dated, into S1 and S2-style dated search | claimed / announcing; owner decision 2 |
| cognitum.one | robots forbids AI crawlers | not collected | none | that organisation's public repositories are already covered |
| LinkedIn, Substack, Medium | no references found on disk | not looked up | none | add when a URL list exists |

## 6. Build order, each step with the gate that admits it

1. S1 for all stores, and S2 for the top 25 repositories, served as FILES + HISTORY. Gate: the sealed exam2
   set, opened once after the build, plus a fresh history stratum (rule C2 again).
2. S4 for every store (not a subset). Gate: rule R4 on new questions, amateurs reported separately.
3. S5 for every unit by per-unit extraction (a card whose quotes do not verify is excluded). Gate: a new
   pre-registered test of the card section at retrieval and at answer level; target signals to beat: +5.3
   points where a card exists, false claims halved.
4. S3 only as section 4 allows.
5. Product serving change (sections, authority line, no router). Gate: answer-level test with the no-tool
   baseline and the shipped product at three complete runs.

Footprint (ADR-0098 treats it as a cost): text + lexical index measured at 1.33 GB for 644k passages, about
2.3 GB projected for the whole corpus, against 1.7 GB shipped today with vectors. Full-precision vectors for
every passage would add about 3.4 GB; for the documentation tier about 1.0 GB.

## 7. Defects found on the way (to fix regardless of this design)

1. `plugin/mcp/server.mjs` starts its search worker with the node path the server was started under. After
   Homebrew replaced node at 3:31 a.m. on 2026-11-16 every long-running session lost `search_ruvnet`
   ("brain worker exited" after 7 ms: the old binary cannot load `libsimdjson.36.dylib`). Fix: when the worker
   exits immediately, resolve node again from PATH and retry once; write the dead path to `health.json`.
2. Opening a vector store "read-only" rewrites its `.idmap.json` sidecar. This run's dense tool did that to nine
   shipped stores; the bytes are identical to the release manifest (checked, 9 of 9), only timestamps moved.
3. The shipped bge build embeds bare text with no header (`kb/forge-big.mjs:302`, `:432`) and chunks at 4,000
   characters (`kb/forge-corpus.mjs:11`).
4. Each shipped search worker uses about seven cores; six at once drove this machine's load to 196.
5. The gist store has passages for 433 of 517 gists; cause not investigated.
6. The owner's global instructions prescribe `createAIDefence({ ..., blockThreshold: 'medium' })`. In the ruflo
   clone `blockThreshold` is an option of `createAIDefenceGate`
   (`v3/@claude-flow/guidance/src/ruvbot-integration.ts:96`, `:1024`), not of `createAIDefence`
   (`v3/@claude-flow/aidefence/src/index.ts:227`).
7. Two public gists are prompt-injection test pages and are indexed as ordinary content today.
8. The Sonnet subscription quota ran out at 9:32 p.m. during the answer runs ("all 2 accounts are at their
   quota"); runs resumed by themselves. Large answer-level tests need to be paced.
9. Oversized results: a search_ruvnet answer of 65,066 characters (and, in the parent session, of 61,000 and
   51,000) was rejected by the host as larger than it accepts, so the model received nothing. The answer text
   and the structured copy of the same documents are both returned, which doubles the size. The product must
   cap the total result (the candidate server in this run stays under 80,000 characters and returned 42,000 to
   49,000) and must not send the same document twice.
10. The Brain pins the vector library at versions 0.3.4 / 0.2.3; the read-only sidecar rewrite of item 2 is
    fixed upstream in 0.4.x (reported by the deep-dive researcher, npm/packages/rvf/src/backend.ts:731).
11. Any question containing the word "brain" is routed to the ruvnet-brain repository, so rUv's own pi brain
    cannot be asked about by name (reported by the deep-dive researcher).
