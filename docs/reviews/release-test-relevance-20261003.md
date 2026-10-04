Updated: 2026-10-03 13:58:55 EDT | Version 1.0.0
Created: 2026-10-03 13:58:55 EDT

# Retained release test relevance review

Repository: /Users/stuartkerr/Code/ruvnet-brain-worktrees/adr102-integration
Reviewed at: 2026-10-03T17:54:06.892011+00:00
Base inventory: git show e01c96dc:scripts/release-qualification-contract.mjs (26 source + 4 integration); current release QE glob (4 files).
Read-only review; no test execution, repository edits, release action, or score. All 34 test files were read in full, including fixture construction, assertions, cleanup and platform guards. Current contract has additional memory/lifecycle/learning tests outside this delegated retained-inventory scope; those are not approved by this report.

Architecture grounding: full CONTRIBUTING.md, docs/qa-execution-contract.md, current release-qualification-contract.mjs and release-qualification.mjs; actual hook policy/installer registry validator; actual updater Stable Spine engine and shell-boundary definitions; relevant installer uninstall paths; candidate host evidence producer; public lane/aggregate acceptance paths; signing producer/consumer; shared fake release provider; current CI QE invocation. Production module bodies not fully read are not claimed fully audited.

## Consequential findings

1. Uninstall fixture isolation is unsafe under exported path overrides. See uninstall-footprint run env and bin/install resolvedKbDir/codexHomeDir/uninstallAll. Do not run unchanged under an ambient configured user environment.
2. Initial QA contract overstated native full installed-update acceptance versus bounded scheduler smoke. Root independently traced the existing smoke policy to f93bc4a0 and corrected documentation. Retain smoke tests as bounded release scheduler-boundary proof; full two-run installed-update soak remains NOT PROVEN by this review.
3. Windows source inventory contains unguarded file symlink creation. Missing permissions are failed prerequisites, not valid skips; current unit fixture portability needs explicit proof.
4. Builder fence success-ish cases do not check exit status/ZIP and can count partial output as public exclusion proof. Scope them explicitly or validate actual archive.
5. Source text workflow/serial-runner assertions are source-presence assertions; retain workflow wiring only with separate behavioral/native receipts, remove redundant serial-runner text case.
6. Packed hook tests compare only event keys, not full declared callback plane. Strengthen packaging parity while preserving restored automatic hook architecture.

## Per-file disposition

### tests/unit/sign-verify-roundtrip.test.mjs
- SHA-256: `285b072f406dd02cc2cd6fd6c2fdd6bf4743146abfe9926f739bb1d9363725ca`
- Read scope: all 89 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual signing CLI plus trusted consumer; tampering, foreign key, missing signature. Opaque bytes are intentional crypto fixture, not ZIP/runtime proof.

### tests/unit/assembled-release-projection.test.mjs
- SHA-256: `3e493fb0f356ce13e519b0e3ea13d05d76d03d92969ee5aef60e3dfc5f2f8fe6`
- Read scope: all 202 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Current pure sealed projection and validation-only activation; real fixture producer/inventory; modified coverage, ledger, public bytes and gist-set drift. Requires checkout kb/ruv-gists.sources.json; receipt freshness is not asserted.

### tests/unit/protected-release-invocation.test.mjs
- SHA-256: `91bed5923f8f7800b33e6f5e5e43a035cc2d04967445d791f390ed49d49a5760`
- Read scope: all 134 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual environment/seal consumer with same-source artifact mutation; synthetic strict/stabilization receipts exercise validator, not workflow authorization or real independent graders.

### tests/unit/release-identity-invariants.test.mjs
- SHA-256: `80df1281fc5800d61521c9f83ab12bb60a9c0eff3f7b647325f37e1a648e28d8`
- Read scope: all 28 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Current single version surfaces and refusal to infer publication from source version. Source assertion, correctly bounded.

### tests/unit/release-transaction.test.mjs
- SHA-256: `b4b2ea5fce35446e378a9f996171ffaaac47756eb827065086a01e01e55f7089`
- Read scope: all 127 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual transaction and signing/chain/disposition code through FakeReleaseProvider; includes schema2 compatibility, destructive explicit abort authorization and undefined serialization. Fake provider cannot prove remote durability.

