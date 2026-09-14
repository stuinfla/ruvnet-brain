# Memory-Durability SOTA Report — 2026-09-14

## Rotation

```
DATE   = 2026-09-14
DAYINT = 20260914
SLOT   = 4  (20260914 % 5)
DEEP   = memory-durability
SCAN   = managed-boundary, round-trip-proof
BONUS  = none (20260914 % 25 = 14, % 75 = 39 — neither hits)
SESSION_COMMIT = dd435b6bd9132716db23ac4c40d3e04d9f25b95e
```

`OPENROUTER_API_KEY` present tonight, but irrelevant here: no stage in this candidate needs a model
call (a deterministic process/filesystem verification guard, same class as every prior
memory-durability night).

## A note on tonight's git history: CONCURRENT NIGHT

A separate firing of this same routine landed first on the same branch name
(`dream/2026-09-14-memory-durability`, commit `d25b55f`, session
`session_014PcvCwyqRQf1qCBRvaNCiq`) — this session's push was rejected
(non-fast-forward) when it discovered that. That session's row is
**reconciliation-only** (INCONCLUSIVE): it rebased #275 onto current `main`
(`f0fbc61`→`9af1d14`, the same post-rebase commit this session had already
independently fetched and tested) and recommended it over #276, but opened no
new candidate. This session's work is independent and non-overlapping — a
different file (`agentdb-fleet-doctor.mjs`, not touched by that row) — so,
per this repo's own established precedent for concurrent nights (see the
2026-08-20/08-28/08-31 ledger rows), both rows are kept rather than one
overwriting the other. This session's branch was renamed to
`dream/2026-09-14-memory-durability-agentdb-fleet-doctor` and this report to
match, to avoid colliding with the other session's identically-named branch
and report file.

## TL;DR

Per this repo's ISSUE DISPOSITION OVERRIDE, reconciliation came first. The one open issue on
tonight's DEEP surface — **#274** — already has an open, CI-green candidate fix PR (**#275**,
based exactly on tonight's `main` tip) plus a second, overlapping candidate (**#276**) for the same
finding. Rather than open a third PR for an already-covered finding, tonight's session independently
re-verified #275 against current `main` (reproduced its TEETH claim fresh, confirmed CI, confirmed
blast radius) and posted evidence to both PRs, including flagging #276 as a duplicate the reviewer
should choose between rather than merge both. Full detail: comments on #275 and #276.

That freed the night for a genuinely new finding on the same surface: `scripts/agentdb-fleet-doctor.mjs`
— a fleet-health diagnostic CLI, zero prior test coverage — has its OWN, separate instance of the
exact ADR-063 / 2026-08-13 incident shape, in a file #274/#275/#276 never touched. Its checkpoint-
seeding step (`FIX 1`) derived `row.seeded` solely from `ruflo memory store`'s exit code plus a regex
match on stdout wording (`/stored successfully/i`) — never verifying the specific key it wrote
actually persisted. The file's own separate FIX-2 step round-trips a *different*, freshly-generated
canary key later in the same run; that canary proves the namespace is writable in general, and cannot
tell "this checkpoint write persisted" apart from "the namespace happens to still accept writes while
this one silently dropped."

## Reconciliation (STEP 1 / ISSUE DISPOSITION OVERRIDE)

