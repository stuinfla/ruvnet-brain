// Shared harness for the issue-autofix release tests (batch A3): a real temp bare origin, a real clone,
// and a recording command runner. Real git runs only against the temp file:// origin; gh, npm, node and
// unzip are always fakes. The runner refuses force/merge argv exactly as the production runner must.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPO = 'owner/repo';
export const FORBIDDEN = [
  (c, a) => a.includes('--force') || a.includes('--force-with-lease'),
  (c, a) => a.includes('push') && (a.includes('-f') || a.some((x) => String(x).startsWith('+'))),
  (c, a) => a.some((x) => /\+refs\//.test(String(x))),
  (c, a) => c === 'gh' && a[0] === 'pr' && a[1] === 'merge',
  (c, a) => c === 'gh' && a.some((x) => /\/merge(\b|$)/.test(String(x))),
];
export const isForbidden = (cmd, args) => FORBIDDEN.some((f) => f(cmd, args));
export const allCalls = []; // every recorded exec across the whole file, scanned at the end

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
// fixture=true: setup helper with a throwaway identity. The recording exec uses fixture=false, so a commit
// made through production code has ONLY the identity production code supplies.
export function realGit(cwd, args, extraEnv = {}, fixture = true) {
  const id = fixture ? { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'f@example.invalid' } : {};
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, ...GIT_ENV, ...id, ...extraEnv } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal, timedOut: false };
}
export const head = (dir) => realGit(dir, ['rev-parse', 'HEAD']).stdout.trim();
export const remoteMain = (origin) => realGit(origin, ['rev-parse', 'refs/heads/main']).stdout.trim();
export const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** bare origin + seed commit + clone. Version 1.0.0. */
export function makeRepos(extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-rel-'));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(origin);
  realGit(origin, ['init', '--bare', '-b', 'main']);
  fs.mkdirSync(seed);
  realGit(seed, ['init', '-b', 'main']);
  write(path.join(seed, 'package.json'), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  write(path.join(seed, 'package-lock.json'), '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n');
  write(path.join(seed, 'plugin/.claude-plugin/plugin.json'), '{\n  "version": "1.0.0"\n}\n');
  write(path.join(seed, 'src/a.js'), 'export const a = 1;\n');
  for (const [f, t] of Object.entries(extraFiles)) write(path.join(seed, f), t);
  realGit(seed, ['add', '-A']);
  realGit(seed, ['commit', '-m', 'seed']);
  realGit(seed, ['remote', 'add', 'origin', `file://${origin}`]);
  realGit(seed, ['push', 'origin', 'main']);
  const clone = path.join(root, 'cache', 'autofix-repo');
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  realGit(root, ['clone', `file://${origin}`, clone]);
  return { root, origin, seed, clone, runDir: path.join(root, 'runs'), worktrees: path.join(root, 'cache', 'issue-fix-worktrees') };
}

/** ctx with a recording exec. `handler(cmd, args, opts)` answers every non-git command (return null to fail loudly). */
export function makeCtx(repos, { handler = () => null, checkpoint, gitHook, extra = {} } = {}) {
  const calls = [];
  let t = Date.parse('2026-10-29T14:00:00Z');
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '', signal: null, timedOut: false });
  const ctx = {
    repo: REPO, clone: repos.clone, runDir: repos.runDir, worktrees: repos.worktrees,
    holdFile: path.join(repos.root, 'release-hold'),
    identity: { name: 'RuvNet Brain Autofix', email: 'stuinfla@users.noreply.github.com' },
    now: () => t, sleep: (ms) => { t += ms; }, log: () => {},
    checkpoint: async (name) => {
      calls.push({ cmd: 'checkpoint', args: [name] });
      if (checkpoint) await checkpoint(name);
    },
    exec: (cmd, args, opts = {}) => {
      if (isForbidden(cmd, args)) throw new Error(`forbidden-command: ${cmd} ${args.join(' ')}`);
      calls.push({ cmd, args, opts });
      allCalls.push({ cmd, args });
      if (cmd === 'git') {
        const faked = gitHook && gitHook(args, opts);
        if (faked) return { status: 0, stdout: '', stderr: '', signal: null, timedOut: false, ...faked };
      }
      if (cmd === 'git') return realGit(opts.cwd || repos.root, args, opts.env || {}, false);
      const r = handler(cmd, args, opts);
      if (r === null || r === undefined) return { status: 127, stdout: '', stderr: `unhandled fake: ${cmd} ${args.join(' ')}`, signal: null, timedOut: false };
      return typeof r === 'object' ? { status: 0, stdout: '', stderr: '', signal: null, timedOut: false, ...r } : ok(String(r));
    },
    ...extra,
  };
  const line = (c) => `${c.cmd} ${c.args.join(' ')}`;
  return { ctx, calls, line, find: (re) => calls.findIndex((c) => re.test(line(c))), count: (re) => calls.filter((c) => re.test(line(c))).length,
    tick: (ms) => { t += ms; }, clock: () => t };
}

/** A fix commit in a linked worktree, then a release worktree on release/<version> carrying it. */
export function makeReleaseWorktree(repos, version = '1.0.1') {
  const rwt = path.join(repos.worktrees, `release-${version}`);
  fs.mkdirSync(repos.worktrees, { recursive: true });
  realGit(repos.clone, ['fetch', 'origin', 'main']);
  realGit(repos.clone, ['worktree', 'add', '-b', `release/${version}`, rwt, 'origin/main']);
  write(path.join(rwt, 'src/a.js'), 'export const a = 2;\n');
  write(path.join(rwt, 'package.json'), `{\n  "name": "fixture",\n  "version": "${version}"\n}\n`);
  realGit(rwt, ['add', '-A']);
  realGit(rwt, ['commit', '-m', `release ${version}`]);
  return rwt;
}
