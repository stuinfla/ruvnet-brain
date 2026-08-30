Updated: 2026-08-22 12:15:00 EDT | Version 1.1.0
Created: 2026-07-22 11:05:00 EDT

# The Architecture Map — what the pieces ARE, and what you lose if you take only some

## Why this document exists

A power user told the owner, and this is close to verbatim:

> "I can't use your stuff because it has hooks and this and that. I just loaded the brain into my
> RuVector Brain and I don't get the rest of it."

He is not confused. He is **correct** — he took one piece, and the other pieces are the ones that do
the work he has not seen. Nobody could tell him which ones, or what they were worth, because nobody
had written it down. This file is that answer.

It exists because of a specific, dated failure of our own: on 2026-07-22 two reviewers found that
`enforcement: block` in the lesson store could not block — the gate exited 1 where the harness
requires 2, wrote its reason to stdout where exit-2 reads stderr, and the dispatcher discarded the
code with `|| true`. Three layers agreed with each other and all three were wrong, for days, because
**no document said what each layer was supposed to do**, so no reader could notice that one of them
didn't. A system with nine moving parts and no map is a system whose parts can quietly stop working.

Two rules govern everything below.

**Every number here was derived by running something, today, on a real machine.** Not recalled. Each
one carries the command that produced it, so you can re-derive it or catch it going stale. Where a
thing could not be measured, it says so — `unknown` is a first-class answer and it never renders as
`off`. (That rule was written into `scripts/capability-registry.mjs` after a live probe of this
repo's own memory store returned "unable to open database file" from losing a race with a concurrent
writer; 90 seconds later the same query returned 1,201 healthy memories. A naive
`healthy ? 'on' : 'off'` would have told the owner to fix a system that was already working.)

**Nothing here is a recommendation to install more.** Several of the most useful configurations in
the matrix at the end involve installing *less*. If "brain only" is the right shape for how you
work, this document's job is to tell you precisely what that costs you so you can decide — not to
talk you out of it.

---

## Provenance — how to re-derive every number in this file

```bash
# corpus: repos built, catalogued, org total
node -e "console.log(JSON.parse(require('fs').readFileSync('data/manifest.json')).coverage)"

# corpus: stores on disk, passages, bytes
ls ~/.cache/ruvnet-brain/kb/*.big.rvf | wc -l          # big (768-dim) stores
ls ~/.cache/ruvnet-brain/kb/*.rvf | wc -l              # canonical stores plus any legacy files pending cleanup
cat ~/.cache/ruvnet-brain/kb/*.passages.jsonl | wc -l
du -sh ~/.cache/ruvnet-brain

# hooks: what actually fires, and what each invocation runs
cat plugin/hooks/hooks.json
sed -n '37,48p' plugin/scripts/hook-shim.mjs          # the typed dispatch table

# what the hooks have actually cost you in context (real bytes, not estimates)
node scripts/token-report.mjs                          # or read ~/.cache/ruvnet-brain/token-ledger.jsonl

# what the gates have actually refused
cat ~/.cache/ruvnet-brain/gate-blocks.jsonl

# lessons, capabilities
node scripts/lesson-ratify.mjs --list
node scripts/capability-registry.mjs                   # 11 rows, on/off/unknown, per scope
```

Measurements below were taken **2026-07-22 between 10:20 and 11:00 EDT** on an M3 Max, against a
corpus built 2026-07-21. Your machine will differ; the commands are the point, not the digits.

---

## The nine pieces, at a glance

| # | Piece | Where it lives | Optional? | One line |
|---|-------|----------------|-----------|----------|
| 1 | **KB corpus** | `~/.cache/ruvnet-brain/kb/*.rvf` | No — everything else reads it | 69 rUv repos as searchable vector stores + full passage text |
| 2 | **MCP server** | `plugin/mcp/server.mjs` → `kb/forge-mcp-all.mjs` | Yes | Puts one tool, `search_ruvnet`, inside Claude Code |
| 3 | **Hooks** | `plugin/hooks/hooks.json` (10 scripts, 14 invocations) | Yes, individually | Fire on session start, every prompt, before/after tools, on stop |
| 4 | **Stable spine** | `~/.cache/ruvnet-brain/versions/` + `active.json` | Yes | Lets hook behavior update without restarting Claude Code |
| 5 | **Console** | `console/*` + `scripts/onboarding-console.mjs` | Yes | Local page: what's installed, what's dormant, one-click reversible fixes |
| 6 | **Capability registry** | `scripts/capability-registry.mjs` | Yes | 11-row audit of what you own and whether it's switched on |
| 7 | **Lesson store** | `~/.config/ruvnet-brain/lessons.json` | Yes | Your recorded corrections, replayed at the moment they apply |
| 8 | **Evergreen + Dream evaluation** | `com.ruvnet.brain-update` + Dream Machine | Yes | Updates installed bytes and evaluates repo changes without writing the primary checkout |
| 9 | **Commands & skills** | `plugin/commands/` (4), `plugin/skills/` (5) | Yes | `/rvbc`, `/configure`, and the behavioral skills |

