---
id: ADR-034
title: A document's status is a claim about code — derive it, stamp it with something you cannot type from memory
status: Proposed
date: 2026-07-22
updated: 2026-08-22
impl: unbuilt
governs:
  - scripts/doc-currency.mjs
  - scripts/git-hooks/pre-push
authors: [Stuart Kerr, Claude Code]
tags: [documentation, currency, derived-status, gates, drift, honesty, anti-fabrication]
supersedes: []
relates: [ADR-009, ADR-020, ADR-024, ADR-030]
---

**Status**: Proposed

<!-- The two axes are deliberately on SEPARATE lines. rUv's ADR tooling parses `**Status**: X` and
     accepts exactly one of Proposed/Accepted/Implemented/Superseded/Deprecated — putting the
     implementation and verification state on that same line breaks the ecosystem's parser, which
     the adr-format gate caught on this file's first save. The owner's four states are therefore
     modelled as a SECOND axis alongside rUv's, never as a replacement for it (anti-corruption
     boundary, DDD-0008). -->

**Decision date**: 2026-07-22 · **Last updated**: 2026-08-22 · **Why**: this document had drifted from
its own implementation — see the currency log; corrected under ADR-056 and re-reviewed after the
pre-push convergence wiring in `b1172a7`
**Implementation**: built (derived) · **Verified in sync**: never

This document proposes a schema and then wears it. Its own `impl:` is derived, not asserted, and on
2026-07-27 that derivation caught this file lying about itself.

> **DRIFT, FOUND AND CORRECTED 2026-07-27 (ADR-056).** For five days this section read *"`impl:
> unbuilt` is derived, not modest: `scripts/doc-currency.mjs` does not exist"* — while that file sat
> beside it at 780 lines with 43KB of tests, committed the same day this ADR was written. **The ADR
> about documents drifting was the drifted document.** Two causes, both now fixed: (a) the frontmatter
> claimed `impl: unbuilt`, and (b) `governs:` listed `plugin/scripts/doc-currency-gate.sh`, which was
> never built — and under weakest-member-wins one unresolvable path dragged the whole derivation to
> `unbuilt`, so the honest mechanism was reporting the dishonest answer for an honest reason.
> `governs:` also listed the `docs/adr/` and `docs/ddd/` **directories**, which this document's own §6
> forbids; replacing them with globs was worse still — the set expanded to all 67 documents and went
> permanently `presumed-stale`. The real error was semantic: **this ADR governs the tooling; the
> documents are its subjects, not its implementation.** `governs:` is now the two files that
> implement it. The gate itself lands in `scripts/git-hooks/pre-push` per ADR-056 §5, not in the
> separate `doc-currency-gate.sh` this document originally imagined.


> **Reviewed 2026-08-04 (4.0.10).** Governed code moved: scripts/doc-currency.mjs now understands a PINNED date. A blanket "make the stamp match the last commit" rule cannot tell a currency stamp from a historical record, and it silently rewrote ADR-050's incident cutoff — putting this gate into direct contradiction with tests/unit/fix-workstream-guidance, which asserts that exact date, with no way to satisfy both. Documents now declare it with `updated_pinned: true`; pinned dates WARN instead of BLOCK and --fix is forbidden from rewriting them. Checked against this decision: it preserves every currency guarantee stated here and closes a case where the fixer corrupted the record it exists to protect. No clause superseded.

## The critique this exists to answer

The owner, 2026-07-22:

> *"ADRs are supposed to be the real plan of attack, but lots of times they were just an initial
> plan. We write code, and then we modify code. One thing I ALWAYS want you to do is indicate in an
> ADR what the status is: Is it planned? Is it built? Is it implemented? Is it VERIFIED TO BE IN SYNC
> with the resulting output?"*
>
> *"Documentation should always be updated with the output… they should have a time and date stamped
> on when they were initially written and a time and date stamped on the last time they were updated
> AND WHY. That way I know I'm never looking at out-of-date documents."*
>
> *"There are dozens of things like this that are the difference between you acting as a smart
> learning partner and somebody that needs to constantly be reminded of everything all the time."*

The last sentence is the one that matters, and it is not about documentation. He is describing a
class: **things he has already said that did not stick.** This ADR is one instance; the mechanism
that let it decay is general.

## The measurement

Re-measured at write time, not recalled. `docs/adr/`, 32 ADRs, 2026-07-22 06:01 EDT:

```sh
for f in docs/adr/[0-9]*.md; do
  g=$(git log -1 --format=%ad --date=short -- "$f")
  up=$(awk '/^---$/{n++;next} n==1 && /^updated:/{print $2;exit}' "$f")
  printf '%-46s git=%s claims=%s\n' "$(basename $f)" "$g" "${up:--}"
