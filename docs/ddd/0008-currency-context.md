# DDD-0008 — The Currency bounded context

Updated: 2026-09-05 18:48:31 EDT | Version 1.2.0
Created: 2026-07-22

Governs **ADR-034** (document currency and the status lifecycle) and **ADR-056** (currency at a
chokepoint — the scope widening to Authored Documents and Diagrams).

**Status**: Proposed (2026-07-22) · scope extended 2026-07-27 (ADR-056)

## Implemented boundary — 2026-09-05 recovery

The historical model below is a proposal, not a complete implementation claim. Current source
authority is `scripts/doc-currency.mjs`, shared by edit and push consumers. Its digest binds the
normative document body and actual regular-file working bytes; it is not the HEAD-only recipe in
the original vocabulary table. Implementation is the weakest governed member, not any one member.

`reviewed_digest` plus a dated source-linked review row is a separate review-freshness record.
It records examined bytes and findings, not correspondence, correctness, acceptance, or verification.
Matching current bytes removes only the missing-review presumption while retaining historical drift;
changed/unavailable bytes expire it. No automatic stamping path may invent this judgment.

Default presumed drift blocks except for retired decision statuses; the warning-only event table
below describes the original proposal. The proposed per-claim verification-ledger enforcement is
not implemented. Other proposed rules also have narrower actual enforcement, enumerated in ADR-034's
current-boundary section. This review does not promote Proposed to Accepted or claim those gaps closed.

---

## Why this context exists separately

Every other context in this repo reasons about **the world**: Advocacy (DDD-0004) about the machine,
Learning (DDD-0005) about the agent, Capability (DDD-0006) about what is on and off.

Currency reasons about **our own claims about the world.** Its subject matter is not code, not the
user, and not the agent — it is the set of assertions this repo has already made in writing, and
whether each still holds. That is a genuinely different domain: its entities are documents, its
invariants are about *correspondence* rather than behaviour, and its single failure mode is a
sentence that used to be true.

The temptation is to fold it into QA. That would be wrong for a reason ADR-034 measured: QA asks
*"does the code work?"* Currency asks *"does the document still describe the code?"* — a question that
can fail while every test passes. On 2026-07-22, `docs/adr/0013` disagreed with itself on adjacent
lines (frontmatter `updated: 2026-07-14`, body `**Updated**: 2026-07-18`) with a fully green suite,
for four days. No amount of testing the code was ever going to find that.

---

## Ubiquitous language

| Term | Precise meaning | Explicitly NOT |
|---|---|---|
| **Document** | An ADR or DDD carrying a `governs:` set — an assertion about specific code | any markdown file; README and PROGRESS are out of scope this round |
| **Status** | The **decision's** state: `Proposed` · `Accepted` · `Deprecated` · `Superseded` — rUv's enum, unchanged | anything about whether code exists |
| **Impl** | The **code's** state relative to the document: `unbuilt` · `built` · `wired` · `verified` | a phase of work, a progress indicator, or a synonym for Status |
| **Wired** | Reachable from a non-test, non-doc caller | present in the repo; tested; merged |
| **Governed set** | The paths a Document asserts things about, declared in `governs:` | everything the document mentions |
| **Digest** | `git rev-parse HEAD:<p>` over the governed set, sorted, hashed — a value obtainable **only by running the check** | a checksum of the document itself |
| **Verification** | A dated reading of a Document against its governed set, stamped with the Digest **and** a claim ledger | a review, an approval, or a green suite |
| **Claim ledger** | Each normative claim in the Document → the `file:line` satisfying it | a summary of what was read |
| **Currency** | Correspondence between a Document and its governed set, **as of a stated moment** | accuracy, quality, or completeness |
| **Drift** | code-clock > doc-clock: the governed set moved after the Document last did | the Document being old |
| **Currency log** | Append-only table in the body: date · what changed · **why** | a changelog of the product |
| **Referent** | A resolvable thing inside a *why* — an existing path, an ADR id, a resolving SHA, an issue, a dated quote | evidence that the why is sincere |

### Two pairs that must never be confused