Pieces 2–9 are all genuinely optional. Piece 1 is the substrate: remove it and the MCP server still
starts, still registers its tool, and returns an honest install-guidance error instead of vanishing
(`plugin/mcp/server.mjs:150`) — deliberate, because a tool that disappears looks like a bug in
Claude Code rather than a missing bundle.

---

## 1 · The KB corpus

**What it is.** 69 of rUv's repositories, walked file-by-file, chunked into passages, embedded, and
written to RVF vector stores that sit next to the original text.

**What it gives you.** Answers about the rUv ecosystem that come from rUv's actual source rather than
from a model's training prior. Each hit is a whole document labeled `repo/path`, so you can check it.

**Measured, 2026-07-22:**

| Fact | Value | Derived from |
|---|---|---|
| Repos built | 69 | `data/manifest.json` → `coverage.built` |
| Repos catalogued but not built | 123 pending, of ~248 in the org | same file |
| Vector stores on disk | 136 (69 × `big`, 67 × small) | `ls ~/.cache/ruvnet-brain/kb/*.rvf \| wc -l` |
| Passages | 160,238 | `cat kb/*.big.passages.jsonl \| wc -l` |
| Disk after install | 2.7 GB | `du -sh ~/.cache/ruvnet-brain` |
| Download | 843 MB | `dist/ruvnet-brain.zip` = 842,886,182 bytes |

Two embedders, on purpose, from the same passages — verified by reading the sidecars, not recalled:

- `*.big.rvf` — `Xenova/bge-base-en-v1.5`, 768-dim, CLS pooling, **asymmetric** (queries get the
  prefix `"Represent this sentence for searching relevant passages: "`, passages do not). This is the
  sharp one; retrieval auto-selects it when present.
- `*.rvf` — `Xenova/all-MiniLM-L6-v2`, 384-dim, mean pooling, **symmetric**. The edge/Seed-compatible
  variant, for machines and runtimes that can't carry the big model.

**What it costs.** 2.7 GB of disk and an 843 MB download. Zero runtime cost when nothing queries it —
it is inert files. No server, no daemon, no port.

**What you lose without it.** Everything. This is the substrate; pieces 2–8 are ways of getting at it
or keeping it honest.

**The honest caveat, and it ships in-band.** The corpus is a *snapshot*, not a live mirror. Every
`search_ruvnet` response carries its own staleness line, computed from the real file mtimes of the
stores that were queried (`kb/forge-mcp-all.mjs:170`). That exists because of issue #31 (Jan Lafko):
a model quoted a version out of the corpus as though the corpus were live. For anything about
"latest" or a dist-tag, check the live registry — the tool now says so on every single response
rather than leaving you to remember it.

---

## 2 · The MCP server — `search_ruvnet`

**What it is.** Two processes. `plugin/mcp/server.mjs` is a thin protocol shell that Claude Code
spawns and talks to; it supervises a warm child (`kb/forge-mcp-all.mjs`) that holds the models and
does the retrieval. One tool is exposed: `search_ruvnet({ query, k = 6 })`.

**What it gives you.** The model can consult 69 repos mid-answer without you doing anything. A query
fans out to *every* store, pools the candidates, re-scores the whole pool in one cross-encoder pass
so hits from different repos are comparable, and returns the globally best whole documents.

**Why the shell/child split exists at all** (ADR-023): v1 was a launcher that spawned the brain with
`stdio: 'inherit'` and got out of the way — which froze retrieval behavior at session start, because
Claude Code spawns the MCP server once. The shell now owns the client connection permanently and hot-
swaps the child between requests (never mid-flight) when the code underneath changes. You get updated
retrieval without restarting your editor.

**Measured cost, 2026-07-22** — three real `tools/call` round-trips through the actual MCP protocol,
`k=6`, warm model cache:

