# The Conventions Audit — every rule in this repo, and whether anything enforces it

Created: 2026-07-22
Updated: 2026-08-02 — issue #84 truthful Agent/Task hook timing semantics
Why: The owner, 2026-07-22 — *"There are dozens of things like this that are the difference between
you acting as a smart learning partner and somebody that needs to constantly be reminded of
everything all the time."* This document is the enumeration of "things like this." It exists because
the ADR-stamp decay (ADR-0034) is one instance of a class, and nobody had ever counted the class.

> **This document wears the convention it audits.** Created/Updated/Why are stamped above. If you
> edit it and do not touch those three lines, you have demonstrated the finding.

---

## 0. Method — what was actually read, so this is reproducible and falsifiable

Everything below is measured at **2026-07-22 06:20–06:45 EDT**, on the working tree at
`4c49646` + uncommitted changes. Nothing here is recalled.

**Read in full or grepped systematically:**

| Surface | What was extracted |
|---|---|
| `~/.claude/CLAUDE.md` (v6.7.0) | 22 numbered global rules (0–21) |
| `~/.claude/projects/-Users-stuartkerr-Code-ruvnet-brain/memory/feedback_*.md` | **46 standing-order files** |
| `~/.config/ruvnet-brain/lessons.json` | 15 lessons (12 ratified, 3 candidate) |
| `docs/adr/*.md` | 34 ADRs — frontmatter keys + normative body statements |
| `docs/ddd/*.md` | 8 DDD context docs |
| `CONTRIBUTING.md`, `SECURITY.md`, `README.md`, `PROGRESS.md`, `docs/adr/README.md` | imperative grep (`ALWAYS`/`NEVER`/`MUST`/`SHOULD`) |
| `.github/workflows/*.yml` (5) | every CI step |
| `plugin/hooks/hooks.json`, `.claude/settings.json`, `~/.claude/settings.json` | every registered hook |
| `scripts/git-hooks/pre-push`, `scripts/release.mjs` | the push and ship boundaries |
| `scripts/*.mjs` (104), `plugin/scripts/*.sh` (20) | gate implementations + orphan check |
| `tests/unit/*` (81), `tests/integration/*` (20) | which conventions have a behavioral fixture |
| `~/Library/LaunchAgents/*.plist` (17) | scheduled-job invocation of any gate |

**Three false findings were caught and removed during this audit**, which is worth stating because
constraint 3 says a gate that cries wolf gets bypassed — and so does an audit:

1. `private-fence.mjs` first read as an orphaned security control. It is **not** — it is imported by
   `scripts/build-concepts.mjs:15` and covered by `tests/unit/build-concepts-fence.test.mjs`. The
   first sweep only looked for CLI invocation and missed module imports.
2. `status-honesty.mjs` first read as unwired. It is **not** — `tests/unit/derived-status.test.mjs:94`
   calls `scanRepo(ROOT)` against the live repo, and that test runs in CI via `npm run test:cov`.
3. A grep for `/10` flagged three "scores out of 100" violations in `ADR-0025:36-39`. Reading the
   lines, they are **retrieval hit-counts** (`0/10`, `2/10` questions answered) in a results table,
   not quality grades. Not a violation. This is precisely the shape of false positive that a naive
   `scores-out-of-100` gate would generate on every benchmark table in the repo — which is why that
   convention is ranked *down* in §4 rather than up, despite being trivially greppable.

Every "PROSE ONLY" verdict below survived an import-aware, test-aware, plist-aware re-check.

---

## 1. The decisive measurement — same files, same authors, same sessions

`tests/unit/adr-format.test.mjs` gates exactly **two** things about an ADR: the frontmatter `id:`
key, and a body `**Status**:` line parseable by rUv's importer. Every other field in the same
frontmatter block is prose convention.

Measured across all **34** ADRs:

| Field | Gated? | Present | Compliance |
|---|---|---|---|
| frontmatter `id:` | **YES** — `adr-format.test.mjs:44` | 34 / 34 | **100%** |
| body `**Status**:` | **YES** — `adr-format.test.mjs:48` | 34 / 34 | **100%** |
| frontmatter `status:` | no | 22 / 34 | 65% |
| frontmatter `date:` | no | 22 / 34 | 65% |
| frontmatter `authors:` | no | 22 / 34 | 65% |
| frontmatter `tags:` | no | 21 / 34 | 62% |
| body `**Date**` / `**Updated**` | no | 14 / 34 | 41% |
| frontmatter `updated:` | no | 12 / 34 | **35%** |

