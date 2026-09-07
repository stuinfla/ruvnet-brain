Updated: 2026-09-05 18:48:31 EDT | Version 1.5.0
Created: 2026-09-05 14:11:00 EDT

# QA execution contract

The producer inventory is `scripts/qa-lanes.mjs`. Local and CI consumers must select
producers from it instead of copying command lists. `qa-runner.mjs --list` prints
the diagnostic inventory; `--release --list` includes release diagnostics.

Use `--base <base-sha>` to scope document debt to the candidate merge base. Historical
drift remains in unscoped reports. Invalid base references fail explicitly. Without a
base, presumed drift is advisory; malformed document claims still fail.

`--lane <name>` may be repeated. Selection includes prerequisites automatically:
claims-source requires the coverage producer. Partial receipts say `selection: partial`;
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

Claims have explicit `source` and `runtime` scopes. The cold source stage checks baseline,
held-out data, coverage and versions. Runtime checks cost, corpus census and learning.
Strict census qualification requires explicit candidate KB, source SHA and version; the
canonical installed store is only an ambient diagnostic. Each scoped claims receipt lists omitted obligations, reports
`complete: false` and overall `verdict: UNKNOWN` even if its `scopeVerdict` is PASS;
a known failure remains FAIL.
Source qualification cannot stand in for the separate required runtime receipt.
The `architecture` lane runs `product-integrity-contract.mjs --check-source`. It validates
the ownership/dependency graph and checks every named architecture, implementation and
positive/adversarial test path. Missing files, directories or symlink substitutes fail.
Its report explicitly says `scope: source-presence` and `behaviorVerified: false`:
even complete source presence does not establish execution of the North Star lifecycle.

Runtime census diagnostics observe the installed store, not a sealed candidate. Strict
qualification stays UNKNOWN without explicit candidate inputs. Validated projection
membership excludes ambient extras. Qualification additionally requires an explicit clean
candidate root, payload manifest and ID, exact bundle-to-sidecar bytes, and agreement with
the candidate's committed advertising surfaces. Default signed mode verifies the pinned signing
key; explicit staged mode verifies member bytes but reports public signature proof as untested.
Do not regenerate advertising from ambient counts. Strict mode refuses `--fix`; complete
candidate-bound census verification remains required before publication.

Real embedding integration tests require the separately declared KB dependencies:
`npm ci --prefix kb --no-audit --no-fund`. A root-only install is not a complete runtime
test environment. Report a missing runtime dependency as such; do not skip the affected
tests or replace the real embedder with a fake to make qualification green.

These diagnostics do not replace packaged installation, cross-host runtime, public byte
verification, or real learning evidence. Do not describe a passing diagnostic subset as
North Star acceptance. The integration owner connects the shared producers to workflows
and retains each distinct runtime/artifact lane exactly once.

The release `continuity` lane consumes `RUVNET_SEALED_PACKAGE` without rebuilding it; local
diagnostics without that input pack once. It exercises interrupted
Claude-to-Codex and Codex-to-Claude restoration against disposable projects and real global
Ruflo. It proves packed-adapter durability, not native model-session continuation or relocation.
CI invokes this same lane in the existing candidate job and retains its source-bound receipt
alongside candidate evidence. Native Codex discovery is required in Linux integration;
a missing CLI or skipped discovery cannot qualify the release.

Candidate retrieval uses the same sealed canary plan and validator as public verification.
Both the candidate producer and prepublication consumer require the plan and coverage inputs.
One MCP process per staged host survives smoke and canary queries and is closed on every exit;
at most one RPC per host executes at a time. Full-corpus duration remains a measured release
requirement, not an inference from fixture timings. Structured ordered hits, query/depth and
actual returned passage content establish retrieval evidence; document prose cannot supply ranks.
Legacy responses lacking that structured metadata are explicitly UNKNOWN, not a text fallback.

Document currency binds current working-file bytes and refuses deleted or symlinked governed
files. A clean committed blob retains its existing digest recipe; unrelated edits do not expire it.
An explicit source-bound review may resolve only the presumption of missing review before commit.
Its digest and source-linked review row cannot assert correctness, promote decision/implementation
status, or hide other blocking findings; edits expire it. No hook automatically creates a review.
Installer-preserved generations and unresolved installer staging/rollback copies count toward
storage accounting. Their data is not automatically deletable, and their presence cannot satisfy
the zero-extra-copy native two-run proof.

Diagnostic source diffs are limited to 40 lines per input. This bounds output only, not
assertions or verdicts; failures retain their test name, source location, and truncation marker.
Console staging has one shared copy/digest surface and a real isolated import regression,
including its dynamically loaded archive helper. Syntax-only staging is not import proof.
