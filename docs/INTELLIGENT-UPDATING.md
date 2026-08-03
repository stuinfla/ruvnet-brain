Updated: 2026-08-02 18:25:00 EDT | Version 2.0.1
Created: 2026-07-18 10:55:00 EDT

# Intelligent Updating — how RuvNet Brain stays current without ever trapping you

> Governing decision: **ADR-0023** (Stable Spine). Bounded context: **docs/ddd/0003-update-context.md**.
> House pattern mirrored: cognitum-v0-appliance **ADR-248** (manifest → verify → atomic swap → health-gate → retained-prev rollback).
> **v2.0.0 (same day):** revised after the GPT-5.6 adversarial review (`docs/reviews/0023-gpt56-redteam.md`,
> 30 findings). Major accepted changes: `active.json` generation pointer replaces the symlink (portable,
> atomic, no privileges); the hook shim is a **Node dispatch table** (typed interpreter + advisory/blocking
> mode per hook); the MCP layer is a **stable server delegating per-call to the active generation** — the
> handshake-replaying child proxy is dead; one locked updater with a persisted transaction record; signing
> mandatory for **unattended** applies; explicit one-restart migration. Rejected with reasons: per-session
> epoch pinning (finding 14) — it would resurrect the trapped-session disease; we use per-invocation
> atomicity plus a forward-compat contract on hook output formats instead.

## 0. The one-paragraph version

Claude Code loads a plugin **once, at boot, from a version-frozen directory** — so anything that
lives there is trapped until restart. Ruflo's CLI never has this problem because a CLI is
**invoked** (fresh `exec` per call), not **loaded**. Intelligent Updating restructures the Brain so
that almost everything becomes *invoked through one stable pointer* —
`~/.cache/ruvnet-brain/active.json` — and updating is just atomically rewriting that pointer.
Hooks run new code on their next fire. The stable MCP server swaps its warm brain worker between
requests. No restart, no nag, no trapped users — on npm, npx, git-clone, and marketplace installs
alike.

## 1. The two classes: loaded vs invoked

| Piece | Class | Update latency |
|---|---|---|
| hooks.json **declarations** (matchers, timeouts) | loaded at CC boot | next restart (rare; honest nag) |
| skills / commands markdown | loaded at CC boot | next restart (rare; honest nag) |
| MCP **tool name + registration** | loaded at CC boot | next restart (rare; honest nag) |
| **hook script bodies** (grounding, session-start, walls…) | invoked per fire → **spine** | next hook fire (seconds) |
| **MCP behavior** (`search_ruvnet` implementation + KB) | warm worker under the stable server | next tool call after worker swap |
| CLI / console / scripts | invoked | immediately |
| KB data stores | read per query by the MCP child | on KB update (own track) |

Design rule that keeps this working forever: **the boot-frozen shell must stay tiny and boring.**
`plugin/` changes are near-frozen ABI; anything with behavior belongs in the body (spine-resolved).

## 2. The spine — filesystem contract (v2: pointer file, not symlink)

```
~/.cache/ruvnet-brain/
  active.json                  # THE SPINE: atomically-rewritten pointer (temp-file + rename)
  versions/
    3.4.13-dev/                # immutable, fully-gated code payload (never edited in place)
    3.4.14-dev/
  kb/                          # KB DATA — separate lifecycle (forge-update.mjs), private-store fence intact
  .update.lock/                # single-updater lock DIR (atomic mkdir; pid+host+target inside; stale-reclaimed)
  update-txn.json              # persisted transaction record — crash recovery is deterministic
  update-receipts.jsonl        # append-only ledger: every check/apply/flip/rollback, with SHAs
  dev.json                     # OPT-IN dev mode marker (points codeRoot at a git checkout; never auto-flipped away)
```

`active.json` (the entire control plane, one small file):

```json
{ "generation": 41, "version": "3.4.14-dev", "codeRoot": "versions/3.4.14-dev",
  "digest": "sha256:…", "previous": { "generation": 40, "codeRoot": "versions/3.4.13-dev" },
  "requiresRestart": false, "flippedAt": "…" }
```

- **Atomic flip**: write `active.json.tmp-<pid>` → `fs.renameSync` over `active.json`. Atomic on
  macOS/Linux/Windows, no symlink privileges anywhere (red-team finding 6). Readers parse
  `generation` — never compare file mtimes (finding 26).
