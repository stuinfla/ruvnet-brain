# Memory Durability SOTA Report — 2026

**Rotation**: SLOT=4 → DEEP=memory-durability, SCAN=managed-boundary,round-trip-proof (no bonus dive: DAYINT%25=24, DAYINT%75=49)
**Session commit**: e89ea1ba167d9252ec99910304f534c8da5ca0ab
**Date**: 2026-09-24

## TL;DR

`plugin/scripts/project-progression-reader.mjs` — the read-only `node:sqlite` fast path this
repo's own "exact-key round trip" evidence (`project-progression-store.mjs`'s `appendExact`)
partly depends on for its independent read leg — silently **vivifies `-wal`/`-shm` sidecar files**
on a resting WAL database (the normal state of a real `.swarm/memory.db` between checkpoints),
contradicting the module's own documented invariant ("It never writes... This path takes no lock
and mutates nothing."). This is the exact WAL-open hazard `memory-doctor.mjs` already discovered,
measured and worked around for the `sqlite3` CLI path (2026-07 era) — but the fix was never
migrated to this newer, sibling `node:sqlite` reader. Fixed by mirroring `memory-doctor.mjs`'s
sidecar-presence-decides-mode pattern, with a per-read re-check against a writer racing in mid-flight.

## What's new

- **Reproduced, not assumed.** A disposable script created a WAL-mode SQLite database, checkpointed
  it to a resting state (no sidecars — the common state of an idle project memory store), then opened
  it exactly as this reader does (`new DatabaseSync(dbPath, { readOnly: true })`) and ran one `SELECT`.
  Result: `-wal` and `-shm` both appear on disk afterward. Grade **A** (reproducible on this container,
  Node v22.22.2, `node:sqlite` experimental).
- **The fix already existed in this codebase, unmigrated.** `plugin/scripts/memory-doctor.mjs`
  solved precisely this for the `sqlite3` CLI in 2026-07 (own file comments: "MEASURED (fresh WAL db,
  same file, three ways)..."), gating `immutable=1` on sidecar absence and re-verifying absence
  post-read to catch a writer arriving mid-flight. `project-progression-reader.mjs` — added later —
  never carried that lesson over.
- **`immutable=1` is not a free upgrade — verified the trap too.** Forcing `immutable=1` while a
  writer's frames are genuinely pending (sidecars present) returns **wrong data**: reproduced live,
  an immutable-mode open of an actively-written WAL database reported `no such table: memory_entries`
  for a table that unquestionably existed and was mid-write. The fix therefore only uses `immutable=1`
  when sidecars are absent at open time, keeps plain `readOnly` when they are present, and re-checks
  after every read so a writer that arrives during the reader's lifetime is caught, not trusted.

## Competitors (how they treat read-only WAL access)

| Project | Approach | Grade |
|---|---|---|
| Sakana AI Scientist | No documented direct SQLite read-only concurrency handling in its public experiment harness; relies on file-based artifacts, not a live shared DB | C |
| OpenHands | Uses a session-scoped SQLite store per agent process; avoids concurrent-reader/writer WAL contention by construction rather than solving it | B |
| DSPy/GEPA | No persistent shared SQLite memory store in the optimizer path; not directly comparable | C |
| SWE-agent | Trajectory logs are JSONL/append-only, sidestepping the WAL reader problem entirely rather than solving it | B |
| Cursor background agents | Proprietary; no public documentation of its memory/store concurrency model | C |

None of the five solve "read-only, in-process, zero side effects, against a live external writer's
WAL store" — this is a narrow, product-specific problem inherited from re-implementing a fast path
around `ruflo`'s (an external, unversioned-here dependency's) on-disk format, not a novel invention
being pitched as prior art.

## Frozen hypothesis (before evaluation)

> Given a resting (no-sidecar) real or fixture WAL-mode `memory_entries.db`, when
> `openProgressionReader()`/`withProgressionReader()` is used to list keys or read content, then the
> operation should complete without creating `-wal`/`-shm` sidecar files, subject to: identical
> query results vs. the unfixed code; a genuine mid-read writer race must still be caught and
> reported as `ProgressionReaderUnavailable` rather than silently trusted.