**Two gated fields: 100% and 100%. Six ungated fields: 35%–65%.** Same files. Same authors. Often the
same commit. The only variable is whether a test would go red.

This is a cleaner experiment than ADR-0030's 8/8-vs-0/6 session measurement, because it holds the
document, the author, and the moment of writing constant and varies *only* enforcement. It is the
strongest evidence in the repo for the thesis, and it was sitting in the corpus uncounted.

**Corollary nobody had noticed:** `adr-format.test.mjs:53` allows `'Implemented'` in its status
enum. ADR-0034 §1 establishes — grounded in rUv's `ruflo-adr` REFERENCE.md, where `implemented`
appears **0 times** — that `Implemented` is not a valid rUv status and is the lie-shaped value. **The
gate currently blesses the exact value the architecture says must not exist.** Two ADRs (0013, 0018)
sit on it, both gate-green.

---

## 2. What is actually enforced today — the gate inventory

Eight enforcement surfaces exist. This is the honest denominator for everything in §3.

| # | Surface | Mechanism | Blocks? | Covers |
|---|---|---|---|---|
| 1 | **CI `ci.yml` / check** | 12 steps on every push+PR | hard red | fossil >5MB, version drift, silent substitution, model catalog, plugin battery, vitest+coverage, claims ledger, installer smoke, injection guard ×2, dep audit |
| 2 | **CI `ci.yml` / windows-unit** | full `tests/unit` on win32 | hard red | cross-platform regressions |
| 3 | **`scripts/git-hooks/pre-push`** | secret scan + `verify-channels --pre-push` | refuses push | live API keys, channel drift |
| 4 | **`.claude/settings.json` PreToolUse:Bash** | `version-bump-gate.sh` | exit 2 | every push carries a version bump |
| 5 | **`~/.claude/settings.json` PreToolUse** | `ground-before-write.sh`; `verify-interface.sh` advisory | exit 2 only from the grounding wall | ungrounded rUv-domain writes; legacy raw-shell CLI calls receive migration guidance only |
| 6 | **`plugin/hooks/hooks.json`** | hooks via `hook-shim.mjs` | 3 blocking | `design-wall`, `unprompted-speech`, and `protect-state`; route-dispatch and interface guidance are advisory |
| 7 | **`scripts/release.mjs`** | gates A–E | aborts ship | both suites, narrative version, clean tree, live channel walk |
| 8 | **`Stop` hook** | `continuation-gate.mjs` | advisory (exit 0) | unfinished authorized work |

**The enforcement ladder has a broken rung, already self-documented.** `lesson-gate.mjs` exits **1**;
Claude Code's contract is **exit 2 + stderr**; `lesson-hooks.sh` exits 0 unconditionally. So a lesson
marked `enforcement: block` and human-ratified **prints the word BLOCKED and permits the action**.
Recorded honestly at `docs/adr/0028-what-proactive-means.md:60-75` (corrected 2026-07-22 07:00). Of
15 lessons, **8 are `enforcement: block`** — all 8 are advisory in fact.

---

## 3. The full convention table

Status key: **GATED** = a mechanism fails/blocks on violation · **PARTIAL** = enforced on one axis,
path, or surface but not the stated rule · **PROSE ONLY** = nothing mechanical.

