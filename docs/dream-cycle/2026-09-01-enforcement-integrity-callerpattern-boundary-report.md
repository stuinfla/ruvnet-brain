# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-09-01** · SLOT=1→2 (rotated) · DEEP=`enforcement-integrity` · SCAN=`lesson-delivery`,`gate-teeth`

## TL;DR

`scripts/wired-check.mjs`'s `callerPattern()` — the predicate deciding whether a module has a real caller — matched a filename as an unbounded substring anywhere in a quoted string or shell invocation, with no boundary check on either side. An unrelated, longer filename that merely happens to END with the same characters as a shorter module's name registers as a phantom caller of it. Live in this repo, not hypothetical: `scripts/gate.sh` was reported "wired" today, hidden behind two phantom matches — the JS property-access expression `aggregate.sha` in `.github/workflows/protected-release.yml` and a `version-bump-gate.sh` path string in `.claude/settings.json` and `plugin/hooks/hook-contracts.json` — none of which ever reference `scripts/gate.sh` at all. `scripts/gate.sh` in fact has zero real callers anywhere in the repo (verified by direct grep): it is a genuine, always-standalone benchmark harness that has simply never had a STANDALONE entry, exactly the "built is not shipped; shipped is not wired" failure class this gate exists to catch (ADR-037/P7).

## What's new

This is the fourth shape of a defect class `wired-check.mjs`'s own history already documents fixing three times: "a string that names a module is not a call to it" (v1's bare-prose substring match; the 2026-07-23 comment/usage-example regrade; the 2026-07-27 package.json-definition-vs-invocation fix). This time the false positive comes from one REAL module's filename being a trailing substring of another REAL (or even non-filename — `aggregate.sha`) string, not a comment or definition.

- `gates.mjs` is a trailing substring of `corpus-aggregates.mjs`; `version.mjs` is a trailing substring of both `set-version.mjs` and `sync-version.mjs`; `gate.sh` is a trailing substring of `version-bump-gate.sh`, and — the most surprising instance — of the plain JS expression `aggregate.sha` (a property-access chain, not a filename at all).
- Reproduced live: `scripts/gates.mjs` was reported "wired" partly via two phantom callers (`scripts/corpus-reconcile.mjs`, and `wired-check.mjs` itself) whose only real reference is to `corpus-aggregates.mjs`. `scripts/version.mjs`'s caller list shrank from 14 to 6 after the fix — every removed entry was independently confirmed (by direct grep) to have zero genuine `version.mjs` reference, only a `set-version.mjs`/`sync-version.mjs` mention.
- The one live-consequential instance: `scripts/gate.sh` (a benchmark harness rebuilding the concepts/capability layer and running three `prove.mjs` question batteries) had ZERO genuine callers anywhere in the repo, but was masked as "wired" by the collision above. `node scripts/wired-check.mjs --check` flips from a false-green exit 0 (baseline) to a true-positive exit 1 (candidate, pre-classification) the moment the phantom callers are removed — proving the bug had a real, live effect on this repo's own release gate today, not just a latent risk.

## Hypothesis (frozen before implementation)

> Given `scripts/wired-check.mjs`'s `callerPattern(fileName)`, when a quoted string or shell invocation contains `fileName` as a substring of a longer, unrelated token (a different real filename, or an arbitrary code expression) rather than as a delimiter-bounded reference, then the module should NOT be counted as called from that occurrence — subject to: every genuine reference (`./x.mjs`, `scripts/x.mjs`, a bare `'x.mjs'`, or a reference immediately followed by ordinary prose punctuation such as a sentence-ending period) must still match unchanged.

Frozen before implementation; unchanged since.

## Evaluation Receipt

