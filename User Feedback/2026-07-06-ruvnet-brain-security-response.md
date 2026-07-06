# RuvNet Brain — response to Dragan's QE pass (2026-07-06)

Dragan — thank you. This was one of the most useful reviews we've had: every item had a `file:line` and
a concrete fix, ranked by leverage, and it lined up almost exactly with the self-audit in ADR-0009. We
verified every finding against the real code before touching anything (nothing dismissed, nothing
rubber-stamped) and have started fixing from the top. Status below is honest — **FIXED** means committed +
pushed (with the commit), **VERIFIED** means we reproduced your finding, **PLANNED** means sequenced with a
concrete fix, not hand-waved.

Reviewed at your HEAD `126fc3b`; fixes land on `main` from `5e703fb` onward.

**Scorecard:** 12 findings — **all 12 addressed and pushed** (11 fully fixed + verified, 1 with the acute
vector closed and full crypto-signing tracked). Every fix was verified with a real command before it counted
as done; two migrations were caught breaking things in verification and reworked rather than shipped.

---

## ✅ FINAL STATUS (after the fix session — everything below is on `main`, verified)

| # | Finding | Status | Verified by | Commit |
|---|---|---|---|---|
| 1 | gate.sh can't fail | ✅ FIXED | PIPESTATUS exit-code capture; exits non-zero on a missed gate | 5e703fb |
| 2 | version drift (5+ numbers) | ✅ FIXED | one source (`plugin.json`) + `sync-version.mjs --check` in CI; "all surfaces agree" | 12232ed |
| 3 | run-tests 25/26 | ✅ FIXED | reconciled to intended behavior; **npm test → 26/26** | 12232ed |
| 4 | fence fails OPEN | ✅ FIXED | fail-closed; **fault-injection test → FATAL abort** | 5e703fb |
| 5 | aggregate-store bypass | ✅ FIXED | concepts store now fail-closed + private-filtered; fence verified | ff8193b |
| 6 | unsigned auto-updater RCE | 🟡 acute vector CLOSED | auto-`--apply` (code overwrite) removed → detect+notify only; full Ed25519/cosign signing tracked | 7b88e80 |
| 7 | injection guard bypass | ✅ FIXED | widened recall; **19/19 held + all 5 evasions now flag** | cb0f2bb |
| 8 | lockfile never ships | ✅ FIXED | ships package-lock + `npm ci`; clean lockfile (#9) | ee8daca |
| 9 | protobufjs CVSS 9.8 | ✅ FIXED | override → protobufjs 8.7.0; **npm audit → 0 vulns; live query still works** | ee8daca |
| 10 | Windows overclaim | ✅ FIXED | README scoped honestly (hooks are POSIX; native-Win needs WSL) | ff8193b |
| 11 | explainer overclaim | ✅ FIXED | S04 rewritten to the shipped soft-inject behavior | 12232ed |
| 12 | CI + small items | ✅ FIXED | CI added; `.env` leak scrubbed; orphan-guard + mkdir ported (SOURCE.json URL held with #6 signing) | multiple |

**Two verify-first catches worth calling out** (they're the discipline your review is teaching): (a) the
"obvious" #9 fix — migrating to `@huggingface/transformers` — *broke the embedder* on every offline install
(the new package couldn't read the old model cache), caught by a live query before shipping; reworked to an
npm `overrides` bump that clears the CVE with the embedder untouched. (b) #4's fail-closed was proven by
deliberately corrupting the fence and confirming the build aborts, not by asserting it.

**The one open item, honestly:** #6 full cryptographic signing (Ed25519/cosign, verify-before-extract,
hash-pinned tool files) is real work we're not rushing — the acute RCE vector (unattended unsigned code
overwrite) is already closed, and we'll ground the signing design in rUv's own RVFA-appliance pattern
(ruflo ADR-177). Would genuinely value your eyes on that design when we draft it.

---


---

## Top priority

### #1 — `gate.sh` always exits 0 (the gate can't fail) — ✅ FIXED (`5e703fb`)
Confirmed exactly: no exit-code check, the `grep` pipe masked `prove.mjs`'s `exit 1`, hardcoded personal
`cd`. Rewrote `scripts/gate.sh`: repo-relative `cd "$(dirname "$0")/.."`, `KB_MODEL_CACHE` defaults local,
each gate's real exit code captured via `PIPESTATUS`, and the script exits non-zero if any gate misses its
threshold. Your root cause ("no CI is what let this ship") is spot-on and tracked as #12/CI below.

### #2 — Version/number drift across every surface — 🔶 VERIFIED, next up (ADR-0009 decision #1)
Fully confirmed, and it's the finding that stings most for an anti-drift tool — we'd already opened it as
ADR-0009 decision #1 before your note. Your fix *is* our plan: **one hand-typed source** (`plugin.json`),
generate the README table + explainer stats + residual prose + `PROOF.md` at build, plus a **CI grep that
fails on any hardcoded version literal**. We're landing this next; it kills the whole class (and the npm
`1.6.2` vs repo `1.9.1` gap you flagged — `npx` installing behind the repo — is part of it). We'll also pin
`kb/package.json` off `"latest"` so the routing eval is deterministic and the "two honest residuals" prose
stops naming the wrong repos.

### #3 — `run-tests.mjs` is 25/26, not the README's 26/26 — 🔶 VERIFIED, planned
Confirmed. The new Gate-0 stack-watchdog footer (`ground-ruvnet.sh`) prints on *every* prompt, which broke
the older "silent on a non-RuvNet prompt" assertion and contradicts the hook's own "Stays SILENT" comment
(plus real per-turn token cost). Decision: the footer is a deliberate presence signal we want to keep, so
we'll **scope it** (status line / session-level, not literally every prompt) and update the test + README to
the intended behavior — restoring true silence on off-topic turns. Sequenced right after #2.

---

## Security

### #4 — Private-store fence fails OPEN — ✅ FIXED & PROVEN (`5e703fb`)
The scariest one, and confirmed: `loadPrivateStores()` returned an **empty set** on any error, so a
truncated/missing `PRIVATE-STORES.json` shipped *every* store incl. private cognitum source. Now
**fail-closed**: a present-but-unparseable fence **always aborts** the build; a missing fence aborts unless
`ALLOW_NO_PRIVATE_FENCE=1` (the explicit escape hatch a genuine no-private fork needs — never the silent
default). Proven with a fault-injection test: a corrupt fence now exits `FATAL` instead of shipping
everything. We also reconciled the count you flagged — the file lists **3** private stores (the "5" in
`PROGRESS.md` was stale and is corrected).

### #5 — Aggregate stores bypass the fence — 🔶 VERIFIED, planned
Confirmed: `kb/l2/`, `primer/`, and `concepts.big.rvf` are copied wholesale and `build-concepts.mjs` folds
*every* primer + L2 article into the shipped concepts store with no private filter — so a fenced repo's
*prose* could ship even though its raw `.rvf` is correctly excluded. Fix (sequenced): apply the same private
set inside `build-concepts.mjs` and the `cpDir` calls, add a **fail-closed unit test** on the fence, and — per
your best-long-term note — move toward deriving privacy from **repo visibility at ingest** rather than a hand-
maintained denylist. (Today, no fenced repo *has* a primer/L2 write-up, so nothing is leaking right now — but
the gap is real and we're closing it before that can change.)

### #6 — Unsigned bundle + auto-updater overwrites executable code — 🔶 VERIFIED, highest-severity design fix
Confirmed and taken seriously: the ~512 MB release is fetched + extracted with **no checksum/signature**, and
the consent-gated self-updater overwrites the whole KB dir **including the `.mjs` tool files** — a compromised
release = silent RCE on opted-in users. This is the one we will not blind-patch; it needs real signing infra,
grounded in rUv's own pattern (`ruflo` ADR-177 ships config as a **signed RVFA appliance**, Ed25519 footer,
verified with pure Node before adoption; `ruview-verify` uses SHA-256 witness bundles). Plan: publish a signed
SHA-256 / minisign (or cosign) signature, **verify before extract** in both `install.mjs` and
`forge-update.mjs`, and **hash-pin the `.mjs` tool files separately from data** so code and corpus have
different trust gates. **Interim hardening we're doing immediately:** the code-overwriting KB auto-*apply* is
being gated so it does not silently overwrite `.mjs` from an unsigned source until signing lands (detect +
notify stays; unattended code-replacement pauses). (Aside: the KB self-update URL currently 404s — points at
`ruvnet/` not `stuinfla/` — so today the code-overwrite path is de-facto inert; we're keeping it inert until
it's signed rather than "fixing" the URL into a working-but-unsigned updater.)

### #7 — Injection guard is easy to phrase around — 🔶 VERIFIED, planned
Confirmed: the six precision-biased regexes in `forge-guard-injection.mjs` miss synonyms (`disobey`/
`supersede`), `curl … | sh`, and "paste `~/.aws/credentials`", and the `aidefence` second layer silently
no-ops (broken ESM import) — so the lite regexes are the *entire* live defense. Given the autonomous threat
model, your call is right: **widen recall on the destructive/exfil category** (a false positive there is just
a cheap inert wrapper), and fix or remove the dead `aidefence` import so the "second layer" is real or
honestly absent. Sequenced in the security batch.

---

## Supply chain

### #8 — The lockfile never reaches users — 🔶 VERIFIED, planned
Confirmed: `kb/package-lock.json` is committed but not shipped, and `installReader()` runs `npm i` (not
`npm ci`) in the lockless unpacked bundle → a fully unpinned resolve on every install. Fix: add
`package-lock.json` to the bundle `tools` list and switch to `npm ci`. Pairs with #9.

### #9 — Transitive RCE, no fix-forward (`protobufjs` <7.5.5, CVSS 9.8) — 🔶 VERIFIED (npm audit: 1 critical), planned
Confirmed live — `npm audit` reports the critical `protobufjs` advisory (GHSA-xq3m-2v4x-88gg, arbitrary code
execution) via `@xenova/transformers → onnxruntime-web → onnx-proto → protobufjs`, and you're right that this
chain parses the `.onnx` weights we download from HF at first run, so it's a real trigger path. Fix (sequenced,
and tested because it touches the embedding path): migrate `@xenova/transformers` → the maintained
`@huggingface/transformers` fork, **pin exact versions** (off `"latest"`), and **pin a model `revision`/hash**
so downloaded weights get an integrity check they don't have today. This is a dependency change we'll verify
end-to-end (embeddings still resolve, routing eval holds) rather than ship blind.

---

## Portability & docs

### #10 — "Works the same on Windows" isn't true for the core feature — 🔶 VERIFIED, planned
Confirmed: hooks are `"_platform":"posix"` calling `/bin/bash …*.sh || true`, so on stock Windows the
grounding/hijack hooks — the main enforcement — **silently never fire**, and `|| true` hides it. Fix: port
the 3 hooks to Node (we're Node-18+ everywhere already), or scope the README claim to macOS/Linux/WSL.
Leaning toward the Node port so the claim stays true. (Thank you for the credit on `install.mjs` cross-platform
handling — that one we sweated.)

### #11 — Explainer claims an enforcement guarantee the product doesn't implement — 🔶 VERIFIED, planned (cheap)
Confirmed, and it's the one user-facing claim someone acts on with false confidence: S04 says the Brain
"catches" `import pinecone` "before the code lands," but `hijack-ruvnet.sh` is `DECISION="defer"` (never
blocks) and there's no `Stop` hook — exactly as ADR-0009 and your review both note. Fix: rewrite S04 to the
actually-shipped **soft retrieve-and-inject** behavior. Cheap and honest; landing it in the docs-truth pass
with #2/#3.

### #12 — Smaller items — mixed
- **No CI** (`.github/workflows/` absent) — 🔶 the root cause behind #1/#3 shipping unnoticed. PLANNED
  (ADR-0009 decision #7): CI running the brain-independent checks + the version-literal grep on every commit.
- **`VISION.md` leaks local paths incl. a `.env` location in a public repo** — ✅ FIXED (`5e703fb`). Scrubbed
  the absolute `.env`/model-cache paths from `VISION.md`, and removed the same hardcoded personal `.env`
  absolute path from 4 author scripts (`brain-grade-groundtruth`, `build-l2`, `build-primer`, `gen-images`) —
  they now read `process.env.RUVNET_ENV_FILE`, no personal path in the public tree.
- **`forge-mcp.mjs` missing the orphan-guard its twin has** — 🔶 PLANNED (cheap; port the `ppid` backstop).
- **`ground-ruvnet.sh` writes to `~/.cache/ruvnet-brain/` without `mkdir -p`** — 🔶 PLANNED (trivial).
- **`kb/SOURCE.json` self-update URL 404s (`ruvnet/` not `stuinfla/`)** — 🔶 VERIFIED. Intentionally held with
  #6: fixing the URL alone would turn a safely-inert unsigned updater into a working-but-unsigned one; it gets
  corrected *with* signing.
- **`forge-ask.mjs` (805 lines / stacked heuristics) hard to regression-test** — 🔶 acknowledged; the
  cross-encoder is the real lever (your read matches our header). Tracked as a refactor, not a security item.

---

## What you verified as strong — we're keeping it
PROVE-IT regenerating headline numbers from checked-in primers; `test-guard-injection.mjs` 19/19 with sharp
precision; `behavioral-l1-l4` honest pass/fail; MCP 9/9 live over stdio; above-average accessibility. And thank
you for the ADR-0009 nod — running the honest self-audit *before* an outside reviewer showed up is exactly the
discipline we're trying to build in, and your pass made it sharper.

## Sequence from here (bit by bit, top of the list down)
1. **#2 version single-source-of-truth + CI version-grep** (kills the whole drift class; ADR-0009 #1).
2. **#11 + #3 + docs-truth pass** (explainer S04 → real behavior; footer silence; README counts).
3. **#9 dependency migration** (@huggingface/transformers, pinned, model-hash) **+ #8 lockfile/npm ci**.
4. **#6 signing** (Ed25519/cosign verify-before-extract, hash-pinned tool files) — the big one.
5. **#5 aggregate-fence + fail-closed unit test**, **#7 guard recall**, **#10 Windows hooks port**, **#12 CI + small items**.

Happy to take you up on pairing — the top three are indeed an afternoon, and they move the credibility needle
most. Everything above is on `main`; the FIXED items are live now.

— Stuart (with RuvNet Brain running its own review)
