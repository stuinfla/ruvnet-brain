#!/usr/bin/env node
// self-update.mjs — nightly evergreen driver.
// Compares each in-scope repo's live HEAD against the stamped manifest, then (re)builds the segments
// that changed and re-stamps. Dry-run by default; pass --apply to actually (re)build.
//
//   node scripts/self-update.mjs                 # dry-run: print the rebuild plan
//   node scripts/self-update.mjs --apply         # rebuild stale/pending repos (serial; embedding is CPU-bound)
//   node scripts/self-update.mjs --apply --tier T0   # limit scope
//   node scripts/self-update.mjs --apply --repo ruflo
//
// Publication is intentionally NOT supported here. A scheduled or local rebuild may prepare
// candidate bytes, but only the protected release workflow may publish them after release-proof
// seals the exact clean SHA and packed-artifact digest.
//
// Designed to be invoked by deploy/com.ruvnet.brain-nightly.plist (LaunchAgent — NOT auto-installed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FULL_HINTS, KEEP_DIRS } from './full-hints.mjs';
import { withSubmoduleSymlinksDetached } from './git-clone-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// launchd delivers a minimal PATH, and the plist-level export has now failed across TWO separate
// reloads for TWO separate reasons: (2026-07-10) `gh release create` ENOENT, pid 0, while the
// loaded plist showed the export; (2026-07-12) launchd's WorkingDirectory was unset entirely so
// the job never even reached this file. Both are now fixed at the plist level too, but the script
// guarantees its own environment regardless: /usr/local/bin FIRST (that's the node every build
// tonight was tested and gated against — 22.13.1; homebrew independently upgraded to 25.9.0,
// which cannot load kb/'s native @ruvector/rvf module) and every spawned tool resolved to an
// absolute path, never bare-name PATH lookup — a bare `node`/`gh` silently picks up whichever
// version macOS or homebrew put first, and that has now broken this pipeline twice.
process.env.PATH = ['/usr/local/bin', '/opt/homebrew/bin', process.env.PATH || ''].join(':');
const GH = ['/usr/local/bin/gh', '/opt/homebrew/bin/gh'].find((p) => fs.existsSync(p)) || 'gh';
const NODE = ['/usr/local/bin/node', '/opt/homebrew/bin/node'].find((p) => fs.existsSync(p)) || process.execPath;
// Fourth instance of the same disease: kb/resolve-deps.mjs's loadRvf()/loadTransformers() fall
// back to NODE_PATH / bare require() resolution, which only works when the invoking shell's rc
// files happened to export it — true for an interactive login shell, silently false for launchd's
// bash -lc (non-interactive, so any `[[ $- != *i* ]] && return`-style guard in .bash_profile skips
// the rest of the file). Never depend on ambient shell state for a scheduled job again: pin both
// deps to their real, verified absolute locations via resolve-deps.mjs's own explicit overrides.
if (!process.env.RVF_MODULE_PATH && fs.existsSync('/Users/stuartkerr/.npm-global/lib/node_modules/@ruvector/rvf')) {
  process.env.RVF_MODULE_PATH = '/Users/stuartkerr/.npm-global/lib/node_modules';
}
if (!process.env.XENOVA_PATH && fs.existsSync('/Users/stuartkerr/.npm-global/node_modules/@xenova/transformers')) {
  process.env.XENOVA_PATH = '/Users/stuartkerr/.npm-global/node_modules/@xenova/transformers';
}
const has = (f) => process.argv.includes(f);
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const APPLY = has('--apply');
const TIER = arg('--tier', null);
const ONLY = arg('--repo', null);
if (has('--publish')) {
  console.error('[release-authority] DENIED: self-update is rebuild-only; --publish cannot create a GitHub Release, publish npm, move a dist-tag, push a release commit, or label anything shipped.');
  console.error('[release-authority] Use the protected release workflow after release-proof seals the exact clean SHA and packed-artifact digest.');
  process.exit(2);
}
// --publish's whole job is to end this run with `git commit` + `git push origin main` (see the
// PUBLISH block far below) — and those two commands operate on whatever branch is CURRENTLY
// CHECKED OUT in this working tree, not necessarily main. Real failure (2026-07-19): the nightly
// fired at 03:15 while a developer had feat/meta-proxy-passthrough checked out, and commit 4a10833
// "Nightly brain refresh v3.4.21-dev" landed silently on THAT branch — a version-bump commit no
// release will ever be cut from, stranded on top of someone's unrelated in-progress work.
// Guard here, before ANY of the (hours-long, CPU-bound) rebuild work below even starts, and before
// the GitHub Release / npm publish steps run — checking branch only at commit-time would still
// burn a full night's rebuild, or worse, leave a Release cut with no matching version-bump commit
// to go with it. We deliberately do NOT `git checkout main` to self-correct: this machine is
// routinely mid-task on a feature branch at 03:15 (that is exactly how this bug was found), and
// switching branches out from under someone's uncommitted work is precisely the "clever and
// destructive" move this repo has already been burned by once (see the -readonly/timeout lesson in
// CLAUDE.md Rule 19). An aborted nightly that logs clearly and reruns tomorrow costs nothing; a
// checkout that clobbers a developer's working tree cannot be undone.
// ── THE BRANCH GUARD IS GONE, AND THAT IS THE FIX (2026-07-24) ──────────────────────────────────
//
// It used to FATAL here when ROOT was not on main. That guard was CORRECT for what it knew: these
// git commands act on whatever branch is checked out, and on 2026-07-19 that stranded commit 4a10833
// on feat/meta-proxy-passthrough. Refusing beat clobbering a developer's working tree.
//
// But refusing had a cost nobody was watching. This file is the ONLY thing that cuts GitHub Releases
// (`release.mjs --publish` does npm and contains zero `gh release` calls). So on 2026-07-23 the
// nightly hit this guard — the repo was on branch 4.0 — aborted correctly, and the release channel
// froze at v3.9.18-dev while npm advanced to 3.9.50. Thirty-two versions of drift produced by a guard
// working exactly as designed, invisible because the channel verifier only checked the bundle was
// REACHABLE, never that it was CURRENT.
//
// The dilemma was false. It only existed because the version commit ran in ROOT. It now runs in a
// worktree pinned to origin/main (see the PUBLISH block), so the developer's tree is never touched
// AND the release is never blocked by what they have checked out. Neither horn, rather than a better
// choice between them.
//
// Nothing replaces this check because nothing needs to: ROOT's branch is now irrelevant to publishing.
// If the worktree cannot be prepared, THAT fails loudly and refuses to fall back to committing in
// ROOT — the guarantee this guard existed to provide, kept, without the outage it caused.
// --fresh-window <days>: LIVE-scan the org(s) and take every non-fork/non-archived repo pushed within
// N days, bypassing the static registry.tiers.json AND the nightly T3 skip. This is THE fix for
// "new repos rUv shipped never got ingested" — a brand-new repo is discovered and built the same night
// it appears, but only within the rolling window, so the old "days of compute for all 173" risk that the
// tier gate guarded against still cannot happen. Absent this flag, scoping is byte-for-byte unchanged.
const FRESH_WINDOW = arg('--fresh-window', null);
const MODEL_CACHE = process.env.KB_MODEL_CACHE || path.join(ROOT, 'kb', 'models-cache');

