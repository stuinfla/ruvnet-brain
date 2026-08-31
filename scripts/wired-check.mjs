#!/usr/bin/env node
/**
 * wired-check.mjs — refuses to let a module ship with zero callers.
 *
 * THE FAILURE THIS EXISTS TO END. On 2026-07-22 this project shipped built-tested-unwired code
 * SEVEN times in a single session: capability-registry, capability-audit, lesson-gate, anticipate,
 * advocacy-outcomes, lesson-promote, continuation-gate. Each was found by a human running grep.
 * Every one passed its own tests, because a unit test imports the module directly — the one caller
 * whose existence is guaranteed by its own file.
 *
 * (Those names are deliberately NOT written here as `<name>.mjs`. The first version of this header
 * listed them in invocation form, and the gate's own memorial then matched as a caller for every
 * module it eulogised. A gate must not be able to wire its own dead.)
 *
 * The owner's principle, P7: "Built is not shipped; shipped is not wired. A feature exists only
 * when a real caller invokes it on a real user path."
 *
 *   node scripts/wired-check.mjs            report
 *   node scripts/wired-check.mjs --check    exit 1 if any shippable module has no caller
 *
 * ── WHAT CHANGED, 2026-07-22 (ADR-037 / DDD-0010) ────────────────────────────────────────────
 * v1 of this gate reported 62/62 wired, exit 0, and had never failed. That was not health, it was
 * silence. Adversarial review (GPT-5.6-Sol, Fable 5) found three defects, all measured:
 *
 *   1. THE PREDICATE. v1 matched any MENTION of the basename anywhere in a file. A comment counted.
 *      A substring counted — `prove` matched "proven"; `version` matched a `"version"` JSON key.
 *      DDD-0010's own glossary said a Caller is "explicitly NOT any mention of the module's name",
 *      and the implementation was exactly that. The model disclaimed the code and nobody diffed it.
 *      Now: a caller must reference the module in INVOCATION SHAPE — inside a quoted string (import,
 *      require, npm script, workflow `run:`) or after node/bash/sh. Prose no longer wires anything.
 *
 *   2. THE INVENTORY. v1 read `scripts/*.mjs` only — 40 of 129 first-party executables were
 *      invisible, never audited, never printed, never counted. Among them
 *      `plugin/scripts/anticipate.sh`: one of the seven failures above, which v1 could never have
 *      caught. An invisible module is worse than an unwired one, because nothing reports it.
 *
 *   3. THE SEARCH SET. `kb/` was scanned for callers — ~3MB of JSON corpora INDEXING 68 OTHER
 *      REPOSITORIES, so a foreign repo's filenames counted as callers here. Removed. Also added:
 *      `.github/` + `--include=*.yml` (all 5 workflows are YAML; adding the directory without the
 *      glob, as ADR-037 draft 1 proposed, would have matched exactly nothing) and root package.json,
 *      where npm-script callers actually live.
 *
 * Also fixed: the test exclusion filtered `/tests/` PATHS, so `scripts/console-engine.test.mjs`
 * counted as a caller — violating this file's own rule in-tree. Now excluded by NAME, anywhere.
 *
 * WHAT COUNTS AS A CALLER: an invocation-shaped reference from non-test, non-self source. A test is
 * explicitly NOT a caller — that exclusion is the entire point, because every one of the seven had
 * passing tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadLessons, TRIGGERS, STATUS } from './lesson-store.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

/**
 * Modules that are legitimately standalone: a human or an out-of-repo scheduler runs them, so a call
 * site would be wrong to demand.
 *
 * An array, not an object literal, so a duplicate name is DETECTABLE. v1 used an object and had
 * `memory-doctor` twice (lines 50 and 64) — last-wins discarded one silently.
 *
 * HONEST LIMIT (ADR-037 §3): a reason here is PROSE, and prose is not verification. v1's four
 * "invoked from the workflow" reasons were all written in the same commit as the gate, by an author
 * who never ran the check — three of them were simply false. No schema detects that. The two real
 * mitigations are (a) needing far fewer entries now the predicate is correct, and (b) PRINTING
 * every entry on every run, below, so they cannot rot unseen.
 */