### tests/unit/prepublication-evidence.test.mjs
- SHA-256: `cc5b037106b8aff32030314200f85f77ad250836565951f84ce514c1a3110e34`
- Read scope: all 199 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual envelope consumer against same-run typed fixture receipts; canary evidence is produced through actual validator with fake search. Source/run/payload/warmup/census/skips mutations are relevant.

### tests/unit/candidate-host-evidence.test.mjs
- SHA-256: `bbf3cc65cc7e70f99d2736668b052d15bf790ae1d9e36b6e012d8c90061c68f1`
- Read scope: all 128 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual archive staging and fixture RPC boundary; fake installer/grounding/search server isolates exact receipt consumer behavior. Limits and cleanup relevant; not native host acceptance.

### tests/unit/host-install-matrix-concurrency.test.mjs
- SHA-256: `08f4915372bbcc0f356f86fad2cf46e5b378c8cfa7057a45402f60f1d619cfc0`
- Read scope: all 173 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual orchestration with injected command/search collaborators; isolated hosts/shared model cache, sequential order, failure diagnostics and registry resolution. No real host install or performance proof.

### tests/unit/integration-evidence.test.mjs
- SHA-256: `2c8c7962a1630c3170be555f9004ad9a0b8ca04886a083646c2e3d167ecdece4`
- Read scope: all 80 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Legacy governed exclusions remain compatibility-only; current reviewed receipt branch independently rejects skipped/unaccounted/wrong-source evidence. Synthetic reports do not prove execution.

### tests/unit/qualified-candidate-check.test.mjs
- SHA-256: `b1a9f604b8cf831a4531fb43787e4be54f51ffc588caac9aa609a91fa1a3c2b1`
- Read scope: all 75 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual authenticated-run/artifact identity consumer, injected GitHub API. Polling and provenance mutants matter; no real GitHub service proof.

### tests/unit/release-qualification.test.mjs
- SHA-256: `61892d8b84f69d79de455b511ef98136c7bc92124c5791805494a094603aa214`
- Read scope: all 78 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual report/receipt validators, complete passed cases and exact file set; Windows path normalization and source stability mutants. Does not execute qualification producer end to end.

### tests/unit/development-push-boundary.test.mjs
- SHA-256: `1b435a66b958af7bff972dd0270fb17a9a69298ca99eaf47de88883cef423f6b`
- Read scope: all 30 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Real Git fixtures plus production push inspector catches historical removed secret; ordinary push remains separate from publication gates.

### tests/unit/protected-release-workflow.test.mjs
- SHA-256: `832155e959b0d7d7e63881e1c78a02604c73792a6dd748c91462e00471cdb8b9`
- Read scope: all 216 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Source wiring assertions for current once-only preflight/payload/public verification and machine gates. Text presence is source-presence proof only; YAML execution/GitHub settings require other evidence.

### tests/unit/public-verification-aggregate.test.mjs
- SHA-256: `afa5a2f71dbb77e09abff154f873984db95568b8d6c95602ca91174b91c6c92b`
- Read scope: all 252 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual nine-leaf signing/aggregation and CLI with synthetic retrieval/native proof; rejects identity/digest/signature/missing/raw evidence and wrong run. Fixture counters are not corpus-current proof.

### tests/unit/public-verification-finalizer.test.mjs
- SHA-256: `fb963e80f43866eca489d16d6040b7b3dc0af474257ea07eeb8f65e3c20ba06e`
- Read scope: all 179 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual finalizer and receipt materialization with fake provider; verifies no republish, channel/source/verifier/signature drift, append-only output. Review model IDs are current validator compatibility fixtures, not actual model execution.

### tests/unit/public-verification-lane.test.mjs
- SHA-256: `790c2cec7dcda56d17170796e6c67dd4b1fb368f1a79a37ad21e19532d6b2207`
- Read scope: all 285 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual public lane consumer tests and fake native-adapter boundary. Bounded smoke success follows existing production policy, independently traced by root to f93bc4a0; documentation overclaim corrected by root. Full installed-update soak is separate and not established.

