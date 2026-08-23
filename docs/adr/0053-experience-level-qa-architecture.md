---
id: ADR-053
title: Experience-level QA — test the journey a user actually has, on every host, OS, and install path
status: Accepted
date: 2026-07-26
updated: 2026-08-23
authors: [Stuart Kerr, Claude Code]
tags: [qa, testing, experience, cross-platform, codex, agentic-qe, ci]
supersedes: []
relates: [ADR-028, ADR-050, ADR-051]
governs:
  - tests/experience/*.json
  - tests/experience/*.mjs
  - .github/workflows/ci.yml
  - .github/workflows/qe-4-3.yml
  - scripts/qe/*.mjs
  - tests/ux/*.mjs
---

# ADR-053: Experience-level QA

**Status**: Accepted (adversarially duel-verified 2026-07-26 — record below)
**Date**: 2026-07-26
**Related**: ADR-028 (test classes), ADR-050 (issue pipeline), ADR-051 (Codex wiring)

## Context — the owner's mandate, verbatim in spirit

Issues #42 and #43 (Henrik Pettersen) were both the same failure at different layers: everything
worked **on the machine that built it** and was dead on the surface a real user touched. #42: the
server shipped, the Codex registration didn't. #43: the registration code shipped, the npm tarball
didn't carry its file. Both passed 1,700 unit tests, because every test exercised the source
checkout. Separately, CI ran red for five days (2026-07-21 → 26) on Windows-only and
fresh-checkout-only failures — meaning the suite was structurally blind to two of the three OSes
and to every machine that is not the author's Mac.

The owner's standing instruction (2026-07-26): *don't just fix the issue — zoom out. The test
surface must be larger, more mature, and aimed at the **experience**: Claude Code and Codex, Mac
and Linux and Windows, every install path a real user takes. Hundreds of people use this; one bad
experience and they delete it.*

This ADR is that zoom-out. ADR-028's five test classes (low/medium/high/numeric/qualitative)
remain the grammar of individual tests; this ADR adds the missing **dimension**: whose machine,
which host, which artifact, which journey.

## Decision

### 1. A checked-in scenario LIST is the unit of coverage — never a Cartesian matrix

v1 proposed a host × OS × artifact × journey matrix. Both duel reviewers killed it independently:
the axes are falsely orthogonal (a marketplace clone is a Claude-only artifact; `--update` is a
transition, not an artifact), so the product manufactures ~100 incoherent cells whose bulk-labeling
as `manual` makes the report permanently green — the matrix Goodharts itself in one move. Instead:
`tests/experience/scenarios.json` is an explicit, hand-written list of the ~20 coherent scenarios,
each one record: {host, os, artifact, stage, user-state, classification, evidence, owner}. The
report fails on any coherent scenario left unclassified AND on `manual` exceeding 20% of the list.
`manual` requires a named owner and sits OUTSIDE the coverage denominator; wherever a machine can
reach the surface, the classification is `scheduled-live-probe`, not `manual`.

Two axes v1 lacked, now required on every scenario:
- **user-state**: fresh home · POPULATED home (the user's own config.toml with comments/CRLF/their
  own `mcp_servers`; foreign hooks in settings.json; prior-release on-disk state) · hostile paths
  (spaces, unicode, read-only cache, near-full disk). Hermetic must never mean sterile — the
  clobbered-stranger's-config class only exists in populated homes.
- **recurring use**: "prompt N on day 9" is a stage. The product's highest-frequency touchpoint is
  a hook firing mid-session, and v1's one-time journey stages structurally could not see it.

### 2. The hooks-as-shipped battery — tier one, funded by the cuts below

> **STATUS 2026-07-27 — items 1, 2, 5, 7, 8 SHIPPED as a POST-INSTALL SELF-CHECK, and born red.**
> `scripts/selfcheck.mjs` + `tests/unit/selfcheck-battery.test.mjs` (32 tests), reachable as
> `npx ruvnet-brain --doctor --hooks` and run as the installer's final step. This closes the gap an
> independent grader scored 40/100: *"is there any mechanical check that runs after install on a
> stranger's machine and can fail?"* — previously **no**, for a reason that was pure consumption and
> not detection. `verifyInstall()` and `smokeQuery()` both RETURN verdicts and `bin/install.mjs`
> called both as bare statements, discarding both; `doctor()` printed *"! Needs attention."* and
> returned `undefined`. Measured on origin/main before the fix, against an install with zero stores
> and no reader deps:
>
> ```
> $ node bin/install.mjs --doctor        →  "! Needs attention."
> $ node bin/install.mjs --doctor; echo $?  →  0
> ```
>
> Both are now consumed and `--doctor` exits 1 on that same install.
>
> **It is BORN RED against the shipped product, which is the proof it works.** Run against this
> machine's installed 3.9.84-dev plugin it reports — and each was then reproduced with plain
> `timeout` + pipes, with zero involvement from the checker, because a harness that invents a defect
> is worse than no harness:
>
> | finding | independent reproduction |
> |---|---|
> | `ground-ruvnet` hangs on held-open stdin AND on 1MB garbage (declared timeout 5s) | `( printf '{}'; sleep 12 ) \| timeout 8 node …/hook-shim.mjs ground-ruvnet` → **exit 124** |
> | `session-start` writes 8923 bytes of stdout (cap 4096) — **CLOSED 2026-07-27, now 3663** | `echo '{}' \| node …/hook-shim.mjs session-start \| wc -c` → **8923**, and after the fix → **3663** (ADR-055 build item 2's closure note has the full before/after and the two mutants) |
> | `learn-flush`, `route-dispatch`, `design-wall`, `verify-interface`, `protect-brain-state`, `hijack-ruvnet`, `learn-capture`, `unprompted-runtime` all hang on at least one regime | same shape |
> | `route-dispatch.sh` double-registered from two code roots (spine + marketplace-clone) | ADR-055 F3, already known |
>
> These are F20/F3 exactly as ADR-055 predicted. Per ADR-055's build order — item 2 (battery)
> **before** item 3 (changing any registration) — they are recorded here as findings, not fixed out
> of order. Item 3 is what closes them.
>
> Not yet built from the list below: **3** (p95 over 100 firings), **4** (broken-world sweep), **6**
> (static lint — partly covered by `scripts/hook-registry.mjs --lint`, which is clean on all 16
> repo-owned registrations), **9** (update-while-firing).

The single highest user-pain surface. A required CI job (ubuntu + windows) and a release gate:

1. **Invocation fidelity**: every battery case derives from hooks.json ITSELF (an entry with no
   battery case fails the build), runs the literal registered command with `CLAUDE_PLUGIN_ROOT`
   substituted to the PACKED marketplace layout — never the module, never the body directly (the
   adjacent-door defect: today's battery spawns the .sh bodies and skips the shim layer that
   actually runs on strangers' machines).
2. **Four stdin regimes** per hook, under an external process-group watchdog: valid event JSON;
   empty EOF; 1MB garbage; and stdin HELD OPEN past budget — the canonical hang, and the one check
   that catches the /rvbc class pre-ship. In-process timers don't count: a frozen event loop or
   synchronous child defeats them.
3. **Latency budgets far below the timeout**: warm < 500ms, cold < 2s, p95 of 100 repeated firings
   < 500ms. A budget AT the timeout detects nothing until users already eat it per prompt.
4. **Broken-world sweep**: no cache dir · active.json → missing generation · truncated
   active.json · node_modules absent · read-only cache. Advisory hooks: exit 0, silent. Blocking
   hooks: only their documented exit codes — never a stack trace on a stranger's screen.
5. **Stream discipline**: stdout ≤ 4KB (it lands in the user's context window), stderr whitelisted.
6. **Static lint**: every entry carries an explicit timeout (three unprompted-speech entries
   shipped WITHOUT one — found live by this duel, fixed in the same commit); prompt-path events
   cap at 5s; the blocking set matches ADR-023's table exactly.
7. **Process-tree hygiene**: SIGTERM the parent at budget → zero surviving descendants.
8. **Coexistence**: run inside merged user+project+plugin registries carrying sentinel foreign
   hooks (slow, failing, garbage-printing, before AND after ours); against a no-plugin baseline,
   prove every sentinel still fires exactly once, unrelated config stays byte-equivalent, and our
   contribution stays inside its documented latency/output. Double-install never duplicates.
9. **Update-while-firing**: flip active.json mid-battery; every invocation still lands in budget —
   the ADR-023 stable-spine claim becomes a measurement instead of an assertion.

### 3. Artifact-first, extended to PUBLISHED bytes

`npm pack` on the checkout proved unable to represent registry reality (prepack/publish-env/
dist-tag/propagation). The ship flow becomes: publish to a **candidate dist-tag** → clean-container
install of that exact integrity on all three OSes → doctor + Codex wire + MCP round trip + one
grounded answer → only then promote the SAME integrity to `latest`. A scheduled live probe re-runs
the install nightly and files an issue on failure, so "walk every channel" has a machine, not a
memory.

### 4. Gate C++ v2 — exact SHA, every required workflow

v1's gate read the LATEST completed run of ci.yml only: it verified the parent commit, not the one
shipping, and was blind to integration-linux — re-opening the 5-day hole one release at a time.
v2: push the release commit, capture its SHA, WAIT for every required workflow on that exact SHA,
refuse on missing/skipped/cancelled/stale; authenticated API (rate-limit 403s otherwise train the
override into muscle memory); `--ci-override` reasons go into the release LOG and a required line
in the next release's notes — a printed-once diagnostic nobody reads is the ADR-050 failure shape.

### 5. agentic-qe: on-demand generator only — off the critical path

Both reviewers, independently: deterministic artifact/hook/update/exact-SHA gates come first, and
must demonstrate they fail on seeded defects before any fleet output is trusted. aqe drafts
scenarios on demand under the standing budget cap; the quarterly HTSM ritual is cut (this repo's
own record: unowned periodic ceremonies do not fire).

### 6. Cuts (funding the above)

DDD aggregates/domain events/anti-corruption ceremony → one sentence survives: journey tests speak
only through public faces (CLI, doctor output, MCP protocol, user-visible files). The universal
<90s CI budget → split: fast PR suite (cached) vs uncached release-qualification lane; the
first-grounded-answer scenario is honestly `scheduled-live-probe` until a cached-bundle CI lane
exists, and the gate watches whatever lane carries it.

## Rollout (converged ranked order — user-pain-avoided, both lists merged)

1. hooks.json lint: explicit timeout everywhere, 5s prompt-path cap (**shipped with this ADR**).
2. Hook battery v2, shim-level, four stdin regimes + watchdog (kills the every-prompt-hang class).
3. Gate C++ v2: exact-SHA, all required workflows.
4. Candidate-dist-tag publish flow + post-publish live probe.
5. Codex merge on POPULATED config.toml (foreign servers, comments, CRLF, unicode) — byte-diff.
6. MCP stdio round trip from the unpacked tarball on all three OSes.
7. Real-Windows checkout journey (`core.autocrlf=true` — the default CI currently disables).
8. Upgrade-from-real-prior-release (seed N−2 state, run --update, assert Codex server copy refreshes).
9. Update-while-firing concurrency probe.
10. Hostile-home journeys (spaces/unicode/read-only/ENOSPC) — degrade with one clear message, zero hook errors.

## Consequences

- Ship time: PR suite stays fast; release qualification gets its own uncached lane.
- Windows/ubuntu first-class; macOS gets a mechanical verdict via the release-qualification lane
  rather than trusting one developer laptop.
- Node floor: CI must pin the OLDEST engines-promised runtime (>=18) in at least one lane, or the
  engines field must be raised honestly.

## Adversarial duel record (2026-07-26, per the standing order)

Fable 5 (fresh context, no authorship bias) and GPT-5.6-Sol (codex exec, read-only) attacked v1
independently with identical briefs. **Convergent verdicts, reached separately:** (1) the matrix
cannot see the hook/recurring-use class — the product's worst live failure mode; (2) three shipped
hooks lacked timeouts at that moment (both found it; fixed same-commit); (3) gate C++ v1 verified
the wrong commit and the wrong workflow set; (4) locally-packed bytes ≠ published bytes; (5)
hermetic-turned-sterile — no populated-home/coexistence axis; (6) cut the DDD ceremony, the
quarterly fleet ritual, `manual`-as-coverage, and the Cartesian matrix. Notable singles: Fable —
CRLF (CI tests a Windows no user has), npx-cache eviction leaving a frozen Codex server copy,
GitHub rate-limit on the unauthenticated gate; GPT-5.6 — candidate-dist-tag promotion flow,
process-group watchdog over in-process timers, p95/p99 latency canary. Where they differed on
budgets (500ms vs 1s prompt-path), the stricter number won. v1's matrix section is superseded by
§1 above; everything else in v1 stands.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-08-23 | The aggregate now downloads merged receipts into its canonical `.qe/receipts` directory, and Vitest steps retain verbose diagnostics alongside JSON. | The workflow fix prevents successful uploads from being misclassified as missing, while commit `4b2b340`'s bounded tails make a hosted parser or timeout actionable without rerunning unrelated lanes. |
| 2026-08-23 | Receipt diagnostics now retain bounded stdout/stderr tails for hosted parser failures. | Commit `1310fb6` makes the exact failing-process evidence available in the uploaded receipt without rerunning unrelated lanes; the zero-spend and exact-SHA boundaries remain unchanged. |
| 2026-08-23 | QE receipts now retain skipped-test identities and suite-level errors, not just aggregate counts. | Commit `cc25c24` makes the cross-platform failure contract diagnosable from the uploaded artifact before any rerun. |
| 2026-08-23 | Candidate resources no longer treats live-precondition skips as release evidence, and Windows invokes Vitest through Node rather than `npm.cmd`. | Commit `0e30d68` keeps unavailable live checks out of the deterministic candidate denominator and removes the hosted PowerShell launcher failure; live qualification remains a separate required regime when explicitly run. |
| 2026-08-23 | Failure receipts now preserve failed test identities and upload on failed lanes; release-QE waits for every required behavior/resource lane. | Commit `b570e25` closes the first hosted-run observability gap in the new workflow: a red lane remains diagnosable, and downstream artifact work cannot begin after Windows/resources failure. |
| 2026-08-23 | Replaced the legacy auto-triggered CI/integration/UX matrix with `.github/workflows/qe-4-3.yml`: fail-fast preflight, isolated behavior/artifact/resource lanes, zero-spend enforcement, and exact-SHA machine receipts. The legacy workflows remain manual-only for recovery. | The prior monolithic integration gate spent ~16 minutes before failing a detached-fixture cleanup race after seven other lanes had passed. The new workflow implements this ADR's required separation and refuses missing, skipped, stale, or non-PASS evidence through `scripts/qe/aggregate-4.3.mjs`; Agentic-QE remains on-demand and off the release critical path. |
| 2026-08-21 | Re-read the exact release-QE and integration changes after the emergency seed repair; the user-journey contract is unchanged. | `.github/workflows/ci.yml` now runs `rvf-index-audit.mjs --repair` before strict bundle assembly, and the integration fixture now supplies the generation receipt production requires. The real Linux integration lane passed on `c2b9fb0`; no experience scenario, threshold, or host path was removed. |
| 2026-08-21 | Removed the #145 quarantine after replacing the Linux procfs fixture that blocked Node 20 collection. | `.github/workflows/ci.yml` again runs the complete unit suite. `tests/unit/decision-outcomes.test.mjs` now produces the same write failure with a regular-file parent, while `.github/workflows/diag-145-hang.yml` retains a bounded Ubuntu diagnostic. No experience scenario or threshold was weakened. |
| 2026-08-19 | **ci.yml quarantines one unit test; no scenario or grader threshold is affected.** | `check`'s nine-day hang now has a NAME: `tests/unit/decision-outcomes.test.mjs`, identified by construction rather than guessed. `--no-file-parallelism` makes completion order equal execution order, and vitest sequences by file size DESCENDING — verified, not assumed: the 129 files that completed are EXACTLY the largest 129 by size, zero mismatches, so the file that started and never finished is the 130th. It converges with the independently-derived regression window (main last green 2026-08-10T11:06, first red 16:23), which contains the two ADR-067 decision-gate commits — and this is a decision-gate test. The file is QUARANTINED via `--exclude`, not fixed: it passes locally in 1.8s WITH coverage, so the cause is ubuntu-specific and unknown. #145 stays open; the exclusion comes out when the mechanism is understood, because a quarantine that quietly becomes permanent is deleted coverage. Nothing in `tests/experience/*` changed. |
| 2026-08-19 | **ci.yml gained a temporary verbose-reporter diagnostic; no scenario or grader threshold is affected.** | A temporary `--reporter=verbose` diagnostic was added to the `check` job's vitest step (#145). The step hangs DETERMINISTICALLY on ubuntu — two runs 38 minutes apart went silent after the same file, with the same six files before it and the same orphan signature at cleanup — and it survived every one of today's twelve unit-test fixes, so the failing tests were not the cause. The default reporter prints on file COMPLETION only, so a file that starts and never finishes is structurally invisible; verbose prints start events. Diagnostic only, to be removed once the file is named. Nothing in `tests/experience/*` changed. |
| 2026-08-19 | **Re-read after ci.yml gained job timeouts; the experience-level contract is unchanged.** | The only governed path that moved is `.github/workflows/ci.yml`, which gained `timeout-minutes` on all four jobs after EIGHT consecutive main runs wedged on the vitest step for up to three hours (see ADR-058's 2026-08-19 row). No scenario, no report shape, and no grader threshold in this document is affected: the change bounds how long a job may hang, not what it asserts. `tests/experience/scenarios.json` and `report.mjs` are untouched. |
| 2026-08-07 | **Re-read after the experience-QA surface moved; the decision is unchanged and is now more nearly true than when written.** | `.github/workflows/ux-qe.yml` is a real 43-line workflow running on push, pull_request and dispatch across an OS matrix, and `tests/experience/{scenarios.json,report.mjs,report.test.mjs}` moved with the merges of #119/#120/#121. This ADR argues that experience-level QA must execute rather than exist as a listed-but-uninvoked suite — the same lesson ADR-058 §D7 records about a mutation corpus that sat in `include` for days with no CI step ever running it. A governed suite gaining its own CI lane implements that requirement; it contradicts nothing here. Verified the lane is reachable (it reported success at `886eeb5`) rather than assuming a workflow file means a workflow runs — the distinction this ADR exists to make. |
| 2026-08-02 | Re-read the governed CI surface after the 4.0.8 evidence-DAG change; experience-level QA remains a required exact-SHA input. | Commit `8608cfd` builds the immutable npm and bundle artifacts once in `.github/workflows/ci.yml`, runs candidate host evidence from those bytes, and makes the derived aggregate the sole publication input. It does not weaken the UX or session-start gates. |
| 2026-08-02 | Re-read the final 4.0.7 browser probe after Console provenance and inventory landed; the 4,000ms gate and three-OS journey architecture remain unchanged. | Commit `3668b1b` updates `tests/ux/render-probe.mjs` to observe the new runtime identity and owner-only issue inventory exposed by the shipped Console. It does not weaken the click path, timing oracle, OS-derived controls, or failure conditions. Exact-SHA CI remains the cross-platform authority. |
| 2026-08-02 | Re-read the real Console Fix All journey after making the timing oracle account for the actual user click rather than a harness-only trial click. The 4,000ms hard gate and the three-OS journey architecture are unchanged. | Commits `7b8b41d`, `57bbe0b`, and `d7bed73` make `tests/ux/render-probe.mjs` report response/render/verification phases, prohibit `trial: true`, and perform exactly one real Fix All click. Commit `8f06287` replaces test `HOME`/`USERPROFILE` overrides with an explicit absolute `RUVNET_CONSOLE_ROOT` fixture plus named config/state files; `tests/unit/console-root.test.mjs` rejects relative traversal input at startup. Three macOS browser trials passed Fix All in 2325ms, 2453ms, and 2294ms; this local evidence does not replace the required cross-platform scheduled probes. |
| 2026-08-01 | Re-read the governed experience surfaces after the clean recovery candidate added a serialized `release-qe` job; the journey architecture and its remaining limitations are unchanged. | `.github/workflows/ci.yml` now runs `scripts/release-authority.mjs`, `npm run version:check`, and the exact-artifact release-QE configuration in one named job. No governed scenario, report, UX probe, or performance budget changed, and this local candidate still lacks exact-SHA remote CI and published-byte proof. |
| 2026-07-30 | Updated the cross-platform Console acceptance oracle to the shipped 4.0.2 controls and made platform-conditional absence an explicit, OS-derived contract. | PR #68’s exact-SHA UX jobs proved `tests/ux/render-probe.mjs` still expected only provider/advocacy plus seven unsupported controls. The product has eight universally owned controls and a ninth nightly control on macOS; the oracle derives that expectation from `process.platform`, never from the product output it is grading. `HOME` and `USERPROFILE` now share the same fixture root so Windows must surface the known npx defect and exercise real save/reload, Fix All, and undo paths rather than silently accepting zero recommendations. |
| 2026-07-29 | Re-read the governed experience and QE surfaces after the 4.0.0 Agentic-QE expansion; the journey architecture remains valid and now has additional stored adversarial coverage. | Commit `e20cdf2` adds `tests/qe/gpt56/*.test.mjs` and release/security suites while preserving the governed contracts in `tests/experience/scenarios.json`, `scripts/qe/card-lane-gate.mjs`, `scripts/qe/session-start-gate.mjs`, and `.github/workflows/ci.yml`; the focused and full gates recorded in `docs/qe/AGENTIC-QE-4.0-MASTER-PLAN.md` pass. |
| 2026-07-29 | Added opt-in, builtin-only stage tracing to the cold SessionStart measurement after the first corrected Windows run still exceeded the declared timeout. The trace is silent outside the isolated QE environment and identifies the product stage to fix; it does not relax the budget. | PR #58 run `30423370117`, Windows job `90484507774`; governed paths `plugin/scripts/session-start.sh`, `scripts/qe/session-start-gate.mjs`, and `scripts/qe/ux-suite.mjs`. |
| 2026-07-29 | Re-read the experience gate after the Windows SessionStart incident. The cold first fire is now a separately reported hard result, the steady-state distribution remains separate, and every shell/Node home authority points at the same isolated fixture root. This strengthens §2’s process-watchdog and real-user-wait requirements without changing the journey architecture. | Main UX run `30422743294` exposed the defect; governed paths `scripts/qe/session-start-gate.mjs`, `scripts/qe/ux-suite.mjs`, and `kb/card-lane-budget.json`; regression `tests/unit/session-start-gate.test.mjs`. |
| 2026-07-28 | Re-read the governed experience paths after the recovery candidate bound every scheduled scenario to the exact workflow job and executable path, added three-OS user-felt UX budgets, and fixed the command-probe timer lifecycle. The one remaining manual scenario is still explicit and owned; no architecture decision changed. | Commits `d065f49`, `a7af965`, and `cf5bc24`; `tests/experience/report.test.mjs` passes 8/8 including missing/uninvoked-path mutants, and `scripts/qe/ux-suite.mjs` completes with every hard budget green. |
| 2026-07-28 | Re-read every governed experience surface after the two later scenario-list commits; S18 now names the real native Codex plugin-skill boundary, and S21 names the assembled-directory `--local` contract. The architecture and its unbuilt limitations are otherwise unchanged. | Commit `ac8c978` changes only `tests/experience/scenarios.json` S18 from retired `.codex/skills/*/skill.toml` manifests to installed `plugin/skills/*/SKILL.md` discovery, backed by `tests/integration/codex-skill-discovery.test.mjs`. Commit `7eb11fb` changes only S21's artifact from `dist/ruvnet-brain.zip` to assembled `dist/ruvnet-brain/`. Neither commit implements §3's candidate-dist-tag promotion, §4's exact-SHA/all-workflow gate, or rollout items 9–10; those remain planned rather than claimed. |
| 2026-07-28 | The warm-brain CI lane now derives its required query embedders from installed RVF sidecars and asserts every exact model leaf. | The independent grade of SHA `879b928` found all 62 heavy repositories unavailable because canonical stores require `Xenova/bge-base-en-v1.5`, while `.github/workflows/ci.yml` warmed and asserted only MiniLM. The lane can no longer report a warm adjacent model as proof of the real reader. |
| 2026-07-27 | `governs:` changed from the directory `tests/experience/` to two globs, `tests/experience/*.json` and `tests/experience/*.mjs` | `scripts/doc-currency.mjs` flagged `governs-directory`: a directory's tree object changes when ANY file under it changes, mass-expiring unrelated verifications. Checked what actually exists under `tests/experience/` (`report.mjs`, `report.test.mjs`, `scenarios.json`) before choosing the glob, per the tool's own guidance — both patterns match exactly those 3 tracked files, no more |
| 2026-07-27 | **Re-read against the governed code; NO change required — every claim still holds.** | Flagged `presumed-stale`: 7 commits (0d) after this document's last commit, touching `.github/workflows/ci.yml`, `scripts/qe/card-lane-gate.mjs`, `scripts/qe/ux-suite.mjs`. All 7 are ADR-058 work (D1/D2/D5/D6/D7 — `ce72282`, `987160e`, `8b4cb04`, `83e590e`, `30c8018`, `495922a`, `9f8421c`, `314be33`, `aa8c090`), building OUT rollout items this ADR already named (item 6 MCP round trip, the REQUIRE_BRAIN lane, the 22-scenario `scenarios.json` this ADR's §1 specified) — additive, not contradicting. `scripts/qe/card-lane-gate.mjs` and the `ux-suite.mjs` changes are governed by ADR-058 (its own frontmatter names them), not discussed by name in this document's prose; nothing here asserts anything about those two files specifically. The §2 STATUS callout (self-check items shipped, F20/F3 recorded not fixed) and the "not yet built: 3/4/6/9" list were re-checked against current `scripts/selfcheck.mjs` and `tests/unit/selfcheck-battery.test.mjs` — still accurate, item 3 (four-plane dispatchers) still not landed |