Not modified after evaluation began.

## Candidate

`plugin/scripts/project-progression-reader.mjs` (+31/-4 lines):
- new `walSidecarsPresent(dbPath)` helper (the same signature `memory-doctor.mjs` already trusts).
- `openProgressionReader()` now opens via `file:${encodeURI(dbPath)}?immutable=1` when sidecars are
  absent at open time, plain `dbPath` when present; re-verifies sidecar absence immediately after
  open (catches a writer racing the presence check) and again inside `query()` after every
  `listKeys`/`readContent` call (catches a writer arriving later in the reader's lifetime).
- No public API change: `openProgressionReader`, `withProgressionReader`, `listKeys`, `readContent`
  keep their exact signatures and `{ok, value}` / `{ok:false, reason}` contract.

## Baseline vs candidate (real evaluator, not inferred from logs)

`npx vitest run tests/unit/project-progression-reader.test.mjs` (12 tests, includes 2 new TEETH tests):

| | baseline (`git stash` to `e89ea1b`) | candidate |
|---|---|---|
| `NEVER WRITES` sidecar test | **FAIL** — `expected true to be false` (sidecars vivified) | PASS |
| mid-read writer-race test | **FAIL** — `expected [Function] to throw` (silently trusted stale) | PASS |
| other 10 pre-existing tests | 10/10 pass | 10/10 pass |

`npm run test:integration` (313→ same 407 tests both runs): **23 failed / 323 passed / 16 skipped / 45
todo, byte-identical file-and-test-name set baseline vs candidate** (diffed with `diff` over sorted
`FAIL` lines — zero difference). All 23 pre-existing failures are this container's own known
environmental gaps: no global `ruflo` binary (`project-progression-reader-identity`,
`project-progression-restore-semantics`, `project-progression-concurrent-sessions`,
`project-progression-checkpoint` — all assert `expect(ruflo, '...must not vacuously skip')`), no
network/model cache for the cross-encoder regression fixture, and pre-existing EACCES-under-root
fixtures (`anticipate*`, `console-apply-timings`, `health-repair*`) unrelated to this file.

`npm run claims:verify`: 3 PASS / 4 SKIP — identical to the pattern every prior memory-durability
night has recorded on this container (no local brain corpus materialized).

`npm run eval:gate`: **EVALUATED=blocked** — `no brain at /root/.cache/ruvnet-brain/kb` (this
container never materializes a corpus; independently confirmed via `restore-local-ingests.mjs` and
`store-root.mjs`, both `stores 0 dark 0`). Not this candidate's surface (grounding/retrieval) anyway.

## Darwin

Not run. Bounded Darwin activates only after a testable, model-scored candidate clears basic
evaluation; this candidate is a deterministic, structural fix with a real red→green unit receipt —
Darwin's mutation search has nothing to explore here (there is one correct fix, already verified).

## Evidence classification

- MEASUREMENT: the sidecar-vivification reproduction (3 independent repro scripts, kept in the PR's
  linked evidence).
- MEASUREMENT: the `immutable=1`-on-pending-WAL data-loss trap, reproduced live.
- MEASUREMENT: `test:integration` byte-identical baseline/candidate failure sets.
- DECISION: mirror `memory-doctor.mjs`'s established mode-selection pattern rather than invent a new
  one — same trade-off, same codebase, already reviewed once.
- HYPOTHESIS (untested tonight, out of scope): whether any *other* direct `node:sqlite`/`better-sqlite3`
  reader elsewhere in this codebase has the identical un-migrated gap. A repo-wide grep for
  `DatabaseSync(` outside this file found none in `plugin/scripts/` or `scripts/`; not exhaustively
  checked against `kb/`.

## Reward-hack / adversarial critique (independent pass, not the candidate's own claim)

- Weakens a benchmark or gold data? No benchmark or eval fixture touched.
- Cherry-picks? No selective reporting — full `test:integration` diff shown, including all 23
  pre-existing failures, not filtered to convenient ones.
- Exploits the evaluator? N/A — no evaluator scoring involved in this surface.
- Hides cost? `fs.existsSync` calls added (2 per query, 1 per open) are sub-millisecond; the reader's
  own documented ~1ms/read budget is unaffected in substance.
- Touches a threshold? No.
- Relies on an undocumented cache? No.
- Blast radius: grepped every caller of `openProgressionReader`/`withProgressionReader` repo-wide —
  exactly three (`project-progression-store.mjs`, `project-progression-producer.mjs`,
  `project-progression-session-start.mjs`), all consume only the unchanged `{ok, value}` /
  `{ok:false, reason}` contract; none inspect sidecar files themselves. CLEAR.

## Security review

No prompt-injection, credential, network, or permission-scope surface touched. The `encodeURI`-into-
`file:` URI pattern is not new — it is the identical pattern `memory-doctor.mjs` already ships for
the same reason (paths containing spaces breaking a raw URI); `dbPath` here is always the
internally-resolved `canonicalAgentDbPath`, never user-supplied free text. The new
`ProgressionReaderUnavailable` throw on a detected writer race is strictly more conservative than
current behavior (falls back to the CLI instead of returning a possibly-torn read) — narrows,
does not widen, the trust boundary.

## Scan findings (this cycle's two SCAN surfaces, both memory-durability, both no new issue)

- **managed-boundary**: Re-read ADR-063's Currency log and `tests/unit/managed-memory-boundary.test.mjs`
  fresh. The one standing documented gap ("not proof the command did not execute", 2026-08-06) is a
  host-trust limitation this repo cannot close from inside a hook script — it depends on Claude
  Code/Codex actually honoring a PreToolUse deny, which `tests/mesh/coexistence.test.mjs` and the
  both-hosts conformance gate already exercise at the level that IS locally provable. No new,
  actionable, reproducible gap found tonight; not reopened per the ISSUE DISPOSITION OVERRIDE
  ("historical ledger finding is not a reason to reopen it" — this was never a ledger finding, just
  an ADR-recorded honest limitation).
- **round-trip-proof**: this cycle's candidate IS a round-trip-proof finding — the independent read
  leg (`node:sqlite`) that `appendExact()`'s digest-verification round trip prefers over the CLI was
  silently mutating disk state next to the store it reads. Fixed above.

## Gist

**LOCAL** — no `gh` CLI binary and no gist-creation MCP tool available in this session (GitHub API
access for issues/PRs IS available via the `mcp__github__*` tools, confirmed via `get_me`). Not
fabricated; consistent with every prior night's ledger entries under this same constraint (e.g.
2026-08-31: "GIST: LOCAL — no `gh` CLI or gist-creation tool available this session").

