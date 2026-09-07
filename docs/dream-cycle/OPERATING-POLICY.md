Updated: 2026-09-05 14:15:00 EDT | Version 1.0.0
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