**Status ≠ Impl.** They answer different questions, are owned by different parties, and have opposite
derivability. Status is social and no script may set it; Impl is mechanical and no human should be
trusted to assert it. **Collapsing them is not hypothetical — it already happened here.** rUv's
`ruflo-adr` plugin (`0.3.0`, `REFERENCE.md:12`) enumerates `proposed | accepted | deprecated |
superseded`, and `implemented` occurs zero times in the entire plugin; this repo nonetheless carries
`status: Implemented` on ADR-013 and ADR-018. A fifth value was invented on someone else's key
precisely because there was no key for the fact we were trying to state.

**Old ≠ Stale.** A Document untouched for months whose governed set has not moved is **current**, and
saying otherwise is the false positive that gets the gate deleted. Only Drift is real; age appears
nowhere in the formula. *This context's entire credibility rests on never flagging ADR-0021 for the
crime of being four days old.*

---

## Aggregates and their invariants

### Aggregate: **Document** (root)

The consistency boundary. Status, Impl, stamps, governed set, and currency log change together or
not at all — a Document that is internally inconsistent is the failure this context exists to end.

**Invariants — each one is a real failure this repo shipped:**

1. **A Document MUST carry `date`, `updated`, and `status`.**
   *Twelve of thirty-two ADRs (0001–0012) carry a frontmatter of exactly `id:` — no status, no date —
   while all twelve assert `**Status**: Accepted` in their bodies. The machine-readable half says
   nothing; the human half asserts everything.*
2. **`date` is written once and is immutable.**
   *A diff that edits the creation date is a rewrite of the past, and there is no legitimate reason
   to do it.*
3. **`updated` MUST equal the commit date of the change carrying it — derived, never typed.**
   *Measured 2026-07-22: four of twenty stamped ADRs (0013, 0015, 0018, 0019) carry an `updated:`
   older than their own last commit. Twenty percent decay in thirteen days, on a thirteen-day-old
   convention.*
4. **The frontmatter and the body MUST NOT disagree.**
   *ADR-013's body-update note repaired a Status disagreement and introduced a date disagreement four
   lines above it, in the same edit, and shipped. The note's own words: "a file disagreeing with
   itself, exactly the ADR-drift this project's own hooks warn about."*
5. **Every change MUST append a currency-log row whose *why* carries ≥1 Referent.**
   *"Updated docs" is the failure. A why with no referent is a stamp wearing a sentence.*
6. **`impl` MUST be derivable from the artifact; a value the artifact refutes is void.**
   *ADR-024 is already law here — "a status must be RE-DERIVED from the verifiable artifact, never
   read from a self-asserted field." We wrote that law about job receipts and never once applied it
   to the documents asserting we had.*

### Aggregate: **Governed set**

The link from a Document to the code it speaks about. Owned by the Document; meaningless alone.

**Invariant: a `verified` Document MUST have a non-empty governed set.**
*An empty `governs:` verifies against nothing and shows green — a forgery requiring no intent, only
carelessness.*

**Invariant: a changed resolved member of a Governed set MUST bring its owning Document into the
`--changed` validation scope.** A code-only change is precisely when correspondence can break.
Scoping only to directly touched document filenames turns `governs:` into evidence the report can
display but the release gate can ignore.

**Acknowledged weakness, recorded rather than designed around: the governed set is an asserted
field.** Nothing derives it. A narrow or wrong list produces a Document that verifies perfectly and
means nothing. This context can warn (empty list; a commit naming an ADR id while touching no path it
governs) and cannot close it. *ADR-024 hit the identical wall — "a lexical layer can in principle be
gamed" — and recorded it. So do we. The alternative is a fifth lie-shaped status.*

### Aggregate: **Verification** (a value object, not an entity)

A Verification is a **fact about a moment**, not a property a Document keeps. It is created, never
mutated, and it **expires by derivation** when the Digest stops matching.

**Invariants:**

1. **A Verification MUST carry a Digest, and the Digest MUST be recomputable.**
   *This is the load-bearing design choice: a date can be typed from memory, a git object id cannot.
   Every stamp this system has ever had was typeable, and that is exactly why four are already wrong.*
2. **A Verification MUST carry a claim ledger.**
   *Otherwise "verified" means "someone said so," which is the asserted status we are replacing. The
   ledger is the shape `scripts/claims-verify.mjs` already uses for numbers; documents get the same
   treatment or none.*
3. **A Verification MUST NOT be recorded in a commit that moves its own governed set.**
   *A claim the artifact refutes in the same breath is fabrication rather than neglect, and it is the
   one currency failure that fails closed.*
