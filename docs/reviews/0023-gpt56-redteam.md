# ADR-0023 Red-Team Review — GPT-5.6

Updated: 2026-07-18

Reviewer stance: adversarial architecture review of `docs/adr/0023-intelligent-updating-stable-spine.md` against the actual code in `plugin/hooks/hooks.json`, `plugin/mcp/server.mjs`, `plugin/scripts/session-start.sh`, `bin/install.mjs`, `scripts/release.mjs`, and the effective bundled updater `kb/forge-update.mjs` because `scripts/forge-update.mjs` is absent.

One thing I agree with: splitting boot-frozen declarations from invoked behavior is the right direction. Everything below is about the places where this ADR either does not implement that split, implements it unsafely, or chooses a more complex mechanism than needed.

1. **BLOCKER — The ADR is marked Accepted, but the described spine is not implemented.**

   `plugin/hooks/hooks.json` still invokes `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh` and `${CLAUDE_PLUGIN_ROOT}/the former learning flusher (deleted 2026-10-12)` directly (`hooks.json:11`, `:21`, `:33`, `:45`, `:55`, `:65`, `:75`, `:87`, `:99`). `plugin/mcp/server.mjs` is still a one-shot `spawn('node', [MCP], { stdio: 'inherit' })` launcher (`server.mjs:41`). `scripts/update-apply.mjs` does not exist. `scripts/forge-update.mjs` does not exist. `scripts/release.mjs` has no gate for hook shim presence, reload-stamp behavior, `requiresRestart`, or spine integrity. As written, the ADR is not an accepted design record for shipped behavior; it is a future implementation sketch with production claims.

   Superior alternative: downgrade the ADR status to Proposed until the shell shims, update engine, proxy semantics, release gates, and failure tests are present. Add release gates that fail if hooks still reference `${CLAUDE_PLUGIN_ROOT}/scripts/` directly or if `scripts/update-apply.mjs` is missing.

2. **BLOCKER — The migration needs one final restart, and the ADR hides that bootstrap cost.**

   The only way existing installed versions can start using a hook shim is for Claude Code to load a new `hooks.json`. Today it has frozen direct commands. A background marketplace update in `session-start.sh:233-236` can stage a new plugin, but this running process will still use the old hook declarations until restart. The ADR says the every-session restart nag is deleted, but the first delivery of the stable spine necessarily requires a one-time restart.

   Superior alternative: define an explicit two-phase migration: release N installs the boot shim and honestly asks for one restart; release N+1 and later can hot-swap body code. The release manifest should carry `migrationRequiresRestart: true` for the first spine release even if later body-only releases do not.

3. **BLOCKER — The code/body split is internally inconsistent: executable MCP code still lives in the KB data directory.**

   ADR-0023 says `versions/` holds code and `kb/` holds data. Actual behavior runs executable code from `~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs` (`server.mjs:19-21`), ships tool code into the bundle (`build-bundle.mjs:204`), and the effective updater overwrites the KB directory including `.mjs` files (`kb/forge-update.mjs:196`). This is exactly the executable-data coupling the ADR claims to remove.

   Superior alternative: move all runtime code into `versions/<codeVersion>/plugin/...` or `versions/<digest>/runtime/...`; keep `kb/` to `.rvf`, passages, metadata, and model/data files only. The stable MCP server should load a fixed tool schema and delegate to code under the active code root while passing `KB_DIR` as data.

4. **BLOCKER — Current install and update paths mutate the live KB in place and are crash-corruptible.**

   `bin/install.mjs` extracts directly into `cacheDir` (`install.mjs:382`), then removes live paths before renaming extracted entries into place (`install.mjs:405-406`). A crash, `unzip` failure after partial writes, power loss, or concurrent reader during this window can leave a missing or mixed-version KB. `kb/forge-update.mjs` backs up the live dir (`forge-update.mjs:195`) and then `copyTree(extractDir, KB_DIR)` overwrites files one by one (`forge-update.mjs:115-120`, `:196`). Its “local files untouched” comments stop being true after line 196.

   Superior alternative: extract to `versions/<digest>.staging`, validate there, rename staging to immutable `versions/<digest>`, then atomically update a tiny pointer. Never unzip or copy over the active tree.

5. **BLOCKER — There is no cross-process lock, so two sessions can race the same spine/update.**

   `session-start.sh` rate-limits by writing a timestamp (`session-start.sh:205-208`) but does not lock. It can launch multiple `claude plugin update` jobs (`session-start.sh:233-236`) across simultaneous Claude windows. `bin/install.mjs` and `kb/forge-update.mjs` mutate the same `~/.cache/ruvnet-brain/kb` path without a lock. ADR-0023 adds a shared `current` symlink but does not define a lock around unpack/health/flip/stamp. Two sessions can download different versions, both validate, then flip in last-writer-wins order. Worse, one can run health checks against a tree another is replacing.

   Superior alternative: use a per-home lock directory such as `~/.cache/ruvnet-brain/.update.lock` acquired with atomic `mkdir`, containing pid/host/start/targetVersion, with stale-lock rules. Every entry point that writes cache state must use the same lock.

6. **BLOCKER — The proposed symlink spine is not a portable Windows design.**

   The current hooks already declare `"_platform": "posix"` and hard-code `/bin/bash` (`hooks.json:3`, `:11`, etc.). ADR-0023 doubles down on a POSIX symlink `current -> versions/<active-version>/`. Native Windows symlink creation often requires Developer Mode or elevated privileges. Directory junctions have different behavior, require absolute targets, and do not behave identically to POSIX symlinks under rename/delete. The installer has Windows accommodations for `.cmd` shims and PowerShell extraction (`install.mjs:136-146`, `:361-394`), but the ADR’s core update primitive is POSIX-biased.

   Superior alternative: do not use a symlink as the control plane. Use an atomically rewritten `active.json` pointer containing `{ codeRoot, kbRoot, version, digest, previous, manifestSig }`, and have stable Node shims read it. This works on macOS, Linux, and Windows without symlink privileges.

