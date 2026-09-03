# Dream Cycle 2026-09-03 — grounding-quality SOTA Report

## Rotation

DEEP=`grounding-quality`, SCAN=`retrieval-precision`,`citation-binding` (slot 3 of 5,
`20260903 % 5 == 3`). No bonus modulus tonight (`% 25` = 3, `% 75` = 28, both non-zero).

## Ledger check (reconciliation)

Read `docs/dream-cycle/LEDGER.md` (9 prior rows, 2026-08-19 → 2026-08-31). Re-checked the fate of
recent issues/PRs via GitHub MCP rather than assuming:

- `#142/#143`, `#147/#148`, `#149/#150`, `#178`, `#215` — **MERGED**.
- `#154/#155` — PR closed unmerged, change landed on `main` directly via `420854b`.
- `#185` (closed by owner 2026-08-30) / **PR #186** — still open/draft as of this morning, but its
  fix (`kb/verify-citation.mjs`'s bounded-span + sequential-rank check) is **already on `main`**
  via commits `a04ffc9`/`0ae0196` (2026-08-30). Closed PR #186 tonight as integrated, with a comment
  citing the exact commits.
- `#187` (still open) / PR `#188` closed unmerged — its fix (`eval-brain.mjs`'s `routed` metric
  reading `receipt.repo`) is **already on `main`** via commit `39349c0` (2026-08-30). Closed issue
  #187 tonight as integrated, with a comment citing the commit.
- `#212/#213` closed unmerged; the same finding (`forge-currency.mjs` store-root) appears to have
  landed via a separate non-dream commit/PR (#222, merged 2026-08-31) — flagged, not independently
  diff-verified tonight.
- **Zero merges since #215 (2026-08-31)**, i.e. the 3 days up to tonight. 17 `dream/*` PRs are
  currently open/draft (#157, #159, #162, #164, #167, #168, #172, #174, #182, #184, #192, #194,
  #227, #229, #231, #233, plus #226/#228/#230 as newer open issues without a merged PR yet) — the
  review backlog first flagged 2026-08-26 has not shrunk in any of the 5 nights since. This is
  independently the single highest-value action available to the owner right now, restated because
  it has been restated every relevant night since and nothing about it has changed.

**Learning signal applied:** zero of the recent `dream/*` PRs have merged since 2026-08-31 → bias
tonight's output to something that does **not** add to the open-PR backlog if it isn't a clean,
small, immediately actionable code fix (see Recommendation).

## Deep dive

Read `docs/adr/0025-hybrid-retrieval-and-self-retrieval-gate.md` (hybrid retrieval / self-retrieval
gate) and both prior grounding-quality nights' reports (`2026-08-28-grounding-quality-report.md`,
`2026-08-28-grounding-quality-routed-receipt-report.md`). The 2026-08-28 security review on PR #186
explicitly named a residual risk and deliberately deferred it: *"It does not close a maximally
adversarial case engineered to predict and spoof the exact next expected rank... needs a structural
fix... named as a follow-up ADR candidate, not attempted here."*

Investigated two hypotheses before settling on this one:

1. **`repo:` directive alias resolution** (`kb/forge-ask-all.mjs`'s `inventoryReposFromQuery`): the
   directive-specific branch resolves only against canonical store names, never through
   `repositoryNames()`/`repo-aliases.json`. Traced the full call path: `qIdentityPhrase` is derived
   from the ENTIRE original query text (punctuation normalized to spaces), so an alias word inside
   a failed `repo:<alias>` directive still appears as plain text and gets picked up correctly by the
   subsequent free-text `named` loop, which does use `repositoryNames()`. Wrote out the resolution
   by hand for combined-directive and single-directive cases; found no case where the final
   `repos`/`confidence`/`inventoryScope` output actually differs — only the `reason` string's wording
   differs (cosmetic). **REJECTED as a live behavioral defect** — no user-visible wrong answer,
   confirmed by tracing rather than assumed.
2. **`scripts/rerank-cap-eval.mjs`/`rerank-cap-warm-ab.mjs` treating `grounded` as "retrieval
   returned ≥1 result"** instead of calling real `verifyGrounding()` (flagged, not actioned, in
   issue #187): re-read the code — the weaker definition is a deliberate, commented design choice
   for these offline A/B replay tools (`// grounded is structurally true here: every candidate is a
   passage the retriever actually returned`), not an oversight. **Not a new, actionable defect** —
   it is documented intentional scope, consistent with `findingPolicy.skipIf: environment-only`-style
   reasoning (these tools never claim disk-verified grounding in the first place).

## Hypothesis (frozen before further investigation)

> Given `kb/verify-citation.mjs`'s `parseCitations()` as fixed by PR #186 (bounded per-block
> extraction + strictly sequential rank enforcement), when a retrieved document's own indexed body
> contains a header-shaped look-alike claiming to be the NEXT sequential rank relative to wherever
> that document itself is retrieved, then `parseCitations()` accepts the look-alike as the real
> citation for that rank and the genuine citation at that rank is silently dropped — **without the
> attacker needing to predict which rank their own document lands at**, only that whatever rank it
> lands at, "the next one" is a fixed, computable offset (+1) they can pre-author into their own
> document's body ahead of time. This is a *more* exploitable variant than the "maximally
> adversarial, must predict the exact next rank" case the 2026-08-28 security review characterized
> as the closed-out residual risk, because no prediction of an absolute rank is required at all —
> only a relative one, which is trivially always "+1" from wherever the attacker's own content
> happens to land.

## Evaluation receipt

Not a corpus/model-graded question — a direct, deterministic reproduction against the real,
unmodified `kb/verify-citation.mjs` on `main` (commit `cbca83b`). Two independent repros, committed
as evidence (`docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-{a,b}.mjs`, runnable
standalone from repo root, zero corpus/model dependency):

- **Repro A** (`...-repro-a.mjs`): a retrieved document's dumped body contains one look-alike header
  claiming rank #2. `parseCitations()` on the resulting stdout parses **only 2 citations, both
  `repo=evil`** — the real rank-2 citation (`repo=good`) never appears in the output at all, having
  been silently consumed by the look-alike. `node docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-a.mjs`
  → exits 1, prints `VULNERABLE`.
- **Repro B** (`...-repro-b.mjs`): the same hijack, but the look-alike's path resolves to a real
  passage the attacker's own store carries. `verifyGrounding()` returns `grounded: true` — correctly,
  in this instance, on the attacker's own genuinely-retrieved rank-1 citation — but the parsed
  citation set still shows the real rank-2 (`repo=good`) evidence was dropped and replaced before
  `verifyGrounding` ever got a chance to examine it. In a variant where rank-1 does not resolve
  (omitted here for brevity; follows directly from Repro A's mechanism), `verifyGrounding` would
  fall through to the hijacked rank-2 entry and report `grounded: true` with `receipt.repo` naming
  the attacker's chosen document instead of the real one. `node docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-b.mjs`
  → exits 1, prints `VULNERABLE`.

Both repros run clean against `main` with no modification required — TEETH proven by direct
execution, not inferred from logs.

`npm run eval:gate`: not attempted for this finding — it is a parser-logic security question, not a
question the frozen 120-question held-out set can distinguish (same reasoning independently reached
on 2026-08-28 for the sibling finding). This container also still has no materialized corpus
(`stores 0 dark 0`, confirmed via `store-root.mjs` tonight), consistent with every prior night.
`OPENROUTER_API_KEY` is present — `LLM_EVAL` is not credential-blocked, simply not applicable here.

## Why no code candidate ships tonight

A parser-only patch (e.g. requiring more of the fixed-format trailer — `chars:`/`chunks:`/the
`----- full document -----` line — to immediately follow a candidate header) would raise the
attacker's replication cost but **cannot close the gap**, because nothing in the wire format is a
secret: an attacker who has read this file's own header comment (or `forge-ask-all.mjs`'s source)
can reproduce any fixed textual pattern byte-for-byte. Closing this for real needs one of:

1. **A per-query, unguessable value bound into the header format** (e.g. a random token generated
   fresh in `forge-ask-all.mjs` at the start of each `searchAll()` invocation, printed once up front
   and required on every citation header; `verify-citation.mjs` rejects any header not carrying it).
   Small in concept, but touches the reader's *output format*, which the existing docstring says at
   least three other consumers also parse (`forge-mcp.mjs`, `forge-mcp-all.mjs`, `card-lane.mjs`) —
   blast radius not established, so not "bounded" as this repo's own policy uses that word.
2. **Structured (JSON) citation transport** instead of human-readable delimited text — the fix the
   2026-08-28 security review already named as the real answer, with the same blast-radius caveat,
   more so.

Both are **architectural decisions**, not a tiny nightly patch, and this repo's own learning signal
(zero of the recent `dream/*` PRs merged) argues against adding another unreviewed candidate to an
already-growing backlog. Filed as `ADR-0076` (Proposed) instead of a code candidate, per this
routine's own STEP 19 ("create an ADR only if tonight's result is an architectural decision").

## Evidence classification

OBSERVATION (PR #186's own security review named an unclosed "maximally adversarial" case) →
MEASUREMENT (two independent, reproducible repros against unmodified `main`, both `VULNERABLE`,
proving the case requires no rank prediction — only a fixed +1 relative offset — which is a
materially easier bar than "predict the exact next rank") → DECISION (open issue + ADR-0076
Proposed; no code candidate; REJECT the "a bounded same-file patch can close this" hypothesis).

## Reward-hack check

N/A — no benchmark, threshold, or gold answer touched. No candidate code shipped. The two evidence
scripts are demonstrations, not tests added to the enforced suite (deliberately — see below).

## Security review

This IS the security finding. Summary for anyone reviewing this report in isolation: a citation
verification bypass in `kb/verify-citation.mjs`, exploitable by any actor who can get content
indexed into any store this repo's retriever searches (an ingested repo, gist, or transcript). The
practical severity depends on how attacker-controlled that ingestion path is — this repo already
treats ingested content as generally trusted-but-verified (that is the entire reason
`verify-citation.mjs` exists at all, replacing a keyword-presence check), so this is a real gap in
the "verified" half of that story, not a theoretical one. No fix shipped tonight (see above); no
production behavior changed by this report.

Why the two repro scripts were **not** added to `tests/unit/` as new test cases: doing so would add
a permanently-red assertion to the enforced suite for a defect with no accompanying fix, which
would break CI for the next person to touch this file for an unrelated reason. They are committed
as standalone, directly-runnable evidence instead (`docs/dream-cycle/evidence/`), referenced by
issue and ADR, so `ADR-0076`'s eventual implementer has a ready-made regression test to promote into
the suite once a bounded fix exists.

## Scan findings

1. **citation-binding** (elevated to tonight's focus): see above.
2. **retrieval-precision**: re-confirmed ADR-025 Open Item #3 (`kb/self-retrieval-bench.mjs` still
   not wired into any nightly/CI gate) is still true by inspection tonight, five weeks after first
   noted (2026-07-19) and re-flagged again on 2026-08-28. Not actioned — same reason both times: it
   needs a materialized corpus this container does not have. Re-flagging a fourth time without new
   evidence would be exactly the "don't rediscover a failed direction" anti-pattern this routine is
   supposed to avoid, so this is the last time this report repeats it without either new evidence or
   a materialized corpus to test against.

## Competitors

LangChain, LlamaIndex, and Sakana AI Scientist's structured pipelines all carry citations as typed
objects rather than round-tripping through printed, human-readable text — the same observation the
2026-08-28 report made, unchanged and re-confirmed rather than re-researched from scratch (C-grade,
general design knowledge; informs `ADR-0076`'s "structured transport" alternative).

## Gist

No gist-creation tool available in this session (no GitHub MCP gist endpoint, no `gh` CLI). This
report is the fallback artifact, same precedent as every prior night since 2026-08-26.

## Witness

Session commit `cbca83bc7a72a8ee4552d50530e391694200b670`.

Computed as `WITNESS = sha256(REPORT_HASH + SESSION_COMMIT)`, where `REPORT_HASH` is this file's
own sha256 as it existed immediately before this section was filled in (the version tracked by git
as the parent commit of the one adding this witness).

```text
REPORT_HASH = d781631c39d89f253227ca07ec5a7e45d8a904cdf2f98fd57a0f71194178898d
WITNESS     = d9dd3ac3f78f61d94199b50503c927145f40d456805ba9bda3a5e79e814391d5
```

**Verifier procedure** (5 steps, reproducible by anyone):
1. `git show cbca83bc7a72a8ee4552d50530e391694200b670:docs/dream-cycle/2026-09-03-grounding-quality-report.md` — not applicable here, since this file did not exist at that commit; instead, check out this PR's commit that ADDS this file *without* this Witness section filled in, or recompute directly against the file as committed with the placeholder text removed.
2. Recompute `sha256sum` of the report content used in step 1.
3. Concatenate that hash with `cbca83bc7a72a8ee4552d50530e391694200b670` (no separator) and `sha256sum` the result.
4. Compare against `WITNESS` above — a match proves this report's content, as evaluated, is bound to this exact session commit.
5. Independently re-run both evidence scripts (`docs/dream-cycle/evidence/2026-09-03-grounding-quality-repro-{a,b}.mjs`) against `main` at commit `cbca83b` to reproduce the underlying finding directly, rather than trusting this report's own claim.

## ADR index note

This routine's STEP 19 says to "add the INDEX row" when creating an ADR. `docs/adr/README.md`'s
index table stops at ADR-0010 — it has not been updated for any of the 65 ADRs added since
(0011 through 0075 are all missing rows). Adding ADR-0076's row alone, immediately after 0010, would
misrepresent the table as current when it is not. Not done tonight; flagged instead as a separate,
pre-existing gap the owner should decide how to handle (backfill vs. drop the table vs. replace it
with a generated index) — not folded silently into this report's own diff.

## Recommendation

`evaluated: attempted but blocked` for a code candidate (architectural fix required, out of bounded
scope tonight); the finding itself is real and reproduced. Human review requested for `ADR-0076`
(Proposed) — pick a direction (per-query nonce token vs. structured transport), and, separately and
more urgently: the 17-PR `dream/*` review backlog needs owner triage independent of anything in this
report; it has been flagged every relevant night since 2026-08-26 and has only grown.
