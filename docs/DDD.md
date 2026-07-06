# RuvNet Brain — Domain Model (DDD)

`Updated: 2026-07-06 14:30 EDT | v0.2`

RuvNet Brain is two coupled products: a **build-and-serve pipeline** (make the knowledge bundle) and a
**live partner** (behave like rUv on the user's shoulder, and keep itself honest and current). DDD here
keeps each concern at its own level of sophistication and prevents cross-context leakage (grading logic
must not creep into ingestion; enforcement must not assume knowledge it doesn't have; a *nudge* must not
claim to be a *gate*). v0.2 adds the serve-side contexts that shipped in the 2026-07-05/06 work (presence,
proposal-contract, currency, self-improvement) and the **self-QA** discipline of ADR-0009, and reconciles
the Enforcement invariant to what actually ships.

## Ubiquitous language
- **Repo** — a RuvNet GitHub repository at a pinned commit SHA.
- **Chunk / Passage** — a ~4k-char span of real source/doc text; the unit of retrieval. FULL text always
  joined back (never embeddings-only).
- **Symbol** — a `pub fn`/`struct`/`trait`/exported binding → `repo:file:line` (the point-deeper target).
- **Segment** — one repo's HNSW store; the Brain is a set of segments, not one merged index.
- **Layer (L0–L4)** — human primer / AI gate / concept ("RuvNet way") / deep source / structure.
- **Grounded answer** — an answer whose load-bearing claims cite source the grader fetched and verified.
- **Drift** — an answer that dismisses or routes around RuvNet architecture (the failure to suppress).
- **Nudge vs Gate** — a *nudge* injects a directive the model may follow (soft); a *gate* structurally
  blocks or fails-closed (hard). Confusing the two is a domain error (see ADR-0009 defect 2).
- **Running vs Staged version** — the version *loaded in this session* vs the newer copy sitting on disk
  awaiting a restart. Only the running version acts; the status footer must never present staged as running.
- **Product version** — the single source of truth: `plugin/.claude-plugin/plugin.json` `version`. Every
  other surface reads it; none hand-copies it (ADR-0009 decision 1).

## Bounded contexts (each its own aggregate + level)

### Build-and-serve pipeline (make the bundle)
1. **Ingestion** — walks a Repo, produces Passages + census. *Invariant:* chunks == passages == ids
   (reconcile-or-fail). Knows files, not vectors.
2. **Indexing** — embeds Passages (best/multi-vector), builds the Symbol index + repo Graph + ADR status.
   *Invariant:* every vector has a passage; symbols resolve to real lines.
3. **Synthesis (L2)** — generates "the RuvNet way" articles. *Invariant:* ≥2 citations to **Implemented**
   code, ADR-checked; un-citable → rejected. (Highest-risk context — most guarded.)
4. **Verification / Grading** — the gate of record. Fetches cited source, checks support, runs an
   independent deep-dive re-answer, multi-vendor panel. *Invariant:* citations must hold against real
   source; no same-family LLM is final.
5. **Distribution** — assembles the zip bundle (segments + passages + symbols + graph + primers + gate +
   signed manifest). *Invariant:* self-contained; one `.mcp.json` line wires it. **Smoke-gated** (ADR-0009
   decision 3): a bundle that cannot answer 3 canonical questions with a cited hit does not publish.
6. **Evergreen / Currency** — the single owner of "is anything stale?" (ADR-0009 decision 6): registry +
   SHA-pinned rebuild + the nightly publisher + the user-side plugin/KB/stack-package checks. *Invariant:*
   one version-compare implementation, one stamp discipline; a stale brain pages; a **failed** rebuild never
   ships (publisher aborts the Release on any per-repo failure).

### Live partner (behave like rUv, stay honest)
7. **Presence / Watchdog** — the always-on signal that the brain is here and what the project's stack looks
   like: the SessionStart banner + the per-response status footer + the filesystem stack check (Ruflo wired?
   AgentDB memory fresh? packages current?). *Invariant:* reports **ground truth from the filesystem**, never
   impressions; the footer shows the **running** version (staged shown as staged, never as running).
8. **Proposal-Contract** — the "take the wheel" behavior: hear → attack-plan → fit-to-their-code → what-I-
   checked → cleared-to-go, calibrated to developer level. *Invariant:* **one canonical definition** (ADR-0009
   decision 6) that the shell hook and the skill both read — not two prose copies that drift. Never a nudge
   dressed as a gate.
9. **Enforcement** — the host-side grounding. *Invariant (RECONCILED in v0.2):* enforcement is **retrieve-
   and-inject only** today — a *nudge*, not a lock. The PreToolUse hard-deny is `defer` (advisory), the `Stop`
   judge is **not wired**, and there is **no measured drift-rate SLO**. The context must **never claim more
   than it does** (this replaces v0.1's aspirational "measured drift-rate ≤ SLO" invariant, which was unmet —
   see ADR-0005 reconciliation, ADR-0009 decision 2).
10. **Self-Improvement / Eval** — the behavioral flywheel (ADR-0009 decision 4, grounded in ruflo ADR-176/177):
    contract variants are candidates; a **frozen held-out** scenario suite + graded field transcripts are the
    gate. *Invariant:* a variant is promoted only if it beats the incumbent and regresses nothing on the
    frozen set; scores are **measured, never predicted**.
11. **Self-QA** — the Mirror Discipline made a capability (ADR-0009 decision 5): ADR-QA (an ADR's claims must
    match its code), DDD-QA (named contexts must exist, anti-corruption boundaries must hold), doc-currency
    (every version/feature claim must agree with the product version and shipped reality). *Invariant:* the
    brain runs these on **itself first** — this DDD and ADR-0009 are the first artifacts under audit.

## Anti-corruption boundaries
- Ingestion ↔ Indexing: passages cross by id only; Indexing never re-reads the repo.
- Synthesis ↔ Verification: an L2 article is just another graded answer — no special pass.
- Enforcement ↔ everything: enforcement consumes the served bundle; it never assumes un-retrieved knowledge,
  and never claims a gate it doesn't structurally have.
- Presence ↔ Proposal-Contract: Presence reports *state* (footer/watchdog); it must not drive *behavior*.
  The Proposal-Contract owns behavior; it reads Presence's facts but doesn't re-derive them.
- Currency ↔ everyone: exactly one context owns "is X stale?" All others call it; none re-implement
  version-compare + registry-fetch + stamp (the v0.1 smear this boundary exists to end).
- Self-QA ↔ Verification: Self-QA audits *artifacts* (ADRs, DDD, docs, versions); Verification grades
  *answers*. Different subjects, same honesty bar.

## Aggregate roots
`ProductVersion` (`plugin.json.version`, vMAJOR.MINOR.PATCH) is the **single** root of identity: every other
surface reads it. `BrainVersion` (the bundle's provenance in `manifest.json` + `kb/SOURCE.json.releaseTag`)
is a *derived* stamp of the corpus, not an independent hand-typed number. A BrainVersion is publishable only
when GradeReport (ground-truth) + the **smoke gate** (answers 3 canonical questions) + Manifest (signed) are
all green, and no repo in the rebuild set failed. A ProductVersion ships to users only when the eval-gate
(Self-Improvement) does not regress the frozen behavioral suite.