4. **No one un-verifies. The artifact does.**
   *A stamp that must be manually retracted will not be, and the whole system decays to the state
   measured on 2026-07-22.*

**A Verification proves freshness, not correctness.** It proves the governed set has not moved since
someone read the two together. It cannot prove the reading was careful, or happened at all. *Stating
this inside the domain language is deliberate: the word "verified" overclaims, and a context that
lets its own vocabulary overclaim has already lost the argument it exists to win.*

### Aggregate: **Currency log** (append-only)

**Invariant: rows are appended, never edited or removed; the newest row's date equals `updated`.**
*Rewriting history is how a document becomes plausible instead of true. Append-only is also this
project's settled answer elsewhere: the `project-state-current` checkpoint was redesigned to
append-only on 2026-07-12, the same day the overwrite version silently destroyed a concurrent
session's entire checkpoint with zero error.*

### Aggregate: **Authored Document** (added 2026-07-27, ADR-056)

A hand-written `.md` file that is **not** a Governed Document. It carries one obligation and no
others: a stamp on the first screen, so a human can judge staleness without running anything.

*This tier exists because the original scoping — "any markdown file … out of scope this round" —
was measured on 2026-07-27 as **166 of 239 repo `.md` files carrying no stamp at all**. The owner's
rule is explicitly about his own reading: "so I know if they're stale or current actually in there so
that I can read it, not just you." A tier that only serves the machine does not answer that.*

**Invariants:**

1. **An Authored Document MUST carry a first-screen stamp**, placed by SHAPE, never at a literal
   line 1. Frontmatter present → the `updated:` key inside the block; plain document → top of body;
   **unrecognised prologue → nothing at all.**
   *Five `plugin/skills/*/SKILL.md` files require YAML frontmatter at line 1 for Claude Code's skill
   loader. A literal line-1 insertion stops them loading. Silence is the correct output for a shape
   we do not understand — and this ships to strangers, whose line 1 is load-bearing in ways this repo
   cannot enumerate.*
2. **Generated markdown is NOT an Authored Document and MUST NOT be stamped.**
   *`kb/`, `dist/`, `.agentic-qe/logs/`, `node_modules/`, `clones/` account for 96 of the 166. A
   stamp on machine output is noise wearing the costume of signal, and it would bury the 70 files
   where the stamp actually carries information.*
3. **An Authored Document has no `governs:`, no Digest, and no Verification.**
   *It cannot drift against code, because it asserts nothing about code. Giving it the heavy
   machinery would manufacture exactly the false positives that kill gates — and would require
   asserting a governed set, the one field this context admits it cannot derive.*
4. **Its stamp means LAST MODIFIED. It never means reviewed, current, or verified.**
   *Mechanising the stamp silently changes what it says. A typo fix stamps today's date, moving the
   field from "the author attests this was current as of D" to "some tool touched this file on D" —
   handing the reader **false freshness**, the mirror image of the staleness it exists to expose.
   Stated here rather than discovered later. `verified` remains available only to Governed Documents.*
5. **The tier is decided by DOCUMENT KIND, never by the presence of `governs:`.**
   *Otherwise deleting a key downgrades enforcement — a two-keystroke escape. An ADR with no
   `governs:` is still a Governed Document that cannot derive its impl; it is not demoted to the
   thin tier by omission.*

**Acknowledged tension, recorded rather than designed around: a hook-maintained stamp is a cached
file date, and ACL 2 below prohibits mirroring git.** The mirror is partial by construction — it
updates only on Claude Code's edit paths, so a vim edit, a GitHub web edit or a merge drifts it. This
is a real violation of this context's own boundary, accepted knowingly because the alternative (no
stamp at all) fails the reader the rule exists to serve. It is bounded by invariant 4: the field
claims only modification, which is the one thing a partial mirror can still almost say.

**The tiers are deliberately unequal.** Conflating them was the alternative, and it fails in both
directions at once: it either burdens a README with a digest it cannot have, or it dilutes `verified`
until it means "has a date on it."

### Aggregate: **Diagram** — PROPOSED AND CUT the same day (2026-07-27, ADR-056 §8)

An ASCII block and its rendered SVG *is* the same correspondence problem this context models — an
authored source, a derived artifact, a claim they still agree. The modelling was right; the aggregate
was still wrong, and the record of why is kept here so it is not re-proposed:

