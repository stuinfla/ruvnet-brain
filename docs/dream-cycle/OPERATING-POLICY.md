Updated: 2026-10-25 08:45:00 EDT | Version 1.1.0
Created: 2026-09-05 14:15:00 EDT

# Dream issue disposition and deployment verification

Dream first tries to solve a reproduced defect within its existing authority. A
verified repair goes into the work record with its source identity, test evidence,
diff, witness, and integration reference. It does not get a tracking issue merely
because the experiment found a defect. A review PR can carry a verified local fix
without a paired issue. Only a new, reproduced, actionable problem that remains
unresolved after the bounded repair merits an issue containing the exact blocker.
An unsafe or unauthorized repair is recorded as that blocker, never attempted by
expanding the job's authority. Unreproduced or environmentally blocked experiments
remain work records.

## Confirmed compiler defect and correction

The inspected `dream-machine` 0.1.1 compiler's `withDefaults()` omits `findingPolicy`.
Consequently that object's prior `ledgerFirst` and `openIssueOnlyWhen` declarations
did not reach the generated prompt. The compiler's STEP 5-9 explicitly instructed
untestable findings to become issues; STEP 17-18 instructed issue creation without
checking whether a repair had already solved the finding.

The engine does preserve `extraDisciplines` in GLOBAL INVARIANTS. The repository now
uses that supported field to override those named steps, require a bounded repair
and fingerprint reconciliation, and make `Issue=NONE` valid. No custom unused
publisher or alternate nightly engine was introduced. `findingPolicy` remains a
machine-readable declaration; `extraDisciplines` is the actual compiler input.
The compiler test checks that the operative override survives emission.

## Running scheduler remains a separate verification boundary

ADR-068 records cloud routine `trig_01VuFmQFG3YdaPeswTPMVaT6`, named
`Ruvnet Brain Nightly Dream Cycle`, cron `30 8 * * *` UTC, targeting
`stuinfla/ruvnet-brain`. Its recorded bootstrap compiles current `dream.config.json`
at runtime. This is a source record, not a fresh confirmation of account state.
No routine-management tool was available during this correction; no live routine,
LaunchAgent, or GitHub state was modified.

Before declaring the scheduler corrected, inspect that existing routine in the
owner's Claude cloud account. Confirm its actual source branch and bootstrap, then
verify the next compiled prompt contains `ISSUE DISPOSITION OVERRIDE`. If it uses
a frozen prompt, update the existing routine to compile from the corrected source;
do not create a duplicate schedule. The existing documented compiler command is:

```sh
dream-machine schedule dream.config.json --out routine.json
```

That command emits a routine body; it does not by itself update the cloud schedule.
Verify a subsequent run records a solved finding without an issue, an unresolved
reproduced finding with its failed repair, and deduplication against an existing
fix PR. A generated prompt passing tests is not proof that a hosted worker followed
it. Technical enforcement additionally requires restricting that worker's GitHub
write path; the configuration alone does not remove direct issue-creation tools.

`scripts/issue-fix.mjs` consumes existing issues. Its scheduled mode only triages;
its supervised mode prepares local candidates without public writes. It is not the
Dream issue producer, so changing it would not prevent the cloud routine's issue
creation. Existing backlog reconciliation belongs to the integration owner.

## Known session-scope limitations (as of 2026-10-25)

Two recurring conditions are environment facts, not repository defects, and a
night hitting either should record `INCONCLUSIVE`/`not attempted` rather than
retry a workaround:

- **STEP 0 compile denial.** `npx -y dream-machine@0.1.1 compile` is sometimes
  denied by the session's own auto-mode classifier (`Code from External` /
  `Untrusted Code Integration`) before any slot is selected — see #298 (first
  2026-09-19, recurred 2026-09-27, 2026-10-20, twice 2026-10-21, 2026-10-23;
  succeeded again 2026-10-25). Intermittent, not permanent. The only real fix —
  vendoring `dream-machine@0.1.1` into `devDependencies` so `npm ci` supplies it
  without a runtime `npx -y` fetch — needs a human to run `npm install --save-dev`
  outside this sandbox; every attempt to propose it from inside a session has
  itself been denied by the same classifier.
- **`coverage-gap-review` cannot execute inside a Dream Cycle session.**
  `scripts/source-coverage.mjs` enumerates all of `ruvnet`'s public repositories
  via `gh api graphql`, and its REST fallback (`gh api users/{owner}/repos`) is
  also blocked — see #494 (2026-10-25). This session type is bound to a fixed,
  pre-configured set of repositories; open-ended cross-repo discovery is refused
  at the session layer regardless of which GitHub API shape the script uses. The
  script itself is correct and already runs successfully in
  `.github/workflows/corpus-seed.yml` and `.github/workflows/protected-release.yml`,
  which have unrestricted `gh` auth. No in-session code fix exists. Until the
  owner decides whether to drop `coverage-gap-review` from `dream.config.json`'s
  `bonusModuli` or redefine it as a staleness check against the already-committed
  `data/source-coverage.json` instead of a live re-measurement, a night landing on
  this bonus slot should record the same disposition and move on.
