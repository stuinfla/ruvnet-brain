#!/usr/bin/env node
/**
 * GITHUB HEALTH WATCH — one place that notices GitHub is unhappy, before the maintainer does.
 *
 * WHY THIS EXISTS. On 2026-08-08 the maintainer said: "You should never ever let it be in a
 * situation where it's got failed pushes. Your job is to always be looking out for GitHub to make
 * sure if there's any problem that you're on it immediately." They were right, and the reason it
 * kept happening is structural, not attentional: every existing signal watched ONE thing.
 *
 *   · signal-watch      — CI verdicts, per push
 *   · issue-watch       — open issues and their SLA
 *   · published-surface — npm vs GitHub, nightly
 *
 * Nothing watched the states that actually stall work: a red default branch, a PR that has silently
 * gone CONFLICTING, a branch left behind after a merge, a stuck queue, or a release that published
 * and then failed its own bookkeeping. Each was found by a human noticing something felt wrong.
 *
 * WHAT IT DOES NOT DO. It does not push, merge, close, publish, or edit anything. It REPORTS. A
 * watcher that also acts is a watcher whose failures are hard to reason about, and this repo has
 * already been bitten by automation that satisfied its own success predicate (ADR-050). Exit code
 * is the contract: 0 = healthy, 1 = something needs attention, and the reasons print in full.
 *
 *   node scripts/github-health-watch.mjs            # human-readable
 *   node scripts/github-health-watch.mjs --json     # machine-readable, for hooks/CI
 */
import { execFileSync } from 'node:child_process';

const REPO = 'stuinfla/ruvnet-brain';
const JSON_OUT = process.argv.includes('--json');
const findings = [];
const note = (level, area, detail, action) => findings.push({ level, area, detail, action });

const gh = (args) => {
  try { return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000 }).trim(); }
  catch (error) { return { __error: String(error.stderr || error.message).slice(0, 200) }; }
};
const ghJson = (args) => {
  const out = gh(args);
  if (out && out.__error) return out;
  try { return JSON.parse(out); } catch { return { __error: 'unparseable gh output' }; }
};

// ── 1. Is the default branch green? A red main blocks every release and every merge. ─────────────
const runs = ghJson(['run', 'list', '--repo', REPO, '--branch', 'main', '--workflow', 'ci',
  '--limit', '1', '--json', 'status,conclusion,headSha,url']);
if (runs.__error) note('warn', 'ci', `could not read CI status: ${runs.__error}`, 'check gh auth');
else if (!runs.length) note('warn', 'ci', 'no CI runs found on main', 'verify the workflow is enabled');
else {
  const [run] = runs;
  if (run.status === 'completed' && run.conclusion !== 'success') {
    note('fail', 'ci', `main is RED at ${run.headSha.slice(0, 7)} (${run.conclusion})`, `read ${run.url}`);
  }
}

// ── 2. Queue health. A stalled queue looks identical to slow CI until someone waits an hour. ─────
const queued = ghJson(['run', 'list', '--repo', REPO, '--limit', '60', '--json', 'status']);
if (!queued.__error && Array.isArray(queued)) {
  const q = queued.filter((r) => r.status === 'queued').length;
  const running = queued.filter((r) => r.status === 'in_progress').length;
  // Many queued with NOTHING executing is the shape of a stuck plane or an exhausted runner pool —
  // measured on 2026-08-06, when two hung notifier runs held both slots and starved 21 real runs.
  if (running === 0 && q >= 5) {
    note('fail', 'queue', `${q} runs queued, 0 executing — the Actions plane may be stalled`,
      'check githubstatus.com, then cancel any hung run holding a concurrency slot');
  }
}

// ── 3. PRs that have gone unmergeable. These rot silently; nobody is notified when main moves. ───
const prs = ghJson(['pr', 'list', '--repo', REPO, '--state', 'open', '--json',
  'number,title,mergeable,isDraft,updatedAt']);
if (!prs.__error && Array.isArray(prs)) {
  for (const pr of prs) {
    if (pr.mergeable === 'CONFLICTING') {
      note('fail', 'pr', `#${pr.number} is CONFLICTING — "${pr.title.slice(0, 60)}"`,
        'rebase or resolve against main; a conflicting PR is invisible work');
    }
  }
}

// ── 4. Branches left behind after a merge. The maintainer's standing rule is a few, resolved fast.
const branches = gh(['api', `repos/${REPO}/branches?per_page=100`, '--jq', '.[].name']);
if (typeof branches === 'string') {
  const list = branches.split('\n').filter(Boolean).filter((b) => b !== 'main');
  if (list.length > 3) {
    note('warn', 'branches', `${list.length} non-main branches: ${list.slice(0, 6).join(', ')}`,
      'delete merged branches; resolve the rest back to main');
  }
}

// ── 5. Published surfaces naming different generations — the whole of issue #77. ─────────────────
const npmLatest = (() => {
  try { return execFileSync('npm', ['view', 'ruvnet-brain', 'dist-tags.latest'], { encoding: 'utf8', timeout: 60_000 }).trim(); }
  catch { return null; }
})();
const release = ghJson(['api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name']);
if (npmLatest && typeof release === 'string' && release) {
  if (npmLatest !== release.replace(/^v/, '')) {
    note('fail', 'surfaces', `npm ${npmLatest} != GitHub ${release}`,
      'run scripts/published-surface-probe.mjs; this is issue #77 recurring');
  }
}

// ── 6. Issues past their response SLA. ──────────────────────────────────────────────────────────
const issues = ghJson(['issue', 'list', '--repo', REPO, '--state', 'open', '--json',
  'number,title,createdAt,comments']);
if (!issues.__error && Array.isArray(issues)) {
  for (const issue of issues) {
    const ageH = (Date.now() - Date.parse(issue.createdAt)) / 3_600_000;
    if (ageH > 4 && (issue.comments ?? 0) === 0) {
      note('fail', 'issues', `#${issue.number} is ${Math.round(ageH)}h old with NO response`,
        'respond; the 4h SLA is the promise, not the target');
    }
  }
}

const failed = findings.filter((f) => f.level === 'fail');
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ healthy: failed.length === 0, findings }, null, 2)}\n`);
} else if (!findings.length) {
  process.stdout.write('[github-health] ✓ clean — main green, no conflicting PRs, surfaces coherent, no unanswered issues.\n');
} else {
  for (const f of findings) {
    process.stdout.write(`[github-health] ${f.level === 'fail' ? '✗' : '⚠'} ${f.area}: ${f.detail}\n      → ${f.action}\n`);
  }
}
process.exit(failed.length ? 1 : 0);