### tests/unit/public-verification-abandon.test.mjs
- SHA-256: `df7e5cf42acd181f9b9efbe14d99a44e54b26efec5ee59985fbb1a99fa447a12`
- Read scope: all 136 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual signed unsuccessful closure and GitHub provenance validator through fake API/provider; exact intent/readback/no republish and adversarial source/actor/state cases remain relevant.

### tests/unit/publication-receipt-producer.test.mjs
- SHA-256: `178ba865b6d1c669ba8db741bf8fb100f15c3a0eacfa2cea2670861df25f2a74`
- Read scope: all 404 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Keep actual orchestration, byte/identity consumer, tar/RPC/UTF8/Windows path checks. Source-text serial-runner assertion duplicates behavioral serial-doctor tests and is implementation-coupled; remove only that case from authoritative qualification. Multiple temp roots are not cleaned, so add tracked cleanup.

### tests/unit/recovery-candidate-source.test.mjs
- SHA-256: `906d43ffcf155e4f9a19dc57326eb8b64d8e697c51148d6e43f7046fc2a1608d`
- Read scope: all 186 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Real Git/child subprocess with fail-closed offline fetch/npm substitutes; distinct immutable candidate/verifier and mutation checks. VM source-expression test is narrower than actual Windows execution; no remote probe proof.

### tests/unit/automatic-hook-retirement.test.mjs
- SHA-256: `b3cf337ccea31967de087f72772cf734b3d5766b72baafc2a4361d6d33f20de9`
- Read scope: all 126 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: After tracing production, registrations means forbidden/legacy registrations, not all automatic hooks. Current policy allows declared restored plane. Empty forbidden list and undeclared sentinel rejection are correct. Rename misleading descriptions/comments only; do not remove tests for nonexistent retirement premise.

### tests/unit/install-activation-rollback.test.mjs
- SHA-256: `af373d23c808f81e2c96b4d943aca8f710ce447a2e36560d7bac41b865c44d93`
- Read scope: all 192 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual installer unzipInto, genuine release coverage validator, real filesystem fault injection/prior-private preservation. Synthetic RVFs/guard intentionally test activation boundary, not vector reader correctness.

### tests/unit/forge-update-apply-rollback.test.mjs
- SHA-256: `96d9ebb6670c8aef525223dd012c35bcdeee910603dad140f2e4005b8a43bf5e`
- Read scope: all 652 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Keep actual signed local-network updater, rollback/private storage/disk budget/current/noop/imported evidence checks. Retired-store case and unsafe-backup case create unguarded symlinks on Windows; unlike nearby canLink guarded case, need explicit Windows-capable fixture or verified symlink prerequisite. Manually copied updater module list can drift; derive graph or assert graph closure. IMPORT_ONLY not restored.

### tests/unit/nightly-scheduler.test.mjs
- SHA-256: `0afc02c74747499904e63739c267b5f270bd37e2ec62de82e73cf145e3d981ab`
- Read scope: all 324 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Actual scheduler registration/identity/envelope code with mocked native commands, not native scheduler proof. Unguarded symlink fixture can require Windows privilege; declare prerequisite or portable fixture. Keep symmetric ownership/drift/failure assertions.

### tests/unit/nightly-refresh-launcher.test.mjs
- SHA-256: `4e4d917f1c32e35f16dc27eebdbd7d263829b2bb01aee372f1a74e3ae844e761`
- Read scope: all 63 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual launcher child with fake managed npm entry and platform override; tests literal argv, custom paths, exit propagation and escaping. Windows simulation does not prove native scheduler delivery. Unguarded file-symlink mutant needs Windows prerequisite.

### tests/unit/nightly-two-run-proof.test.mjs
- SHA-256: `6bbb8a225158b72d2cb114761fc270087b962f0a085c4c36bd0f0ab02ab98aba`
- Read scope: all 497 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual native-trigger/receipt validators with fake scheduler and structural proof; explicitly distinguishes imported release from production build. Actual local offline npm/exact package-cache checks valid. No real native trigger soak in unit suite; symlink privileges/prerequisites must be declared.