- **TEETH**: new test `tests/unit/wired-check.test.mjs` → "a quoted reference to a DIFFERENT, longer filename does not wire a module whose name is its trailing substring" — proven RED on pre-candidate code (`git stash` isolated the source-only revert): `AssertionError: expected 'wired' to be 'unwired'`, 42/43 other tests in the file unaffected. GREEN post-candidate: 43/43.
- A second new test proves a real path-prefixed reference to the SAME short tail (`import { g } from './gates.mjs'`) still wires correctly — the fix is precision, not a blanket rejection.
- **Self-correction caught mid-session**: the first cut of the boundary excluded `.` from BOTH sides, which flipped a genuine, unrelated module (`scripts/corpus-seed-publish.mjs`, referenced in `.github/workflows/corpus-seed.yml` as `"...call scripts/corpus-seed-publish.mjs."` — note the sentence-ending period) to a false "unwired". Caught by re-running the FULL real-repo audit after the fix rather than trusting the isolated test pass, exactly the discipline PR #158/#181 name ("caught by re-reading the row after the change instead of trusting it"). Fixed by excluding `.` only from the trailing lookahead.
- `npm run test:unit`: 3727/3918 pass; 4 failed files/4 failed tests — byte-identical to baseline (`git stash` comparison), all the known pre-existing chmod/EACCES-under-root fixtures (`advocacy-ignored`, `advocacy-outcomes`, `hook-shim-fallback-once`, `user-settings`). A 5th file (`convergence-manifest.test.mjs`) failed only until `data/convergence-manifest.json` was regenerated via `npm run convergence:write` (required because `wired-check.mjs` itself is a tracked source surface the manifest hashes) — included in this candidate.
- `npm run test:integration`: 5 failed files/9 failed tests — byte-identical baseline vs candidate (`git stash` comparison), all pre-existing environmental blockers (missing `sqlite3`/`@xenova/transformers`, chmod-under-root, a real-browser-timing test).
- `npm run claims:verify`: 3 PASS/4 SKIP, identical to every prior night.
- `npm run qa:pr`: overall FAIL only on the `docs` lane — 102 pre-existing `stamp-lags-doc` violations, byte-identical count baseline vs candidate (`git stash` comparison), unrelated to this change (a long-standing bulk-commit doc-currency backlog). Every other lane (`wiring` — the lane `wired-check.mjs` itself belongs to — `version`, `convergence`, `execution-policy`, `substitution`, `catalog`, `contract`, `mesh`, `plugin`) PASS.
- `npm run eval:gate`: BLOCKED — `no brain at /root/.cache/ruvnet-brain/kb` (this container never materializes a corpus, same as virtually every prior night). Unrelated to the candidate; finding does not touch retrieval.
- `node scripts/wired-check.mjs --check`: exit 0 on the finished candidate (the `gate.sh` STANDALONE classification restores the clean exit after the boundary fix correctly surfaces it).

## Darwin Results

Not run — a boundary/lookaround regex fix has no continuous parameter to evolve, same precedent as every prior night's non-numeric candidates (PR #155, #159, #182).

## Evidence

- OBSERVATION: `callerPattern()`'s quoted-string and invocation branches had no boundary requirement around the matched filename.
- MEASUREMENT: live repo audit shows `gates.mjs`/`version.mjs`/`npx-witness.sh` carrying phantom callers pre-fix, all independently confirmed via direct grep to have zero genuine reference; `gate.sh` flips `--check` from false-green to true-positive the moment the phantoms are removed.
- INFERENCE: the collision is not a corner case unique to this repo's naming — kebab-case filenames sharing tails, and property-access chains (`aggregate.sha`) incidentally containing a monitored filename, are both realistic recurring shapes as the module inventory grows.
- DECISION: bound `callerPattern` with a filename-character lookbehind/lookahead (dot excluded from the trailing side only, to avoid a sentence-punctuation false negative), and give `scripts/gate.sh` its first honest STANDALONE classification now that its true, previously-hidden state is visible.

## Reward-Hack Check

Independent adversarial critic (fresh agent, no shared context, given only the diff and repository) verdict: **CLEAR** on all five checks it was asked to run.