### 3A. Documentation & record-keeping

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| ADR carries frontmatter `id:` in canonical form | `adr-format.test.mjs` header | `tests/unit/adr-format.test.mjs` (CI) | **GATED** | done |
| ADR has a rUv-parseable `**Status**:` line | same | same | **GATED** | done |
| ADR `**Related**` refs resolve to a real ADR | same | same | **GATED** | done |
| Precise figure + `ADR-NNN` citation must appear in that ADR and be Accepted | `adr-citation-integrity.test.mjs` | that test (CI) | **GATED** | done |
| **ADR carries `date:` (created)** | ADR-0034 §4; convention since ADR-0013 | nothing | **PROSE ONLY** | Low — 5 lines in `adr-format.test.mjs` |
| **ADR carries `updated:` + why** | owner 2026-07-22; ADR-0034 §4 | nothing (35% compliant) | **PROSE ONLY** | Med — ADR-0034 §6 designs it; `scripts/doc-currency.mjs` created 2026-07-22 by a sibling agent, not yet wired |
| **ADR status reflects code reality (`impl:`)** | owner 2026-07-22; ADR-0034 §2 | nothing — state does not exist | **PROSE ONLY** | Med — ADR-0034 §2 spec'd |
| **`Implemented` must not be a status value** | ADR-0034 §1 (grounded in rUv REFERENCE.md) | **the gate permits it** | **INVERTED** | Trivial — delete one enum entry, migrate 2 files |
| **DDD docs have any header convention at all** | — | nothing; zero tests read `docs/ddd/` | **PROSE ONLY** | Low — 8 files, 4 header shapes today |
| **Docs carry `Updated:/Version` + `Created:` line 1–2** | global CLAUDE.md "Doc Versioning" | nothing | **PROSE ONLY** | Low — **3 / 9** `docs/*.md` comply |
| **"If you touch it, version it"** | global CLAUDE.md | nothing | **PROSE ONLY** | Med — needs diff awareness |
| **PROGRESS.md is the real-time source of truth** | `feedback_realtime_project_track.md`; MEMORY.md line 3 | nothing | **PROSE ONLY** | Low — **160 commits / 10 days stale** |
| Frontmatter key is `relates:` not `related:` | de facto | nothing | **PROSE ONLY** | Trivial — 20 use `relates:`, 2 use `related:` |
| Never retro-stamp ADRs 0001–0012 from inference | ADR-0034 anti-goals | nothing | **PROSE ONLY** | n/a — a prohibition, correctly prose |

### 3B. Versioning & shipping

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| Every push carries a version increment | `feedback_version_is_the_update_signal.md`; L05 | `version-bump-gate.sh` (exit 2) | **GATED** | done |
| One version source of truth; no stray literals | ADR-0009 d.1 | `sync-version.mjs --check` (CI) | **GATED** | done |
| "What's new in X" narrative matches shipping version | `feedback_narrative_version_sacrosanct.md` | `tests/unit/narrative-version.test.mjs` (CI + release gate C) | **GATED** | done |
| Ship runs BOTH suites | `feedback_ship_runs_both_suites.md` | `release.mjs` gates B+C | **GATED** | done |
| Walk every channel before "shipped" | `feedback_walk_every_channel_before_shipped.md` | pre-push + `release.mjs` gate E | **GATED** | done |
| Never `--no-verify` | pre-push header | nothing (it is the escape hatch) | **PROSE ONLY** | n/a — by design |
| Public surfaces carry exactly ONE version, never ranges | `feedback_visible_version_precision.md` | `sync-version.mjs` syncs values, does not detect ranges | **PARTIAL** | Low — regex for `\d+\.\d+\s*[–-]\s*\d+\.\d+` on public surfaces |
| **After every push, watch REMOTE CI to conclusion** | `feedback_verify_remote_ci.md` | nothing — no `gh run watch` anywhere | **PROSE ONLY** | Low — post-push hook or `release.mjs` gate F |
| **"Shipped" only after LOOKING at the live surface** | `feedback_shipped_means_live_surface.md` | `verify-channels` checks strings, not appearance | **PARTIAL** | High — needs render+grade |
| Announce clean restart moments | `feedback_announce_restart_moments.md` | nothing | **PROSE ONLY** | Med |

### 3C. Honesty & anti-fabrication

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| Status must be DERIVED, never asserted | ADR-0024 | `status-honesty.mjs` + `derived-status.test.mjs` (CI) | **GATED** | done |
| Every user-facing number regenerates from an artifact | ADR-0011; `feedback_product_never_lies.md` | `claims-verify.mjs` (CI) | **GATED** | done |
| Never hand-roll what rUv ships / wear his name | `feedback_never_impersonate_ruv_tools.md` | `no-silent-substitution.mjs` (CI) | **GATED** | done |
| No model/version fact from memory | ADR-0016; `feedback_rank_models_live_never_memory.md` | `catalog:verify` (CI) | **GATED** | done |
| Every scheduled job proves it ran | `feedback_positive_confirmation_every_job.md` | `job-heartbeat.sh` + `nightly-watchdog.mjs` (14 plists) | **GATED** | done |
| Private stores never ship publicly | SEC-0010 #5 | `private-fence.mjs` + 2 test files | **GATED** | done |
| **Never say "should be" / "probably up" about live state** | `feedback_confirm_never_assume_state.md` | nothing — text-level claim, no tool call | **PROSE ONLY** | High — no trigger exists |
| **Proof of WORKING, not written** | `feedback_proof_of_working_not_written.md` | `status-honesty` covers receipts only | **PARTIAL** | High |
| **Never grade your own work** | `feedback_never_grade_your_own_work.md` | `design-wall` enforces the *ritual*; the grade is still self-assigned | **PARTIAL — deliberately** | n/a — the file itself says a ritual gate cannot enforce taste |
| **Under-enumeration is a tell** (L10) | lessons.json | lesson ladder is advisory | **PROSE ONLY** | High |
| **RuvNet wins disagreements** | `feedback_ruvnet_wins_disagreements.md` | nothing | **PROSE ONLY** | High — judgement |