const STANDALONE = [
  ['lesson-seed', 'one-shot seeding, run deliberately by a human'],
  ['lesson-ratify', 'the human control surface — a CLI is its entire purpose'],
  ['stamp-sweep', 'ADR-056 §2 — the ONE-TIME backfill half of the stamp rule. A human runs it once '
    + '(--apply) to reach the files nobody is editing; the ongoing half is the md-stamp PostToolUse '
    + 'hook, which IS wired. Deliberately not in a gate: it WRITES to documents, and a writer that '
    + 'fires unattended on every push is how a repo gets a churn diff it did not ask for. It shares '
    + 'its entire placement implementation with the hook (ensureStamp/stampInsertionPoint/hasStamp), '
    + 'so there is no second copy to drift. Converged 2026-07-27: 132 stamped, 0 stampable.'],
  ['memory-doctor', 'diagnostic CLI'],
  ['token-report', 'diagnostic CLI'],
  ['agentdb-fleet-doctor', 'diagnostic CLI run by hand when a fleet looks wrong'],
  ['agentdb-context', 'targeted full-fidelity AgentDB recall CLI run by a human (`--grep`, `--key`, '
    + '`--window`). Its former automatic 36-hour dump was deliberately retired from the machine-wide '
    + 'SessionStart hook after 61KB of output hid the current checkpoint; SessionStart now prints the '
    + 'checkpoint plus a compact lesson index and directs topic recall through `ruflo memory search`.'],
  ['onboarding-console', 'human-started local server reached through the shipped `/rvbc`, `/rvcb`, '
    + '`/brain-console`, and `/ruvnet-brain:configure` command documents. The command host executes '
    + 'those instructions; there is intentionally no in-process source caller for a long-running CLI.'],
  ['ingest-meeting', 'one-shot ingestion, run by hand'],
  ['fix-metaharness-memretrieve', 'one-shot historical repair; kept for the record'],
  ['gen-console-images', 'build-time asset generation, run by hand'],
  ['adr-backfill', 'one-shot backfill by a human; its result is enforced by adr-format.test.mjs'],
  ['stamp-existing-rvf-generations', 'one-shot maintainer migration that binds already-built canonical '
    + 'RVFs to RVF-GENERATIONS.json and optionally prunes legacy sidecars; build-bundle.mjs consumes '
    + 'and validates the resulting manifest, so scheduling this destructive migration would be wrong'],
  ['release', 'the ship path, run by a human'],
  ['fix-workstream', 'session-supervised coordination CLI run explicitly by the integration owner or an '
    + 'isolated writing agent to start and hand off a fix lane. Scheduling it would violate its safety '
    + 'boundary: it prepares evidence but never merges, pushes, publishes, deletes, or cleans worktrees'],
  ['self-update', 'author-run candidate rebuild; --apply is guarded by worktree-integrity.mjs and is not scheduled'],
  ['ingest-new-repos', 'author-run corpus expansion; --apply is guarded by worktree-integrity.mjs and is not scheduled'],
  ['count-chunks', 'human-run CLI — recount + restamp chunk surfaces (--check for drift); no scheduler'],
  ['brain-stamp', 'invoked by the author-run self-update.mjs candidate builder'],
  ['lesson-promote', 'human-run CLI — promotion is manual (--apply); no scheduler yet (automation is ADR-029 #4, open)'],
  ['behavioral-l1-l4', 'behavioural harness invoked by its own test file — not a product path'],
  // A measurement harness, not a product path: it answers "would bounding the cross-encoder pool
  // change the answers?" and its --collect phase costs one full uncapped all-repos query per
  // held-out question (~2-8 min each, ~120 questions). Nothing may schedule that. Run by a human
  // whenever the retrieval pool policy is touched; `npm run cap:report` replays the recorded scores.
  ['rerank-cap-eval', 'human-run measurement harness — --collect is hours of cross-encoder time; never scheduled. '
    + 'Collects an uncapped baseline (--cap 0), a real capped run (--cap N, ADR-059) or a real cascade run '
    + '(--cascade K, ADR-060); all three are collected FOR REAL because batch composition moves scores'],
  // The other half of the same measurement (ADR-059): --collect/--report replays a cap offline,
  // this one runs the real thing warm and paired, because batch composition moves cross-encoder
  // scores and a replayed cap is therefore an approximation of a real one. ~35 minutes of ONNX
  // inference for 24 questions; human-run, never scheduled.
  ['rerank-cap-warm-ab', 'human-run measurement harness — the real warm paired A/B behind ADR-059 (--cap) and '
    + 'ADR-059 (--cascade); never scheduled. Both policies share it on purpose: a number is only comparable '
    + 'to another number taken the same way'],

  // ADDED 2026-07-23 (P7 sweep, ADR-037 honesty bar — each reason verified against reality below,
  // not written blind. See PROGRESS.md / the wiring report for the per-item evidence.)
  //
  // launchd nightly (out-of-repo scheduler) — confirmed LIVE via `launchctl list` + the installed
  // plist's own ProgramArguments on 2026-07-23, not assumed from the header comment alone:
  ['clear-claude-tmp', 'launchd, every 3h (out-of-repo scheduler) — confirmed live: '
    + 'com.stuartkerr.clear-claude-tmp.plist is loaded and its ProgramArguments invoke this exact file'],
  ['nightly-gists', 'launchd nightly 21:47 (out-of-repo scheduler) — confirmed live: '
    + 'com.ruvnet.brain-gists.plist is loaded and its ProgramArguments invoke this exact file'],
  ['nightly-wrapper', 'author-run maintenance harness, deliberately unscheduled; refuses primary, nested, and dirty worktrees'],
  ['routing-flywheel', 'launchd nightly 04:45 --dry-run (out-of-repo scheduler) — confirmed live: '
    + 'com.ruvnet.routing-flywheel.plist is loaded and its ProgramArguments invoke this exact file'],
  ['install-npx-witness', 'one-shot idempotent installer for the com.ruvnet.npx-witness launchd job, '
    + 'run by hand once — confirmed live: the installed plist\'s ProgramArguments match exactly what '
    + 'this script writes. The recurring job body is scripts/npx-witness.sh, wired separately'],

  // human-run KB-build/grading harnesses — documented as a unit in CONTRIBUTING.md §5 ("the test/
  // grading scripts") and exercised by hand per PROGRESS.md session logs (`--name X --variant Y`).
  // Each needs an external `../ruvnet-repos/<name>` clone and/or a paid multi-vendor LLM call
  // (OPENROUTER_API_KEY) to grade a KB variant — deliberately outside gate.sh's fast/free/local
  // pipeline (gate.sh only runs prove.mjs, which needs neither):
  ['brain-capability-check', 'human-run KB grading harness (CONTRIBUTING.md §5); '
    + 'grades a built variant against kb/capability.*.json by hand before shipping'],
  ['brain-grade-groundtruth', 'human-run KB grading harness (CONTRIBUTING.md §5); needs an external '
    + '../ruvnet-repos/<name> clone + paid multi-vendor LLM grading, run by hand per repo'],
  ['build-l2', 'human-run KB synthesis harness (CONTRIBUTING.md §5); synthesizes + grades L2 prose '
    + 'via a paid multi-vendor LLM panel, run by hand per repo/variant'],
  ['build-primer', 'human-run KB synthesis harness, the same proven shape as build-l2 (its own header): '
    + 'per-repo top-down primer over the 6 comprehension archetypes, paid-LLM synthesis, run by hand per '
    + 'repo. Surfaced here 2026-07-23 when the comment-strip stopped counting its usage-example mentions '
    + 'as callers — it never had a code caller, it is invoked by a person.'],
  ['gen-images', 'human-run explainer-image generator (OpenAI gpt-image-1, dall-e-3 fallback), run by '
    + 'hand when the explainer art needs regenerating — a paid one-shot build tool with no code caller, '
    + 'same class as the KB synthesis harnesses above. Surfaced by the 2026-07-23 comment-strip.'],

  // diagnostic CLIs run by hand — same shape as memory-doctor/token-report/agentdb-fleet-doctor above:
  ['calibrate-router', 'measurement harness run by hand to calibrate router tiers on real runs; '
    + 'billing-safety wrapped (strips API keys so it can only bill the subscription)'],
  ['proactivity-metrics', 'ADR-041 recall + false-alarm harness. Its own CLI prints the two metrics, and '
    + 'tests/integration/proactivity-ground-truth + tests/mutation/proactivity-detector-mutation exercise '
    + 'it — a test is not a caller, so it registers here like calibrate-router. It spawns the REAL '
    + 'capability-registry.mjs against a ground-truth scratch machine to measure detector-recall and '
    + 'false-alarm IN-FENCE (the two ADR-028 metrics that do not need the deploy gate).'],
  ['correction-detect-measure', 'the measurement harness ADR-033 §2 requires, run by hand (its own '
    + '`invokedDirectly` CLI). It walks the real transcript corpus to score correction-detect on a '
    + 'held-out split. It was previously reported "wired" by three mentions that are ALL prose — two '
    + 'header comments in correction-detect{,-embed}.mjs and this file\'s own HELD string — the exact '
    + '"a gate must not wire its own dead" hole an independent regrade found; the comment-strip closes '
    + 'the comment half, and this entry is the honest classification for a hand-run harness.'],
  ['correction-detect-embed', 'ADR-033 NEGATIVE-RESULT reference, run by hand. Built 2026-07-23 to '
    + 'test whether an embedding k-NN (the same local Xenova/all-MiniLM-L6-v2 path the KB uses) clears '
    + 'the lesson-extraction floor where the regex cannot. It does NOT: measured WORSE precision than '
    + 'the regex (25% vs 50-100%) at comparable recall on the same held-out split, because MiniLM '
    + 'separates by topic, not by the pragmatic "is this correcting the agent" property. Kept, wired to '
    + 'nothing on purpose, so the negative is reproducible and not re-litigated — NOT a path to wire in.'],
  ['check-indexation', 'diagnostic CLI run by hand; explicitly "always exit 0, not a gate" per its '
    + 'own header — live Bing/Google scraping to eyeball real-world SEO status, not CI-appropriate'],
  ['check-legibility', 'manual pre-ship check run by hand against a LOCAL dev server the developer '
    + 'starts themselves (--url http://127.0.0.1:.../page.html, via Playwright) — needs a live '
    + 'rendered page, not a static diff, so it is a dev-loop tool like gen-console-images.mjs, not a '
    + 'CI step'],
  ['dev-plugin-link', 'developer convenience CLI — its own header: "Users never run it." Hot-links '
    + 'the cached plugin install to the working tree so hook edits apply without a CC restart'],

  // ADR-0026 Meta LLM Proxy passthrough trial — both are human-run by design (one launches a proxied
  // session interactively via `exec claude "$@"`, the other is the trial's safety-net uninstaller):
  ['claude-proxied', 'ADR-0026 proxy trial: human-run launcher for one proxied Claude Code session '
    + '(exec claude "$@") — interactive by design, never invoked programmatically'],
  ['proxy-revert', 'ADR-0026 proxy trial: human-run safety-net uninstaller, run by hand to fully '
    + 'revert the trial'],

  // lesson-capture CLI — same shape as lesson-seed/lesson-ratify above: a human runs this with
  // --task/--tried/--worked/--critique flags. docs/ARCHITECTURE-MAP.md documents the pipeline as
  // "record-lesson.mjs -> lesson-store.mjs -> lesson-ratify.mjs (a human, never the model)":
  ['record-lesson', 'human-run structured lesson-capture CLI (--task/--tried/--worked/--critique); '
    + 'never invoked by the model itself, by design'],

  // one-shot, and its job is done: issue #4 closed 2026-07-10 (confirmed live via `gh issue view 4`).
  // Per the file's own header its 07:17 launchd trigger removed itself after firing, so no plist
  // remains to find. Kept for the historical record, same precedent as fix-metaharness-memretrieve
  // above — NOT re-wired, because there is nothing left for it to verify:
  ['verify-nightly-close-issue4', 'one-shot, job complete: issue #4 closed 2026-07-10 (confirmed '
    + 'live); its own launchd trigger self-removed after firing. Kept for the record — deletion is '
    + 'also reasonable and is flagged as a candidate in the wiring report, Stuart\'s call'],

  // The grounding wall and its successful-search stamp used to be in this inert class. They now
  // ship through the plugin shim on both Claude and Codex; keeping them exempt here made the wiring
  // report contradict its own live hook census.
  ['kling-preflight', 'PreToolUse (Bash) gate — ships inert by design, same SECURITY.md class as '
    + 'ground-before-write. Per ADR-0014 ownership moved to the Kling skill (confirmed live: a copy '
    + 'ships at ~/.claude/skills/klingai/scripts/kling-preflight.sh); NOT currently wired into any '
    + 'settings.json there either — honestly dormant until a user opts in, not a silent gap'],
];
// REMOVED 2026-07-22, each verified before removal:
//   check-legibility / check-indexation / status-honesty — claimed "invoked from the workflow";
//     nothing in .github/ invokes them. The claim was false, so they are now audited for real.
//   claims-verify — the claim was TRUE (.github/workflows/ci.yml:56 runs `npm run claims:verify`).
//     It needs no entry now that package.json and *.yml are searched. Draft 1 of ADR-037 called this
//     one false too; it had grepped `claims-verify` while the npm script is `claims:verify`.
//   doc-currency, sync-version, build-bundle, health-repair, capability-audit, wired-check —
//     all have real invokers the corrected scanner now finds on its own.

