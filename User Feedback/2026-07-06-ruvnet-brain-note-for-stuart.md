# RuvNet Brain — a friendly QE pass

Hi Stuart,

I ran a full QE review of `ruvnet-brain` (deep read + a small swarm of specialized agents doing security, code, tests, dependencies, and docs/UX). First: this is genuinely good work — a real, proven grounding brain on the RVF stack, a sophisticated enforcement layer, real PROVE-IT discipline, above-average accessibility, and I loved finding ADR-0009 already calling out several of these before I did. Everything below is meant to help you ship, and every item has a file:line and a concrete fix. Ranked by leverage.

Reviewed at `main` / HEAD `126fc3b2`. "Confirmed" = an agent ran the exact command or read the exact line.

---

## Top priority (cheap + high leverage)

**1. `scripts/gate.sh` always exits 0 — the gate can't fail.** Confirmed by running it: each `prove.mjs` correctly computes `pass != total` and `process.exit(1)` (`scripts/prove.mjs:95`), but `gate.sh` has no `set -e`, never checks `$?`, and prints "GATES COMPLETE" regardless — so `bash scripts/gate.sh && echo SHIP-IT` prints SHIP-IT even when gates score 0%. It also `cd`s to a hardcoded `/Users/stuartkerr/Code/ruvnet-brain` (line 6) and a hardcoded model-cache path (line 7), so it only runs on your machine. **Fix:** `cd "$(dirname "$0")/.."`, capture each `prove.mjs` exit code, `exit 1` if any gate missed its threshold.

**2. Version/number drift across every surface** — the one thing most at odds with an anti-drift tool's brand. Same moment, different numbers:

| | version | repos | chunks | size |
|---|---|---|---|---|
| `plugin.json` | 1.9.1-dev | — | — | — |
| npm (`ruvnet-brain`) | **1.6.2-dev** (older → `npx` installs behind the repo) | — | — | — |
| README | v0.5.0-dev | ~21 | 90,842 | 512 MB |
| `data/manifest.json` | v0.3.0-dev | 19 | — | — |
| live explainer | v0.4.0-dev | 18 | 75,509 | 421 MB |

And the routing eval isn't deterministic: re-running the "re-runnable proof" in a clean tree gave **46/48** and **27/28** with *different failing questions* than the committed `PROOF.md` (partly because `kb/package.json` pins deps to `"latest"`). The README's "two honest residuals" paragraph now names the wrong repos as a result. **Fix — and it's exactly your own philosophy:** one hand-typed source (`plugin.json`/`manifest.json`), generate README table + explainer stats + residual prose + PROOF.md from it at build, plus a CI grep that fails on any hardcoded version. This is ADR-0009 decision #1 — landing it kills the whole class.

**3. `plugin/test/run-tests.mjs` is 25/26 today, not the README's 26/26.** Confirmed. The newer "Gate 0 stack watchdog" (`ground-ruvnet.sh:39-43`) prints a footer on *every* prompt, which broke the older "stays silent on a non-RuvNet prompt" assertion (`run-tests.mjs:60-61`) — and contradicts the hook's own "Stays SILENT when nothing matches" comment (real per-turn token cost too). **Fix:** restore silence on off-topic prompts, or update the test + README to the intended behavior.

---

## Security (worth doing before more users arrive)

**4. The private-store fence fails *open*.** `loadPrivateStores()` (`scripts/build-bundle.mjs:41-46`) wraps the read in `try/catch` returning an **empty** set — so a malformed/truncated `PRIVATE-STORES.json` makes the build ship *everything*. A safeguard should abort, not degrade to "ship all." **Fix:** `catch (e) { console.error('FATAL', e); process.exit(1); }`.

**5. Aggregate stores bypass the fence.** `kb/l2/`, `primer/`, and `concepts.big.rvf` are copied wholesale (`build-bundle.mjs:139-146`) with no private filter, and `build-concepts.mjs:20-73` folds *every* primer + L2 article into the shipped concepts store. So if a fenced repo ever gets a primer or L2 write-up, its prose ships even though the raw `.rvf` is correctly excluded. **Fix:** apply the same private set inside `build-concepts.mjs` and the `cpDir` calls. (Related: the fence is a manual exact-name denylist with zero tests, and `PROGRESS.md:53` says "5 private" while the file lists 3 — worth a quick reconcile + a fail-closed unit test. Best long-term fix: derive privacy from repo visibility at ingest, not a hand-maintained list.)

