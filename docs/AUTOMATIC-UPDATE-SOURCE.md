Updated: 2026-10-10 05:06:23 EDT | Version 1.1.1
Created: 2026-10-05 06:18:56 EDT

# Automatic update source — legacy lifecycle and coordinated schedule

The 4.6.0 production nightly registration uses the developer-suite coordinator and its saved
Latest/Alpha policy. It updates the discovered existing package owner and does not use the
legacy `latest` source's npx invocation. Its canonical operating policy lives in
`CONTRIBUTING.md` under "Coordinated developer updates (4.6.0)".

Automatic lifecycle invocation also joins the immutable canonical coordinator when configured
or registered. Its nested child inherits the shared owner token. An active but unready canonical
owner refuses work instead of creating a fallback copy.

Canonical automatic invocation selects its owner without reading legacy `updateSource`
settings. The preference below is resolved only for unconfigured legacy and older proof paths.
Enrolling the coordinated schedule does not rewrite the preference.
Its default `latest` source runs the current npm package through npx; to make those remaining
legacy paths use the installed coordinator instead, explicitly run:

```sh
ruvnet-brain --update-source installed
```

This saves only the canonical per-user `updateSource` setting under
`~/.config/ruvnet-brain/settings.json`, preserving other owner preferences. Unconfigured legacy nightly and lifecycle paths
read that user choice; a project cannot override it. Missing
or malformed installed packages and unreadable, corrupt or future settings refuse automatic work
instead of falling back to npx. Restore the default with `ruvnet-brain --update-source latest`.

Installed mode invokes the declared Brain installer in your existing `~/.npm-global` package with
`--update`. It keeps the normal signature, coverage, compatibility, locking, private-overlay and
host-convergence checks. Compatible signed corpus generations continue to update. An incompatible
corpus is refused; update your global Brain package manually before retrying. This option avoids
unattended npx, not every possible network request or every existing dependency installation. It
does not switch the updater to notifications only and does not install a second global CLI.

Native schedule enrollment resolves Homebrew's active `opt` Node alias from the running installer, rather
than recording a versioned Cellar executable. A stable alias must resolve to that interpreter and
report a supported Node version. For another installation use:

```sh
ruvnet-brain --enable-nightly --nightly-node /absolute/stable/node
```

Run the installer with that same interpreter when selecting an explicit alias. Version-manager
cache paths without a stable alias refuse enrollment. The runner compares real paths at launch,
allowing the alias to follow an upgrade while refusing another interpreter. Automatic subprocesses
use deterministic owner-prefix and system tool paths; inherited project and npx-cache paths are
excluded. Enrollment still requires the existing explicit authorization to change OS scheduling.

Bundle and metadata GET/read failures receive at most three attempts within an absolute deadline.
Each file attempt writes a fresh private stage from byte zero; failed stages are discarded. There
is no blind Range resume. Socket resets, timeouts and selected transient HTTP responses retry.
Authorization failures, 404s, TLS trust errors, invalid JSON, invalid signatures and failed corpus
validation remain refusals. Successful transport is only the start of validation.

The source fixture exercises the real installed coordinator through SessionStart and a running MCP
server, using an isolated HOME, local signed synthetic corpora and a test trust root. It checks
compatible generations, private bytes, zero installed-mode npx calls and refusal paths. This is
fixture acceptance; it does not prove an owner's real scheduled run or a loaded native window.
