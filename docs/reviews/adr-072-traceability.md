# ADR-072 generated traceability

> Generated from `scripts/product-integrity-contract.mjs`; do not hand-edit.

## Processes

| Process | Upstream | Owns | Contributes |
|---|---|---|---|
| SourceCoverage | — | — | S-1, S-3 |
| CorpusGeneration | SourceCoverage | S-1 | S-2, S-3, S-5 |
| ReleaseProjection | CorpusGeneration | S-2 | — |
| RefreshLifecycle | ReleaseProjection | S-4, S-5 | S-11 |
| HostConvergence | ReleaseProjection | S-6 | S-11, S-12 |
| ReleaseTransaction | ReleaseProjection | — | S-7 |
| PublicVerification | ReleaseTransaction, HostConvergence | S-3, S-7 | S-6, S-10, S-12 |
| ProductIntegrityCase | RefreshLifecycle, PublicVerification | S-8, S-9, S-10, S-11, S-12 | — |

## Obligations

| ID | Statement | Owner | Contributors |
|---|---|---|---|
| S-1 | One complete public corpus | CorpusGeneration | SourceCoverage |
| S-2 | One immutable public release projection | ReleaseProjection | CorpusGeneration |
| S-3 | Recall at 10 is at least 98 percent and delta citations are complete | PublicVerification | SourceCoverage, CorpusGeneration |
| S-4 | Native nightly runs are ordered, idempotent, and retained within budget | RefreshLifecycle | — |
| S-5 | One active corpus preserves private stores and bounded recovery | RefreshLifecycle | CorpusGeneration |
| S-6 | Every supported OS and host loader converges on exact public bytes | HostConvergence | PublicVerification |
| S-7 | Publication ends only after signed public verification | PublicVerification | ReleaseTransaction |
| S-8 | Accepted architecture has one executable owner and source-bound trace | ProductIntegrityCase | — |
| S-9 | Every essential behavior has positive and adversarial proof | ProductIntegrityCase | — |
| S-10 | Fable 5 and GPT-5.6-Sol review identical immutable inputs | ProductIntegrityCase | PublicVerification |
| S-11 | Project continuity is complete and host-neutral | ProductIntegrityCase | HostConvergence, RefreshLifecycle |
| S-12 | RuvNet capability claims are bound to live evidence before delivery | ProductIntegrityCase | HostConvergence, PublicVerification |

## Essential behavior proofs