### tests/unit/ux-render-best-of-n.test.mjs
- SHA-256: `6e1ea5931afaebcff78eafb36af11783a3884ae040b14159d930c804fa4bc45d`
- Read scope: all 143 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual ranking/retry code with synthetic timings/acceptance: persistent regressions/missing readings stay red, recover only fully clean attempts. Not rendered UI/performance evidence. Env-override test title is stronger than assertion, which only checks exported value finite>=1.

### tests/integration/managed-cli-mcp.test.mjs
- SHA-256: `9649dfb1ad78b713802a855f56b88d9e237c3734bb672bd3710173aed9581d80`
- Read scope: all 534 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Actual protocol server subprocess/readiness/CLI policy/literal argv; fixture workers and ruflo executable are intentionally fake. Entire suite relies on POSIX shebang executable and symlink aliases; correct Linux integration placement, not Windows source proof. Cleanup kills without awaiting exits and never removes fixture roots; retain but fix resource cleanup. 500ms wallclock catalog bound can be noisy.

### tests/integration/build-bundle-fence.test.mjs
- SHA-256: `5deec02226f7f4cdd370ee7be82f42c45cfc97794e83fb4bc3e8c88a3879a151`
- Read scope: all 230 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Actual cloned builder CLI with import graph derived; scoped index-audit stub explicitly bounds private fence/sidecar discovery. Successful discovery cases never assert process exit status or ZIP exclusion, so partial builder output can satisfy exclusion claims after later failure; add exact allowed outcome and inspect sealed ZIP for success-case proof. Legacy schema1 ledger fixtures model accepted bootstrap path, not canonical production ledger.

### tests/integration/codex-skill-discovery.test.mjs
- SHA-256: `fe5d644f6fcfebe554193c04506e4d321f07c48467fd764624180f38d1ee8499`
- Read scope: all 162 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Real native Codex loader/repair/disabled-state using disposable CODEX_HOME. CLI absent is fail-closed in qualification because producer sets REQUIRE flag and rejects skipped report. CLI version check has no timeout; add bounded prerequisite. IMPORT_ONLY not restored.

### tests/integration/uninstall-footprint.test.mjs
- SHA-256: `9a234846a90acca0921071e154169d803d8a2c59f12dc7ea0b20a5667e7182ff`
- Read scope: all 157 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Actual uninstall filesystem preservation assertions, but subprocess inherits RUVNET_BRAIN_KB, RUVNET_BRAIN_HOME, CODEX_HOME and related overrides while only HOME is reset. Production honors these overrides, so destructive fixture may reach real KB/config. Must set/sanitize all paths before execution. run() discards status/error and --what-changed only tests output.

### tests/qe/release/issue-64-host-convergence.test.mjs
- SHA-256: `1e78784f54cb45018936e44cf5372fdc1486ad3d36015e4b19fbac682ef58313`
- Read scope: all 124 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Actual Claude registry status and update-apply child; minimal payload/empty hooks isolate selection, not complete current plugin acceptance. CLAUDE_CONFIG_DIR inherited despite temp HOME so staged selection can use foreign cache; isolate it explicitly. Keep expected-version and foreign payload semantics.

### tests/qe/release/packed-clean-install.test.mjs
- SHA-256: `14f3b69456496bd023a0b35f377f5937827b93594ec4d102c1a5fa567f18af13`
- Read scope: all 171 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **CHANGE**.
- Reason and proof limit: Actual sealed package consumption (local pack fallback), exact versions, actual Codex wiring and isolated console import are relevant. Hook parity compares keys only plus SessionStart count; command/matcher/timeout modifications can pass. Compare full host declarations or canonical IDs/matchers against production policy. This is packaging/import proof, not native host runtime install.

### tests/qe/release/release-transaction-faults.test.mjs
- SHA-256: `b00bbb1f766856fca77d9d7adca0ceae338973730edb8dd6ac3cafef11f84c58`
- Read scope: all 190 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual transaction with fake provider covers interrupted before/after mutations, no duplicate npm publish, bounded visibility, pointer-vs-code recency, competing writers and compensation. Shares happy-path proof with unit transaction but fault matrix is distinct. Real remote provider still separately required.

