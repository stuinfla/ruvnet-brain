// Shared helpers for the autofix release path (ADR-107, batch A3). No child_process here: every
// external command goes through the injected `ctx.exec` (see FROZEN INTERFACES).
import os from 'node:os';
import path from 'node:path';
import { AutofixAbort, findClosingKeywords } from './issue-autofix-policy.mjs';

export const VERSION_RE = /^\d+\.\d+\.\d+$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
export const MIN = 60_000;
export const tail = (text, n = 1500) => String(text ?? '').slice(-n);
export const ghBin = (ctx) => ctx.ghBin || 'gh';
export const gitBin = (ctx) => ctx.gitBin || 'git';

export async function run(ctx, cmd, args, opts = {}) {
  return ctx.exec(cmd, args, opts);
}
export const describe = (cmd, args, r) =>
  `${cmd} ${args.join(' ')} -> ${r.timedOut ? 'timed out' : r.status}: ${tail(r.stderr || r.stdout, 400)}`;

/** Run and throw AutofixAbort(stage, code) on any non-zero exit or timeout. */
export async function must(ctx, stage, code, cmd, args, opts = {}) {
  const r = await run(ctx, cmd, args, opts);
  if (r.status !== 0 || r.timedOut) throw new AutofixAbort(stage, code, describe(cmd, args, r));
  return r;
}
export const git = (ctx, dir, args, opts) => run(ctx, gitBin(ctx), ['-C', dir, ...args], opts);
export const mustGit = (ctx, stage, code, dir, args, opts) => must(ctx, stage, code, gitBin(ctx), ['-C', dir, ...args], opts);
export const gh = (ctx, args, opts) => run(ctx, ghBin(ctx), args, opts);

export async function ghJson(ctx, args, opts) {
  const r = await gh(ctx, args, opts);
  if (r.status !== 0 || r.timedOut) return { ok: false, value: null, result: r };
  try { return { ok: true, value: JSON.parse(r.stdout || 'null'), result: r }; }
  catch { return { ok: false, value: null, result: r }; }
}

/** Per-command identity (no repo or global git config is ever written). The env copy stops an ambient GIT_AUTHOR_* from winning. */
export const identityArgs = (ctx) => ['-c', `user.name=${ctx.identity.name}`, '-c', `user.email=${ctx.identity.email}`,
  '-c', 'commit.gpgsign=false'];
export const identityEnv = (ctx) => ({ ...process.env, GIT_AUTHOR_NAME: ctx.identity.name, GIT_AUTHOR_EMAIL: ctx.identity.email,
  GIT_COMMITTER_NAME: ctx.identity.name, GIT_COMMITTER_EMAIL: ctx.identity.email });
/** git commit / cherry-pick as the autofix identity. */
export const gitAs = (ctx, dir, args) => git(ctx, dir, [...identityArgs(ctx), ...args], { env: identityEnv(ctx) });
export const mustGitAs = async (ctx, stage, code, dir, args) => {
  const r = await gitAs(ctx, dir, args);
  if (r.status !== 0 || r.timedOut) throw new AutofixAbort(stage, code, describe(gitBin(ctx), args, r));
  return r;
};

/** Throws when text would auto-close an issue (closing keyword + #N) or credit a co-author. */
export function assertCleanText(stage, text) {
  const hits = findClosingKeywords(String(text));
  if (hits.length) throw new AutofixAbort(stage, 'forbidden-command', `closing keyword in outgoing text: ${hits.join(', ')}`);
  if (/co-authored-by/i.test(String(text))) throw new AutofixAbort(stage, 'forbidden-command', 'co-author trailer in outgoing text');
}

/** One printable line, no '#', no newlines, bounded. */
export function sanitizeTitle(title, max = 72) {
  return String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/#/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

export function assertVersion(stage, version) {
  if (!VERSION_RE.test(String(version))) throw new AutofixAbort(stage, 'branch-exists', `not a plain X.Y.Z version: ${version}`);
}
export function assertIssue(stage, n) {
  if (!Number.isInteger(n) || n <= 0) throw new AutofixAbort(stage, 'diff-policy', `bad issue number: ${n}`);
}

export const worktreesDir = (ctx) => ctx.worktrees || path.join(path.dirname(ctx.clone), 'issue-fix-worktrees');
export const holdFilePath = (ctx) => ctx.holdFile
  || path.join(process.env.HOME || os.homedir(), '.config', 'ruvnet-brain', 'release-hold');

/** Next 05:17 UTC strictly after `ms` (the corpus nightly dispatch). */
export function nextCorpusDispatch(ms) {
  const d = new Date(ms);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5, 17, 0);
  if (t <= ms) t += 24 * 3_600_000;
  return t;
}

/** Poll `fn` until truthy or the limit passes. Bounded by attempts too, so a frozen fake clock cannot hang. */
export async function poll(ctx, { limitMs, intervalMs, fn }) {
  const end = ctx.now() + limitMs;
  const attempts = Math.ceil(limitMs / intervalMs) + 2;
  for (let i = 0; i < attempts; i += 1) {
    const value = await fn();
    if (value) return value;
    if (ctx.now() >= end) break;
    await ctx.sleep(intervalMs);
  }
  return null;
}

/** Parse `git diff -U0` output into the DiffFile[] shape judgeDiff/judgeGovernedVersionOnly consume. */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      cur = { path: m ? m[2] : '', status: 'M', added: [], removed: [], binary: false, symlink: false };
      files.push(cur); inHunk = false; continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) {
      if (line.startsWith('new file mode')) cur.status = 'A';
      else if (line.startsWith('deleted file mode')) cur.status = 'D';
      else if (line.startsWith('rename to ')) { cur.status = 'R'; cur.path = line.slice('rename to '.length); }
      if (/^(new file mode|deleted file mode|new mode|old mode) 120000$/.test(line) || /^index [0-9a-f.]+ 120000$/.test(line)) cur.symlink = true;
      if (line.startsWith('Binary files') || line === 'GIT binary patch') cur.binary = true;
      continue;
    }
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  return files;
}

// ---- shared remote-state queries (window facts, terminal check) ----

export async function queryNpmLatest(ctx) {
  const r = await run(ctx, 'npm', ['view', 'ruvnet-brain', 'dist-tags.latest']);
  const v = String(r.stdout || '').trim();
  return r.status === 0 && VERSION_RE.test(v) ? v : null;
}
export async function queryReleasesLatest(ctx) {
  const j = await ghJson(ctx, ['release', 'view', '--repo', ctx.repo, '--json', 'tagName']);
  return j.ok && j.value && typeof j.value.tagName === 'string' ? j.value.tagName : null;
}
export async function queryRemoteMain(ctx, dir = ctx.clone) {
  const r = await git(ctx, dir, ['ls-remote', 'origin', 'refs/heads/main']);
  const sha = String(r.stdout || '').trim().split(/\s+/)[0];
  return r.status === 0 && SHA_RE.test(sha) ? sha : null;
}
export async function resolveRuntime(ctx, version, outFile) {
  const r = await run(ctx, 'node', ['scripts/approved-runtime.mjs', '--resolve', '--repo', ctx.repo, '--tag', `v${version}`, '--out', outFile],
    { cwd: ctx.clone });
  return r.status === 0 && !r.timedOut;
}
