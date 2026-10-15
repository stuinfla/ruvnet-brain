---
id: ADR-106
title: The hook standard — one registration per role, refuse only on a fact, AgentDB before and after decisions
status: Proposed
date: 2026-10-11
updated: 2026-10-13 14:55:00 EDT
version: 0.6.1
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [hooks, agentdb, decisions, continuity, codex, claude-code]
relates: [ADR-0012, ADR-040, ADR-043, ADR-054, ADR-067, ADR-074, ADR-075, ADR-100, ADR-103, ADR-105]
amends: [ADR-105]
---

# ADR-106 — The hook standard

**Status**: Proposed

Written on the owner's 2026-10-11 direction: the smallest set of hooks that forces the rules a fact
can prove, with AgentDB read before a decision and written after it. The implementation is on branch
`hooks/standard-20261011`. ADR-075's dual-seat review and ADR-103's independent review stamp are
owed; neither has been run on this text or its code.

## Context

Measured on 4.6.3 (2026-10-11): Claude registered 20 hook commands and Codex 19, all through
`hook-shim.mjs`. Four facts drove this decision.

1. An advisory body that crashed exited 0 to the host with nothing on disk. The host hides stderr on
   exit 0, so a dead Stop gate was indistinguishable from a quiet one.
2. AgentDB recall ran on every eligible prompt, but its receipt was never kept. No later check could
   prove a decision had consulted history, and ADR-105 §8 decision records had no writer.
3. Three registrations (`learn-flush` at SessionStart and SessionEnd, `learn-capture` at PostToolUse)
   only started or fed a detached learning worker from payloads another registration already read.
4. The Stop deferral to a user-level turn writer (ADR-100 §3) could never fire; its probe never
   reported a writer.

Codex trust is keyed by position and command hash (`scripts/codex-hook-trust.mjs`). An edited or
shifted entry stops on every Codex machine until it is trusted again.

## Decision

1. **One registration per role.** A hook registration exists only when its event carries a fact no
   other registration already reads. Consolidation removes trailing groups only and never edits a
   surviving command, so Codex trust keys and hashes stay valid. Measured for this change: 16 of 16
   surviving Codex identities unchanged.
2. **Refuse only on a fact.** decision-gate stays the one PreToolUse refuser (ADR-067). At Stop there
   are two correctors: continuation-gate (ADR-043) and grounding-turn-gate. The second stays separate
   because its header records that folding it in would corrupt the continuation ledger semantics. A
   new rule is a policy or check inside one of them, never a new registration. A refusal happens at most once per path per session. Judgement
   rules stay advisory, and no hook claims to enforce them.
3. **AgentDB before and after a decision (ADR-105 §8).**
   - *Before*: `decision-recall` policy. Creating an ADR, or changing an ADR's status line, in an
     adopted project needs a `decision-record.mjs --consult` receipt younger than two hours. Without
     one, the write is refused once. A receipt that reports history unavailable allows the write and
     says so, so an AgentDB outage cannot wedge decisions.
     - The receipt is keyed by project, not topic. It proves a consult of this project's decisions ran
       in the last two hours. It does not prove the consult covered this decision.
     - "Status change" compares every status line of the document (frontmatter `status:` and body
       `**Status**:`) before and after the edit, ignoring fenced code. This covers Edit, MultiEdit, a
       whole-file Write over an existing ADR, and a Codex `apply_patch` Update File hunk (its removed
       and added status lines are compared). Known bypasses: a Bash redirect into an ADR, and a status
       wording a patch hunk changes only through context lines it does not show.
     - The once-per-path acknowledgement is recorded when this policy refuses. When another policy
       also refuses the same call, decision-gate names this refusal in its reason, and the retry then
       passes this policy. Two simultaneous writes can lose an acknowledgement, which refuses once more.
   - *After*: continuation-gate asks once when a Claude turn created an ADR (transcript Write result
     `create`) with no later successful `decision-record.mjs --record`. On Codex the rollout is not
     parsed, so this check is not enforced there and nothing is claimed.
   - `decision-record.mjs` implements the §8 record: validate, redact, then bound, and key
     `decision-<slug>-<stamp>`. It writes through the §3 door, and only an exact readback commits a
     record. A refused or unverified write returns `refused`, writes one hook-failures row and prints
     `NOT recorded`; nothing is kept on disk for a replay. The CLI records `host` as `cli` when
     neither host is identified. Supersession is computed from newer ratified records, and recall
     drops a superseded record and says how many it withheld, on both the prompt and the
     consequential block.
     - Only a ratified record may supersede. A `detected-unconfirmed` record with `--supersedes` is
       refused before anything is written: a detected record is evidence, never authority.
     - `--supersedes` refuses a key unless it reads back as a decision record of this project. The
       store is append-only, so a wrong key could not be undone.
     - Each superseded key also gets a tombstone row `supersession-<old key>`. Recall reads tombstones
       from the key enumeration it already does, so a superseder that ranking or the deadline left out
       still retires the old decision. A second superseder of the same decision finds the earlier
       tombstone and reports it as already stored, not as a conflict.