**6. Unsigned bundle + auto-updater that overwrites executable code.** `install.mjs` and the shipped `forge-update.mjs` fetch the ~512 MB release and extract with **no checksum/signature** (`bin/install.mjs:267-370`, `forge-update.mjs:161-172`), and the self-updater overwrites the whole KB dir *including the `.mjs` tool files* — with one-time, then unattended, consent (`session-start.sh:56-74`). A compromised release = silent RCE on opted-in users. **Fix:** publish a signed SHA-256 / minisign-cosign signature, verify before extract in both paths, hash-pin the tool files separately from data.

**7. Injection guard is easy to phrase around.** Six precision-biased regexes (`forge-guard-injection.mjs`); synonyms (`disobey`/`supersede`) or `curl … | sh` / "paste `~/.aws/credentials`" evade all of them, and the `aidefence` "second layer" silently no-ops (broken ESM import), so the lite regexes are the *entire* live defense. Given the autonomous threat model, widen recall on the destructive/exfil category — a false positive there is just a cheap inert wrapper.

---

## Supply chain

**8. The lockfile never reaches users.** `kb/package-lock.json` is committed but not shipped in the bundle, and `installReader()` runs `npm i` (not `npm ci`) inside the lockless unpacked bundle — so every install does a fully unpinned resolve. **Fix:** add `package-lock.json` to the bundle's `tools` list (`build-bundle.mjs:151`) and use `npm ci`.

**9. Transitive RCE with no fix-forward.** `@xenova/transformers` (pinned `"latest"`, effectively abandoned at 2.17.2) pulls `onnxruntime-web → onnx-proto → protobufjs <7.5.5` (**GHSA-xq3m-2v4x-88gg, CVSS 9.8**) — and that chain parses the `.onnx` weights you download from HF at first run, so it's a real trigger path, not just theory. `npm audit`: 1 critical + 3 high. **Fix:** migrate to the maintained `@huggingface/transformers` fork, pin exact versions, and pin a model `revision`/hash (there's no integrity check on downloaded weights today).

---

## Portability & docs

**10. The "works the same on Windows" claim isn't true for the core feature.** Hooks are `"_platform":"posix"` calling `/bin/bash …*.sh || true` (`hooks.json`), so on stock Windows the grounding/hijack hooks — your main enforcement — silently never fire, and `|| true` hides it. **Fix:** port the 3 hooks to Node (you're Node-18+ everywhere already) or scope the README claim to macOS/Linux/WSL. *(Credit: `bin/install.mjs` itself is genuinely, carefully cross-platform — the `where`/`Expand-Archive` handling is great.)*

**11. The explainer claims an enforcement guarantee the product doesn't implement.** Section S04: *"the instant Claude tries to write `import pinecone` … the Brain catches it … before the code lands."* Your own ADR-0009 notes `hijack-ruvnet.sh` sets `DECISION="defer"` (never blocks) and there's no `Stop` hook — so this is the one user-facing claim someone acts on with false confidence. **Fix:** rewrite S04 to the actually-shipped soft retrieve-and-inject behavior.

**12. Smaller stuff:** no CI at all (`.github/workflows/` absent) — which is what let #1 and #3 ship unnoticed; `forge-mcp.mjs` is missing the orphan-guard its twin `forge-mcp-all.mjs` has (a ~0.5 GB process can leak); `forge-ask.mjs` (805 lines / ~10 stacked heuristics) is getting hard to regression-test — your own header's right that the cross-encoder is the real lever; `ground-ruvnet.sh:75` writes to `~/.cache/ruvnet-brain/` without `mkdir -p` (harmless stderr noise every run); `kb/SOURCE.json`'s self-update URL points at `ruvnet/ruvnet-brain` (404 — repo is `stuinfla/`); and `docs/VISION.md:94-99` leaks your local paths incl. a `.env` location in a public repo — quick scrub.

---

## What's genuinely strong (verified live)

- **PROVE-IT is real, not theater** — retrieval regenerates close to your headline numbers from checked-in primers alone.
- `test-guard-injection.mjs` **19/19**, with sharp precision checks (benign "delete the user record" not flagged).
- `behavioral-l1-l4.mjs` — L1/L4 pass, L2/L3 *honestly* fail for lack of the 512 MB stores, exit code propagated correctly.
- MCP surface **9/9 live** over real stdio JSON-RPC against a freshly built `concepts.big.rvf`.
- Accessibility is above-average: real `title`/`desc` on every inline SVG, comprehensive reduced-motion, forced-colors support, no-JS-safe progressive enhancement.
- ADR-0009 — running an honest self-audit and publishing ~66/100 before an outside reviewer showed up is exactly the right instinct.

If it's useful I'm happy to pair on any of these — the top 3 are an afternoon and they'd move the credibility needle the most.

— Dragan