// Optional author-side clone overrides via env (JSON map); default empty → uses CLONE_DIR/<name>.
const KNOWN_CLONES = JSON.parse(process.env.RUVNET_KNOWN_CLONES || '{}');
const CLONE_DIR = path.join(ROOT, 'clones');
// --full / --keep depth config per repo: SHARED map in scripts/full-hints.mjs (also used by
// ingest-repo.mjs, which previously had NO hints and silently zeroed full-body indexing on any
// rebuild routed through it). History + derivation rationale preserved in that file.

const tiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/registry.tiers.json'), 'utf8'));
const manifest = fs.existsSync(path.join(ROOT, 'data/manifest.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data/manifest.json'), 'utf8')) : { builtRepos: [] };
// case-insensitive: registry names are capitalized (RuVector) but built artifacts are lowercase (ruvector)
const builtSha = Object.fromEntries(manifest.builtRepos.map((r) => [r.name.toLowerCase(), r.builtFromSha]));

// owner/repo default to 'ruvnet'/<name> so existing registry entries (no owner/repo field) are
// unaffected; a repo living outside the ruvnet org (e.g. a different GitHub org) sets both.
const remoteHead = (owner, slug) => {
  try { return execFileSync('git', ['ls-remote', `https://github.com/${owner}/${slug}`, 'HEAD'], { timeout: 30000 }).toString().split(/\s/)[0] || null; }
  catch { return null; }
};
const clonePath = (name) => KNOWN_CLONES[name] || path.join(CLONE_DIR, name);