done
```

| Population | Count | Reading |
|---|---|---|
| Frontmatter containing **only** `id:` — no status, no date, no updated | **12** (0001–0012) | the machine-readable half says nothing |
| …of which the **body** asserts `**Status**: Accepted` | **12 of 12** | the human half asserts everything, unbacked |
| Stamped, `updated:` **matches** the file's last commit | 13 | working as intended |
| Stamped, `updated:` **older** than the file's last commit | **4** (0013, 0015, 0018, 0019) | edited without touching its own stamp |
| Stamped, `updated:` **newer** than the file's last commit | 3 (0027, 0029, 0031) | typed ahead of the artifact |
| Documents whose status means *"checked against the code, on a date"* | **0** | **this state does not exist** |

Two findings from that table are worth more than the counts.

**Four of twenty stamps are already wrong** — 20% decay in thirteen days, on a convention introduced
thirteen days ago. The stamp is not a weak control that needs reinforcing. It is a control that has
never worked, because a hand-typed date is an assertion, and ADR-024 is already law here: *"a status
must be RE-DERIVED from the verifiable artifact, never read from a self-asserted field."* We applied
that law to job receipts and never once applied it to the documents asserting we had.

**ADR-013 disagrees with itself, on adjacent lines.** Frontmatter: `updated: 2026-07-14`. Body,
line 17: `**Updated**: 2026-07-18 — reconciled the body status with the frontmatter (Implemented)…
The body had been left at Proposed while the frontmatter said Implemented — a file disagreeing with
itself, exactly the ADR-drift this project's own hooks warn about.* A repair of one self-disagreement,
which introduced a second one four lines above it, and shipped. Nothing noticed for four days, because
nothing was looking.

### The finding that decides the architecture

`doc-currency` is not a new idea in this repo. **ADR-0009 decided it on 2026-07-06**, as one of three
QA capabilities, with the reasoning already correct (line 62): *"'is it stale?' currency logic is
smeared across four uncoordinated places. All will drift."*

Sixteen days later, `doc-currency` appears in exactly four files:

```
PROGRESS.md   docs/DDD.md   docs/adr/0009-…md   docs/adr/README.md
```

All four are prose. **Zero of this repo's 82 scripts implement it.** And ADR-0009 — the ADR that
decided documentation currency verification — has a frontmatter containing exactly one line:

```yaml
---
id: ADR-009
---
```

No status. No date. No `updated`. **The document that decided doc-currency is the least current
document in the set.** That is not irony to be enjoyed; it is the measurement that rules out one
entire family of solutions. A better convention was already written by people who understood the
problem, and it decayed to nothing in sixteen days. ADR-030 measured why in a controlled setting:
gates 8/8 obeyed, prose 0/6 on the load-bearing rule, same model, same session. **A second prose
convention would be the same experiment run twice.**

## Decision

### 1. Two axes, because rUv already proved one is not enough — and this repo already broke it

Grounded, not assumed. rUv's `ruflo-adr` plugin (cache `0.3.0`), `REFERENCE.md:12`, verbatim:

```
- **Status**: proposed | accepted | deprecated | superseded by ADR-XXX
```

`agents/adr-architect.md:10` states the lifecycle as `proposed → accepted → deprecated → superseded`.
A case-insensitive scan of the entire plugin returns **`implemented`: 0 occurrences.**

This repo uses `status: Implemented` on ADR-013 and ADR-018. **We already invented a fifth value on
rUv's key** — and it is the lie-shaped one. That is the whole argument in a sentence: rUv's enum has
no implementation state *because a decision's status and code's state are different facts with
different owners*. `proposed → accepted` is a social fact that a human ratifies and no script can
derive. `built → wired → verified` is a mechanical fact that no human should be trusted to assert.
Bolting the second onto the first produced a word that reliably means neither.

So: **two axes, on two keys.**

