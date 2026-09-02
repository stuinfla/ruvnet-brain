# Enforcement-Integrity SOTA Report — 2026

**Dream Cycle 2026-09-02** · SLOT=2 · DEEP=`enforcement-integrity` · SCAN=`lesson-delivery`,`gate-teeth`

## TL;DR

`plugin/scripts/version-bump-gate.sh` — the PreToolUse gate whose entire purpose is "every push
carries a version increment" — reads the hook payload with its own inline bash regex helper,
`field() { local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""; ...; }`. `[^"]*` cannot cross a
`"`, and a JSON-escaped `\"` inside a value is still a literal `"` byte in the raw payload text —
so any `command` string containing a quote got silently TRUNCATED there. `command` is the one field
this gate reads that routinely carries quotes (`git commit -m "…"`, `echo "…"`), so a completely
ordinary compound command — `git commit -m "wip" && git push origin main` — truncated `CMD` at the
escaped quote before "git push" ever appeared, and the later `[[ $CMD == *"git push"* ]]` substring
check silently missed the push. The gate opened a push it exists to block, with no error, no
warning, no signal to anyone. This is not a new defect class in this repo: `hook-input.mjs`'s own
header names it explicitly ("issue #13 fixed this in verify-interface.sh, but design-wall.sh —
written AFTER — reintroduced the identical bug") and `design-wall.sh` migrated to the shared,
tested parser to close it there. `version-bump-gate.sh` kept its own inline copy — deliberately,
per its header ("bash builtins + git only", the same dependency-free stance as `protect-brain-state.sh`)
— so the fix stays in-pattern rather than adopting the node-based shared parser: the capture group
now walks `(\\.[^"\\]*)*`, a standard escape-aware ERE string pattern, so an embedded `\"` is
consumed as part of the value instead of ending the match early.

## What's new

This is the fourth documented instance of "a bash regex cannot parse JSON string escaping" in this
repo — issue #13 (original, `verify-interface.sh`), the 07-27 reintroduction in `design-wall.sh`
(fixed by migrating to `hook-input.mjs`), and now a third sibling, `version-bump-gate.sh`, found
still carrying the same inline pattern. Unlike `design-wall.sh`, this file cannot simply adopt
`hook-input.mjs` — its own header states a deliberate no-node-dependency contract shared with
`protect-brain-state.sh` ("a wall that can fail-open because a tool went missing is not a wall").
The fix therefore stays a minimal, in-pattern bash-only regex correction rather than a parser
migration — the smallest change that closes the hole without abandoning the file's own stated
design constraint.

Three sibling files still carry the identical unfixed `field()` — `plugin/scripts/protect-brain-state.sh`
(matches `file_path`, rarely quote-bearing), `plugin/scripts/route-dispatch.sh` (matches
`tool_name`/`subagent_type`/`model`/`description`, structured API fields, not free text, and its own
header explicitly reasons about staying dependency-free), and `plugin/scripts/ground-before-write.sh`
(matches only `tool_name` and `file_path`; its own header already carries a reasoned exception —
"the #13 quote-truncation that justified hook-input.mjs for design-wall does NOT bite here... a
truncated path merely fails the extension check → exit 0, harmless" — independently confirmed
correct by re-reading its call sites, not merely trusting the comment). Left open rather than folded
into this PR — `command` is the only field among all of these genuinely and routinely quote-bearing
in normal use with a substring-containment check, the exact shape that makes truncation dangerous;
bundling four files under one PR would widen a bounded fix into a sweep. Disclosed here, not
silently left.

## Hypothesis (frozen before implementation)

> Given `plugin/scripts/version-bump-gate.sh`'s `field(fieldName)`, when the JSON payload's
> `command` value contains an escaped double quote (`\"`) anywhere before the substring `git push`,
> then `field(command)` should still return the value up to and including that substring, so the
> gate's `*"git push"*` check still fires — subject to: every existing passing case (no quotes, a
> push with no embedded quote, a non-push command, opt-out, garbage stdin) must still behave
> identically.

Frozen before implementation; unchanged since.

## Evaluation Receipt

- **TEETH**: new test `tests/unit/version-bump-gate.test.mjs` → "BLOCKS a git push even when the
  command string has an embedded quote before it" — proven RED on pre-candidate code (`git stash`
  isolated the source-only revert): `expected +0 to be 2`. GREEN post-candidate: 6/6 in the file.