/**
 * DELIBERATELY HELD — built, correct to keep, knowingly NOT wired, each with the bar it must clear.
 * A separate category from STANDALONE on purpose: filing held work under "standalone" would be a
 * small lie that hides a real gap. Held work is VISIBLE work.
 */
const HELD = {
  'correction-detect': 'N3 lesson extraction. Re-measured 2026-07-23 on a reproducible held-out split '
    + 'of 1,328 real transcripts (scripts/correction-detect-measure.mjs): 5 real detector bugs fixed, '
    + 'corpus detections 2->8, ~50-100% precision at n=4 on the holdout. TWO measured findings now bound '
    + 'this, and both point the same way. (1) The >=100-DETECTION floor is UNREACHABLE ON THIS CORPUS: '
    + 'hand-labeling all 271 loose-net candidates across the full 1,328 transcripts against ADR-033\'s '
    + 'four-signal definition found only ~37-43 genuine corrections TOTAL — a third of the floor. The '
    + 'floor is a fact about the data, not the regex. (2) The embedding classifier that this note used '
    + 'to name as the way out was BUILT and MEASURED (scripts/correction-detect-embed.mjs, STANDALONE): '
    + 'it is WORSE than the regex (25% vs 50-100% precision, comparable recall) and less legible, because '
    + 'MiniLM separates by topic not by pragmatics. No primitive clears >=100 here. The honest floor '
    + '(owner decision, ADR-033) is ">=90% precision at whatever N the corpus supports, accumulating as '
    + 'it grows" — under which this STILL stays HELD, precision at the available N being unproven. '
    + 'CORPUS WIDENED 2026-07-24 (the lever nobody had pulled): the note above said the floor is a fact '
    + 'about THE DATA — true, and it was measured on ONE project. Re-run across 8 further transcript '
    + 'corpora (--corpus-dir): 2,728 files / 2,641 candidates / 11 detections, for a combined 4,083 '
    + 'files / 4,023 candidates / 19 detections. Detections went 8 -> 19 with ZERO detector changes, so '
    + 'the binding constraint was corpus size, not the regex. TWO findings. (1) IT GENERALISES: it fires '
    + 'in a salon website, an insurance-appeal tool and a health platform — non-software domains it was '
    + 'never tuned on — at a comparable low rate. Not 0 (which would mean overfit to this repo\'s '
    + 'dialect) and not a flood (false positives). That was the open question about the second-person '
    + 'rule and it now has an answer. (2) THE FLOOR IS REACHABLE, JUST FAR: at ~19 per 4,083 transcripts, '
    + '>=100 needs on the order of 21,000 transcripts. That is a schedule, not a wall — the earlier '
    + '"unreachable" was true of one project and false of the machine. '
    + 'PRECISION MEASURED AT n=19 (2026-07-24), by THREE independent raters labelling BLIND — they were '
    + 'given the utterances with the detector verdict stripped, and the author did not label, being '
    + 'unblinded by construction. Majority vote. HOLDOUT (the only unbiased half): n=9, 7 TRUE / 2 FALSE, '
    + 'ZERO borderline, so strict and lenient agree exactly: PRECISION 77.8%. Combined n=19: 68.4% strict '
    + '/ 84.2% lenient. Rater agreement 73.7-84.2% pairwise, 13/19 unanimous. THIS REPLACES the old '
    + '"~50-100% at n=4" — a range so wide it asserted nothing. The wider corpus did not just grow N, it '
    + 'REVEALED THE DETECTOR IS WEAKER than the small sample implied, which is precisely why n=4 was never '
    + 'shippable. 77.8% is BELOW the >=90% floor, so this stays HELD — now for a measured reason instead '
    + 'of an unproven one. THE RESIDUAL FALSE-POSITIVE CLASS IS NAMED AND SINGULAR: both holdout misses '
    + '(and every tune borderline) are REPROACH PHRASED AS A QUESTION — "you keep doing X, why?" — real '
    + 'dissatisfaction about a real pattern, carrying no explicit forward rule. Signal 3 binds a quantifier '
    + 'to the second person and these satisfy it ("you keep"), yet a human reads them as complaint, not '
    + 'instruction. That is the next thing to fix, and it is one class, not a long tail.',
  'lesson-lifecycle': 'retirement + generalization for extracted lessons. Depends on '
    + 'correction-detect; wiring it alone would retire hand-written lessons on evidence that does '
    + 'not exist yet.',
  'capability-audit': 'THE L3 GAP, and now visible instead of falsely green. The offensive half of '
    + 'retrieval — it answers "what capability is installed and dormant?" — but nothing calls it: verified '
    + '2026-07-23 that its only non-comment mention is its own invokedDirectly guard (self). It was '
    + 'reported "wired" purely by JSDoc mentions in capability-registry.mjs until the comment-strip; '
    + 'ADR-028 and 4.0-READINESS §4 both name this the single largest 4.0 gap. HELD because the fix is a '
    + 'real decision — one in-session consumer that speaks unprompted, with a one-action permanent silence '
    + '— not a line of wiring.',
  'issue-fix': 'the GitHub-issue AUTO-FIXER, built but intentionally NOT wired. Verified 2026-07-23: '
    + 'issue-watch.yml runs only issue-watch.mjs (which LISTS issues), and issue-watch.mjs spawns only '
    + 'gh/sleep — never this. Its own yml comment says why it is gated: it "spawns a headless Claude and '
    + 'costs money + needs credentials". Wiring it is a cost-and-consent decision the owner makes, not a '
    + 'gap to silently close.',
};