1. **The population does not support an aggregate.** Excluding generated `kb/` primers, the authored
   box-drawing corpus is **three files** — `SPEC.md` (which this document already names as
   must-stay-ASCII) and two DDD context maps. Roughly **two** legitimate candidates. An aggregate,
   two domain events and manifest-drift machinery for two files is the bureaucracy the owner
   explicitly asked not to be handed.
2. **The proposed chokepoint could not do the work.** Detection is arithmetic and fits anywhere;
   conversion needs a model. The draft put conversion at pre-push — *a shell process with no model,
   no session, no tokens*, i.e. the identical constraint that meant the `ascii-to-svg` skill's
   advertised auto-sync hook could never have existed. The design reproduced, one chokepoint over,
   the exact impossibility it had just diagnosed.
3. **Unconverted candidates do not fit the manifest it claimed to reuse.** `change-tracking.md`
   requires `svgFile`, `svgHash` and `lastConverted` per entry. A permanent candidate has none of
   them, so recording one either forks the skill's schema or cannot be recorded — and a candidate
   list with no `dismissed` state becomes a warning cemetery people learn to ignore.

**What replaced it:** stale-diagram candidates are surfaced at **session start**, the one chokepoint
where a model is actually present to act, and conversion stays a judged act invoked through the skill
that owns the format. No new aggregate, no forked manifest, no gate.

---

## Domain events

| Event | Emitted when | Consumed by |
|---|---|---|
| `DocumentStamped` | a Document is created or edited with valid stamps | the currency report |
| `GovernedCodeMoved` | a commit touches a path in some Document's governed set | drift computation |
| `DriftThresholdCrossed` | drift ≥2 commits or ≥7 days | `presumed-stale` warning |
| `ImplementationWired` | a governed path gains its first non-test caller | `impl` derivation (`built` → `wired`) |
| `VerificationRecorded` | a reading is stamped with Digest + ledger | the Document |
| `VerificationExpired` | recomputed Digest ≠ stamped Digest | **derived** status downgrade; loud warning |
| `StampContradicted` | a diff refutes a stamp it carries | the gate — **blocks** |
| `LegacyDocumentDetected` | a Document has no stamps at all | the report — **never** the gate |
| `AuthoredDocumentUnstamped` | an Authored Document is written or edited with no first-screen stamp | the `md-stamp` hook — **inserts**, never blocks |
| `DiagramDrifted` | a fenced ASCII block's normalized hash ≠ its manifest `asciiHash` | the **session-start notice** — never the gate, never a pre-push batch (see the cut aggregate above) |

`VerificationExpired` is the event this repo most needs and has never had. It is what makes
`verified` safe to say: the label decays on its own, so nobody has to remember to remove it. Every
prior stamp in this repo required a human to remember, and the measurement shows exactly how that
went.

`LegacyDocumentDetected` is deliberately consumed by the report and never the gate. *Twelve
pre-existing violations that block the first push are a gate uninstalled on day one, which returns
the system to zero — the state it is in now.*

---

## Anti-corruption layer

Three boundaries where foreign models must not leak in:

**1. Against rUv's ADR lifecycle.** `ruflo-adr` owns `status:` and its four values, and its tooling
(`adr-index`, `adr-verify`, the AgentDB causal-edge import) reads that key. We **add nothing to it**
and correct the two documents that already did. Everything this context needs lives on new keys
(`impl`, `governs`, `verified`, `verified_digest`) that rUv's tooling ignores by construction. *We
extend; we never overload. Redefining a shared key for the sake of one word is how a repo silently
forks a convention it depends on — and this repo has already done it once.*

**2. Against git.** git is the source of truth for what changed and when. We **read** it —
`log -1 --format=%ct`, `rev-parse HEAD:<path>`, `hash-object` — and model none of it. We keep no
mirror of commit history, no cached file dates, no second opinion about what moved. *The only reason
a stamp can be derived at all is that git already knows; a local copy of that knowledge would drift
from it, which is this context's own failure mode reproduced inside its implementation.*

**3. Against the owner's global doc-versioning convention.** `~/.claude/CLAUDE.md` specifies
`Updated: … | Version X.Y.Z` on line 1 and `Created:` on line 2 — a machine-wide human convention
that predates this context and applies to every project. We **satisfy** it (this file does) and do
not replace it. Currency reads created/updated from whichever shape a document uses; it does not
demand one. *Measured 2026-07-22: six DDDs, four header shapes — 0005 and 0006 written the same day
in two different forms. Unification is a real cleanup and belongs to a document-shape decision, not
to the context that checks correspondence. Making the checker also the style police is how a gate
acquires the false positives that kill it.*