## Witness

- REPORT_HASH = `cdb455062250d4ba587683113e8e7592d84e657a2fc61ba1ce7ebddf23b30b97`
- SESSION_COMMIT = `e89ea1ba167d9252ec99910304f534c8da5ca0ab`
- WITNESS = `b7723a4b437a94f987fd8763776a06230cc2fa69409159f4988fac6fb8e0ba53`

(REPORT_HASH is the sha256 of this file as it stood immediately before this section was rewritten
with the computed values, per the compiled routine's own witness-stamp procedure. Verifier procedure: (1) fetch this exact
gist/report text, (2) `sha256sum` it → must equal REPORT_HASH, (3) `git rev-parse <PR branch tip>`
on the reviewer's own clone should show this commit or a fast-forward of it, (4) concatenate
REPORT_HASH+SESSION_COMMIT and `sha256sum` → must equal WITNESS, (5) re-run
`npx vitest run tests/unit/project-progression-reader.test.mjs` on `main` and on the PR branch and
diff — must reproduce FAIL→PASS exactly as reported above.)

## Recommendation

ACCEPT for human review: small (one file + its test, ~65 changed lines), fully reproduced,
zero-regression (byte-identical `test:integration` failure set), fixes a real documented-invariant
violation using an already-reviewed pattern from the same codebase. Merge policy: human review
required; this session never self-merges.