| Call | Latency | Response |
|---|---|---|
| "how does agenticow branch memory" | 122.3 s | 20,020 chars (~5.0K tokens) |
| "what is the RVF witness chain" | 91.4 s | 43,066 chars (~10.8K tokens) |
| "ruflo swarm init topology" | 151.4 s | 7,557 chars (~1.9K tokens) |

**Read that table honestly: a `search_ruvnet` call is a 1.5–2.5 minute operation on this machine, and
it can return 10K tokens.** That is the real price of fanning out across 69 stores and re-ranking the
pool with a cross-encoder. It is not a fast autocomplete lookup and should not be sold as one. It is
worth it when the alternative is a confident wrong answer about a tool that already exists — the
failure mode this whole project was built after — and it is not worth it for a question you could
answer by reading one file.

By comparison, the same retrieval via the CLI (`node kb/forge-ask-all.mjs --q "…" --k 2`) took
**110 seconds wall** for one question, because each invocation reloads both ONNX models from scratch.
The MCP server's warm child is what amortizes that away across a session.

**What it costs beyond latency.** One resident Node process holding the embedding models (~0.5 GB,
which is why `forge-mcp-all.mjs:227` carries an orphan guard that exits if it gets re-parented to PID
1 — force-quitting Claude Code used to leave these resident for hours). One JSON line appended per
call to `~/.cache/ruvnet-brain/token-ledger.jsonl`. No network. No project files touched.

> **A fixed bug worth knowing about, because it is the class of thing this piece could get wrong
> again.** The token meter originally wrote to `process.cwd()/.ruvnet-brain/` — and an MCP server
> inherits its cwd from the Claude Code session, so it scattered hidden directories through users'
> project trees. Issue #36 (mamd69) reported this against two shell hooks; the MCP server had the
> identical bug and was *not* in the report. Fixing only what was reported would have left the
> symptom alive and made the fix look wrong. All three now write user-level only, keeping cwd as a
> data *field* so per-project analysis survives without writing into a project.

**What you lose without it.** The corpus stops being reachable from inside a conversation. You keep
every byte of it and you can still query it by hand:

```bash
cd ~/.cache/ruvnet-brain/kb
node forge-ask-all.mjs --dir . --q "your question" --k 3
```

...at ~110 s per question, in a separate terminal, with the result pasted back in by you. **That is
the exact configuration the power user described**, and the specific thing he is missing is not
"proactivity" — it is that the model cannot consult 69 repos *during* an answer, so it answers rUv
questions from its training prior, which is where every "we'll have to build that ourselves"
conclusion in this project's history came from.

---

## 3 · The hooks

This is the piece people mean when they say "hooks and this and that", so it gets enumerated rather
than summarized. **Everything below is one file you can read in full: `plugin/hooks/hooks.json`.**

Six Claude Code events, 14 invocations, 10 distinct scripts. All but two route through
`plugin/scripts/hook-shim.mjs`, which resolves the active code generation per invocation (see §4).