/** Where first-party executables live. v1 knew only the first line of this table. */
const INVENTORY_ROOTS = [
  { dir: 'scripts', exts: ['.mjs', '.sh'], recurse: true },
  { dir: 'plugin/scripts', exts: ['.mjs', '.sh'], recurse: true },
  { dir: 'bin', exts: ['.mjs'], recurse: false },
  { dir: 'console', exts: ['.js'], recurse: false },
];

/**
 * Where callers live. NOT kb/ — it indexes 68 other repos and their filenames are not our callers.
 *
 * `.claude/` earns its place the hard way: the first run of the corrected gate reported
 * `version-bump-gate.sh` unwired, and it is invoked from `.claude/settings.json`. Per ADR-037 §3, an
 * invoker outside the roots proves the ROOTS are incomplete — the fix is to add the root, never to
 * write an exemption. That rule caught its own author within a minute of the gate first running.
 */
// `dream.config.json` is executable configuration, not documentation: the Dream compiler runs its
// controlPlaneProbes and evaluatorEntrypoints. Excluding it made two real scheduled callers look
// dead while the same scanner already trusted workflow YAML and package.json command manifests.
const CALLER_ROOTS = [
  'scripts', 'plugin', 'console', 'bin', '.github', '.claude', 'package.json', 'dream.config.json',
];
const CALLER_EXTS = new Set(['.mjs', '.js', '.sh', '.json', '.html', '.yml', '.yaml']);
export const REQUIRED_OPERATIONAL_EXPORTS = [
  { rel: 'scripts/corpus-reconcile.mjs', symbol: 'syncCorpusInputs' },
  { rel: 'scripts/corpus-reconcile.mjs', symbol: 'materializeGistReceipts' },
  { rel: 'scripts/corpus-reconcile.mjs', symbol: 'observeAndMaterializeGistReceipts' },
  { rel: 'scripts/corpus-aggregates.mjs', symbol: 'rebuildCorpusAggregates' },
  { rel: 'scripts/corpus-reconcile.mjs', symbol: 'reconcileCorpusUntilStable' },
  { rel: 'scripts/corpus-reconcile.mjs', symbol: 'reconcileAndPrepareCorpusCandidate' },
];

const isTestFile = (f) => /\.(test|spec)\.(mjs|js)$/.test(path.basename(f))
  || f.includes(`${path.sep}tests${path.sep}`) || f.startsWith(`tests${path.sep}`);

function walk(abs, recurse, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(abs, e.name);
    if (e.isDirectory()) {
      if (recurse && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(full, recurse, out);
    } else out.push(full);
  }
  return out;
}

/** Every first-party module expected to be USED by something. */
export function shippableModules(repo = REPO) {
  const out = [];
  for (const root of INVENTORY_ROOTS) {
    const abs = path.join(repo, root.dir);
    for (const full of walk(abs, root.recurse)) {
      const ext = path.extname(full);
      if (!root.exts.includes(ext)) continue;
      if (isTestFile(full)) continue;
      const rel = path.relative(repo, full).split(path.sep).join('/'); // POSIX-style always: repo-relative keys must not vary by OS
      out.push({ base: path.basename(full, ext), file: path.basename(full), rel });
    }
  }
  return out;
}

/** Files that could contain a caller. */
function callerFiles(repo = REPO) {
  const out = [];
  for (const r of CALLER_ROOTS) {
    const abs = path.join(repo, r);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) { out.push(abs); continue; }
    // ADR-056, 2026-07-27: git hooks are EXTENSIONLESS by git's own contract — the file must be named
    // exactly `pre-push` / `pre-commit` or git ignores it. So the extension filter excluded
    // `scripts/git-hooks/pre-push` — THIS REPO'S PRIMARY SHIP GATE — from the caller set entirely, and
    // anything reachable only from there read as unwired. Found the moment the currency check was
    // wired into pre-push and `wired-check` went on reporting it `manual`. This file's own note names
    // the remedy: "an invoker outside the roots proves the ROOTS are incomplete — the fix is to add
    // the root, never to" special-case the module. Same rule, applied to the extension filter.
    for (const f of walk(abs, true)) {
      if (CALLER_EXTS.has(path.extname(f))) { out.push(f); continue; }
      if (path.extname(f) === '' && path.basename(path.dirname(f)) === 'git-hooks') out.push(f);
    }
  }
  return out;
}

/**
 * INVOCATION-SHAPED match. The whole correction lives here.
 *
 * A caller references the file either inside a quoted string — covering `import ... from '...'`,
 * `require('...')`, npm scripts, and a workflow's `run:` — or directly after node/bash/sh. A bare
 * mention in prose does not match, which is what let a comment wire a module in v1.
 */
export function callerPattern(fileName) {
  const q = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // eslint-disable-next-line no-useless-escape
  return new RegExp(`["'\`][^"'\`\\n]*${q}|(?:node|bash|sh|exec|spawn\\w*)\\s+[^\\n]*${q}`);
}

/**
 * Strip comments BEFORE matching. The invocation branch of callerPattern (`node <file>`) matches a
 * usage example in a header comment exactly as it matches a real command line — which is how, after
 * this gate already fixed "a bare prose mention wired a module in v1", a `node scripts/…measure.mjs`
 * line inside a comment quietly re-opened it (an independent regrade, 2026-07-23, found correction-
 * detect-measure.mjs reported "wired" by three comment/string mentions, one of them this file's own
 * HELD reason). Removing comments closes the comment form of that hole.
 *
 * Conservative by construction: over-stripping a `//` that lives inside a string (a URL) can only ever
 * DROP a candidate line, never invent one — and a genuine caller is an import / require / node-exec,
 * never a URL — so this can hide a prose mention but cannot hide a real caller. The `[^:]` guard keeps
 * `https://…` from eating its own line. String LITERALS that name a module (e.g. a documentation
 * string) are deliberately NOT stripped — that is a separate, rarer shape, and the module it would
 * mis-wire here is instead classified honestly in STANDALONE.
 */
export function stripComments(src, ext) {
  const jsLike = ['.mjs', '.js', '.cjs', '.ts', '.mts'].includes(ext);
  const shLike = ['.sh', '.yml', '.yaml'].includes(ext);
  if (!jsLike && !shLike) return src;                // .json has no line-comment syntax
  // ONLY blank a line that is ENTIRELY a comment (trimmed, it starts with the comment marker). This is
  // the deliberately narrow, provably-safe version. An earlier attempt span-matched `/*…*/` globally and
  // a `/*` sitting inside a line-comment made it swallow real code across many lines — it hid
  // sign-bundle.mjs's genuine caller in self-update.mjs:353 (execFileSync([... 'scripts/sign-bundle.mjs'])).
  // A REAL invocation never lives on a whole-line-comment line, so this cannot hide a caller; block and
  // inline comments are left untouched (a caller-shaped mention there is rare and not worth the span risk),
  // and JSDoc `*` bodies are NOT matched (a `*gen()` line is real code). Every false caller the regrade
  // found — `// … scripts/…measure.mjs` usage examples — is a whole-line `//`, so this closes exactly it.
  const marker = jsLike ? '//' : '#';
  // ADR-056, 2026-07-27: ALSO blank JSDoc continuation lines. The comment documenting the
  // package.json fix, two screens below, spelled both an invocation-shaped path and an
  // `npm run <script>` line as illustrations — and forged TWO false callers with them, flipping the
  // very module it audits back to `wired` twice in a row. The note above says block comments are
  // "left untouched (a caller-shaped mention there is rare…)"; it turned out to be rare right up
  // until someone documented a caller-shaped bug.
  // SAFE BY CONSTRUCTION, and the space matters: a trimmed line starting `*` FOLLOWED BY WHITESPACE
  // (or nothing) is a JSDoc body line. A generator method is `*gen()` — star then a letter — so it is
  // untouched, which is exactly the case the original note refused to risk. Like every other rule
  // here this can only ever DROP a candidate line, never invent one.
  const jsdocBody = /^\*(\s|$)/;
  return src.split('\n')
    .map((l) => {
      const t = l.trim();
      if (t.startsWith(marker)) return '';
      if (jsLike && jsdocBody.test(t)) return '';
      return l;
    })
    .join('\n');
}

