#!/usr/bin/env node
/**
 * RELEASE CONVERGENCE WATCHDOG — finishes issue #77 unattended, or does nothing at all.
 *
 * WHY THIS EXISTS. On 2026-08-06 the published surfaces named different generations (npm 4.0.12,
 * GitHub releases/latest v4.0.7). The cause was not drift: the release rail was dead three
 * independent ways, each fatal alone, and with the rail dead every release was made by hand — which
 * is how the surfaces came apart in the first place. All three are fixed. What remained was a
 * GitHub Actions MAJOR OUTAGE ("workflow runs are still failing or delayed in starting"), and the
 * publisher is an Actions workflow, so the last step could not run and the maintainer was leaving
 * for a month.
 *
 * WHAT IT WILL NOT DO. It does not publish. `scripts/self-update.mjs:56` refuses `--publish` and
 * only `protected-release.yml` may create a release, publish npm, or move a dist-tag. This script
 * DISPATCHES that workflow — the sanctioned path — and never substitutes for it. Every safety gate
 * (exact-SHA evidence, clean worktree, release-proof, host verification, post-publication seal)
 * still runs inside the workflow exactly as designed. Bypassing them to "get it done while nobody
 * is looking" would be the worst possible reading of an instruction to finish the job.
 *
 * IT IS A NO-OP UNLESS EVERY PRECONDITION HOLDS. It runs from the nightly, unattended, for weeks.
 * A watchdog that acts on a partial picture is worse than no watchdog, so it refuses on anything
 * unexpected and says why. The default outcome is "nothing happened, here is the reason".
 *
 *   node scripts/release-convergence-watchdog.mjs           # report only, never acts
 *   node scripts/release-convergence-watchdog.mjs --dispatch # act, but only if ALL gates pass
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const DISPATCH = process.argv.includes('--dispatch');
const REPO = 'stuinfla/ruvnet-brain';

const log = (s) => process.stdout.write(`[release-watchdog] ${s}\n`);
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000, ...opts }).trim();
const tryShy = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

/** Refuse loudly and exit 0 — a watchdog that exits non-zero would page someone every night. */
function stand_down(reason) {
  log(`STAND DOWN: ${reason}`);
  log('no action taken. This is the expected outcome on most nights.');
  process.exit(0);
}

// ── 1. Is there anything to converge? ────────────────────────────────────────────────────────────
const npmLatest = tryShy(() => sh('npm', ['view', 'ruvnet-brain', 'dist-tags.latest']));
const ghLatest = tryShy(() => sh('gh', ['release', 'view', '--repo', REPO, '--json', 'tagName', '-q', '.tagName']));
if (!npmLatest || !ghLatest) stand_down(`could not read published surfaces (npm=${npmLatest} github=${ghLatest})`);

const ghVersion = ghLatest.replace(/^v/, '');
log(`npm dist-tags.latest = ${npmLatest} · GitHub releases/latest = ${ghLatest}`);
if (npmLatest === ghVersion) {
  log(`CONVERGED — both surfaces name ${npmLatest}. Issue #77's invariant holds; nothing to do.`);
  process.exit(0);
}

// ── 2. Can the publisher even run? ───────────────────────────────────────────────────────────────
// The whole reason this script exists. Dispatching into a broken Actions plane burns a candidate and
// leaves a confusing failed run behind for a maintainer who is not here to read it.
const running = tryShy(() => sh('gh', ['run', 'list', '--repo', REPO, '--limit', '20', '--json', 'status',
  '-q', '[.[]|select(.status=="in_progress")]|length']), '0');
const queued = tryShy(() => sh('gh', ['run', 'list', '--repo', REPO, '--limit', '40', '--json', 'status',
  '-q', '[.[]|select(.status=="queued")]|length']), '0');
if (Number(running) === 0 && Number(queued) > 3) {
  stand_down(`Actions appears stalled (${running} running, ${queued} queued) — likely still the outage. Will retry tomorrow.`);
}

// ── 3. Everything else must already be resolved. ─────────────────────────────────────────────────
const openPrs = tryShy(() => sh('gh', ['pr', 'list', '--repo', REPO, '--state', 'open', '--json', 'number', '-q', 'length']), '?');
if (openPrs !== '0') stand_down(`${openPrs} open PR(s) — merge them before cutting a release, so the release contains them`);

const dirty = tryShy(() => sh('git', ['status', '--porcelain']), 'unknown');
if (dirty === 'unknown' || dirty.split('\n').filter((l) => l && !l.startsWith('??')).length) {
  stand_down('working tree is dirty — release candidates must come from a clean worktree');
}

sh('git', ['fetch', 'origin', '--quiet']);
const head = sh('git', ['rev-parse', 'HEAD']);
const originMain = sh('git', ['rev-parse', 'origin/main']);
if (head !== originMain) stand_down(`local HEAD ${head.slice(0, 7)} != origin/main ${originMain.slice(0, 7)}`);

// ── 4. The candidate must BE a release candidate. ────────────────────────────────────────────────
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/.claude-plugin/plugin.json'), 'utf8')).version;
if (/-dev$/.test(version)) {
  // Deliberate: promoting -dev to clean means writing a release commit, and that is an authoring
  // decision (which generation ships, with what narrative) — not something a nightly should invent.
  stand_down(`main carries ${version}; a release needs a clean version in a release(<version>) commit. Authoring that is a human/session decision, not a watchdog's.`);
}
const subjects = sh('git', ['log', '-25', '--pretty=%s']).split('\n');
if (!subjects.some((s) => /^release\s*\(/i.test(s) && s.includes(version))) {
  stand_down(`clean version ${version} present but no release(${version}) commit in recent history`);
}

// ── 5. Exact-SHA evidence must exist and be green. ───────────────────────────────────────────────
const runsFor = (wf) => JSON.parse(tryShy(() => sh('gh', ['run', 'list', '--repo', REPO, '--workflow', wf,
  '--limit', '20', '--json', 'databaseId,status,conclusion,headSha']), '[]'));
const greenAt = (wf) => runsFor(wf).find((r) => r.headSha === originMain && r.conclusion === 'success');

const ci = greenAt('ci');
const aggregate = greenAt('release-aggregate');
if (!ci) stand_down(`no successful exact-SHA \`ci\` run at ${originMain.slice(0, 7)} yet`);
if (!aggregate) stand_down(`no successful exact-SHA \`release-aggregate\` run at ${originMain.slice(0, 7)} yet`);

log(`ALL GATES PASS — candidate=${originMain.slice(0, 7)} version=${version} ci=${ci.databaseId} aggregate=${aggregate.databaseId}`);
if (!DISPATCH) {
  log('report-only mode; pass --dispatch to actually invoke the protected release workflow.');
  process.exit(0);
}

// ── 6. Dispatch THE SANCTIONED PUBLISHER. Nothing here publishes; the workflow does. ─────────────
sh('gh', ['workflow', 'run', 'protected-release.yml', '--repo', REPO,
  '-f', `candidate_sha=${originMain}`,
  '-f', `version=${version}`,
  '-f', `release_qe_run_id=${ci.databaseId}`,
  '-f', `aggregate_run_id=${aggregate.databaseId}`]);
log(`DISPATCHED protected-release for ${version}. The workflow owns every safety gate from here.`);
log('Verify afterwards with: node scripts/published-surface-probe.mjs (D-version-coherence must PASS).');
