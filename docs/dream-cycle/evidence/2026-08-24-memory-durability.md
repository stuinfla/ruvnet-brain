# Memory-Durability SOTA Report — 2026

**Dream Cycle 2026-08-24 · DEEP=memory-durability · SCAN=managed-boundary,round-trip-proof · SLOT=4**
**Repo:** `stuinfla/ruvnet-brain` · **Session commit (base):** `72f079f3fb4c562da91aa848e7fade448ff665b6`

## TL;DR

`scripts/record-lesson.mjs` — the repository's dedicated, human-run "capture a durable lesson"
CLI — determined success by regex-matching the `ruflo memory store` command's own stdout wording
(`/OK|stored/i`). That is the exact evidentiary shape of the 2026-08-13 incident this repository
already has an ADR about (ADR-063): `ruflo memory store` printed `[OK] Data stored successfully` on
every call for three days while the write itself left rowcount 0, and three days of memory were
lost. This repo's own established discipline — reused in `degradation-watch.mjs`'s
`proveMemoryDurable()` and `learning-replay-fixture.mjs`'s `retrieveExact()` — is that the only
accepted proof of a memory write is retrieving the *same key* back through the managed interface and
reading the returned VALUE. `record-lesson.mjs` had never been updated to that discipline, and (a
second, related gap) hardcoded the bare command name `ruflo` instead of the shared `resolveRuflo()`
resolver that three sibling scripts already use (ADR-021 / issues #99, #105) — which is also why the
script had zero test coverage: it could not be pointed at a fake binary for a test.

Tonight's candidate makes `record-lesson.mjs`'s exit code depend on an exact-key round trip, and
routes it through the shared resolver so it is testable and consistent with its siblings.

## What's new

- `record-lesson.mjs` now calls `ruflo memory retrieve -k <key> -n <ns> --value-only --path <db>`
  after `store`, and its `stored` verdict (which gates the process exit code) is
  `retrievedValue.includes(writtenValue)` — never the store command's own claimed-success text.
- `record-lesson.mjs` now resolves the `ruflo` binary via `plugin/scripts/ruflo-bin.mjs`'s
  `resolveRuflo()` (honors `RUFLO_BIN`, then `~/.npm-global/bin/ruflo`, then a PATH walk), matching
  `distill-project.mjs`, `learn-flush.mjs`, and `degradation-watch.mjs`'s own probe.
- New test file `tests/unit/record-lesson.test.mjs` (0 lines of coverage existed before tonight): a
  fake-binary harness reproducing the exact 2026-08-13 incident shape (`store` claims success,
  `retrieve` on the same key answers "Key not found"), a healthy round-trip case, a damaged-store
  case (a SQL-layer error rather than "Key not found" — added after an independent critic pass
  flagged that the first three cases alone couldn't discriminate a genuine value comparison from a
  shallower "not literally Key-not-found" check), and a fails-loudly-not-silently case for an
  unresolvable binary.

## Five candidates considered (this session's own architecture review — no external issue tracker mined)

| # | Candidate | Fit | Novelty | Testability | Measurability | Prod-value | Reviewability |
|---|---|---|---|---|---|---|---|
| **1 (selected)** | `record-lesson.mjs`'s stored-verdict trusts CLI wording, not an exact-key round trip; also bypasses the shared `ruflo` resolver | 5 | 4 | 5 | 5 | 4 | 5 |
| 2 | `docs/ARCHITECTURE-MAP.md` / `wired-check.mjs` both assert a `record-lesson.mjs -> lesson-store.mjs -> lesson-ratify.mjs` pipeline that does not exist in code (`record-lesson.mjs` never imports `lesson-store.mjs`) | 2 | 3 | 3 | 3 | 2 | 4 |
| 3 | `restore-local-ingests.mjs`'s classifier (PR #143, merged Night 1) still can't distinguish ENOTDIR/EACCES from a real wipe — a fast-follow gap PR #155's own critic already logged and deferred | 4 | 2 | 4 | 4 | 3 | 4 |
| 4 | Re-verify `hijack-ruvnet.sh`'s managed-store matcher against the currently shipped `hooks.json` wiring (regression check, not a new defect) | 4 | 2 | 3 | 3 | 3 | 3 |
| 5 | Audit `memory-doctor.mjs`'s hardcoded `learns` thresholds (`cover>=0.5`, `distilled>=0.05`) for empirical provenance | 3 | 3 | 2 | 2 | 2 | 3 |

**Selection: #1.** It sits squarely on tonight's SCAN surfaces (`round-trip-proof` directly;
`managed-boundary` via the same `ruflo`-mediated write path ADR-063 governs), is a genuinely new
finding (not a rediscovery of #3's already-logged, already-deferred gap), and is the only candidate
with zero pre-existing test coverage to build a TEETH test against from scratch. #2 is real but is a
documentation-currency defect, off tonight's surface — recorded below as a fast-follow, not chased
tonight to keep one conceptual change.

## Hypothesis (frozen before implementation)

> Given `scripts/record-lesson.mjs`, when its `stored` verdict is changed from
> `/OK|stored/i.test(storeCommandStdout)` to an exact-key `ruflo memory retrieve` round trip whose
> returned value is compared against the value written, then a fake `ruflo` reproducing the
> 2026-08-13 incident shape (store claims success, retrieve on the same key reports the key absent)
> should cause the script to report failure (non-zero exit, no "round-trip verified" claim) —
> subject to: a genuinely successful round trip is still reported as success and exits 0, and the
> script's `distill`/`search` best-effort steps are unchanged in behavior.

Unchanged since freeze.

## Benchmarks / Evaluation

Not a retrieval-quality candidate — `npm run eval:gate` is out of scope and independently blocked in
this container (no brain materialized at `/root/.cache/ruvnet-brain/kb`, unrelated to this diff).
`LLM_EVAL=blocked` — no `OPENROUTER_API_KEY`/model-API credential present in this container tonight;
no model-graded stage was attempted, and none was needed for a deterministic scripting fix.

**Guard proven to fail first (TEETH).** `tests/unit/record-lesson.test.mjs`, run against
pre-candidate `scripts/record-lesson.mjs` (via `git stash`, before the discriminating 4th case was
added — see Reward-Hack Check below for that case run against pre-candidate separately):

```
✗ TEETH: a store that claims success but does not round-trip is reported as FAILED, not stored
✗ a write that genuinely round-trips is reported as stored, exit 0
✓ fails loudly, not silently, when the resolved ruflo binary does not exist   (coincidental pass —
  pre-candidate code also hardcoded a missing binary name and hit the same catch block)
```

Both real TEETH cases fail on pre-candidate code — not because of an unrelated crash, but because
the pre-candidate script cannot even be pointed at a fake `ruflo` (it hardcodes the literal command
`ruflo`, absent from PATH in this container), so it never reaches the wording-match logic being
tested at all. That is itself evidence for the second half of tonight's fix: the resolver gap is
also a *testability* gap.

**Candidate, same file, same container, all 4 cases (post independent-critic strengthening):**

```
✓ TEETH: a store that claims success but does not round-trip is reported as FAILED, not stored
✓ a write that genuinely round-trips is reported as stored, exit 0
✓ a damaged store answering a SQL-layer error (not "Key not found") is still reported as FAILED
✓ fails loudly, not silently, when the resolved ruflo binary does not exist
```

4/4 pass. Full command: `npx vitest run tests/unit/record-lesson.test.mjs`.

## Regression Analysis

- `npx vitest run tests/unit/record-lesson.test.mjs` — 3/3 pass (new file, see above).
- `npx vitest run tests/unit/ruflo-bin-resolution.test.mjs` — pass, unmodified; `resolveRuflo()`
  itself is untouched by this candidate, only a new caller was added.
- Blast radius: `grep -rn "record-lesson" .` (excluding node_modules/.git) shows exactly four
  referrers — `scripts/wired-check.mjs` (a descriptive string, not a call site),
  `plugin/scripts/degradation-watch.mjs` (matches the *event name* `'record-lesson'` against a
  regex on `ruflo memory store` command text, not this file's exports — unaffected),
  `docs/ARCHITECTURE-MAP.md` and `docs/adr/0032-capability-surface.md` (prose). No file imports
  `record-lesson.mjs`'s exports (it has none — it is a CLI entrypoint only), so the change is
  contained to invocations of the script itself.
- `node scripts/doc-currency.mjs --check`: run before and after this diff; identical violation count
  both times. No ADR's `governs:` frontmatter lists `scripts/record-lesson.mjs`.
- `node scripts/sync-version.mjs --check`: agrees on every surface, unaffected by this diff.
- Full `npm run test:unit` / `npm run test:integration`: see the PR's own regression-analysis
  section for the complete run captured at push time (this container's real, degraded ML-fallback
  performance applies here the same as every prior Dream Cycle night).

## Darwin Lineage

Not run — no continuous parameter to evolve for a boolean round-trip-verified/not-verified
determination; skipped rather than run for form's sake, same precedent as every prior
memory-durability-adjacent night in this ledger.

## Reward-Hack Check

Independent-critic pass (a fresh general-purpose agent, not this candidate's author): read the
candidate, the new test file, `ruflo-bin.mjs`, and the two precedent round-trip functions in full;
ran the test suite itself; grepped blast radius itself. **Verdict: CLEAR.** No benchmark, gold
answer, or existing test's assertion touched; diff scope is exactly the two files claimed.

The critic flagged one real gap in test *discrimination* (not in the shipped logic): the original 3
test cases could not distinguish the correct `.includes(writtenValue)` comparison from a shallower
"retrieved output does not literally say Key not found" check, because all 3 fixtures returned
either the exact value or literally "Key not found". A 4th case was added in response — a damaged
store answering `[ERROR] no such table: memory_entries` (a real ruflo failure shape
`degradation-watch.mjs`'s own comments document) — which the shallow alternative would misread as
success and the shipped `.includes()` comparison correctly still fails. All 4 cases pass on the
candidate.

**Known, non-blocking limitation the critic also surfaced and this candidate does NOT fix** (recorded
rather than hidden, same discipline as PR #155's ENOTDIR/EACCES gap): the round-trip key
(`lesson-${slug}`) is fully deterministic from CLI args, unlike `proveMemoryDurable()`'s
per-run-nonce probe key. A second run with an identical `--slug`/`--task`/`--tried`/`--worked`/
`--critique` whose store silently fails would retrieve the FIRST run's still-present, textually
identical value and wrongly report success. This is a pre-existing property of the key scheme, not
introduced by tonight's diff, and is orthogonal to the incident shape this candidate targets
(first-write loss) — flagged as a fast-follow, not chased tonight to keep one conceptual change.

## Competitors (external landscape, graded)

| System | Memory-durability stance (as documented) | Evidence grade |
|---|---|---|
| **Sakana AI Scientist** | Public materials emphasize experiment-log/paper-artifact generation; no public documentation found tonight describing an explicit write-then-read-back durability proof for its memory/state layer. | C (absence of evidence, not evidence of absence — not deeply searched tonight) |
| **OpenHands (Agent SDK)** | The 2026 SDK paper explicitly names "durable state management" as a foundation requirement for production agents, alongside safe sandboxed execution — architectural framing consistent with tonight's finding (a store that *claims* durability without proving it is a production liability), but the paper does not detail an exact-key round-trip mechanism. | A (arXiv 2511.03690, official) |
| **DSPy / GEPA** | GEPA's reflective-optimization loop persists prompt/config mutations as versioned artifacts it re-scores, which is closer to an append-only ledger than a key-value store — the round-trip failure mode this finding targets (silent overwrite loss) is structurally different for an append-only design. | A (official repo, github.com/gepa-ai/gepa) |
| **SWE-agent** | Comparative surveys describe it and OpenHands as the two leading open-source coding-agent frameworks; no durability-specific claims surfaced in tonight's search. | C (single-source blog comparison) |
| **Cursor background agents** | Framed publicly as moving from assistive to hours-long autonomous execution; no public documentation on memory write-verification mechanics surfaced tonight. | C (general framing only, not durability-specific) |
| **(field-wide)** Stability and Safety Governed Memory (SSGM) framework | Proposes governance mechanisms for *evolving* agent memory (risk framing, not write-durability specifically), but is the closest 2026 academic framing to "a memory system must prove its own claims" found tonight. | A (arXiv 2603.11768) |

No competitor claim above is used to justify the implementation on its own — the implementation is
justified entirely by this repository's own ADR-063 and its own already-established, already-tested
`proveMemoryDurable()`/`retrieveExact()` pattern, applied to a sibling script that had never received
it.

## Next steps (concrete)

1. **Fast-follow (candidate #2 above):** correct `docs/ARCHITECTURE-MAP.md` and
   `scripts/wired-check.mjs`'s comment — both assert `record-lesson.mjs -> lesson-store.mjs`, which
   is not what the code does (`record-lesson.mjs` writes to AgentDB via `ruflo`; `lesson-store.mjs`
   is a separate JSON-catalogue path never called from it). Doc-currency fix, not tonight's surface.
2. **Fast-follow (candidate #3 above, already logged by PR #155's critic):** give
   `restore-local-ingests.mjs`'s and `brain-score.mjs`'s existence checks a third `UNREADABLE` state
   (ENOTDIR/EACCES) distinct from both `NEVER-MATERIALIZED` and `WIPED`.
3. **Extend the round-trip discipline check itself.** `tests/unit/managed-memory-no-raw-sql.test.mjs`
   already scans instruction blocks for the SQL-bypass violation ADR-063 fixed; consider a sibling
   static check that greps for `ruflo memory store` call sites lacking any adjacent `retrieve` call
   in the same function, so a *fourth* sibling script cannot reintroduce this exact gap silently.
4. **Give the round-trip key a per-run nonce**, matching `proveMemoryDurable()`'s
   `durability-probe-${pid}-${Date.now()}` pattern, so a second identical invocation whose store
   silently fails cannot be masked by the first run's still-present value under the same key
   (independent-critic finding, non-blocking, not fixed tonight — see Reward-Hack Check).

## Security Review

Security-sensitive-surface scan (STEP 15): this candidate touches exactly one file outside its own
new test — `scripts/record-lesson.mjs`, a **human-run** CLI (confirmed via `wired-check.mjs`:
"never invoked by the model itself, by design"). No hook, gate, or enforcement file
(`plugin/hooks/*.json`, `hijack-ruvnet.sh`, `hook-shim.mjs`) is touched. Attack-surface checklist:

- **Prompt injection / agent impersonation:** N/A — no LLM call is added or removed.
- **Tool/MCP authority:** N/A — no new tool, no new permission scope.
- **Credential exposure:** none added; no new secret, token, or credential path.
- **Filesystem/network scope:** adds exactly one additional read-only `ruflo memory retrieve` call
  against the same store (`<dir>/.swarm/memory.db`) the script already writes to in the same
  process — same trust boundary as the pre-existing `store`/`distill`/`search` calls, no new host,
  no new path.
- **Supply-chain exposure:** no new dependency; `resolveRuflo()` is an existing, unmodified,
  already-reviewed shared module three sibling scripts already import.
- **Binary-resolution surface:** `resolveRuflo()`'s `RUFLO_BIN`-is-authoritative behavior is
  pre-existing, shared code — this candidate does not expand who can influence it, only makes
  `record-lesson.mjs` consistent with the three scripts that already resolve `ruflo` this way.
- **Unsafe autonomous mutation:** N/A — this script is opt-in and human-triggered, never part of an
  automated hook chain.

No new attack surface identified.

## Witness

```
SESSION_COMMIT = 72f079f3fb4c562da91aa848e7fade448ff665b6
REPORT_HASH    = f8d451c860fbd4352293df7e9503eb40a4ec7565d223fed608e4a31eed5e6c3d
WITNESS        = bae5c608807325951610fbb554fab2f30396fccf6cca6fc5c5ade0a5587cb4d1
```

Verifier (5 steps, reproducible by anyone):
1. `git checkout 72f079f3fb4c562da91aa848e7fade448ff665b6`
2. `git checkout <candidate branch>` and `git stash` the diff to isolate `scripts/record-lesson.mjs`
   and `tests/unit/record-lesson.test.mjs`.
3. `npx vitest run tests/unit/record-lesson.test.mjs` on the pre-candidate tree — 2 of 3 cases fail.
4. `git stash pop`; re-run the same command — 3 of 3 pass.
5. `sha256sum` this gist file, concatenate with `SESSION_COMMIT`, `sha256sum` again — compare to
   `WITNESS` above.