let inScope = [];
if (FRESH_WINDOW) {
  const days = parseInt(FRESH_WINDOW, 10);
  if (!Number.isFinite(days) || days <= 0) { console.error(`--fresh-window needs a positive day count, got "${FRESH_WINDOW}"`); process.exit(2); }
  const cutoff = Date.now() - days * 86400 * 1000;
  const orgs = (process.env.RUVNET_FRESH_ORGS || 'ruvnet').split(',').map((s) => s.trim()).filter(Boolean);
  let orgFailures = 0;
  for (const org of orgs) {
    let rows;
    try {
      rows = JSON.parse(execFileSync(GH, ['repo', 'list', org, '--limit', '1000', '--json', 'name,pushedAt,isFork,isArchived'], { timeout: 60000 }).toString());
    } catch (e) { orgFailures++; console.error(`[fresh-window] gh repo list ${org} FAILED: ${e.message} — skipping org (nothing from it this run)`); continue; }
    for (const r of rows) {
      if (r.isFork || r.isArchived) continue;
      if (new Date(r.pushedAt).getTime() < cutoff) continue;
      inScope.push({ name: r.name, owner: org, repo: r.name, tier: `${days}d`, pushedAt: r.pushedAt });
    }
  }
  if (ONLY) inScope = inScope.filter((r) => r.name === ONLY);
  // FENCE: deliberately-removed (helix — a downstream consumer app) + empty repos must NOT be silently
  // re-added by the rolling window. data/nightly-exclude.json is the one editable list; every drop logged.
  const exPath = path.join(ROOT, 'data/nightly-exclude.json');
  if (fs.existsSync(exPath)) {
    try {
      const exSet = new Set((JSON.parse(fs.readFileSync(exPath, 'utf8')).exclude || []).map((s) => String(s).toLowerCase()));
      const dropped = inScope.filter((r) => exSet.has(r.name.toLowerCase())).map((r) => r.name);
      inScope = inScope.filter((r) => !exSet.has(r.name.toLowerCase()));
      if (dropped.length) console.log(`[fresh-window] fenced out ${dropped.length}: ${dropped.join(', ')} (data/nightly-exclude.json)`);
    } catch (e) { console.error(`[fresh-window] nightly-exclude.json unreadable (${e.message}) — proceeding WITHOUT fence`); }
  }
  console.log(`[fresh-window] live scan of [${orgs.join(', ')}] → ${inScope.length} repos in scope after fence, pushed since ${new Date(cutoff).toISOString().slice(0, 10)} (${days}d window)`);
} else {
  for (const t of ['T0', 'T1', 'T2', 'T3']) {
    if (TIER && t !== TIER) continue;
    for (const r of tiers.tiers[t].repos) {
      if (ONLY && r.name !== ONLY) continue;
      if (t === 'T3' && !ONLY) continue;            // T3 is deep-walked on demand, not nightly
      inScope.push({ ...r, tier: t });
    }
  }
}