/**
 * ── THE THIRD STATE (ADR-056, 2026-07-27) ────────────────────────────────────────────────────────
 * DEFINING an npm script is not INVOKING it. `package.json` line 35 defines `doc:currency` as a
 * command that runs the currency script, and callerPattern's quoted-string branch matches that
 * VALUE — so the line that DEFINES the script counted as a caller of it. The currency script was
 * therefore reported `wired` while nothing in the repo ran it: absent from pre-push, gate.sh,
 * gates.mjs and every workflow. Measured 2026-07-27: `npm run doc:currency` (a REAL invocation)
 * does not match callerPattern at all, while the definition does. The auditor was blind in BOTH
 * directions on the largest instance of exactly the built-but-unwired failure it exists to catch.
 *
 * This is the THIRD time this defect class has landed here, and the shape never changes: **a string
 * that NAMES a module is not a CALL to it.** v1 substring-matched prose; the 2026-07-23 regrade
 * found invocation-shaped usage examples inside `//` comments; this is the package.json form.
 *
 * ⚠ AND THE FIX REPRODUCED IT ONCE MORE, IN ITSELF. The first draft of this very comment spelled the
 * currency script's full filename after the word `node`, as an illustration. `stripComments` blanks
 * only WHOLE-LINE `//` comments — block comments are left untouched, deliberately ("a caller-shaped
 * mention there is rare and not worth the span risk"). So this JSDoc forged a caller and made
 * wired-check itself a "caller" of the module it was auditing, flipping it back to `wired`. Caught
 * 2026-07-27 by checking the row after the fix instead of trusting it. The hole is REAL and still
 * open for block comments; it is recorded here rather than papered over, because the safe rule costs
 * nothing: **never write an invocation-shaped path in a comment in this file.** Name the script, not
 * the command line.
 *
 * NOT fixed by flagging npm scripts `unwired` — `tests/unit/wired-check.test.mjs:45` deliberately
 * accepts them, and rightly: a script a human runs IS a way in. The honest distinction is that an
 * npm script is a HUMAN entry point, not an AUTOMATED one, and collapsing those two is what let
 * doc-currency hide in plain sight for five days. So a module reachable ONLY through an npm script
 * that nothing automated invokes is reported `manual` — true, legible, and impossible to mistake for
 * "this runs in the ship path." Inventing a fourth lie-shaped status was the alternative; DDD-0008
 * says not to, and a status that overclaims is the thing this whole context exists to end.
 */
export const NPM_AUTO_LIFECYCLE = new Set([
  'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack',
  'preinstall', 'install', 'postinstall',
  'prestart', 'poststart', 'pretest', 'posttest',
  'preversion', 'version', 'postversion',
]);

/** Which package.json script bodies NAME this module? (definitions, not invocations) */
export function npmScriptsNaming(pkgSrc, modFile) {
  let pkg;
  try { pkg = JSON.parse(pkgSrc); } catch { return []; }
  const scripts = pkg && pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return [];
  const re = callerPattern(modFile);
  return Object.entries(scripts)
    .filter(([, body]) => typeof body === 'string' && (re.test(body) || re.test(`"${body}"`)))
    .map(([name]) => name);
}

/**
 * Is any of these npm script names reachable by AUTOMATION rather than by a human typing it?
 * Automated means: npm itself runs it (a lifecycle name), or some file — a workflow, a shell hook,
 * or another composite npm script — invokes it by name.
 */
export function npmScriptAutomated(names, files, repo = REPO) {
  for (const n of names) {
    if (NPM_AUTO_LIFECYCLE.has(n)) return { automated: true, via: `npm lifecycle (\`${n}\` is run by npm itself)` };
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const n of names) {
    const re = new RegExp(`(?:npm|pnpm|yarn|npm-run-all|run-s|run-p)\\s+(?:run\\s+)?${esc(n)}(?![\\w:-])`);
    for (const f of files) {
      const rel = path.relative(repo, f).split(path.sep).join('/');
      let src = '';
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      // A composite script in package.json ("test:all": "npm run test:unit && …") IS automation.
      if (re.test(stripComments(src, path.extname(f)))) return { automated: true, via: `${rel} runs \`${n}\`` };
    }
  }
  return { automated: false, via: null };
}

/** Count REAL callers. Tests excluded deliberately: all seven failures had passing tests. */
export function callersOf(mod, files, repo = REPO) {
  const re = callerPattern(mod.file);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(repo, f).split(path.sep).join('/');
    if (rel === mod.rel) continue;              // self
    if (isTestFile(rel)) continue;              // a test is not a caller
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (re.test(stripComments(src, path.extname(f)))) hits.push(rel);
  }
  return hits;
}

export function operationalExportAudit({ repo = REPO, required = REQUIRED_OPERATIONAL_EXPORTS } = {}) {
  const files = callerFiles(repo);
  const rows = required.map(({ rel, symbol }) => {
    const sourceFile = path.join(repo, rel);
    let source = '';
    try { source = fs.readFileSync(sourceFile, 'utf8'); } catch { /* reported as missing below */ }
    const quoted = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exported = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${quoted}\\s*\\(`).test(source);
    if (!exported) return { rel, symbol, state: 'missing', callers: [] };
    const declaration = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${quoted}\\s*\\(`, 'g');
    const invocation = new RegExp(`\\b${quoted}\\s*\\(`);
    const callers = [];
    for (const file of files) {
      const callerRel = path.relative(repo, file).split(path.sep).join('/');
      if (isTestFile(callerRel)) continue;
      let body = '';
      try { body = stripComments(fs.readFileSync(file, 'utf8'), path.extname(file)); } catch { continue; }
      body = body.replace(declaration, 'export function __operational_definition__(');
      if (invocation.test(body)) callers.push(callerRel);
    }
    return { rel, symbol, state: callers.length ? 'wired' : 'unwired', callers };
  });
  return { rows };
}

export function audit({ repo = REPO, standalone = STANDALONE, held = HELD,
  operationalExports = REQUIRED_OPERATIONAL_EXPORTS } = {}) {
  const dupes = [];
  const seen = new Map();
  for (const [name, why] of standalone) {
    if (seen.has(name)) dupes.push(name); else seen.set(name, why);
  }

  const files = callerFiles(repo);
  const all = shippableModules(repo);
  const rows = [];
  for (const m of all) {
    if (seen.has(m.base)) { rows.push({ ...m, state: 'exempt', why: seen.get(m.base) }); continue; }
    if (held[m.base]) { rows.push({ ...m, state: 'held', why: held[m.base] }); continue; }
    const callers = callersOf(m, files, repo);
    let state = callers.length ? 'wired' : 'unwired';
    let why;
    // ADR-056: callers that are ONLY the package.json line defining the script are not automation.
    if (callers.length && callers.every((c) => c === 'package.json')) {
      let pkgSrc = '';
      try { pkgSrc = fs.readFileSync(path.join(repo, 'package.json'), 'utf8'); } catch { /* none */ }
      const names = npmScriptsNaming(pkgSrc, m.file);
      if (names.length) {
        const auto = npmScriptAutomated(names, files, repo);
        if (!auto.automated) {
          state = 'manual';
          const list = names.map((n) => `\`${n}\``).join(', ');
          why = `defined as npm script ${list} and invoked by NOTHING automated — reachable only by a `
            + `human typing \`npm run ${names[0]}\`. This wiring audit does not establish operational `
            + `correctness.`;
        }
      }
    }
    rows.push({ ...m, state, callers, ...(why ? { why } : {}) });
  }
  const operationalRows = operationalExportAudit({ repo, required: operationalExports }).rows;
  return { rows, operationalRows, dupes, inventory: all.length };
}