7. **BLOCKER — The MCP hot-swap proxy design is much harder than the ADR admits and is not compatible with `stdio: inherit`.**

   The existing MCP launcher cannot cache or replay anything because it wires Claude Code directly to the child with inherited stdio (`server.mjs:40-41`). A real hot-swap proxy must parse JSON-RPC messages, track request ids, understand initialization state, forward stderr separately, handle process death, and multiplex stdin/stdout. ADR-0023 treats this as a small addition to the existing proxy, but the existing proxy is not a proxy in the protocol sense; it is just a process launcher.

   Superior alternative: replace the MCP child-proxy plan with a stable MCP server that declares `search_ruvnet` itself and, on each tool call, dispatches to the active implementation through a private API. If warm models require a worker, keep a worker behind an internal request protocol, not a replayed external MCP handshake.

8. **BLOCKER — Replaying `initialize` risks invalid JSON-RPC/MCP state unless ids and notifications are remapped.**

   MCP initialization is not just one request. The client sends `initialize`, receives a response, then sends an `initialized` notification. If the proxy replays the cached `initialize` with the original client id to a new child, the child will respond with the same id; the proxy must swallow it without confusing pending client requests. It also needs to replay `initialized` if the child expects it. If the client sends batches or overlapping requests, the proxy must not mistake a child response id for a client id after restart.

   Superior alternative: if a child MCP server must remain, allocate proxy-private ids for all child requests, map ids both directions, cache both `initialize` and `initialized`, and test against real MCP traffic including notifications, batches, and concurrent requests. This is not a 15-line proxy change.

9. **BLOCKER — The ADR’s “between requests” swap rule ignores concurrent requests and streaming.**

   It says “Never swap mid-request; queue and swap between requests.” That only works if the client has at most one in-flight request. MCP/JSON-RPC permits concurrent requests and notifications; even if Claude Code is currently sequential, the plugin should not encode that assumption into an architecture whose purpose is resilience. A reload stamp observed while one request is pending must defer until all pending ids drain. Child death mid-request must return a JSON-RPC error for that id, not exit the parent process.

   Superior alternative: explicit state machine: `activeGeneration`, `pendingRequestCount`, `reloadPending`, `draining`, `spawnCandidate`, `healthProbeCandidate`, `promoteCandidate`. No swap while `pendingRequestCount > 0`; no parent exit for child crash unless boot initialization cannot ever succeed.

10. **MAJOR — The ADR claims verify-before-flip, but current signature policy still allows unsigned extraction.**

   `bin/install.mjs` has a good embedded Ed25519 verifier, but `SIGNING_REQUIRED = false` and missing signatures warn-and-proceed (`install.mjs:1902-1912`). There is also a user-facing `--no-verify` override. The effective updater has a legacy bootstrap branch that applies one unsigned update when verifier/key are absent (`forge-update.mjs:183-189`). That contradicts the ADR’s “SHA-256 verify” safety claim.

   Superior alternative: make signed manifest and signed bundle mandatory before enabling unattended update. For legacy installs without a verifier/key, refuse `forge-update.mjs --apply` and instruct the user to update via the npm installer, where the trust root is embedded in the package code.

11. **MAJOR — SHA-256 alone is not a supply-chain trust boundary.**

   ADR-0023 says “fetch manifest -> download -> SHA-256 verify.” If the manifest and bundle come from the same GitHub release/channel and the manifest is not signed by a pinned key, a compromised release can publish a matching malicious hash. The code already understands this better than the ADR: `install.mjs` and `build-bundle.mjs` include Ed25519 verifier/key handling (`install.mjs:26-39`, `build-bundle.mjs:221-230`). The ADR regresses the security model by naming hash verification but not signature verification as a hard requirement.

   Superior alternative: require a signed manifest whose public key is shipped in the boot shell. The manifest should bind version, digest, artifact URL, tool declarations, `requiresRestart`, and compatibility range.

12. **MAJOR — Archive extraction is not fenced against path traversal or unsafe entries.**

   Both `bin/install.mjs` and `kb/forge-update.mjs` delegate extraction to `unzip`/`Expand-Archive` without pre-validating archive entries (`install.mjs:382`, `:391-394`; `forge-update.mjs:191`). Signature verification lowers risk only when signatures are mandatory and trusted. Today they are not mandatory in the installer and not available for legacy auto-apply. A malicious archive with `../`, absolute paths, symlinks, or odd permissions is an avoidable footgun.

   Superior alternative: preflight the zip central directory before extraction, reject absolute paths, parent traversal, device files, and symlinks, and extract into a private staging dir only after signature verification.

13. **MAJOR — `current` as an executable pointer in a user-writable cache is a TOCTOU execution surface.**

   The hook shim would execute `~/.cache/ruvnet-brain/current/plugin/scripts/<name>`. Any process running as the user can rewrite `current` to arbitrary code between shim path resolution and `exec`, or can replace the target after a check unless the shim verifies the resolved realpath and signed manifest immediately before execution. Same-user compromise is not usually defended against, but this plugin explicitly runs code that changes model behavior, and the ADR is making the cache path a code root.

   Superior alternative: the shim should read `active.json`, resolve `codeRoot`, require it to be under `~/.cache/ruvnet-brain/versions/`, verify the version manifest signature or a stored digest receipt, then exec by file descriptor where possible or at least avoid a separate check/use gap. Also require parent directory permissions not group/world-writable.