const plan = [];
// DERIVED, not asserted (F4, 2026-07-18): remoteHead() returns null on ANY probe failure, and the
// old planner labeled a null-probe repo "up-to-date" — so a network-dark nightly (GitHub unreachable,
// DNS down, token dead) produced an empty todo, exit 0, and the wrapper logged "CLEAN NO-OP" while
// having measured NOTHING. That is the exact "blind tool reports health" bug stack-sync.mjs kills
// with its registry guard. Now: an individually-failed probe is labeled 'unverified (probe failed)' —
// never "up-to-date", never triggering a rebuild — and if HALF OR MORE of the probes failed the run
// REFUSES to claim anything (exit 1), letting the wrapper's retry + escalation do their job.
let probeFailures = 0;
for (const r of inScope) {
  // `r.org` is read as well as `r.owner`, because the registry uses BOTH spellings and reading only
  // one silently mis-resolves the other. MEASURED 2026-07-24: agentic-qe carries org:
  // "proffesor-for-testing", the code read r.owner (undefined), fell through to the 'ruvnet' default,
  // and probed github.com/ruvnet/agentic-qe — which 404s. The repo was reported "unverified (probe
  // failed)" on every single run, which reads as "the remote is down" when the truth was that we
  // asked about a repository that does not exist. Live check: ruvnet/agentic-qe -> 404,
  // proffesor-for-testing/agentic-qe -> 200.
  const live = remoteHead(r.owner || r.org || 'ruvnet', r.repo || r.name);
  if (live === null) probeFailures++;
  const built = builtSha[r.name.toLowerCase()] || null;
  let action = 'up-to-date';
  if (!built) action = 'build (new)';
  // 'unknown' stamped SHA cannot prove freshness — treat as changed whenever upstream is reachable.
  // (Real bug: ruflo + agentic-flow were stamped unknown and therefore NEVER auto-rebuilt — the two
  // most-central repos were invisible to the freshness loop until a 3.24 release exposed it.)
  else if (built === 'unknown') action = live ? 'rebuild (changed)' : 'unverified (probe failed)';
  else if (live === null) action = 'unverified (probe failed)';
  else if (live !== built) action = 'rebuild (changed)';
  plan.push({ name: r.name, owner: r.owner, repo: r.repo, tier: r.tier, built: built?.slice(0, 12) || '—', live: live?.slice(0, 12) || '?', action });
}
if (inScope.length > 0 && probeFailures * 2 >= inScope.length) {
  console.error(`\n[blind-guard] ${probeFailures}/${inScope.length} freshness probes FAILED — refusing to claim "up-to-date" for anything. This run measured nothing; that is a failure, not a no-op.`);
  process.exit(1);
}
if (typeof orgFailures !== 'undefined' && orgFailures > 0 && inScope.length === 0) {
  console.error(`\n[blind-guard] every org listing failed (${orgFailures}) and nothing is in scope — cannot distinguish "nothing fresh" from "completely blind". Failing loudly.`);
  process.exit(1);
}

console.log(`self-update ${APPLY ? '(APPLY)' : '(dry-run)'} — ${plan.length} repos in scope\n`);
for (const p of plan) console.log(`  ${p.action.padEnd(20)} ${p.tier} ${p.name.padEnd(24)} built:${p.built}  live:${p.live}`);
// SAFE NIGHTLY SCOPE: by default only REBUILD already-built repos whose upstream changed (keeps the
// shipped bundle current). Building brand-new repos is a supervised, multi-hour scaling effort, NOT an
// unattended nightly job — gate it behind --include-new so the cron can't silently try to deep-walk 40+
// repos (days of compute) on its first run.
// Fresh-window mode exists precisely to discover + build brand-new repos, so default INCLUDE_NEW on
// there (still bounded to the N-day set). Static-tier mode keeps the original opt-in gate untouched.
const INCLUDE_NEW = has('--include-new') || !!FRESH_WINDOW;
const changed = plan.filter((p) => p.action === 'rebuild (changed)');
const newRepos = plan.filter((p) => p.action === 'build (new)');
const todo = INCLUDE_NEW ? [...changed, ...newRepos] : changed;
console.log(`\nrebuild(changed): ${changed.map((p) => p.name).join(', ') || 'none'}`);
console.log(`new(not built): ${newRepos.length} repos${INCLUDE_NEW ? ' — INCLUDED (--include-new)' : ' — SKIPPED (supervised; pass --include-new to build)'}`);
console.log(`→ this run will (re)build ${todo.length}: ${todo.map((p) => p.name).join(', ') || 'none'}`);

if (!APPLY) {
  console.log('\n(dry-run — pass --apply to (re)build; runs serially since embedding is CPU-bound)');
  // Sol amendment to F4: even a dry-run may not report clean (exit 0) when probes failed — the
  // "CLEAN NO-OP" the wrapper logs on exit 0 must mean "measured everything, nothing due".
  if (probeFailures > 0) { console.error(`[blind-guard] ${probeFailures} probe(s) failed — dry-run cannot certify freshness; exiting 1`); process.exit(1); }
  process.exit(0);
}