### 3D. Grounding & tool use

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| No rUv-domain code write without a fresh grounding stamp | ADR-0012; `feedback_gate_the_write_path.md` | `ground-before-write.sh` (exit 2) | **GATED** | done |
| Read a CLI's live interface before invoking it | `feedback_ground_interfaces_not_just_facts.md` | structured `ruvnet_cli_help` → `ruvnet_cli_run`; finite executable enum, literal argv, `shell:false` | **GATED** for the structured boundary; raw Bash advisory only | done |
| Mechanical work never runs in the main loop | `feedback_route_mechanical_work.md` | `route-dispatch.sh` (exit 2) | **GATED** | done |
| ONE global ruflo, never `npx ruflo@latest` | Rule 21; `feedback_one_global_ruflo.md` | `stack-currency.test.mjs`; raw Bash notice is advisory | **PARTIAL** | Low — enforce at install/config boundaries, not by parsing shell text |
| Subscription-first routing | `feedback_subscription_first_routing.md` | `route-cheap.mjs` / router profile — advisory | **PARTIAL** | Med |
| **Check `~/.claude/skills` before building any visual** | `feedback_use_the_tools_you_already_have.md` | nothing | **PROSE ONLY** | Med — a PreToolUse advisory on visual-build intent |
| **Inventory env keys/subs/CLIs before spending** | `feedback_inventory_before_you_buy.md` | `kling-preflight.sh` covers Kling only | **PARTIAL** | Med |
| **Architecture decisions get a cross-model duel** | `feedback_cross_model_architecture_duel.md` | nothing — ADR-0034 lists its own duel as ❌ outstanding | **PROSE ONLY** | Low — require a `## Duel` section in new ADRs |
| Research → present → discuss → build | Rule 11 / Rule 7 Decision Gate | L03/L14 lessons — advisory | **PROSE ONLY** | High |

### 3E. Visual & UX

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| Nothing visual ships/commits/opens ungraded (≥95) | `feedback_the_95_gate.md` | `design-wall.sh` (exit 2) + `design-grade.mjs` stamp | **GATED** | done |
| Gate blocks are auditable | — | `gate-receipt.sh` → `gate-blocks.jsonl` | **GATED** | done |
| **Measure effective px in the LIVE page, not the asset** | `feedback_measure_the_page_not_the_asset.md` | **`scripts/check-legibility.mjs` exists (10,114 bytes) and NOTHING invokes it** — no CI step, no import, no test, no plist | **BUILT, UNWIRED** | **Trivial — one CI line** |
| Crop every embedded screenshot to content | `feedback_crop_to_content.md` | nothing | **PROSE ONLY** | Med |
| Every list ranked by blast-radius × recency | `feedback_relevance_ordering.md` | nothing | **PROSE ONLY** | High |
| Present pages one-click (`open <path>`) | `feedback_open_pages_one_click.md` | nothing | **PROSE ONLY** | Low |
| Visuals information-first / first-look confidence | `feedback_information_first_visuals.md`, `feedback_first_look_confidence.md` | folded into the 95-grade judgement | **PARTIAL** | n/a |
| READMEs visual+vibrant; assets resolve after every edit | `feedback_readme_visual_vibrant.md` | `verify-channels` checks channels, not README assets | **PARTIAL** | Low — resolve every `![](…)` path |
| Canonical domain only (`isovision.ai`) | `feedback_canonical_domain_only.md` | `verify-channels.mjs` + `design-wall.sh` | **GATED** | done |
| Never ship broken slides / quality bar / UX review | 3 legacy feedback files | nothing (superseded in practice by the 95-gate) | **PROSE ONLY** | n/a — merge into the 95-gate |
| All scores out of 100, never /10 | `feedback_scores_out_of_100.md` | nothing | **PROSE ONLY** | Trivial to grep, **but see §0.3 — `k/10` hit-counts are indistinguishable from grades by regex; a naive gate false-positives on every benchmark table** |