| Event | Script | Mode | What it actually does |
|---|---|---|---|
| SessionStart (startup, resume) | `session-start.sh` | advisory | Prints a confidence line so you know the brain is on; runs 4 pure-filesystem health checks (<5 ms, no node, no network): cache dir missing? no `.rvf` at all? reader `node_modules` gone? last real search failed? Injects the capability playbook once per session. |
| UserPromptSubmit | `ground-ruvnet.sh` | advisory | Three independent gates on your prompt text: **RUVNET** (you named the stack → ground before asserting), **DRIFT** (you reached for a classical default → name the rUv replacement), **BUILD** (a build request → apply the playbook). Plus an always-on status footer. |
| UserPromptSubmit | `lesson-hooks.sh assert-fact/recommend-architecture` | advisory | Surfaces your own recorded corrections that apply to stating a fact or proposing an architecture. |
| PreToolUse `Write\|Edit\|Bash` | `hijack-ruvnet.sh` | advisory (`permissionDecision: defer`) | Scans the payload for four categories of classical default — vector stores (`pinecone\|pgvector\|chroma\|weaviate\|faiss\|milvus\|qdrant\|hnswlib\|annoy`), paid embedding APIs, RAG/agent frameworks (`langchain\|llamaindex\|autogen\|crewai\|semantic-kernel`), memory glue (`mem0\|zep\|redis+memory`) — and injects the rUv replacement. **Never blocks.** `DECISION="defer"` is on line 12 and a one-word edit makes it `deny`; it ships as `defer` because a false-positive deny would brick legitimate work. |
| PreToolUse `Task\|Agent` | `route-dispatch.sh` | advisory audit | Records declared versus inherited model use. Claude Code 2.1.220 consumes this hook after dispatch, so it always exits 0 and never claims a late refusal. **Opt-in only**: no `~/.claude/model-router/profile.json` → no receipt. |
| PreToolUse `Bash` | `verify-interface.sh` | advisory | Points legacy raw-shell callers to the structured `ruvnet_cli_help` → `ruvnet_cli_run` boundary. It never blocks: issue #48 retired authorization decisions derived from reconstructed shell structure. |
| PreToolUse `Bash` | `design-wall.sh` | **blocking** | Refuses shipping/committing/opening a visual surface without a fresh design-grade stamp. **Repo-scoped since issue #17** — it checks the plugin manifest's own name and stays silent everywhere else, after a plain `git commit` in an unrelated project got blocked demanding a ruvnet-brain ritual. |
| PreToolUse `Write\|Edit\|MultiEdit` / `Bash` | `lesson-hooks.sh write-code` / `mutate-machine` | advisory | Your recorded corrections for writing code / changing the machine. |
| PostToolUse `Write\|Edit\|MultiEdit\|Bash` | `learn-capture.sh` | advisory | Appends one compact step to the session's learning queue: the command *verb* or a file's *basename*. Never content, never full paths, never secrets. |
| SessionEnd | `learn-flush.mjs` | advisory | Drains the queue into the SONA learner. |
| Stop | `continuation-gate.mjs` | advisory | Fires on *stopping*, because stopping is the absence of an action and every other gate needs a tool call to intercept. Checks the work ledger for committed-to items still unfinished. |
| Stop | `lesson-hooks.sh report-status/claim-done` | advisory | Your recorded corrections about reporting progress and claiming done. |

### The measured cost of the hooks, in your context window

From `~/.cache/ruvnet-brain/token-ledger.jsonl` — real byte counts of what was actually injected, not
estimates. Window: **2026-07-21T23:50 → 2026-07-22T10:29 (10 h 39 m), 2,272 entries.**

| | Fires | Median | Mean | p90 | Silent (0 bytes) |
|---|---|---|---|---|---|
| Per prompt (UserPromptSubmit) | 1,986 | 2,520 chars (~630 tok) | 2,519 | 3,771 | 165 (8.3%) |
| Per session (SessionStart) | 286 | 8,488 chars (~2,120 tok) | 8,637 | — | 0 |

Total across the window: **7,472,556 characters ≈ 1.87 M tokens of injected context.**

That is the honest bill, and it is not small. Roughly 630 tokens on a typical prompt and ~2,100 once
per session. In exchange, drift correction and grounding happen without you remembering to ask. If
that trade is wrong for you, the meter has an off switch (`RUVNET_BRAIN_METER=0` stops the
*measuring*; removing individual hook entries from `hooks.json` stops the *injecting*) — and the fact
that the number is measurable at all is the point. Nothing in the Claude Code stack measured this
before; you cannot make an informed trade against a cost nobody prints.

### The measured cost of the blocking gates

From `~/.cache/ruvnet-brain/gate-blocks.jsonl` — **215 refusals over 2.5 days (2026-07-19T21:16 →
2026-07-22T10:29), across 13 different project directories:**

| Gate | Refusals | Shipped in `hooks.json`? |
|---|---|---|
| `route-dispatch` | 142 | Yes — but inert unless you opted into cost routing |
| `verify-interface` | 50 | Yes |
| `ground-before-write` | 11 | **No** — see below |
| `design-wall` | 7 | Yes, ruvnet-brain's own repo only |
| `version-bump-gate` | 5 | **No** — see below |

**Two of those five are not part of what you install, and saying otherwise would be the exact
dishonesty this project exists to kill.** `ground-before-write.sh` is wired in *this machine's*
global `~/.claude/settings.json`; `version-bump-gate.sh` is wired in *this repo's* project-scoped
`.claude/settings.json` (it lived in global settings until 2026-07-14, taxing every Bash command in
34+ projects with a rule that is only true here — a hook belongs in the narrowest scope where it is
true). A fresh install gets **three** blocking gates, one of which is inert without opt-in and one of
which only fires inside this repo. In practice a new user is subject to exactly one:
`verify-interface`.

**What you lose without the hooks.** Concretely:

- **No unprompted grounding.** 1,986 injections in 10.6 hours become zero. The model consults the
  brain only when it independently decides to, which — measured across this project's history — is
  the failure mode, not the fallback.