14. **MAJOR — Hook hot-swap can make one Claude turn internally inconsistent.**

   Hooks fire at `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `SessionEnd`. If `current` flips mid-turn, grounding can come from version A, a pre-tool policy gate from version B, and learning flush from version C. The ADR treats “updates the moment current flips” as purely good, but multi-hook workflows need epoch consistency or explicit forward-compatible contracts.

   Superior alternative: stamp a session or turn epoch. At SessionStart, write the active version into a session env/file and have all hooks for that session use that epoch by default; allow explicit hot mode only for stateless hooks. If mid-session hot updates are required, define compatibility contracts for hook stdout formats and blocking exit codes.

15. **MAJOR — The route-dispatch blocking contract is fragile under a generic shim.**

   `route-dispatch.sh` deliberately exits 2 and is not guarded by `|| true` (`hooks.json:55`). The ADR says `exec` preserves exit codes, but the actual hook migration must preserve which hooks are fail-open and which are fail-closed. A naive `hook-shim.sh <name>` used under the existing `|| true` convention would silently disable the cost-control wall. The ADR does not define a manifest of hook criticality.

   Superior alternative: hook declarations should call `node hook-shim.mjs route-dispatch --mode=blocking` for blocking hooks and `--mode=advisory` for fail-open hooks, with tests proving exit 2 survives only for the intended matchers.

16. **MAJOR — The proposed hook shim is POSIX-only and omits `.mjs` hooks.**

   ADR-0023 describes `hook-shim.sh <name>` resolving `current/plugin/scripts/<name>`. Current hooks include shell scripts and a Node script (`the former learning flusher (deleted 2026-10-12)`, `hooks.json:99`). Some hook names include extensions in declarations, some ADR prose examples omit them. Without a typed script manifest, the shim will either hard-code extensions or fail on non-shell hooks.

   Superior alternative: use a Node shim with a small dispatch table: hook id -> relative executable, interpreter, advisory/blocking mode, timeout expectations, and minimum body version. Node is already required for MCP and installer.

17. **MAJOR — `forge-update.mjs` is not cross-platform even though the product claims Windows support.**

   The installer supports PowerShell `Expand-Archive` fallback (`install.mjs:361-394`), but the bundled updater uses `execFileSync('unzip', ...)` only (`forge-update.mjs:191`). On native Windows, scheduled or manual `forge-update.mjs --apply` will fail even if the original install worked. This directly violates the ADR’s install-path convergence claim.

   Superior alternative: share one extraction implementation between installer and updater, or move update application entirely into `bin/install.mjs`/`scripts/update-apply.mjs` and stop shipping a divergent updater inside the KB.

18. **MAJOR — Release gating does not know the restart contract exists.**

   ADR-0023 requires a manifest field `requiresRestart: true` only for boot-frozen declaration changes. `plugin/.claude-plugin/plugin.json` has no such field. `scripts/release.mjs` only runs version sync, tests, publish, and `verify-channels` (`release.mjs:49-96`). There is no diff classifier for hooks, skills, commands, MCP tool names, shim/proxy code, or manifest compatibility. This means the “honest restart contract” will immediately drift.

   Superior alternative: generate a release manifest during release. Gate it by diffing the previous release: changes under `plugin/hooks/`, `plugin/skills/`, `plugin/commands/`, `.mcp.json`, `plugin/mcp/server.mjs`, and hook shim/proxy files must either set `requiresRestart: true` or fail release.

19. **MAJOR — Auto-update from `session-start.sh` is the wrong place to apply a code-body update.**

   Hooks have tight timeouts (`hooks.json:12`, `:22`, etc.). `session-start.sh` already backgrounds network work (`session-start.sh:218-223`, `:233-236`) and writes notices to fd 3 after the main hook output. If `session-start` also drives `update-apply.mjs` as the ADR says, it either races Claude Code hook timeout/lifecycle or must background a writer that outlives the hook with no lock and weak observability.

   Superior alternative: session-start should only enqueue a check or trigger a detached updater with locking and durable logs. The updater should not be coupled to hook stdout injection.

20. **MAJOR — Health gates are too shallow for a code payload that is executed as hooks and MCP.**

   ADR-0023 proposes `bash -n`, `node --check`, and one CLI smoke query. `bash -n` does not prove runtime dependencies, env assumptions, hook JSON parsing, advisory vs blocking output shape, or Windows behavior. `node --check` does not catch missing imports. One CLI query does not prove MCP initialization, `tools/list`, `tools/call`, duplicate request ids, or reload.

   Superior alternative: health gate the candidate with the same integration battery users exercise: parse hooks, execute each hook with representative Claude hook JSON, assert exit semantics, start the stable MCP server against the candidate, run `initialize`, `tools/list`, and one `tools/call`, then kill/reload and assert the client connection survives.

21. **MAJOR — Post-flip rollback is claimed but not designed for the hard failure cases.**

   ADR-0023 says “A failed post-flip probe = auto-flip back.” It does not say what happens if the process crashes after flip before writing `.reload-stamp`, if rollback flip fails, if both previous and new versions fail, or if another updater flips again between probe and rollback. Current `kb/forge-update.mjs` merely leaves a backup on guard failure and tells the user to restore it (`forge-update.mjs:207-208`); there is no automatic restore.

   Superior alternative: model update states explicitly: `idle`, `candidate-ready`, `active`, `rollback-needed`, `rollback-complete`. Persist a transaction record before the flip. On every shim/proxy start, detect incomplete transactions and recover deterministically under lock.

22. **MAJOR — The installer fallback can clobber the live KB while the MCP server is reading it.**

   `runUpdate()` falls back from `forge-update.mjs --apply` to running the installer with `--force` (`install.mjs:923-927`). That code path extracts directly into the live `cacheDir` and removes entries (`install.mjs:382`, `:405`). A running MCP child launched from `~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs` may be importing files, reading passages, or writing health state at the same time.

   Superior alternative: all updater paths, including fallback, must install to an inactive version directory and then flip an active pointer. No code path should ever `unzip -o` into the live KB.

23. **MAJOR — The ADR does not define cleanup/retention, so the immutable version store will grow without bound.**

   The ADR says keep previous for rollback, but does not define retention count, disk budget, GC lock rules, or protection for versions still used by active MCP workers. This bundle is large; unbounded `versions/<v>` directories will matter quickly.

   Superior alternative: retain active + previous + last-known-good + any version with a live lease file. GC only under update lock and never delete a version whose lease heartbeat is fresh.

24. **MAJOR — The “dev mode current -> checkout” path can bypass all gates.**

   ADR-0023 allows `current` to point at a git checkout. That is useful for maintainers, but it also means hooks can execute unvalidated working-tree code and MCP can hot-load code whose dependencies are not installed. The ADR does not isolate dev mode from normal users or require an explicit marker.

   Superior alternative: make dev mode opt-in via `~/.cache/ruvnet-brain/dev.json`, require the target to be the current repo root with a marker file, print dev mode in the banner, and never let auto-update overwrite or flip away from it.

25. **MINOR — The ADR’s fallback-to-plugin-dir story can mask a broken spine indefinitely.**

   Falling back to `${CLAUDE_PLUGIN_ROOT}` if the spine is missing sounds fail-safe, but it can silently pin users to an old boot version and hide update corruption. The current session banner already cares about truthful running version (`session-start.sh:274-293`); a silent fallback would undercut that.

   Superior alternative: fallback only for first install or explicitly marked recovery. Otherwise emit a loud hook/MCP health warning that `current` is missing and name the frozen fallback version.

26. **MINOR — The reload stamp is under-specified and can be missed or spuriously triggered.**

   ADR-0023 uses `~/.cache/ruvnet-brain/.reload-stamp`, but does not define contents, atomic write, monotonicity, or relation to active version. Timestamp files can miss events on coarse filesystems or produce false positives from partial writes.

   Superior alternative: make the stamp the same atomic `active.json` pointer. Include generation number and digest. The proxy compares parsed generation, not file mtime.

27. **MINOR — The release process publishes before full live verification.**

   `scripts/release.mjs --publish` pushes, publishes, updates the npm dist-tag, then runs `verify-channels` (`release.mjs:66-96`). If live verification fails after publish, users can already consume the broken release. This is not new in ADR-0023, but a stable-spine architecture raises the stakes because update adoption becomes automatic.

   Superior alternative: split release into “stage artifact and verify by immutable URL” before moving `latest`/active manifest, then promote the signed manifest pointer last.

28. **MINOR — The ADR does not name ownership boundaries for code updates vs KB updates.**

   It says KB data stays on its own track, but actual bundle tooling still packages code and KB together (`build-bundle.mjs:197-230`). Without two manifests and two active pointers, a KB refresh can change executable behavior and a code refresh can change knowledge state.

   Superior alternative: maintain separate signed manifests: `code-manifest.json` and `kb-manifest.json`. The code manifest declares hook/MCP compatibility; the KB manifest declares data schema compatibility. The active pointer binds a compatible pair.

29. **MINOR — Tests currently encode sequential MCP behavior and would not catch hot-swap bugs.**

   `plugin/test/run-tests.mjs` says requests are sent sequentially, “the way a real MCP client behaves” according to its comment. ADR-0023’s proxy would need tests for duplicate ids, concurrent requests, child restart during request, notifications, and reload boundaries. Existing tests will give false confidence.

   Superior alternative: add a protocol test harness with a fake child MCP server and scripted JSON-RPC traffic. Assert the proxy never leaks the replayed initialize response and never breaks client id continuity.

30. **MINOR — The hook shell assumes `/bin/bash`, while several scripts claim `/bin/sh`.**

   `session-start.sh` declares `#!/bin/sh`, but hooks execute it with `/bin/bash` (`hooks.json:11`, `:21`). A stable shim should not perpetuate this ambiguity. The health gate should validate under the actual interpreter used in the hook declaration, not merely `bash -n every hook script`.

   Superior alternative: each hook entry in the dispatch table should name its interpreter. Validate with that interpreter and with representative stdin.