- `npm run test:unit`: 3724/3918 pass (one new passing test). 5 failed files/6 failed tests —
  byte-identical to baseline via `git stash` isolation (`advocacy-ignored`, `advocacy-outcomes`,
  `hook-shim-fallback-once`, `session-snapshot-health`, `user-settings` — all pre-existing
  chmod/EACCES-under-root container fixtures, none touching the changed files). A 6th file,
  `convergence-manifest.test.mjs`, failed only until `data/convergence-manifest.json` was
  regenerated via `npm run convergence:write` (required because `version-bump-gate.sh` is a
  tracked source surface the manifest hashes) — included in this candidate.
- `npm run test:integration`: 5 failed files/9 failed tests — byte-identical count and shape to
  every recent night's documented baseline (missing `sqlite3`/`@xenova/transformers`, a real-browser
  timing test, chmod-under-root permission fixtures); none reference `version-bump-gate.sh`.
- `npm run claims:verify`: 3 PASS/4 SKIP, identical to every prior night.
- `npm run qa:pr`: overall FAIL only on the `docs` lane — 99 pre-existing `stamp-lags-doc`
  violations, byte-identical count baseline vs candidate (confirmed via direct `doc-currency.mjs
  --check` diff, not just the runner's summary). Every other lane (`version`, `convergence`,
  `execution-policy`, `wiring`, `substitution`, `catalog`, `contract`, `mesh`, `plugin`) PASS.
  `version-bump-gate.sh` is not listed in any ADR's `governs:` frontmatter (grepped all matches —
  every hit is a prose mention, e.g. ADR-034), so no currency-log update is required.
- `npm run eval:gate`: BLOCKED — `no brain at /root/.cache/ruvnet-brain/kb` (this container never
  materializes a corpus, same as virtually every prior night). Unrelated to the candidate; the
  finding does not touch retrieval. `LLM_EVAL=blocked` too — no `OPENROUTER_API_KEY`/
  `ANTHROPIC_API_KEY` in this environment.
- `node scripts/wired-check.mjs --check`: exit 0, unaffected.
- **ReDoS check**: fed the live script a 200,000-character adversarial payload (unterminated
  backslash run, and separately 50,000 repeated `\"a` escape pairs) with a real opted-in
  `model-router/profile.json`; both completed in well under half a second — no catastrophic
  backtracking. The new capture group `([^"\\]*(\\.[^"\\]*)*)` is a standard linear escape-aware ERE
  string pattern, not a nested-quantifier shape.

## Darwin Results

Not run — a regex correctness fix has no continuous parameter to evolve, same precedent as every
prior night's non-numeric candidates (PR #155, #159, #182, #229).

## Evidence

- OBSERVATION: `field()`'s capture group `([^"]*)` cannot cross a literal `"` byte, including one
  produced by a JSON `\"` escape.
- MEASUREMENT: live reproduction — `runGate(work, 'git commit -m "wip" && git push origin main')`
  against a repo with outgoing, unbumped commits returns `status: 0` (allowed) pre-fix, `status: 2`
  (blocked, "NO version increment") post-fix; RED-then-GREEN confirmed via `git stash` source-only
  isolation, not merely the candidate's own claim.
- INFERENCE: `command` is the only field this file's `field()` parses that routinely carries
  quoted sub-strings in ordinary use (`-m "…"`, `echo "…"`) — the exact shape that triggers the
  truncation — making this a live, not merely theoretical, gap in a gate whose sole job is
  push-time enforcement.
- DECISION: replace the capture group with an escape-aware ERE pattern, staying within the file's
  own stated "bash builtins + git only" dependency constraint rather than migrating to the shared
  `hook-input.mjs` parser `design-wall.sh` uses.
- DISCLOSED, NOT FIXED: `protect-brain-state.sh` and `route-dispatch.sh` carry the identical
  unfixed `field()`, assessed as lower live risk (structured/rarely-quoted fields) and left out of
  this bounded PR.

## Reward-Hack Check