- **No drift interception.** 4 categories × ~20 regex patterns stop watching your writes. Nothing
  says "you're about to add pgvector; RVF is a single file with SIMD HNSW and no server."
- **No brain-health alarm.** On 2026-07-12 this brain's `node_modules` vanished and every search
  failed *for days, invisibly*, returning empty results that read as "nothing exists." The four
  structural checks in `session-start.sh` exist because of that, and they are the only thing that
  tells you the brain has died rather than gone quiet.
- **No learning capture.** `learn-capture.sh` → `learn-flush.mjs` → SONA is how "the way you work"
  accumulates across all your projects. Without it the learner starves. (It already did: the flush
  originally fired only on a clean `SessionEnd`, so sessions that compacted, crashed, or resumed
  never reached it — the queue grew to 1,884 undelivered events over days while the learner sat at 5
  trajectories, last trained six days earlier. Draining it took the learner to 412/412 in one
  command. ADR-027 added the heartbeat flush.)
- **No lesson replay.** Your corrections stay in a file nobody reads at the moment they'd matter.

---

## 4 · The stable spine

**What it is.** `~/.cache/ruvnet-brain/versions/<v>/` holds immutable copies of the hook bodies;
`active.json` points at one. `hook-shim.mjs` is the only thing `hooks.json` names, and it resolves
that pointer once per invocation.

**What it gives you.** Hook behavior updates the moment `update-apply.mjs` flips the pointer — **no
Claude Code restart**. Claude Code freezes `${CLAUDE_PLUGIN_ROOT}` at boot, so without this, every
hook is trapped at the version that was on disk when you opened your editor.

**What it costs.** One `active.json` read per hook fire. Disk for retained generations (garbage-
collected, with leases so a tree still being served by a running MCP process is never collected).

**What you lose without it.** Correctness of updates, and the ability to know when you don't have it.
The shim distinguishes three states and is deliberately noisy about two of them: a spine that resolves
but is missing a body file falls back to the frozen plugin **and prints a stderr line naming the
fallback**; a previously-seeded-but-now-broken spine does the same; only a genuine first install is
quiet. That asymmetry exists so a broken spine can never masquerade as health — silence has to mean
one thing.

---

## 5 · The console

**What it is.** `scripts/onboarding-console.mjs` serves `console/` on 127.0.0.1 with a random per-
launch token. Open it with `/rvbc`.

**What it gives you.** Your machine, mirrored: which rUv tools are installed and at what version,
which capabilities are dormant, memory health, router utilization — and reversible one-click fixes.

**The four laws it encodes in code rather than in a promise:**

1. **Read-only by default.** Rendering the page and building `/api/state` writes nothing.
2. **Re-verify before write.** Apply re-measures the world and refuses any item no longer true. This
   structurally avoids the stale-read-then-write that clobbered a memory checkpoint on 2026-07-12,
   when two concurrent sessions both wrote and one silently destroyed the other's entire state.
3. **Record the inverse first.** The undo is journalled to `~/.cache/ruvnet-brain/console-undo.jsonl`
   *before* the mutation runs.
4. **Never re-implement a mutation.** Every machine change dispatches to a script that already backs
   up, verifies against disk, and is idempotent.

A recommendation **cannot be constructed** without evidence, a cost, and an undo — the factory in
`scripts/console-engine.mjs` throws otherwise, and if it touches the machine it additionally requires
a plain-English impact statement of at least 40 characters. That is a type error at construction, not
a code review someone can forget.

**What it costs.** A local HTTP server while open. Network reads of the npm registry for the version
audit. Writes nothing until you click.

**What you lose without it.** The ability to *see* any of this. Every other piece works headless —
the console is the window, not the engine. Its absence costs you discovery, which is precisely the
power user's complaint: he owns pieces he has never seen.

---

## 6 · The capability registry

**What it is.** 11 capabilities, each with a live probe. Unlike an audit — which only speaks when a
detector decides something is *wrong* — this returns a row per capability whether the news is good,
bad, or unavailable.

`learning-hooks` · `memory-distillation` · `workflow-pattern-learning` · `cheap-model-routing` ·
`cross-project-lessons` · `lessons-in-force` · `harness-evolution` · `write-gates` ·
`session-capture` · `mcp-servers` · `nightly-refresh`

**Two rules it exists to enforce.** First: `unknown` outranks `off` every time a probe could not run
— reporting "off" for something you failed to measure is the exact lie this project was built to
kill, and it is *easy* to commit here because every underlying helper has a falsy default. Second:
`turnOn` is `null` unless the exact command was run with `--help` and the subcommand confirmed
present. **Four of the eleven carry `turnOn: null`**, each recording the negative check that produced
it, so nobody re-litigates from memory:

- `learning-hooks` — `ruflo hooks --help` lists no `enable`/`disable` subcommand. No CLI flips them.
- `harness-evolution` — `ruflo metaharness --help` enumerates its subcommands; `evolve` is not among
  them. The MCP tool exists; the CLI surface does not, and this registry only ships pasteable commands.
- `lessons-in-force` — deliberate. `lesson-seed.mjs --apply` stores *candidates* only, because the
  model does not get to ratify its own rules. A `turnOn` would hand it the pen it was denied.
- `session-capture`, `write-gates`, `nightly-refresh` — turning these on means editing `settings.json`
  or loading a launchd plist. Multi-step machine mutation with no single verified command.

**What you lose without it.** The flat answer to "is X on?" — and with it, the ability to notice that
something you own has quietly switched off. This is the honest form of the phrase "you lose
proactivity": you lose an 11-row inventory that distinguishes *off* from *unmeasurable*, so a dormant
capability and a broken probe look identical, which is how a starving learner sat unnoticed for six
days.

> **A bug this file shipped, kept here because it is the most instructive one in the repo.** Every
> `scope: PROJECT` detector used to read `REPO` (where the *code* is installed) instead of
> `process.cwd()` (where the *user* is standing). From an empty folder it reported "write-gates | ON |
> 6 gates can refuse a write, 203 refusals recorded" — ruvnet-brain's own numbers, presented as
> yours. From a real project with a healthy 16 MB memory store it reported "memory-distillation |
> ABSENT", with a button offering to fix a problem you don't have. Anyone not standing inside a
> ruvnet-brain checkout — which is every user — got one of those two.

---

## 7 · The lesson store

**What it is.** `~/.config/ruvnet-brain/lessons.json`. Corrections you have given, structured, and
replayed at the decision point where they apply.

**Measured today:** 15 lessons — **12 ratified, 3 candidate**; by declared enforcement, **8 `block`,
5 `checklist`, 2 `review`**. Ten trigger types: `assert-fact`, `recommend-architecture`,
`relay-number`, `report-status`, `write-code`, `claim-done`, `ship`, `mutate-machine`,
`choose-work`, `finish`.

**The pipeline.** `correction-detect.mjs` (is this utterance a behavioral correction?) →
`record-lesson.mjs` → `lesson-store.mjs` → `lesson-ratify.mjs` (a human, never the model) →
`lesson-gate.mjs` → `lesson-hooks.sh` (the dispatcher that maps real Claude Code events onto
triggers). One dispatcher, not one hook per lesson: **gates scale with decision types, never with
lesson count** (ADR-030). Adding a lesson requires no code change, and that asymmetry is the entire
architecture.

**What it actually does, verified by running it today rather than by reading its config:**

```
$ bash plugin/scripts/lesson-hooks.sh Stop ; echo $?
{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"Your own recorded
 corrections apply at this moment. These are advisory — they do not refuse anything…"}}
0
```

**It nudges. It does not force.** A lesson declaring `block` still arrives as advisory
`additionalContext` unless you have personally opted that lesson into refusing. That is deliberate,
and it is the owner's own correction of an earlier design: *"Nudging somebody is very fair. Forcing
them through a gate is not."*

The reason this behavior is stated with an execution transcript rather than a description is that on
2026-07-22 the previous version **printed `⛔ BLOCKED` and returned exit 0** — three stacked defects
(gate exited 1 not 2; reason on stdout where exit-2 reads stderr; dispatcher discarded the code with
`|| true`), each individually sufficient. ADR-028 claimed "five gates exit 1 and refuse the action —
proven by exit code." The proof had been obtained by running the CLI by hand, which is the one caller
that is not a gate. **Never verify a hook by running it the way a hook doesn't.**

**Fail-open, correctly defined.** The old code implemented fail-open as "always exit 0", which is not
the same thing. Failing open means an *error* must not refuse you — missing node, unreadable store,
timeout. It never meant discarding a *deliberate* refusal. Those are now distinguished by exit code:
2 is a decision and propagates; every other non-zero is a malfunction and allows.