/**
 * ── WHAT CHANGED, 2026-07-24: TWO NEW CHECK CLASSES ─────────────────────────────────────────────
 *
 * This gate closes THE PREVIOUS GAP: everything above proves a MODULE has a CALLER — an import, a
 * require, an npm/yml `run:` line. That is the right predicate for a module. It is the wrong
 * predicate for a HOOK and for a LESSON, and three real instances found the seam on 2026-07-24:
 *
 *   1. scripts/capability-audit.mjs — a module with no caller. THIS gate already caught it (HELD,
 *      above). Proof the existing predicate works when the thing being checked really is a module.
 *   2. plugin/scripts/route-dispatch.sh — a PreToolUse gate, written 2026-07-13, never added to
 *      ~/.claude/settings.json. This gate MISSED it, because "wired" for a hook does not mean
 *      "some file mentions my filename" — hook-shim.mjs's dispatch table happens to quote every
 *      hook's filename, so the module predicate stumbles onto the right answer for anything shipped
 *      through hooks.json, BY COINCIDENCE OF QUOTING STYLE, and has ZERO visibility into
 *      ~/.claude/settings.json — the one file that proves a hook is actually LIVE on THIS machine
 *      rather than merely shipped in the plugin payload. That is a different question, and nothing
 *      above asked it.
 *   3. L16-parallel-by-default (~/.config/ruvnet-brain/lessons.json) — RATIFIED, taught FOUR times,
 *      and never once delivered in any session, because its trigger `choose-work` was never
 *      requested by any event in plugin/scripts/lesson-hooks.sh's dispatch table. A lesson's
 *      trigger is not a module either — no import, no require, nothing the predicate above can see.
 *
 * Same root failure as ADR-037's original defect (a gap in the shape of the exact bug the gate
 * exists to prevent), different surface. Two new, narrow predicates, each modelling the REAL
 * mechanism Claude Code / the lesson dispatcher actually uses, not a generic text search:
 *
 *   CHECK B — HOOK WIRING. Walks the real reachability chain for both supported hosts:
 *   plugin/hooks/hooks.json (Claude Code) → hook-shim.mjs's own TABLE (resolving its id-based
 *   indirection explicitly, since a hook id like "route-dispatch" is not the string
 *   "route-dispatch.sh"); and plugin/hooks/codex-hooks.json → bin/install.mjs's Stable Spine copy
 *   (codex-hook-wrapper.mjs installed as codex-hook.mjs) → codex-hook-adapter.mjs. It also reads
 *   this repo's own
 *   .claude/settings.json → the user's REAL ~/.claude/settings.json (what is actually installed on
 *   THIS machine — never checked before). One further hop is closed by a small fixed-point pass
 *   (the unprompted-speech runtime spawns anticipate.sh/lesson-hooks.sh as candidate producers),
 *   reusing this file's own invocation-shaped predicate (`callerPattern`/`stripComments`) but
 *   restricted to files already PROVEN reachable from a real hook entry point — not "does anything
 *   in the repo mention it", which is the weaker, accidentally-right-sometimes question above.
 *
 *   CHECK C — LESSON-TRIGGER WIRING. Every ratified/active lesson names a `trigger`
 *   (scripts/lesson-store.mjs's TRIGGERS enum). plugin/scripts/lesson-hooks.sh's
 *   `case "$EVENT" in` block is the single authority on which triggers any real Claude Code event
 *   actually requests. A trigger no branch requests is INERT — the store says armed, the machine
 *   says unconnected, exactly the L16 finding — and is reported loudly, by name, every run.
 *
 * BOTH checks read HOOK_PLUMBING/HOOK_HELD in the same spirit as STANDALONE/HELD above: explicit,
 * printed every run, a true reason required — never a silent exemption.
 *
 * THE --check DECISION, made deliberately (not a default carried over from the module check):
 *   • Check B (hook wiring) HARD-FAILS on a genuinely new unwired hook — same as an unwired module
 *     above, because a hook script IS a shippable module: this repo owns hooks.json, this repo's
 *     own .claude/settings.json, and (per HOOK_PLUMBING/HOOK_HELD) can name every known exception.
 *     kling-preflight.sh is the one PRE-EXISTING, already-documented gap (STANDALONE says the same
 *     thing above) — it is HELD, not unwired, so today's run does not break release.mjs for a
 *     condition this task did not introduce and was not asked to fix.
 *   • Check C (lesson triggers) is ADVISORY ONLY, NEVER fails --check, by deliberate design: the
 *     lesson store lives at ~/.config/ruvnet-brain/lessons.json (or $RUVNET_LESSON_STORE) — per-user,
 *     per-machine state OUTSIDE this repo. A fresh machine has none (loadLessons() degrades to []
 *     gracefully, not a failure). Hard-failing the ship path on the CONTENTS of a file the repo does
 *     not own, cannot reproduce in CI, and varies by whose machine runs it would gate a push on data
 *     that has nothing to do with the commit being shipped. It is reported loudly instead — printed
 *     every run, impossible to miss — which is the same bar HELD already sets for a known gap: never
 *     silent, never blocking.
 */

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd', 'PreCompact', 'Stop'];
const HOOK_EVENT_RE = new RegExp(`(${HOOK_EVENTS.join('|')})[^.\\n]{0,40}?\\b(hook|gate)\\b`, 'i');

/**
 * Files that MENTION a hook event in their header but are plumbing, not a hook body: a dispatcher, a
 * shared parser, a shared logger. Needed because the header heuristic below is deliberately loose —
 * hook-input.mjs's own header reads "the ONE parser every PreToolUse gate uses", which matches
 * "PreToolUse gate" exactly as a genuine self-declaration would. Same STANDALONE-style honesty bar:
 * explicit, printed every run, a TRUE reason — the fix for a heuristic false positive is a named
 * exception, not a cleverer regex that will just find the next false positive.
 */
const HOOK_PLUMBING = [
  ['hook-shim.mjs', 'the Stable Spine dispatcher — routes EVERY event via its own TABLE (parsed below); '
    + 'it is what hooks.json calls, not a single-event hook body itself'],
  ['hook-input.mjs', 'the shared JSON-payload parser "every PreToolUse gate uses" (its own words) — a '
    + 'library, never itself registered as a hook'],
  ['gate-receipt.sh', 'the shared receipt-logger a blocking gate calls just before it exits non-zero — a '
    + 'library, never itself registered as a hook'],
  ['unprompted-runtime.mjs', 'the unprompted-speech chokepoint (ADR-040) — registered once in hooks.json, '
    + 'and itself spawns anticipate.sh + lesson-hooks.sh as candidate producers; it is the runtime, not a '
    + 'single-purpose hook body'],
  ['update-apply.mjs', 'the Stable Spine writer — a human/nightly CLI (see STANDALONE above), not a hook body'],
];
const HOOK_PLUMBING_NAMES = new Set(HOOK_PLUMBING.map(([n]) => n));

