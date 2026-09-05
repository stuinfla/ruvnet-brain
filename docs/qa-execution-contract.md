Updated: 2026-09-05 14:11:00 EDT | Version 1.0.0
Created: 2026-09-05 14:11:00 EDT

# QA execution contract

The producer inventory is `scripts/qa-lanes.mjs`. Local and CI consumers must select
producers from it instead of copying command lists. `qa-runner.mjs --list` prints
the diagnostic inventory; `--release --list` includes release diagnostics.

Use `--base <base-sha>` to scope document debt to the candidate merge base. Historical
drift remains in unscoped reports. Invalid base references fail explicitly. Without a
base, presumed drift is advisory; malformed document claims still fail.

`--lane <name>` may be repeated. Selection includes prerequisites automatically:
claims requires the coverage producer. Partial receipts say `selection: partial`;
they are never a complete qualification. Processes sharing the tests resource serialize;
at most two independent resources run together. Failed prerequisites block dependents,
while independent lanes still finish.

Every invocation creates a unique temporary receipt directory printed in its last JSON
line. Receipts bind HEAD plus a digest of tracked and nonignored untracked source bytes,
file modes and symlink targets. Source is compared before and after execution; changes
make the aggregate UNKNOWN. Ignored runtime assets are outside this source identity;
publication still requires the existing separately verified package and RVF payload.

Statuses are PASS, FAIL, UNKNOWN, TIMEOUT and BLOCKED. Unknown evidence never aggregates
to PASS. Claims diagnostics display unmeasured evidence as UNKNOWN; the release claims
producer uses `--strict`, which exits 4 for UNKNOWN. A successful source test or stable
version string never proves publication. Publication remains receipt and artifact based.

These diagnostics do not replace packaged installation, cross-host runtime, public byte
verification, or real learning evidence. Do not describe a passing diagnostic subset as
North Star acceptance. The integration owner connects the shared producers to workflows
and retains each distinct runtime/artifact lane exactly once.
