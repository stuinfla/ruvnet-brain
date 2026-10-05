#!/usr/bin/env node
/**
 * Explicit local repair for the Codex cache copy of security-guidance 2.0.9.
 * Dry run by default; --apply is required. No plugin trust/settings changes.
 * Codex 0.160.0's installed post-tool-use.command.output rejects metrics and
 * rewakeSummary; its parser also rejects updatedMCPToolOutput semantically.
 * This source-bound patch routes telemetry to the plugin's existing debug log,
 * preserves security controls/context, and leaves other events/review logic intact.
 * Future versions or different source bytes require a new reviewed compatibility
 * patch. A successful repair is not native execution evidence or future-update support.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const COMPATIBILITY = Object.freeze({
  version: '2.0.9', nativeContract: 'Codex 0.160.0 PostToolUse',
  originalSha256: '2766399e43bd923ed786f8bb0fcbf6d2055b3ad4ef79ec73f722be19122de1f8',
  patchedSha256: '4bba541507b54b6b1f882ac13d49be9b8ea865b4e3dc3fd870820a3b48749de1',
  patchSha256: '49f0c628775d9b12a5b50ea5d3072a031c3a2e986fee050dd80f46c044677a35',
});
const PATCH = fileURLToPath(new URL('../config/hook-compat/security-guidance-2.0.9.patch', import.meta.url));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const noFollow = fs.constants.O_NOFOLLOW;

function requireRegularPath(file) {
  let current = path.parse(file).root;
  for (const segment of file.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (current !== file && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
    if (current === file && !stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  }
}

function readRegular(file) {
  requireRegularPath(file);
  if (noFollow === undefined) throw new Error('O_NOFOLLOW is required for this repair');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    return { bytes: fs.readFileSync(fd), stat };
  } finally { fs.closeSync(fd); }
}

/** Apply only the checked-in exact-context hunks, without invoking patch/git/Python. */
export function applyCompatibilityPatch(original) {
  const patch = readRegular(PATCH).bytes;
  if (sha256(patch) !== COMPATIBILITY.patchSha256) throw new Error('Compatibility patch digest mismatch');
  if (sha256(original) !== COMPATIBILITY.originalSha256) throw new Error('Original source digest mismatch');
  const source = original.toString('utf8').split('\n');
  const lines = patch.toString('utf8').split('\n');
  const result = [];
  let cursor = 0;
  for (let i = 2; i < lines.length; i++) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(lines[i]);
    if (!header) { if (!lines[i]) continue; throw new Error('Unexpected patch structure'); }
    const start = Number(header[1]) - 1;
    if (start < cursor) throw new Error('Overlapping patch hunks');
    result.push(...source.slice(cursor, start)); cursor = start;
    let oldCount = 0; let newCount = 0;
    while (i + 1 < lines.length && !lines[i + 1].startsWith('@@ ') && lines[i + 1] !== '') {
      const line = lines[++i]; const type = line[0]; const content = line.slice(1);
      if (![' ', '-', '+'].includes(type)) throw new Error('Unsupported patch line');
      if (type !== '+') {
        if (source[cursor++] !== content) throw new Error('Compatibility patch context mismatch');
        oldCount++;
      }
      if (type !== '-') { result.push(content); newCount++; }
    }
    if (oldCount !== Number(header[2]) || newCount !== Number(header[4])) throw new Error('Patch hunk count mismatch');
  }
  result.push(...source.slice(cursor));
  const patched = Buffer.from(result.join('\n'));
  if (sha256(patched) !== COMPATIBILITY.patchedSha256) throw new Error('Patched source digest mismatch');
  return patched;
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | noFollow);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function repairSecurityGuidance({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), apply = false } = {}) {
  if (!path.isAbsolute(codexHome) || path.normalize(codexHome).split(path.sep).includes('.claude')) {
    throw new Error('An absolute Codex home is required; Claude cache repair is forbidden');
  }
  const target = path.join(codexHome, 'plugins/cache/claude-plugins-official/security-guidance', COMPATIBILITY.version, 'hooks/security_reminder_hook.py');
  const original = readRegular(target);
  const digest = sha256(original.bytes);
  const receipt = { target, compatibility: COMPATIBILITY, sourceSha256: digest, apply, status: 'dry-run' };
  if (digest === COMPATIBILITY.patchedSha256) return { ...receipt, status: 'already-patched' };
  if (digest !== COMPATIBILITY.originalSha256) throw new Error(`Unknown security-guidance source: ${digest}; refusing to patch ${target}`);
  const patched = applyCompatibilityPatch(original.bytes);
  if (!apply) return receipt;
  const dir = path.dirname(target);
  const backup = `${target}.${COMPATIBILITY.originalSha256}.original`;
  let fd;
  try {
    fd = fs.openSync(backup, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, original.bytes);
    fs.fchmodSync(fd, (original.stat.mode & 0o444) || 0o400);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (sha256(readRegular(backup).bytes) !== digest) throw new Error('Existing immutable backup digest mismatch');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  syncDirectory(dir);
  const temporary = path.join(dir, `.security-guidance-compat-${crypto.randomUUID()}.tmp`);
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    try {
      fs.writeFileSync(fd, patched);
      fs.fchmodSync(fd, original.stat.mode & 0o777);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const current = readRegular(target);
    if (current.stat.dev !== original.stat.dev || current.stat.ino !== original.stat.ino || sha256(current.bytes) !== digest) {
      throw new Error('Plugin source changed during repair; refusing replacement');
    }
    fs.renameSync(temporary, target);
    syncDirectory(dir);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { ...receipt, status: 'patched', backup, patchedSha256: sha256(readRegular(target).bytes) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    let codexHome; let apply = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply') apply = true;
      else if (args[i] === '--codex-home' && args[i + 1]) codexHome = args[++i];
      else throw new Error(`Unknown argument: ${args[i]}`);
    }
    console.log(JSON.stringify(repairSecurityGuidance({ codexHome, apply }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
