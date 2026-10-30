// scripts/issue-autofix-runner.mjs — where the nightly autofix job's OWN code lives (ADR-107).
// launchd runs the job from ~/.cache/ruvnet-brain/autofix-runner: a detached worktree of the job's clone, pinned to
// the newest install-verified release tag. Never the owner's checkout: that would make the job depend on, and run, the
// owner's uncommitted work. After each run the runner moves to the newest tag that is published on npm, is GitHub's
// latest release, and resolves as install-verified — for the NEXT run; the running process is never changed under
// itself. Every file the runner executes is outside the editable allowlist (tests/unit/issue-autofix-deploy.test.mjs
// proves it over the whole import closure), so the job cannot change its own code; only a person's release can.
//
//   node scripts/issue-autofix-runner.mjs --install --tag vX.Y.Z   (arming: create the runner at a released tag)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';
import { makeExec } from './issue-autofix-exec.mjs';
import { PATHS } from './issue-autofix-state.mjs';

export const runnerPath = (home) => path.join(home, '.cache', 'ruvnet-brain', 'autofix-runner');
const TAG = /^v\d+\.\d+\.\d+$/;
const ver = (t) => String(t).replace(/^v/, '').split('.').map(Number);
const newer = (a, b) => { const x = ver(a); const y = ver(b); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

function runnerVersion(dir) {
  try { return `v${JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version}`; } catch { return null; }
}

/** Point the runner at `tag` (fetching it into the clone) and install its node_modules. Throws on any failure. */
export function checkoutRunner(exec, { clone, runner, tag }) {
  if (!TAG.test(tag)) throw new Error(`not a release tag: ${tag}`);
  const must = (args, opts) => { const r = exec('git', args, opts); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.slice(-300)}`); return r; };
  must(['-C', clone, 'fetch', '-q', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]);
  if (!fs.existsSync(path.join(runner, '.git'))) {
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    must(['-C', clone, 'worktree', 'add', '--detach', runner, tag]);
  } else {
    if (exec('git', ['-C', runner, 'status', '--porcelain', '--untracked-files=no']).stdout.trim()) throw new Error('the runner worktree has local changes; it is never overwritten');
    must(['-C', runner, 'checkout', '-q', '--detach', tag]);
  }
  fs.mkdirSync(path.join(runner, 'logs'), { recursive: true }); // launchd's StandardOutPath/StandardErrorPath live here
  const ci = exec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: runner, timeoutMs: 30 * 60_000 });
  if (ci.status !== 0) throw new Error(`npm ci in the runner failed: ${ci.stderr.slice(-300)}`);
  return runnerVersion(runner);
}

/**
 * After a live run: move the runner to `latestTag` when it is newer AND install-verified. Best effort; never throws.
 * Returns { moved, from, to, reason }.
 */
export async function advanceRunner(rt, { latestTag, installVerified }) {
  const runner = rt.paths.runner;
  if (!runner) return { moved: false, from: null, to: null, reason: 'no runner path' };
  const from = runnerVersion(runner);
  if (!fs.existsSync(path.join(runner, '.git'))) return { moved: false, from, to: null, reason: 'no runner worktree (not armed from one)' };
  if (!latestTag || !TAG.test(latestTag) || !from || !newer(latestTag, from)) return { moved: false, from, to: latestTag, reason: 'up to date' };
  if (!installVerified) return { moved: false, from, to: latestTag, reason: `${latestTag} is not install-verified yet` };
  try { return { moved: true, from, to: checkoutRunner(rt.exec, { clone: rt.paths.clone, runner, tag: latestTag }), reason: 'advanced' }; }
  catch (e) { return { moved: false, from, to: latestTag, reason: e.message.slice(0, 300) }; }
}

if (isDirectInvocation(import.meta.url)) {
  const argv = process.argv.slice(2);
  const tag = argv[argv.indexOf('--tag') + 1];
  if (!argv.includes('--install') || !TAG.test(String(tag))) {
    console.error('usage: node scripts/issue-autofix-runner.mjs --install --tag vX.Y.Z');
    process.exit(2);
  }
  const home = process.env.HOME || os.homedir();
  const paths = PATHS(home);
  const exec = makeExec({ primary: paths.primary });
  if (!fs.existsSync(path.join(paths.clone, '.git'))) {
    const r = exec('git', ['clone', '-q', '--no-checkout', 'https://github.com/stuinfla/ruvnet-brain.git', paths.clone]);
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  }
  try { console.log(`runner ${runnerPath(home)} at ${checkoutRunner(exec, { clone: paths.clone, runner: runnerPath(home), tag })}`); }
  catch (e) { console.error(`issue-autofix-runner: ${e.message}`); process.exit(1); }
}
