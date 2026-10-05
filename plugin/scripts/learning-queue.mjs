// Workflow queue transport only. Retained source bytes plus acknowledgments permit crash replay.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_QUEUE_BYTES = 1024 * 1024;
export const WORKER_BUDGET_MS = 18_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const nofollow = fs.constants.O_NOFOLLOW || 0;
export const queueName = /^session-[A-Za-z0-9_-]+\.jsonl$/;

/** Reject symlinks/junctions at every ancestor beneath the canonical selected scope. */
export function safeQueue(context, create = false) {
  const root = fs.realpathSync.native(context.scope === 'user' ? context.home : context.projectDir);
  const relative = path.relative(root, context.queueDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('queue outside scope');
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(current) !== current) throw new Error('unsafe queue ancestor');
  }
  return current;
}

export function readSafe(file, maxBytes = MAX_QUEUE_BYTES) {
  if (!fs.lstatSync(file).isFile()) throw new Error('unsafe queue file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | nofollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('queue file exceeds bounded read');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function queueFiles(context, options = {}) {
  try {
    const dir = safeQueue(context);
    if (Number.isInteger(options.limit)) {
      const before = []; const after = []; let passed = !options.cursor;
      const iterator = fs.opendirSync(dir);
      try {
        let entry;
        while (Date.now() < options.deadline && (entry = iterator.readSync())) {
          if (!queueName.test(entry.name)) continue;
          const file = path.join(dir, entry.name);
          if (!passed && entry.name === options.cursor) { passed = true; if (before.length < options.limit) before.push(file); continue; }
          if (passed) { after.push(file); if (after.length >= options.limit) break; }
          else if (before.length < options.limit) before.push(file);
        }
      } finally { iterator.closeSync(); }
      return [...after, ...before].slice(0, options.limit);
    }
    return fs.readdirSync(dir).filter(name => queueName.test(name)).map(name => path.join(dir, name))
      .sort((a, b) => fs.lstatSync(a).mtimeMs - fs.lstatSync(b).mtimeMs || a.localeCompare(b));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** Hash-bound offsets cannot acknowledge replaced source bytes or an appended sibling line. */
export function pendingRecords(file) {
  const bytes = readSafe(file); let ack = {};
  try { ack = JSON.parse(readSafe(`${file}.ack.json`).toString()); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = []; let start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    const line = bytes.subarray(start, end + 1); const key = `${start}:${hash(line)}`;
    if (line.toString().trim() && ack[key] !== true) records.push({ key, raw: line.toString() });
    start = end + 1;
  }
  // A torn final line is pending evidence; it can become complete on a legacy writer's next append.
  if (start < bytes.length && bytes.subarray(start).toString().trim()) records.push({ key: null, raw: bytes.subarray(start).toString() });
  return { records, ack };
}

export function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | nofollow, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function writeAtomic(target, bytes) {
  try { if (!fs.lstatSync(target).isFile()) throw new Error('unsafe acknowledgment'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${target}.${randomUUID()}`;
  writeExclusive(temporary, bytes);
  fs.renameSync(temporary, target);
}
export function acknowledge(file, ack) { writeAtomic(`${file}.ack.json`, JSON.stringify(ack)); }

/** Lease lasts longer than the finite worker. PID is diagnostic, never writer authority. */
export function takeQueueLock(context, now = Date.now()) {
  const dir = safeQueue(context); const file = path.join(dir, '.worker-lock');
  const token = randomUUID(); const body = JSON.stringify({ token, expires: now + 60_000 });
  try { writeExclusive(file, body); return token; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const seen = readSafe(file).toString();
  let expires;
  try { const owner = JSON.parse(seen); if (owner.retirementUnconfirmed || owner.retirementRequired) return null; expires = owner.expires; } catch { expires = fs.lstatSync(file).mtimeMs + 60_000; }
  if (!Number.isFinite(expires)) expires = fs.lstatSync(file).mtimeMs + 60_000;
  if (!(expires < now)) return null;
  const aside = `${file}.${token}`;
  fs.renameSync(file, aside);
  if (readSafe(aside).toString() !== seen) {
    try { fs.linkSync(aside, file); } catch { /* another fenced owner already exists */ }
    fs.rmSync(aside); return null;
  }
  fs.rmSync(aside);
  try { writeExclusive(file, body); return token; } catch (error) { if (error.code === 'EEXIST') return null; throw error; }
}

export function ownsQueueLock(context, token) {
  try {
    safeQueue(context);
    const lock = JSON.parse(readSafe(path.join(context.queueDir, '.worker-lock')).toString());
    return !lock.retirementUnconfirmed && lock.token === token && Date.now() < lock.expires;
  } catch { return false; }
}
export function releaseQueueLock(context, token) {
  if (ownsQueueLock(context, token)) fs.rmSync(path.join(context.queueDir, '.worker-lock'));
}

// Fixed vocabulary: arbitrary executable names, arguments, basenames and paths never persist.
const verbs = new Set('git npm node python python3 cargo rustc go gh cd ls rg cat export mkdir rm cp mv bash sh curl wget npx ruflo'.split(' '));
const subs = new Set('status diff log show add commit push pull fetch checkout switch branch test run install ci build check fmt clippy auth workflow release memory hooks'.split(' '));
export function safeAction(tool, value) {
  if (typeof value !== 'string') return null;
  if (tool === 'Bash') {
    const [verb, sub] = value.trim().split(/\s+/, 3);
    if (!verbs.has(verb)) return 'command';
    return subs.has(sub) ? `${verb} ${sub}` : verb;
  }
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) return null;
  // Legacy action is minimized again before invocation; no private basename reaches Ruflo argv.
  return 'edit file';
}
