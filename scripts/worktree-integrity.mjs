#!/usr/bin/env node
/**
 * One mutation boundary for author-side automation.
 *
 * A clean linked worktree is the only place a corpus/update command may write. The primary
 * checkout is never a writer, even when it is on a feature branch, because scheduled work cannot
 * distinguish the owner's active edits from its own generated changes. This module only classifies
 * and refuses; it never resets, cleans, removes, commits, or switches a checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown git error').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return String(result.stdout || '').trim();
}

function samePath(left, right) {
  try { return fs.realpathSync(left) === fs.realpathSync(right); } catch { return false; }
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function inspectMutationWorktree(root) {
  const requestedRoot = path.resolve(root);
  const worktreeRoot = fs.realpathSync(git(requestedRoot, ['rev-parse', '--show-toplevel']));
  const commonDirRaw = git(worktreeRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = fs.realpathSync(commonDirRaw);
  const primaryRoot = fs.realpathSync(path.dirname(commonDir));
  const dotGit = fs.lstatSync(path.join(worktreeRoot, '.git'));
  const linked = dotGit.isFile();
  const primary = samePath(worktreeRoot, primaryRoot);
  const nestedInPrimary = !primary && within(primaryRoot, worktreeRoot);
  const status = git(worktreeRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const clean = status.length === 0;
  const allowed = linked && !primary && !nestedInPrimary && clean;
  let reason = 'clean-linked-worktree';
  if (primary) reason = 'primary-checkout';
  else if (!linked) reason = 'not-linked-worktree';
  else if (nestedInPrimary) reason = 'nested-inside-primary';
  else if (!clean) reason = 'dirty-writer-worktree';
  return { allowed, reason, worktreeRoot, primaryRoot, commonDir, linked, primary, nestedInPrimary, clean, status };
}

export function assertIsolatedMutationWorktree(root, operation = 'repository mutation') {
  const state = inspectMutationWorktree(root);
  if (!state.allowed) {
    throw new Error(
      `[worktree-integrity] DENIED ${operation}: ${state.reason}. `
      + `Run author-side mutations in a clean linked worktree outside ${state.primaryRoot}; `
      + 'the primary checkout is immutable to automation.',
    );
  }
  return state;
}

/**
 * Seal the primary checkout around an isolated author-side mutation.
 *
 * A status-only comparison is insufficient: a checkout that was already dirty can be modified
 * again while keeping the same porcelain status. Bind HEAD, the staged diff, the full tracked
 * working diff, and the exact non-ignored untracked-file set instead. Ignored runtime state (logs,
 * AgentDB, locks) is deliberately outside the source-checkout contract.
 */
export function snapshotPrimaryCheckout(root) {
  const { primaryRoot } = inspectMutationWorktree(root);
  return {
    primaryRoot,
    head: git(primaryRoot, ['rev-parse', 'HEAD']),
    indexDigest: digest(git(primaryRoot, ['diff', '--binary', '--cached', 'HEAD', '--'])),
    trackedDigest: digest(git(primaryRoot, ['diff', '--binary', 'HEAD', '--'])),
    untracked: git(primaryRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0').filter(Boolean).sort(),
  };
}

export function assertPrimaryCheckoutUnchanged(root, before) {
  const after = snapshotPrimaryCheckout(root);
  const fields = ['primaryRoot', 'head', 'indexDigest', 'trackedDigest', 'untracked'];
  const changed = fields.filter((field) => JSON.stringify(after[field]) !== JSON.stringify(before[field]));
  if (changed.length) {
    throw new Error(
      `[worktree-integrity] PRIMARY CHECKOUT CHANGED during isolated mutation: ${changed.join(', ')}. `
      + 'The candidate is invalid and must not be promoted.',
    );
  }
  return after;
}

const invokedDirectly = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const command = process.argv[2];
    if (command === 'snapshot') {
      process.stdout.write(`${JSON.stringify(snapshotPrimaryCheckout(process.argv[3] || process.cwd()))}\n`);
    } else if (command === 'verify') {
      const root = process.argv[3] || process.cwd();
      const receipt = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
      process.stdout.write(`${JSON.stringify(assertPrimaryCheckoutUnchanged(root, receipt))}\n`);
    } else {
      const state = assertIsolatedMutationWorktree(command || process.cwd(), process.argv[3] || 'repository mutation');
      process.stdout.write(`${JSON.stringify(state)}\n`);
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exit(2);
  }
}