const NOTIFY = (t, m, p) => { try { execFileSync('sh', [path.join(ROOT, 'scripts/notify.sh'), t, m, p || 'default']); } catch { /* alerting never breaks the pipeline */ } };

// ---- child steps that can explain themselves -------------------------------------------------
// With stdio:'inherit' a failing child's Error carries NO output: e.stdout and e.stderr are both
// null and e.message is only "Command failed: <argv>" (verified 2026-08-06). That empty reason is
// what propagated into the [FATAL] summary, which is in turn what nightly-wrapper.sh samples for
// the escalation — so six identical nightly failures escalated saying nothing, while the log had
// the answer the whole time.
//
// Capture, then RE-EMIT verbatim so the log is byte-identical to what stdio:'inherit' produced,
// and keep a tail for the failure record.
//   captureStdout=false (clone/fetch/reset/symbols): stdout stays inherited so those steps stream
//     live and survive a kill; only stderr is buffered (small: stacks and warnings).
//   captureStdout=true  (every step that carries a corpus-QA verdict — [refresh] and [qa]): BOTH
//     streams, because corpus-qa prints its verdict table and every '↳ <reason>' line via
//     console.log — i.e. on STDOUT. Capturing stderr alone would have captured nothing for the
//     exact failure this exists to explain. Measured output is ~34 lines/step, so it costs nothing.
const STEP_TAIL_LINES = 14;
function runStep(label, file, args, opts = {}, { captureStdout = false } = {}) {
  const r = spawnSync(file, args, {
    ...opts,
    stdio: ['inherit', captureStdout ? 'pipe' : 'inherit', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.stdout?.length) process.stdout.write(r.stdout);
  if (r.stderr?.length) process.stderr.write(r.stderr);
  if (r.error) { r.error.step = label; throw r.error; }
  if (r.status !== 0) {
    const tail = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]).toString()
      .split('\n').map((l) => l.trim()).filter(Boolean).slice(-STEP_TAIL_LINES).join(' | ');
    const err = new Error(`${label} exited ${r.status}${tail ? ` — ${tail}` : ' — (child produced no output)'}`);
    err.step = label;
    err.status = r.status;
    err.output = tail;
    throw err;
  }
}
const failures = []; // per-repo build failures collected here; ANY failure aborts before publish (see below)
for (const p of todo) {
  const dir = clonePath(p.name);
  try {
    if (!fs.existsSync(path.join(dir, '.git'))) {
      console.log(`[clone] ${p.name}`);
      fs.mkdirSync(CLONE_DIR, { recursive: true });
      runStep(`[clone] ${p.name}`, 'git', ['clone', '--depth', '1', `https://github.com/${p.owner || p.org || 'ruvnet'}/${p.repo || p.name}`, dir]);
    } else {
      // Some cached clones deduplicate large submodules with symlinks to another clone. Git refuses
      // even a fetch when a gitlink path is a symlink ("expected submodule path ... not to be a
      // symbolic link"). Detach only those declared submodule symlinks for fetch/reset, then restore
      // them in finally so a network/reset failure cannot strand the cache in a half-repaired state.
      withSubmoduleSymlinksDetached(dir, () => {
        runStep(`[fetch] ${p.name}`, 'git', ['-C', dir, 'fetch', '--depth', '1', 'origin']);
        runStep(`[reset] ${p.name}`, 'git', ['-C', dir, 'reset', '--hard', 'origin/HEAD']);
      });
    }
    const env = { ...process.env, KB_MODEL_CACHE: MODEL_CACHE };
    const kb = p.name.toLowerCase();                 // artifacts are lowercase (ruvector.rvf), registry name is RuVector
    const full = FULL_HINTS[kb];
    const keep = KEEP_DIRS[kb];
    const buildArgs = ['forge-refresh.mjs', '--repo', dir, '--out', '.', '--name', kb,
      '--canonical-url', process.env.RUVNET_CANONICAL_URL || 'https://raw.githubusercontent.com/stuinfla/ruvnet-brain/main/kb'];
    if (full) buildArgs.push('--full', full);
    if (keep) buildArgs.push('--keep', keep);
    console.log(`[refresh] ${kb}`);
    // captureStdout: forge-refresh runs corpus-qa against its CANDIDATE dir and refuses to promote
    // on a FAIL — so this step, not the [qa] step below, is where the six 2026-08-03..08-06 nightly
    // failures actually died, and the verdict table naming the offending chunk is on ITS stdout.
    // Steps produce ~34 lines at most (largest measured [refresh] section in logs/nightly.log), so
    // buffering costs nothing; the tradeoff is that the log flushes at step end rather than live.
    runStep(`[refresh] ${kb}`, NODE, buildArgs, { cwd: path.join(ROOT, 'kb'), env }, { captureStdout: true });
    console.log(`[symbols] ${kb}`);
    runStep(`[symbols] ${kb}`, NODE, ['scripts/build-symbols.mjs', '--name', kb], { cwd: ROOT, env });
    // Corpus QA gate (scripts/corpus-qa.mjs): structural (passages>0, full-bodies>0 where
    // FULL_HINTS demands them, vectors==passages, embed.json present) + deterministic
    // self-retrieval round trip on every canonical store. Non-zero exit throws -> failures[] ->
    // the run aborts before stamp/bundle/publish. This is the machine version of the
    // 2026-07-10 hand-verification: a store that embeds wrong or reads wrong cannot ship.
    console.log(`[qa] ${kb}`);
    // captureStdout: corpus-qa's verdict table and its '↳ <reason>' lines go to stdout.
    runStep(`[qa] ${kb}`, NODE, ['scripts/corpus-qa.mjs', '--store', kb], { cwd: ROOT, env }, { captureStdout: true });
  } catch (e) {
    console.error(`[FAIL] ${p.name}: ${e.message}`);
    failures.push({ name: p.name, step: e.step || '(unknown step)', error: e.message, reason: e.output || '' });
  }
}

