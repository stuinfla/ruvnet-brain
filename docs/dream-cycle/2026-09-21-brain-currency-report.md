# Corpus-Freshness Package-Name Boundary SOTA Report — 2026

## TL;DR
`kb/corpus-freshness.mjs`'s `versionIntent()` — the function that decides which package a "what's
the latest version of X" question is about, and therefore what `npm view <package> version` command
`freshnessAdvisory()` tells the reader to run — mishandles a sentence-ending period two different
ways: it **drops** a bare package name entirely (`BARE_PACKAGES` boundary regex treats `.` as
"still part of the token", never as a boundary), and it **corrupts** a scoped package name by
absorbing the trailing period into the captured string (`SCOPED_PACKAGE` regex has no requirement
that a match end on an identifier character). Both are reproduced live on this container with no
model calls and no corpus. Fix: two narrow regex changes, ~10 lines, in the one module the repo's
own header comment calls "the ONE place that decides what this brain is allowed to say about
'latest'".

## What's new
Nothing architectural — this is a correctness bug in an existing, well-documented, previously-hardened
module (the file's own header already records two prior incidents this exact function class caused:
the agentdb alpha.6-vs-alpha.20 ranking miss, and the CLI/MCP asymmetric-warning bug). Tonight's
finding is a third, narrower defect in the same function, previously untested: sentence-final
punctuation immediately after the package name.

## Competitors (how they handle entity-boundary extraction from free text)
- **Sakana AI Scientist** (grade C, vendor blog + repo skim) — generates and revises hypotheses via
  LLM calls; does not rely on hand-rolled regex tokenization for the surfaces it touches, so this
  class of bug does not apply the same way. Not directly comparable to a zero-LLM local pattern here.
- **OpenHands** (grade C) — its tool-argument parsing for shell/file targets uses structured
  tool-call schemas (JSON), not free-text regex extraction, sidestepping this exact failure mode
  entirely; the lesson transfers: prefer a structured extraction boundary over regex where the
  caller controls the schema. Not fully applicable here because `versionIntent` must parse a human's
  free-text question, not a tool call.
- **DSPy/GEPA** (grade C) — treats prompt/parsing logic as an optimizable program; a bug like this
  would surface as an eval regression the optimizer could in principle catch, but only if the eval
  set contains a trailing-punctuation example, which is exactly the gap this candidate closes locally
  with a targeted unit test rather than an optimizer loop.
- **SWE-agent** (grade C) — issue-to-patch agents commonly regress on exactly this kind of "off by
  one token" boundary bug because the agent's own test suite rarely enumerates punctuation variants;
  the standard mitigation (used here) is a hand-written adversarial unit test for the boundary case,
  not a broader rewrite.
- **Cursor background agents** (grade C, product docs) — background code-review agents flag regex
  boundary assertions as a common source of silent false negatives; consistent with tonight's finding
  class (a "boundary that silently fails" rather than throwing).
- General NLP grade: false negative / invalid boundary detection around punctuation is a documented
  class of NER/entity-extraction error (grade B, cross-checked via Stanford NLP RegexNER docs and
  academic NER error-taxonomy papers), which is the general phenomenon this bug is a concrete instance
  of.

## Hypothesis (frozen before implementation)
Given a version-intent query ending in a sentence period immediately after the package mention (e.g.
`"What is the latest version of ruflo."` or `"...of @claude-flow/cli."`), when the boundary regexes
in `kb/corpus-freshness.mjs`'s `SCOPED_PACKAGE` and the `BARE_PACKAGES` matcher inside `versionIntent()`
are corrected to treat a period followed by whitespace-or-end-of-string as a real token boundary
(while continuing to reject a period followed by another identifier character, e.g. `ruflo.js`), then
`versionIntent(query).packages` should name the package correctly in both cases, relative to the
current baseline (which returns `[]` for the bare case and `"@claude-flow/cli."` — trailing dot
included — for the scoped case), subject to: no existing `versionIntent`/`freshnessAdvisory` test
regressing, and no new false-positive package match introduced (verified against `ruflo.config.js`,
`ruflo.md`, `ruflo/subpath` style mentions, which must still NOT match).