### 3F. Process & session discipline

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| Finish authorized work; never stop to ask | `feedback_finish_the_loop_dont_ask.md`; L13 | `continuation-gate.mjs` (Stop hook, advisory by necessity) | **PARTIAL — by design** | n/a — a Stop hook cannot force a turn |
| Close the loop = close issue + personal thank-you | `feedback_thank_contributors_personally.md` | nothing in `issue-fix.mjs` | **PROSE ONLY** | Med |
| Re-score 8 dimensions at end of every session, ≥95 | `feedback_rescore_every_session_target_95.md` | nothing | **PROSE ONLY** | Med — SessionEnd hook |
| Recall memory before non-trivial decisions | Rule 19 | `agentdb-ensure.sh` surfaces `project-state-current` at SessionStart | **PARTIAL** | Low |
| Append-only `project-state-current-<epochms>` | Rule 19 (corrected 2026-07-12) | `agentdb-ensure.sh` reads latest by LIKE | **PARTIAL** | Low |
| Store lessons after meaningful work | Rule 19 | `learn-capture` / `learn-flush` hooks | **GATED** | done |
| Know the datetime; never guess | `feedback_always_know_the_datetime.md` | `date-awareness-fast.sh` (SessionStart) | **GATED** | done |
| Persist "always do X" the moment it is uttered | `feedback_realtime_project_track.md` | `correction-detect.mjs` + `lesson-seed.mjs` | **PARTIAL** | Low |
| No architecture thrashing | `feedback_no_thrashing.md` | nothing | **PROSE ONLY** | High |
| Nudge: correct, confident, never pushy | `feedback_nudge_make_the_right_thing_easy.md` | nothing | **PROSE ONLY** | n/a — style |
| Visualization work routes to Fable 5 / GPT-5.6 Sol | `feedback_visualization_model_routing.md` | `route-dispatch.sh` routes, does not pick by task type | **PARTIAL** | Low |

### 3G. Contribution & security

| Convention | Stated where | Enforced by | Status | Cost to gate |
|---|---|---|---|---|
| No secret ever reaches a remote | pre-push header | pre-push secret scan | **GATED** | done |
| No tracked file >5MB | `ci.yml` no-fossil guard | CI | **GATED** | done |
| High+ severity deps fail | `ci.yml` | CI | **GATED** | done |
| Private repo → must be added to `kb/PRIVATE-STORES.json` | `CONTRIBUTING.md:74` | `private-fence.mjs` fences what is listed; **nothing verifies the list is complete** | **PARTIAL** | Med — the gap is provably unclosable by grep |
| Never hardcode a version string | `CONTRIBUTING.md:89` | `sync-version.mjs --check` | **GATED** | done |
| Consent defaults OFF; per-launch token on mutations | `SECURITY.md:95-107` | `consent-no-blanket-yes.test.mjs`, `install-telemetry-consent.test.mjs` | **GATED** | done |
| Bundle Ed25519-signed | `SECURITY.md:113` | `sign-verify-roundtrip.test.mjs` + `verify-bundle.test.mjs` | **GATED** | done |

---

## 4. Ranking the PROSE-ONLY items — blast radius × observed violation rate

Violation counts are measured from the working tree and `git log` (352 commits), not estimated.