Independent adversarial critic (fresh agent, no shared context, given only the diff and repository,
instructed to reproduce every claim itself rather than trust the diff's commentary) verdict:
**CLEAR** on all six checks it ran.

1. Repro RED→GREEN: independently reproduced via the same `git stash` isolation, byte-for-byte the
   predicted `expected 0 to be 2`.
2. Non-vacuity: extracted `field()`'s live definition and ran it directly against the real JSON
   payload — confirmed `BASH_REMATCH[1]` captures the full command through the escaped segment. Its
   own first hand-typed reproduction attempt (using one backslash instead of the file's actual two)
   silently produced an empty match — cited as evidence of how easily this class reintroduces itself.
3. ReDoS: fed the live script a 400KB pure-backslash payload and a 250KB payload of `\"` pairs,
   both under 50ms, confirming the pattern is structurally linear (disjoint-class alternation, no
   nested ambiguous quantifiers).
4. Blast radius: `field()` is not shared — each file defines its own copy — so the fix cannot alter
   behavior anywhere else; `tool_name` extraction is unaffected since it never contains quotes.
5. Sibling files: independently traced `protect-brain-state.sh` and `route-dispatch.sh`'s actual
   call sites and confirmed the lower-risk assessment (exact-match/presence checks, not
   substring-containment on free text) — but flagged that a third sibling, `ground-before-write.sh`,
   carries the identical unfixed `field()` and wasn't mentioned in the original draft of this
   report. Added above (What's new) after independently confirming its own pre-existing header
   comment's exception ("a truncated path merely fails the extension check → exit 0, harmless") is
   accurate.
6. Overclaiming: none found — the added comments are scoped strictly to this file and correctly
   cite precedent.

## Security Review

No new attack surface: the change replaces one ERE capture group with another inside an existing,
purely local bash function, invoked only by this one PreToolUse hook script on a bounded (65536-byte
capped), already-read stdin payload. No new I/O, dependency, network call, subprocess, or
credential — the file's own "bash builtins + git only" contract is preserved, not weakened. Fixes,
rather than introduces, a fail-open hole: before this change, an ordinary quoted `command` could
cause the gate to silently ALLOW a push it should have blocked; after, the gate's fail-open
posture is unchanged for genuinely unparseable input, but a parseable command is no longer
mis-parsed into a false allow. Stress-tested against adversarial backslash/quote-heavy input for
ReDoS (see Evaluation Receipt) — linear time, no blowup. `field()` has no callers outside this one
file (confirmed by grep) — blast radius is fully contained to `version-bump-gate.sh`.

## Scan: lesson-delivery

Not the primary surface tonight (this finding is squarely gate-teeth). Re-confirmed per STEP 2 that
the lesson-delivery surface's own recent instances (`lesson-gate.mjs` project-scope suffix match,
PR #184; `lesson-hooks.sh` ship-trigger whitespace, PR #182) remain open, unmerged, and
non-overlapping with tonight's finding — no new lesson-delivery gap surveyed beyond that
reconciliation.

## Scan: gate-teeth

This IS the primary finding — a third sibling instance of "a bash regex cannot parse JSON string
escaping," this time in the version-bump push gate rather than a comment/prose/definition-mention
false-positive class, with a demonstrated live consequence (an ordinary compound push command
bypasses the gate) rather than only a synthetic one.

## Competitors

| Source | Pattern | Grade |
|---|---|---|
| This repo's own `hook-input.mjs` (issue #13 fix, 2026-07-18/27) | replaced ad hoc bash regexes with one real JSON parser, shared by every gate that can afford a node dependency | A (this repo, accepted, merged) |
| This repo's own `design-wall.sh` rewrite (2026-07-27) | migrated off the identical broken `field()` this fix targets, in a sibling file | A (this repo, accepted, merged) |
| OWASP input-validation guidance on ad hoc parsers for structured formats | "do not hand-roll a parser for a language with a grammar (JSON, YAML, shell) — use a real parser" | A (established, general practice) |
| PR #229 (this repo, 2026-09-01) — `wired-check.mjs` `callerPattern()` boundary fix | the same enforcement-integrity night's prior instance of a regex silently accepting more than it should | A (this repo, this surface, unmerged draft) |
| PR #184 (this repo, 2026-08-27) — `lesson-gate.mjs` `isHome()` suffix-boundary fix | the same enforcement-integrity surface's precedent for "bound a match to a real delimiter" | A (this repo, this surface, unmerged draft) |

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation recorded on
every prior Dream Cycle night, e.g. the 2026-08-31 and 2026-09-01 ledger rows). Full report
committed at `docs/dream-cycle/2026-09-02-enforcement-integrity-version-bump-quote-escape-report.md`
on the candidate branch.

## Witness

(computed below, see PR body — `WITNESS = sha256(sha256(this file) + SESSION_COMMIT)`)

## Recommendation

evaluated: **accepted**, pending independent critic verdict recorded in the PR. Human review
requested; `autoMerge: false` holds — this session never merges.