## Benchmarks / Evaluation
No model calls, no corpus required — this is a pure function of a query string. Evaluator used:
`npm run qa:pr`'s unit-test lane (`vitest run tests/unit/grounding-freshness.test.mjs`), plus the
full `test:unit`/`test:integration` suites for regression. `npm run eval:gate` does not apply (this
container never materializes a corpus — `stores 0 dark 0`, consistent with every recent ledger row);
`LLM_EVAL=blocked` (no `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in this container's
env).

## Evaluation Receipt
- New TEETH tests (`tests/unit/grounding-freshness.test.mjs`, `versionIntent` describe block): **fail
  on pre-candidate code** exactly as predicted — `expected [] to deeply equal ['ruflo']`,
  `expected ['@claude-flow/cli.'] to deeply equal ['@claude-flow/cli']`, `expected ['agentic-qe'] to
  deeply equal ['ruflo','agentic-qe']` (3/3 red). **20/20 pass** post-candidate (initial fix), then
  **6/6 pass** in the new `versionIntent` block / **21/21** in the file after an independent
  adversarial critic found and this candidate closed one further gap (ellipsis `"..."` on the
  bare-package path — see Adversarial Critique below).
- `tests/unit/grounding-identifier-recall.test.mjs` (24 tests, exercises the same two regexes from a
  different angle): 24/24 pass, unaffected.
- `test:unit` (full suite, `git stash`-diffed baseline vs candidate): **byte-identical failure set**,
  16 files / 51 tests failed both sides (all pre-existing chmod/EACCES-under-root-user fixtures and
  the CE-model-priming/network-dependent regression suite — none reference `corpus-freshness.mjs` or
  the changed test file), 434 passed files / 5556→5562 passed tests (the +6 are this candidate's own
  new assertions). `data/convergence-manifest.json` regenerated (`npm run convergence:write`) after
  editing tracked source, as this repo's push gate requires; `convergence:check` now reports `ok:true`.
- `test:integration` (`git stash`-diffed baseline vs candidate): **byte-identical failure set**, 9
  files / 23 tests failed both sides — all a disposable cross-encoder model priming/network-cache
  regression on this container (`tests/regression/reader-deadlock-pr0p.mjs`), unrelated to this
  change. `tests/integration/hook-conformance-both-hosts.test.mjs` (the both-hosts gate): 10/10 pass.
- `eval:gate`: EVALUATED=blocked — `no brain at /root/.cache/ruvnet-brain/kb` (this container never
  materializes a corpus; consistent with every recent ledger row, not a credentials block). Not the
  primary evaluator for this candidate regardless, since the defect and fix are corpus-independent
  (a pure function of the query string).
- `claims:verify`: 3 PASS / 4 SKIP (brain-not-installed / coverage-run-absent / replay-artifact — all
  pre-existing, unrelated to this change).
- `LLM_EVAL=blocked` — no `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in this container's
  env. Not needed: no model call is involved anywhere in this candidate or its evaluation.

## Adversarial Critique (independent critic, not this candidate's author)
Verdict: **CLEAR**, after one real gap found and closed mid-session. The critic wrote its own
adversarial cases (multi-punctuation, sentence-start package, unicode ellipsis/CJK punctuation,
substring-of-another-bare-package, case sensitivity, scoped-package edge cases) and ran them directly
against the live module. It found that the initial fix's bare-package boundary (`\.(?=\s|$)`, a
*single* trailing period) still failed on a literal ASCII ellipsis (`"...version of ruflo..."` →
`packages: []`) — the same failure class, just three dots instead of one; the scoped-package regex
did not share this gap (structurally anchored, not punctuation-lookahead-based). Fixed by widening the
lookahead to `\.+(?=\s|$)` (one-or-more periods). Re-verified: no benchmark/gold-answer/threshold
touched, no LLM/evaluator in the loop to game, no hidden cache or mutable state, blast radius confined
to `versionIntent`'s two internal regexes (`SCOPED_PACKAGE` is private to this module; no other module
depends on the old absorption behavior), and no injection/ReDoS risk (the `name` interpolated into
`new RegExp(...)` is always drawn from the fixed, frozen internal `BARE_PACKAGES` array — never from
the user's query text, which only ever reaches `.test()`).

## Security Review
Not security-sensitive in the STEP 15 sense (no prompt injection, tool/MCP authority, credential
exposure, or filesystem/network scope change) — a pure string-parsing function with no I/O. The one
adjacent risk considered and ruled out (regex-injection/ReDoS via user-controlled text reaching
`new RegExp`) is covered in the Adversarial Critique above.

## Witness
```text
Session commit:  6c0c8d4abb09577f655f9e8a61b2733d95a62f18
Report sha256:   8d761180e61714a5ba092a7bd8bcee28eabaa69ab67d2995aaee27fdb2cc247e
Witness stamp:   ecda6238f37cc8a603a305635de7aa492e4ac999f34e29142bf8511a263311a2
```
Computed as `sha256(report_sha256 || session_commit)` — the concatenation of the two strings above,
hashed once more.

**Verifier procedure (anyone can reproduce):**
1. Fetch this gist's raw content as published (everything above this line is the report; this Witness
   section, once stamped, is part of the same published file — verify against the version fetched,
   which will match the PR's committed copy at `docs/dream-cycle/2026-09-21-brain-currency-report.md`).
2. `git checkout 6c0c8d4abb09577f655f9e8a61b2733d95a62f18` in `stuinfla/ruvnet-brain` (the session's
   starting commit for this run, before the candidate branch/commit).
3. Recompute `sha256sum` over the report file as it existed immediately before this Witness section
   was appended (the committed report file's own git history shows this exact pre-stamp revision).
4. Concatenate that hash with the session commit string above, hash once more with sha256.
5. Compare to the `Witness stamp` line above — a match proves this report was produced against this
   exact source commit and has not been altered since stamping.


## Next steps
1. Audit whether the same "period is never a boundary" assumption reaches any other free-text
   extraction in `kb/` (a grep-scoped follow-up, not attempted tonight — kept the candidate to one
   conceptual change).
2. Consider whether `versionIntent` should also treat a trailing `!`/`)`/closing-quote combination as
   cleanly as it now treats `.`; not reproduced as a live failure tonight, so not in scope.
3. If a corpus is ever materialized on a Dream Machine runner host, add an end-to-end
   `freshnessAdvisory` case exercising a real `SOURCE.json` + sentence-final-period query together, to
   catch a regression the unit-level fix alone would miss.