- **Consistency during a flip**: every consumer (shim, MCP server) reads `active.json` **once per
  invocation/call**, resolves `codeRoot`, validates it sits under `versions/` (finding 13), and uses
  that resolved tree for the whole invocation — never straddling two generations mid-run. Version
  dirs are immutable, so a resolved tree cannot change underneath a running script.
- **Concurrent updaters** (three sessions on this very machine today, plus nightly): `.update.lock/`
  acquired by atomic `mkdir` with stale-pid reclaim; **every** writing entry point (installer,
  --update, session-triggered, nightly) goes through the ONE engine that takes it (finding 5).
- **GC/retention** (finding 23): keep active + previous + last-known-good + any version with a fresh
  lease (the MCP server leases the generation it's serving); collect the rest under the update lock.

## 3. The hook shim — a Node dispatch table (v2, findings 15/16/30)

`plugin/hooks/hooks.json` (frozen per session — fine, it changes ~never) routes every hook through
one Node shim with an explicit table:

```
command: node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" ground-ruvnet     (advisory entries keep `|| true`)
command: node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs" route-dispatch || true  (advisory on the host's async Agent/Task boundary)
```

`hook-shim.mjs` (part of the frozen shell, designed to never need changing) carries a dispatch
table: hook id → relative path, interpreter (`bash` | `node`), mode (`advisory` | `blocking`).

1. Read `active.json`; validate `codeRoot` is under `~/.cache/ruvnet-brain/versions/` (or the
   `dev.json` checkout — finding 24). Resolve ONCE per invocation.
2. Spawn `<interpreter> <codeRoot>/plugin/scripts/<file>` with stdin/env passthrough;
   **propagate the exit code verbatim** — blocking semantics survive by contract, not by luck.
3. No spine / broken spine → fall back to `${CLAUDE_PLUGIN_ROOT}/scripts/<file>` AND emit a loud
   one-line warning naming the frozen fallback version (finding 25: a silent fallback would mask a
   broken spine forever). First-install (no spine yet, nothing staged) stays quiet.

Consequence: the CC-versioned plugin cache stops mattering. Whatever stale version CC boots,
hook fire #1 executes current code.

## 4. The MCP layer — a stable server, not a hot-swapped child (v2, findings 7/8/9)

The red-team killed the handshake-replay proxy — replaying `initialize` to a fresh child while
preserving JSON-RPC id continuity is a protocol minefield, not a 15-line patch. The stable design:

- `plugin/mcp/server.mjs` becomes a **real, minimal MCP stdio server** (frozen shell): it owns the
  protocol — `initialize`, `tools/list`, `tools/call` — and declares `search_ruvnet` itself, with a
  **fixed tool schema**. The client connection is never proxied, never replayed, never dropped.
- Delegation, **as built** (the brain has no importable query library — it ships a stdio server,
  so a dynamic-import design would have meant forking it): the stable server supervises a **warm
  child worker** (the KB's own `forge-mcp-all.mjs`, unchanged) over a **private handshake** — the
  parent sends its OWN `initialize` with parent-allocated ids and forwards `tools/call` with id
  remapping in both directions. The client's handshake is never replayed to anyone. On a generation
  change (`active.json`) or a KB-track code change (the worker file's mtime), the child is
  respawned **between requests only** (pending-count drain gate); warm model state costs one reload
  per update, not per call. The server takes a **lease** on the generation it's serving so GC can't
  pull it out from under an in-flight call.
- A call already in flight completes on its generation; the next call gets the new one. No swap
  logic, no id remapping, no child supervision — the entire class of findings 7–9 evaporates.
- If a new generation's import or first query fails → serve the previous generation, write a loud
  receipt, and flag `--doctor` (process-level health-gating, ADR-248 §6's principle).
- Honest limit: changes to the **stable server itself** or the tool's declared schema are shell
  changes → `requiresRestart: true`.

## 5. The update engine — `scripts/update-apply.mjs`

One engine, invoked by every trigger (session-start background check, nightly launchd, `--update`,
`bin/install.mjs`):

```
lock     mkdir .update.lock/ (atomic; stale-pid reclaim) — EVERY writing entry point takes it
check    GET manifest (releases/latest → manifest.json)
verify   Ed25519 manifest+bundle signature (pubkey shipped in the shell — findings 10/11:
         signature is MANDATORY for unattended applies; manual --update may proceed on
         SHA-256 + an explicit loud warning) · SHA-256 each artifact ·
         zip-entry preflight: reject ../, absolute paths, symlinks, device files (finding 12)
unpack   → versions/<v>.staging-<pid>/   (never into a live dir; ONE shared extraction impl
         used by installer and updater alike — finding 17)
gate     run each hook script under its declared interpreter with representative hook JSON on
         stdin, assert exit semantics (advisory 0 / blocking contract) · start the stable MCP
         server against the candidate: initialize → tools/list → one real tools/call (finding 20)
txn      write update-txn.json {state: candidate-ready, from, to}   — crash recovery reads this
promote  mv versions/<v>.staging-<pid> versions/<v>   (atomic)
flip     rewrite active.json (generation+1, previous kept) via temp+rename
txn      update-txn.json {state: active} · receipt appended
```

`--rollback`: rewrite `active.json` pointing at `previous`, receipt. One command, instant.
On every engine start: an incomplete `update-txn.json` state is recovered deterministically under
the lock (finding 21) — a crash between any two steps leaves either the old world or the new
world, never a half-world.

**Failure modes, by construction:**
- Network dies mid-download → staging dir discarded; `current` untouched.
- Bad bundle → verify fails → no promote, no flip. Users never see it.
- Gate fails → same. The receipt says why.
- Crash between promote and flip → a valid unused `versions/<v>` sits there; next run re-gates and
  flips it. Nothing is half-applied because the flip *is* the apply.
- Post-flip breakage discovered live → `--rollback`, or the proxy's 5s auto-rollback for the child.

## 6. The honest restart contract

The release manifest gains `requiresRestart: boolean` + `restartReason: string`, set by
`release.mjs` **automatically** (it diffs the shell: `plugin/hooks/hooks.json`, `plugin/.mcp.json`,
`plugin/skills/**`, `plugin/commands/**`, `hook-shim.sh`, `mcp/server.mjs` between releases — not
by a human remembering). session-start:

- update applied + `requiresRestart:false` → **say nothing**. It's just live.
- `requiresRestart:true` → ONE line, once, with the reason — the only nag that survives, and it's
  always true when shown.

## 7. Install-path agnosticism

| Path | What happens |
|---|---|
| `npx github:stuinfla/ruvnet-brain` / npm -g | `bin/install.mjs` installs KB (as today) + seeds `versions/<v>` + flips spine |
| Claude Code marketplace/plugin | CC installs the frozen shell; first session-start seeds the spine; from then on CC's own update cadence is irrelevant |
| git clone (maintainer) | `node scripts/update-apply.mjs --dev` → `current` → the checkout; edits are live on save. Guard: dev mode refuses to GC or overwrite a checkout target |
| Already-installed users (migration) | first session-start on the new version detects no spine → seeds it from the running plugin dir → flips. Zero-step migration |

## 8. Security posture

- Bundle Ed25519 signature verification stays mandatory (pubkey inlined in the installer — already
  shipped and CI-asserted); the spine adds SHA-256 per artifact from the manifest.
- The spine lives in user-space (`~/.cache`); no elevation, no keychain, no system mutation.
- Version dirs are immutable-by-convention and never executed from staging paths.
- The updater never touches `kb/` stores — the private-store fence (a user's private KBs) is
  structurally outside the code-update blast radius.

## 9. What we deliberately did NOT build

- **No hot-reload of CC declarations** — CC's loader owns those; pretending otherwise would lie.
  We minimize what lives there and tell the truth the one time a restart genuinely helps.
- **No per-hook version pinning / channels UI** — one `current`, one `prev`. Channels (stable/dev)
  exist only as manifest inputs. Complexity budget spent on atomicity and honesty instead.
- **No daemon.** Update checks piggyback on session-start + the existing nightly job. Nothing new
  runs resident.

## 10. Proving it (what "tested the shit out of it" means here)

- Unit: shim resolution + fallback + exit-code preservation; atomic flip under concurrent flips;
  rollback; manifest requiresRestart diffing; receipt writing.
- Integration: spawn the real proxy, run a real `initialize` → flip spine → next call answers from
  the NEW child (asserted via a version echo in the tool result), old child reaped.
- Live: fire a real hook via the shim, flip to a version dir with a marker change, fire again in
  the SAME session, observe the change — the restart-free update, demonstrated, not asserted.
