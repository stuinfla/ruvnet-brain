// Reviewed stabilization release boundaries. Legacy tests remain developer diagnostics.
export const RELEASE_REQUIREMENTS = Object.freeze({
  "source": [
    {
      "id": "signed-artifacts",
      "reason": "Signature verification and exact assembled coverage reject changed bytes",
      "files": [
        "tests/unit/sign-verify-roundtrip.test.mjs",
        "tests/unit/assembled-release-projection.test.mjs"
      ]
    },
    {
      "id": "protected-publication",
      "reason": "Only owner-authorized exact-source artifacts enter publication",
      "files": [
        "tests/unit/protected-release-invocation.test.mjs",
        "tests/unit/release-identity-invariants.test.mjs",
        "tests/unit/release-transaction.test.mjs",
        "tests/unit/prepublication-evidence.test.mjs",
        "tests/unit/candidate-host-evidence.test.mjs",
        "tests/unit/host-install-matrix-concurrency.test.mjs",
        "tests/unit/integration-evidence.test.mjs",
        "tests/unit/qualified-candidate-check.test.mjs",
        "tests/unit/release-qualification.test.mjs",
        "tests/unit/development-push-boundary.test.mjs",
        "tests/unit/protected-release-workflow.test.mjs"
      ]
    },
    {
      "id": "public-verification",
      "reason": "Public bytes, native update evidence and terminal receipts are bound to the actual candidate and run",
      "files": [
        "tests/unit/public-verification-aggregate.test.mjs",
        "tests/unit/public-verification-finalizer.test.mjs",
        "tests/unit/public-verification-lane.test.mjs",
        "tests/unit/public-verification-abandon.test.mjs",
        "tests/unit/publication-receipt-producer.test.mjs",
        "tests/unit/recovery-candidate-source.test.mjs"
      ]
    },
    {
      "id": "safe-install-update",
      "reason": "Installation and update preserve prior and private state and reject invalid dependencies",
      "files": [
        "tests/unit/automatic-hook-retirement.test.mjs",
        "tests/unit/install-activation-rollback.test.mjs",
        "tests/unit/forge-update-apply-rollback.test.mjs"
      ]
    },
    {
      "id": "native-scheduler",
      "reason": "Owned scheduler lifecycle, execution identity, measured no-op and signed installed coverage",
      "files": [
        "tests/unit/nightly-scheduler.test.mjs",
        "tests/unit/nightly-refresh-launcher.test.mjs",
        "tests/unit/nightly-two-run-proof.test.mjs"
      ]
    },
    {
      "id": "ux-hard-acceptance",
      "reason": "Retry accounting preserves hard UI acceptance failures and chooses only a clean measured attempt",
      "files": [
        "tests/unit/ux-render-best-of-n.test.mjs"
      ]
    },
    {
      "id": "canonical-memory-privacy",
      "reason": "Canonical project isolation, persisted consent and truthful capture status",
      "files": [
        "tests/unit/turn-outcome-capture.test.mjs",
        "tests/unit/turn-journal-platform.test.mjs",
        "tests/unit/project-store-resolver.test.mjs"
      ]
    },
    {
      "id": "lossless-lifecycle-retention",
      "reason": "Evidence compaction preserves tokens, private state and atomic transaction recovery",
      "files": [
        "tests/unit/lifecycle-evidence-retention.test.mjs",
        "tests/unit/update-storage-transaction.test.mjs"
      ]
    },
    {
      "id": "causal-learning-proof",
      "reason": "Recorded learning evidence rejects forged, absent and mismatched causal transcripts",
      "files": [
        "tests/unit/learning-replay-proof.test.mjs"
      ]
    },
    {
      "id": "qualification-topology",
      "reason": "Release promotion consumes qualified exact-source receipts and preserves required contexts",
      "files": [
        "tests/unit/qualify-once-workflow.test.mjs"
      ]
    },
    {
      "id": "managed-memory-test-safety",
      "reason": "Only managed project memory is accessed and tests cannot target owner stores",
      "files": [
        "tests/unit/no-real-store-path-in-tests.test.mjs",
        "tests/unit/managed-memory-no-raw-sql.test.mjs"
      ]
    },
    {
      "id": "citation-producer-boundaries",
      "reason": "Actual CLI, card and MCP outputs reject document-injected citation headers; packed verifier and source mutants bind the changed boundary",
      "files": [
        "tests/unit/verify-citation.test.mjs",
        "tests/unit/citation-producers.test.mjs",
        "tests/mutation/citation-binding-mutation.test.mjs"
      ]
    },
    {
      "id": "pending-memory-durability",
      "reason": "Complete outbox tails replay and accepted pending journal events survive capacity pressure without silent deletion",
      "files": [
        "tests/unit/project-progression-outbox.test.mjs",
        "tests/unit/project-progression-durability.test.mjs"
      ]
    }
  ],
  "integration": [
    {
      "id": "native-explicit-interface",
      "reason": "Real MCP subprocess readiness, command policy and literal argv safety",
      "files": [
        "tests/integration/managed-cli-mcp.test.mjs"
      ]
    },
    {
      "id": "private-bundle-boundary",
      "reason": "Actual bundle builder rejects absent private fence and incomplete public payloads",
      "files": [
        "tests/integration/build-bundle-fence.test.mjs"
      ]
    },
    {
      "id": "native-codex-discovery",
      "reason": "Actual Codex plugin discovery and repair preserve explicit disabled state",
      "files": [
        "tests/integration/codex-skill-discovery.test.mjs"
      ]
    },
    {
      "id": "owned-uninstall",
      "reason": "Actual offline uninstall preserves unrelated files and user guidance",
      "files": [
        "tests/integration/uninstall-footprint.test.mjs"
      ]
    },
    {
      "id": "canonical-memory-native-boundary",
      "reason": "POSIX registered recall and capture use canonical project stores; global Ruflo prerequisites and real-process privacy/readback probes fail closed",
      "files": [
        "tests/unit/agentdb-recall.test.mjs",
        "tests/unit/session-start-core-parity.test.mjs",
        "tests/unit/learning-replay.test.mjs",
        "tests/integration/continuity-journal.test.mjs",
        "tests/integration/changed-memory-process-probes.test.mjs",
        "tests/unit/managed-memory-boundary.test.mjs"
      ]
    },
    {
      "id": "automatic-memory-transition-durability",
      "reason": "Reviewed POSIX automatic boundary capture, complete history, consent suspension, first-start recovery and data-only turn replay; real global Ruflo and filesystem prerequisites are required",
      "files": [
        "tests/unit/project-transition-hook.test.mjs",
        "tests/unit/turn-transport-security.test.mjs",
        "tests/unit/turn-durable-transport.test.mjs",
        "tests/integration/automatic-progression-continuation.test.mjs",
        "tests/integration/capture-consent-boundary.test.mjs",
        "tests/integration/session-start-turn-replay.test.mjs"
      ]
    },
    {
      "id": "pending-continuity-capacity",
      "reason": "POSIX non-root permission refusal, capacity-pressure reporting and recovery preserve all accepted pending continuity events",
      "files": [
        "tests/unit/continuity-journal-bounds.test.mjs"
      ]
    }
  ]
});
