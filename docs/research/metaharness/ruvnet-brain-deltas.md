# RuvNet-Brain deltas — always-running MetaHarness coding service

Updated: 2026-09-17 | Version 1.0.1

**Status:** research only; no service, harness, cloud resource, or deployment has been created.
**Written:** 2026-07-17
**Companion to:**
- `ruv-gist-meta-wrapper.md` — rUv's research. **That document IS the research.** This document
  does not repeat it, re-derive it, or second-guess its architecture. It adds exactly two things
  the gist could not have: (1) our own constraints — what this machine, this billing model, and
  this repo's proven house patterns require; and (2) our answers to the seven questions the gist
  explicitly left open.
- `ruv-doctrine-2026-07-16.md` — rUv's spoken deployment doctrine, which independently answers
  parts of his own gist's open questions (Q3–Q7 below lean on it directly).

**Re-verification note (Rule 0):** the gist's package table was re-checked live against npm on
2026-07-17, one day after its research date — `metaharness@0.3.1`, `@metaharness/harness@0.1.0`,
`@metaharness/host-claude-code@0.1.2`, `@metaharness/host-codex@0.1.2` are all unchanged.
`@metaharness/router@0.3.2` (referenced in §1 Q5 and §2) also confirmed live. No drift to flag.

---

## 1. Answers to rUv's seven open questions, from our context

The gist numbers these under "Open questions." Answered in that order.

### Q1 — Internal single-tenant, or unrelated-user repositories?

**Internal single-tenant, v1.** The only repository this service should execute against at launch
is `stuinfla/ruvnet-brain` itself (and, later, other repos Stuart owns) — never a repo submitted by
an unrelated caller. This is not a new policy invented for this doc; it is the trust boundary
`scripts/issue-fix.mjs` already enforces today (hardcoded `REPO = 'stuinfla/ruvnet-brain'`, no
caller-supplied repository argument at all). Staying single-tenant means we can skip the gist's
harder isolation tier ("evaluate one job per Cloud Run Job, GKE Sandbox/gVisor, or dedicated
projects" — its own words for mutually-untrusted public tenants) for the entire Phase 0–2 window.
Multi-tenant is a distinct, later decision with its own threat model, not a v1 default.

### Q2 — Must agents push commits/open PRs, or is a signed patch artifact sufficient?

**Patch/branch-only. Never auto-push to main, never auto-merge.** This is not a proposal — it is
already the working, shipped precedent in this exact repo: `issue-fix.mjs` creates a disposable git
worktree on branch `issue-fix/<N>`, implements a fix, runs both gates, pushes *only* that branch
(`git push -u origin issue-fix/${issue.number}`), and posts a comment saying a human must review
and merge. Its hard rules are explicit and enforced in the prompt itself: "NEVER push to main,
force-push, or push any branch other than issue-fix/${issue.number}" and "NEVER run `gh issue
close`." The GCP service should adopt the identical output-authority model: a pushed branch (or,
if push access isn't granted to the worker's service account, a downloadable patch + a link) is
the unit of output. Escalating to auto-merge or auto-PR-open is a separate, later decision that
needs its own explicit sign-off — not a default that falls out of "the harness could do it."

### Q3 — Which unattended authentication methods are approved?