1. **Regex correctness**: reproduced the lookbehind/lookahead behavior live — the start-of-string case is vacuously satisfied, no escaping issues. Identified one real, non-blocking asymmetry: excluding `.` only from the trailing side means a string shaped like `"scripts/version.mjs.map"` would still phantom-match `version.mjs`. Grepped all 337 caller-shaped files in the repo for that exact shape: zero live hits today. Now documented as a known, deliberately-accepted residual limit directly in the source (see the updated JSDoc), not silently left.
2. **Test non-vacuity**: reverted ONLY `callerPattern` (kept the new STANDALONE entry and everything else exactly as diffed), confirmed exactly the new collision test fails red with the predicted wrong-direction assertion, while the unrelated module (`corpus-aggregates.mjs`) stays correctly `wired` even under the broken regex — proving the two assertions are independent, not tautological.
3. **Blast radius**: re-ran `--check` before/after with the STANDALONE list held constant — identical wired/manual/exempt/held/unwired totals both times (227 wired · 6 manual · 49 exempt · 4 held · 0 unwired; 63/1/0 for the hook audit). Independently cross-checked `scripts/gate.sh` against pre-push, `ci.yml`, `package.json`, and every workflow: genuinely never invoked programmatically, only documented in prose (README/CONTRIBUTING) — confirming the STANDALONE classification is accurate, not a rationalization.
4. **Security**: no ReDoS — the lookaround is fixed-width with no nested quantifiers, timed at ~1ms against a 200k-character adversarial string.
5. **Other**: no overclaiming found; every specific claim in the diff's commentary checked out against direct reproduction. Manifest regen independently confirmed current via `npm run convergence:check` → `ok:true`.

## Security Review

No new attack surface: the change adds fixed-width lookbehind/lookahead character-class assertions to an existing regex inside a purely local, static-analysis-only function (`callerPattern`), invoked only by `wired-check.mjs` on repo source it already reads via the pre-existing `fs.readFileSync` calls. No new I/O, dependency, network call, or credential. No ReDoS risk: the added assertions are single-position, non-nested, non-quantified character-class lookarounds — they cannot introduce catastrophic backtracking, and the surrounding `[^"'\`\n]*`/`[^\n]*` greedy segments were already present, unchanged, in the prior version. `callerPattern` is exported but has exactly two importers repo-wide (`wired-check.mjs` itself and its own test file) — blast radius is fully contained to this one CI/pre-push static-analysis tool; nothing in a production/runtime path is affected.

## Scan: lesson-delivery

Not the primary surface tonight (this finding is squarely gate-teeth); no new lesson-delivery gap surveyed beyond re-confirming (per STEP 2) that issues #183/#181/#158/#156 remain open, unmerged, and non-overlapping with tonight's finding.

## Scan: gate-teeth

This IS the primary finding — a fourth instance of "a string that names a module is not a call to it," this time as a real-vs-real filename collision rather than prose/comment/definition, with a demonstrated live consequence (`gate.sh`'s true unwired status was hidden) rather than only a synthetic one.

## Competitors

| Source | Pattern | Grade |
|---|---|---|
| ast-grep / semgrep structural matching | matches on parsed AST/CST nodes, immune by construction to substring collisions a regex-based scanner is vulnerable to | A (official docs, general knowledge) |
| ESLint `no-restricted-imports` / import-resolution rules | resolve import specifiers through the module resolver, not string containment | B (general knowledge, not re-fetched tonight) |
| This repo's own `isHome()` project-scope fix (PR #184, 2026-08-27) | the exact same "bound a suffix match to a real delimiter" principle, applied to project-name scoping instead of caller detection | A (this repo, accepted) |
| This repo's own three prior "a mention is not a caller" fixes (v1 prose; 2026-07-23 comment regrade; 2026-07-27 npm-script definition) | the same defect class, three earlier shapes | A (this repo, accepted, merged) |
| This repo's `hook-conformance-both-hosts.test.mjs` fix (PR #148) | replaced a vacuous check with a real fixture — same "test the real mechanism, not a proxy" principle | A (this repo, accepted, merged) |

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation recorded on every prior Dream Cycle night). Full report committed at `docs/dream-cycle/2026-09-01-enforcement-integrity-callerpattern-boundary-report.md` on the candidate branch.

## Witness

(computed below, see PR body)

## Recommendation

evaluated: **accepted**. Independent critic verdict CLEAR on all checks. Human review requested; `autoMerge:false` holds — this session never merges.
