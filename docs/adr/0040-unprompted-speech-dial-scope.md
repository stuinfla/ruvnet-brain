---
id: ADR-040
title: What the advocacy dial actually governs — chokepoint, or honest per-channel controls
status: Accepted
date: 2026-07-23
updated: 2026-09-11
authors: [Stuart Kerr, Claude Code]
tags: [proactive, advocacy, dial, chokepoint, honesty, 4.0]
supersedes: []
relates: [ADR-027, ADR-028, ADR-030, ADR-032, DDD-0004]
---

**Status**: Accepted (2026-07-23)

Design converged; NOT yet Implemented (that waits for the tests under §Decision to be green).

Governed DDD: `docs/ddd/0004-advocacy-context.md`

## The problem, from a live-source check (not recalled)

An independent regrade (Fable 5, 2026-07-23) found the console presents the `advocacy` setting as
"How much it volunteers" — *the* volume knob on unsolicited behaviour — but it is not:

- `plugin/scripts/anticipate.sh` reads the dial **itself** (`advocacyLevel()`, its own settings read).
- `scripts/lesson-gate.mjs` reads **no** setting at all — a user who sets `advocacy: off` still gets
  lesson advisories on every matching trigger.
- `plugin/scripts/md-stamp.mjs` rewrites the user's files governed only by an env var
  (`RUVNET_MD_STAMP=0`) that no console surface exposes.
- In `plugin/hooks/hooks.json`, `anticipate.sh` and `lesson-hooks.sh` are wired **bare**
  (`bash … || true`), while every other hook routes through `hook-shim.mjs` (verified in hooks.json).

`docs/ddd/0004-advocacy-context.md` §"The enforcement chokepoint" (v1.1.0) already mandates the fix
and states the invariant verbatim: *"Every unprompted utterance passes through ONE runtime that reads
the level and the DismissalLedger and alone decides whether bytes reach the user… Raw text from an
emitter is a protocol violation."* It also promises **a registry test that fails if any emitter is
wired to anything other than the runtime** — that test does not exist. So the DDD describes a world the
code does not implement: the classic stale-plan failure this repo punishes.

**Two honest ways to reconcile plan and code. This ADR picks one; the Fable-5 vs GPT-5.6 duel decides
whether the pick survives.**

## The fork

- **(A) Implement the chokepoint.** One runtime consults the level + ledger; emitters return structured
  candidates (`{channel, findingId, severity, observationHash, copy}`), never raw bytes; a registry
  test asserts on real process stdout that no advocacy/promotion emitter is wired off-runtime.
- **(B) Retract the chokepoint mandate; make per-channel controls honest.** Keep each emitter reading
  its own control, but (i) the console stops claiming the advocacy dial is *the* volume knob and names
  exactly what each dial governs, (ii) every unprompted channel has a visible control, (iii) a test
  asserts the console copy matches what each channel actually reads.

## Decision (Accepted 2026-07-23 — the duel resolved it)

**CONVERGED: GPT-5.6's captured-stdio delivery runtime, WITH Fable 5's per-channel policy — a single
seam that OWNS the bytes, not a single consent policy. Lessons stay OUT of the advocacy dial.**

The seam is `plugin/scripts/unprompted-runtime.mjs`: the SOLE writer of user-facing bytes for
unprompted hooks. `hook-shim.mjs` invokes it under one id (`unprompted-speech`) with the Claude Code
event name as argv. It spawns the real producers (`anticipate.sh`, `lesson-gate.mjs`) as CAPTURED
child processes (`stdio: 'pipe'`, never `'inherit'`), reads one candidate-JSON line per emission
(producers emit candidates only under `RUVNET_EMIT_CANDIDATES=1`; unset, they behave exactly as
today — purely additive), applies per-channel policy, and writes the final envelope itself. Advisory =
exit 0 with `{hookSpecificOutput:{hookEventName, additionalContext}}`; block = exit 2, reason on
stderr, stdout empty; invalid JSON / unknown channel / raw non-JSON bytes on an advisory path are
silently dropped — which is what makes "raw bytes are a protocol violation" mechanically true.

