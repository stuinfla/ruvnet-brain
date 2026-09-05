---
id: ADR-056
title: Pay the debt, then wire the gate — document currency without a ratchet
status: Proposed
date: 2026-07-27
updated: 2026-09-01
impl: wired
governs:
  - scripts/wired-check.mjs
  - scripts/doc-currency.mjs
  - scripts/git-hooks/pre-push
  - plugin/scripts/md-stamp.mjs
authors: [Stuart Kerr, Claude Code]
tags: [documentation, currency, chokepoint, hooks, gates, drift, honesty, stamps]
supersedes: []
relates: [ADR-034, ADR-024, ADR-037, ADR-009, ADR-020]
---

# ADR-056: Pay the debt, then wire the gate

**Status**: Proposed
**Date**: 2026-07-27 · **Last updated**: 2026-08-01 · **Why**: v3 closes a changed-scope escape that
let governed code move without bringing its ADR into the blocking set; v2 followed an adversarial
duel in which v1 scored
scored 33/100 and 52/100 by two independent models and largely rewritten; record in §Duel
**Implementation**: wired (DERIVED, not claimed — §§1, 2, 5, 7 are built, wired and tested; §8's
session-start notice and §3's opt-in hook widening are NOT) · **Verified in sync**: never

## Context

The owner, 2026-07-27, giving three rules and one constraint governing all of them:

> 1. *"Every markdown document, the first line of which has to have a time and date stamp … so I know
>    if they're stale or current actually in there so that I can read it, not just you."*
> 2. *"All of the ASCII art is to be transformed into appropriate SVG art using that skill. This should
>    be … a standard course of business that RuvNet Brain runs all the time at the appropriate time."*
> 3. *"All ADRs should always have a status: whether they were written, whether they were implemented,
>    whether they've been confirmed to coincide with the latest code. … That's inexcusable."*
>
> *"Do it in an intelligent, elegant way. I'm not trying to shove contacts down anybody's throat. I'm
> not trying to add a ton of overhead."*
>
> And the framing that matters most: *"I don't know if they exist anywhere or if they're another thing
> that's going to be a recommendation that you ignore, which is not acceptable."*

### The audit (measured 2026-07-27, verified independently by both duel models)

His suspicion was right, and understated. **All three rules already existed. None fires.**

| Rule | Built? | Fires? | Evidence |
|---|---|---|---|
| Stamps | **Yes** — `plugin/scripts/md-stamp.mjs`, wired PostToolUse (`plugin/hooks/hooks.json:137`), tested | **Half** | Refreshes stamps that exist; by its own line 11 leaves *"a file with none … alone."* **166 of 239** `.md` files carry no stamp — a silent no-op on all of them |
| ASCII→SVG | **Yes** — global `ascii-to-svg` skill v2.1 | **No** | Advertises *"Fully automatic via global PostToolUse hook `~/.claude/hooks/ascii-svg-auto-sync.sh` … set-and-forget."* That file **does not exist**. Manifest last written 2026-06-29 |
| ADR status | **Yes** — `scripts/doc-currency.mjs`, 780 lines, 43KB of tests, already deriving the owner's exact three axes | **No** | Absent from `pre-push`, `gate.sh`, `gates.mjs`, every workflow. `package.json:35` defines `doc:currency`; **nothing calls it** |

**ADR-034 has itself drifted.** Written 2026-07-22 quoting the owner asking for rule 3 in nearly these
words; its frontmatter still reads `impl: unbuilt` while the 780-line implementation sits beside it,
dated the same day. *The ADR about documents drifting drifted, in five days.*

**And `wired-check` reported a false green that hid it.** Its only "invoker" was the `package.json`
line **defining** the script. Defining a command counted as wiring it.

### The one root cause

Three rules, one failure: **each lived somewhere that only fires when someone remembers to invoke it.**

## Decision

> **v1 of this ADR proposed a stateful ratchet, a corpus-wide `governs:` backfill, a Diagram
> aggregate, and pre-push diagram conversion. The duel killed all four.** What follows is what
> survived. The deleted design is preserved in §Duel, because a record of a rejected idea is how the
> next person avoids re-proposing it.

### 1. Pay the debt. Do not build machinery to live with it.

This is the whole decision, and it replaces v1's ratchet outright.

Today's 32 BLOCK findings across 31 documents decompose (measured, `--json`) into:

| Count | Finding | Work required |
|---|---|---|
| 24 | `stamp-lags-doc` | **None.** `doc-currency --fix` derives them from git — 47 fixes verified in dry-run |
| 4 | `governs-directory` | Four one-line glob edits; the tool prints each exact fix |
| 4 | `presumed-stale` | Four genuine re-reads — *the actual work, and the only judgement in the set* |

That is one sitting. v1 proposed a stateful new-vs-pre-existing violation tracker so the gate could
coexist with this debt **forever** — machinery whose entire purpose was avoiding an evening's work,
and which both duel models proved gameable in every storage form it could take. A committed baseline
can be gamed in the same commit that adds the violation; re-evaluating at the remote SHA needs a
second worktree and is not implementable cheaply; and "report the pre-existing forever" means 30+
findings on every push in perpetuity — which `doc-currency.mjs`'s own header names as the designed
failure mode: *"a gate that cries wolf gets bypassed and a bypassed gate protects nothing."*

**Clear the backlog and the scaffolding has nothing left to hold up.**

> **`--fix` IS SELF-INVALIDATING, and this bites every time. Found 2026-07-27 by doing it.**
> `--fix` sets `updated:` to each file's **last commit date**. Committing that fix then creates a
> *new* commit touching those same files — so every stamp it just repaired now lags its own file, and
> the count went straight back from 4 blocking findings to 28. The invariant (DDD-0008 #3) is
> *"`updated` MUST equal the commit date of the change carrying it"*, and the change carrying it is
> **the commit you are about to make**, not the one before.
>
> **The convergent workflow:** run `--fix` to recover dates git can prove for files you are *not*
> otherwise touching, then set `updated:` to **today** on every file the commit actually changes —
> which is precisely what `computeStampedContent` (the `md-stamp` hook's pure function) already does,
> so reuse it rather than writing a second stamper.
>
> **Never blanket-restamp.** Applying it to every governed document bumps files that did not change
> and manufactures the false freshness §4 exists to prevent. Scope it to the files in *this* change
> (`git show --name-only <sha>` / `git diff --cached --name-only`) and nothing else.
>
> **THE SAME TRAP HAS A SECOND MOUTH — via governed CODE, not the document.** Committing a change to
> code an ADR governs, without touching that ADR, makes it `presumed-stale` at the next check: the
> governed set moved and nobody re-read the document against it. That is the mechanism working, not a
> bug — but it means **an ADR governing actively-developed code goes stale on the very next commit to
> that code.** This document did it to itself twice in one session: two commits touching
> `wired-check.mjs` and `doc-currency.mjs` re-staled the ADR that governs them, minutes after it
> reached zero findings.
>
> **The rule that closes both mouths: an ADR is stamped in the SAME commit as the governed code it
> describes.** If the change conforms to the ADR, restamp it and say so in the currency log; if it
> does not, the ADR needed editing anyway and the gate just told you so at the only moment the answer
> is cheap. Splitting the two across commits is what creates the treadmill.

### 2. Serve rule 1 with a sweep, then maintain with the hook — both halves

The sharpest finding of the duel, and it inverts v1:

> *"The 166 dateless files are dateless because they are not being edited. Insert-on-touch fires only
> when a file **is** edited — so the mechanism reaches actively-edited files, the ones least likely to
> be stale, and never reaches a stale file, **by definition of stale**."*

v1 shipped the half that cannot serve the request. The owner is asking about the documents sitting on
disk **today**. So:

- **One-time sweep** over the ~70 authored dateless files, with dates **derived from git and labelled
  as derived, never invented.** This is not a new pattern — it is exactly what `doc-currency --fix`
  already does, and the house rule (ADR-024) that a status is re-derived from the artifact.
- **Then** the `md-stamp` hook maintains them going forward.

v1 rejected the sweep as *"fixes today's 166 files and nothing about tomorrow's."* True — and
insert-on-touch fixes tomorrow's and nothing about today's. The answer is both, not the wrong one.

### 3. Stamp insertion is frontmatter-aware, or it does not happen

Five `plugin/skills/*/SKILL.md` files open with YAML frontmatter that Claude Code's skill loader
**requires at line 1**. They are hand-written `.md` in no excluded directory — Authored Documents by
this ADR's own definition. A literal line-1 insertion corrupts them and the skill stops loading. This
ships to strangers, where line 1 is load-bearing in ways this repo cannot enumerate.

Therefore insertion follows the shape already implemented in `md-stamp.mjs`, never a blind line 1:

- **Frontmatter present** → maintain the `updated:` key *inside* the block (the existing
  `refreshFrontmatterStamp` path).
- **Plain document** → the top of the body.
- **Unknown or structured prologue** (MDX exports, license headers, anything unrecognised) → **do
  nothing.** Silence is the correct output for a shape we do not understand.

Generated markdown is never stamped: `kb/`, `dist/`, `.agentic-qe/logs/`, `node_modules/`, `clones/`
account for 96 of the 166. A stamp on machine output is noise wearing the costume of signal.

### 4. Say plainly what the stamp means, because mechanising it changes that

An honest consequence v1 hid, raised independently by both models:

**A hook-maintained `Updated:` line is a cached file date** — a mirror of `git log -1` maintained by a
writer that only fires on Claude Code's edit paths. Every edit from vim, the GitHub web UI, or a
merge drifts it. DDD-0008's ACL 2 prohibits exactly this in italics: *"a local copy of that knowledge
would drift from it, which is this context's own failure mode reproduced inside its implementation."*

And the meaning shifts: a typo fix stamps today's date, so the field quietly moves from *"the author
attests this was current as of D"* to *"some tool touched this file on D."* A reader who keeps
reading it the old way is being handed **false freshness** — the mirror image of the staleness it was
built to expose.

**So the field is named for what it is — last modified — and it never claims review.** "Verified in
sync" remains a separate, derived, expiring claim available only to Governed Documents (ADR-034).

### 5. Wire the gate plain: one line, `--changed`, no ratchet

After §1, `scripts/git-hooks/pre-push` gains one invocation of the currency check scoped with the
tool's existing `--changed` flag. No baseline, no state, no new mechanism. A document is in that
scope when either the document itself changed **or any resolved path in its `governs:` set changed**.
Scoping only to directly touched ADR filenames is an escape hatch: code can invalidate the claim
without the claim ever being evaluated. `--changed` is only safe *because* the debt is zero: a
touched document, or a document governing touched code, that is red really is your fault.

### 6. `governs:` grows one document at a time — the corpus-wide backfill is CUT

Both models ranked this their #1 cut, independently. Fable measured why the proposed derivation is
contaminated: commits `3501ef4`, `2319806`, `deadb55` each co-commit their ADR with `package.json`,
`README.md`, `plugin.json`, `data/manifest.json`, `explainer/index.html` — the version-bump surfaces
this repo touches on **every release**. A history-derived `governs:` set inherits those for nearly
every ADR; `package.json` then moves on the next bump and ~48 documents cross `presumed-stale` at once.

Worse than the noise: today's `impl: unknown` values are **honest** — *"I cannot tell."* After a
backfill, `deriveImpl` runs over a wrong set and returns confident values. DDD-0008 already wrote the
indictment: *"a narrow or wrong list produces a Document that verifies perfectly and means nothing."*
**Forty-eight unverified assertions dressed as derivations are strictly worse than forty-eight
`unknown`s**, because the epistemology of the whole system rests on derived values being trustworthy.

`governs:` is added when a human actually reads an ADR against its code — the only moment the
assertion means anything.

### 7. Fix the false green that hid all of this — **BUILT**

`wired-check` must not count a `package.json` script *definition* as an invoker of itself. Because an
npm script **is** a real way in for a human, the honest answer is a third state rather than a flip:

- `wired` — reached by automation (a workflow, a hook, a composite script, an npm lifecycle name)
- `manual` — an npm script exists, nothing automated runs it
- `unwired` — nothing at all

**Status: built, wired, and tested** (`scripts/wired-check.mjs`, 7 new cases in
`tests/unit/wired-check.test.mjs`, 34 passing). It immediately reclassified **5** modules that had
been reporting `wired`: `doc-currency`, `eval-brain`, `falsify`, `qe/ux-suite`, and — with some irony
— `status-honesty`.

*The fix reproduced the bug twice inside itself.* Its own JSDoc spelled an invocation-shaped path and
an `npm run` line as illustrations; block comments were not stripped, so the comment forged callers
and flipped the audited module back to `wired` — twice, by two different mechanisms. Caught only by
re-reading the row after the change instead of trusting it. `stripComments` now also blanks JSDoc body
lines (`*` followed by whitespace; `*gen()` generators stay untouched, with a test proving it).

### 8. Rule 2 (ASCII→SVG): tell the truth about it, and put it where a model exists

v1 proposed conversion at pre-push. **That reproduces the exact impossibility this ADR diagnosed one
section earlier**: a pre-push git hook is a shell process with no model, no session, no tokens — the
identical constraint that meant `ascii-svg-auto-sync.sh` could never have been built. Either the hook
converts (impossible) or it prints a recommendation the model ignores (the decay mode this ADR exists
to end).

And the population does not justify machinery. Excluding generated `kb/` primers, the authored
box-drawing corpus is **three files** — `SPEC.md` (which DDD-0008 explicitly names as must-stay-ASCII)
and two DDD context maps. **Roughly two legitimate candidates.**

So: no Diagram aggregate, no manifest-drift machinery, no pre-push batch. Stale-diagram candidates are
surfaced **at session start** — the one chokepoint where a model is actually present to act — in a
notice measured in lines, not subsystems. Conversion stays a judged act invoked through the skill that
owns it.

### 9. The thesis, narrowed

v1 asserted: *"A convention that cannot be stated as a hook, a gate, or a derivation is not a
convention. It is a hope."* Too strong, and this repo's own history refutes it. Where mechanisms fail
here, **they fail silently, wearing green**: `wired-check`'s false green hid this entire episode; the
pre-push secret scan spent weeks scanning the staged index (*"could only catch the one case that never
happens"*); the ascii skill advertised a hook that never existed; ADR-053 found three shipped hooks
with no timeout.

**A rule in the model decays visibly** — the owner notices, complains, and this ADR gets written. **A
rule in a broken chokepoint decays invisibly and lies about itself until an audit.** Every new
mechanism enlarges the surface the meta-auditor must audit — and the meta-auditor was itself broken.

The honest form: **mechanise what is derivable; keep the chokepoint inventory small enough to audit;
route judgement-shaped rules to a point where judgement actually happens, and accept that they stay
judgement.**

## Consequences

- Rule 1 is satisfied **on the day it ships**, not asymptotically never.
- Rule 3 is satisfied by an afternoon of wiring plus an evening of debt paydown — the 780 hard lines
  were written and tested on 2026-07-22 and only ever needed calling.
- Rule 2 is honestly *partially* satisfied: detection and surfacing, not automatic conversion. Saying
  so is the point; the alternative is a fourth advertised automation that does not exist.
- `impl: unknown` stays on ~48 ADRs. That is the honest state and it is not a defect to be papered over.

## Duel — Fable 5 × GPT (codex-cli 0.144.6), 2026-07-27

Run per standing order (cross-model adversarial duel on hard/architectural questions). Both models
were given the same brief, told a broadly-approving response is a failed response, and told a score
above 85 means they had not looked hard enough. Both read the live files.

**Scores: GPT 33/100 · Fable 52/100.**

**Unanimous #1 cut, reached independently: the corpus-wide `governs:` backfill.**

Convergent findings — each raised by **both** models with no knowledge of the other:

| # | Finding | Disposition |
|---|---|---|
| 1 | The ratchet has no baseline, is misrepresented as an existing mechanism, and ratchets *open* in every storage form | **Accepted — ratchet deleted** (§1) |
| 2 | `governs:` backfill manufactures false confidence at scale; derivation method contaminated by release co-commits | **Accepted — cut** (§6) |
| 3 | Pre-push generation cannot repair the commit being pushed, and has no model anyway | **Accepted — moved to session start** (§8) |
| 4 | Stamp insertion breaks YAML frontmatter; 5 in-repo `SKILL.md` files would stop loading | **Accepted — frontmatter-aware or nothing** (§3) |
| 5 | The stamp launders "recently touched" into "current" | **Accepted — named honestly** (§4) |
| 6 | The tier boundary is multiply-defined and gameable | **Accepted — key-based, one definition** |
| 7 | The chokepoint thesis proves too much | **Accepted — narrowed** (§9) |

Findings unique to one side, both accepted:

- **GPT:** the `legacy` grandfather clause is *"a door that opens from the inside"* — stripping a
  document's convention keys downgrades every stamp BLOCK to WARN forever. Fix: `legacy` must also
  require that the file never carried convention keys in its git history (`git log -S`), a derived
  property key-deletion cannot manufacture.
- **Fable:** the insert-on-touch mechanism *"never reaches a stale file, by definition of stale"* —
  the finding that inverted §2, and the single most valuable sentence of the duel.
- **Fable:** the over-engineering verdict against the owner's explicit constraint — *"it has grown a
  bureaucracy where a sweep and three small diffs would do."* v1 delivered, at ship time,
  approximately **none** of the three rules.

Both models credited exactly one section of v1 as correct and correctly-sized: **§7, the `wired-check`
fix** — which is the one section that was already built.

## Currency log

| Date | What changed | Why (with referents) |
|---|---|---|
| 2026-09-01 | Re-read after `scripts/wired-check.mjs` moved (the only governed path touched). `callerPattern()` gained a filename-boundary lookbehind/lookahead, closing a false-positive class where an unrelated module's name that is a trailing substring of another's (e.g. `gates.mjs` inside `corpus-aggregates.mjs`) registered as a phantom caller — live in this repo, hiding `scripts/gate.sh` as falsely "wired" via exactly such a collision. The §7 mechanism (real invocation-shaped callers, not mentions) is strengthened, not changed: this is a precision fix to the existing predicate, and `scripts/doc-currency.mjs`, `scripts/git-hooks/pre-push`, `plugin/scripts/md-stamp.mjs` did not move. | PR #229 (dream-cycle 2026-09-01, issue #228); `node scripts/wired-check.mjs --check` exit 0 on the finished candidate, 43/43 tests in `tests/unit/wired-check.test.mjs`. |
| 2026-08-22 | Re-read the expanded reachability and pre-push chokepoint at convergence tip `ddae606`; the gate now distinguishes real operational callers from exports, self-reference, manual tools, and isolated maintenance entrypoints without weakening fail-closed behavior. | `b1172a7` wires the maintenance entrypoints, `c05f535` audits release-critical operational exports, and `17fe54b` / `bd446d9` make corpus ownership reachable through the production reconcile path. Exact-tip `npm run wired:check` reports 272 modules, zero UNWIRED modules, zero UNWIRED critical exports, and zero UNWIRED hooks. This row reviews currency only; the six manual tools and four held modules remain disclosed rather than rounded up. |
| 2026-08-30 | Re-read the chokepoint after adding the convergence-manifest check to pre-push; the release identity is now validated before remote publication. | `scripts/git-hooks/pre-push`; `scripts/convergence-manifest.mjs`; exact hosted QA failure on stale generated identity. |
| 2026-08-22 | Re-read the only moved governed path, `scripts/wired-check.mjs`; the chokepoint remains fail-closed and its reachability model is more exact. | `6336c52` reclassifies the retired nightly/source writers as explicit author-run isolated-worktree commands instead of claiming a deleted LaunchAgent reaches them. `26b0095` makes Check C enumerate both static lesson trigger labels and dynamically appended `ARGS+=(--trigger ...)` paths, with `tests/unit/wired-check.test.mjs` proving the dynamic-only case. `scripts/doc-currency.mjs`, `scripts/git-hooks/pre-push`, and `plugin/scripts/md-stamp.mjs` did not move; this ADR remains Proposed with its wired slice unchanged. |
| 2026-08-06 | **A version bump no longer counts as governed-code drift** (`scripts/doc-currency.mjs`, `deriveDrift`). | This gate's own credibility problem, found by using it heavily in one day. `scripts/sync-version.mjs` rewrites the plugin manifests, `package.json`, `kb/package.json` and `RVF-GENERATIONS.json` on EVERY release bump, and several ADRs legitimately `govern:` those files — so each bump marked them `presumed-stale` regardless of whether any decision moved. It fired four times in one day (ADR-050/051/057/058), and every single resolution was "re-read, only a version string changed". That is the precise failure mode this ADR exists to prevent: a chokepoint that cries wolf gets satisfied with a date stamp instead of a reading, and this repo has already blanket-stamped 61 ADRs from a bad grep once. It would also have permanently blocked `scripts/release-convergence-watchdog.mjs`, which runs unattended and cannot author a currency row. Drift now counts only commits whose diff inside the governed paths contains at least one non-version line; one substantive line still counts the whole commit. TEETH measured in both directions rather than assumed — the same day's substantive edit to `.github/workflows/protected-release.yml` still registers (`state=lagging, commits=1`) while the codex manifest's version-only churn is exempt (`state=current, commits=0`). Blocking findings 4 → 1. |
| 2026-08-01 | Classified `scripts/fix-workstream.mjs` as an explicit session-supervised standalone CLI after the clean integration gate correctly rejected it as unreachable. | ADR-050 requires an isolated worktree and integration-owner handoff for non-trivial fixes. `scripts/fix-workstream.mjs` implements that human/agent-invoked boundary and deliberately has no unattended caller; `tests/unit/fix-workstream.test.mjs` proves it cannot merge, push, publish, delete, or clean worktrees. |
| 2026-07-30 | Closed the `--changed` governed-path escape and corrected the pre-push success message boundary. | `scripts/doc-currency.mjs` previously intersected the diff only with ADR filenames, so changed governed code could print global BLOCK findings yet leave the scoped set empty and return 0. The scope now includes documents whose resolved `governs:` paths intersect the diff; `tests/unit/doc-currency.test.mjs` pins both governed-path failure and unrelated-change pass. `scripts/verify-channels.mjs` now reports only channel-check success before currency runs, while `scripts/git-hooks/pre-push` owns the final whole-gate success. |
| 2026-07-28 | Removed the obsolete `ground-before-write` and `grounding-stamp` exemptions from `scripts/wired-check.mjs`. | Both hooks are now shipped through `plugin/hooks/hooks.json` and `plugin/hooks/codex-hooks.json`; retaining the inert exemptions made the same report call them both exempt and wired. `npm run wired:check` now reports 0 unwired without that contradiction. |
| 2026-07-27 | Initial draft (v1) | Owner's three rules. Audit found all three pre-existing and unfired: `md-stamp.mjs:11`, missing `~/.claude/hooks/ascii-svg-auto-sync.sh`, `package.json:35` defined-but-uncalled. ADR-034's `impl: unbuilt` refuted by `scripts/doc-currency.mjs` |
| 2026-07-27 | **Re-read after its own governed code moved.** Commits `00dd34a` (Rejected/Superseded exempted from drift) and `936c6b4` (stamp-sweep classified STANDALONE) both changed `scripts/wired-check.mjs` / `scripts/doc-currency.mjs` without touching this document, which re-staled it minutes after it reached zero findings. Both changes were made UNDER this ADR and conform to it: §7's third state and §1's debt-paydown. Restamped, and §1 now carries the general rule — an ADR is stamped in the SAME commit as the governed code it describes | The mechanism catching its own author is the strongest evidence it works; recorded rather than quietly restamped |
| 2026-07-27 | **v2 — rewritten after adversarial duel.** Cut the ratchet, the `governs:` backfill, the Diagram aggregate, and pre-push conversion. Added the sweep, frontmatter-aware insertion, the honest stamp semantics, and the narrowed thesis | GPT 33/100 and Fable 52/100, converging on the same #1 cut. §7 recorded as built (5 modules reclassified; `stripComments` hole closed after the fix twice reproduced the bug it was fixing) |
| 2026-07-27 | **Re-read against the governed code; NO change required — every claim still holds.** | Flagged `presumed-stale`: 3 commits (0d) after this document's last commit (`731b3b9`). `scripts/wired-check.mjs` gained two 10-line additions (`1a6b54d`/`a44899b`, the cross-encoder-cap harnesses registering `cap:collect`/`cap:ab` as npm scripts) — purely additive registrations, the `wired`/`manual`/`unwired` §7 mechanism itself untouched. `scripts/git-hooks/pre-push` gained a real fix (`ece5df7`): the `--changed` base-commit resolution now falls back to `merge-base` when the remote tip is not an ancestor (a rebase/force-push case), because the plain-remote-tip form this ADR's §5 shipped had just refused a rebased push for ADR-054/055, documents this branch never touched — the FIX conforms to and strengthens §5's decision (use `--changed`, no ratchet), it does not change it. `plugin/scripts/md-stamp.mjs` and `scripts/doc-currency.mjs` itself: no commits in range beyond the renumbering commit that is this doc's own last commit |
| 2026-07-27 | Re-verified against `scripts/wired-check.mjs`, which moved twice | It gained honest registrations for the two rerank harnesses, both classified `manual` with a stated reason (hours of cross-encoder time, never scheduled) — the chokepoint design working, not changing. AND the re-read caught something a date-stamp would have missed: those registrations cited **ADR-057** for the pool cap, a number that now belongs to a different document after tonight's renumbering. Fixed in this commit. A currency check that only compares dates would have passed this and left two wrong citations in shipped code. |