| Rank | Convention | Blast radius | Times actually violated (evidence) | Score |
|---|---|---|---|---|
| 1 | **ADR `updated:` / `impl:` / verified-in-sync** | High — every reader of every ADR acts on a possibly-dead plan | **22 of 34** ADRs missing `updated:`; **4 of 20** stamps older than their own last commit; **0** documents mean "checked against code" | **critical** |
| 2 | **Built ≠ wired ("Implemented" is a lie)** | High — capability reported shipped, does nothing | **5 in 24h** (capability-registry, lesson triggers ×5, global hook, `lesson-gate` exit-1, `check-legibility`); 8 commits in log about wiring something already "shipped" | **critical** |
| 3 | **`check-legibility.mjs` unwired** | High — the exact failure it was written for (8.1px, 2.9px diagrams) ships again silently | 1 known incident; the gate has been dormant since written | **high** |
| 4 | **PROGRESS.md real-time track** | High — MEMORY.md names it *the* source of truth; every session starts from it | **160 commits / 10 days** behind HEAD | **high** |
| 5 | **`Implemented` permitted by `adr-format.test.mjs`** | High — the gate certifies the value the architecture forbids | 2 ADRs green on an invalid status | **high** |
| 6 | **Remote CI watched to conclusion** | Med-High — "green" claimed from local gates | standing order written *because* it happened; no mechanism since | **med-high** |
| 7 | **DDD docs have no convention or gate** | Med — 8 docs, 4 header shapes, zero tests read the directory | 0005 and 0006 written same day in two shapes | **med** |
| 8 | **Doc header versioning** (`Updated:/Version`) | Med | **6 of 9** `docs/*.md` non-compliant | **med** |
| 9 | **Cross-model architecture duel** | Med — standing order since 2026-07-18 | ADR-0034 lists its own duel ❌ outstanding | **med** |
| 10 | **Scores out of 100** | Low — cosmetic | **0 confirmed.** The 3 apparent hits were hit-counts, not grades (§0.3). Do not gate: the false-positive rate is the whole story | **do not gate** |
| 11 | **`relates:` vs `related:`** | Low | 2 of 22 | **low** |
| 12 | Thank contributors personally | Low-Med — relationship cost, invisible in code | not measurable from the tree | **low-med** |
| 13 | Crop to content / one-click / relevance ordering | Low each | not measurable | **low** |

Items requiring judgement (never assume state, RuvNet wins disagreements, no thrashing, nudge) are
**deliberately excluded from the ranking.** They have no mechanical trigger, and inventing one would
produce the wolf-cry that gets every gate in the neighbourhood disabled. They belong in the lesson
store as advisory interrupts — which is what it is for.

---

## 5. Recommended top 5 to gate next, with the specific mechanism

Ordered by (blast radius × violation rate) ÷ cost. Each mechanism is chosen to fail loudly on a real
violation and never on a false one (constraint 3), and each derives rather than asserts (ADR-0024).

### #1 — Delete `'Implemented'` from the ADR status enum

**Cost: one line. Highest ratio in this document.**

`tests/unit/adr-format.test.mjs:53` currently reads:

```js
expect(['Proposed', 'Accepted', 'Implemented', 'Superseded', 'Deprecated']).toContain(s);
```

`Implemented` is not in rUv's enum (`ruflo-adr` REFERENCE.md: 0 occurrences — ADR-0034 §1 verified
it). It is the lie-shaped value that records an intention. Remove it; migrate ADR-0013 and ADR-0018
to `Accepted` + `impl:`. The gate then makes the fifth status **unwritable** rather than certified.

This must land *with* ADR-0034's `impl:` axis or it removes the only word people had. Do both or
neither.

### #2 — Wire `check-legibility.mjs` into CI. One line.

```yaml
- name: Effective legibility in the LIVE page (never the asset in isolation)
  run: node scripts/check-legibility.mjs
```