- **#274** (open issue, this DEEP surface): has `closed_by_pull_requests` naming **#275** (open,
  draft, CI green, base = tonight's exact `main` tip `dd435b6`). Per `findingPolicy.skipIf:
  ["existing-fix-pr", ...]`, no new issue/PR opened for this finding. Independently re-verified
  instead (see below) — comment posted to #275.
- **#276** (open, draft, same night as #275, overlapping candidate for the same #274 finding, on an
  older base `5433bd27`): flagged as a duplicate via comment, not closed — its implementation choice
  (permanently appending a `nonce` into every future stored lesson's VALUE) differs materially from
  #275's (a disposable probe key, real content untouched), so this is a reviewer decision, not
  something this session resolves unilaterally.
- Independent re-verification of #275, fresh session: `npx vitest run tests/unit/record-lesson.test.mjs`
  on the candidate — 5/5 pass. `git checkout main -- scripts/record-lesson.mjs` (isolating the
  production fix, keeping the candidate's tests) — 2/5 fail, `expected +0 to be 1` on the aliasing
  case, matching #275's own "Revision 2" TEETH claim exactly. Restored via `git checkout HEAD --
  scripts/record-lesson.mjs` — 5/5 pass again. Blast radius re-grepped: unchanged, one reference
  outside itself (`wired-check.mjs`, confirms human-run-only). CI on #275 (`canonical-qa`,
  `qualify-development`, `integration`) green as of tonight.

## Deep Dive — memory-durability, second instance in `agentdb-fleet-doctor.mjs`

`scripts/agentdb-fleet-doctor.mjs` audits a fleet of project AgentDB stores by hand (confirmed via
`npm run wired:check`: classified `○`, "diagnostic CLI run by hand when a fleet looks wrong" — never
invoked by a hook or the model). Its `FIX 1` block seeds a canonical `project-state-current-<ts>`
checkpoint from git history when a project has none, then reports whether it succeeded:

```js
const r = ruflo(proj, ['memory', 'store', '-k', `project-state-current-${Date.now()}`, '--value', val, '-n', name]);
row.seeded = r.status === 0 && /stored successfully/i.test(r.out);
```

This is the exact shape ADR-063 documents: `ruflo memory store` printed `[OK] Data stored
successfully` on every write for three days during the 2026-08-13 incident while nothing persisted
(a native SQLite ABI mismatch silently fell back to a non-durable driver). `record-lesson.mjs` was
fixed for this class on 2026-08-24 (PR #167, confirmed live on `main`); `agentdb-fleet-doctor.mjs`
never received it, and had zero test coverage before tonight (confirmed: no `tests/**/*fleet-doctor*`
file existed).

The file's separate `VERIFY` step (below FIX 1/FIX 2) does round-trip a canary key — but a
**different, freshly-generated** key (`fleet-doctor-canary-<ts>`), not the checkpoint key FIX 1 just
wrote. That canary answers "is this namespace writable right now," not "did THIS specific checkpoint
write persist." A store call that claims success for the checkpoint key while silently no-oping (the
incident shape) would still show a passing canary — the aggregate report would read `SEEDED` /
`round-trip: PASS`, both wrong for the checkpoint specifically.

## Hypothesis (frozen before implementation)

> Given `scripts/agentdb-fleet-doctor.mjs`'s FIX 1 checkpoint-seeding path, whose `row.seeded` verdict
> is derived solely from the `ruflo memory store` command's exit status and a regex match against its
> stdout wording ("stored successfully"), when that store call exits 0 and prints the success wording
> while the underlying write to that SPECIFIC key silently does not persist (the ADR-063 / 2026-08-13
> incident shape), then `row.seeded` (and therefore `row.checkpoint`) currently reports true (a false
> positive) even though the separate round-trip canary check (`row.roundtrip`) verifies a DIFFERENT
> key in the same namespace and cannot distinguish a total namespace outage from a single silently-
> dropped write; adding a real round-trip check — retrieving the SPECIFIC seeded key back and
> confirming its value — before trusting `row.seeded`, should make the doctor correctly report a
> NOT-seeded / NEEDS ATTENTION state in that scenario — subject to: a genuinely successful, persisted
> seed is still reported as seeded; the existing separate canary round-trip check is unaffected; and
> no existing project's real checkpoint content is disturbed by this verification.

Frozen before implementation; unchanged since.

## Candidate

`scripts/agentdb-fleet-doctor.mjs`: captured the checkpoint's own key in a variable (`seedKey`,
previously computed inline and never retrievable), and — mirroring `degradation-watch.mjs`'s
`proveMemoryDurable()` / `record-lesson.mjs`'s established precedent — after a successful-looking
store call, retrieve that SAME key back through the managed interface (`--value-only`) and require
the returned value to contain a distinctive prefix of what was written (the value embeds a per-write
ISO timestamp, so a prefix match still identifies THIS write specifically, not a stale one; a full-
value match was avoided because this file's own FIX-2 canary comment already documents this CLI's
output truncating/reflowing multi-line content). `row.seeded` (and therefore `row.checkpoint`) is now
gated on both the store call succeeding AND that retrieve round-trip confirming the value. Diff: 1
file, +19/-3 lines (production only — the pre-existing inline key computation was hoisted to a
variable so it could be retrieved, no other logic changed). `tests/unit/agentdb-fleet-doctor.test.mjs`:
new file, 3 cases (zero coverage existed before tonight).

## Evaluation Receipt

Not a retrieval-quality candidate — `npm run eval:gate`: `no brain at
/root/.cache/ruvnet-brain/kb`, store root never materialized (`stores 0 dark 0` via
`store-root.mjs`), same condition every night has hit since 2026-08-19. `LLM_EVAL`: N/A — no model
call in this candidate's own path (`OPENROUTER_API_KEY` present, but nothing here calls it).

**TEETH, proven to fail first.** `git stash push -u -- scripts/agentdb-fleet-doctor.mjs` (isolating
the candidate, keeping the new tests), ran against unmodified `main`: **1 of 3 new tests fails** —
`TEETH: a store that claims success but silently drops the checkpoint key is NOT reported SEEDED` —
`expected '...SEEDED...' not to match /SEEDED/` (the doctor prints `SEEDED` for a checkpoint whose
write was silently dropped by the fake `ruflo`, exactly the false-positive this candidate targets).
The other 2 cases (a genuinely healthy seed; a store call that fails outright) pass unchanged on
baseline — confirming this is not a guard that fires on everything. `git stash pop`, re-ran: **3/3
pass.**

An **independent adversarial critic** (a fresh general-purpose agent, not this candidate's author)
reviewed the diff and reproduced the TEETH result independently before returning its verdict — see
Reward-Hack Check below.

## Regression Analysis

- Blast radius: `grep -rn agentdb-fleet-doctor` repo-wide — exactly this file, its own new test, and
  `scripts/wired-check.mjs`'s pre-existing classification comment (`'diagnostic CLI run by hand when
  a fleet looks wrong'`, unaffected — confirms human-run-only, never model-invoked). No importer.