**What it costs.** One `node` spawn per matching event, hard-capped at 5 s where `timeout` exists.
(`timeout` is GNU coreutils and **stock macOS does not ship it** — unguarded, `timeout 5 node …`
exits 127 on a clean Mac and the gate never runs at all, producing silence indistinguishable from "no
lessons applied." It is used when present and skipped when not.)

**What you lose without it.** Your corrections stay prose. You re-explain the same preference; the
store currently records one lesson you have had to give **6 times across 1 project**.

---

## 8 · Evergreen updates and nightly evaluation

**What it is.** Two non-overlapping paths: the optional end-user LaunchAgent
(`com.ruvnet.brain-update`, 03:47) downloads and verifies the newest published release, while the
Dream Machine evaluates repository changes and proposes evidence without merging. The former
`com.ruvnet.brain-nightly` author-source writer was retired on 2026-08-22 after it accumulated
generated changes in the primary developer checkout.

**What it gives you.** A corpus that doesn't rot. rUv ships fast — Ruflo went 3.26 → 3.28 inside an
18-hour window.

**Its operating discipline.** Installed-cache updates never build or publish source. Dream cycles
never merge. A maintainer may run `scripts/nightly-wrapper.sh` manually, but the shared mutation
boundary refuses primary, nested, non-linked, and dirty worktrees and verifies afterward that the
primary HEAD, index, tracked diff, and untracked-file set did not change.

**What it costs.** The end-user LaunchAgent is a real machine mutation, so the installer keeps it
behind explicit consent. Author rebuilds consume local CPU, disk, and network only when explicitly
started in an isolated worktree.

**What you lose without it.** Corpus freshness, degrading continuously. The in-band staleness line on
every `search_ruvnet` response tells you how bad it has become (`newest store Nd old, oldest Nd`), so
this degrades *visibly* — which is the design. You can also refresh by hand:
`node ~/.cache/ruvnet-brain/kb/forge-update.mjs`.

The full separation and author-worktree contract are in
[Nightly refresh, evaluation, and author rebuilds](NIGHTLY-REFRESH.md).

---

## 9 · Commands and skills

**4 slash commands:** `/rvbc`, `/rvcb`, `/brain-console` (three aliases for the same console, because
people misremember the initials) and `/configure`.

**5 skills:** `ruvnet-brain` (the behavioral spine — ground every rUv claim in real source before
asserting), `brain-build`, `brain-prompt`, `brain-score`, `savings`.

**What you lose without them.** The doors. Every capability is still reachable by running its script
directly; you just have to know it exists — which returns you to the power user's original problem.

---

## The compatibility matrix

Four honest configurations. **"Brain only" is a legitimate choice, not a broken install.**

| | **Brain only** | **Brain + MCP** | **Brain + MCP + hooks** | **Full plugin** |
|---|---|---|---|---|
| **What you install** | Unzip the bundle | Bundle + `.mcp.json` entry | Bundle + plugin, hooks trimmed | `npx ruvnet-brain` |
| **Disk** | 2.7 GB | 2.7 GB | 2.7 GB + ~30 MB | same |
| Search 69 repos | ✅ by hand, ~110 s/question | ✅ in-conversation | ✅ | ✅ |
| Model consults it mid-answer | ❌ you paste results | ⚠️ only when it chooses to | ✅ prompted every turn | ✅ |
| Unprompted grounding | ❌ | ❌ | ✅ ~1,986 injections / 10.6 h | ✅ |
| Drift interception (pgvector, langchain, …) | ❌ | ❌ | ✅ 4 categories, ~20 patterns | ✅ |
| Brain-health alarm | ❌ silent death | ❌ silent death | ✅ 4 structural checks/session | ✅ |
| Blocking gates | ❌ | ❌ | ✅ 3 shipped (1 opt-in, 1 repo-scoped) | ✅ |
| Learning capture → SONA | ❌ | ❌ | ✅ | ✅ |
| Lesson nudges | ❌ | ❌ | ✅ 15 lessons, 10 triggers | ✅ |
| 11-capability audit | ⚠️ `node scripts/capability-registry.mjs` | ⚠️ same | ⚠️ same | ✅ + the console |
| Console | ❌ | ❌ | ❌ | ✅ `/rvbc` |
| Slash commands / skills | ❌ | ❌ | ❌ | ✅ 4 + 5 |
| Hot update, no restart | ❌ | ⚠️ MCP child only | ✅ | ✅ |
| **Context tax / prompt** | **0 tokens** | **0 until called** | **~630 tok median** | **~630 tok median** |
| **Context tax / session** | **0** | **0** | **~2,120 tok** | **~2,120 tok** |
| **Files written outside the cache dir** | **none** | **none** | **none** | **none** |
| Can refuse one of your actions | Never | Never | Yes — 3 gates | Yes — 3 gates |

**Reading the matrix as the power user.** Taking only the brain costs you, specifically and in
numbers: 1,986 grounding injections per 10.6 hours become zero; four categories of drift interception
stop watching your writes; the four structural health checks that catch a silently dead brain stop
running (that failure mode is not theoretical — it ran for *days* on 2026-07-12, returning empty
results that read as "nothing exists"); the learning queue never fills; 15 lessons across 10 decision
points never surface; and the 11-capability audit, the thing that would have told you any of this was
switched off, is not on screen.

What it *saves* you: ~630 tokens per prompt, ~2,120 per session, three gates that can refuse a Bash
or Task call, and any writes under `~/.cache/ruvnet-brain`.

If you are a heavy rUv user, the trade favors the full plugin decisively. **If you use one rUv tool
occasionally and value an uninterrupted shell, brain-only or brain+MCP is genuinely the right shape —
and nothing in this document is trying to talk you out of it.**

---

## Per-user vs per-project

The install asks this once, and it is a real choice, not a formality.

**Per-user (the default, and our strong recommendation).** The plugin installs at user scope
(`claude plugin install ruvnet-brain@ruvnet-brain --scope user`); the corpus lives once at
`~/.cache/ruvnet-brain`. Learning, lessons, capability audits, and software versions stay current
across **all** your projects — you install once and every project benefits, including projects you
haven't created yet. It is also the only shape in which cross-project learning means anything: a
lesson learned in project A is worthless if it can't reach project B.

**Per-project.** Choose it only if this is something you genuinely use in one project alone. It
isolates cleanly — but you pay 2.7 GB per project, you re-answer install questions per project, and
learning cannot compound because there is nothing to compound across.

**The recommendation is strong and the decision is still yours.** You are the arbiter of how things
run on your machine. Nothing below the plugin install requires all-or-nothing: `hooks.json` is a
plain file you can trim entry by entry, and each row in the hook table above tells you exactly what
you'd be turning off.

### What lands on your machine either way

| Path | Written by | What |
|---|---|---|
| `~/.cache/ruvnet-brain/kb/` | installer | the corpus (2.7 GB) |
| `~/.cache/ruvnet-brain/versions/`, `active.json` | update-apply | the stable spine |
| `~/.cache/ruvnet-brain/token-ledger.jsonl` | hooks + MCP | injected-byte meter (`RUVNET_BRAIN_METER=0` disables) |
| `~/.cache/ruvnet-brain/learn/session-*.jsonl` | learn-capture | command verbs + file basenames, never content |
| `~/.cache/ruvnet-brain/gate-blocks.jsonl` | the gates | refusal receipts |
| `~/.cache/ruvnet-brain/health.json` | brain-alarm | last known retrieval health |
| `~/.cache/ruvnet-brain/console-undo.jsonl` | console apply | the inverse of every change, journalled first |
| `~/.config/ruvnet-brain/lessons.json` | lesson-ratify | your ratified corrections |
| `~/.claude/ruvnet-brain/config.json` | console save | your console preferences |
| launchd plists | **only if you say yes** | installed-cache updates and other explicitly enabled jobs |

**Nothing is written into your project directories.** That is load-bearing and it was once false —
see the issue #36 note in §2.

---

## What this document deliberately does not claim

- **That every gate blocks.** Three do; two of the five that appear in the refusal ledger are wired
  in this machine's own settings and are not part of a fresh install. The lesson gate nudges.
- **That `search_ruvnet` is fast.** It is 1.5–2.5 minutes per call on an M3 Max, measured today.
- **That the corpus is current.** It is a snapshot. Every response says how old, in days, per store.
- **That 69 repos is the ecosystem.** 69 built, 123 pending, ~248 in the org.
- **That any of this was verified on Windows or Linux.** Every number here came from one macOS
  machine on 2026-07-22. `hooks.json` declares `"_platform": "posix"`.

---

## See also

- `docs/adr/0023-intelligent-updating-stable-spine.md` — why the shim and the MCP shell exist
- `docs/adr/0013-onboarding-console.md` — the console's four laws
- `docs/adr/0030-how-promoted-knowledge-changes-behavior.md` — gates scale with decision types
- `docs/adr/0032-capability-surface.md` — the registry's `unknown`-outranks-`off` rule
- `docs/INTELLIGENT-UPDATING.md` — the update mechanics end to end
- `console/architecture.html` — this document, rendered, in the console's visual language
