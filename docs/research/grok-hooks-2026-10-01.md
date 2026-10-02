Updated: 2026-10-01 11:20:00 EDT | Version 1.0.0
Created: 2026-10-01 11:20:00 EDT

# Grok CLI and the Brain's hooks — what loads, what runs, what is supported

Grok CLI 1.0.13 (`grok 1.0.13 (5e9a58528b76) [stable]`). Every statement below is either quoted from
Grok's shipped docs (path:line) or was measured on 2026-10-01; nothing is inferred from the name of a
setting.

## 1. The payload (fixed in 4.5)

Grok runs Claude-format hooks but its payload differs (`~/.grok/docs/user-guide/10-hooks.md` "Input",
lines 241-254; captures in `tests/fixtures/hook-payloads/grok/`): snake_case event names
(`pre_tool_use`), its own tool names (the measured file tool is `write`; the docs also name
`search_replace` and `run_terminal_command`), camelCase fields, and a Stop payload whose
`lastAssistantMessage` / `stopHookActive` have no snake_case duplicate. A matcher written with Claude
names still fires — Grok aliases them in the *matcher* (10-hooks.md "Tool Name Aliases", 167-179) —
but the payload keeps the native name, so the write guards compared `tool_name` to `Write` and
silently allowed a Grok `write`.

4.5 normalises a Grok payload to Claude's shape in the one parser (`plugin/scripts/hook-input.mjs`
`normalizeHostEvent`), decision-gate normalises before its policies, and the bash write guards match
the tool name case-insensitively. Claude and Codex payloads are returned untouched.

## 2. Why the Brain's hooks do not run in `grok -p`

Grok documents plugin hooks as loading from trusted plugins (`09-plugins.md:14`, `:148`, `:326`) and
lists Claude Code's plugin directories and `~/.claude/plugins/installed_plugins.json` as plugin
sources whose hooks are "discovered and used by Grok at runtime" (the README's "Claude Code
Compatibility" table, embedded in the binary). Measured:

| Probe | Result |
|---|---|
| `grok inspect --json`, isolated HOME + GROK_HOME, plugin copied to `~/.grok/plugins/ruvnet-brain` | discovered, scope user, **enabled**, `hooks/hooks.json` listed |
| same, copied to `~/.claude/plugins/ruvnet-brain` | discovered, enabled, hooks listed |
| same, Claude Code's real layout `~/.claude/plugins/cache/<mkt>/<plugin>/<ver>` without `installed_plugins.json` | **not discovered** |
| same, project `.grok/plugins/ruvnet-brain` in an untrusted folder | discovered, **enabled: false**, no hooks |
| `grok plugin install <dir> --trust` (isolated) | copied to `~/.grok/installed-plugins/<slug>`, enabled, hooks listed |
| `grok inspect --json`, the owner's real HOME | Brain discovered from `~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/4.4.0`, hooks listed |
| **one real `grok -p` turn that writes a file**, owner's real HOME, debug log | Brain discovered (`has_hooks=true`), its **MCP server attached**; the session logged `loaded hooks hook_count=8` — exactly the 4 hooks in `~/.claude/settings.json` + the 4 in `~/.grok/hooks/superwhisper.json`. **No plugin's hooks** (not the Brain's, not superpowers', not vercel's) were loaded, and no Brain hook ever completed. |

So `grok inspect` reporting a plugin's hooks is not evidence they run: in `grok -p` on 1.0.13 the
session loads global hooks only. `--plugin-dir` would make a plugin trusted, but it exists only on
`grok agent … stdio` and is ignored in leader mode (`09-plugins.md:360-365`); `grok -p` has no such flag.

`scripts/hook-qualify-hosts.mjs` `scanGrok` now reports "Brain plugin hooks discovered but never ran"
as a finding, so a Layer 2 Grok run cannot pass while this is true.

## 3. The supported path, and what it can carry

**Global hooks are what `grok -p` loads**: `~/.grok/hooks/*.json` ("always trusted",
`10-hooks.md:78`) and `[[hooks.<Event>]]` in `~/.grok/config.toml` (`10-hooks.md:214`). Measured: the
owner's `~/.grok/hooks/superwhisper.json` hooks ran in the `-p` turn above.

What a Brain hook can do once it runs on Grok (all from `10-hooks.md`):
- **PreToolUse** can deny (exit 2 or `decision: deny`) — the write gate works (4.5 payload fix).
- **Stop** can block (`decision: block`) — the grounding and continuation gates work; Grok overrides
  after 8 continuations per turn (`:306`).
- **UserPromptSubmit** output is discarded ("stdout of an allowing hook is discarded (no
  `additionalContext`)", `:112`), and **SessionStart / PostToolUse** stdout is ignored (`:440`). The
  grounding *directive* therefore cannot reach the model on Grok; only the gates can.
- Timeouts default to 5 s (600 s for Stop) and every failure fails open (`:165`, `:190`).

**Not built yet (follow-up):** the installer does not write a Grok global hooks file. It needs a
version-stable launcher (the Codex equivalent is `~/.cache/ruvnet-brain/codex-hook.mjs`): a global
hook cannot point at the Claude plugin cache (`…/ruvnet-brain/<version>/…`), which changes on every
update, and `CLAUDE_PLUGIN_ROOT` is set only for plugin hooks. `hook-shim.mjs` already resolves its
own root when that variable is absent, so a stable copy of the shim plus a Brain-owned
`~/.grok/hooks/ruvnet-brain.json` registering PreToolUse (write route), PostToolUse (grounding stamp),
Stop, PreCompact and SessionEnd is the whole wiring; uninstall and `--doctor` must own that file.

## 4. Not verified

- Whether `/plugins enable`, `grok plugin install --trust`, or a plugin under `~/.grok/plugins/` makes
  plugin hooks load in `grok -p`: verifying it needs a signed-in Grok with a changed `~/.grok`, which
  this work was not authorised to touch, and an isolated `GROK_HOME` has no credentials.
- Interactive (TUI) Grok sessions were not run; only `grok -p`.
- Grok's `search_replace` input shape was not captured; the normaliser maps the name to `Edit` and
  reads Claude's field names.
