---
id: ADR-021
title: One shared hook-input parser — a PreToolUse gate is a parser; write and test the parser ONCE
status: Accepted
date: 2026-07-18
authors: [Stuart Kerr, Claude Code]
tags: [gates, hooks, parsing, correctness, dry, trust]
supersedes: []
relates: [ADR-020]
updated: 2026-09-17
updated_source: derived-from-git
---

**Status**: Accepted (hook-input.mjs shipped; design-wall.sh ported; former verify-interface shell consumer retired)

## Context

Every PreToolUse gate must answer one question from Claude Code's JSON hook event: "is this really an
invocation of tool X, and what is the command?" Each gate hand-rolled the extraction with a bash regex:

```bash
field() { local re="\"$1\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""; [[ $INPUT =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"; }
```

`([^"]*)` cannot cross a `"`, and a JSON-escaped `\"` is still a literal `"` byte in the raw payload —
so **any command containing a quote was silently truncated at the first one.** For a gate that means it
**fails open on exactly the commands most worth inspecting** (`echo "x" && vercel --prod` truncated to
`echo \` — the deploy vanished). This was issue #13, fixed once in `verify-interface.sh` by parsing with
`node -e JSON.parse`. But the fix lived as an inline snippet in that one file — so `design-wall.sh`,
written afterwards, **reintroduced the identical bug** (verified live 2026-07-18: its `vercel --prod`
and `open https://` triggers were parsed by the broken regex and failed open). One class, fixed in one
file, regenerated in the sibling. JSON string escaping is not a regular language; no regex fixes it.

## Decision

- **`plugin/scripts/hook-input.mjs`** — the ONE parser. Exports `parseHookEvent`, `toolName`,
  `commandOf`, `field(path)`; also a CLI (`… | node hook-input.mjs command`) the bash gates call. It
  fails open by contract: any parse failure or missing field returns `""` / exit 0, never a throw or
  nonzero — a gate that breaks the shell protects nothing.
- **Ported the remaining shell gate onto it.** `design-wall.sh` extracts via
  hook-input.mjs instead of a hand-rolled regex. The former verify-interface consumer is retired;
  managed CLI authorization is owned by structured MCP arguments.
- **One known-bad fixture, tested once** (`tests/unit/hook-input.test.mjs`): a command whose
  interesting part sits AFTER an embedded quote must round-trip WHOLE. Proven end-to-end: design-wall
  now correctly BLOCKS (exit 2) a quoted `vercel --prod` it previously let through, and still allows
  benign commands.

## Consequences

- The gate-parsing class (#12/#13/#17) is foreclosed in a shared module with a shared test, not
  re-litigated per file. A future gate imports the parser; it does not invent a fourth regex.
- design-wall.sh is now *stricter* (correct): commands it used to miss on a quote it now evaluates. That
  is the intended behavior — the wall exists to catch exactly those deploys/opens.
- `ground-before-write.sh` deliberately does NOT adopt the shared node parser and stays pure-bash
  (BASH_REMATCH), enforced by its own test: it is the critical BLOCKING wall, so it must depend on
  nothing fragile and can never fail-open because a tool went missing. Its #13 exposure is negligible
  (the product-term scan runs over the raw payload; only file_path parsing is affected, and a truncated
  path just fails the extension check → harmless fail-open). It did get the real fix it needed — an
  exemption so it stops firing on the guidance hooks (`ground-ruvnet.sh` / `session-start.sh`) whose
  job is to enumerate the very rUv product names it scans for.