A 10KB gate implementing a standing order, written after diagrams shipped at 2.9px, has **zero
callers** — verified against CI, package.json, all hooks, all imports, all tests, and all 17 launchd
plists. This is not a proposal to build something; it is a proposal to connect something already
built and paid for. Before wiring, run it once against a known-bad fixture — a gate that has never
demonstrated a failure has not demonstrated anything (ADR-0024 Layer 2's pattern).

### #3 — The wired-check, generalized: `scripts/orphan-check.mjs`

This is the mechanical form of the repo's signature failure and of §4 rank 2.

**Mechanism.** For every `scripts/*.mjs` and `plugin/scripts/*.sh`, resolve whether it is reachable
from any of: a CI step, a `package.json` script, `hooks.json`, either `settings.json`, `pre-push`,
`release.mjs`, a launchd plist, a non-test import, or a test file. Emit `orphan` for zero hits.

**Warn, never block** — dynamic dispatch and hook-invoked scripts are legitimately unreachable by
grep, exactly as ADR-0034 §2 argues for `impl: wired`. A block here would fire on `hook-shim.mjs`'s
dispatch table on day one.

**Must be import-aware and plist-aware.** This audit's first pass produced two false positives
(`private-fence.mjs`, `status-honesty.mjs`) by checking only CLI invocation. Ship the checker with
both as fixtures that must read `wired`, and `check-legibility.mjs` as the fixture that must read
`orphan`. That is the self-proving shape ADR-0024 established.

**Cost:** ~80 lines + fixtures. **Kills:** the "built, tested, shipped, unreachable" class, which is
this repo's most expensive recurring mistake and the reason `impl:` needs four rungs.

### #4 — Extend the doc-currency gate to `PROGRESS.md` and `docs/ddd/`

ADR-0034 §"Deliberately NOT in this round" scopes to `docs/adr/` and `docs/ddd/`, and explicitly
excludes PROGRESS.md for lacking a code mapping. **PROGRESS.md's mapping is the whole repo**, and
MEMORY.md line 3 names it the source of truth. It is 160 commits stale.

**Mechanism.** Reuse ADR-0034 §5's two-clock drift test with the repo as the governed set:

- doc-clock = `git log -1 --format=%ct -- PROGRESS.md`
- code-clock = `git log -1 --format=%ct` (HEAD)
- **Warn** (never block) at ≥25 commits of drift, printed at SessionStart alongside the existing
  `project-state-current` recall.

25, not 1: writing code before updating the log within a session is normal, and ADR-0034 §5 fixes
the false-positive rate at zero as a design constraint. At 160 it is not a lag, it is an abandonment.

For `docs/ddd/`: pick one header shape (DDD-0006/0007/0008 already agree — `Updated:` / `Created:` /
`Governs`), then extend `adr-format.test.mjs`'s existing loop over the directory. **Cost: low**, and
it closes the one documentation directory that literally no test has ever opened.

### #5 — A post-push remote-CI receipt

**Mechanism.** Add gate F to `release.mjs`, and a `PostToolUse:Bash` hook matching `git push`:

```sh
gh run watch "$(gh run list -L1 --json databaseId -q '.[0].databaseId')" --exit-status
```

Write the conclusion to `~/.cache/ruvnet-brain/ci-receipts.jsonl` in `gate-receipt.sh`'s shape. Then
the claim "CI is green" becomes **derivable** — the same move ADR-0024 made for job receipts, applied
to the one claim that is currently made from local evidence about a remote system.

**Advisory, not blocking** — the push has already happened; blocking is meaningless. The value is
that "green" acquires an artifact. **Cost: low** (`gh` is installed at `/opt/homebrew/bin/gh`).

---

### The structural note that outlives these five

Four of the five above are one line, one wire, or one reuse of a mechanism that already exists. The
expensive part was never building gates — it was **knowing which conventions had none**, which
nobody had counted until this document.

So the durable recommendation is the meta one: **this audit should itself be a script, not a
document.** `docs/CONVENTIONS-AUDIT.md` is prose, and per its own thesis it will decay — its numbers
are already drifting (`scripts/doc-currency.mjs` came into existence during the writing of it). A
`scripts/conventions-audit.mjs` that re-derives §1's compliance table and §3's GATED/PROSE column on
every run would make this map self-maintaining, and would satisfy the owner's actual request — not
"remind me of the rules" but **"stop needing to be reminded."**

---

## 6. What I did NOT check — stated so the coverage is not overclaimed

- **`clones/`** (68 upstream repos) — not audited. rUv's own conventions are out of scope, except
  where ADR-0034 grounded the `ruflo-adr` status enum.
- **`kb/`** (866 entries) — excluded from grep sweeps for time. KB-forge scripts may carry their own
  conventions.
- **Skills** (`plugin/skills/*/SKILL.md`, 5 files) — read for existence, not line-by-line for
  imperatives.
- **Whether each gate actually fires.** I verified wiring — that a mechanism is invoked by CI, a
  hook, or a test. I did **not** execute each gate against a known-bad fixture. ADR-0024's standard
  is that a check which cannot demonstrate failure has demonstrated nothing; by that standard the
  GATED column is *wiring-verified, not efficacy-verified.* Only `derived-status.test.mjs`,
  `no-silent-substitution.test.mjs`, `version-bump-gate.test.mjs` and `adr-format.test.mjs` are known
  to carry prove-FAIL fixtures.
- **The 46 standing orders were read at description level**, not in full body. A rule stated only in
  a file's body, never in its `description:`, could be missing from §3.
- **Violation counts for judgement-class conventions** (never assume state, no thrashing, nudge) are
  unmeasurable from the tree and are marked as such rather than estimated.
- **`~/.claude/settings.local.json`** contains no hooks (verified) but its permissions block was not
  audited.