| Axis | Key | Values | Who decides | Derivable? |
|---|---|---|---|---|
| **Decision** | `status:` | `Proposed` · `Accepted` · `Deprecated` · `Superseded` — **rUv's enum, unchanged, no additions** | a human | **No, by nature** |
| **Implementation** | `impl:` | `unbuilt` · `built` · `wired` · `verified` | the artifact | **Yes, all four** |

The owner's four states map without loss, and gain the rung that matters:

| Owner's word | This schema | Why |
|---|---|---|
| planned | `status: Accepted`, `impl: unbuilt` | agreed, no code |
| built | `impl: built` | governed paths exist |
| **implemented** | **`impl: wired`** | exists **and is reachable from a non-test caller** |
| verified in sync | `impl: verified` + `verified:` + `verified_digest:` | §3 |

`built` and `wired` are separated because the gap between them is this repo's signature failure.
It is documented in-repo, dated 2026-07-22, in `plugin/scripts/version-bump-gate.sh:64-67`:

> *"This gate hardcoded its own message for months while lesson L05 — the identical rule, recorded 52
> times across 4 projects — sat in a store that nothing read. A grep for `lessonsFor` across every
> gate returned zero: lessons were mined, weighted, trust-boundaried, and consumed by nobody."*

Mined, weighted, trust-boundaried, tested — and unreachable. Under one axis there is no honest word
for that state, so it gets called `Implemented`. Under two, it is `impl: built`, and the distance to
`wired` is a grep: **does a non-test file call it?** The repo's most expensive recurring mistake
becomes a one-line mechanical check, which is the entire reason for the extra rung.

**Anti-corruption is structural, not conventional.** Axis 1 keeps rUv's key and rUv's exact values —
we add nothing to `status:`, and ADR-013 and ADR-018 must be corrected off `Implemented` onto
`Accepted` + `impl: wired`. Axis 2 lives on **new keys** (`impl:`, `governs:`, `verified:`,
`verified_digest:`) that rUv's tooling does not read and will ignore. We extend; we never overload.
Redefining `status:` would break `adr-index`, `adr-verify`, and the AgentDB causal-edge import for
the sake of a word — the definition of fighting the ecosystem.

### 2. `impl:` is derived. Every value has a check.

| Value | Derivation | Fails when |
|---|---|---|
| `unbuilt` | no path in `governs:` exists | a governed path exists → contradiction, warn |
| `built` | ≥1 governed path exists | claimed with no path existing → **block** (self-refuting) |
| `wired` | ≥1 governed path referenced from a non-test, non-doc file | zero call sites → warn loudly (the L05 failure) |
| `verified` | §3 digest matches | mismatch → derived-downgrade to `verification-expired` |

`wired` warns rather than blocks, deliberately. Dynamic dispatch, hook-invoked scripts, and
`plugin/hooks/hooks.json` entries are reachable without a greppable caller — a false block on a
correctly-wired hook is exactly the wolf-cry that gets a gate switched off. ADR-024 made the same
call and said so: *"Deliberately scoped to receipt/status tokens — a gate that cries wolf gets
disabled."*

### 3. `verified in sync` — the stamp must contain something you cannot type from memory

This is the crux, and it follows directly from the measurement: **every stamp this system has ever
had was typeable, and 4 of 20 are already wrong.** A date can be recalled, guessed, or copied from
the line above. Correctness of a date is unfalsifiable at a glance. So the verification stamp carries
a value that can only be obtained by running the check:

```yaml
governs:
  - scripts/lesson-gate.mjs
  - scripts/lesson-store.mjs
verified: 2026-07-22
verified_digest: 1a8c4c9600fe
verified_by: node scripts/doc-currency.mjs --verify ADR-034
```

The digest is the git object id of the governed set — one line, no new machinery, verified working
before being written into this ADR:

```sh
for p in $(governs); do git rev-parse "HEAD:$p"; done | sort | git hash-object --stdin | cut -c1-12
#   scripts/lesson-gate.mjs + scripts/lesson-store.mjs  →  1a8c4c9600fe
```

**The check:** recompute the digest at HEAD. Match → the governed code has not moved since a reader
said the document described it. Mismatch → `impl:` reads `verification-expired` **as a derived
value**, regardless of what the file says. Nobody un-verifies by hand. The artifact does it, which
is ADR-024's law applied where we never applied it.

