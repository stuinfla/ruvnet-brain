Updated: 2026-08-22 12:15 EDT | Version 2.0.0
Created: 2026-07-28 13:00 EDT

# Nightly refresh, evaluation, and author rebuilds

There are two supported scheduled jobs and one deliberately unscheduled author harness. They must
not be confused:

| Job | Who it serves | Scheduler | Time | What it does |
|---|---|---|---|---|
| Dream Machine evaluation | This repository's evidence loop | Cloud routine from `dream.config.json` | 08:30 UTC | Opens evidence-backed issues/draft PRs; `autoMerge:false`, no publication authority |
| End-user Evergreen update | One installed copy of the Brain | Optional macOS LaunchAgent `com.ruvnet.brain-update` | 03:47 local | Downloads and verifies the newest already-published signed bundle; it never builds or publishes |
| Author candidate rebuild | A maintainer preparing source changes | **No scheduler**; explicit `scripts/nightly-wrapper.sh` invocation | Human-run | Rebuilds only in a clean linked worktree outside the primary checkout; never publishes |

## Retired primary-checkout writer

`com.ruvnet.brain-nightly` was retired on 2026-08-22. It invoked source-writing rebuild and ingest
commands from `/Users/stuartkerr/Code/ruvnet-brain`, so unattended work accumulated beside active
human changes. Its installed plist was unloaded and archived, its checked-in plist was removed, and
the required-job registry no longer watches it. Do not recreate or re-enable it.

The author wrapper remains a manual diagnostic/candidate harness. It refuses the primary checkout,
any non-linked or nested worktree, and any dirty writer worktree before a source mutation. It also
seals the primary checkout's HEAD, staged diff, tracked working diff, and non-ignored untracked-file
set around the run. It invokes:

```bash
node scripts/self-update.mjs --apply --fresh-window 60
```

Publication is not part of this command; only the proof-gated protected release workflow may
publish immutable artifacts. If an author run fails, the wrapper waits three minutes and retries
once. A second failure writes
`.ruvnet-brain/nightly-failure.json`, logs the exact failure, and sends the configured urgent
notification. A clean no-op is success and stays quiet.

## What “incremental” means

The author builder does not rebuild the full corpus on every invocation:

1. Fetch each upstream repository and compare its commit SHA with the last promoted generation.
2. Skip repository stores whose upstream SHA and build fingerprint are unchanged.
3. For a changed repository, walk its current files and compare stable content-addressed chunk IDs
   with the previous corpus ledger.
4. Keep unchanged chunks and vectors, delete departed chunks, and locally embed only new or changed
   chunks with the one canonical BGE-768 model.
5. Build a staged RVF candidate and run structural and retrieval gates without touching the primary
   checkout.
6. Hand the reviewable candidate to the protected exact-SHA release workflow. Only that workflow
   may stamp and publish immutable artifacts or advance `releases/latest`.

“Complete Brain” and “RuVector Only” are install profiles over the same release. The canonical
publisher still builds the complete public release once. An installed RuVector-only copy retains
only the RuVector RVF family; fresh installs and Evergreen updates reapply that selection after
verified extraction, so unselected stores do not accumulate again.

Switching back to Complete Brain restores from a local full release when one is available; otherwise
the console invokes the installed signed updater with `--restore-complete`, forcing one verified
release download even when the RuVector store itself is already current.

## Inspect and test the supported scheduler

These are read-only checks:

```bash
plutil -p ~/Library/LaunchAgents/com.ruvnet.brain-update.plist
launchctl print "gui/$(id -u)/com.ruvnet.brain-update"
tail -100 ~/.cache/ruvnet-brain/kb/update.log
```

The manual author harness has a dry-run mode. Run it only from a clean linked worktree outside the
primary checkout:

```bash
NIGHTLY_SMOKE=1 scripts/nightly-wrapper.sh
```

## Why the author builder is unscheduled

An author build needs a large mutable RVF workspace, a warm model cache, and deliberate ownership of
the generated diff. Scheduling it in a daily-use checkout violated that ownership boundary. The
explicit linked-worktree requirement keeps candidate bytes isolated and reviewable. GitHub Actions
remains the independent validation and publication plane: CI, stranger-install matrices,
release-surface checks, and protected exact-SHA release gates.

If unattended author builds return, they require a dedicated disposable checkout/worktree owned by
that job, automatic failure receipts, and proof that the primary checkout is byte-for-byte unchanged.
A daily-use developer checkout is never an automation workspace.

Authoritative platform references:

- [GitHub scheduled workflow behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub Actions usage limits](https://docs.github.com/en/actions/reference/limits)
- [GitHub security guidance for self-hosted runners](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
- [GitHub self-hosted runner responsibilities](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)

## End-user Evergreen scheduling

Evergreen is off until the user explicitly enables it:

```bash
npx ruvnet-brain --enable-nightly
npx ruvnet-brain --disable-nightly
```

On macOS this manages `~/Library/LaunchAgents/com.ruvnet.brain-update.plist` and runs the signed,
non-publishing updater at 03:47. The generated launchd PATH includes `~/.npm-global/bin` and
`~/.local/bin`, because the host-convergence phase invokes the installed Claude and Codex doors and
launchd does not load an interactive shell profile. On Linux, the equivalent cron entry is:

```cron
47 3 * * * npx --yes ruvnet-brain@latest --update --host-sync-only --no-nightly-prompt >> "$HOME/.cache/ruvnet-brain/kb/update.log" 2>&1
```

Windows users should schedule the same `npx --yes ruvnet-brain@latest --update --host-sync-only
--no-nightly-prompt` command with Task Scheduler; the installer does not silently create a system
schedule there.
