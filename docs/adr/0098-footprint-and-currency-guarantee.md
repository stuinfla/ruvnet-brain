---
id: ADR-098
title: The footprint and currency guarantee — one knowledge base, current, in use, nothing building up
status: Accepted
date: 2026-10-01
updated: 2026-10-01
authors: [Stuart Kerr, Claude Opus 5.5]
tags: [footprint, install, update, data-safety, confirmation]
supersedes: []
amends: [ADR-084]
---

# ADR-098 — The footprint and currency guarantee

**Status**: Accepted (2026-10-01)

## Owner requirement

"Build that into the functionality so every end user has only the information they need on their
computer and nothing that they don't." There is exactly one copy of the knowledge base, it is current
and in use, and "a simple QA that everything that should be there is, it's current, and everything that
shouldn't be there isn't, nothing building up cruft" — confirmed positively, not inferred from silence.

## What went wrong (measured on the owner's Mac, 2026-10-01)

- `~/.cache/ruvnet-brain-quarantine-20260916` held three full old KB copies (`kb.bak-2026-09-04…`,
  `kb.install-preserved-4vYVmt`, `kb.install-preserved-pPgP8t`) = 3.6 GB, never cleaned.
- `~/.cache/ruvnet-brain/kb.pre-update-20260930` (1.4 GB) was left after an update.
- Five stale npx installer copies (~7 MB each) in `~/.npm/_npx`; plugin generations 4.3.35/4.3.37 kept
  by session leases; append-only logs without a cap (`evidence.jsonl` 3.1 MB, `token-ledger.jsonl`
  2.8 MB, `detached-jobs.jsonl` 2.1 MB); ruflo scratch debris; empty forge candidates.
- Root causes: (1) `bin/install.mjs` preserved the whole prior generation on every fresh/forced install
  ("PRESERVED_UNCLASSIFIED") and nothing ever released it; (2) `kb/forge-update.mjs` `reclaimBackups`
  releases a copy only when EVERY byte survives in live — which no older generation satisfies, so those
  copies were kept forever and then made the updater's own preflight refuse ("unresolved rollback
  state exists"); (3) recovery work created copies under names no reclaimer knew; (4) nothing rotated logs
  or old installer copies; (5) nothing stated, positively, that the machine was clean.

## Decision

1. **One classifier** — `plugin/scripts/brain-footprint.mjs` — sorts everything the Brain owns (brain
   home incl. a symlinked one, KB siblings, `*-quarantine-*` dirs, Claude and Codex plugin caches, npm
   `_npx` copies, ruflo scratch, logs, lifecycle evidence) into **must-exist**, **may-exist (bounded)**,
   **must-not-exist**, and **unowned** (reported, never removed). It lives in the plugin payload so the
   installer and SessionStart share it; it reuses the KB's own readers (lifecycle-evidence retention,
   the storage-transaction receipts) and the installer's lease-aware plugin collector instead of
   restating them.
2. **One proof before any KB copy is removed** — `plugin/scripts/kb-copy-proof.mjs`. Every file in the
   copy must be: a private-store file (fence of live AND of the copy, plus every `updateManaged:false`
   store) that is byte-identical in live; or a public release file (listed with these bytes in the copy's
   own `ARCHIVE-MANIFEST.json`, a name the live generation ships, or a public store family); or
   installer-written/reinstallable; or a symlink identical in live. Anything else keeps the copy, and is
   named. The live KB must itself be present. Public bytes are not unique: they are signed and
   re-downloadable.
3. **Enforced in the lifecycle, not on request**: after a fresh/forced install (the installer releases its
   own preserved generation the moment the new one validates), before the updater runs (so its preflight
   is never blocked by a disposable copy), after every update, at `npx ruvnet-brain --clean`, and from a
   bounded SessionStart sweep (a detached run at most every 6 h, only when the cheap name-only scan finds
   something). The SessionStart knowledge self-heal runs `--update`, so it inherits the sweep.
