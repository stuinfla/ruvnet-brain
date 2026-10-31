// Reviewed stabilization release boundaries. Legacy tests remain developer diagnostics.
export const RELEASE_REQUIREMENTS = Object.freeze({
  "source": [
    {
      "id": "console-click-receipts",
      "reason": "A click's verdict is derived from two reads of the machine, never from the endpoint's own ok: success with nothing changed is unverified, unknown is never blank or zero, the history is bounded and newest first, and a small real size never prints as 0 MB",
      "files": ["tests/unit/console-receipts.test.mjs"]
    },
    {
      "id": "public-admin-release-and-engineering-status",
      "reason": "Latest code release stays separate from corpus identity; issue and pull-request pagination preserves the complete engineering queue and failed probes remain unknown without inventing owner action",
      "files": ["tests/unit/explainer-api.test.mjs", "tests/unit/admin-render.test.mjs"]
    },
    {
      "id": "source-bound-installed-update-coordinator",
      "reason": "Allowed channels and immutable Claude artifact paths reject downgrades, ambiguous registry records, changed bytes, extra active resources and escape paths; Console success requires the exact launched source closure. POSIX owner fixtures additionally enforce original-prefix installs, existing-tool-only policy, shared locks and source-bound scheduler receipts",
      "files": ["tests/unit/developer-update-policy-portable.test.mjs", "tests/unit/plugin-artifact-proof.test.mjs", "tests/unit/console-suite-update.test.mjs", "tests/unit/developer-update-scheduled-receipt.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/developer-update.test.mjs", "tests/unit/developer-update-codex-launcher.test.mjs", "tests/unit/developer-update-lock-reclaim.test.mjs", "tests/unit/developer-update-lock-release-race.test.mjs", "tests/unit/developer-update-stage-isolation.test.mjs"],
        "macos": ["tests/unit/developer-update.test.mjs", "tests/unit/developer-update-codex-launcher.test.mjs", "tests/unit/developer-update-lock-reclaim.test.mjs", "tests/unit/developer-update-lock-release-race.test.mjs", "tests/unit/developer-update-stage-isolation.test.mjs"]
      }
    },
    {
      "id": "installer-release-argument-safety",
      "reason": "Incomplete named releases refuse before network or settings writes; valid named releases and installer help retain their contracts",
      "files": ["tests/unit/install-release-fallback.test.mjs"]
    },
    {
      "id": "honest-currency-lesson-and-metrics-evidence",
      "reason": "Foreign KB roots remain isolated; panel currency derives from measured completion rather than checkout time; exact lesson readback binds this shell-free write; public metrics never fabricate performance or a competing product score; SessionStart reports a host-sync-only failure after a passed knowledge update separately from knowledge currency",
      "files": ["tests/unit/forge-currency-selected-root.test.mjs", "tests/unit/brain-score-producer.test.mjs", "tests/unit/brain-grade-groundtruth-timestamp.test.mjs", "tests/unit/record-lesson.test.mjs", "tests/unit/lesson-presentation-budget.test.mjs", "tests/unit/metrics-truth.test.mjs", "tests/unit/issue-watch-retry.test.mjs", "tests/unit/session-start-knowledge-currency.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/session-start-knowledge-auto-update.test.mjs", "tests/unit/claims-verify.test.mjs", "tests/unit/capability-registry.test.mjs"],
        "macos": ["tests/unit/session-start-knowledge-auto-update.test.mjs", "tests/unit/claims-verify.test.mjs", "tests/unit/capability-registry.test.mjs"]
      }
    },
    {
      "id": "owner-alerting-volume-and-trust",
      "reason": "Alerts page on change, not repeat; an undelivered page is retried; overrunning jobs and their whole process tree stop; people's issues page once at SLA with one daily summary; the ntfy inbox never turns message text into instructions",
      "files": ["tests/unit/issue-watch-paging.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/job-heartbeat-alerting.test.mjs", "tests/unit/ntfy-inbox.test.mjs", "tests/unit/brain-alarm-paging.test.mjs", "tests/unit/ntfy-alerts-filter.test.mjs", "tests/unit/api-spend-watchdog-transition.test.mjs", "tests/unit/issue-watch-unreadable-exit.test.mjs", "tests/unit/nightly-watchdog.test.mjs", "tests/unit/ntfy-delivery.test.mjs"],
        "macos": ["tests/unit/job-heartbeat-alerting.test.mjs", "tests/unit/ntfy-inbox.test.mjs", "tests/unit/brain-alarm-paging.test.mjs", "tests/unit/ntfy-alerts-filter.test.mjs", "tests/unit/api-spend-watchdog-transition.test.mjs", "tests/unit/issue-watch-unreadable-exit.test.mjs", "tests/unit/nightly-watchdog.test.mjs", "tests/unit/ntfy-delivery.test.mjs"]
      }
    },
    {
      "id": "automatic-update-source-and-transport",
      "reason": "Captured owner policy never falls back on read failures; installed-only automation avoids npx; transient GET and body failures retry without weakening trust; POSIX executable aliases retain interpreter identity",
      "files": ["tests/unit/automatic-update.test.mjs", "tests/unit/download-retry.test.mjs"],
      "platformFiles": {
        "linux": ["tests/unit/automatic-update-node-alias.test.mjs", "tests/unit/host-update-knowledge-exit.test.mjs"],
        "macos": ["tests/unit/automatic-update-node-alias.test.mjs", "tests/unit/host-update-knowledge-exit.test.mjs"]
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
        "linux": ["tests/unit/advocacy-route-budget.test.mjs", "tests/unit/ground-before-write.test.mjs", "tests/unit/grounding-code-projection.test.mjs", "tests/unit/package-recommender.test.mjs", "tests/unit/write-gate-policy.test.mjs"],
        "macos": ["tests/unit/advocacy-route-budget.test.mjs", "tests/unit/ground-before-write.test.mjs", "tests/unit/grounding-code-projection.test.mjs", "tests/unit/package-recommender.test.mjs"]
      }
    },
    {
      "id": "owned-startup-execution-evidence",
      "reason": "Opt-in native execution and private stage diagnostics bind released source and preserve unknown convergence and incomplete cleanup boundaries",
      "files": ["tests/unit/codex-host-execution-proof.test.mjs", "tests/unit/codex-host-proof-runtime.test.mjs", "tests/unit/session-start-proof.test.mjs"]
    },
    {
      "id": "canonical-learning-capture",
      "reason": "Fixed metadata capture, canonical scope, consent, exact readback and loud refusal retain privacy; learning is handed straight to ruflo memory store with no local queue; the SessionEnd checkpoint plans for Claude Code's real 1.5 s budget and detaches instead of being cancelled",
      "files": [
        "tests/unit/learn-capture-project-root.test.mjs",
        "tests/unit/learn-capture-redaction.test.mjs",
        "tests/unit/learner-scope-agreement.test.mjs",
        "tests/unit/claude-session-end-budget.test.mjs"
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
      "files": []
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
      ],
      "platformFiles": {
        "linux": ["tests/unit/self-update-publish-branch-guard.test.mjs", "tests/unit/pre-push-worktree-root.test.mjs", "tests/unit/wired-baseline-classification.test.mjs"],
        "macos": ["tests/unit/self-update-publish-branch-guard.test.mjs", "tests/unit/pre-push-worktree-root.test.mjs", "tests/unit/wired-baseline-classification.test.mjs"]
      }
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
      "reason": "Installation and update preserve prior and private state and reject invalid dependencies; the Codex hook bridge a retained Brain generation shipped upgrades reversibly while edited, linked, shared or foreign-owned bridges stay preserved; a failed host sync rolls the Console runtime back and records its reason",
      "files": [
        "tests/unit/automatic-hook-retirement.test.mjs",
        "tests/unit/codex-wrapper-upgrade-ownership.test.mjs",
        "tests/unit/install-activation-rollback.test.mjs",
        "tests/unit/forge-update-apply-rollback.test.mjs",
        "tests/unit/forge-update-archive-digest.test.mjs",
        "tests/unit/kb-copy-proof-legacy-sidecars.test.mjs",
        "tests/unit/kb-copy-proof-unknown-content.test.mjs",
        "tests/unit/user-model-hook-install.test.mjs",
        "tests/unit/console-runtime-transaction.test.mjs",
        "tests/unit/install-update-exit-semantics.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/codex-wrapper-upgrade-ownership-links.test.mjs", "tests/unit/forge-update-signal.test.mjs", "tests/unit/console-runtime-replacement-posix.test.mjs", "tests/unit/update-apply-lock-identity.test.mjs", "tests/unit/update-apply-lock-takeover-race.test.mjs", "tests/integration/install-update-signals.test.mjs", "tests/unit/forge-guard-injection-log-location.test.mjs", "tests/unit/installer-sibling-imports-packaged.test.mjs", "tests/unit/npm-pack-json.test.mjs", "tests/unit/npm-tarball-codex.test.mjs", "tests/integration/pack-completeness.test.mjs"],
        "macos": ["tests/unit/codex-wrapper-upgrade-ownership-links.test.mjs", "tests/unit/forge-update-signal.test.mjs", "tests/unit/console-runtime-replacement-posix.test.mjs", "tests/unit/update-apply-lock-identity.test.mjs", "tests/unit/update-apply-lock-takeover-race.test.mjs", "tests/integration/install-update-signals.test.mjs", "tests/unit/forge-guard-injection-log-location.test.mjs", "tests/unit/installer-sibling-imports-packaged.test.mjs", "tests/unit/npm-pack-json.test.mjs", "tests/unit/npm-tarball-codex.test.mjs", "tests/integration/pack-completeness.test.mjs", "tests/unit/spend-guard-install.test.mjs"]
      }
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
        "tests/unit/codex-hook-trust.test.mjs",
        "tests/unit/model-catalog-refresh-workflow.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/model-weekly-cycle-native-stub.test.mjs", "tests/unit/goldie-weekly-path.test.mjs", "tests/unit/model-currency-live-capture.test.mjs"],
        "macos": ["tests/unit/model-weekly-cycle-native-stub.test.mjs", "tests/unit/goldie-weekly-path.test.mjs", "tests/unit/model-currency-live-capture.test.mjs"]
      }
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
        "tests/unit/project-store-resolver.test.mjs"
      ]
    },
    {
      "id": "ruflo-runs-under-a-node-that-loads-its-binding",
      "reason": "Hooks inherit whatever node is first on their PATH; every direct ruflo launch (turn and learning capture, the SessionEnd/PreCompact checkpoint writer, the SessionStart memory reader and the recall reader) runs ruflo under the first node that can load its own better-sqlite3 within a bounded probe (a healthy machine is untouched, and no candidate means no change), so a native memory write is not refused for a node-ABI mismatch",
      "files": [],
      "platformFiles": {
        "linux": ["tests/unit/ruflo-native-node.test.mjs"],
        "macos": ["tests/unit/ruflo-native-node.test.mjs"]
      }
    },
    {
      "id": "lossless-lifecycle-retention",
      "reason": "Evidence compaction preserves tokens, private state and atomic transaction recovery; an abandoned atomic receipt temporary is reclaimed or preserved, never a permanent blocker",
      "files": [
        "tests/unit/lifecycle-evidence-retention.test.mjs",
        "tests/unit/refresh-run.test.mjs",
        "tests/unit/refresh-run-stale-reclaim.test.mjs",
        "tests/unit/update-storage-transaction.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/refresh-run-takeover-race.test.mjs"],
        "macos": ["tests/unit/refresh-run-takeover-race.test.mjs"]
      }
    },
    {
      "id": "nightly-knowledge-jobs",
      "reason": "The gists nightly re-embeds over a stale store, scales its stall budget with the slowest batch and reports its error paths; a stalled shard is detected; a reader never deadlocks the refresh",
      "files": ["tests/unit/forge-big-stall.test.mjs"],
      "platformFiles": {
        "linux": ["tests/integration/ingest-gists.test.mjs", "tests/integration/nightly-gists-error-paths.test.mjs"],
        "macos": ["tests/integration/ingest-gists.test.mjs", "tests/integration/nightly-gists-error-paths.test.mjs"]
      }
    },
    {
      "id": "causal-learning-proof",
      "reason": "Recorded learning evidence rejects forged, absent and mismatched causal transcripts",
      "files": [
        "tests/unit/learning-replay-proof.test.mjs"
      ],
      "platformFiles": {
        "linux": ["tests/unit/learning-replay-workflow-step.test.mjs"],
        "macos": ["tests/unit/learning-replay-workflow-step.test.mjs"]
      }
    },
    {
      "id": "qualification-topology",
      "reason": "Release promotion consumes qualified exact-source receipts and preserves required contexts",
      "files": [
        "tests/unit/qualify-once-workflow.test.mjs",
        "tests/unit/architecture-review-lock.test.mjs",
        "tests/unit/canonical-qa-preflight-parity.test.mjs"
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
      "tests/unit/hook-shim.test.mjs",
      "tests/unit/continuation-gate-quiet-default.test.mjs"
    ],
    "macos": [
      "tests/unit/hook-shim.test.mjs",
      "tests/unit/continuation-gate-quiet-default.test.mjs",
      "tests/unit/hook-qualify.test.mjs"
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
      ]
    },
    {
      "id": "open-issue-fixes-4-7-22",
      "reason": "Reporter-filed defects stay fixed: completion evidence never binds a masked or negated check and a masked check is an advisory, not a false 'no check ran' stop; the boot surface of a recovered Codex host is proven per changed path; Console fleet and lesson counts match by store identity and never show unknown as zero; one project-scope rule is shared by the lesson gate and the Console; a refused or unreadable memory restore is reported as such and an aborted Ruflo call leaves no child process",
      "files": [],
      "platformFiles": {
        "linux": ["tests/unit/continuation-gate-codex-transcript.test.mjs", "tests/unit/codex-boot-surface-proof.test.mjs", "tests/unit/console-activity-fleet-dedupe.test.mjs", "tests/unit/console-activity-identity.test.mjs", "tests/unit/console-activity-lessons.test.mjs", "tests/unit/lesson-gate.test.mjs", "tests/unit/ruflo-memory-session.test.mjs"],
        "macos": ["tests/unit/continuation-gate-codex-transcript.test.mjs", "tests/unit/codex-boot-surface-proof.test.mjs", "tests/unit/console-activity-fleet-dedupe.test.mjs", "tests/unit/console-activity-identity.test.mjs", "tests/unit/console-activity-lessons.test.mjs", "tests/unit/lesson-gate.test.mjs", "tests/unit/ruflo-memory-session.test.mjs"]
      }
    },
    {
      "id": "open-issue-fixes-4-7-24",
      "reason": "A storage transaction stuck at RECOVERY_REQUIRED has a supported way out: a read-only preview, then an explicit keep-live disposition bound to the live tree's exact sha256 that moves every other tree intact and records a terminal DISPOSED receipt (#335); a detached learning capture is acknowledged only after its exact readback, so a refused store is retried instead of being coalesced away for ten minutes (#377). Windows is not verified",
      "files": [],
      "platformFiles": {
        "linux": ["tests/unit/update-recovery-disposition.test.mjs", "tests/unit/learn-capture-ack-after-readback.test.mjs"],
        "macos": ["tests/unit/update-recovery-disposition.test.mjs", "tests/unit/learn-capture-ack-after-readback.test.mjs"]
      }
    },
    {
      "id": "nightly-converges-4-7-25",
      "reason": "The scheduled nightly converges or says why (ADR-104 4.7.25): a CURRENT corpus still runs the installer when the runtime or a host is behind the installed package, an installer exit 0 that leaves it behind is a failure, a failed knowledge stage is retried once the same night, a night that ends not-ok pages through scripts/notify.sh and the next good one pages recovered, the failure carries the installer's own lines, and Codex plugin commands get the catalog-refresh limit. Paging needs a POSIX shell, so Windows is not verified",
      "files": [],
      "platformFiles": {
        "linux": ["tests/unit/nightly-self-retry-and-page.test.mjs"],
        "macos": ["tests/unit/nightly-self-retry-and-page.test.mjs"]
      }
    },
    {
      "id": "issue-autofix-bounded-writer",
      "reason": "The unattended issue fixer (ADR-107) stays inside its authority: kill switch, single-writer lock, deny-by-default editable paths, the static malware and secret scan, the manifest/lockfile/pack/audit night gate, the red-team judge, restricted tool-less LLM stages, the macOS sandbox for model-written code (macOS only), never-weakened tests, independent verifier, resumable never-doubled release steps, no force or merge, owner-marker-prefixed comments, personal notes that are never boilerplate or repeated, and a registry and LaunchAgent that match. It runs on the owner's macOS launchd, so it is qualified on macOS and Linux only, the same scope as the ntfy inbox reader",
      "files": [],
      "platformFiles": {
        "linux": ["tests/unit/issue-autofix-policy.test.mjs", "tests/unit/issue-autofix-agents.test.mjs", "tests/unit/issue-autofix-release.test.mjs", "tests/unit/issue-autofix-release-ship.test.mjs", "tests/unit/issue-autofix-comment.test.mjs", "tests/unit/issue-autofix-deploy.test.mjs", "tests/unit/issue-autofix-security.test.mjs", "tests/unit/issue-autofix-notes.test.mjs", "tests/unit/issue-autofix-gate.test.mjs", "tests/unit/issue-autofix-night.test.mjs"],
        "macos": ["tests/unit/issue-autofix-policy.test.mjs", "tests/unit/issue-autofix-agents.test.mjs", "tests/unit/issue-autofix-release.test.mjs", "tests/unit/issue-autofix-release-ship.test.mjs", "tests/unit/issue-autofix-comment.test.mjs", "tests/unit/issue-autofix-deploy.test.mjs", "tests/unit/issue-autofix-security.test.mjs", "tests/unit/issue-autofix-notes.test.mjs", "tests/unit/issue-autofix-gate.test.mjs", "tests/unit/issue-autofix-night.test.mjs", "tests/unit/issue-autofix-sandbox.test.mjs"]
      }
    }
  ],
  "integration": [
    {
      "id": "console-click-receipts-interface",
      "reason": "The actual Console server answers every mutating click with a receipt whose before and after are re-reads of the machine, derives changed/no-change/failed from them, keeps the history across repaints and reloads, marks a spent undo, and records nothing for a forged token",
      "files": ["tests/integration/console-receipts-endpoint.test.mjs"]
    },
    {
      "id": "authenticated-update-coordinator-interface",
      "reason": "The actual Console server reports unrun status without policy writes, rejects absent tokens, cross-origin requests and invalid policies, and refuses a second updater while the shared lock is owned",
      "files": ["tests/integration/console-suite-update-endpoint.test.mjs"]
    },
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
      "reason": "Retired 2026-10-12: the learning queue, flush worker and Console queue recovery were deleted (owner ruling: hooks only call rUv's memory tools); learning writes are covered by canonical-learning-capture",
      "files": []
    },
    {
      "id": "release-prepush-shift-left",
      "reason": "The explicit release pre-push gate collects every failure with per-check timing, reads the newest corpus generation's public census over HTTP Range (refusing zip64, unknown compression and CRC mismatch), names each stale claim surface with its old and new number, refuses stray added artifacts with anchored patterns, selects text-anchored tests for changed source, and before dispatch requires the preflight's sealed generation to still be the newest",
      "files": ["tests/unit/release-prepush.test.mjs", "tests/unit/generation-census.test.mjs"]
    },
    {
      "id": "canonical-progression-store",
      "reason": "Actual adopted canonical storage, exact readback, and concurrent session restoration retain consent and complete history",
      "files": [],
      "platformFiles": {
        "linux": [],
        "macos": []
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
      "reason": "Actual installer update converges managed routing while preserving private overrides; POSIX archive and native metadata subprocess probes bind authorized hook trust to verified released bytes and preserve concurrent or disabled owner state; a running shared Codex app-server is reloaded after a plugin or trust change without granting approval (#492)",
      "files": [
        "tests/unit/model-router-update-convergence.test.mjs",
        "tests/unit/codex-hook-trust-reconcile.test.mjs",
        "tests/unit/codex-shared-host-refresh.test.mjs"
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
        "tests/integration/changed-memory-process-probes.test.mjs",
        "tests/unit/managed-memory-boundary.test.mjs"
      ]
    },
    {
      "id": "automatic-memory-transition-durability",
      "reason": "Reviewed POSIX automatic boundary capture, complete history, consent suspension, first-start recovery and data-only turn replay; real global Ruflo and filesystem prerequisites are required",
      "files": [
        "tests/integration/capture-consent-boundary.test.mjs"
      ]
    },
    {
      "id": "pending-continuity-capacity",
      "reason": "POSIX non-root permission refusal, capacity-pressure reporting and recovery preserve all accepted pending continuity events",
      "files": [
      ]
    },
    {
      "id": "open-issue-fixes-4-7-22-integration",
      "reason": "A named release over an existing install moves, skips truthfully or warns on a downgrade instead of reporting a false lookup failure; the Ruflo memory hooks honour the absolute deadline and abort, kill the whole child process group, and never report a refused or partly unreadable restore as restored",
      "files": [],
      "platformFiles": {
        "linux": ["tests/integration/stale-install-trap.test.mjs", "tests/integration/ruflo-memory-hooks.test.mjs"],
        "macos": ["tests/integration/stale-install-trap.test.mjs", "tests/integration/ruflo-memory-hooks.test.mjs"]
      }
    },
    {
      "id": "issue-autofix-simulated-end-to-end",
      "reason": "The whole autofix night (select, AIDefence screen, plan, build, scan, sandboxed test validity, red-team, verify, one batched release, push, pull request, fast-forward, dispatch, terminal check, one personal note per person) runs against a file:// origin with a fake gh and fake claude; hostile fixes (obfuscated payload, new dependency, off-allowlist edit, red-team flag, new audit advisory) never ship, one failing fix never blocks the others, a dropped connection or the kill switch pauses and the next run resumes without a second push or dispatch, and only a red after main moved halts. macOS and Linux only (the job is the owner's launchd tool)",
      "files": [],
      "platformFiles": {
        "linux": ["tests/integration/issue-autofix-simulate.test.mjs", "tests/integration/issue-autofix-simulate-night.test.mjs"],
        "macos": ["tests/integration/issue-autofix-simulate.test.mjs", "tests/integration/issue-autofix-simulate-night.test.mjs"]
      }
    }
  ]
});
