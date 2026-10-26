# Memory-Durability SOTA Report — 2026-10-19

## TL;DR

`scripts/agentdb-fleet-doctor.mjs` audits a fleet of per-project AgentDB memory stores and claims
to "VERIFY: a real round-trip through the ruflo CLI" for each one. The round-trip check it shipped
with wrote a timestamped canary key/value through `ruflo memory store`, then verified it via
`ruflo memory search -q 'fleet-doctor round-trip canary' --limit 3` and tested whether the search
output contained the GENERIC substring `fleet-doctor-cana` or `round-trip canary` — never this
run's own unique key or value. Every canary this project has ever written shares that substring, so
a STALE canary left over from a prior run, still ranked by `memory search`, makes the check report
`roundtrip: true` even when the CURRENT run's store call silently failed to land — the exact
"claimed success is not evidence of a write" incident class ADR-063 documents (2026-08-13: `ruflo
memory store` printed `[OK] Data stored successfully` for three days while the write itself left
rowcount 0), already fixed this same way in three sibling scripts (`record-lesson.mjs`,
`distill-project.mjs`, `health-repair.mjs`'s fleet receipt) but never carried to this fourth,
sibling verifier — despite this repo's own `ground-ruvnet.sh` explicitly naming the discipline for
every write in the codebase: "never infer a broken write from... semantic-search misses...
unique-key store -> exact-key retrieve and read the returned VALUE."

Fix: the VERIFY step now calls `ruflo memory retrieve -k <canaryKey> -n <name> --value-only`
and requires an exact string match against the value just written — the identical discipline
already used everywhere else in this codebase.

## What's new

Nothing external — an internal control-flow gap in this repo's own fleet-health tool, found by
checking every `ruflo memory store` call site in the repo against the one discipline this codebase
has converged on four separate times (`record-lesson.mjs`, `distill-project.mjs`,
`health-repair.mjs`, now `agentdb-fleet-doctor.mjs`) for proving a managed-store write actually
landed. The gap is structurally identical to the 2026-08-29 Dream Cycle night's finding
(`distill-project.mjs`'s stale-snapshot misattribution) and the 2026-08-26 night's finding
(`store-root.mjs`'s `ENOTDIR`/`EACCES` false-negative) — the same shape recurring at a fourth call
site this repo had not yet reached with the discipline.

## The hypothesis (frozen before implementation)

> Given `scripts/agentdb-fleet-doctor.mjs`'s per-project round-trip VERIFY step, when the current
> run's `ruflo memory store` canary write silently fails to land (a fake CLI reproducing the
> 2026-08-13 incident shape: store claims success, the value is never actually written) while a
> semantically similar STALE canary from a PRIOR run is still present and ranks in `ruflo memory
> search`'s top 3 results, then the pre-candidate substring-match check against `memory search`
> output should wrongly report `roundtrip: PASS`; changing the VERIFY step to an exact-key `ruflo
> memory retrieve` with a strict value comparison should make it correctly report `roundtrip: FAIL`
> in that scenario — subject to: a genuinely successful round trip is still reported as `PASS`, and
> the FIX-1 (checkpoint seeding) and FIX-2 (distill) steps elsewhere in the same function are
> unchanged in behavior.

Unchanged since freeze.

## Competitors — memory/state write-verification stance (as documented; none used to justify the fix)

| System | Stance on verifying a "success" claim from a subprocess/backend before trusting it | Grade |
|---|---|---|
| OpenHands (Agent SDK) | Names durable state management as a foundation requirement; no documented backup/write-freshness check surfaced. | A (arXiv 2511.03690, general framing only) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts; "which write is current" is explicit by version, not inferred from a search ranking. | A (official repo) |
| SWE-agent | No public write-verification mechanics surfaced tonight. | C (not deeply searched) |
| Cursor background agents | No public documentation on write-verification mechanics surfaced tonight. | C (general framing only) |
| Sakana AI Scientist | No public documentation of an explicit freshness/round-trip check on its own state artifacts. | C (not deeply searched) |

This repo's own precedent — `record-lesson.mjs` (PR #167, closed unmerged but the fix is present
on `main` today), `distill-project.mjs` (2026-08-29 report), `health-repair.mjs`'s fleet receipt
(PR #192) — is the actual justification: exact-key readback, never search ranking or wording, is
the only accepted proof of a managed-store write in this codebase.

## Five candidates considered

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod value | Reviewability | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `agentdb-fleet-doctor.mjs` canary verified by `memory search` substring, not exact-key `retrieve` (chosen) | 5 | 3 | 5 | 5 | 4 | 5 | Fourth instance of an already-converged-on repo discipline; narrow, ~12-line diff; no existing test covered this path |
| 2 | `record-lesson.mjs` deterministic round-trip key (nonce gap, PR #167's own flagged fast-follow) | 3 | 1 | 3 | 3 | 2 | 3 | Checked current `main`: already fixed — `RECORDING: ${randomUUID()}` binds the read-back to this write. Resolved, not reopened. |
| 3 | `distill-project.mjs` stale-snapshot misattribution (2026-08-29 report's own candidate) | 2 | 1 | 2 | 2 | 1 | 2 | Checked current `main`: already fixed — `newestSnapshot()` takes `sinceMs`/`MTIME_GRACE_MS`. Resolved, not reopened. |
| 4 | `health-repair.mjs` fleet `writeReceipt()` swallowing its own write failure (2026-08-29 report's own deferred candidate #3) | 2 | 1 | 2 | 2 | 1 | 2 | Checked current `main`: already fixed (PR #192, cited in this file's own comment) — `if (!writeReceipt())` now fails closed. Resolved, not reopened. |
| 5 | `learning-replay-fixture.mjs` `retrieveExact()` | 1 | 1 | 2 | 2 | 1 | 2 | Read in full (again, per 2026-08-29 report precedent): already correct, exact-key comparison. No defect. |

## Evaluation

Not a retrieval-quality candidate. `npm run eval:gate`: **EVALUATED=blocked** — `no brain at
/root/.cache/ruvnet-brain/kb` (store root never materialized, `stores 0 dark 0`), the identical
condition every prior Dream Cycle night has recorded since 2026-08-19. `LLM_EVAL`: not blocked
(`OPENROUTER_API_KEY` present) but no model-graded stage applies to a deterministic CLI-output
comparison.

**TEETH, proven to fail first.** New test `tests/unit/agentdb-fleet-doctor-roundtrip.test.mjs`,
two cases. Against the CANDIDATE (fixed) code: 2/2 pass — a silently-failed write (with a stale
canary present) reports `FAIL`/`NEEDS ATTENTION`; a genuine round trip reports `PASS`/`1/1 fully
verified`. Reverted only `scripts/agentdb-fleet-doctor.mjs` via `git stash` (kept the new test) and
re-ran: the TEETH case goes **red** exactly as predicted — pre-candidate code reports
`PASS`/`1/1 fully verified` for the silently-failed write (the false positive the hypothesis
named). Restored the fix via `git stash pop`: 2/2 green again.

**Regression analysis.**
- `npm run claims:verify`: 3 PASS / 4 SKIP — identical class to every prior Dream Cycle night (all
  skips are environmental: brain not installed on this container).
- Blast radius: `grep -rln agentdb-fleet-doctor` repo-wide — the script itself, its two test files,
  and `scripts/wired-check.mjs` (a descriptive classification string only — `['agentdb-fleet-doctor',
  'diagnostic CLI run by hand when a fleet looks wrong']` — not an import). No file imports this
  script's internals; it is a CLI entrypoint with no exports, same shape as `record-lesson.mjs`
  before its own fix.
- `npm run test:integration` and the full `npx vitest run tests/unit` (hundreds of files): run to
  completion; see PR body for the exact baseline-vs-candidate counts (both captured before this PR
  was opened).
- Independent critic (fresh general-purpose agent, not this candidate's author): see PR body /
  Reward-Hack Check section for its verdict.

## Security Review

No new attack surface: the diff only changes which `ruflo` subcommand (`retrieve` vs `search`) the
script calls with arguments it already constructs, and how it compares the CLI's own stdout — no
new external input, no new credential, no new network call, no new dependency, no path traversal,
no new trust boundary. The script remains a human-run diagnostic CLI (`wired-check.mjs`'s own
classification, unchanged), never invoked by the model.

## Witness

```
SESSION_COMMIT = 37f1f5a2f3e8ad53df27e4d903bd951690c087c8
REPORT_HASH    = 28da81717fc1d3a00785e4039d8cf06c41ed6837fd555ce058f2055ffa5dd2ff
WITNESS        = 4bdbafe8b05244953faeb8c965ad9f3941e918dd3426b307676ef8cb1b9e8976
```

`REPORT_HASH` is the sha256 of this file as it stood immediately before this Witness section was
filled in (the placeholder-Witness version, preserved in this file's git history as the first
commit that adds it).

5-step verifier: (1) `git log --follow -p -- docs/dream-cycle/evidence/2026-10-19-memory-durability.md`
and take the version of this file at its first commit (the placeholder-Witness version); (2)
`sha256sum` that version — compare to `REPORT_HASH`; (3) `git show 37f1f5a:.` is `main`'s HEAD at
session start — confirm via `git log`; (4) concatenate `REPORT_HASH` + `SESSION_COMMIT` and
`sha256sum` again — compare to `WITNESS`; (5) independently reproduce the TEETH proof: `git stash
push -u -- scripts/agentdb-fleet-doctor.mjs && npx vitest run tests/unit/agentdb-fleet-doctor-roundtrip.test.mjs`
(the TEETH case fails — pre-candidate code reports `PASS`/`1/1 fully verified` for a silently-failed
write), `git stash pop && npx vitest run tests/unit/agentdb-fleet-doctor-roundtrip.test.mjs` (2/2 pass).

## Next steps

1. `agentdb-fleet-doctor.mjs` still hardcodes its `ruflo` binary path
   (`path.join(os.homedir(), '.npm-global/bin/ruflo')`) instead of the shared `resolveRuflo()`
   (ADR-021 / issues #99, #105) every sibling script now uses — a real gap, but a second conceptual
   change, deferred tonight to keep this candidate to one.
2. The round-trip check still only proves ONE canary write landed per project per run; it does not
   detect partial/intermittent write loss across repeated invocations. Out of scope tonight.
3. This repo's dream-cycle PR backlog is large and growing (see PR body for tonight's count) — a
   standing, repeatedly-flagged review-capacity issue independent of tonight's candidate.