## Simpler Architecture I Would Prefer

The strictly better version is a stable Node shell, not a symlink-centered shell:

1. Freeze only these boot declarations in the Claude Code plugin: hook commands call `node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs <hook-id>`, and `.mcp.json` calls `node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`.
2. Store active state in `~/.cache/ruvnet-brain/active.json`, atomically written by temp-file + rename. It names `codeRoot`, `kbRoot`, generation, version, digest, previous, compatibility range, and signed manifest receipt.
3. Install code to immutable `~/.cache/ruvnet-brain/versions/<digest>/`. Install KB data to immutable `~/.cache/ruvnet-brain/kb-versions/<digest>/` or keep `kb/current-data` as a separate pointer. Never mutate the active tree.
4. Use one updater implementation for install, manual update, session-triggered update, and nightly update. It must acquire a lock, download, verify signed manifest and artifact, extract to staging, run health gates, rename staging to immutable final, then update `active.json`.
5. Make the MCP server stable and fixed-schema. On `search_ruvnet`, it reads `active.json` and delegates to the active implementation. If keeping a warm worker is required, the worker should speak a private request protocol; do not replay external MCP handshakes.
6. Treat restart truthfully: any change to `hooks.json`, `.mcp.json`, command/skill declarations, hook shim, or stable MCP server requires a restart. Everything else is body code/data and can update behind `active.json`.

This keeps the good idea from ADR-0023, removes Windows symlink dependency, avoids MCP handshake replay, gives crash consistency, and creates one control plane that release gates can actually test.

tokens used
112,752
The sandbox rejected the write to `docs/adr/0023-gpt56-redteam.md` because this session is read-only, so here is the full review content to stdout.

