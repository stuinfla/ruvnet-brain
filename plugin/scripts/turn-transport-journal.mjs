import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const turnQueueDirectory = (db) => path.join(path.dirname(db), 'turn-outbox');
function regular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (!directory && (!stat.isFile() || stat.nlink !== 1))
    || (directory && (!stat.isDirectory() || fs.realpathSync.native(file) !== file))) throw new Error('unsafe turn journal path');
}
// Node's Windows directory handles do not consistently support fsync. Never weaken
// file fsync or hide unexpected I/O errors; a missing namespace flush is reported.
export function syncTurnDirectory(dir, { platform = process.platform, io = fs } = {}) {
  let fd;
  try {
    fd = io.openSync(dir, 'r'); io.fsyncSync(fd);
    return { platform, directoryFsync: 'completed' };
  } catch (error) {
    if (platform !== 'win32' || !['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
    return { platform, directoryFsync: 'unavailable', reason: error.code,
      limitation: 'file fsync remains required; directory-entry persistence across power loss is unproven' };
  } finally { if (fd !== undefined) io.closeSync(fd); }
}
// Legacy recipes are data extraction inputs only, never executable commands.
export function storeData(step) {
  if (step?.kind !== 'store' || !Array.isArray(step.args) || step.args[0] !== 'memory' || step.args[1] !== 'store') throw new Error('invalid turn store operation');
  const fields = {}; const aliases = { '-k': 'key', '--key': 'key', '--value': 'value', '-n': 'namespace', '--namespace': 'namespace', '--path': 'db', '--tags': 'tags', '--provenance': 'provenance' };
  let strict = false;
  for (let i = 2; i < step.args.length; i++) {
    const flag = step.args[i];
    if (flag === '--no-upsert') { if (strict) throw new Error('duplicate turn store flag'); strict = true; continue; }
    const field = aliases[flag];
    if (!field || Object.hasOwn(fields, field) || typeof step.args[i + 1] !== 'string') throw new Error('unknown or duplicate turn store flag');
    fields[field] = step.args[++i];
  }
  if (!fields.key || typeof fields.value !== 'string' || fields.namespace !== 'turns' || !path.isAbsolute(fields.db || '')) throw new Error('invalid turn store namespace or data');
  return { key: fields.key, value: fields.value, db: fields.db };
}
const bindingOf = (step) => ({ projectRoot: step.projectRoot, projectDir: step.projectDir, rootIdentity: step.rootIdentity });
function validateBinding(binding) {
  if (!binding || Object.keys(binding).some((key) => !['projectRoot', 'projectDir', 'rootIdentity'].includes(key))
    || !path.isAbsolute(binding.projectRoot || '') || !path.isAbsolute(binding.projectDir || '')
    || typeof binding.rootIdentity !== 'string' || !/^\d+:\d+$/.test(binding.rootIdentity)) throw new Error('invalid turn canonical binding');
}
export function journalTurn(step, db, key, { platform = process.platform, io = fs, onDurability } = {}) {
  const dir = turnQueueDirectory(db);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); regular(dir, true);
  const file = path.join(dir, `${digest(key)}.json`);
  const data = storeData(step);
  if (data.db !== db || data.key !== key) throw new Error('turn journal identity mismatch');
  const binding = bindingOf(step); validateBinding(binding);
  const record = { schemaVersion: 2, key, value: data.value, contentDigest: digest(data.value), consentScope: 'canonical-project-and-path', binding };
  let created = false;
  try {
    const fd = io.openSync(file, 'wx', 0o600);
    created = true;
    try { io.writeFileSync(fd, JSON.stringify(record)); io.fsyncSync(fd); } finally { io.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = readJournal(file, db);
    if (previous.key !== key || previous.contentDigest !== record.contentDigest) throw new Error('turn journal identity collision');
    // Reflush an existing complete entry: its creator may have died before fsync.
    const fd = io.openSync(file, 'r+');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  const evidence = { fileFsync: 'completed', entry: created ? 'created-exclusively' : 'existing-exact-match-reflushed', ...syncTurnDirectory(dir, { platform, io }) };
  if (onDurability) onDurability(evidence);
  return file;
}
export function readJournal(file, db) {
  const dir = turnQueueDirectory(db); regular(dir, true);
  if (path.dirname(file) !== dir) throw new Error('foreign turn journal rejected');
  regular(file);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  let normalized = record;
  if (record.schemaVersion === 1) {
    const data = storeData(record.step);
    if (!record.step.args.includes('--no-upsert')) throw new Error('legacy turn journal requires strict insert');
    if (data.db !== db || data.key !== record.key) throw new Error('legacy turn journal identity mismatch');
    // Legacy job-selected consent settings are never consumed; caller policy governs replay.
    normalized = { schemaVersion: 2, key: data.key, value: data.value, contentDigest: record.contentDigest,
      consentScope: record.consentScope, binding: bindingOf(record.step), legacyBrainHome: record.step.brainHome };
  } else if (Object.keys(record).some((key) => !['schemaVersion', 'key', 'value', 'contentDigest', 'consentScope', 'binding'].includes(key))) throw new Error('unknown turn journal field');
  validateBinding(normalized.binding);
  if (normalized.schemaVersion !== 2 || normalized.consentScope !== 'canonical-project-and-path'
    || typeof normalized.key !== 'string' || !normalized.key.startsWith('turn-') || normalized.key.length > 250
    || typeof normalized.value !== 'string' || normalized.value.length > 4000
    || digest(normalized.value) !== normalized.contentDigest
    || path.basename(file) !== `${digest(normalized.key)}.json`) throw new Error('invalid turn journal');
  return normalized;
}
export function pendingTurnFiles(db, limit = 10) {
  const dir = turnQueueDirectory(db);
  try { regular(dir, true); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().slice(0, Math.min(25, Math.max(0, limit))).map((name) => path.join(dir, name));
}
export function acknowledgeJournal(file, db, options = {}) {
  readJournal(file, db); fs.unlinkSync(file); return syncTurnDirectory(path.dirname(file), options);
}
export function appendReceipt(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) regular(file);
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(row)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