// A per-repo build failure used to be logged and swallowed before the run re-stamped and re-bundled
// partial data. Fail loud: if ANY repo failed, abort before stamp/bundle. This rebuild process has no
// publication authority; a later protected release may consume only a fully prepared candidate.
if (failures.length) {
  // Carry the REASON, not just the count. The wrapper samples this block's tail for the push
  // escalation, so whatever is not printed here is not in the alert either.
  const first = failures[0];
  NOTIFY('🔴 Nightly brain rebuild ABORTED',
    `${failures.length} repo build(s) failed — no candidate prepared. First: ${first.name} ${first.step} — ${first.reason || first.error}`,
    'urgent');
  console.error(`\n[FATAL] ${failures.length} repo build(s) failed this run — aborting before stamp/bundle. No candidate prepared:`);
  for (const f of failures) {
    console.error(`  - ${f.name} ${f.step}: ${f.error}`);
    if (f.reason) console.error(`      reason: ${f.reason}`);
  }
  console.error('Fix the failing repo(s) and re-run.');
  process.exit(1);
}

console.log('\n[stamp] re-stamping bundle');
execFileSync(NODE, ['scripts/brain-stamp.mjs'], { cwd: ROOT, stdio: 'inherit' });
// refresh the shipped bundle so the rebuilt deep-source ships (concepts/primers/L2 are supervised — not regenerated here)
console.log('[bundle] re-assembling dist/ruvnet-brain');
execFileSync(NODE, ['scripts/build-bundle.mjs'], { cwd: ROOT, env: { ...process.env, KB_MODEL_CACHE: MODEL_CACHE }, stdio: 'inherit' });
console.log('self-update done. (Deep-source refreshed + bundle re-assembled. Primer/L2/concepts + grading are supervised steps — re-run them when a repo materially changes.)');

// Sol amendment to F4 (end of run): the verified rebuilds above are real work and were NOT
// skipped — but if any freshness probe failed, this run still may not report clean. Exit 1 AFTER the
// work so the wrapper's retry re-probes (rebuilds are change-gated, so the retry is cheap) and a
// persistent blind spot escalates instead of hiding inside a green "no-op".
if (typeof probeFailures !== 'undefined' && probeFailures > 0) {
  console.error(`\n[blind-guard] run completed its verified work, but ${probeFailures} freshness probe(s) FAILED — those repos are 'unverified', not 'up-to-date'. Exiting 1 so the failure is visible.`);
  process.exit(1);
}