**What this is worth, stated honestly, because the label overclaims if left alone.** This is a
**freshness proof, not a correctness proof.** It proves the code has not changed since a human or
agent read the two together. It cannot prove the reading was careful, or that it happened at all.

Two mitigations and one residual we are not solving:

- **A verification must emit a claim ledger** — each normative claim in the document mapped to the
  `file:line` that satisfies it, the exact shape `scripts/claims-verify.mjs` already uses for
  numbers. A `verified:` stamp with a missing or empty ledger is **rejected**. This makes a lazy
  verification expensive to fake rather than impossible, which is the honest framing.
- **A contradicted verification blocks.** Stamping `verified` in a commit whose own diff moves a
  governed path is a claim the artifact refutes in the same breath, and it is the one currency
  failure that is fabrication rather than neglect. ADR-020's rules apply, and it fails closed.
- ❌ **Unsolved: `governs:` is itself an asserted field.** A document with a narrow or wrong
  `governs:` list verifies against almost nothing and shows green — a perfect forgery requiring no
  intent, only carelessness. Partial mitigation: warn on an empty `governs:`; warn when a commit
  message names an ADR id but touches no path that ADR governs. This is a real hole. ADR-024 hit the
  identical wall (*"a lexical layer can in principle be gamed"*) and recorded it rather than
  papering over it; so do we.

### 4. Stamps: `updated:` is machine-readable, the *why* is a table

The owner asked for three things — created, updated, and **why updated**. The first two are single
values and belong in frontmatter. The third is a history, and YAML is a bad place for history: it
grows unreadable, diffs badly, and nobody reads it. So:

- `date:` — created. Written once, **never edited**. Any diff touching it is a rewrite of the past
  and is blocked.
- `updated:` — the latest change. Must equal the top row of the currency log (self-consistency,
  derived) **and** the date of the commit carrying the change (derived from git, not typed).
- `## Currency log` in the body, newest first:

```markdown
| Date | What changed | Why |
|---|---|---|
| 2026-07-22 | §4 rewritten; `impl:` added | ADR-030 L05 wiring landed in `scripts/lesson-gate.mjs` (b3f2a1c); §4 still described the pre-wiring shape |
```

**How a gate distinguishes a real *why* from filler.** It cannot judge meaning, and a gate that
claims to would be a fifth lie-shaped status. It checks **structure**: the *Why* cell must contain
at least one **resolvable referent** — a path that exists on disk, an `ADR-0NN`/`DDD-0NN` that
exists, a git SHA that resolves, an issue number, or a dated quote (`YYYY-MM-DD` adjacent to a
quotation mark). Every referent is checkable in milliseconds with no model call.

- *"updated docs"* — zero referents. **Fails.**
- *"§4 rewritten because the L05 wiring landed in `scripts/lesson-gate.mjs` (b3f2a1c)"* — three.
  **Passes.**

❌ **Known bypass, recorded not hidden:** pasting a real path beside an unrelated sentence passes.
The check raises the cost of filler; it does not detect insincerity and must never claim to. What it
does reliably kill is the *empty* why — which is the failure that actually happens, because filler is
written by someone in a hurry, and a hurried person types "updated docs", not a plausible SHA.

### 5. Staleness is drift, never age

The distinction the owner drew, made mechanical. Two clocks:

- **doc-clock** = `git log -1 --format=%ct -- <doc>`
- **code-clock** = `git log -1 --format=%ct -- <governs…>`

**Drift = code-clock > doc-clock.** Age is not in the formula anywhere, and that is deliberate:
ADR-0021 (shared hook input parser) is untouched since 2026-07-18 and, if its governed code has not
moved, it is **current** — flagging it for being four days old is a false positive, and false
positives are how this repo's own hooks say gates die. **`old` and `stale` are orthogonal. Only
drift is real.**

| Drift | State | Response |
|---|---|---|
| none | `current` | silent |
| ≤1 commit **or** <2 days | `lagging` | silent — writing code before updating the doc *within a session* is normal, and blocking it makes doc-editing a prerequisite for every commit |
| ≥2 commits **or** ≥7 days | `presumed-stale` | **warn**, listed with the drifting commits |
| `verified:` present, digest mismatched | `verification-expired` | **warn loudly**; blocks only per §3 |

