---
id: ADR-023
title: Intelligent Updating — the Stable Spine (auto-update every piece; restart only for declarations)
status: Accepted
date: 2026-07-18
authors: [Stuart Kerr, Claude Code]
tags: [updating, self-update, plugin, hot-reload, rollback, mcp, hooks]
supersedes: []
relates: [ADR-020, ADR-021, ADR-022]
updated: 2026-08-01
updated_source: derived-from-git
---

# ADR-0023 — Intelligent Updating: the Stable Spine

**Status**: Accepted (implemented in the feat/stable-spine change-set: hook-shim.mjs + dispatch-table hooks.json, stable MCP server with warm supervised worker, update-apply.mjs engine with lock/txn/gates/GC/rollback/dev-mode, session-start seed + honest shellChanged nag, release.mjs A2 classifier — 17 engine/shim tests green)

**Design provenance**: mirrors the house self-update pattern in cognitum-v0-appliance's ADR-248
(manifest → verify → atomic swap → health-gate → retained-prev rollback). A GPT-5.6 adversarial
review (`docs/reviews/0023-gpt56-redteam.md`, 30 findings) drove a major revision: the active-version pointer is
an atomically-rewritten `active.json` (portable, no symlink privileges), the hook shim is a Node
dispatch table (typed advisory/blocking modes), and the MCP layer is a stable server delegating
per-call to the active generation — not a handshake-replaying child proxy. Full doc:
`docs/INTELLIGENT-UPDATING.md`; bounded context: `docs/ddd/0003-update-context.md`.

## Context — the failure this kills

Users (starting with the maintainer, four separate times) are forced to **restart Claude Code to get ANY update** — and are nagged every session until they do. Root cause, verified live on 2026-07-18:

- Claude Code installs each plugin version into a **version-named directory**
  (`~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/<version>/`) and records that exact path in
  `installed_plugins.json`. The running CC process binds it at boot and never re-reads it.
- Every hook command in `plugin/hooks/hooks.json` uses `${CLAUDE_PLUGIN_ROOT}` — which resolves to
  that frozen dir. So **all behavioral code** (grounding, session-start, route-dispatch, design-wall,
  learn-capture…) is trapped at the boot-time version even though a newer one is fully downloaded
  and sitting on disk. Proof: this session ran 3.4.7-dev while `installed_plugins.json` already
  pointed at 3.4.11-dev.
- Meanwhile ruflo/RuVector *CLIs* update invisibly — because they are **invoked** (fresh exec per
  call), not **loaded** (bound at boot). The distinction between invoked and loaded is the entire
  architecture problem.

## Decision

Split the product into a **boot-frozen shell** (as small as possible, changes ~never) and a
**hot body** (everything else, updatable mid-session), joined by one stable path:

```
~/.cache/ruvnet-brain/
  active.json                                    # THE SPINE: atomic pointer file (temp+rename); no symlinks
  versions/<v>/                                  # immutable per-version code payloads
  update-txn.json · update-receipts.jsonl        # transaction record + append-only ledger
  .update.lock/ · leases/ · dev.json             # mkdir-lock · GC leases · opt-in dev mode
  kb/                                            # KB DATA — separate track, never touched by code updates
```

1. **Hook shim (shell)** — `hooks.json` commands change once, forever, to run
   `node hook-shim.mjs <hook-id>`: a typed dispatch table (file, interpreter, advisory|blocking
   mode) that reads `active.json` once per invocation, validates codeRoot containment under
   `versions/` (or the explicit `dev.json` checkout), and executes the hook body from that
   immutable tree. Blocking hooks propagate exact exit codes — `route-dispatch.sh`'s deliberate
   exit-2 wall survives by contract. Broken spine → LOUD fallback to `${CLAUDE_PLUGIN_ROOT}`;
   first-install → quiet fallback. **Hook behavior updates the moment `active.json` flips — zero
   restart.**

2. **Stable MCP server (shell)** — `plugin/mcp/server.mjs` owns the client protocol itself
   (initialize / ping / tools/list / tools/call; fixed `search_ruvnet` schema) and supervises the
   brain (`forge-mcp-all.mjs`) as a **warm child worker over a PRIVATE handshake**:
   parent-owned ids in both directions, the client's handshake never replayed to anyone. On a
   generation change (or a KB-track code change), the child respawns **between requests only**
   (pending-count drain gate); the server leases the generation it serves so GC can't collect it.
   Capability discovery is shell-owned and protocol-fast: `tools/list` returns the fixed declarations
   without waiting for worker/model warmup. Initialize starts one shared readiness attempt; the first
   `search_ruvnet` call joins it. Atomic `mcp-readiness.json` receipts distinguish registered,
   ready/live, and degraded startup or worker-exit states for SessionStart and doctor. Codex's managed
   registration also carries a 30-second startup deadline as defense in depth, not as permission to
   block discovery on model work.
   **Claude Code's connection never drops; `search_ruvnet` serves the new brain mid-session.**

