// scripts/issue-autofix-exec.mjs — the ONE place the autofix job (ADR-107) touches child_process, plus the
// primary-checkout guard. Every git/gh/npm/node call in the orchestrator, the release path and the reporter goes
// through the exec this module builds, so two rails live here and nowhere else to be forgotten:
//   * assertCommandAllowed (no force, no merge, no delete) runs on EVERY argv before it is spawned;
//   * a command whose cwd (or `git -C` dir) is inside the developer's primary checkout is refused.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { AutofixAbort, assertCommandAllowed } from './issue-autofix-policy.mjs';

/** realpath of the nearest existing ancestor + the not-yet-existing tail (macOS /var -> /private/var safe). */
function realish(p) {
  let cur = path.resolve(String(p));
  const rest = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  let base = cur;
  try { base = fs.realpathSync(cur); } catch { /* keep the unresolved path */ }
  return path.join(base, ...rest);
}

/** Throws AutofixAbort('S2','primary-checkout') when `p` is the primary checkout or anywhere inside it. */
export function resolveWorkPath(p, { primary }) {
  const real = realish(p);
  const prim = realish(primary);
  if (real === prim || real.startsWith(prim + path.sep)) {
    throw new AutofixAbort('S2', 'primary-checkout', `${real} is inside the primary checkout ${prim}`);
  }
  return real;
}

// git global options that take a value, so the sub-command is the first token after them.
function gitSub(args) {
  const a = args.map(String);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '-C' || a[i] === '-c') { i += 1; continue; }
    if (a[i].startsWith('-')) continue;
    return { sub: a[i], rest: a.slice(i + 1) };
  }
  return { sub: '', rest: [] };
}

/** True for a command that WRITES (to a remote, the clone, or a worktree): a --dry-run records and skips these. */
export function isWriteCommand(cmd, args, { ghBin } = {}) {
  const a = (args || []).map(String);
  const bin = path.basename(String(cmd));
  if (bin === 'git') {
    const { sub, rest } = gitSub(a);
    if (['push', 'commit', 'cherry-pick', 'clone', 'add'].includes(sub)) return true;
    return sub === 'worktree' && ['add', 'remove'].includes(rest[0]);
  }
  if (String(cmd) === ghBin || bin === 'gh') {
    const [g, s] = a;
    if (g === 'issue') return ['comment', 'close', 'edit'].includes(s);
    if (g === 'pr') return ['create', 'close'].includes(s);
    if (g === 'workflow') return s === 'run';
    if (g === 'variable') return s === 'set';
    if (g === 'api') return a.some((t) => /dispatches/.test(t));
    return false;
  }
  if (bin === 'npm') return a[0] === 'ci' || (a[0] === 'run' && a[1] === 'version:set');
  return false;
}

/** True for a command that reaches GitHub with a write (push, comment, label, close, PR, workflow, dispatch, variable). */
export function isRemoteWrite(cmd, args, { ghBin } = {}) {
  const a = (args || []).map(String);
  const bin = path.basename(String(cmd));
  if (bin === 'git') return gitSub(a).sub === 'push';
  return (String(cmd) === ghBin || bin === 'gh') && isWriteCommand(cmd, a, { ghBin });
}

/**
 * exec(cmd, args, {cwd, env, timeoutMs, input}) -> {status, stdout, stderr, signal, timedOut}. Never throws on a
 * non-zero exit; throws AutofixAbort for a forbidden argv or a primary-checkout cwd. dryRun skips every write;
 * rehearse skips only writes that reach GitHub (local worktrees and commits in the job's own clone still happen).
 */
export function makeExec({ dryRun = false, rehearse = false, log = () => {}, primary = null, ghBin = 'gh', env = process.env } = {}) {
  let stage = 'S0';
  const exec = (cmd, args = [], opts = {}) => {
    const argv = args.map(String);
    assertCommandAllowed(cmd, argv, stage);
    if (primary) {
      if (opts.cwd) resolveWorkPath(opts.cwd, { primary });
      const c = argv.indexOf('-C');
      if (path.basename(String(cmd)) === 'git' && c !== -1 && argv[c + 1]) resolveWorkPath(argv[c + 1], { primary });
    }
    const line = [cmd, ...argv.map((t) => (t.length > 160 ? `${t.slice(0, 160)}…` : t))].join(' ');
    if ((dryRun && isWriteCommand(cmd, argv, { ghBin })) || (rehearse && isRemoteWrite(cmd, argv, { ghBin }))) {
      log(`[dry-run, not executed] ${line}`);
      return { status: 0, stdout: '', stderr: '', signal: null, timedOut: false, skipped: true };
    }
    log(line);
    const r = spawnSync(cmd, argv, { cwd: opts.cwd, env: opts.env || env, encoding: 'utf8', timeout: opts.timeoutMs,
      input: opts.input, maxBuffer: 256 * 1024 * 1024, killSignal: 'SIGTERM' });
    const timedOut = r.error?.code === 'ETIMEDOUT';
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error && !timedOut ? String(r.error.message) : ''),
      signal: r.signal || null, timedOut };
  };
  exec.setStage = (s) => { stage = s; };
  return exec;
}

/**
 * notify.sh exit code: 0 delivered, 1 failed, 2 paging off. The job runs from its own runner worktree, which has no
 * .env, so the topic comes from $NTFY_TOPIC or ~/.cache/ruvnet-brain/ntfy-topic — the file job-heartbeat.sh reads.
 * NTFY_TOPIC set but empty stays an explicit opt-out.
 */
export function defaultNotify(root, env = process.env) {
  return (title, body, priority = 'default') => {
    let topic = env.NTFY_TOPIC;
    if (topic === undefined) {
      try { topic = fs.readFileSync(path.join(env.HOME || '', '.cache', 'ruvnet-brain', 'ntfy-topic'), 'utf8').trim(); } catch { topic = undefined; }
    }
    const r = spawnSync('sh', [path.join(root, 'scripts', 'notify.sh'), title, body, priority, 'autofix'],
      { encoding: 'utf8', timeout: 30_000, env: topic === undefined ? env : { ...env, NTFY_TOPIC: topic } });
    return Number.isInteger(r.status) ? r.status : 1;
  };
}

/** Stops the Mac sleeping for as long as this process lives (best effort). */
export function keepAwake(pid = process.pid) {
  try { spawn('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore', detached: true }).unref(); } catch { /* best effort */ }
}