/**
 * DELIBERATELY HELD, same bar as HELD above: a hook-intended script genuinely not reachable from
 * hooks.json or any settings.json today, and NOT a gap this check can silently close — the owner's
 * call, already recorded once (STANDALONE's kling-preflight entry above) and reproduced here so
 * --check does not fail the ship path on a pre-existing, already-documented, non-regression condition.
 */
const HOOK_HELD = {
  'kling-preflight.sh': 'PreToolUse (Bash) gate — ships inert by design (SECURITY.md), ownership moved to '
    + 'the Kling skill by ADR-0014 (confirmed live: a copy ships at '
    + '~/.claude/skills/klingai/scripts/kling-preflight.sh). Not currently wired into plugin/hooks/'
    + 'hooks.json, this repo\'s .claude/settings.json, or ~/.claude/settings.json — matching '
    + 'STANDALONE\'s own entry for this file above. Honestly dormant until a user opts in, not a silent '
    + 'gap this check introduces.',
};

/** Read+JSON.parse a file. null on ANY failure (missing, unreadable, malformed) — never throws. */
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Every `command` string inside a hooks.json / settings.json shaped `{ hooks: {...} }` document. */
function commandStrings(hooksNode) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      if (typeof node.command === 'string') out.push(node.command);
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(hooksNode);
  return out;
}

/** Plugin-script basenames (.mjs/.sh) mentioned literally in one command string. */
function basenamesIn(cmd) { return cmd.match(/[\w.-]+\.(?:mjs|sh)\b/g) || []; }

