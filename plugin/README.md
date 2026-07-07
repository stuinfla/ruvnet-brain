# ruvnet-brain — a RuvNet brain transplant for Claude Code

One install gives Claude Code a **source-grounded brain over Reuven Cohen's (rUv's) RuvNet ecosystem**
(Ruflo, RuVector/RVF, AgentDB, RuLake, RuView, agentic-flow, SPARC, QuDAG, ruv-fann, SAFLA, FACT,
SynthLang, DAA, agent-harness-generator, agenticow, cve-bench, and more) **plus always-on grounding**
so Claude answers from rUv's real source instead of drifting to training-prior defaults.

> This is the plugin's short README. **The full story, current version, exact repo coverage, install
> options, and proof live in the [root README](../README.md)** — kept as the single source of truth so
> nothing here can go stale. Version is shown live on the badge at the top of that README.

## Install (one line)

```bash
npx ruvnet-brain
```

Installs at **user scope** — active in every project, nothing to reinstall per repo. (Manual path and
the `github:` bleeding-edge form are in the [root README](../README.md#install--one-line).)

## What you get

| Piece | File | Effect |
|---|---|---|
| **Knowledge** | `.mcp.json` → `ruvnet-brain` MCP | the `search_ruvnet` tool: cross-repo, cross-encoder-ranked, source-grounded retrieval over rUv's real source |
| **Behavior** | `skills/ruvnet-brain/SKILL.md` | grounds RuvNet claims and prefers RuvNet building blocks over pgvector/Pinecone/LangChain/etc. |
| **Enforcement** | `hooks/hooks.json` + `scripts/*.sh` | a `UserPromptSubmit` hook that injects a grounding directive every RuvNet-relevant turn — a strong, always-on nudge (it steers, it doesn't rewrite your code) |

## How the brain is delivered

The plugin is tiny and path-free; the knowledge bundle is fetched once to `~/.cache/ruvnet-brain/kb`
by the `npx ruvnet-brain` installer. It stays current on its own — see the root README's
"Staying current" notes.

## License

MIT
