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
        "tests/unit/integration-evidence.test.mjs",
        "tests/unit/qualified-candidate-check.test.mjs",
        "tests/unit/release-qualification.test.mjs",
        "tests/unit/development-push-boundary.test.mjs"
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
    }
  ]
});