### tests/qe/release/stable-spine-recovery.test.mjs
- SHA-256: `b2d7901c651628c2fa7019e5c32cc323f2b54312cf132ae8f2c5b8e08d7f2342`
- Read scope: all 84 lines, current working-file bytes; all test cases/fixtures and cleanup.
- Disposition: **KEEP**.
- Reason and proof limit: Actual update-apply child and real fs for idempotence/rollback/collision/syntax rejection; empty hook fixtures accepted by current engine and intentionally not complete native loader payloads. BrainHome isolated; no native model/knowledge update claim.

## Duplicate proof and prerequisite disposition

The transaction happy path appears in unit transaction and release QE fault tests, but the fault matrix and recovery mutants supply distinct authority; consolidate only their shared happy path if producer inventory is intentionally changed. Public lane, aggregate, finalizer and prepublication checks are distinct production seams, not duplicate native execution; their synthetic receipts must never be counted as native producers. Version equality source and packed checks are distinct source/artifact boundaries. Hook-retirement and packed-hook checks also differ: policy acceptance vs packaging preservation.

Required tools observed in retained fixtures: Node ESM + Vitest, Git, tar, native Codex, real local npm, POSIX executable semantics for Linux managed-CLI integration, zip on POSIX or PowerShell archive writer on Windows, and symlink capability for several source fixtures. No availability check or runtime claim was made in this read-only review. The real Codex tests fail qualification when unavailable; other prerequisite weaknesses identified above need explicit remediation.

No whole-corpus freshness, model execution, actual external publication, actual native two-run installed-update soak, automatic Codex Stop delivery or native cross-host session continuation was tested here.

## Executed remediation after read-only review

Root authorized an isolated writing worktree for only the two unsafe/nonhermetic fixtures. Commit `2b47320d` on `fix/reviewed-test-isolation` strips ambient RUVNET_/CLAUDE_/CODEX_/XDG_ selectors case-insensitively and sets disposable HOME/USERPROFILE/config/cache/Brain paths. Uninstall helper now asserts error absent, signal absent and exit status zero. Actual negative fixture checks preserve a foreign valid Brain and refuse a foreign Claude cache payload. Scoped command: `node node_modules/vitest/vitest.mjs run tests/integration/uninstall-footprint.test.mjs tests/qe/release/issue-64-host-convergence.test.mjs --maxWorkers=1`; result 2 files,17 tests PASS,4.46s. `git diff --check` passed. No broad tests were run. Generated convergence change was excluded from commit and left unstaged in isolated worktree.

Fixed exact source hashes (worktree `/Users/stuartkerr/Code/ruvnet-brain-worktrees/reviewed-test-isolation`):
- `tests/integration/uninstall-footprint.test.mjs`: `fb946fe5c663c1f1aa26c8c009fff89cb83e3007a4ad1c7a1a74ca47373b2b0c`; all 187 final lines inspected.
- `tests/qe/release/issue-64-host-convergence.test.mjs`: `754538d02971879f342a10c5d87999635a8a00fade15754dbc46d137595533f3`; all 149 final lines inspected.

## Second scoped remediation

Commit `10733416` changes only builder-fence, managed-cli-mcp and packed-clean-install retained tests. Builder discovery fixtures now require exact exit1/missing-public-idmap failure and no archive, with accurately bounded test names; subprocess launch errors/signals and timeout are checked. Managed fixtures await protocol shell closure, force-kill boundedly on timeout while retaining failure, and remove only tracked fixture roots after successful shutdown. Packed host manifests must equal complete parsed source declarations, including callbacks, matchers, timeouts and metadata; removed redundant weaker event-key comparison.

Scoped three-file run:31tests PASS in8.83s. Final managed cleanup fallback refinement:15tests PASS in5.21s. Diff whitespace check passed. No broad test execution, production source changes or generated convergence commit.
- Final `tests/integration/build-bundle-fence.test.mjs`: `71764d4c8d4aaf395bab4dbe247625a1c12ac4a25343e37df1dfb5227ec0d744`; 245 final lines inspected.
- Final `tests/integration/managed-cli-mcp.test.mjs`: `a218a224831a7d43dd43813c705a878b483e4e249dadfd13116ce0737705f52c`; 557 final lines inspected.
- Final `tests/qe/release/packed-clean-install.test.mjs`: `f457edbb03fbf4dd726aa83e44b1bd3c4f3388db80906430969356a97daf97a3`; 167 final lines inspected.