4. **Failure is a status line.** The shim appends one bounded line per failed advisory run (nonzero
   exit, signal or spawn error). SessionStart prints one `[RuvNet Brain — HOOK FAILURES]` summary of
   new failures. Nothing is printed per fire. Limits:
   - The cursor is per machine, so the first session after a failure reports it, once.
   - Unread rows beyond the 256 KiB rotation are lost.
   - The ledger covers body failures only. If the shim itself cannot load, the `|| true` suffix on the
     Claude commands hides it and nothing is recorded. Removing `|| true` would make that failure
     visible as a host hook error and costs no Codex trust. It is not done in this slice: the suffix
     is referenced by 12 test files, and per-fire hook errors are the owner's recorded complaint
     (`hook-shim.mjs` notice comment).
5. **No deferral of authorized work (`no-deferral`, in continuation-gate).** On Claude, a final
   answer is asked ONCE to continue when all three hold:
   - its last ~700 characters seek permission ("say go", "want me to", "should I", "do you want",
     "let me know if", "decisions I need from you", "waiting on your") or list its own next actions as
     future work ("Next:", "Remaining:", "I'll … when/once/later");
   - authorization exists: a standing instruction in the session's owner prompts ("don't stop", "keep
     going", "get it done/shipped", "finish", "until done", "just do it", …) or an open promise of this
     session in the work ledger;
   - the answer names no genuine blocker class: missing credential, hardware-key/2FA tap, write
     outside the stated authority (user-level, publish needing a human-only step), irreversible
     action needing consent, evidenced outage, background work still running, an action only the
     owner can physically do, a purchase, or a choice between named options.
   The answer is not flagged when it says work is continuing or that nothing is needed from the owner.
   Authorization is SESSION-WIDE and topic-blind: a standing phrase in any earlier owner prompt
   authorizes the whole session (known limit, independent review finding F1; scoping it to the most
   recent prompts is follow-up work). The blocker lists are broad by design, so an incidental word can
   clear a deferral (finding F2); the false-negative rate is unmeasured.
   Loop safety: `stop_hook_active` limits it to one force per natural stop, and a per-prompt counter
   caps forces at 3. A deferral still present on the continued stop is recorded once in the
   hook-failures ledger ("deferral not resolved") and reported at the next SessionStart.
   `RUVNET_NO_DEFERRAL=off` disables it.
   *Codex:* the detector is shared and pure, but the Codex rollout's prompts are not parsed, so
   authorization cannot be shown there. The check is not enforced on Codex and nothing is claimed.
   *Measured* with `npm run deferral:replay` on this machine's real Claude transcripts (2026-10-11):
   - 99 transcripts and 2,023 turns. 55 turns would be forced (2.7%).
   - All 55 were hand-classified: 47 true deferrals, 8 false positives, so the false-positive rate is
     15%. Typical false positives are a status report with a permission phrase mid-answer, a wait on
     a running review the detector did not recognize, and a clinician-only question.
   - This is a resubstitution estimate: the phrase and blocker lists were tuned on these same turns,
     and no unseen transcript set with standing instructions was left on this machine. The true
     false-positive rate on new transcripts is likely higher.
   - Held-out false-positive and false-negative rates are UNMEASURED. The 15% figure is a tuning-set
     estimate and must not be quoted as accuracy. A credible held-out check needs at least 60 flagged
     and 60 unflagged turns from transcripts not used for tuning, a rubric written before the run,
     frozen phrase and blocker lists, Wilson intervals, and sessions with no standing instruction.
   - The "decisions I need from you" pattern counts as a deferral because the owner named it so. Some
     of those decisions are genuinely the owner's; they still get one correction, after which the
     answer may stand.
   - Not measured: false negatives (deferrals the detector misses), and how the host acts on the
     forced continuation.