`presumed-stale` is a presumption, not a verdict: a document may be entirely correct while its
governed code churns. The state says *"nobody has checked since the code moved,"* which is exactly
what is true, and is why the resolution is a verification pass — not an edit.

### 6. The gate: blocks four things, warns about everything else

`plugin/scripts/doc-currency-gate.sh`, built to the contract its five siblings already use
(`version-bump-gate.sh:20`): **exit 0 = allow · exit 2 + stderr = BLOCK · FAILS OPEN on anything
unparseable**, opt-in via the router profile.

**BLOCKS** — only where the check is mechanical, the false-positive rate is zero, and the fix takes
seconds:

1. An ADR or DDD **added or edited in this push** with a missing `status:`, `date:`, or `updated:`.
2. `updated:` not equal to the commit date of the change carrying it — *derived from git, not typed*.
3. A currency-log row missing, or its *Why* cell carrying zero resolvable referents.
4. A `verified:` stamp the diff contradicts, or an `impl:` value the artifact refutes (`built` with
   no governed path existing). Fabrication, not neglect — ADR-020 territory.

**WARNS, never blocks** — everything requiring judgement: `presumed-stale`, `impl: wired` with no
greppable call site, `verification-expired`, empty `governs:`, and **the twelve unstamped legacy
ADRs**. Those twelve are reported by `scripts/doc-currency.mjs --report` and never gate a push:
retro-stamping twelve documents is not a push-time job, and a gate whose first act is to block on
twelve pre-existing violations is a gate that gets disabled on day one, which returns us to zero.

**Escape hatch:** `RUVNET_SKIP_CURRENCY_GATE=1`, mirroring `RUVNET_SKIP_VERSION_GATE=1`
(`version-bump-gate.sh:32`) — deliberate, and said out loud. Public plugin users are never blocked by
this repo's internal discipline; that is the same reasoning ADR-024 used to reject a fail-closed
profile check, and it holds here for the same reason.

## Anti-goals

- **A currency score.** A number invites optimizing the number. There is no percentage anywhere in
  this design, by construction.
- **Blocking on staleness.** The most tempting and most fatal choice. Drift is a presumption; a
  presumption that stops work gets the gate removed, and a removed gate protects nothing.
- **Auto-writing the *why* from the diff.** A machine can describe *what* changed from the diff. The
  owner asked for *why*, which is intent, and intent is not in the diff. A generated why-line is
  filler that passes the referent check — the one bypass we would be building deliberately.
- **Retro-stamping ADRs 0001–0012 from inference.** Nobody now knows what those dates were. A
  reconstructed stamp is a fabricated number on a user-facing surface, which this project's standing
  order forbids outright. They stay unstamped and *visibly* unstamped.
- **A fourth lie-shaped status.** If a state cannot be derived from an artifact, it does not get a
  value on `impl:`. It gets prose in the body, where a reader can see it is a claim.

## Consequences

- Every ADR gains a `governs:` list, which is real work and the schema's real cost. It is also the
  first machine-readable link this repo has ever had between a decision and its code — the thing
  ADR-0009 identified as *"smeared across four uncoordinated places"* sixteen days ago.
- ADR-013 and ADR-018 must move off `status: Implemented` (not a rUv value) onto `Accepted` +
  `impl:`. That is a correction of a real error, not a migration cost.
- **New risk:** `impl: verified` reads as stronger than it is. A freshness proof will be read as a
  correctness proof by anyone who has not read §3, and the label invites it. The claim ledger is the
  only thing standing between the two, which makes §3's ledger requirement load-bearing rather than
  procedural. If the ledger requirement is ever relaxed, `verified` becomes the fifth lie-shaped
  status and this ADR will have caused the exact failure it was written to end.
- Four gates already govern the push boundary. This is a fifth, and each one is latency and one more
  thing to fail open. The bound is ADR-030's: gates scale with decision *types*, and "am I shipping a
  document that lies about the code?" is a type, not an instance.

## Deliberately NOT in this round

1. **Semantic verification that prose matches code.** No honest mechanism exists. §3 proves
   freshness; a claim to prove correctness would be the thing this ADR exists to stop.
2. **Anything outside `docs/adr/` and `docs/ddd/`.** README, PROGRESS, skills, and the primer all
   drift too, and none has an explicit mapping to code. Start where `governs:` is writable.