```markdown
# ADR-0023 Red-Team Review — GPT-5.6

Reviewer stance: adversarial architecture review of `docs/adr/0023-intelligent-updating-stable-spine.md` against the actual code in `plugin/hooks/hooks.json`, `plugin/mcp/server.mjs`, `plugin/scripts/session-start.sh`, `bin/install.mjs`, `scripts/release.mjs`, and the effective bundled updater `kb/forge-update.mjs` because `scripts/forge-update.mjs` is absent.

One thing I agree with: splitting boot-frozen declarations from invoked behavior is the right direction. Everything below is about the places where this ADR either does not implement that split, implements it unsafely, or chooses a more complex mechanism than needed.

1. **BLOCKER — The ADR is marked Accepted, but the described spine is not implemented.**

   `plugin/hooks/hooks.json` still invokes `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh` and `${CLAUDE_PLUGIN_ROOT}/the former learning flusher (deleted 2026-10-12)` directly (`hooks.json:11`, `:21`, `:33`, `:45`, `:55`, `:65`, `:75`, `:87`, `:99`). `plugin/mcp/server.mjs` is still a one-shot `spawn('node', [MCP], { stdio: 'inherit' })` launcher (`server.mjs:41`). `scripts/update-apply.mjs` does not exist. `scripts/forge-update.mjs` does not exist. `scripts/release.mjs` has no gate for hook shim presence, reload-stamp behavior, `requiresRestart`, or spine integrity. As written, the ADR is not an accepted design record for shipped behavior; it is a future implementation sketch with production claims.

   Superior alternative: downgrade the ADR status to Proposed until the shell shims, update engine, proxy semantics, release gates, and failure tests are present. Add release gates that fail if hooks still reference `${CLAUDE_PLUGIN_ROOT}/scripts/` directly or if `scripts/update-apply.mjs` is missing.

2. **BLOCKER — The migration needs one final restart, and the ADR hides that bootstrap cost.**

   The only way existing installed versions can start using a hook shim is for Claude Code to load a new `hooks.json`. Today it has frozen direct commands. A background marketplace update in `session-start.sh:233-236` can stage a new plugin, but this running process will still use the old hook declarations until restart. The ADR says the every-session restart nag is deleted, but the first delivery of the stable spine necessarily requires a one-time restart.

   Superior alternative: define an explicit two-phase migration: release N installs the boot shim and honestly asks for one restart; release N+1 and later can hot-swap body code. The release manifest should carry `migrationRequiresRestart: true` for the first spine release even if later body-only releases do not.

3. **BLOCKER — The code/body split is internally inconsistent: executable MCP code still lives in the KB data directory.**

   ADR-0023 says `versions/` holds code and `kb/` holds data. Actual behavior runs executable code from `~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs` (`server.mjs:19-21`), ships tool code into the bundle (`build-bundle.mjs:204`), and the effective updater overwrites the KB directory including `.mjs` files (`kb/forge-update.mjs:196`). This is exactly the executable-data coupling the ADR claims to remove.

   Superior alternative: move all runtime code into `versions/<codeVersion>/plugin/...` or `versions/<digest>/runtime/...`; keep `kb/` to `.rvf`, passages, metadata, and model/data files only. The stable MCP server should load a fixed tool schema and delegate to code under the active code root while passing `KB_DIR` as data.

4. **BLOCKER — Current install and update paths mutate the live KB in place and are crash-corruptible.**

   `bin/install.mjs` extracts directly into `cacheDir` (`install.mjs:382`), then removes live paths before renaming extracted entries into place (`install.mjs:405-406`). A crash, `unzip` failure after partial writes, power loss, or concurrent reader during this window can leave a missing or mixed-version KB. `kb/forge-update.mjs` backs up the live dir (`forge-update.mjs:195`) and then `copyTree(extractDir, KB_DIR)` overwrites files one by one (`forge-update.mjs:115-120`, `:196`). Its “local files untouched” comments stop being true after line 196.

   Superior alternative: extract to `versions/<digest>.staging`, validate there, rename staging to immutable `versions/<digest>`, then atomically update a tiny pointer. Never unzip or copy over the active tree.

5. **BLOCKER — There is no cross-process lock, so two sessions can race the same spine/update.**

   `session-start.sh` rate-limits by writing a timestamp (`session-start.sh:205-208`) but does not lock. It can launch multiple `claude plugin update` jobs (`session-start.sh:233-236`) across simultaneous Claude windows. `bin/install.mjs` and `kb/forge-update.mjs` mutate the same `~/.cache/ruvnet-brain/kb` path without a lock. ADR-0023 adds a shared `current` symlink but does not define a lock around unpack/health/flip/stamp. Two sessions can download different versions, both validate, then flip in last-writer-wins order. Worse, one can run health checks against a tree another is replacing.

   Superior alternative: use a per-home lock directory such as `~/.cache/ruvnet-brain/.update.lock` acquired with atomic `mkdir`, containing pid/host/start/targetVersion, with stale-lock rules. Every entry point that writes cache state must use the same lock.

6. **BLOCKER — The proposed symlink spine is not a portable Windows design.**

   The current hooks already declare `"_platform": "posix"` and hard-code `/bin/bash` (`hooks.json:3`, `:11`, etc.). ADR-0023 doubles down on a POSIX symlink `current -> versions/<active-version>/`. Native Windows symlink creation often requires Developer Mode or elevated privileges. Directory junctions have different behavior, require absolute targets, and do not behave identically to POSIX symlinks under rename/delete. The installer has Windows accommodations for `.cmd` shims and PowerShell extraction (`install.mjs:136-146`, `:361-394`), but the ADR’s core update primitive is POSIX-biased.

   Superior alternative: do not use a symlink as the control plane. Use an atomically rewritten `active.json` pointer containing `{ codeRoot, kbRoot, version, digest, previous, manifestSig }`, and have stable Node shims read it. This works on macOS, Linux, and Windows without symlink privileges.

7. **BLOCKER — The MCP hot-swap proxy design is much harder than the ADR admits and is not compatible with `stdio: inherit`.**

   The existing MCP launcher cannot cache or replay anything because it wires Claude Code directly to the child with inherited stdio (`server.mjs:40-41`). A real hot-swap proxy must parse JSON-RPC messages, track request ids, understand initialization state, forward stderr separately, handle process death, and multiplex stdin/stdout. ADR-0023 treats this as a small addition to the existing proxy, but the existing proxy is not a proxy in the protocol sense; it is just a process launcher.

   Superior alternative: replace the MCP child-proxy plan with a stable MCP server that declares `search_ruvnet` itself and, on each tool call, dispatches to the active implementation through a private API. If warm models require a worker, keep a worker behind an internal request protocol, not a replayed external MCP handshake.

8. **BLOCKER — Replaying `initialize` risks invalid JSON-RPC/MCP state unless ids and notifications are remapped.**

   MCP initialization is not just one request. The client sends `initialize`, receives a response, then sends an `initialized` notification. If the proxy replays the cached `initialize` with the original client id to a new child, the child will respond with the same id; the proxy must swallow it without confusing pending client requests. It also needs to replay `initialized` if the child expects it. If the client sends batches or overlapping requests, the proxy must not mistake a child response id for a client id after restart.

   Superior alternative: if a child MCP server must remain, allocate proxy-private ids for all child requests, map ids both directions, cache both `initialize` and `initialized`, and test against real MCP traffic including notifications, batches, and concurrent requests. This is not a 15-line proxy change.

9. **BLOCKER — The ADR’s “between requests” swap rule ignores concurrent requests and streaming.**

   It says “Never swap mid-request; queue and swap between requests.” That only works if the client has at most one in-flight request. MCP/JSON-RPC permits concurrent requests and notifications; even if Claude Code is currently sequential, the plugin should not encode that assumption into an architecture whose purpose is resilience. A reload stamp observed while one request is pending must defer until all pending ids drain. Child death mid-request must return a JSON-RPC error for that id, not exit the parent process.

   Superior alternative: explicit state machine: `activeGeneration`, `pendingRequestCount`, `reloadPending`, `draining`, `spawnCandidate`, `healthProbeCandidate`, `promoteCandidate`. No swap while `pendingRequestCount > 0`; no parent exit for child crash unless boot initialization cannot ever succeed.

10. **MAJOR — The ADR claims verify-before-flip, but current signature policy still allows unsigned extraction.**

   `bin/install.mjs` has a good embedded Ed25519 verifier, but `SIGNING_REQUIRED = false` and missing signatures warn-and-proceed (`install.mjs:1902-1912`). There is also a user-facing `--no-verify` override. The effective updater has a legacy bootstrap branch that applies one unsigned update when verifier/key are absent (`forge-update.mjs:183-189`). That contradicts the ADR’s “SHA-256 verify” safety claim.

   Superior alternative: make signed manifest and signed bundle mandatory before enabling unattended update. For legacy installs without a verifier/key, refuse `forge-update.mjs --apply` and instruct the user to update via the npm installer, where the trust root is embedded in the package code.

11. **MAJOR — SHA-256 alone is not a supply-chain trust boundary.**

   ADR-0023 says “fetch manifest -> download -> SHA-256 verify.” If the manifest and bundle come from the same GitHub release/channel and the manifest is not signed by a pinned key, a compromised release can publish a matching malicious hash. The code already understands this better than the ADR: `install.mjs` and `build-bundle.mjs` include Ed25519 verifier/key handling (`install.mjs:26-39`, `build-bundle.mjs:221-230`). The ADR regresses the security model by naming hash verification but not signature verification as a hard requirement.

   Superior alternative: require a signed manifest whose public key is shipped in the boot shell. The manifest should bind version, digest, artifact URL, tool declarations, `requiresRestart`, and compatibility range.

12. **MAJOR — Archive extraction is not fenced against path traversal or unsafe entries.**

   Both `bin/install.mjs` and `kb/forge-update.mjs` delegate extraction to `unzip`/`Expand-Archive` without pre-validating archive entries (`install.mjs:382`, `:391-394`; `forge-update.mjs:191`). Signature verification lowers risk only when signatures are mandatory and trusted. Today they are not mandatory in the installer and not available for legacy auto-apply. A malicious archive with `../`, absolute paths, symlinks, or odd permissions is an avoidable footgun.

   Superior alternative: preflight the zip central directory before extraction, reject absolute paths, parent traversal, device files, and symlinks, and extract into a private staging dir only after signature verification.

13. **MAJOR — `current` as an executable pointer in a user-writable cache is a TOCTOU execution surface.**

   The hook shim would execute `~/.cache/ruvnet-brain/current/plugin/scripts/<name>`. Any process running as the user can rewrite `current` to arbitrary code between shim path resolution and `exec`, or can replace the target after a check unless the shim verifies the resolved realpath and signed manifest immediately before execution. Same-user compromise is not usually defended against, but this plugin explicitly runs code that changes model behavior, and the ADR is making the cache path a code root.

   Superior alternative: the shim should read `active.json`, resolve `codeRoot`, require it to be under `~/.cache/ruvnet-brain/versions/`, verify the version manifest signature or a stored digest receipt, then exec by file descriptor where possible or at least avoid a separate check/use gap. Also require parent directory permissions not group/world-writable.

14. **MAJOR — Hook hot-swap can make one Claude turn internally inconsistent.**

   Hooks fire at `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `SessionEnd`. If `current` flips mid-turn, grounding can come from version A, a pre-tool policy gate from version B, and learning flush from version C. The ADR treats “updates the moment current flips” as purely good, but multi-hook workflows need epoch consistency or explicit forward-compatible contracts.

   Superior alternative: stamp a session or turn epoch. At SessionStart, write the active version into a session env/file and have all hooks for that session use that epoch by default; allow explicit hot mode only for stateless hooks. If mid-session hot updates are required, define compatibility contracts for hook stdout formats and blocking exit codes.