---

## What this context deliberately does NOT own

- **Whether the code is correct** → QA, the eval flywheel, the test suites. Currency is orthogonal:
  every suite can be green while a document lies.
- **What a document should say** → its author. This context checks that the document and the code
  have been read together and when — never what the reading concluded.
- **Product versioning and release stamps** → the version-bump gate and `sync-version.mjs`. Adjacent,
  different clock, different artifact.
- **Prose quality, style, or header shape** → nobody yet, deliberately (see ACL 3).
- **README, PROGRESS, skills, primer** → ~~out of scope this round~~ **in scope as of 2026-07-27
  (ADR-056), but only as Authored Documents.** The original reasoning stands and is exactly why the
  tier is thin: none has a writable `governs:` set, and inventing one would assert the very field
  this context admits it cannot derive. So they get a stamp and nothing more — never a Digest, never
  a Verification, never a `verified` label. *The 2026-07-22 parking was right about the machinery and
  wrong about the reader: a human judging staleness needs a date on the page, not a governed set.*
- **Prose quality of an Authored Document, and whether ASCII *should* be a diagram** → its author.
  Currency checks that a stamp exists and that a rendering still matches its source. It never judges
  whether the sentence is good or whether the picture was worth drawing.

---

## The failure this context is designed around

Stated once, plainly, because every invariant above descends from it:

> **A convention that nothing checks decays to nothing, and the document that decided the convention
> decays first.**
>
> `doc-currency` was decided in ADR-0009 on 2026-07-06, with the diagnosis already correct: *"'is it
> stale?' currency logic is smeared across four uncoordinated places. All will drift."* Sixteen days
> later it appears in four files — all prose — and in zero of this repo's 82 scripts. ADR-0009's own
> frontmatter is one line: `id: ADR-009`. No status. No date. No `updated`.

The right answer was written by someone who understood the problem, and it was worth nothing, because
nothing could act on it. ADR-030 measured the same thing under controlled conditions in a single
session: **gates 8/8 obeyed, prose 0/6 on the load-bearing rule** — same model, same session, same
sincere intentions.

Every choice in this context follows: stamps that must be derived rather than typed, a Digest that
cannot be produced without running the check, verification that expires on its own, drift measured
against the artifact rather than the calendar, and an honest refusal to claim correctness where only
freshness can be proven.

---

## Currency log

| 2026-09-05 | Distinguished source-bound examination from semantic verification and documented actual enforcement limits. | `scripts/doc-currency.mjs` and `tests/unit/doc-currency-review.test.mjs` bind review to exact current bytes without changing the verification recipe or promoting implementation status. ADR-034 records the still-unimplemented claim-ledger and historical proposal differences. |

| Date | What changed | Why |
|---|---|---|
| 2026-07-30 | Added the governed-path reachability invariant for changed-scope validation. | `scripts/doc-currency.mjs` had scoped `--changed` only to directly modified ADR filenames. A change to a resolved `governs:` path therefore escaped the blocking set even when the full report showed the ADR stale. ADR-056 v3 and the real-git regression close that aggregate-boundary gap. |
| 2026-07-22 | Created | Defines the bounded context for ADR-034 (`docs/adr/0034-document-currency.md`). Owner, 2026-07-22: *"Is it VERIFIED TO BE IN SYNC with the resulting output?"* — no such state existed in any of the 32 ADRs in `docs/adr/` |
| 2026-07-27 | Added the **Authored Document** and **Diagram** aggregates; un-parked README/PROGRESS/skills/primer into the thin tier; added `AuthoredDocumentUnstamped` + `DiagramDrifted` events | Governs `docs/adr/0055-currency-at-a-chokepoint.md`. Owner's three rules, 2026-07-27. Measured that day: **166 of 239** `.md` files unstamped (96 of them generated output, hence the exclusion invariant); `~/.claude/hooks/ascii-svg-auto-sync.sh` advertised by `ascii-to-svg/change-tracking.md` **does not exist**, manifest last written 2026-06-29; `package.json:35` defines `doc:currency` and nothing calls it. The Diagram aggregate lands here rather than in a new context because ASCII→SVG is the same authored-source/derived-artifact correspondence this context already models |