| Behavior | Positive | Adversarial | Receipts |
|---|---|---|---|
| S-1.essential | tests/unit/source-coverage.test.mjs (unit)<br>tests/unit/corpus-reconcile.test.mjs (unit) | tests/unit/source-coverage.test.mjs (unit)<br>tests/unit/corpus-reconcile.test.mjs (unit) | ruvnet-brain-source-observation<br>ruvnet-brain-corpus-candidate |
| S-2.essential | tests/integration/build-bundle-fence.test.mjs (integration)<br>tests/unit/public-inventory.test.mjs (unit) | tests/integration/build-bundle-fence.test.mjs (integration)<br>tests/unit/public-inventory.test.mjs (unit) | ruvnet-brain-release-coverage |
| S-3.essential | tests/unit/retrieval-canary.test.mjs (unit)<br>tests/unit/packed-retrieval-canary.test.mjs (unit) | tests/unit/retrieval-canary.test.mjs (unit)<br>tests/unit/packed-retrieval-canary.test.mjs (unit) | ruvnet-brain-retrieval-canary-plan<br>ruvnet-brain-retrieval-canary-receipt |
| S-4.essential | tests/unit/nightly-scheduler.test.mjs (unit)<br>tests/unit/nightly-two-run-proof.test.mjs (unit) | tests/unit/nightly-scheduler.test.mjs (unit)<br>tests/unit/nightly-two-run-proof.test.mjs (unit) | ruvnet-brain-refresh-run<br>ruvnet-brain-native-two-run-nightly-proof |
| S-5.essential | tests/unit/update-storage-transaction.test.mjs (unit)<br>tests/unit/brain-profile.test.mjs (unit) | tests/unit/update-storage-transaction.test.mjs (unit)<br>tests/unit/brain-profile.test.mjs (unit) | ruvnet-brain-update-storage-transaction<br>ruvnet-brain-installed-profile |
| S-6.essential | tests/unit/host-registry.test.mjs (unit)<br>tests/integration/dual-host-install.test.mjs (integration) | tests/unit/host-registry.test.mjs (unit)<br>tests/integration/dual-host-install.test.mjs (integration) | ruvnet-brain-host-registry<br>ruvnet-brain-public-verification-leaf |
| S-7.essential | tests/qe/release/release-transaction-faults.test.mjs (candidate-host)<br>tests/unit/public-verification-finalizer.test.mjs (unit) | tests/qe/release/release-transaction-faults.test.mjs (candidate-host)<br>tests/unit/public-verification-finalizer.test.mjs (unit) | ruvnet-brain-release-transaction-receipt<br>ruvnet-brain-public-verification-aggregate |
| S-8.essential | tests/unit/product-integrity-contract.test.mjs (unit)<br>tests/unit/source-scope-receipt.test.mjs (unit) | tests/unit/product-integrity-contract.test.mjs (unit)<br>tests/unit/source-scope-receipt.test.mjs (unit) | ruvnet-brain-product-integrity-contract<br>ruvnet-brain-product-integrity-trace |
| S-9.essential | tests/unit/product-integrity-contract.test.mjs (unit)<br>tests/unit/adr-072-completion.test.mjs (unit) | tests/unit/product-integrity-contract.test.mjs (unit)<br>tests/unit/adr-072-completion.test.mjs (unit) | ruvnet-brain-product-integrity-trace<br>ruvnet-brain-adr-072-completion |
| S-10.essential | tests/unit/public-verification-aggregate.test.mjs (unit)<br>tests/unit/protected-release-workflow.test.mjs (unit) | tests/unit/public-verification-aggregate.test.mjs (unit)<br>tests/unit/protected-release-workflow.test.mjs (unit) | ruvnet-brain-independent-review<br>ruvnet-brain-public-verification-aggregate |
| S-11.essential | tests/unit/project-progression-contract.test.mjs (unit)<br>tests/acceptance/cross-host-project-resume.test.mjs (packed-artifact) | tests/unit/project-progression-contract.test.mjs (unit)<br>tests/acceptance/cross-host-project-resume.test.mjs (packed-artifact) | ruvnet-brain-project-progression<br>ruvnet-brain-cross-host-resume |
| S-12.essential | tests/unit/capability-inventory-receipt.test.mjs (unit)<br>tests/unit/capability-claim-evidence.test.mjs (unit)<br>tests/unit/continuation-gate-capability-truth.test.mjs (unit)<br>tests/unit/managed-cli-interface.test.mjs (unit)<br>tests/unit/grounding-receipt-lanes.test.mjs (unit)<br>tests/acceptance/adr-074-packed-capability-claims.acceptance.test.mjs (packed-artifact) | tests/unit/capability-inventory-receipt.test.mjs (unit)<br>tests/unit/capability-claim-evidence.test.mjs (unit)<br>tests/unit/continuation-gate-capability-truth.test.mjs (unit)<br>tests/unit/managed-cli-interface.test.mjs (unit)<br>tests/unit/grounding-receipt-lanes.test.mjs (unit)<br>tests/acceptance/adr-074-packed-capability-claims.acceptance.test.mjs (packed-artifact) | ruvnet-brain-capability-inventory<br>ruvnet-brain-capability-claim-audit<br>ruvnet-brain-source-claim<br>ruvnet-brain-live-surface<br>ruvnet-brain-capability-claim-aggregate |