15. **MAJOR — The route-dispatch blocking contract is fragile under a generic shim.**

   `route-dispatch.sh` deliberately exits 2 and is not guarded by `|| true` (`hooks.json:55`). The ADR says `exec` preserves exit codes, but the actual hook migration must preserve which hooks are fail-open and which are fail-closed. A naive `hook-shim.sh <name>` used under the existing `|| true` convention would silently disable the cost-control wall. The ADR does not define a manifest of hook criticality.

   Superior alternative: hook declarations should call `node hook-shim.mjs route-dispatch --mode=blocking` for blocking hooks and `--mode=advisory` for fail-open hooks, with tests proving exit 2 survives only for the intended matchers.

16. **MAJOR — The proposed hook shim is POSIX-only and omits `.mjs` hooks.**

   ADR-0023 describes `hook-shim.sh <name>` resolving `current/plugin/scripts/<name>`. Current hooks include shell scripts and a Node script (`the former learning flusher (deleted 2026-10-12)`, `hooks.json:99`). Some hook names include extensions in declarations, some ADR prose examples omit them. Without a typed script manifest, the shim will either hard-code extensions or fail on non-shell hooks.

   Superior alternative: use a Node shim with a small dispatch table: hook id -> relative executable, interpreter, advisory/blocking mode, timeout expectations, and minimum body version. Node is already required for MCP and installer.

