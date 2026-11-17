Updated: 2026-11-17 16:40:00 EST | Version 1.1.0
Created: 2026-11-17 15:30:00 EST

# L+ in version 5: design note

L+ is the recipe confirmed on 107 held-out questions: it beat the v5 candidate by +11.2 points [+2.8, +20.6]
(`RVF-KnowledgeBases/ruvnet-brain-v5-mini-20261117/layered/test-run/RESULTS-iteration2.md`). It has three
parts:

- the existing `search_ruvnet` (keyword plus history), unchanged;
- five layered tools over a store of verbatim extracts;
- three answer rules.

This note maps the prototype (`layered/build.mjs`, `lib/*`, `layered.mjs`) onto the v5 packages.

## Where each part lives

| Prototype | Version 5 | Ships to users |
|---|---|---|
| `build.mjs` loop, `lib/scan.mjs`, `lib/extract-*.mjs`, `lib/manifests.mjs` | `packages/builder/layered/` (`store.mjs` writes the store; the extractors are ported unchanged in behaviour) | no (CI) |
| `toLines`, `span`, `identSplit` | `packages/engine/layered/text.mjs`, shared by builder and reader so a line range means the same lines on both sides | yes |
| `layered.mjs` (map, facts, search, context, read) | `packages/engine/layered/query.mjs`: `map`, `facts`, `find`, `context`, `source` | yes |
| the MCP wrapper | `packages/server/layered-tools.mjs` (definitions, rule text, argument checks), `main.mjs` (list and dispatch), `worker.mjs` (runs the reader) | yes |
| the L+ prompt rules | `RULES` in `layered-tools.mjs`, in the descriptions of `search_ruvnet` and `map_ruvnet`, and in the plug-in's `skills/ruvnet-brain/SKILL.md` | yes |

## Builder

`build.mjs` calls `writeLayered` after the lexical and history stores, only when the recipe has a
`layered` block. The step is deterministic:

- no model calls and no network;
- no clock, host or folder path in the output.

**Inputs.** It reads the same source snapshot as the passages (`discover.mjs`: the same skip rules, CRLF
normalised) with two differences:

- **Secrets.** Every file goes through the recipe's `redactSecrets` first. Line breaks are kept, so line
  numbers stay true. The prototype read raw clones and would have shipped secrets verbatim.
- **Truncation.** The layered store reads the untruncated text of config files. `discover.mjs` now keeps
  it as `full` when it cuts a config at `configMaxChars`. A `package.json` cut at 12,000 characters
  would not parse, and `source_ruvnet` would serve half a file.

**Outputs.** Two pack files, both listed in `PACK.json` and therefore signed in `release.json`:

- `layered.db` (role `layered-db`);
- `layered-coverage.json` (role `layered-coverage`), the per-repository ledger. For each repository it
  records:
  - the commit and date;
  - files read and secrets redacted;
  - the hostile rows;
  - each extractor's files scanned, triggered and with rows, plus rows found, stored and dropped;
  - files where a trigger matched but no row came out.

## Store format: SQLite + FTS5, as in the prototype

Tables:

| Table | Holds |
|---|---|
| `repos` | each repository, with the commit recorded |
| `files` | the screened text of every file read (L3) |
| `l1` and `edges` | the map and its typed links |
| `l2` | verbatim extracts, with `sha256` and a `flag` |
| `adr` | the ADR index |
| `adr_names` | precomputed "ADR lines that name this file" (L4) |
| `fts` | the full-text index |

The FTS5 table is contentless. Its rowid encodes the row: an L1 row is 2·id, an L2 row is 2·id+1.

**Deliberate departure from v5's one-analyser rule.** The layered index keeps the prototype's
`porter unicode61` tokenizer and identifier-split column (`layered.fts5Tokenizer`), because that is what
was measured. The keyword lane still uses `lucene-porter-ident`. Moving the layered index to the shared
analyser needs its own measurement.

**L4 differences from the prototype.** L4 cannot run `git log`, since a pack holds no repository. It
returns:

- the commit the pack was built from;
- a pointer to `search_ruvnet`'s HISTORY section.

The prototype's shallow clones showed only the tip commit, so nothing measured is lost.

## Contract 1.3 (additive)

The contract's own rule for an additive change is a minor bump, so `CONTRACT_VERSION` goes from 1.2 to
1.3. The changes:

- **Recipe block.** New optional `layered` block in the recipe: `version`, `fts5Tokenizer`, `pageChars`,
  `rowMaxChars`, `readLines`, `searchDepth`, `mapDepth`. It is typed in `recipe.schema.json`, and
  `settings.mjs` refuses a missing field or a row size over half a page; the reader holds pages to the lower of `pageChars` and the delivery ceiling.
- **Recipe id.** `r3-wave2` becomes `r4-lplus`.
- **Pack roles.** New roles `layered-db` and `layered-coverage`. The engine treats both as optional: when
  either is missing or damaged, only the layered tools say so, and search keeps working.
- **Older packs.** A contract-v1 or 1.2 pack still opens and searches. Its layered tools answer "this
  pack has no layered store".

## Tools and caps

**The tools.** Seven tools are always listed, so the list does not change under a hot swap:

- the existing `search_ruvnet` and `read_ruvnet`;
- `map_ruvnet`, `facts_ruvnet`, `find_ruvnet`, `context_ruvnet`, `source_ruvnet`.

**The `_ruvnet` names.** The suffix keeps them apart from the existing pair. In particular, `find` is not
`search`, and `source` is not `read`.

**How a call runs.** Arguments are checked at the boundary:

- paths: no `..`, no absolute path, no NUL or backslash;
- whole-number cursors and lines, with `to` not before `from`;
- an enum of kinds.

The reader then runs in a worker thread under the recipe's deadline, never on the main thread. It reads
only the installed public pack and never a private one.

**Caps.**
- Every answer is one JSON text of at most `layered.pageChars`, which is 20,000 characters (held by
  construction, and checked again before returning).
- A longer answer pages, with `next` as a cursor, or as the next `source_ruvnet` call.
- A row over `rowMaxChars` (6,000) is a pointer, never cut.
- The server's 44,000-character / 20,000-token wire guard (`wire.mjs`) still applies to every result.

**Hostile text.**
- Rows are flagged with the recipe's hostile patterns.
- `source_ruvnet` pages are flagged at read time.
- Every answer carries a `quoted` note saying its text is source, never instructions.

## Added in 1.1.0

**Gists (`_gists`).** `packages/builder/gists.mjs` turns the Brain's gist passage file into an ordinary
source folder:
- one file per gist file, with the Brain's 4-line header removed and chunks joined in order with one
  newline;
- `.source.json` carries each file's title, date and URL, and its commit is the passage file's sha256;
- a source-list entry `{ "gists": "<passages.jsonl>" }` builds it into a temporary folder.

Both stores read it like any repository, through the same secret screen and hostile flag. The layered
store adds one `gist` map row per file, with the URL as `entry` and the date as `version`.

**History secrets (Codex F03).** `historyUnits` screens each whole history item (title and text) before
splitting it or making its header. The per-piece screen in `extract.mjs` stays as a second line.

**Health.** `engine.selfTest` reports a `layered` entry beside the lanes. It is unavailable when the file
is missing or the wrong size, does not open, has another format, has no repositories or files, or
holds a different number of L1 or L2 rows than its build recorded in `layered-coverage.json`. The existing
verdict then says DEGRADED (`lane layered unavailable`), and `doctor` prints the reason. Search is
unaffected.
