# Brain-Currency SOTA Report — 2026-10-21

## TL;DR

This repo's own self-knowledge pipeline has a silent, 7-week-old compiler-drop bug: the owner's
2026-08-30 decision to make the nightly ledger "ledger-first" (`dream.config.json`'s
`findingPolicy.ledgerFirst: true`) never reached a single compiled nightly prompt, because
`dream-machine@0.1.1`'s `withDefaults()` drops the whole `findingPolicy` object — the exact defect
this repo already diagnosed and partially patched (for the sibling field `openIssueOnlyWhen`) via
`docs/dream-cycle/OPERATING-POLICY.md`, but never finished for `ledgerFirst`. Verified live tonight
by compiling the committed config and finding zero mention of ledger ordering anywhere in the
15KB output. Fixed with the same precedented mechanism (an `extraDisciplines` override entry),
verified red-before/green-after against the real `dream-machine@0.1.1` compiler, independent
critic verdict CLEAR.

Separately, and NOT fixed tonight (outside one night's bounded-repair authority, and already
tracked as issue #410): `docs/dream-cycle/LEDGER.md` on `main` has not had a new row since
**2026-08-31** — 51 days — not because the nightly routine stopped (it has fired every night,
confirmed via this account's own scheduled-task registry: trigger `trig_01JyA1ddkysQMLZk8VJMTs6H`,
enabled, cron `30 8 * * *`, last fired today), but because the ledger row ships inside each
candidate's draft PR, and the `dream/*` PR backlog has not merged one since `#215`
(2026-08-31). Tonight's own GitHub MCP check: **5 of 90 total `dream/*` PRs have ever merged**,
66 still open/draft. This matches issue #410's 2026-10-06 count almost exactly, so the backlog has
not meaningfully moved in two weeks.

## What's new

Nothing external. This is an internal self-consistency gap between a committed decision
(`dream.config.json`) and the compiled artifact actually governing nightly behavior — found by
treating the compiled prompt, not the config file, as ground truth for what tonight's session is
actually told to do (the same discipline `docs/dream-cycle/OPERATING-POLICY.md` already applied
to `openIssueOnlyWhen`, left half-finished).

## Competitors — self-consistency between declared config and compiled/executed policy

| System | Stance on verifying a declared config actually reaches the executed pipeline | Grade |
|---|---|---|
| OpenHands (Agent SDK) | 2026 SDK docs emphasize declarative agent config as the source of truth; no public documentation of a compiler step that silently drops config fields. | B (vendor docs, general framing only) |
| DSPy / GEPA | Optimizer config and the compiled program are the same artifact (no separate "compile, then maybe drop fields" step) — structurally avoids this failure mode rather than needing to detect it. | A (official repo, architecture inspection) |
| SWE-agent | No public documentation of a config-compilation step with silent field-dropping. | C (not deeply searched tonight) |
| Cursor background agents | No public documentation on config/execution consistency verification. | C (general framing only) |
| Sakana AI Scientist | No public documentation of this specific failure class. | C (not deeply searched tonight) |

This repo's own precedent (`docs/dream-cycle/OPERATING-POLICY.md`'s `openIssueOnlyWhen` fix, and
`tests/unit/dream-config.test.mjs`'s TEETH compiler test) is the real justification — the same
discipline applied to a second field it had not yet reached.

## The hypothesis (frozen before implementation)

> Given `dream.config.json`'s `findingPolicy.ledgerFirst: true` declaration, when compiled via
> `dream-machine@0.1.1`'s real `compile` command, the emitted nightly prompt contains NO
> instruction reflecting `ledgerFirst`'s plain-text intent (finalize the local ledger-row content
> before any GitHub side effect this run produces), because `withDefaults()` drops the whole
> `findingPolicy` object; adding a `LEDGER-FIRST OVERRIDE` entry to the separately-preserved
> `extraDisciplines` array — mirroring the already-shipped `ISSUE DISPOSITION OVERRIDE` precedent —
> should make that instruction survive compilation, verified by extending the existing TEETH
> compiler test, without touching `autoMerge`, any evaluator entrypoint, or the PR-review/ledger
> landing-on-main question (which stays the human integration owner's call per issue #410).

Unchanged since freeze.

## Candidate

`dream.config.json`: one new string in `extraDisciplines` (53-line diff total across 3 files:
`dream.config.json`, `tests/unit/dream-config.test.mjs`, `docs/adr/0068-dream-machine-nightly-evolution.md`'s
Currency log). No production code touched. No evaluator entrypoint touched.

## Baseline vs candidate (real evaluator: `npx -y dream-machine@0.1.1 compile`)

- Baseline (`main`, commit `5db36d6`): compiled prompt, 15029 bytes, zero matches for
  `LEDGER-FIRST OVERRIDE`/`ledgerFirst`.
- Candidate: compiled prompt, 15992 bytes, contains the new override text (verified by grep on the
  real compiler's own output, not inferred).

## Evaluation receipt

- `tests/unit/dream-config.test.mjs` (`DREAM_ENGINE_VERIFY=1 npx vitest run`): 6/6 pass on
  candidate. Reproduced TEETH directly: reverting ONLY `dream.config.json` to the baseline
  (keeping the new test assertions) turns the suite 1 failed/5 passed, failing exactly at the new
  `toContain('LEDGER-FIRST OVERRIDE')` assertion — confirmed independently by a separate critic
  agent, not just this session's own claim.
- `npm run test:integration` (420 tests, 55 files): 335 passed/22 failed/18 skipped/45 todo,
  9 failed files. Spot-checked the two representative failing files
  (`model-managed-checker-native.test.mjs`, `reader-deadlock-regression.test.mjs`) against baseline:
  byte-identical 4/4 failures, same assertions, same messages — pre-existing/environmental
  (native-sandbox and CE-model-cache dependencies this container doesn't have), not caused by
  tonight's config/docs/test-only diff. Both-hosts conformance gate specifically: 10/10 green.
- `npm run claims:verify`: 3 PASS/4 SKIP — matches the standing pre-existing pattern recorded in
  every prior night since 2026-08-28 (brain not installed on this container).
- `npm run eval:gate`: `EVALUATED=blocked` — `no brain at /root/.cache/ruvnet-brain/kb` (container
  never materializes a corpus; independently cross-checked via `restore-local-ingests.mjs` and
  `store-root.mjs`, both report `stores 0 dark 0`). `LLM_EVAL=blocked` too (no `OPENROUTER_API_KEY`
  in this environment).
- `npm run qa:pr`: did not complete within tonight's budget (large runner); not used as evidence
  either way, consistent with prior nights' handling of the same runner (e.g. 2026-08-26's row).

## Darwin

Not run. The candidate is a one-line config/text change with a deterministic pass/fail compiler
test; bounded Darwin (mutation search) has no meaningful search space here and would not change
the verdict.

## Evidence

- MEASUREMENT: baseline compiled-prompt byte count and grep result (15029 bytes, 0 matches).
- MEASUREMENT: candidate compiled-prompt byte count and grep result (15992 bytes, 1 match region).
- MEASUREMENT: `tests/unit/dream-config.test.mjs` red-on-baseline / green-on-candidate, reproduced
  twice (this session, then independently by the critic agent).
- OBSERVATION: `docs/dream-cycle/LEDGER.md` last touched on `main` 2026-08-31 (commit `f0e9abd`,
  confirmed via GitHub MCP `list_commits` with a `path` filter — not the local shallow clone, which
  only reaches back to 2026-10-13).
- OBSERVATION: exactly 5 `dream/*` PRs have ever merged (#143, #148, #150, #178, #215); 66 of 84
  currently-open PRs are `dream/*`-headed; oldest open `dream/*` PR dated 2026-09-08. Cross-checked
  against the concurrent 2026-10-21 PR #479's independently-stated "5 merged... 66 open" and issue
  #410's 2026-10-06 count — consistent across three independent sessions/dates.
- INFERENCE: the backlog, not a stopped routine, is why `LEDGER.md` reads as stale on `main` — the
  scheduled trigger itself is healthy (enabled, fired on schedule every night per this account's own
  trigger registry).
- DECISION: fix the compiler-drop gap (in authority, tiny, tested); do NOT unilaterally change the
  PR-review/ledger-landing policy (exceeds one night's authority; already tracked in #410 as a human
  integration-owner decision).

## Reward-Hack Check

Independent critic (fresh agent, not this candidate's author) verdict: **CLEAR**. Checked: override
text scope (correctly disclaims authority over PR-merge timing), test substance (reproduced red→green
independently, not cosmetic), no evaluator touched, defect reality (cross-checked `OPERATING-POLICY.md`'s
own account and grepped pre-diff config for any existing ledger-override text — none existed), security
(no prompt-injection shape, no authority expansion), blast radius (`extraDisciplines` has exactly two
readers: the compiler and this one test file). One cosmetic-only note: the critic couldn't independently
re-verify commit `9e0498e`'s attribution locally due to this container's shallow clone — already resolved
in this session via the GitHub MCP `list_commits` API (full commit body quoted in the ADR's Currency log),
not the local shallow git history.

## Security Review

Config/docs/test-only change. No credential handling, no filesystem/network scope change, no new
tool authority, no prompt-injection shape (the new string is declarative and explicitly scopes
itself to write-ordering within a single run, never claiming authority over merge timing). `autoMerge`
remains `false`, test-enforced (`tests/unit/dream-config.test.mjs`'s existing `TEETH: autoMerge is
FALSE` assertion, unmodified and still passing).

## Scan Findings

**dark-stores**: `kb/store-root.mjs`'s `storeRoot()` reports `stores 0 dark 0` on this container
(never materialized here — expected for an ephemeral nightly checkout, not evidence of a real dark-store
problem; `restore-local-ingests.mjs` independently confirms 125 recorded ingests never materialized on
this host, exit code 2, with its own disclaimer that this is NOT evidence of a wipe on a fresh
container).

**corpus-freshness**: `scripts/brain-score.mjs` reports all 4 `quality` dimensions STALE
(`grounded`/`routed`/`abstained` at 41.5 days against a 14-day budget; `panelStrict` undated) and both
`coverage` dimensions UNMEASURED (store root never materialized here). The script itself is correctly
designed (refuses to average quality and coverage, flags staleness rather than silently using a stale
reading) — the staleness is a real, accurate reading of this container's/this period's state, not a
bug in the measurement tool. No composite in either `kind` tonight, as designed.

## Gist

LOCAL — this session's auto-mode permission classifier denied `gh gist create --public` tonight
(`Reason: [Public Data-Sharing Upload]`), and then transiently denied unrelated read-only `git
log`/`wc -l` commands with the same reason tag before allowing equivalent commands again seconds
later. This is additional, independently-observed evidence for the open, already-filed issue #298
("Dream Cycle ... compile blocked by this session's sandbox" — recurring since 2026-09-19, most
recently again today via the concurrent PR #479's "[Code from External]" denial on the compile step
itself). Tonight's denial hit a different stage (gist publish + transient Bash, not compile) with a
different reason string (`[Public Data-Sharing Upload]` vs `[Code from External]`/`[Untrusted Code
Integration]`), reinforcing #298's own observation that the classifier's behavior is not stable
across nights or even within one run. Recorded as a comment on #298, not a new issue
(`skipIf: duplicate-open-issue`).

## Witness

```
SESSION_COMMIT = 5db36d691c32f778065eccfb9aedb34ca70336fb
REPORT_HASH    = def3a7d31b27e56e88baf29d747ca7260ec44b5731f4adfee5fe12e7021db3aa
WITNESS        = 1d7602d675a73c4c8c95701c4936a5def4174b5d6805490020240d5dfd4cfae3
```

(`REPORT_HASH` is the sha256 of this file as it stood immediately before this Witness section was
rewritten with the real values — the same documented convention this repo's 2026-08-29
memory-durability report used, since the hash cannot include its own value.)

Verifier procedure: (1) check out `stuinfla/ruvnet-brain` at `5db36d691c32f778065eccfb9aedb34ca70336fb`;
(2) take this gist file as published; (3) `sha256sum` it, compare to `REPORT_HASH` in the ledger row;
(4) concatenate `REPORT_HASH` + the session commit, `sha256sum` again, compare to `WITNESS`;
(5) independently reproduce the TEETH proof: `git stash` just `dream.config.json` (keep the test file),
run `DREAM_ENGINE_VERIFY=1 npx vitest run tests/unit/dream-config.test.mjs`, confirm it fails at the
`LEDGER-FIRST OVERRIDE` assertion; `git stash pop`, re-run, confirm 6/6 green.

## Three concrete next steps

1. **Human decision needed** (issue #410, reinforced by tonight's independent corroboration): decide
   whether to run a backlog-reconciliation pass on the 66 open `dream/*` PRs (many may already be
   superseded by direct-to-main commits, per #410's own worked examples closing #258/#260/#264), and/or
   whether future nights should default to a reconciliation-first posture before opening a new PR.
2. Re-run `npm run qa:pr` to completion (it did not finish within tonight's budget) to get a clean
   baseline-vs-candidate comparison on that lane specifically, even though this candidate shouldn't
   touch it.
3. If issue #298's sandbox-classifier denials keep recurring on the compile step itself (not just
   tonight's gist/Bash-stage variant), revisit its 2026-09-19 suggested structural fix — vendoring
   `dream-machine@0.1.1` into `devDependencies` so `npm ci` supplies it instead of a runtime `npx -y`
   fetch — since per #298's 2026-09-28 comment that fix itself was also denied by the same classifier,
   it needs a human acting outside this sandbox.