17. **MAJOR — `forge-update.mjs` is not cross-platform even though the product claims Windows support.**

   The installer supports PowerShell `Expand-Archive` fallback (`install.mjs:361-394`), but the bundled updater uses `execFileSync('unzip', ...)` only (`forge-update.mjs:191`). On native Windows, scheduled or manual `forge-update.mjs --apply` will fail even if the original install worked. This directly violates the ADR’s install-path convergence claim.

   Superior alternative: share one extraction implementation between installer and updater, or move update application entirely into `bin/install.mjs`/`scripts/update-apply.mjs` and stop shipping a divergent updater inside the KB.

18. **MAJOR — Release gating does not know the restart contract exists.**

   ADR-0023 requires a manifest field `requiresRestart: true` only for boot-frozen declaration changes. `plugin/.claude-plugin/plugin.json` has no such field. `scripts/release.mjs` only runs version sync, tests, publish, and `verify-channels` (`release.mjs:49-96`). There is no diff classifier for hooks, skills, commands, MCP tool names, shim/proxy code, or manifest compatibility. This means the “honest restart contract” will immediately drift.

   Superior alternative: generate a release manifest during release. Gate it by diffing the previous release: changes under `plugin/hooks/`, `plugin/skills/`, `plugin/commands/`, `.mcp.json`, `plugin/mcp/server.mjs`, and hook shim/proxy files must either set `requiresRestart: true` or fail release.

19. **MAJOR — Auto-update from `session-start.sh` is the wrong place to apply a code-body update.**

   Hooks have tight timeouts (`hooks.json:12`, `:22`, etc.). `session-start.sh` already backgrounds network work (`session-start.sh:218-223`, `:233-236`) and writes notices to fd 3 after the main hook output. If `session-start` also drives `update-apply.mjs` as the ADR says, it either races Claude Code hook timeout/lifecycle or must background a writer that outlives the hook with no lock and weak observability.

   Superior alternative: session-start should only enqueue a check or trigger a detached updater with locking and durable logs. The updater should not be coupled to hook stdout injection.

20. **MAJOR — Health gates are too shallow for a code payload that is executed as hooks and MCP.**

   ADR-0023 proposes `bash -n`, `node --check`, and one CLI smoke query. `bash -n` does not prove runtime dependencies, env assumptions, hook JSON parsing, advisory vs blocking output shape, or Windows behavior. `node --check` does not catch missing imports. One CLI query does not prove MCP initialization, `tools/list`, `tools/call`, duplicate request ids, or reload.

   Superior alternative: health gate the candidate with the same integration battery users exercise: parse hooks, execute each hook with representative Claude hook JSON, assert exit semantics, start the stable MCP server against the candidate, run `initialize`, `tools/list`, and one `tools/call`, then kill/reload and assert the client connection survives.

21. **MAJOR — Post-flip rollback is claimed but not designed for the hard failure cases.**

   ADR-0023 says “A failed post-flip probe = auto-flip back.” It does not say what happens if the process crashes after flip before writing `.reload-stamp`, if rollback flip fails, if both previous and new versions fail, or if another updater flips again between probe and rollback. Current `kb/forge-update.mjs` merely leaves a backup on guard failure and tells the user to restore it (`forge-update.mjs:207-208`); there is no automatic restore.

   Superior alternative: model update states explicitly: `idle`, `candidate-ready`, `active`, `rollback-needed`, `rollback-complete`. Persist a transaction record before the flip. On every shim/proxy start, detect incomplete transactions and recover deterministically under lock.

22. **MAJOR — The installer fallback can clobber the live KB while the MCP server is reading it.**

   `runUpdate()` falls back from `forge-update.mjs --apply` to running the installer with `--force` (`install.mjs:923-927`). That code path extracts directly into the live `cacheDir` and removes entries (`install.mjs:382`, `:405`). A running MCP child launched from `~/.cache/ruvnet-brain/kb/forge-mcp-all.mjs` may be importing files, reading passages, or writing health state at the same time.

   Superior alternative: all updater paths, including fallback, must install to an inactive version directory and then flip an active pointer. No code path should ever `unzip -o` into the live KB.

