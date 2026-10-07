import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function rejectParentTraversal(value, label) {
  if (value.split(/[\\/]+/).includes('..')) throw new Error(`${label} contains parent traversal`);
}

function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty path`);
  rejectParentTraversal(value, label);
  let canonical;
  try { canonical = fs.realpathSync.native(value); } catch { throw new Error(`${label} does not exist`); }
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function canonicalProspectivePath(value) {
  let cursor = path.resolve(value);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('store path has no resolvable ancestor');
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  if (missing.length && !fs.statSync(cursor).isDirectory()) {
    throw new Error('store path ancestor must be a directory');
  }
  return path.join(fs.realpathSync.native(cursor), ...missing);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function gitValue(cwd, args, gitTimeoutMs, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error('restore deadline exceeded');
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(Number.isFinite(remaining) || gitTimeoutMs
        ? { timeout: Math.max(1, Math.floor(Math.min(gitTimeoutMs || Infinity, remaining))), killSignal: 'SIGKILL' } : {}),
    }).trim();
  } catch (error) {
    // A timed-out Git identity check is not evidence for a non-git project.
    if (error.code === 'ETIMEDOUT') throw new Error('Git project identity timed out');
    return null;
  }
}

function gitProject(projectDir, gitTimeoutMs, deadlineAt) {
  const commonValue = gitValue(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], gitTimeoutMs, deadlineAt);
  const checkoutValue = gitValue(projectDir, ['rev-parse', '--show-toplevel'], gitTimeoutMs, deadlineAt);
  if (!commonValue || !checkoutValue) return null;
  const gitCommonDir = canonicalDirectory(commonValue, 'Git common directory');
  const checkoutRoot = canonicalDirectory(checkoutValue, 'Git checkout root');
  if (path.basename(gitCommonDir) !== '.git') {
    throw new Error('Git common directory must identify a canonical primary checkout');
  }
  return {
    gitCommonDir,
    checkoutRoot,
    projectRoot: canonicalDirectory(path.dirname(gitCommonDir), 'Git project root'),
  };
}

export function resolveProjectStore({ projectDir = process.cwd(), requestedStorePath, gitTimeoutMs, deadlineAt = Infinity } = {}) {
  const canonicalInput = canonicalDirectory(projectDir, 'projectDir');
  if (gitTimeoutMs !== undefined && (!Number.isSafeInteger(gitTimeoutMs) || gitTimeoutMs <= 0)) throw new TypeError('gitTimeoutMs must be a positive integer');
  const git = gitProject(canonicalInput, gitTimeoutMs, deadlineAt);
  const resolved = git ?? {
    gitCommonDir: null,
    checkoutRoot: canonicalInput,
    projectRoot: canonicalInput,
  };
  const kind = git ? 'git' : 'non-git';
  const canonicalAgentDbPath = path.join(resolved.projectRoot, '.swarm', 'memory.db');
  const resolvedAgentDbPath = canonicalProspectivePath(canonicalAgentDbPath);
  if (!isWithin(resolved.projectRoot, resolvedAgentDbPath)) {
    throw new Error('store symlink escape rejected');
  }
  // A hard link passes every path check yet writes into a foreign inode (ADR-0102 G-053, measured: the
  // Stop boundary's progression/continuity writers changed a hard-linked foreign store).
  let storeStat = null;
  try { storeStat = fs.statSync(resolvedAgentDbPath); } catch { /* not created yet */ }
  if (storeStat && storeStat.nlink > 1) throw new Error('store hard link rejected');
  if (requestedStorePath !== undefined) {
    if (typeof requestedStorePath !== 'string' || !requestedStorePath.trim()) {
      throw new TypeError('requestedStorePath must be a non-empty path');
    }
    rejectParentTraversal(requestedStorePath, 'requestedStorePath');
    if (canonicalProspectivePath(requestedStorePath) !== resolvedAgentDbPath) {
      throw new Error('foreign store root rejected');
    }
  }
  const projectIdentity = Object.freeze({
    id: `${kind}-sha256:${sha256(resolved.gitCommonDir ?? resolved.projectRoot)}`,
    canonicalAgentDbPath,
  });
  return Object.freeze({
    kind,
    projectRoot: resolved.projectRoot,
    checkoutRoot: resolved.checkoutRoot,
    gitCommonDir: resolved.gitCommonDir,
    canonicalAgentDbPath,
    projectIdentity,
  });
}