4. **Positive confirmation** — `plugin/scripts/brain-confirmation.mjs` — one block after every
   install/update and in `--doctor` (`--doctor --json` for machines): Software (= npm latest), Hosts
   (= runtime), Knowledge (exactly one copy, built < 48 h, signature verified and bound to the live
   COVERAGE.json, corpus tag), In use (the search worker reports the KB path it opened; last metered
   answer), Footprint (total vs budget = KB + models + fixed allowance, with breakdown), No cruft. Every ✗
   names one command. SessionStart prints one line only when the footprint is wrong.
   *Amended 2026-10-01 (review S5):* `--doctor`, `--doctor --json` and the exit code are one verdict
   (`doctorVerdict`): ✗ anywhere fails, including the doctor's own checks; currency (Software behind npm
   latest, Hosts ≠ runtime, Knowledge built ≥ 48 h) is `!` advisory and never fails it, so install
   verification of a correctly installed older build stays green. A verified local bundle (signature beside
   it) is recorded like a download, and `--update` that applies nothing restores a missing record only from
   this machine's receipt of a verified apply whose coverage digest equals the live COVERAGE.json.

## Invariants (each enforced by a test that is proven red by breaking its guard)

- Exactly one KB tree under HOME after install, forced reinstall, and each of three updates
  (`tests/integration/footprint-three-updates.test.mjs`).
- A private-store file that is not byte-identical in live keeps its copy; so does any unclassified file
  or link (`tests/unit/brain-footprint.test.mjs`, BREAK-IT mutants).
- Nothing is followed through a symlink; nothing outside an owned root is removed; an `npm_config_cache`
  outside HOME is ignored. A removal target must sit directly inside the REAL directory it was inventoried
  in, itself inside an owned root (`plugin/scripts/footprint-io.mjs` removeWithin; the earlier guard compared
  a path with its own parent and could never refuse — review S7, BREAK-IT: a parent swapped for a link).
- Leftovers of an interrupted `--move-brain` (`<home>.old-<pid>`, `.<name>.moving-<pid>` beside the home or
  the linked target, `<home>.link-<pid>`, `<home>.link-old-<pid>`; dead pid only, none while a refresh lock is
  held) are REPORTED, never removed, each as a Move line with the exact next step: `!` with the `rm` that
  finishes the move, or `✗` with the `mv` back when the set-aside original is the only copy. Their KB copies
  are shown as "not counted" beside the one live copy. A dry run and `--doctor` write nothing.
- A copy KEPT because it holds data the live brain lacks is proven once and cached (stat fingerprints of
  the copy and the live brain; a stale entry can only keep), reported with what it holds and "nothing to
  run" instead of `--clean`, triggers no background sweep, and is announced at SessionStart once per change.
- **Only what the Brain itself created is ever removed.** Anything in our directories that the Brain did
  not write — in particular hand-made backups such as `X.bak-20260808`, `*.retired-*`, `*.dead-*` and
  `bootstrap-backup-*` — is classified **unowned** and only REPORTED: no age, size or "looks like a backup"
  heuristic makes it removable, and it never counts as Brain cruft (so it never makes "No cruft" fail or
  names `--clean`). Removal is limited to names the Brain writes (its KB-copy and stage prefixes, capped
  logs, stale leases, ruflo scratch, older npx copies of `ruvnet-brain`), and for any KB copy only with
  the `kb-copy-proof` above (amended 2026-10-01 after review B1: an earlier rule deleted hand-made backups
  older than 7 days with no proof; `tests/unit/brain-footprint.test.mjs` "report-only guard" mutant).
- An in-progress storage transaction's trees, a refresh-lock holder's siblings, and a live lease are kept.
  So is everything beside the KB, and every npx copy, while a plain install activates (its
  `.kb.install-activation.lock` names a live pid, its stage is younger than 2 h, or a
  `kb.install-prior-<ts>-<pid>` names a live pid); an older npx copy fetched < 2 h ago is kept (review S6).

## Consequences

- A copy that holds private data the live brain lacks stays on disk until the owner restores or deletes
  it; it is reported every time, never removed silently. The budget can therefore be exceeded by user data,
  and the confirmation says so rather than deleting it.
- The three-update footprint check in `scripts/corpus-canary.mjs` is opt-in (`--footprint-updates`): its
  CI runtime on the real ~1.4 GB brain is not yet measured (offline fixture: +0.7 s).
- Lifecycle receipts (`.kb.update-transactions`, `refresh-runs`) are the one thing allowed to accumulate,
  and only to their own retention policy (lifecycle-evidence-v1, 16 MiB).
