#!/usr/bin/env node
// DISTINCT-FROM: scripts/model-router-setup.mjs — native per-user registration only; never deploys policy or runtime.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

// Parse only standalone literal argv. Shell expansion, operators and redirection are never ownership.
function literalArgv(command) {
  if (typeof command !== 'string') return null;
  const args = []; let word = ''; let quote = ''; let active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') { quote = ''; continue; }
      if ('$`\\'.includes(c)) return null;
      word += c; continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; continue; }
    if (c === '\\') { if (++i === command.length) return null; word += command[i]; active = true; continue; }
    if (/\s/.test(c)) { if (active) { args.push(word); word = ''; active = false; } continue; }
    if (';&|<>$`(){}*?!~'.includes(c)) return null;
    word += c; active = true;
  }
  if (quote) return null;
  if (active) args.push(word);
  return args;
}

function realNode(command, nodeExecutable, searchPath) {
  const candidates = path.isAbsolute(command) ? [command] : command === 'node'
    ? searchPath.split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command)) : [];
  const trusted = fs.realpathSync(nodeExecutable);
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate) === trusted; } catch { /* next PATH entry */ }
  }
  return false;
}

function assertSafePath(file, home) {
  const relative = path.relative(home, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escapes supplied home');
  let cursor = home;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${cursor}`);
      if (cursor !== file && !stat.isDirectory()) throw new Error(`Non-directory ancestor: ${cursor}`);
      if (cursor === file && !stat.isFile()) throw new Error(`Non-file target: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function configPlan(file, host, options) {
  assertSafePath(file, options.home);
  let before = null; let mode = 0o600;
  try { before = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let config;
  try { config = before === null ? {} : JSON.parse(before); } catch { throw new Error(`Malformed JSON: ${file}`); }
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || (config.hooks !== undefined && !object(config.hooks))) throw new Error(`Malformed hooks object: ${file}`);
  config.hooks ??= {};
  const entries = config.hooks.UserPromptSubmit === undefined ? [] : config.hooks.UserPromptSubmit;
  if (!Array.isArray(entries)) throw new Error(`Malformed UserPromptSubmit: ${file}`);
  const owned = [];
  for (const [index, entry] of entries.entries()) {
    if (!object(entry) || !Array.isArray(entry.hooks)) throw new Error(`Malformed hook group: ${file}`);
    for (const hook of entry.hooks) {
      if (!object(hook) || typeof hook.type !== 'string') throw new Error(`Malformed hook: ${file}`);
      if (hook.type !== 'command') continue;
      if (typeof hook.command !== 'string') throw new Error(`Malformed command: ${file}`);
      const args = literalArgv(hook.command);
      const expected = host === 'claude' ? ['--claude'] : [];
      if (args?.[1] === options.script && realNode(args[0], options.nodeExecutable, options.searchPath)
          && JSON.stringify(args.slice(2)) === JSON.stringify(expected)) owned.push({ index, hook });
      else if (args?.includes(options.script) || hook.command.includes(options.script)) {
        throw new Error(`Unowned model-hook override requires review: ${file}`);
      }
    }
  }
  if (owned.length > 1) throw new Error(`Ambiguous duplicate owned registrations: ${file}`);
  const nodeCommand = realNode('node', options.nodeExecutable, options.searchPath) ? 'node' : shellQuote(options.nodeExecutable);
  const command = `${nodeCommand} ${shellQuote(options.script)}${host === 'claude' ? ' --claude' : ''}`;
  if (!owned.length) entries.push({ hooks: [{ type: 'command', command, timeout: 3 }] });
  // Existing exact registrations are preserved byte-for-byte, including private group options.
  config.hooks.UserPromptSubmit = entries;
  const after = owned.length ? before : `${JSON.stringify(config, null, 2)}\n`;
  return { host, file, before, after, mode, changed: before !== after, registration: owned.length ? 'present' : 'add' };
}

export function planUserModelHooks({ home = os.homedir(), nodeExecutable = process.execPath, searchPath = process.env.PATH || '' } = {}) {
  home = path.resolve(home);
  const script = path.join(home, '.claude/model-router/bin/user-model-prompt-hook.mjs');
  const options = { home, script, nodeExecutable: path.resolve(nodeExecutable), searchPath };
  return { home, script, changes: [
    configPlan(path.join(home, '.claude/settings.json'), 'claude', options),
    configPlan(path.join(home, '.codex/hooks.json'), 'codex', options),
  ] };
}

export function applyUserModelHooks(plan) {
  assertSafePath(plan.script, plan.home);
  if (!fs.existsSync(plan.script)) throw new Error('Install the user hook runtime before applying registrations');
  // Validate every original before any writes, so stale plans never overwrite a concurrent edit.
  for (const change of plan.changes) {
    assertSafePath(change.file, plan.home);
    const current = fs.existsSync(change.file) ? fs.readFileSync(change.file, 'utf8') : null;
    if (current !== change.before) throw new Error(`Config changed since plan: ${change.file}`);
  }
  const written = [];
  for (const change of plan.changes.filter(item => item.changed)) {
    fs.mkdirSync(path.dirname(change.file), { recursive: true, mode: 0o700 });
    assertSafePath(change.file, plan.home);
    const suffix = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const backup = change.before === null ? null : `${change.file}.backup-${suffix}`;
    if (backup) fs.copyFileSync(change.file, backup, fs.constants.COPYFILE_EXCL);
    const temporary = `${change.file}.tmp-${suffix}`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', change.mode);
      fs.writeFileSync(fd, change.after); fs.fchmodSync(fd, change.mode); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      assertSafePath(change.file, plan.home);
      const latest = fs.existsSync(change.file) ? fs.readFileSync(change.file, 'utf8') : null;
      if (latest !== change.before) throw new Error(`Config changed before rename: ${change.file}`);
      fs.renameSync(temporary, change.file);
      written.push({ file: change.file, backup });
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return { applied: true, written };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--apply', '--dry-run', '--plan'].includes(arg))) throw new Error('Usage: user-model-hook-install.mjs [--apply|--dry-run|--plan]');
    const plan = planUserModelHooks();
    const result = args.includes('--apply') ? applyUserModelHooks(plan) : { applied: false, script: plan.script, changes: plan.changes.map(({ host, file, changed, registration }) => ({ host, file, changed, registration })) };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
