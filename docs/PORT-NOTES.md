Updated: 2026-11-17 16:55:00 EST | Version 1.1.0
Created: 2026-11-17 15:20:00 EST

# L+ port into version 5: notes

**Branch.** `v5/lplus-port`, from `origin/v5/rewrite` at `1be0c8dc`. It is in its own worktree
(`.claude/worktrees/v5-lplus-port`), has not been pushed or merged, and touches no other branch.

**Commits.**

| Commit | What |
|---|---|
| `d348b2eb` | The port: code, tests, breaks, design note and regenerated documents. The repository's own pre-commit hook also updated `data/convergence-manifest.json` (the tracked-file count). |
| `2b672ac3` | The first notes. |
| `b15290ad` | Second job: the F03 fix, gists as `_gists`, `layered.db` in the health signal, tests `wave4-04` to `wave4-06`. |
| this file's commit | These notes, updated with the full-corpus measurement. |

**Design.** See `docs/v5/LPLUS-DESIGN.md`.

## What was built

**Builder** (`packages/builder/layered/`). It runs in CI only and is not shipped to users.
- **Extractors.** The prototype's extractors, manifest parsers and bracket matcher are ported with the
  same behaviour.
- **Store writer.** `store.mjs` writes `layered.db` and `layered-coverage.json`.
- **What it reads.** The same snapshot `discover.mjs` reads for the passages. Two differences from the
  prototype:
  - every file goes through the recipe's secret screen first;
  - config files are read untruncated (`discover.mjs` now keeps the full text as `full` when it cuts a
    config).
- **Deterministic.** There is no clock, host or folder path in the output, and two builds are
  byte-identical (tested).

**Reader** (`packages/engine/layered/query.mjs` and `text.mjs`). It ships.
- **Tools.** `map`, `facts`, `find` (the prototype's `search`), `context` and `source` (the prototype's
  `read`).
- **Page cap.** Each answer is JSON of at most `layered.pageChars` (20,000), or the delivery ceiling when
  that is lower. Longer answers page.
- **Long rows.** A row over 6,000 characters comes back as a pointer, never cut.
- **L4.** Context is served from the pack: the recorded commit, plus a pointer to `search_ruvnet`
  HISTORY. A pack has no `git log`.

**Server.**
- **Tools.** `map_ruvnet`, `facts_ruvnet`, `find_ruvnet`, `context_ruvnet`, `source_ruvnet`, defined
  with argument checks in `layered-tools.mjs`. `tools/list` always lists all seven tools.
- **How a call runs.** Calls run in the worker pool under the recipe's deadline, and only on the
  installed public pack.
- **Wire guard.** Every result still leaves through the 44,000-character / 20,000-token guard in
  `wire.mjs`.

**Rules.** The three L+ rules are verbatim from `layered/test-run/RESULTS.md`. They appear in:
- the `search_ruvnet` description;
- the `map_ruvnet` description;
- the plug-in's `SKILL.md`.

**Contract 1.3**, all additive:
- an optional recipe block `layered`, typed in the schema and checked in `settings.mjs`;
- pack roles `layered-db` and `layered-coverage`, which the engine treats as optional;
- recipe id `r4-lplus`.

Tests pinned to `'1.2'`, `r3-wave2` and the pack's file list were updated.

**Generated files.** `docs/RECIPE.md` (with a new layered section) and
`packages/release/shipped-files.json` were regenerated with the repository's own writers.

## Test results (all run 2026-11-17, macOS, Node 24)

| Check | Result |
|---|---|
| `npm test` | Plugin tests 58/58 passed. v5: 116 tests, 113 pass, 0 fail, 3 skipped. The 3 skips (WP1 T1, T2, T5) need the retrieval corpus or the question sets, which are not on this machine; they are not new. |
| `npm run test:v5`, run alone before the last fix | 1 failure: `wave2-delivery`. A recipe that lowers the delivery ceiling to 12,000 was refused by my first page-cap rule. It is now fixed: the reader holds pages to the lower of the two, and `wave4-02` tests that. The run after the fix is the `npm test` row above. |
| `npm run single-source:check` | 20/20 pass |
| `node packages/docs/generate.mjs --check` | current |
| `node tests/acceptance/v5/run-breaks.mjs wave4` | 3 tests green, 9 of 9 breaks red with the expected failure |
| Existing break anchors (all 249 `find` strings in `breaks*.mjs`) | each still matches exactly once in the edited tree |