- `npm run wired:check`: exit 0, `scripts/agentdb-fleet-doctor.mjs` still classified `○` (standalone).
- `node scripts/sync-version.mjs --check`: `4.3.25` agrees everywhere.
- `node scripts/doc-currency.mjs --check --changed HEAD`: no blocking violations. No ADR governs
  `scripts/agentdb-fleet-doctor.mjs`.
- `npm run claims:verify`: 4 PASS / 3 SKIP (brain-not-installed class, same as every prior night).
- `npx vitest run tests/unit` (full suite, 381+ files): started this session, still running at the
  time of this commit (this repo's own stop-hook requires committing/pushing promptly rather than
  holding work uncommitted while a ~450s full run completes). The targeted candidate test
  (`tests/unit/agentdb-fleet-doctor.test.mjs`) already ran to completion multiple times above (TEETH
  red→green, independently reproduced by a separate critic agent). Full-suite numbers will be pushed
  as a follow-up commit to this same PR once the run completes — the pattern this repo's own prior
  nights (e.g. #275, #276) already use for iterative, multi-commit draft PRs.
- `sqlite3` CLI installed this session (`apt-get install -y sqlite3`) to seed a real AgentDB schema
  for the new test — same operational note as the 2026-08-26 ledger row.

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean write-verification gate; same precedent as
every prior memory-durability night (record-lesson.mjs nights, 08-19/08-24/09-04/09-09).

## Evidence

OBSERVATION → MEASUREMENT → DECISION chain:
- OBSERVATION: `agentdb-fleet-doctor.mjs:68` (pre-candidate) computed `row.seeded` from stdout wording
  alone; grep confirmed zero prior test file existed.
- MEASUREMENT: TEETH test fails 1/3 on baseline (reproducing the false-positive), 3/3 pass on
  candidate; independently re-confirmed by a separate critic agent.
- DECISION: candidate closes the gap without weakening any existing check; ACCEPT recommended for
  human review (never self-promoted — see Merge Policy).

## Reward-Hack Check

Independent-critic pass (fresh general-purpose agent, not this candidate's author) — full verdict:
**CLEAR**. Checked: does the fix actually close the gap (yes — a genuine store→retrieve-same-key
round trip, matching the two established precedents); does it risk a false positive under realistic
conditions (checked timestamp-collision, output-truncation, and unhandled-throw scenarios — none
apply to a human-run CLI at this call rate); does it introduce a new defect (no — retrieve is
read-only, the new call is gated behind the pre-existing `if (!row.checkpoint)` block, `spawnSync`
does not throw on a missing binary); is the test's fake `ruflo` a faithful, non-gamed simulation (the
critic independently reproduced the TEETH red→green cycle itself, confirming the guard actually
fires for the right reason); any reward-hacking shape (none — no benchmark, gold answer, or threshold
touched). One non-blocking suggestion (the `val.slice(0, 60)` prefix-match rationale was under-
commented) — addressed before this report was finalized: the code now carries an explicit comment
explaining the prefix choice, re-verified 3/3 green after the change.

## Security Review

No new attack surface: the new retrieve call is read-only, uses the same `ruflo(...)` wrapper the
file already uses for `store`/`distill`/`search`, and reads only the key this same function just
wrote (no new external input, dependency, network call, or credential). `npm run wired:check`
confirms `agentdb-fleet-doctor.mjs` remains human-run only. No hook, gate, or model-invoked path
touched.

## Scan Findings

**managed-boundary**: this candidate's write path (checkpoint store + new retrieve) stays inside the
existing `ruflo(...)` wrapper — never raw `sqlite3` against the managed store (the file's separate
`sql()` helper, used elsewhere in this file for read-only fleet auditing, was already an established,
unchanged pattern predating tonight and out of scope for this candidate). No bypass introduced.

**round-trip-proof**: this scan surface IS tonight's Deep Dive finding — `agentdb-fleet-doctor.mjs`'s
checkpoint-seed path lacked ANY round-trip proof for its own specific write, relying entirely on a
sibling canary that verifies a different key. Closed via the same store→retrieve-same-key discipline
already established for `record-lesson.mjs` and `degradation-watch.mjs`.

## Competitors

| System | Relevant stance | Grade |
|---|---|---|
| OpenHands (Agent SDK) | Names durable state management as a foundation requirement; no documented per-write round-trip verification distinct from a health-check canary. | A (arXiv 2511.03690) |
| DSPy / GEPA | Persists mutations as versioned, re-scored artifacts — sidesteps this aliasing/false-positive class structurally. | A (official repo) |
| SWE-agent | No public claims on per-write round-trip verification surfaced tonight. | C |
| Cursor background agents | No public documentation on write-verification-under-repetition surfaced tonight. | C |
| Sakana AI Scientist | No public documentation of an explicit per-write freshness check distinct from a general health probe. | C |

No competitor claim justifies the implementation — justification is entirely this repo's own
`degradation-watch.mjs` / `record-lesson.mjs` precedent, extended to a second file.

## Gist

LOCAL — no `gh` CLI, no MCP gist-creation tool available this session (same limitation as every Dream
Cycle night since 2026-08-19). Full report committed at this path.

## Witness

```
SESSION_COMMIT = dd435b6bd9132716db23ac4c40d3e04d9f25b95e
REPORT_HASH    = 654fac486b51449aa6b33b4f7522b7fd540b289faf5ce8beb23499bfff1d60b0
WITNESS        = 12dba9c0a72a63bcda0021d867c6ebadbed613026b8a2c6a22d8100637752bdb
```

5-step verifier procedure anyone can reproduce:
1. `git log -1 --format='%H' dd435b6` — confirms tonight's session base commit.
2. `sha256sum docs/dream-cycle/2026-09-14-memory-durability-agentdb-fleet-doctor-report.md` (the committed, final version
   of this file) and compare to `REPORT_HASH` in the ledger row.
3. `printf '%s%s' <REPORT_HASH> <SESSION_COMMIT> | sha256sum`, compare to `WITNESS`.
4. `git stash push -u -- scripts/agentdb-fleet-doctor.mjs && npx vitest run tests/unit/agentdb-fleet-doctor.test.mjs; git stash pop` — reproduce the 1-of-3-fails-then-3-of-3-pass TEETH cycle this report cites.
5. `grep -rn agentdb-fleet-doctor --include='*.mjs' --include='*.json' --include='*.md' .` — reproduce the blast-radius claim (only the file itself, its test, and `wired-check.mjs`'s pre-existing classification comment).

## Recommendation

`evaluated: accepted`. Human review of the linked draft PR requested. Separately, and independent of
this candidate: the reviewer should pick ONE of #275/#276 (both fix #274) rather than merge both —
see the reconciliation comments posted to each tonight.

**Merge policy**: this session never merges and never self-promotes. Evaluation is not promotion
(ADR-068).