Per-channel policy the runtime dispatches on `candidate.channel`: **advocacy** → advocacy dial +
DismissalLedger (`shouldStillOffer`); **promotion** → onboarding policy + advocacy level; **lesson** →
NEVER the dial, only the lesson frequency cap + blocking opt-in (`lesson-gate.mjs` owns this, ADR-030);
**alarm** → always delivered.

### How the duel decided it

The recommendation below was a hybrid leaning (B)-for-lessons and (A)-for-advocacy. Fable 5 and
GPT-5.6 each attacked it, and each corrected a real error in the other's position:

- **GPT-5.6 corrected Fable 5's "byte-interposition is unenforceable" claim.** Fable 5 argued full (A)
  over-engineered a deploy-ceilinged pillar and that a runtime could not truly own the bytes without a
  boot-frozen ABI, so per-channel honesty (B) was the safe pick. GPT-5.6 showed this was wrong: by
  spawning producers as CAPTURED children (`stdio: 'pipe'`) and being the only process that writes to
  the real streams, the seam DOES own every byte — no ABI change to the producers is needed, only an
  additive `RUVNET_EMIT_CANDIDATES` mode. The "minimum honest = just keep anticipate reading the dial +
  add a test" fallback in the recommendation was therefore too weak: it left lesson/promotion emitters
  still writing bytes directly. Full (A)'s delivery guarantee is achievable and is the honest floor.

- **Fable 5 corrected GPT-5.6's lessons-category error.** GPT-5.6's first-pass (A) routed *all*
  unprompted speech — lessons included — through the advocacy dial as one consent policy. Fable 5's
  standing objection held: a ratified lesson is the user's own opted-in words, not something the brain
  volunteers, so putting it under an "advocacy volume" knob mis-models it (this is recommendation
  point 2, and it survived). The convergence keeps GPT-5.6's runtime but adopts Fable 5's per-channel
  split: the seam gives every channel the same *byte-ownership* guarantee WITHOUT giving them the same
  *consent* rule. Lessons keep their own cap + opt-in; advocacy keeps the dial + ledger; alarm bypasses
  both.

The net: neither pure (A) (one policy for all) nor (B)/hybrid (emitters keep writing their own bytes)
was right. The seam that owns delivery for everyone, with a policy table that treats the channels as
the different categories they are, is what both reviewers could sign.

### Why Accepted and not Implemented

The design is ratified; the code is not yet proven. Status flips to Implemented only when the seam
exists and these tests are green — each proving an invariant by breaking the thing it guards:

1. An opted-in BLOCK lesson still exits 2 with byte-empty stdout (a refusal is never swallowed).
2. `advocacy=off` → an advocacy candidate yields exit 0 and byte-EXACT `stdout === ""`.
3. A rogue producer printing raw bytes instead of candidate JSON → NOTHING reaches either user stream
   on the advisory path.
4. Adding a bare `bash rogue-emitter.sh || true` unprompted line to `hooks.json` → the registry test
   (`tests/integration/unprompted-speech-registry.test.mjs`) FAILS.

DDD-0004 §"The enforcement chokepoint" is reconciled in the SAME work (bumped to v1.3.0): narrowed to
this delivery seam, with an honest retraction that its v1.1.0 "proven by a registry test" claim named a
test that did not yet exist.

## Recommendation (superseded by the Decision above — retained as the pre-duel input)

**A HYBRID, leaning (B)-for-lessons and (A)-for-advocacy, because the two channels are different
categories and collapsing them is itself a modelling error:**

1. **Capability advocacy + promotion** (the brain volunteering *its own* capabilities — `anticipate.sh`)
   is what DDD-0004's chokepoint is really about. It SHOULD converge on one dial. But the full
   "structured-candidate runtime" is a large boot-frozen shell change (`hook-shim.mjs` TABLE +
   hooks.json rewrite, both `requiresRestart`); the *minimum honest* version is: anticipate already
   reads the one dial; keep it, and add the missing **registry test** that fails if it is ever wired to
   emit without the dial in its path.
2. **Lessons are NOT advocacy.** A ratified lesson is the *user's own words*, opted into; forcing it
   under an "advocacy volume" dial mis-models it. Lessons already have their own controls (the
   per-session cap `RUVNET_LESSON_MAX_SHOWS`, and blocking opt-in). The fix here is **honesty**, not a
   chokepoint: the console must say the advocacy dial governs capability-advocacy, and that lessons /
   md-stamp are separate channels with their own named controls.