3. **Retro-stamping 0001–0012** (see Anti-goals). Reported forever, blocked never.
4. **A console surface for currency.** ADR-032 owns the surface question. Currency ships as a CLI
   report and a gate first — the pattern ADR-030's lesson store followed, and the reason it exists at
   all today.
5. **DDD header unification.** Measured 2026-07-22: six DDDs, **four different header shapes** —
   `**Status**` only (0001, 0005), `Updated:`/`Created:` with timestamps (0003, 0004), date-only
   (0006, 0007), and nothing at all (0002). DDD-0005 and DDD-0006 were written *on the same day, in
   the same session family*, in two different shapes. Worth fixing; not worth coupling to this.

## Currency log

| Date | What changed | Why |
|---|---|---|
| 2026-08-22 | Re-read `scripts/doc-currency.mjs` and `scripts/git-hooks/pre-push`; no decision change. | Commit `b1172a7` added the already-declared `sync-census.mjs --check` and `sync-commands.mjs --check` authorities to the same pre-push boundary that invokes document currency. The additions strengthen the boundary's single-purpose checks without changing this ADR's derivation, drift, or fail-open rules. |
| 2026-07-28 | Re-read `scripts/doc-currency.mjs` and `scripts/git-hooks/pre-push`; no decision change. | The adversarial release run at SHA `879b928` correctly blocked on six stale governed documents. This row is committed with the repaired documents and code, proving the chokepoint remains fail-closed rather than bypassing its findings. |
| 2026-07-27 | **Corrected this document's drift from its own implementation**, under ADR-056. `impl:` claim `unbuilt` → derived `built`; removed `plugin/scripts/doc-currency-gate.sh` from `governs:` (never built — one unresolvable path dragged the whole weakest-member-wins derivation to `unbuilt`, so the honest mechanism reported the dishonest answer for an honest reason); replaced the `docs/adr/` + `docs/ddd/` **directories** — which this document's own §6 forbids — not with globs (the set expanded to all 67 docs and went permanently `presumed-stale`) but with the two files that actually implement it. The gate now lives in `scripts/git-hooks/pre-push` per ADR-056 §5 | The body asserted *"`scripts/doc-currency.mjs` does not exist"* for five days while that file sat beside it at 780 lines with 43KB of tests, committed the same day. Found 2026-07-27 by the owner's third rule; `wired-check` had also been reporting the script `wired` because `package.json:35` DEFINED an npm alias for it — now `wired` for real, caller `scripts/git-hooks/pre-push` |
| 2026-07-22 | Created | Owner, 2026-07-22: *"Is it VERIFIED TO BE IN SYNC with the resulting output?"* — measured the same day: 12 of 32 ADRs in `docs/adr/` carry no status or date, and 4 of the 20 stamped ones already carry an `updated:` older than their own last commit |

## Verification (what must be true before this is Accepted)

1. ❌ `scripts/doc-currency.mjs` exists and derives all four `impl:` values on this repo's real
   `docs/adr/`, producing at least one finding that is true and was not already known.
2. ❌ The digest check **fails on a known-bad fixture** — a document stamped `verified:` whose
   governed path has moved — on every run, the self-proving pattern
   `tests/unit/derived-status.test.mjs` established for ADR-024. A check that cannot demonstrate
   failure has not demonstrated anything.
3. ❌ The gate is proven **not** to fire on: an old-but-undrifted ADR (ADR-0021), a hook-invoked
   script with no greppable caller, and a same-session code-then-doc commit sequence. Over-blocking
   is the designed failure mode; it must be tested for directly, not assumed absent.
4. ❌ The *why*-referent check is run against the twelve real currency-log entries a week of use
   produces, and the false-positive rate is reported honestly — including whether anyone gamed it.
5. ❌ ADR-013 and ADR-018 corrected off `status: Implemented`; ADR-0009 given the stamps it decided
   everything else should have.
6. ❌ **The load-bearing one:** thirty days after the gate ships, re-run the measurement at the top of
   this document. If the count of drifted stamps has not fallen to zero, the gate is not doing what
   prose failed to do and this ADR joins ADR-0009 as a second decided-and-decayed convention. That
   comparison is the only evidence that matters, and it cannot be run today.
7. ❌ Adversarial cross-model review recorded (standing order, 2026-07-18) — outstanding.