The full break runner for waves 1 to 3 was **not** re-run. Only its anchors were checked.

### Tests added

**`wave4-01-extract`.**
- Every L2 row equals its file's line range, read back from disk by the test's own line split (not the
  product's `toLines`), and its sha256 matches.
- Every L1 source line is verbatim.
- All 12 extractor kinds fire, each with the expected path and lines.
- Links resolve: an internal dependency goes to its row, and an outside one is marked external.
- The secret's bytes appear nowhere in `layered.db`, and its line keeps its place.
- A `package.json` whose description sits past 12,000 characters still becomes an L1 row.
- A hostile row is flagged.
- Two builds are byte-identical.

**`wave4-02-pages`.**
- The fixture has 400 MCP tools, 3,000 constants, a 5,000-line document and one 7,000-character row.
- Every page of every tool is at most 20,000 characters.
- Following `next` in `facts` and `find` shows every row exactly once.
- `source` pages rebuild the file line for line.
- A long row comes back as a pointer.
- A lowered delivery ceiling lowers the pages.
- A row size over half a page is refused by the builder.

**`wave4-03-served`** (acceptance). Build, sign, install into a fresh home, then call the real server
over stdio:
- `tools/list` has seven tools with their schemas.
- The rules are verbatim in two descriptions and in the installed skill.
- map → facts → find → source → context reach the exact lines.
- The secret never appears in an answer.
- The hostile page is flagged.
- Six kinds of bad argument are refused: `..`, an absolute path, `to` before `from`, a bad kind, a
  missing query and a negative cursor.
- With `layered.db` damaged, search still answers in normal mode and the layered tools say the store is
  damaged.
- A pack built without a layered store says so, and search still works.

### Broken-code proofs (each break is applied to a scratch copy; each test went red with the named failure)

| Break | Test | Failure shown |
|---|---|---|
| span one line too long (`r.line_end + 1`) | wave4-01 | `verbatim: default HnswConfig::default at crates/hnsw/src/lib.rs:7-7` |
| secret screen bypassed | wave4-01 | `no secret key bytes anywhere in layered.db` |
| truncated passage text used | wave4-01 | the big manifest is no longer an L1 row |
| page cap removed | wave4-02 | `map page is 33515 characters, over 20000` |
| cursor skips a row | wave4-02 | `6767 shown of 6836; a row was skipped` |
| rules left out of `search_ruvnet` | wave4-03 | `search_ruvnet carries the answer rules verbatim` |
| layered tools not listed | wave4-03 | `the server lists seven tools` |
| path check removed | wave4-03 | `..` path not refused |
| layered store made a required pack file | wave4-03 | search goes DOWN: `Pack file layered.db is missing or has the wrong size` |

## Real-repository measurement (ruflo + RuVector, the two largest)

The two repositories are APFS clones of the prototype's checkouts, built with the shipped recipe.

| Measure | Result |
|---|---|
| Build time | 106 s with the layered store, 75 s without, so the layered step is about 31 s |
| Peak memory | 3.7 GB |
| `layered.db` | 518 MB (beside `lexical.db` 540 MB) |
| Files | 20,676 |
| L1 rows | 2,092 |
| L2 rows | 296,013 |
| ADRs | 1,074 |

**Against the prototype.** The prototype had 295,578 L2 rows for the same two repositories. That is
within 0.15%, but they are not identical:
- the commits differ;
- v5's skip rules are not the prototype's (v5 leaves out `vendor/`, `target/` and files over 1.5 MB, and
  reads only the recipe's file types).

**Queries.** Nine real queries returned 7,900 to 19,700 characters each, all under the cap, in 2 to
318 ms.

## Second job (2026-11-17, afternoon)

### F03: history secrets screened before the split (fixed)

**The fix.** `packages/builder/history.mjs` `historyUnits` now takes the recipe's screen. It runs the
screen on each whole history item, title and text, before splitting the item or making its header.
- Hits are recorded once per item. A title that is also the text's first line is not counted twice.
- `extract.mjs` passes the screen in. Its per-piece screen stays as a second line.

**Test `wave4-04-history-secrets`.** The recorded history is written at test time and holds three
secrets:
- a 3,000-character PEM key in an owner issue;
- a GitHub token placed across the 1,600-character split;
- a token in a release title.

**Both runs.**
- **Old code: red.** `AssertionError: a secret reached history.db: /BEGIN RSA PRIVATE KEY/`.
- **Fixed code: green.** No key or token byte appears in `history.db` or `lexical.db`, and the manifest
  records `github-token`, `github-token` and `private-key` once each.
- **Break `wave4-04-split-first`** (screen only after the split) goes red again with the same message.

### Gists in the layered store (`_gists`)

**What was built.** `packages/builder/gists.mjs` turns `kb/ruv-gists.passages.jsonl` into an ordinary
source folder:
- the Brain header is removed and chunks are joined in order;
- unsafe paths and passages without the header are skipped and counted;
- there is no clock, so the same passage file gives the same folder.

A source-list entry `{ "gists": "<file>" }` builds it. Both stores read it through the same secret screen
and hostile flag, and the layered store adds one `gist` map row per file, with URL, date and first
sentence.

**On the real passage file.** 596 files, 596 map rows and 10,229 extract rows, with the same
`sha256:ce4aa…` source identity as the prototype, whose counts were also 596 / 596 / 10,229.

**Test `wave4-05-gists`.**
- The text is verbatim and the folder is deterministic.
- Bad passages are skipped.
- The map row, `source_ruvnet` under the short name `gists`, the key screen, the number line, and
  keyword search all work.
- Break `wave4-05-header-kept`: red.

### layered.db in the one health signal

**What was added.** `engine.selfTest` reports `{ name: 'layered', available, reason }` beside the lanes.
The entry is unavailable when the file is:
- missing or the wrong size;
- unopenable;
- another format;
- empty of repositories or files;
- holding a different number of L1 or L2 rows than its build recorded in `layered-coverage.json`.

(A first version required every level to be non-empty. That refused valid small packs at install, which
the S5 and WP2 T1 tests caught, since a corpus with no manifest has no L1 rows.)

The existing verdict then says DEGRADED (`lane layered unavailable`), never DOWN, and `doctor` prints the
reason. No health-package code was changed.

**Test `wave4-06-layered-health`.**
- A good store is available.
- A missing file, a store that lost its L2 rows, and another format each report unavailable, while the
  probes still pass.
- Served, with `layered.db` removed: the hook line is DEGRADED, `doctor` names the cause, and search
  stays in normal mode.
- Break `wave4-06-unchecked`: red.

### Full corpus build (22 pinned repositories + gists)

The repositories are APFS clones of `RVF-KnowledgeBases/ruvnet-brain-v5-mini-20261117/sources/`; the
gists come from the passage file in the main checkout. The list file has 23 sources.

| Measure | Result |
|---|---|
| Default Node heap (about 4 GB) | **Out of memory** at 443 s. The baseline builder without any layered store also runs out at the default heap (341 s, exit 134), so this predates the port: the v5 builder holds every passage in memory. |
| `--max-old-space-size=24576` | Built in **496 s**, peak memory **10.4 GB**. From file times, the layered step is about 3 min of that. |
| Content | 783,670 passages from 56,530 files; layered: 23 repos, 4,573 map rows, 745,465 extract rows, 1,967 ADRs |
| `layered.db` | **1.19 GB** raw: gzip-6 286 MB, zstd-19 200 MB |
| `lexical.db` | 1.47 GB raw: gzip-6 380 MB, zstd-19 293 MB |
| Whole pack | **2.66 GB** raw, against about 1.47 GB without the layered store (**×1.81**); about 493 MB compressed with zstd-19, against 293 MB (**×1.68**) |

**Against the prototype.** The prototype has 4,685 map rows and 752,844 extract rows. The difference comes
from v5's skip rules: it leaves out `vendor/`, `target/` and files over 1.5 MB, and reads only the
recipe's file types, 56,530 files against the prototype's 60,472.

**The pack does not more than double.** No shrink was made, as instructed. These are the options, by
size:

1. **`files.text` is 642 MB, 54% of `layered.db`.** It repeats source text that the lexical store also
   holds in passages. Options:
   - **Derive L2 text from it.** `l2` stores only line ranges and sha256, and the reader cuts the text
     from `files` (exact by construction). This saves most of `l2`'s 274 MB.
   - **Deflate each file's text.** Node's bundled zlib makes this deterministic per Node version, and
     the builder pins Node in CI. The likely saving is around 400 MB raw. It does not help the download
     much, since the pack is compressed for transfer anyway.
2. **Drop the secondary indexes `l2_sym` and `l2_kind`.** About 35 MB. They would need a query-time
   check first.
3. **Drop the `test` kind.** About 145k rows and 9 MB of text. It had the lowest cite rate in the
   held-out traces (88 cited of 2,137 returned).

**L2 kind usage in the held-out traces.** I parsed all 321 L+ traces (`it2/traces/*.LP.*.jsonl`). Every
extract kind returned rows whose path was later read or cited in an answer, so no kind is a clean drop:

| Kind | Rows returned | Path later read | Path cited |
|---|---|---|---|
| doc-number-line | 10,651 | 277 | 702 |
| signature | 6,645 | 344 | 464 |
| default | 2,907 | 140 | 207 |
| test | 2,137 | 75 | 88 |
| const | 1,543 | 69 | 122 |
| marker | 1,205 | 61 | 132 |
| env | 414 | 31 | 45 |
| status | 406 | 18 | 44 |
| flag | 378 | 10 | 25 |
| mcp-tool | 284 | 25 | 76 |
| mcp-schema | 157 | 19 | 42 |
| command | 110 | 1 | 5 |

**Memory for CI.** The release build job must run Node with a larger heap (24 GB was used here). Making
the builder stream passages to disk instead of holding them all is the real fix, and it belongs to
whoever owns the build pipeline.

## The Codex review's four blockers (V5-REVIEW-CODEX.md)

| Blocker | What it says | Status after this port |
|---|---|---|
| F01 | Promotion accepts asserted gate and platform results (`promote.mjs`) | **Not touched. Still open.** |
| F02 | The launcher, installer and helper can run a program from inside the project | **Not touched. Still open.** |
| F03 | History secrets are redacted after splitting | **Fixed in the second job**: whole items are screened before the split (`wave4-04`, red on the old code, green now). |
| F04 | Not a releasable v5 distribution: root package 4.7.28, no public key, no unattended migration | **Not touched. Still open.** |

The port also respects F08 (the layered tools never open a private pack) and F09 (layered calls run in
worker threads under the deadline, with no main-thread fallback). The underlying F08 and F09 defects in
`search_ruvnet` are untouched.

## Open items before a release

1. **Release blockers.** F01, F02 and F04 block any v5 release whatever the port's quality. They belong
   to the other builder (`v5/review-fixes`). F03 is fixed here.
2. **The L+ score has not been re-measured through v5.** The tool names changed:
   - `map` → `map_ruvnet`
   - `facts` → `facts_ruvnet`
   - `search` → `find_ruvnet`
   - `context` → `context_ruvnet`
   - `read` → `source_ruvnet`

   The dive strings changed with them. L4 has no `git log`, the skip rules are v5's, and the text is
   screened. The held-out question set must be run against this server before the +11.2 claim can
   carry over. No model calls were allowed here.
3. **Pack size.** It is ×1.81 raw and ×1.68 compressed for the full corpus. The shrink options are
   above, not implemented. The installer's disk-space and download checks were not re-measured against
   a 2.66 GB pack.
4. **Gists are built** (second job). CI must add the `{ "gists": ... }` entry to the release source list.
5. **Not built** (as in the prototype): `history` and `submit_answer` tools, `contradicts` edges, and
   per-file commit history.
6. **Health is checked** (second job). The heap is not: the full build needs a larger Node heap, a
   limit that predates this port.
7. **The analyser differs.** The layered index uses `porter unicode61` plus an identifier-split column, as
   measured, not the v5 shared analyser.
8. **Not run on Linux or Windows.** Waves 1 to 3's full break runner was not re-run either; only its
   anchors were checked.