3. **The single testable invariant that makes this non-cosmetic:** a test that reads the console's
   dial *copy* and asserts it names every channel the dial does and does not govern — so the copy can
   never again claim to be the volume knob for behaviour it does not touch.

## What the duel must resolve

- Is the hybrid right, or is it a dodge that ships DDD-0004's violation with better copy? (GPT-5.6,
  argue that only full (A) is honest.)
- Is full (A) over-engineering a deploy-ceilinged pillar — a structured-candidate runtime that adds a
  boot-frozen ABI surface for a dial two emitters could read directly? (Fable 5, argue (B)/hybrid.)
- Whichever wins, DDD-0004 must be reconciled in the SAME work: implemented, or its chokepoint section
  retracted with a note — never left describing a world the code does not have.

## Consequences

Neither branch moves the Proactive/Self-impl score to 95 — that is deploy-gated (real ledger data +
the spine flip), established by two independent regrades. This ADR is about **honesty and modelling**,
which is worth doing on its own terms. Decision + duel transcript land in this ADR before any build.

## Amendment 2026-09-11 — a second owner at UserPromptSubmit, outside the speech seam

**Change.** `ground-ruvnet` (plugin/scripts/ground-ruvnet.sh) is registered at UserPromptSubmit again, beside
`unprompted-speech`. It was registered there until 00526b12 (2026-09-07) retired every automatic gate; the
retirement left the plane with no prompt-level grounding at all, and on 2026-09-11 the failure ADR-0011/0012
exist to prevent recurred in this repo — a "configuration dashboard" was built without asking the brain whether
one already existed (it did: `console/`, RVBC). Stuart: *"the fact that you don't have a hook set up to do that
means you're a toy versus a solution."*

**Why this does not violate the invariant.** The Decision above makes `unprompted-runtime.mjs` the SOLE writer
of *unprompted user-facing bytes* — advocacy, promotion, lesson and alarm candidates, governed by the dial and
the DismissalLedger. `ground-ruvnet` is none of those. It emits a grounding DIRECTIVE to the model ("call
search_ruvnet before you assert / name the rUv replacement / apply the playbook"), triggered by the content of
the user's own prompt, and it is governed by the brain on/off switch (`offBehavior: 'silence'`, ADR-054) —
never by the advocacy dial, which it does not read. It is not a candidate producer because it has no channel:
it is the enforcement primitive of ADR-0011/0012, not speech about capabilities. The invariant is therefore
restated with its scope explicit: **every unprompted utterance in the four channels passes through ONE runtime;
grounding directives are not utterances in those channels and have exactly one owner of their own.** The
DDD-0004 registry test's scope is unchanged (the four channels); `unprompted-runtime.mjs` is untouched.

**What is registered, measured.** hooks.json (Claude): `ground-ruvnet || true`, matcher `*`, timeout 10 —
the pre-retirement shape at 00526b12^. codex-hooks.json: the same id through the Codex wrapper (UserPromptSubmit
delivery was observed by the 2026-09-11 probe). `plugin/hooks/hook-contracts.json` v5 names the second owner
under `_eventOwners` with class *grounding injection*; `continuity-hook-policy.mjs` carries the registration;
`npm run hooks:check` and the installer's convergence predicate derive from it. Companion registrations in the
same change: decision-gate's write route (PreToolUse, ADR-067) and grounding-stamp (PostToolUse) — the gate and
its key — recorded in ADR-067's status log.

## Currency log

| 2026-09-11 | Amendment recorded (`7b8e6e73`, merged `a610f3f5`): `ground-ruvnet` is a second UserPromptSubmit owner scoped to grounding directives; the four-channel single-writer invariant is restated with its scope explicit; `unprompted-runtime.mjs` is untouched. This row exists because the amendment landed without moving `updated:`. No code review is claimed here — this ADR governs no paths. | Referents: `plugin/scripts/ground-ruvnet.sh`, `plugin/hooks/hooks.json`, `plugin/scripts/unprompted-runtime.mjs`; ADR-067; commit 7b8e6e73. |