/** The hook-shim dispatch id passed as hook-shim.mjs's first CLI argument, if this command calls it. */
function hookShimIdIn(cmd) {
  const m = cmd.match(/hook-shim\.mjs["'`]?\s+([a-zA-Z][\w-]*)/);
  return m ? m[1] : null;
}

/** The dispatch id after Codex's inline bootstrap and numeric timeout. Same grammar as hook-registry. */
function codexHookIdIn(cmd) {
  const m = cmd.match(/"\s+\d+\s+([a-zA-Z][\w-]*)/);
  return m ? m[1] : null;
}

/**
 * Derive the Stable Spine wrapper copy from the installer source. The Codex manifest names the
 * durable installed target (`codex-hook.mjs`), while the repository inventory contains its source
 * (`codex-hook-wrapper.mjs`). Both names plus the actual copy operation must be present; otherwise
 * there is no proven bridge and the hook stays unwired.
 */
function installedCodexHookWrapper(repo) {
  let src = '';
  try { src = fs.readFileSync(path.join(repo, 'bin/install.mjs'), 'utf8'); } catch { return null; }
  const stripped = stripComments(src, '.mjs');
  const source = stripped.match(/hookWrapperSource\s*=\s*path\.join\([^\n]*['"]([\w.-]+\.mjs)['"]\)/)?.[1];
  const target = stripped.match(/const codexHookWrapperPath[\s\S]{0,260}?['"]([\w.-]+\.mjs)['"]\)/)?.[1];
  const copiesSource = /fs\.copyFileSync\(hookWrapperSource,\s*tmp\)/.test(stripped);
  return source && target && copiesSource ? { source, target } : null;
}

/** hook-shim.mjs's own dispatch TABLE: id -> file. Parsed, not re-implemented — it IS the authority. */
function hookShimTable(repo) {
  let src = '';
  try { src = fs.readFileSync(path.join(repo, 'plugin/scripts/hook-shim.mjs'), 'utf8'); } catch { return {}; }
  const map = {};
  const re = /'([\w-]+)':\s*{\s*file:\s*'([\w.-]+)'/g;
  let m; while ((m = re.exec(src))) map[m[1]] = m[2];
  return map;
}

/**
 * A hook body self-declares its event in its header — "a UserPromptSubmit hook", "PreToolUse gate on
 * Bash" — read from a handful of real headers in this repo (ADR-037's own convention: read a few
 * headers to see the shape). Deliberately loose; HOOK_PLUMBING above is the deliberate, honest
 * correction for where it over-fires, rather than a fragile attempt at a perfect regex.
 */
function hookHeaderDeclares(src) { return HOOK_EVENT_RE.test(src.slice(0, 1600)); }

/**
 * CHECK B — HOOK WIRING. See the file-level comment above for the full reasoning. Walks the real
 * chain from the real entry points (both plugin hook manifests, this repo's .claude/settings.json,
 * the user's actual ~/.claude/settings.json) through each host's real indirection, then closes one
 * further hop with a small fixed-point pass restricted to files already proven reachable.
 */
export function hookWiringAudit({
  repo = REPO,
  homeSettingsFile = path.join(os.homedir(), '.claude', 'settings.json'),
  held = HOOK_HELD,
} = {}) {
  const table = hookShimTable(repo);
  const codexWrapper = installedCodexHookWrapper(repo);
  const reached = new Map(); // basename -> Set(reason)
  const add = (name, reason) => {
    if (!name) return;
    if (!reached.has(name)) reached.set(name, new Set());
    reached.get(name).add(reason);
  };

  const scanConfig = (file, label, { codex = false } = {}) => {
    const doc = readJsonSafe(file);
    if (!doc || !doc.hooks) return;
    for (const cmd of commandStrings(doc.hooks)) {
      const basenames = basenamesIn(cmd);
      for (const b of basenames) add(b, label);
      const id = codex ? codexHookIdIn(cmd) : hookShimIdIn(cmd);
      if (id && table[id]) add(table[id], `${label} (${codex ? 'Codex dispatch' : 'hook-shim'} id "${id}")`);
      if (codex && codexWrapper && basenames.includes(codexWrapper.target)) {
        add(codexWrapper.source, `${label} via bin/install.mjs Stable Spine copy (${codexWrapper.target})`);
      }
    }
  };
  scanConfig(path.join(repo, 'plugin/hooks/hooks.json'), 'plugin/hooks/hooks.json');
  scanConfig(path.join(repo, 'plugin/hooks/codex-hooks.json'), 'plugin/hooks/codex-hooks.json', { codex: true });
  scanConfig(path.join(repo, '.claude/settings.json'), '.claude/settings.json (this repo)');
  scanConfig(homeSettingsFile, '~/.claude/settings.json (this machine)');

  // Fixed point: anything already reachable may itself spawn another plugin script by a real,
  // invocation-shaped reference — reusing the module check's own predicate, never a comment.
  const scriptsDir = path.join(repo, 'plugin/scripts');
  let all = [];
  try { all = fs.readdirSync(scriptsDir).filter((f) => /\.(mjs|sh)$/.test(f)); } catch { /* no dir */ }
  for (let i = 0; i < 10; i++) {
    let changed = false;
    for (const from of [...reached.keys()]) {
      let src = ''; try { src = fs.readFileSync(path.join(scriptsDir, from), 'utf8'); } catch { continue; }
      const stripped = stripComments(src, path.extname(from));
      for (const cand of all) {
        if (reached.has(cand)) continue;
        if (callerPattern(cand).test(stripped)) { add(cand, `spawned by plugin/scripts/${from}`); changed = true; }
      }
    }
    if (!changed) break;
  }

  const rows = [];
  for (const f of all) {
    if (HOOK_PLUMBING_NAMES.has(f)) continue; // plumbing, not a hook body — never part of the census
    let src = ''; try { src = fs.readFileSync(path.join(scriptsDir, f), 'utf8'); } catch { continue; }
    const declared = hookHeaderDeclares(src);
    const isReached = reached.has(f);
    if (!declared && !isReached) continue; // not hook-intended at all — outside the census
    if (isReached) rows.push({ file: f, state: 'wired', sources: [...reached.get(f)] });
    else if (held[f]) rows.push({ file: f, state: 'held', why: held[f] });
    else rows.push({ file: f, state: 'unwired' });
  }
  return { rows, plumbing: HOOK_PLUMBING };
}

/**
 * The trigger tokens requested by lesson-hooks.sh — the sole authority. A trigger reaches the gate
 * two ways: a static `case "$EVENT" in ... TRIGGERS="<name>"` label, or a dynamic conditional append
 * (`ARGS+=(--trigger <name>)`, e.g. `ship`, appended only when a live regex matches the real command
 * text). Reading only the static form means a trigger whose SOLE live path is dynamic is invisible
 * to this audit — and Check C would then depend on an unrelated dead case label merely coexisting in
 * the file to report it correctly, which breaks the moment that dead label is ever cleaned up.
 */
function lessonHooksRequestedTriggers(repo) {
  let src = '';
  try { src = fs.readFileSync(path.join(repo, 'plugin/scripts/lesson-hooks.sh'), 'utf8'); } catch { return new Set(); }
  const stripped = stripComments(src, '.sh');
  const requested = new Set();
  const re = /TRIGGERS="([^"]*)"/g;
  let m;
  while ((m = re.exec(stripped))) { for (const t of m[1].split(/\s+/)) if (t) requested.add(t); }
  const dynRe = /ARGS\+=\(--trigger\s+"?([A-Za-z][\w-]*)"?\)/g;
  while ((m = dynRe.exec(stripped))) { requested.add(m[1]); }
  return requested;
}

/**
 * CHECK C — LESSON-TRIGGER WIRING. See the file-level comment above for the full reasoning
 * (advisory-only, deliberately, because the store is per-user/per-machine state outside this repo).
 */
export function lessonTriggerAudit({ repo = REPO, lessonsFile = undefined } = {}) {
  const requested = lessonHooksRequestedTriggers(repo);
  const lessons = loadLessons(lessonsFile);
  const live = lessons.filter((l) => !l.demoted && (l.status === STATUS.RATIFIED || l.status === STATUS.ACTIVE));
  const labelOf = (trigger) => Object.values(TRIGGERS).find((t) => t.key === trigger)?.label || trigger;
  const inert = live
    .filter((l) => !requested.has(l.trigger))
    .map((l) => ({ id: l.id, trigger: l.trigger, label: labelOf(l.trigger) }));
  return { requested: [...requested], checked: live.length, inert };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).endsWith(`wired-check${path.extname(process.argv[1])}`);

if (invokedDirectly) {
  const { rows, operationalRows, dupes, inventory } = audit();
  const by = (s) => rows.filter((r) => r.state === s);
  const unwired = by('unwired');
  const operationalUnwired = operationalRows.filter((row) => row.state !== 'wired');

  const hookAudit = hookWiringAudit();
  const hookBy = (s) => hookAudit.rows.filter((r) => r.state === s);
  const hookUnwired = hookBy('unwired');

  const lessonAudit = lessonTriggerAudit();

  if (!argv.includes('--quiet')) {
    console.log(`\n  ${inventory} first-party module(s) in the inventory`);
    console.log(`    ${by('wired').length} wired · ${by('manual').length} manual · ${by('exempt').length} exempt · `
      + `${by('held').length} held · ${unwired.length} UNWIRED\n`);

    for (const u of unwired) console.log(`    ✗ ${u.rel}  — built, and invoked by nothing`);
    if (unwired.length) {
      console.log(`\n  A module with no caller is not a feature. Either wire it to a real user path,`);
      console.log(`  or add it to STANDALONE in this file WITH A TRUE REASON.\n`);
    }

    console.log(`  ${operationalRows.length} release-critical operational export(s) checked · `
      + `${operationalUnwired.length} UNWIRED\n`);
    for (const row of operationalUnwired) {
      console.log(`    ✗ ${row.rel}#${row.symbol} — exported, but no production invocation reaches it`);
    }
    if (operationalUnwired.length) {
      console.log('\n  Importing or re-exporting a function is not operation. A release-critical export must');
      console.log('  be invoked through a production path whose module is itself wired.\n');
    }

    // Every exemption, every run. v1 never printed these, so 3 false reasons rotted unseen for a
    // day inside the gate built to stop exactly that.
    if (by('manual').length) {
      console.log(`  ${by('manual').length} MANUAL — an npm script exists, but no automation runs it `
        + `(ADR-056; this is how the currency gate hid while reporting "wired"):\n`);
      for (const m of by('manual')) console.log(`    ▲ ${m.rel}\n       ${m.why}\n`);
    }
    console.log(`  ${by('exempt').length} exempt — no caller required, and why:\n`);
    for (const e of by('exempt')) console.log(`    ○ ${e.rel}\n       ${e.why}`);

    console.log(`\n  ${by('held').length} HELD — built, not wired, and the bar each must clear:\n`);
    for (const h of by('held')) console.log(`    ⏸ ${h.rel}\n       ${h.why}\n`);

    if (dupes.length) console.log(`  ✗ DUPLICATE exemption(s): ${dupes.join(', ')}\n`);

    // ── CHECK B: HOOK WIRING ──────────────────────────────────────────────────────────────────
    console.log(`\n  ── HOOK WIRING — plugin/scripts/*.sh|*.mjs vs plugin/hooks/{hooks,codex-hooks}.json, `
      + `.claude/settings.json, ~/.claude/settings.json ──\n`);
    console.log(`  ${hookAudit.rows.length} hook-intended script(s) in the census`);
    console.log(`    ${hookBy('wired').length} wired · ${hookBy('held').length} held · `
      + `${hookUnwired.length} UNWIRED\n`);

    for (const u of hookUnwired) {
      console.log(`    ✗ plugin/scripts/${u.file}  — declares a hook event and is invoked by nothing`);
    }
    if (hookUnwired.length) {
      console.log(`\n  A hook script nothing points at will never fire. Wire it into hooks.json or a`);
      console.log(`  settings.json, or add it to HOOK_HELD in this file WITH A TRUE REASON.\n`);
    }

    for (const h of hookBy('held')) console.log(`    ⏸ plugin/scripts/${h.file}\n       ${h.why}\n`);

    for (const w of hookBy('wired')) {
      console.log(`    ✓ plugin/scripts/${w.file}\n       via ${w.sources.join('; ')}`);
    }

    console.log(`\n  ${HOOK_PLUMBING.length} plumbing file(s) excluded from the census (dispatchers/`
      + `parsers/loggers, not hook bodies), and why:\n`);
    for (const [n, why] of HOOK_PLUMBING) console.log(`    ○ plugin/scripts/${n}\n       ${why}`);

    // ── CHECK C: LESSON-TRIGGER WIRING (advisory — see the file-level comment for why) ─────────
    console.log(`\n  ── LESSON-TRIGGER WIRING — ratified lessons vs plugin/scripts/lesson-hooks.sh's `
      + `case block ──\n`);
    console.log(`  ${lessonAudit.checked} ratified/active lesson(s) checked (requested triggers: `
      + `${lessonAudit.requested.join(', ') || '(none)'})`);
    console.log(`    ${lessonAudit.inert.length} INERT\n`);
    for (const l of lessonAudit.inert) {
      console.log(`    ✗ ${l.id}  — trigger "${l.trigger}" (${l.label}) is ratified but NO event `
        + `requests it; this lesson will NEVER be delivered`);
    }
    if (lessonAudit.inert.length) {
      console.log(`\n  ADVISORY ONLY — the lesson store is per-user machine state, not part of this`);
      console.log(`  repo, so this never fails --check. Fix by adding the trigger to a case branch in`);
      console.log(`  plugin/scripts/lesson-hooks.sh.\n`);
    }
  }

  const bad = unwired.length || operationalUnwired.length || dupes.length || hookUnwired.length;
  process.exit(argv.includes('--check') && bad ? 1 : 0);
}