23. **MAJOR — The ADR does not define cleanup/retention, so the immutable version store will grow without bound.**

   The ADR says keep previous for rollback, but does not define retention count, disk budget, GC lock rules, or protection for versions still used by active MCP workers. This bundle is large; unbounded `versions/<v>` directories will matter quickly.

   Superior alternative: retain active + previous + last-known-good + any version with a live lease file. GC only under update lock and never delete a version whose lease heartbeat is fresh.

24. **MAJOR — The “dev mode current -> checkout” path can bypass all gates.**

   ADR-0023 allows `current` to point at a git checkout. That is useful for maintainers, but it also means hooks can execute unvalidated working-tree code and MCP can hot-load code whose dependencies are not installed. The ADR does not isolate dev mode from normal users or require an explicit marker.

   Superior alternative: make dev mode opt-in via `~/.cache/ruvnet-brain/dev.json`, require the target to be the current repo root with a marker file, print dev mode in the banner, and never let auto-update overwrite or flip away from it.

25. **MINOR — The ADR’s fallback-to-plugin-dir story can mask a broken spine indefinitely.**

   Falling back to `${CLAUDE_PLUGIN_ROOT}` if the spine is missing sounds fail-safe, but it can silently pin users to an old boot version and hide update corruption. The current session banner already cares about truthful running version (`session-start.sh:274-293`); a silent fallback would undercut that.

   Superior alternative: fallback only for first install or explicitly marked recovery. Otherwise emit a loud hook/MCP health warning that `current` is missing and name the frozen fallback version.

26. **MINOR — The reload stamp is under-specified and can be missed or spuriously triggered.**

   ADR-0023 uses `~/.cache/ruvnet-brain/.reload-stamp`, but does not define contents, atomic write, monotonicity, or relation to active version. Timestamp files can miss events on coarse filesystems or produce false positives from partial writes.

   Superior alternative: make the stamp the same atomic `active.json` pointer. Include generation number and digest. The proxy compares parsed generation, not file mtime.

27. **MINOR — The release process publishes before full live verification.**

   `scripts/release.mjs --publish` pushes, publishes, updates the npm dist-tag, then runs `verify-channels` (`release.mjs:66-96`). If live verification fails after publish, users can already consume the broken release. This is not new in ADR-0023, but a stable-spine architecture raises the stakes because update adoption becomes automatic.

   Superior alternative: split release into “stage artifact and verify by immutable URL” before moving `latest`/active manifest, then promote the signed manifest pointer last.

28. **MINOR — The ADR does not name ownership boundaries for code updates vs KB updates.**

   It says KB data stays on its own track, but actual bundle tooling still packages code and KB together (`build-bundle.mjs:197-230`). Without two manifests and two active pointers, a KB refresh can change executable behavior and a code refresh can change knowledge state.

   Superior alternative: maintain separate signed manifests: `code-manifest.json` and `kb-manifest.json`. The code manifest declares hook/MCP compatibility; the KB manifest declares data schema compatibility. The active pointer binds a compatible pair.

29. **MINOR — Tests currently encode sequential MCP behavior and would not catch hot-swap bugs.**

   `plugin/test/run-tests.mjs` says requests are sent sequentially, “the way a real MCP client behaves” according to its comment. ADR-0023’s proxy would need tests for duplicate ids, concurrent requests, child restart during request, notifications, and reload boundaries. Existing tests will give false confidence.

   Superior alternative: add a protocol test harness with a fake child MCP server and scripted JSON-RPC traffic. Assert the proxy never leaks the replayed initialize response and never breaks client id continuity.

30. **MINOR — The hook shell assumes `/bin/bash`, while several scripts claim `/bin/sh`.**

   `session-start.sh` declares `#!/bin/sh`, but hooks execute it with `/bin/bash` (`hooks.json:11`, `:21`). A stable shim should not perpetuate this ambiguity. The health gate should validate under the actual interpreter used in the hook declaration, not merely `bash -n every hook script`.

   Superior alternative: each hook entry in the dispatch table should name its interpreter. Validate with that interpreter and with representative stdin.

## Simpler Architecture I Would Prefer

The strictly better version is a stable Node shell, not a symlink-centered shell:

1. Freeze only these boot declarations in the Claude Code plugin: hook commands call `node ${CLAUDE_PLUGIN_ROOT}/scripts/hook-shim.mjs <hook-id>`, and `.mcp.json` calls `node ${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs`.
2. Store active state in `~/.cache/ruvnet-brain/active.json`, atomically written by temp-file + rename. It names `codeRoot`, `kbRoot`, generation, version, digest, previous, compatibility range, and signed manifest receipt.
3. Install code to immutable `~/.cache/ruvnet-brain/versions/<digest>/`. Install KB data to immutable `~/.cache/ruvnet-brain/kb-versions/<digest>/` or keep `kb/current-data` as a separate pointer. Never mutate the active tree.
4. Use one updater implementation for install, manual update, session-triggered update, and nightly update. It must acquire a lock, download, verify signed manifest and artifact, extract to staging, run health gates, rename staging to immutable final, then update `active.json`.
5. Make the MCP server stable and fixed-schema. On `search_ruvnet`, it reads `active.json` and delegates to the active implementation. If keeping a warm worker is required, the worker should speak a private request protocol; do not replay external MCP handshakes.
6. Treat restart truthfully: any change to `hooks.json`, `.mcp.json`, command/skill declarations, hook shim, or stable MCP server requires a restart. Everything else is body code/data and can update behind `active.json`.

This keeps the good idea from ADR-0023, removes Windows symlink dependency, avoids MCP handshake replay, gives crash consistency, and creates one control plane that release gates can actually test.