3. **Update engine (ships in the plugin payload)** — `plugin/scripts/update-apply.mjs`, mirroring
   cognitum-v0-appliance ADR-248's proven mechanic: mkdir-atomic lock → staged copy (never into a
   live dir) → **interpreter-true gates** (bash -n where bash exists, node --check everywhere,
   hooks.json parse) → **transaction record** → atomic promote → **atomic `active.json` rewrite**
   (temp+rename — the flip IS the update) → previous retained for instant `--rollback` → GC with
   leases → `shellChanged` computed on every flip. A failed gate = no flip = users stay on the
   working version. Crash anywhere = deterministic recovery to old world or new world, never half.

4. **Honest restart contract** — the release manifest carries `requiresRestart: true` **only** when
   boot-frozen declarations changed (hooks.json matchers, skills/commands markdown, MCP tool name,
   the shim/proxy themselves). Everything else updates silently. The every-session restart nag is
   deleted; the only remaining nag is the rare, truthful one.

5. **Install-path agnostic** — npm, npx, git clone, and the CC marketplace all converge on the same
   spine: `bin/install.mjs` and session-start both drive `update-apply.mjs`; a git checkout can
   opt into dev mode (`current` → the checkout) so maintainers are live-on-save.

6. **KB data stays on its own track** — `versions/` holds CODE only. KB stores keep their existing
   update flow (`forge-update.mjs`) including the private-store fence: a code update can never
   strip a user's private stores (the maintainer's machine carries 3).

7. **Host-neutral convergence** — SessionStart launches `host-update.mjs`, never a host-specific
   marketplace pipeline. The current published installer refreshes the signed KB release, wires
   every detected Claude Code and Codex host through its supported plugin lifecycle, requires the
   installed snapshot version to equal the candidate exactly, and only then advances the Spine from
   the newest staged payload in either host cache. A missing, stale, or unverifiable host snapshot
   leaves the prior runtime generation active and returns a failed update for automatic retry.

   **Trust boundary (reconciled 2026-07-29):** the Brain/KB Release archive is the product-signed
   channel and unattended extraction requires its Ed25519 signature. Host plugin code is a separate
   package-manager channel: npm/Claude/Codex verifies its published artifact integrity, then the
   Spine independently requires exact version equality, contained regular files with no symlinks,
   and all structural/runtime gates before activation. We do not claim an Ed25519 signature exists
   on a host cache when that channel supplies none.

## Why this holds

- It converts our "loaded" surfaces into "invoked" surfaces wherever the process boundary allows,
  and makes the one truly-resident piece (the MCP child) swappable behind a stable proxy — the same
  reason ruflo's CLI updates live while its MCP needs a restart, solved instead of accepted.
- Every mechanic is the already-proven house pattern (ADR-248: manifest → verify → atomic swap →
  health-gate → retained-prev rollback), applied to a plugin instead of an appliance.
- Failure-safe by construction: gate-before-flip, the flip is one atomic rename, rollback is a
  pointer rewrite away, and a missing spine falls back to the plugin dir (the status quo, never worse).

## Consequences

- Users on any install path get every behavioral/knowledge update **without restarting, without
  knowing** — the "trapped on an old version" class of issue ends.
- `plugin/` (the shell) must now be treated as near-frozen ABI: changes there are rare, flagged
  `requiresRestart`, and get the one honest nag.
- The versioned CC plugin cache stops mattering: whatever stale version CC boots, the first hook
  fire executes the active generation. CC's own updater becomes the trusted download path whose
  staged payload the engine gates and applies.
- New failure mode to watch: a broken active generation. Mitigated by gate-before-flip + retained
  previous + loud shim fallback; `update-apply.mjs --doctor` reports spine state.
- A dual-host machine has one candidate and one runtime Spine, not two update races. A Codex-only
  machine does not require the `claude` executable, and vice versa.

## What this does NOT claim

- Declarations (hooks.json matchers, skill/command markdown, MCP tool *names*) still require a CC
  restart — that is CC's loader, not ours. The manifest flag keeps that honest and rare.
- The MCP child swap serves the NEXT tool call on new code; a call already in flight completes on
  the old child.
