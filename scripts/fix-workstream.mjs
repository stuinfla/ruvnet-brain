#!/usr/bin/env node
// Supervised fix lifecycle boundary: create one isolated writer lane, then seal a clean,
// content-bound handoff. This command intentionally cannot merge, push, publish, promote,
// delete, reset, or force-remove anything. Immutable release authority remains release-proof.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[a-f0-9]{40}$/i;
const SCOPED_BRANCH = /^(fix|bugfix|hotfix|issue|codex)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASE_COMMAND = 'node scripts/release-proof.mjs --candidate <candidate-receipt.json>';

function fail(message) {
  throw new Error(message);
}

function command(commandName, args, options = {}) {
  return spawnSync(commandName, args, {
    encoding: options.encoding ?? 'utf8',
    cwd: options.cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function git(cwd, args, { allowFailure = false, binary = false } = {}) {
  const result = command('git', ['-C', cwd, ...args], {
    cwd,
    encoding: binary ? null : 'utf8',
  });
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || 'unknown git failure').trim();
    fail(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result;
}

function output(cwd, args) {
  return String(git(cwd, args).stdout || '').trim();
}

function parseArgs(args) {
  const parsed = { evidence: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`missing value for --${key}`);
    index += 1;
    if (key === 'evidence') parsed.evidence.push(value);
    else if (['integration', 'base', 'branch', 'worktree', 'scope', 'out'].includes(key)) parsed[key] = value;
    else fail(`unknown option: --${key}`);
  }
  return parsed;
}

function requireAbsolute(value, label) {
  if (!value) fail(`${label} is required`);
  if (!path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function requireScope(value) {
  if (!SAFE_SCOPE.test(String(value || ''))) fail('scope must be a bounded identifier using letters, digits, dot, underscore, or dash');
  return value;
}

function requireClean(cwd, role) {
  const dirty = output(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) fail(`${role} worktree is dirty; preserve it and reconcile before continuing`);
}

function commonDirectory(cwd) {
  const raw = output(cwd, ['rev-parse', '--git-common-dir']);
  return fs.realpathSync(path.resolve(cwd, raw));
}

function currentBranch(cwd) {
  const branch = output(cwd, ['branch', '--show-current']);
  if (!branch) fail(`${cwd} is detached; a named branch is required`);
  return branch;
}

function validateBase(cwd, base) {
  if (!FULL_SHA.test(String(base || ''))) fail('base lineage must be an explicit full 40-character commit SHA');
  const resolved = output(cwd, ['rev-parse', '--verify', `${base}^{commit}`]);
  if (resolved !== base) fail('base lineage does not resolve to the explicit commit SHA');
}

function requireScopedBranch(branch, integrationBranch) {
  if (!SCOPED_BRANCH.test(String(branch || '')) || branch === integrationBranch) {
    fail('writer must use a scoped non-main branch (fix/, bugfix/, hotfix/, issue/, or codex/) distinct from integration');
  }
}

function worktrees(cwd) {
  const text = output(cwd, ['worktree', 'list', '--porcelain']);
  return text.split(/\n\n+/).filter(Boolean).map((block) => {
    const fields = {};
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      fields[space === -1 ? line : line.slice(0, space)] = space === -1 ? true : line.slice(space + 1);
    }
    return fields;
  });
}

function assertSingleOwner(cwd, branch, expectedPath, role) {
  const ref = `refs/heads/${branch}`;
  const owners = worktrees(cwd).filter((item) => item.branch === ref);
  if (owners.length !== 1 || fs.realpathSync(owners[0].worktree) !== fs.realpathSync(expectedPath)) {
    fail(`${role} branch has a shared writer or is not owned by the declared worktree`);
  }
}

function receipt(payload) {
  const encoded = JSON.stringify(payload);
  return { ...payload, receiptId: `sha256:${createHash('sha256').update(encoded).digest('hex')}` };
}

function emit(value, outPath = null) {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (outPath) {
    const target = requireAbsolute(outPath, 'out');
    if (fs.existsSync(target)) fail(`refusing to overwrite existing receipt: ${target}`);
    fs.writeFileSync(target, rendered, { flag: 'wx', mode: 0o600 });
  }
  process.stdout.write(rendered);
}

function pendingRealPath(value, label) {
  const absolute = requireAbsolute(value, label);
  const parent = path.dirname(absolute);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail(`${label} parent directory does not exist: ${parent}`);
  return path.join(fs.realpathSync(parent), path.basename(absolute));
}

function isWithin(root, candidate) {
  const relative = path.relative(fs.realpathSync(root), candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function startFixWorkstream(options) {
  const integration = requireAbsolute(options.integration, 'integration');
  const writer = requireAbsolute(options.worktree, 'worktree');
  const scope = requireScope(options.scope);
  validateBase(integration, options.base);
  requireClean(integration, 'integration');
  const integrationSha = output(integration, ['rev-parse', 'HEAD']);
  if (integrationSha !== options.base) fail('base lineage must equal the current integration HEAD');
  const integrationBranch = currentBranch(integration);
  requireScopedBranch(options.branch, integrationBranch);
  assertSingleOwner(integration, integrationBranch, integration, 'integration');

  if (writer === integration || writer.startsWith(`${integration}${path.sep}`)) fail('writer worktree must be isolated from the integration worktree');
  if (fs.existsSync(writer)) fail('writer worktree path already exists; it will not be removed or overwritten');
  const branchRef = git(integration, ['show-ref', '--verify', `refs/heads/${options.branch}`], { allowFailure: true });
  if (branchRef.status === 0) {
    const owner = worktrees(integration).find((item) => item.branch === `refs/heads/${options.branch}`);
    fail(owner ? `branch is already checked out at ${owner.worktree}; shared writers are forbidden` : 'writer branch already exists; branch reuse is forbidden');
  }

  const created = git(integration, ['worktree', 'add', '-b', options.branch, writer, options.base], { allowFailure: true });
  if (created.status !== 0) {
    const detail = String(created.stderr || created.stdout || created.error?.message || 'unknown git failure').trim();
    fail(`git worktree add failed without cleanup or force removal: ${detail}`);
  }

  if (commonDirectory(writer) !== commonDirectory(integration)) fail('created writer is not in the integration repository lineage');
  if (output(writer, ['rev-parse', 'HEAD']) !== options.base) fail('created writer HEAD does not match the explicit integration base');
  requireClean(writer, 'writer');
  assertSingleOwner(writer, options.branch, writer, 'writer');

  return receipt({
    schemaVersion: 1,
    phase: 'workstream-start',
    scope,
    branch: options.branch,
    worktree: writer,
    integrationWorktree: integration,
    integrationBranch,
    baseSha: options.base,
    baseTree: output(integration, ['rev-parse', `${options.base}^{tree}`]),
    repositoryCommonDir: commonDirectory(integration),
    publishAuthorized: false,
    promotionAuthorized: false,
    releaseGate: { authority: 'release-proof', command: RELEASE_COMMAND },
  });
}

function requireAncestor(cwd, ancestor, descendant, message) {
  const result = git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFailure: true });
  if (result.status !== 0) fail(message);
}

function evidenceFiles(values) {
  if (!Array.isArray(values) || values.length === 0) fail('at least one focused test or review evidence file is required');
  return values.map((value) => {
    const absolute = requireAbsolute(value, 'evidence');
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail(`evidence file does not exist or is not a file: ${absolute}`);
    const bytes = fs.readFileSync(absolute);
    return { path: absolute, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
}

export function sealFixHandoff(options) {
  const integration = requireAbsolute(options.integration, 'integration');
  const writer = requireAbsolute(options.worktree, 'worktree');
  const scope = requireScope(options.scope);
  if (options.out) {
    const out = pendingRealPath(options.out, 'out');
    if (isWithin(integration, out) || isWithin(writer, out)) fail('handoff receipt must be outside the integration and writer worktrees');
    if (fs.existsSync(out)) fail(`refusing to overwrite existing receipt: ${out}`);
  }
  validateBase(integration, options.base);
  validateBase(writer, options.base);
  requireClean(integration, 'integration');
  requireClean(writer, 'writer');
  if (commonDirectory(writer) !== commonDirectory(integration)) fail('writer and integration do not share repository lineage');

  const integrationBranch = currentBranch(integration);
  const writerBranch = currentBranch(writer);
  requireScopedBranch(writerBranch, integrationBranch);
  assertSingleOwner(integration, integrationBranch, integration, 'integration');
  assertSingleOwner(writer, writerBranch, writer, 'writer');
  const integrationSha = output(integration, ['rev-parse', 'HEAD']);
  const writerSha = output(writer, ['rev-parse', 'HEAD']);
  requireAncestor(integration, options.base, integrationSha, 'integration lineage does not descend from the declared base');
  requireAncestor(writer, options.base, writerSha, 'writer lineage does not descend from the declared base');
  if (writerSha === options.base) fail('writer contains no committed change to hand off');

  const patchBytes = git(writer, ['diff', '--binary', `${options.base}..${writerSha}`], { binary: true }).stdout;
  const changedPaths = output(writer, ['diff', '--name-status', `${options.base}..${writerSha}`])
    .split('\n').filter(Boolean).map((line) => {
      const [status, ...names] = line.split('\t');
      return { status, path: names.join(' -> ') };
    });
  if (changedPaths.length === 0) fail('writer commit has no content change to hand off');

  return receipt({
    schemaVersion: 1,
    phase: 'fix-handoff',
    scope,
    branch: writerBranch,
    worktree: writer,
    integrationWorktree: integration,
    baseSha: options.base,
    integrationSha,
    writerSha,
    writerTree: output(writer, ['rev-parse', `${writerSha}^{tree}`]),
    patchSha256: createHash('sha256').update(patchBytes).digest('hex'),
    changedPaths,
    evidence: evidenceFiles(options.evidence),
    publishAuthorized: false,
    promotionAuthorized: false,
    nextAuthority: 'integration-owner',
    releaseGate: { authority: 'release-proof', command: RELEASE_COMMAND },
  });
}

export function main(args = process.argv.slice(2)) {
  const [operation, ...rest] = args;
  if (!['start', 'handoff'].includes(operation)) {
    console.error('fix-workstream: supported commands are start and handoff; this tool cannot merge, publish, promote, or clean up');
    return 2;
  }
  try {
    const options = parseArgs(rest);
    const result = operation === 'start' ? startFixWorkstream(options) : sealFixHandoff(options);
    emit(result, operation === 'handoff' ? options.out : null);
    return 0;
  } catch (error) {
    console.error(`fix-workstream: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