**API keys via Secret Manager, scoped and pinned, never the Claude Max subscription's interactive
login state.** This is a house rule, not a preference: the Claude Max subscription this machine
runs on cannot be ridden by unattended server workloads — those must be API-billed or routed to a
cheap model via OpenRouter. Locally, `issue-fix.mjs` and `calibrate-router.mjs` both do the mirror
image of what GCP needs: they *strip* `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `ANTHROPIC_AUTH_TOKEN`
from the child's environment before every `claude -p` spawn, deliberately forcing the run onto the
interactive subscription login rather than risk billing a stray key. `issue-fix.mjs`'s own comment
names the incident this defends against: "the $1,600 / issue-#557 lesson" — an unstripped API key on
this machine was live-verified as stale/invalid, so an unstripped run failed outright with a 401
instead of riding the subscription; worst case locally is "fails," never "silently bills."

GCP inverts this exactly, and the inversion must be deliberate, not accidental: there is no
subscription to fall back to in a Cloud Run container, so the worker *must* inject a scoped API key
— pulled from Secret Manager, pinned to a specific secret version, granted to a dedicated service
account with no other permissions (per the gist's own Secret Manager guidance, itself citing current
Google best practice). The two paths must never cross: a GCP worker image must never bundle a
personal OAuth/session token, and a local script must never accidentally pick up a service-account
key from the environment. Both directions of that boundary are billing-safety boundaries, and the
$1,600 lesson is exactly why both need to be explicit rather than assumed.

### Q4 — Job duration, concurrency, and monthly spend envelope?

Concrete numbers, with the reasoning and the confidence level for each:

- **Job wall-clock timeout — propose 30 min, SIGTERM then SIGKILL after 20s grace.**
  `issue-fix.mjs` already codifies a 15-min timeout / 30 max-turns / 20s grace for exactly this
  shape of one-shot bounded coding job, and that number should anchor the GCP default. **Caveat,
  checked honestly before writing this:** as of 2026-07-17 the local job's own log
  (`logs/issue-fix.out.log`) is three lines long and reads "No new open issues to fix. Board is
  clean" — **zero real fixer runs have executed yet**, so 15 min is a configured design choice,
  not a measured, load-tested number. Proposing 30 min (2× local default) for the GCP job gives
  headroom for a broader "coding service" scope than single-issue triage, while keeping the same
  SIGTERM→SIGKILL(after grace)→durable-log-first shutdown sequence `issue-fix.mjs` already proves
  works cleanly on process exit (see its `cleanupOnSignal` handler). Phase 1's spike (already in
  the gist's plan) should replace this proposed number with a measured one before it becomes a hard
  production ceiling.

- **Concurrency — 1 concurrent job per worker instance, 1 worker-pool min-instance, for the MVP.**
  Two independent sources agree on this number: the gist itself ("Limit each instance to one active
  coding job initially") and `issue-fix.mjs`'s own concurrency-1 PID-file lock
  (`acquireLock()`/`releaseLock()`), which exists specifically because a single fix can outlive the
  10-minute poll cadence and must never double-run. That's real, working, local evidence for the
  same number the gist reasons to independently — high confidence.

- **Spend envelope — propose a $2 hard ceiling per job, a $25/day circuit-breaker, and a $150/month
  starting cap for Phase 1–2.** Grounded in two things, not invented: (1) the $1,600 issue-#557
  incident is the cautionary bound — a single unbounded/unstripped run is what a spend ceiling
  exists to make structurally impossible; (2) rUv's own flywheel warning — "a misconfigured
  flywheel is a self-DDoS... it burned his credits for days discovering dead ends" — is the reason
  the ceiling must be a hard stop, not a soft alert. $2/job assumes cheap-tier-first routing (his
  measured ~56–57× cost ratio for GLM 5.2 vs. Fable-tier) keeps a bounded one-shot coding task well
  under $1 in practice, with 2× headroom. $25/day mirrors the existing local pattern this repo
  already runs — `com.stuartkerr.api-spend-watchdog` pages hourly against runaway spend — applied
  cloud-side via a Cloud Billing budget alert wired to the same worker service account. **Honesty
  check:** the gist's own evidence-quality table rates "Cost/performance: Unknown — no workload,
  region, model mix, or benchmark supplied," and that is still true here; these three numbers are
  reasoned starting ceilings for Phase 1–2, not benchmarked figures, and should be revisited once
  Phase 2 produces real measured job costs.

- **Scope boundary this envelope does NOT cover:** rUv's flywheel/dream-cycle jobs are a
  structurally different product — his own doctrine describes runs of "several days." Those belong
  behind the frozen-gate/evolve discipline (ADR-234: `meetsPromotionRule` never moves, every
  promotion Ed25519-signed and replayable), never as a raw unbounded `claude -p`/`codex exec`
  child process. v1 of this coding service is bounded one-shot jobs only; flywheel/dream-cycle jobs
  are explicitly out of scope until a frozen-gate spike passes on its own terms.

### Q5 — Does `@metaharness/harness` have a stable-enough API for production job orchestration?

**No — and the gist already says so in its own evidence-quality table: "Production suitability of
`@metaharness/harness` | Low/unknown | Package description verified; runtime API and operational
maturity not validated."** Re-verified live today: still `0.1.0`, a pre-1.0 package description
("deterministic control plane with safety gates, receipts, circuit breaking, verification, and
worker selection") with no independent confirmation of its runtime API in this repo. Our answer:
**treat it as a policy/router layer inside a service-owned state machine, not as the durable job
controller**, exactly as the gist itself concludes ("MetaHarness should initially
generate/configure the agent harness; the service must still own queue acknowledgements, leases,
job state, process supervision, and workspace lifecycle").

What a spike must prove before `@metaharness/harness` earns more trust than that (this is the
gist's own Phase 1 plan, restated as acceptance criteria): `harness doctor` passes; MCP policy
scans pass; the same read-only coding task runs once through `claude -p` and once through Codex
with structured-event parsing intact; timeout, cancellation, process-tree cleanup, and workspace
deletion are all observed to actually happen, not just claimed. Separately, `@metaharness/router`
(the real learned cost-optimal router, `0.3.2`, live-verified — see `ADR-040`/`ADR-043` in this
repo, `Accepted`/implemented) is a *different* package from `@metaharness/harness` and should not
be conflated with it: the router question (which model handles this task) and the harness question
(who owns job lifecycle) are separate maturity assessments.

### Q6 — Are live steering and resumable conversations required?

**No, not for v1 — and the gist's own recommendation is to avoid the experimental app-server surface
entirely when they aren't required.** Nothing in this repo's actual use case (issue triage/fix,
bounded coding tasks) needs mid-run steering or session resume; `issue-fix.mjs`'s whole design is
"one process per job, no state carried between runs," which is also exactly what the gist
recommends as the reliability posture ("Reject" — long-lived `claude`/Codex conversation, "State
leakage, drift, memory growth, fragile cancellation/recovery"). Since steering isn't required, the
`codex app-server` WebSocket surface — which OpenAI's own docs call experimental/unsupported for
production — should stay a Phase 4 research spike only, per the gist's own phased plan. No reason
found in our context to pull that forward.

### Q7 — Which build/test commands may run, and what outbound network destinations do they need?

Derived directly from this repo's own `.github/workflows/ci.yml` (the closest thing we have to a
"what does verifying this repo's code actually require" spec, and the honest source rather than a
guess):

**Commands** (all currently gate main via required CI checks):
```
npm run version:check         # version single-source-of-truth
npm run claims:verify         # advertised-numbers ledger regenerates
npm run substitution:check    # no-silent-substitution gate (never impersonate rUv's tools)
npm run catalog:verify        # model catalog live-verified against committed snapshot
npm test                      # structure + grounding-hook behavior (plugin/test/run-tests.mjs)
npm run test:cov              # vitest unit suite + coverage (tests/unit)
node --test tests/integration/install-smoke.mjs
npm exec -- vitest run tests/unit/forge-guard-injection.test.mjs tests/unit/forge-guard-passages.test.mjs
node tests/integration/redteam-guard.mjs
npm audit --audit-level=high  # (run inside kb/, its own package boundary)
```
A verification-only worker (Phase 2's "run independent verification commands in a stricter,
non-agent shell policy" from the gist's job lifecycle step 7) should allowlist exactly this set —
nothing broader — since it is the repo's own definition of "verified."

**Outbound network destinations**, split by phase since they're genuinely different egress needs:
- *CI/build-time egress* (what `ci.yml`'s steps actually reach): `github.com` / `api.github.com`
  (checkout, `gh` CLI calls), `registry.npmjs.org` (`npm ci`/`npm install`), `ntfy.sh`
  (`ntfy-alerts.yml`'s alert push — read-nothing permissions, env-quoted to block injection from
  attacker-controlled issue/PR titles).
- *Runtime agent-call egress* (what a spawned `claude -p` / Codex child needs, not currently
  exercised by CI): `api.anthropic.com` (Claude), `api.openai.com` (Codex), and — per rUv's
  meta-proxy doctrine and this repo's own cheap-tier routing work (`scripts/route-cheap.mjs`) —
  `openrouter.ai` for cheap-model fallback. None of these three should be open by default to a job
  whose adapter wasn't selected for that call; default-deny per the gist's own security section.

No destination beyond this list should be reachable from inside a job's egress policy without an
explicit, reviewed addition — this is the allowlist, not a starting point to relax.

---

## 2. Our constraint layer on his architecture

The principle: **his engine, our constraints, our wiring.** Nothing below replaces or second-guesses
the gist's architecture — each item is a filter or a policy layer bolted onto a specific node in his
mermaid diagram, using design work this repo has already started (or, for entitlements, an
adjacent DDD aggregate already specified for the Onboarding Console).

### Provenance / persona constraints (candidate-set filter, ahead of the Router node)

Design intent already captured in this project's memory (`project_router_constraints.md`,
2026-07-16, Stuart): a constraints step ahead of model selection, stored per-user, respected by
every routing decision. Concretely, e.g. "no China-origin models" would currently exclude
DeepSeek/inclusionAI-tier cheap options; the correct behavior is **not** to silently degrade or
silently ignore the constraint, but to fall back to the next-best *measured* pick inside the
allowed set (e.g. Haiku 4.5 for the cheap tier) and state the cost delta honestly — "your
constraint costs +$X/Mtok vs. the unconstrained pick." Mapped onto the gist's architecture, this is
a filter inserted between `Router{MetaHarness policy/router}` and the `Claude`/`Codex` child-process
selection: the candidate model/provider set is narrowed by the caller's stored constraints *before*
cost-optimal routing runs, never after. As of this writing, **this filter does not exist in code
yet** — no `router-optimizer.mjs` file exists in `scripts/`, and `route-cheap.mjs` (checked directly)
contains no provenance/China/pinned-provider logic. This is open work, not a shipped capability.

Framing matters as much as the mechanism (per the standing nudge-law order): present as a
preference, never as fear. Default is unconstrained (the measured optimum); the constraint is
visible and one click away; the unconstrained path must never be implied insecure. This applies
identically whether the constrained caller is a human using the router panel or a MetaHarness job
whose caller-supplied policy narrows its own candidate set.

### Per-user entitlement transforms (API-ingress filter, at the gist's job-creation step)

The gist's job lifecycle step 1 is "Authenticate and authorize the caller." The transform that
belongs there already has a real aggregate specified in this repo's own DDD work
(`docs/ddd/0002-onboarding-console.md`, `OperatorProfile { harness, entitlements[], projects[],
statedPreferences[] }`), with an invariant worth carrying into the MetaHarness service verbatim:
**"nothing is inferred that can be asked, and nothing is asked that can be observed. We never guess
entitlements from usage — a wrong guess about someone's paid plan is both an error and an insult."**
Applied here: a job's `entitlements[]` (which provider adapters it may invoke — Claude, Codex,
GLM/DeepSeek via OpenRouter — and which spend tier it's allowed) must be an explicit, stored, asked-
or-observed fact attached to the caller at ingress, never inferred from what the job happens to
request. The entitlement transform's output (allowed adapters, allowed spend tier) should be logged
into the job's audit receipt alongside the provenance-filter outcome, so a completed job's receipt
answers both "what was this caller allowed to use" and "what did the constraint filter narrow it
to" — two distinct, auditable decisions, not one blended one.

### ntfy escalation tiers, mapped to rUv's doctrine

His doctrine states the tiers plainly: "always-running agents (red/blue) → GitHub issues for
findings → email for bad → SMS = 'you've shit the bed.' Escalation carries meaning." This repo
already runs a working three-tier analog, built independently but structurally identical, and it
should extend to the GCP worker pool unchanged rather than be redesigned:

| rUv's tier | This repo's existing mechanism | Trigger, as coded today |
|---|---|---|
| Findings → GitHub issue | `job-heartbeat.sh` receipts + `nightly-watchdog.mjs`'s MISSING/NEVER-RAN/STALE/FAILING/OK state machine | Silent evidence trail; no page on its own — a receipt, not an alert |
| Email — "bad" | ntfy `priority: default` / `high` (`issue-fix.mjs`'s `branch-pushed`/`triage-comment`/`no-action` cases) | Worth knowing, not urgent |
| SMS — "shit the bed" | ntfy `priority: urgent` (`issue-watch.mjs`'s SLA-breach alert; `job-heartbeat.sh`'s non-zero-exit alert) | Reserved for real failures only |

Extending this to the GCP worker pool means: DLQ entries and retryable-class job failures map to
the `default`/`high` tier (worth a look); non-retryable failures (auth, policy violation, budget
breach) and worker-pool total outage (zero healthy replicas) map to `urgent`. No fourth tier should
be invented — that would violate both his "escalation carries meaning" doctrine and this repo's own
transition-only alerting discipline (`nightly-watchdog.mjs`'s explicit design note: "Constant
redness must never become constant noise, or the gong trains you to ignore it").

---

## 3. What's already running locally, mapped to the gist's mermaid architecture

| Gist component | Local analog (file) | Maturity | Exact gap for the GCP version |
|---|---|---|---|
| `Client[Authenticated client / CI]` → `API[Cloud Run API]` | **None.** `issue-fix.mjs` is triggered by a launchd `StartInterval` poll (`gh issue list` every 10 min), not an HTTP ingress. | Not built | The entire authenticated API service is net-new. No caller-auth, no idempotency-key handling, no `202 Accepted` job-creation contract exists anywhere in this repo today. |
| `DB[(Firestore job record)]` | `~/.claude/ruvnet-brain/issue-watch-state.json` — a flat JSON file, with `issue-fix.mjs`'s records namespaced under `__issueFix` so they can't collide with `issue-watch.mjs`'s bare-issue-number keys in the same file. | Working, but simple | No transactional compare-and-set, no lease-generation fencing, no multi-writer concurrency control beyond the advisory PID lock (see next row). Needs real Firestore with the state machine the gist specifies (`queued`/`leased`/`running`/`succeeded`/`failed`/`cancelled`, transitions requiring expected-prior-state + lease generation). |
| `Queue[Pub/Sub jobs topic]` + `DLQ[Pub/Sub dead-letter topic]` | **None.** `issue-fix.mjs` polls; there's no push queue, no redelivery semantics, no dead-letter path — a burst beyond `MAX_PER_RUN` (3) is simply deferred to the next 10-minute poll. | Not built | Full Pub/Sub + DLQ layer is net-new. |
| `Worker[Cloud Run worker pool]` | launchd itself — `RunAtLoad` + `StartInterval`, one Mac, one instance. | Working, but not distributed | "Always running" locally means "gets re-invoked on a timer," not a persistent streaming-pull subscriber; no horizontal scaling concept exists at all. |
| `Lease[Job lease + idempotency check]` | `acquireLock()`/`releaseLock()` in `issue-fix.mjs` — a PID-file advisory lock, concurrency-1, with stale-lock reclaim via `process.kill(pid, 0)`. | Working, proven, simple | This is a real, direct analog of "fenced lease" — it just isn't distributed (a single PID file on one machine, not a Pub/Sub ack-deadline extension across worker instances). The *concept* transfers cleanly; the *mechanism* needs to become Pub/Sub-lease-based. |
| `WS[Disposable workspace]` | `prepareWorktree()` / `cleanupWorktree()` in `issue-fix.mjs` — unique git worktree per job at a pinned `origin/main` ref, force-removed on every exit path including signal handlers (`cleanupOnSignal`). | **Strongest 1:1 match in the whole architecture** | Genuinely production-shaped already: unique dir, pinned commit, guaranteed cleanup on crash/signal. The GCP version needs the same guarantees against a *container* filesystem instead of a shared Mac, but the logic is already correct and provably tested locally. |
| `Router{MetaHarness policy/router}` | **Not wired.** `issue-fix.mjs` hardcodes a single fixed prompt template and a static `ALLOWED_TOOLS` list; it does not call `@metaharness/harness` or `@metaharness/router` at all. | Not built (and flagged honestly, per this repo's own no-silent-substitution standing order) | Everything routing-shaped here is a hand-built lookalike, not rUv's actual package. Before this becomes "the MetaHarness router," it needs to *actually invoke* `@metaharness/harness`/`@metaharness/router`, not just resemble them. |
| `Claude[claude -p child process]` | `spawnFixer()` in `issue-fix.mjs` — **exact 1:1 match**: per-job spawn, `stream-json` output, `--max-turns`, wall-clock timeout, `--allowedTools`, SIGTERM→SIGKILL(grace), API-key-stripped env. Same pattern independently reused in `calibrate-router.mjs`'s `runOnce()`. | **Proven, working, directly portable design** | The Codex half of this adapter contract does not exist in this repo at all — no `codex exec`/`codex mcp-server` child-process wrapper has been built. |
| `Results[Logs, patch, receipts, test results]` → `GCS[(Cloud Storage artifacts)]` | `LOG_DIR` (`~/.claude/ruvnet-brain/issue-fix-logs`) for raw logs; the pushed `issue-fix/<N>` branch itself *is* the durable patch artifact — arguably a cleaner analog than a stored diff file, since it's already a reviewable git object. | Partial | No receipts, no checksums, no test-result artifact separate from the raw log exists. GCS-equivalent storage and a structured receipt schema (job/attempt/provider/repo-hash/image-digest, per the gist's audit-receipt guidance) are net-new. |
| `Secrets[Secret Manager]` | **Inverted, on purpose.** Billing safety here is achieved by *deleting* credentials from the child's environment (forcing subscription auth), not by injecting a vault-managed key. | Working for its actual purpose, wrong shape for GCP | This is the sharpest gap: the local pattern and the GCP requirement are opposites, and that inversion must stay deliberate (see Q3 above) rather than get flattened into "just copy the local script." |
| Reliability/monitoring section (heartbeats, fenced leases, metrics) | `job-heartbeat.sh` + `config/scheduled-jobs.json` + `nightly-watchdog.mjs` — the MISSING/NEVER-RAN/STALE/FAILING/OK state machine, transition-only alerting, "evidence or it didn't happen." | **Arguably more mature locally than the gist spells out in implementation detail** | This is the one component genuinely portable close to as-is: the receipt schema and the "silence is not health" discipline map directly onto the gist's own "stale workers cannot finalize jobs... liveness probes for deadlock detection" requirement. The remaining work is moving receipts from local JSON files to Cloud Monitoring/Firestore-backed ones, not redesigning the discipline. |

`issue-watch.mjs` is a related but distinct concern — it watches *human* SLA response to GitHub
issues, not job health — and shouldn't be conflated with the worker-pool monitoring row above.

---

## 4. Phase-0 decisions ready for Stuart to sign

| Decision | Recommendation | Why |
|---|---|---|
| Tenancy | Internal single-tenant only (Stuart's own repos) for v1 | Matches `issue-fix.mjs`'s existing hardcoded trust boundary; avoids the GKE-sandbox/gVisor isolation tier the gist requires for mutually-untrusted callers |
| Output authority | Patch/branch-only — never auto-push to main, never auto-merge, never auto-close an issue | `issue-fix.mjs` is the working, already-shipped precedent for exactly this policy, enforced today with zero incidents |
| Unattended auth | API key via Secret Manager (pinned version, scoped dedicated service account) — never the Claude Max subscription's interactive session | House rule: unattended server workloads cannot ride the Max subscription. The local billing-safety pattern (env-strip) is the *inverse* of what's needed in GCP, and that inversion must be deliberate |
| Job wall-clock timeout | 30 min default, SIGTERM then SIGKILL after 20s grace | 2× `issue-fix.mjs`'s proven 15-min/20s-grace pattern; flagged honestly as an unmeasured starting number (issue-fix.mjs has logged zero real fixer runs as of 2026-07-17) — Phase 1's spike should replace it with a measured ceiling |
| Concurrency (MVP) | 1 concurrent job per worker instance, 1 min-instance | Two independent sources agree: the gist's own recommendation and `issue-fix.mjs`'s existing concurrency-1 PID lock |
| Spend envelope (Phase 1–2 starting caps) | $2/job hard ceiling, $25/day circuit-breaker, $150/month starting cap | Grounded in the $1,600 issue-#557 incident (the failure mode a ceiling exists to prevent) and rUv's own flywheel self-DDoS warning; explicitly reasoned starting numbers, not benchmarked ones — revisit after Phase 2's real measured costs |
| `@metaharness/harness` role | Policy/router layer only — the service, not the package, owns queue, lease, job-state, and workspace lifecycle | The gist's own evidence-quality table rates its production suitability "Low/unknown"; re-verified still `0.1.0` live on 2026-07-17 |
| Live steering / resumable sessions | Not required for v1; defer `codex app-server` to a Phase 4 spike only | Nothing in this repo's actual coding-task use case needs mid-run steering; matches the gist's own "Reject" verdict on long-lived agent conversations |
| Build/test allowlist | Exactly the commands `.github/workflows/ci.yml` already runs (version:check, claims:verify, substitution:check, catalog:verify, npm test, test:cov, install-smoke, injection-guard, redteam-guard, npm audit) | This repo's own CI is the honest, already-agreed definition of "verified" — no broader shell access needed for the verification step of the job lifecycle |
| Egress allowlist | Split by phase: CI/build-time = `github.com`/`api.github.com`, `registry.npmjs.org`, `ntfy.sh`; runtime agent-call = `api.anthropic.com`, `api.openai.com`, `openrouter.ai` (cheap-tier fallback only) | Derived directly from what this repo's workflows and scripts actually reach today — nothing broader should be open by default |
| Provenance/entitlement constraint layer | Build as a candidate-set filter ahead of the Router node (provenance) and an authorization transform at job-creation (entitlements) — both currently unbuilt (`route-cheap.mjs` checked directly, no such logic exists) | Matches the design intent already recorded for the router work (`project_router_constraints.md`) and the `OperatorProfile` invariant already specified for the Onboarding Console (`docs/ddd/0002-onboarding-console.md`) — reuse existing design, don't invent a third pattern |
| ntfy escalation shape | Keep exactly three tiers (silent receipt / default-high / urgent) — extend to worker-pool DLQ and outage alerts, add no fourth tier | Already matches rUv's own doctrine (GitHub issue → email → SMS) independently; adding tiers would violate both his "escalation carries meaning" rule and this repo's transition-only alerting discipline |
