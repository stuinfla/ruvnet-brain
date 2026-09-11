# TriSmart Skill

**Version 1.1.0** · semantic versioning (`major.minor.patch`)

For a non-technical first run, start with [QUICKSTART.md](QUICKSTART.md).

TriSmart Skill is a portable subscription-only, cross-provider architectural review skill. It uses native Claude Code, Codex, and Grok CLIs with their top verified models, performs adversarial proposal and critique stages, persists only non-secret receipts in AgentDB, and hands accepted work to lower-cost implementation agents. It selects TriSmart when all three are available and Dual when any two are available; Claude + OpenAI is the preferred pair, but the available pair is reported explicitly.

## Install

The installer is a Node program. Double-clicking `install.mjs` opens its source text; that is expected. Use the launcher for your operating system:

- **macOS:** double-click `install.command`, or run `./install.sh` in Terminal.
- **Windows:** double-click `install.cmd`, or run `install.cmd` in PowerShell or Command Prompt.
- **Linux:** run `./install.sh` in a terminal.

All launchers run the same installer. Node.js 18+ is required. The direct command is:

```sh
node install.mjs
```

### macOS first run

Because this ZIP contains an unsigned local script, macOS may show “Apple could not verify install.command.” In Finder, **Control-click (or right-click) `install.command`, choose Open, then choose Open again**. That approves this copy. If you prefer Terminal, use the shell launcher instead:

```sh
cd /path/to/tri-smart-skill
chmod +x install.sh
./install.sh
```

If macOS has already quarantined the file and the right-click path is unavailable, remove quarantine from this extracted copy and run it:

```sh
xattr -d com.apple.quarantine install.command install.sh 2>/dev/null || true
./install.sh
```

There are two supported setup styles:

- **Guided / high-tech:** run the launcher or `node install.mjs`. It creates the host folders, copies the skill, and walks you through OAuth setup.
- **Manual / low-tech:** open the extracted ZIP and drag the `tri-smart` folder into the host's skill directory. Use `.claude/skills/tri-smart/` for Claude Code, `.agents/skills/tri-smart/` for Codex, or `.grok/skills/tri-smart/` for Grok Code. Then restart or reload that host so it discovers the skill.

It installs the same host-neutral skill into your user-level Claude, Codex, and Grok skill directories by default, then starts the guided OAuth walkthrough. Existing installations are preserved; use `--force` only when deliberately upgrading one. Preview it with `node install.mjs --dry-run`; target one host with `--host=claude`, `--host=codex`, or `--host=grok`; target a project-local install with `--project=/path/to/project`.

If you prefer to install manually, copy the `tri-smart` directory into the skill directory used by your host. This is a valid setup path; the installer only automates the copy and guided login:

- Claude Code: `.claude/skills/tri-smart/` or `~/.claude/skills/tri-smart/`
- Codex: `.agents/skills/tri-smart/` or `~/.codex/skills/tri-smart/`
- Grok Code: the skills directory shown by `grok inspect` (commonly `.grok/skills/tri-smart/`)

The same `SKILL.md` is host-neutral and can be loaded by all three hosts. The active host must be able to discover and invoke the other two native CLIs to execute the full workflow; otherwise ModelMesh returns a clearly labeled degraded result. Account tiers vary: ModelMesh tries the preferred top model, then uses the provider's own highest/default model if the account does not include it, and reports the actual model used. It never silently labels a fallback as the top model. Use the host's documented skill directory and verify discovery from that host before relying on it.

## Verify access

For a guided first setup, run:

```sh
node tri-smart/scripts/setup.mjs
```

It detects the CLIs, offers each official OAuth login, explains the selected Dual/TriSmart mode, and asks before spending subscription allowance on a live probe. Use `--dry-run` to see the walkthrough without logging in.

After setup, run the bounded orchestration directly from any of the three hosts:

```sh
node tri-smart/scripts/review.mjs --task-file=architecture-question.md
```

The runner performs independent proposals in bounded parallel waves (two native sessions at a time to avoid provider throttling), pairwise challenge, deterministic synthesis, and independent verification. It prints only stage explanations and a structured decision; it stays read-only and reports the actual model or provider-default fallback used.
Before Stage 1 it prints the exact host/provider/model mapping and native authentication mode. “Dual” or “TriSmart” alone is never the complete model status.
It also prints: “native provider subscription/OAuth CLIs; API-key variables unset.” That proves the access path used by the runner; it does not claim visibility into a provider's internal billing ledger.

From the unzipped directory:

```sh
node tri-smart/scripts/verify-access.mjs
node tri-smart/scripts/verify-access.mjs --probe
node tri-smart/scripts/verify-access.mjs --mode=dual --probe
node tri-smart/scripts/verify-access.mjs --mode=tri --probe
```

The second command performs real single-turn probes only after the selected mode's OAuth/subscription checks pass and may consume subscription allowance. It strips provider API, cloud, helper, and custom-routing variables, validates the exact OAuth mode and model marker, and emits allowlisted metadata only; raw provider output is never printed.

## Trigger

Say **“use ModelMesh”** / **“model mesh”** for automatic mode selection, **“use TriSmart”** / **“tri smart”** / **“trip smart”** for the three-way review, or **“use Dual”** / **“dual smart”** for a two-provider review. “Brock” is accepted as a casual name for Grok. The skill recalls AgentDB, RVF, the North Star, active hooks, release contracts, and prior lessons before starting the review.

## Scope and safety

The package contains instructions and a deterministic access verifier; it does not contain credentials or a hidden API proxy. Native CLI authentication remains in each vendor's secure user store. A provider outage produces a degraded result and never silently substitutes another model. The skill does not claim a production release from a local pass or draft receipt. The verifier proves access prerequisites and marker probes; it does not by itself prove host skill discovery, a complete architectural review, or production readiness.
