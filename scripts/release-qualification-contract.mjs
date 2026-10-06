// Reviewed stabilization release boundaries. Legacy tests remain developer diagnostics.
export const RELEASE_REQUIREMENTS = Object.freeze({
  "source": [
    {
      "id": "installer-release-argument-safety",
      "reason": "Incomplete named releases refuse before network or settings writes; valid named releases and installer help retain their contracts",
      "files": ["tests/unit/install-release-fallback.test.mjs"]
    },
    {
      "id": "honest-currency-lesson-and-metrics-evidence",
      "reason": "Foreign KB roots remain isolated; panel currency derives from measured completion rather than checkout time; exact lesson readback binds this shell-free write; public metrics never fabricate performance or a competing product score",
      "files": ["tests/unit/forge-currency-selected-root.test.mjs", "tests/unit/brain-score-producer.test.mjs", "tests/unit/brain-grade-groundtruth-timestamp.test.mjs", "tests/unit/record-lesson.test.mjs", "tests/unit/lesson-presentation-budget.test.mjs", "tests/unit/metrics-truth.test.mjs", "tests/unit/issue-watch-retry.test.mjs"]
    },
    {
      "id": "automatic-update-source-and-transport",
      "reason": "Captured owner policy never falls back on read failures; installed-only automation avoids npx; transient GET and body failures retry without weakening trust; POSIX executable aliases retain interpreter identity",
      "files": ["tests/unit/automatic-update.test.mjs", "tests/unit/download-retry.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/automatic-update-node-alias.test.mjs"],
        "macos": ["tests/unit/automatic-update-node-alias.test.mjs"]
      }
    },
    {
      "id": "customer-scope-and-session-ownership",
      "reason": "Captured assistant commitments retain their actual session owner and honest noncompleted states; scoped grounding retains strict conservative evidence under contention; legacy guidance never suppresses a tool call",
      "files": ["tests/unit/continuation-commitment-ownership.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/grounding-scope.test.mjs", "tests/unit/hijack-no-defer.test.mjs"],
        "macos": ["tests/unit/grounding-scope.test.mjs", "tests/unit/hijack-no-defer.test.mjs"]
      }
    },
    {
      "id": "bounded-advocacy-and-write-grounding",
      "reason": "Explicit document meaning requests retain corroboration; literal searches stay silent; POSIX complete-write exemptions preserve executable and managed-store grounding",
      "files": ["tests/unit/advocacy-route.test.mjs", "tests/unit/advocacy-catalog.test.mjs", "tests/unit/card-lane.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/advocacy-route-budget.test.mjs", "tests/unit/ground-before-write.test.mjs", "tests/unit/grounding-code-projection.test.mjs"],
        "macos": ["tests/unit/advocacy-route-budget.test.mjs", "tests/unit/ground-before-write.test.mjs", "tests/unit/grounding-code-projection.test.mjs"]
      }
    },
    {
      "id": "owned-startup-execution-evidence",
      "reason": "Opt-in native execution and private stage diagnostics bind released source and preserve unknown convergence and incomplete cleanup boundaries",
      "files": ["tests/unit/codex-host-execution-proof.test.mjs", "tests/unit/codex-host-proof-runtime.test.mjs", "tests/unit/session-start-proof.test.mjs"]
    },
    {
      "id": "canonical-learning-capture",
      "reason": "Fixed metadata capture, canonical scope, consent, acknowledgement and bounded owned recovery retain privacy and originals",
      "files": [
        "tests/unit/learn-flush-partial-failure.test.mjs",
        "tests/unit/learn-capture-project-root.test.mjs",
        "tests/unit/learn-capture-redaction.test.mjs",
        "tests/unit/learner-scope-agreement.test.mjs",
        "tests/unit/health-repair-flush-learning.test.mjs",
        "tests/unit/learning-worker-supervisor.test.mjs"
      ]
    },
    {
      "id": "fresh-owned-host-proof",
      "reason": "Source-bound native registry declarations reject warnings, trust changes and unretired owned processes",
      "files": ["tests/unit/codex-fresh-host-proof.test.mjs"]
    },
    {
      "id": "complete-progression-validation",
      "reason": "Canonical digest validation retains full-history and serialization semantics",
      "files": ["tests/unit/project-progression-contract.test.mjs"]
    },
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
        "tests/unit/release-transaction-provider-buffer.test.mjs",
        "tests/unit/prepublication-evidence.test.mjs",
        "tests/unit/candidate-host-evidence.test.mjs",
        "tests/unit/host-install-matrix-concurrency.test.mjs",
        "tests/unit/integration-evidence.test.mjs",
        "tests/unit/qualified-candidate-check.test.mjs",
        "tests/unit/release-qualification.test.mjs",
        "tests/unit/development-push-boundary.test.mjs",
        "tests/unit/protected-release-workflow.test.mjs",
        "tests/unit/agentic-qe-early-public.test.mjs",
        "tests/unit/release-evidence-dag.test.mjs"
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
        "tests/unit/forge-update-apply-rollback.test.mjs",
        "tests/unit/forge-update-archive-digest.test.mjs",
        "tests/unit/kb-copy-proof-legacy-sidecars.test.mjs",
        "tests/unit/kb-copy-proof-unknown-content.test.mjs",
        "tests/unit/user-model-hook-install.test.mjs"
      ]
    },
    {
      "id": "approved-native-routing",
      "reason": "Current owner allocations, classification floors, native model and effort support, subscription auth and ordinary allowance gate actual stdin dispatch without expanding spend",
      "files": [
        "tests/unit/model-router-engine.test.mjs",
        "tests/unit/model-router-enforcement.test.mjs",
        "tests/unit/native-subscription-usage.test.mjs",
        "tests/unit/model-router-agent-hook.test.mjs"
      ]
    },
    {
      "id": "same-session-native-transport",
      "reason": "Codex and Claude preserve atomic terminal pastes, fresh manual consent, context, UTF-8, control progress, cancellation and deferred FIFO while binding each new turn to an approved native route",
      "files": [
        "tests/unit/managed-terminal-input.test.mjs",
        "tests/unit/model-routing-gateway.test.mjs",
        "tests/unit/model-routing-gateway-boundaries.test.mjs",
        "tests/unit/claude-terminal-mod.test.mjs",
        "tests/unit/model-routing-launchers.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/model-terminal-gateway.test.mjs", "tests/unit/model-terminal-launchers.test.mjs", "tests/unit/claude-controlled-terminal.test.mjs"],
        "macos": ["tests/unit/model-terminal-gateway.test.mjs", "tests/unit/model-terminal-launchers.test.mjs", "tests/unit/claude-controlled-terminal.test.mjs"],
        "windows": ["tests/unit/windows-terminal-boundary.test.mjs"]
      }
    },
    {
      "id": "managed-native-workflow",
      "reason": "Automatic prompt mediation preserves parent context and canonical memory, enforces observed model and effort, bounded DAG execution, exact ownership, actual acceptance and independent review without unsafe replay",
      "files": [
        "tests/unit/model-routing-controller.test.mjs",
        "tests/unit/model-routing-execution-adapters.test.mjs",
        "tests/unit/model-managed-workflow-service.test.mjs",
        "tests/unit/model-managed-prompt.test.mjs",
        "tests/unit/model-routing-defence.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/model-terminal-canonical-entry.test.mjs", "tests/unit/codex-managed-terminal.test.mjs", "tests/unit/grok-subscription-host.test.mjs", "tests/unit/model-managed-parent-context-posix.test.mjs", "tests/unit/automatic-hook-retirement-posix.test.mjs"],
        "macos": ["tests/unit/model-terminal-canonical-entry.test.mjs", "tests/unit/codex-managed-terminal.test.mjs", "tests/unit/grok-subscription-host.test.mjs", "tests/unit/model-managed-parent-context-posix.test.mjs", "tests/unit/automatic-hook-retirement-posix.test.mjs"]
      }
    },
    {
      "id": "weekly-routing-evidence",
      "reason": "Weekly native dispatch requires allowance and trusted tool denial; bounded completions, source fencing and qualified promotion preserve original owner approval and reject requested-only identity",
      "files": [
        "tests/unit/model-weekly-assessment.test.mjs",
        "tests/unit/model-weekly-analyst.test.mjs",
        "tests/unit/model-weekly-cycle.test.mjs",
        "tests/unit/model-weekly-qualification.test.mjs",
        "tests/unit/model-native-qualification.test.mjs",
        "tests/unit/model-native-catalog.test.mjs",
        "tests/unit/user-model-prompt-hook.test.mjs",
        "tests/unit/model-routing-policy-promotion.test.mjs",
        "tests/unit/codex-hook-trust.test.mjs"
      ]
    },
    {
      "id": "native-scheduler",
      "reason": "Owned scheduler lifecycle, execution identity, measured no-op and signed installed coverage",
      "files": [
        "tests/unit/nightly-scheduler.test.mjs",
        "tests/unit/nightly-refresh-launcher.test.mjs",
        "tests/unit/nightly-two-run-proof.test.mjs",
        "tests/unit/nightly-refresh-run-health.test.mjs"
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
      "reason": "Canonical project isolation, persisted consent, excluded-resource privacy before recording, immutable delivery refusal and truthful terminal failure status",
      "files": [
        "tests/unit/turn-outcome-capture.test.mjs",
        "tests/unit/turn-capture-content-privacy.test.mjs",
        "tests/integration/project-progression-hook.test.mjs",
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
        "tests/unit/qualify-once-workflow.test.mjs",
        "tests/unit/architecture-review-lock.test.mjs"
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
  "id": "owner-capture-and-off-controls",
  "reason": "Brain OFF suppresses capacity execution; promise opt-out suppresses only new capture and preserves existing closure and capability truth",
  "files": [
    "tests/unit/capacity-aware-parallel-work.test.mjs",
    "tests/unit/continuation-gate-capability-truth.test.mjs",
    "tests/unit/continuation-gate-completion-claims.test.mjs",
    "tests/unit/continuation-gate-objective-close.test.mjs",
    "tests/unit/continuation-objective.test.mjs",
    "tests/unit/continuation-gate.test.mjs"
  ],
  "platformFiles": {
    "linux": [
      "tests/unit/hook-shim.test.mjs"
    ],
    "macos": [
      "tests/unit/hook-shim.test.mjs"
    ]
  }
},
    {
      "id": "active-managed-generation",
      "reason": "Active code selection binds help authorization and execution to one immutable leased generation across promotion",
      "files": [
        "tests/unit/managed-cli-generation.test.mjs"
      ]
    },
    {
      "id": "pending-memory-durability",
      "reason": "Complete outbox tails replay and accepted pending journal events survive capacity pressure without silent deletion",
      "files": [
        "tests/unit/project-progression-outbox.test.mjs",
        "tests/unit/project-progression-durability.test.mjs",
        "tests/unit/continuity-customer-regressions.test.mjs",
        "tests/unit/progression-outbox-containment.test.mjs",
        "tests/unit/transition-pending-notices.test.mjs"
      ]
    }
  ],
  "integration": [
    {
      "id": "managed-checker-kernel-boundary",
      "reason": "Native read-only sandbox denies acceptance-script writes outside the authorized project",
      "files": [],
      "platformFiles": {
        "linux": ["tests/integration/model-managed-checker-native.test.mjs"],
        "macos": ["tests/integration/model-managed-checker-native.test.mjs"]
      }
    },
    {
      "id": "canonical-learning-recovery",
      "reason": "Cross-session recovery and Console evidence agree on the same canonical scope without ratifying tool metadata as instructions",
      "files": ["tests/integration/learning-recovery-377.test.mjs", "tests/integration/learning-console-scope.test.mjs"]
    },
    {
      "id": "canonical-progression-store",
      "reason": "Actual adopted canonical storage, exact readback, and concurrent session restoration retain consent and complete history",
      "files": ["tests/integration/project-progression-concurrent-sessions.test.mjs", "tests/integration/project-progression-reader-identity.test.mjs"],
      "platformFiles": {
        "linux": ["tests/integration/project-progression-store.test.mjs"],
        "macos": ["tests/integration/project-progression-store.test.mjs"]
      }
    },
    {
      "id": "native-explicit-interface",
      "reason": "Real MCP subprocess readiness, command policy and literal argv safety",
      "files": [
        "tests/integration/managed-cli-mcp.test.mjs",
        "tests/integration/managed-cli-server-boundary.test.mjs"
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
      "id": "installed-routing-and-hook-trust",
      "reason": "Actual installer update converges managed routing while preserving private overrides; POSIX archive and native metadata subprocess probes bind authorized hook trust to verified released bytes and preserve concurrent or disabled owner state",
      "files": [
        "tests/unit/model-router-update-convergence.test.mjs",
        "tests/unit/codex-hook-trust-reconcile.test.mjs"
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
      "reason": "Actual offline uninstall and POSIX copy-cleanup callers preserve unrelated files, changed unknown bytes and private state",
      "files": [
        "tests/integration/uninstall-footprint.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/brain-footprint.test.mjs"],
        "macos": ["tests/unit/brain-footprint.test.mjs"]
      }
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
        "tests/integration/session-start-turn-replay.test.mjs",
        "tests/integration/progression-suspension.test.mjs"
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