6. **Prompt and tool boundaries return in constant time; the shim stops a body before the host does.**
   - The owner hit `UserPromptSubmit hook … timed out after 10s — output discarded` on 2026-10-11. The
     cause: `session-snapshot` at UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure and
     SubagentStop ran the capture-queue replay inline, with one native store write per queued item
     and a budget of up to 6.5 s. Under load and with queued debt, every boundary spent that budget.
   - Those boundaries now only check consent and identity, fsync the observation into the durable
     queue, start the detached replay worker, and return. No native write runs inline.
   - A queued, handed-off observation is the normal state and prints nothing. Only an unwritable
     queue, or queued work older than 10 minutes, is reported. Stop, PreCompact and SessionEnd keep
     their own bounded synchronous budgets. The worker still commits each item only by exact readback.
   - Watchdog (Claude): the shim reads the registered timeout of the exact command from the manifest
     it was registered from and kills the body at that timeout minus 1.5 s. It then records one
     `timed-out-internally` line in the failure ledger, writes nothing partial (stdout is captured
     and forwarded only on normal completion), and exits 0. SessionStart's own restore deadline is
     aligned to the watchdog, so it now plans within 6.5 s instead of 7.75 s.
   - Under Codex the stable wrapper already kills the process group below the host timeout, so the
     shim adds no second watchdog. A second, shorter one would pre-empt the wrapper and orphan the
     body's children; `decision-gate`'s outer-timeout test proves the orphaning when it is added.
   - The Claude watchdog kills only the direct child, so a grandchild of a killed body can outlive it.
     Bodies that spawn children keep their own deadlines (decision-gate, session-snapshot).
   - FAIL-OPEN, NAMED: a body killed by the watchdog exits 0, which the host reads as ALLOW. If
     decision-gate (the one process that may refuse) is killed it therefore fails open. Its own 2 s
     policy budget sits under the 3.5 s watchdog, so this occurs only under extreme load, and it is
     recorded as `timed-out-internally`. A body that backgrounds a child holding its stdout would be
     held until the watchdog and lose its whole output; every registered detached spawn uses
     `stdio: 'ignore'`, and the unregistered `anticipate.sh` is the only known violator.
   - Measured with the same fixture (adopted store, every native write delayed 3 s, load average
     11): prompt and tool boundaries took 3,399–3,846 ms each before and 197–245 ms after (8 fires
     each). With 6 boundaries queued, the detached worker drained all 6 by exact readback
     (`tests/integration/hook-latency-budget.test.mjs`).

   **Audit of every registered command** (Claude, slow fixture, worst of 3 fires, load average 8–10,
   after the fix; "path bound" is the code's own deadline):

   | Event | Command | Claude timeout | Watchdog | Measured max | Path bound |
   |---|---|---|---|---|---|
   | SessionStart | session-start | 8 s | 6.5 s | 389 ms | restore deadline aligned to the watchdog |
   | UserPromptSubmit | session-snapshot | 10 s | 8.5 s | 236 ms | queue + detached worker only |
   | UserPromptSubmit | unprompted-speech | 9 s | 7.5 s | 542 ms | producer budgets inside the runtime |
   | UserPromptSubmit | ground-ruvnet | 10 s | 8.5 s | 893 ms | recall 1.9 s shared deadline |
   | UserPromptSubmit | capacity-aware-parallel-work | 6 s | 4.5 s | 122 ms | bounded resource samples |
   | UserPromptSubmit | grounding-turn-mark | 5 s | 3.5 s | 147 ms | marker write |
   | PreToolUse | session-snapshot | 10 s | 8.5 s | 191 ms | queue + detached worker only |
   | PreToolUse | decision-gate write | 5 s | 3.5 s | 460 ms | 2 s policy budget, parallel policies |
   | PostToolUse | session-snapshot | 10 s | 8.5 s | 201 ms | queue + detached worker; learning capture is a file write |
   | PostToolUse | grounding-stamp | 5 s | 3.5 s | 171 ms | stamp write |
   | PostToolUseFailure, SubagentStop | session-snapshot | 10 s | 8.5 s | 216 / 319 ms | queue + detached worker only |
   | Stop | continuation-gate | 10 s | 8.5 s | 172 ms | 2 MiB transcript tail, local ledgers |
   | Stop | session-snapshot | 10 s | 8.5 s | 462 ms | 8 s capture budget |
   | Stop | grounding-turn-gate | 10 s | 8.5 s | 164 ms | transcript tail |
   | PreCompact, SessionEnd | session-snapshot | 10 s | 8.5 s | 483 / 537 ms | 8 s capture budget |

   Codex: the 16 wrapper budgets sit 0.5–1.0 s under their Codex timeouts (SessionEnd 2.5 s under a
   3 s clamp). Widening that margin to 1.5 s would edit every Codex command and force all 16 hooks to
   be trusted again, so it is not done here.
   - Not measured: a real loaded owner machine, a real ruflo, the Stop-side 8 s capture budget hit
     end to end, and Codex.
7. **Single writer.** The dead user-level deferral is removed. The product is the only writer of
   project turn history, which closes ADR-105 rule 7.

### This slice's set (17 Claude, 16 Codex; the design target is 15 and 14)

| Event | Registration | Enforces | Mode |
|---|---|---|---|
| SessionStart | session-start (+ learning recovery) | verified restore; knowledge currency; hook-failure summary | disclose |
| UserPromptSubmit | unprompted-speech · ground-ruvnet · capacity-aware-parallel-work · grounding-turn-mark · session-snapshot | sole speech writer; grounding + exact-first recall; capacity hint; grounding arm; observation | advise / record |
| PreToolUse | session-snapshot · decision-gate write | observation; protect-state, managed-memory, ground-before-write, **decision-recall**, adr-currency, duplicate-code | record / refuse |
| PostToolUse | session-snapshot (+ learning capture) · grounding-stamp | observation and consent-gated learning; grounding receipt | record |
| PostToolUseFailure (Claude) · SubagentStop · PreCompact | session-snapshot | observation; pending work kept | record |
| Stop | continuation-gate · session-snapshot · grounding-turn-gate | completion, promises, capability claims, **decision record**, **no-deferral**; turn outcome; answered-without-searching | force once / record |
| SessionEnd | session-snapshot (+ learning recovery) | final state | record |

## Not enforceable by a hook

- Rules whose only evidence is quality or authority stay advisory. Examples are cross-model review,
  "never grade your own work" and visual 95 gates.
- Registry rules that name PreToolUse Agent/Task as their enforcement point (P003, P004, P005, P057,
  P061) cannot be enforced there on Claude. The host consumes that result after dispatch
  (`hook-shim.mjs` `route-dispatch` note, #84). They belong in the dispatcher (ADR-075).

## Deferred

- Folding `grounding-turn-gate` into continuation-gate is deferred. Its header records why merging
  would corrupt the continuation ledger semantics.
- Folding `grounding-turn-mark` into `ground-ruvnet.sh` is deferred.
- Generating `codex-hooks.json` from one table is deferred. It rewrites every Codex command hash.
- Binding each learned-registry rule to its enforcing check is deferred. The registry is not tracked
  in this repository.

## Consequences

- Each prompt, tool call and session costs fewer processes. Learning still runs through the same
  bodies.
- ADR authoring gains one bounded wall. `RUVNET_DECISION_RECALL_GATE=off` and
  `RUVNET_DECISION_RECORD_CHECK=off` disable the two decision checks, and `RUVNET_AGENTDB_FIRST=off`
  disables both.
- `hook-shim.mjs` changed, which is a shell change. It takes effect after a host restart.
- Measured cost of the folds (isolated fixture, 7 runs, load average 10-17):
  - SessionEnd under the Codex clamp (`RUVNET_CODEX_BUDGET_MS=2500`): `session-snapshot SessionEnd`
    median 151 ms with the learning fold and 120 ms without it, so about 31 ms. The separate
    `learn-flush` process it replaces had a median of 96 ms.
  - In a real adopted store the snapshot can use its whole 2.2 s budget. The import and spawn then
    run after it and can be cut off by the 2.5 s wrapper kill. A missed schedule is retried by the
    next SessionStart.
  - PostToolUse: `session-snapshot PostToolUse` median 338 ms with learning enabled and 337 ms with it
    off. The separate `learn-capture` process it replaces had a median of 117 ms.
- `tests/unit/hook-registry-lint.test.mjs` ("counts the code-copy MIRRORS") is red by design on this
  branch. The installed plugin mirror at 4.6.3 declares 20 registrations, and this tree declares 17
  at the same version. The test accepts fewer registrations only when
  `plugin/.claude-plugin/plugin.json`'s version is newer than the installed mirror's. The version bump
  is the release integration owner's step (CONTRIBUTING.md), so it is not done here.

## Currency log

| 2026-10-11 | Drafted with implementation on `hooks/standard-20261011`. | Author-run focused tests and mutation checks only; no independent review. |
| 2026-10-11 | Constant-time prompt/tool boundaries, shim watchdog, timeout audit, after the owner's live 10 s timeout. | Author tests and mutation checks only; no stamp. |
| 2026-10-11 | Added `no-deferral` on the owner's direction; replay-measured 15% resubstitution false-positive rate (55 flagged turns of 2,023). | Author tests and mutation checks only; no stamp. |
| 2026-10-11 | Re-review (Fable, REVISE on f65280ce): only ratified records supersede; repeat tombstones are not conflicts; withheld count printed; apply_patch updates and body status lines checked. | Author tests and mutation checks only; no stamp. |
| 2026-10-11 | Revised for an independent review (Fable, REVISE): tombstones, `--supersedes` validation, whole-document status, fenced-code status, Stop wording, honest limits. | The review is not a stamp of these bytes. The ADR-103 review stamp and the ADR-075 dual-seat review are still owed. |
| 2026-10-13 | The thirteen lost-recall todos are now a named register in the 4.7.0 amendment; the nine in the gated recall test were removed because release qualification refuses todo cases. | Author edit only; no stamp. |

## Amendment — 2026-10-12: hooks only call rUv's memory tools (4.7.0)

**Status stays Proposed.** This amends the registration table and withdraws one measurement; it carries
no review stamp. The single-seat review record is in ADR-103.

**Owner ruling (permanent).** Our hooks may only CALL rUv's tools (`ruflo memory store|retrieve|search|list|backup|distill`,
`ruflo hooks ...`). They never rebuild rUv's storage: no private store, queue, outbox, journal or replay
worker for agent memory. Anything of that kind is removed, not bounded.

**Why the earlier figures are withdrawn.** The "Measured max" column above (389 ms SessionStart, 236 ms
snapshot) came from small stores. On a live-size copy of the owner's store on 2026-10-12, 4.6.4's Stop
snapshot ran 8,611 ms and was killed by its own watchdog (limit 8,500 ms) at five of five Stop events;
SessionStart ran 6,573 ms and was killed. The cause was the project-progression snapshot layer (added
2026-08-22 and 2026-09-11, before this ADR): every snapshot carried the project's whole command history
(up to 912 KB), and a 3.38 GB outbox was never compacted. Nothing in this ADR bounded that layer.

**What 4.7.0 does.** The progression store/outbox/producer/reader/sources/hook/session-start/checkpoint,
the capture queue, the transition hook, the continuity journal and brief, the learning queue/flush/worker
and the turn transport journal are deleted. Registrations fall from 17 to 13 on Claude (the
session-snapshot registrations on UserPromptSubmit, PreToolUse, SubagentStop and PostToolUseFailure did
no work and were removed) and to 13 on Codex. The remaining work is:

| Event | Writes / reads, all through `ruflo` |
|---|---|
| SessionStart | `memory list` + `memory retrieve` of the newest `project-state-current-*` by exact key, and the lesson keys |
| Stop | `memory store` of the turn outcome (namespace `turns`, `--no-upsert`, append-only) then an exact-key `memory retrieve`; a refusal or unverified readback is one row in the hook-failures ledger, shown at the next SessionStart |
| PostToolUse | consent-gated `memory store` of one redacted observation, same exact readback |
| PreCompact, SessionEnd | `memory store` of a `project-state-auto-<ms>` checkpoint with exact readback; `memory distill run` detached and bounded |
| Per prompt | one `memory search` plus exact reads, replacing about ten concurrent searches |

**Measured (live-size copy of the owner's 988 MB store, load 7-17; before the final rewrite).** Stop
129-151 ms, SessionEnd and PreCompact about 1.3 s, SessionStart 1.3-1.5 s, recall 640-657 ms with
results (it timed out at 1,495 ms before). **Not measured:** Stop with the inline store under real
ruflo (estimated 1-2 s), and any of this on the installed plugin. Treat these as a design check, not as
a limit.

**Capabilities reduced or removed, stated plainly.** SessionStart no longer carries the structured goal /
next-action / acceptance contract, concurrent-session conflict reporting, or the "come up to speed"
brief. Automatic capture of commits, tags, gate outcomes, agent findings and detected decisions is gone
(manual `ruflo memory store` through `/rnb-brief` remains). Recall is exact reads plus one search, not
ranked search across lessons, patterns, turns and continuity events. Learning loses per-session dedupe,
batching and retry of failed writes.

**Register of recall capabilities lost vs 4.6.4.** This list is the register. An `it.todo` is not
coverage, and the release qualification refuses todo cases, so the nine entries that sat in the gated
`tests/unit/agentdb-recall.test.mjs` were removed from it on 2026-10-13 and are recorded here instead.
The four in the ungated `tests/unit/agentdb-recall-native.test.mjs` remain there and are listed here
too. Restore any of them by extending the single `ruflo memory search`, never by rebuilding a reader
beside rUv's. Recall no longer:

1. searches curated lessons and patterns while excluding transcript telemetry despite its high score;
2. runs real child processes for both namespaces and full-value recall in an isolated cwd with the daemon off;
3. refuses to inject previews when exact-key retrieval times out;
4. recalls relevant automatic OUTCOME knowledge stored only in turns, not session metadata;
5. is proven by running the actual registered Claude command and the Codex launcher/adapter with source candidate bytes;
6. reads exact project observations from the authorized store during normal prompt recall;
7. distinguishes disabled, not-adopted and valid-empty from malformed-search unavailability;
8. guarantees that a successful CLI parent cannot leave an owned pipe-free grandchild running on POSIX;
9. recalls short typed continuity decisions while rejecting commit and gate telemetry;
10. prunes empty namespaces and reads exact values without additional CLI boots or mutation;
11. delivers exact curated records within 600 bytes when ranked search is hung;
12. delivers exact curated records within 600 bytes when ranked search is below threshold;
13. avoids reporting ok-empty when the curated state read is unavailable but ranked search succeeded empty.

**Still not our code to be proud of.** `lesson-store.mjs` keeps its own `lessons.json`, `lesson-bridge.mjs`
reads the ruflo database directly, `decision-record.mjs` keeps refusals on disk, and
`turn-outcome-capture.mjs` keeps local receipt and dedupe files. The write-time wall lists the last as
known debt. Each is a violation of the ruling above until it is replaced by a `ruflo` call.

