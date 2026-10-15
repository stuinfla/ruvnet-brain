/**
 * Decision refusal observations, not repair-success proof. An allowed PreToolUse retry is an
 * admission; no PostToolUse completion is observed here. Historical corrected records remain
 * untouched and are labeled as legacy admissions in the report. Fresh foreign-session debts are
 * retained. Only explicit session closure is abandonment; old observations may expire by age.
 *
 * The existing JSON/JSONL paths remain intact. Owned exclusive locks serialize pending snapshots
 * and ledger appends; atomic/fsynced publication follows the repository's existing write protocol.
 * Malformed, linked, busy or full state is unavailable, never replaced, truncated or written through.
 * Logging remains best-effort and cannot alter the gate's verdict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const CONFIG_ROOT = process.env.RUVNET_CONFIG_ROOT || path.join(os.homedir(), '.config', 'ruvnet-brain');
export const LEDGER = process.env.RUVNET_DECISION_LEDGER || path.join(CONFIG_ROOT, 'decision-outcomes.jsonl');
export const PENDING = process.env.RUVNET_DECISION_PENDING || path.join(CONFIG_ROOT, 'decision-pending.json');
const MAX_LEDGER_BYTES = 1 << 20;
const MAX_PENDING = 200;
const LOCK_WAIT_MS = 1000;
const TERMINAL = new Set(['admitted-retry', 'corrected', 'repeated', 'abandoned', 'expired']);

export function actionKey(toolName, toolInput) {
  const t = String(toolName || '').toLowerCase();
  const i = toolInput || {};
  if (t === 'bash') {
    // First two words of the command: `git commit -m …` and `git commit -m …else` are one action.
    return `bash:${String(i.command || '').trim().split(/\s+/).slice(0, 2).join(' ')}`;
  }
  return `${t}:${String(i.file_path || i.path || '').trim()}`;
}


function regular(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1
      || (typeof process.getuid === 'function' && st.uid !== process.getuid())) throw Error('unmanaged decision state');
    if (st.size > MAX_LEDGER_BYTES) throw Error('decision state capacity exhausted');
    return st;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function readPending(file) {
  if (!regular(file)) return {};
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('pending state unavailable');
  return value;
}
function readLedger(file) {
  if (!regular(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line);
    if (row?.kind === 'refused' || TERMINAL.has(row?.kind)) {
      if (!validDebt(row) || (row.host != null && typeof row.host !== 'string')
        || (row.projectId != null && !/^[a-f0-9]{64}$/.test(row.projectId))) throw Error('malformed decision observation');
      if (row.kind === 'admitted-retry' && (typeof row.refusalId !== 'string' || !row.refusalId
        || row.evidence !== 'pretool-decision-observation' || row.repairVerified !== false)) throw Error('malformed admitted observation');
    }
    return row;
  });
}
/** Same owned wx/token protocol as the existing grounding and continuity handlers. */
function locked(files, work, fallback, { deadlineAt = Infinity, nonBlocking = true } = {}) {
  const paths = [...new Set(files)].sort(), held = [], token = randomUUID();
  const owns = () => held.every(({ file }) => {
    try { return !fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file, 'utf8') === token; } catch { return false; }
  });
  try {
    if (!(Number.isFinite(deadlineAt) || deadlineAt === Infinity) || Date.now() >= deadlineAt) return fallback;
    const deadline = Math.min(Date.now() + LOCK_WAIT_MS, deadlineAt);
    for (const target of paths) {
      if (Date.now() >= deadline) return fallback;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      regular(target);
      const file = target + '.lock';
      for (;;) {
        try {
          const fd = fs.openSync(file, 'wx', 0o600); held.push({ file, fd }); fs.writeSync(fd, token); break;
        } catch (error) {
          if (error.code !== 'EEXIST' || nonBlocking || Date.now() >= deadline) return fallback;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
    }
    const permitted = () => Date.now() < deadline && owns();
    if (!permitted()) return fallback;
    return work(permitted);
  } catch { return fallback; }
  finally {
    for (const { file, fd } of held.reverse()) {
      try { fs.closeSync(fd); } catch {}
      try { if (!fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file); } catch {}
    }
  }
}
function writePending(file, value, owns) {
  const previous = regular(file), temp = `${file}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temp, 'wx', previous ? previous.mode & 0o777 : 0o600);
  try {
    const text = JSON.stringify(value);
    if (fs.writeSync(fd, text) !== Buffer.byteLength(text)) throw Error('incomplete pending state write');
    fs.fsyncSync(fd);
    if (!owns()) throw Error('decision state lock changed');
    fs.renameSync(temp, file);
  } finally { fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
}
function appendLocked(record, file, owns) {
  const st = regular(file), text = JSON.stringify(record) + '\n';
  if ((st?.size || 0) + Buffer.byteLength(text) > MAX_LEDGER_BYTES || !owns()) throw Error('decision ledger unavailable');
  const fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
  try {
    if (fs.writeSync(fd, text) !== Buffer.byteLength(text)) throw Error('incomplete decision ledger write');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
export function append(record, file = LEDGER, budget = {}) {
  return locked([file], owns => { appendLocked(record, file, owns); return true; }, false, budget);
}
const stateFiles = files => ({ pending: files.pending || PENDING, ledger: files.ledger || LEDGER });
const debtId = debt => debt.refusalId || createHash('sha256').update(JSON.stringify([debt.session, debt.key, debt.ts, debt.host || null, debt.projectId || null])).digest('hex');
const validDebt = value => value && typeof value.session === 'string' && typeof value.key === 'string'
  && value.session.length > 0 && value.key.length > 0 && Number.isFinite(value.ts) && Array.isArray(value.policies)
  && value.policies.every(policy => typeof policy === 'string');
function scopeOf(host, project) {
  if (host !== undefined && host !== null && typeof host !== 'string') throw Error('host scope unavailable');
  const projectId = project ? createHash('sha256').update(fs.realpathSync(project)).digest('hex') : null;
  return { host: host || null, projectId };
}
const sameScope = (left, right) => (left.host || null) === (right.host || null) && (left.projectId || null) === (right.projectId || null);
const pendingId = debt => `${debt.session}\u0000${debt.key}${debt.host || debt.projectId ? `\u0000${debt.host || ''}\u0000${debt.projectId || ''}` : ''}`;
const terminals = rows => new Set(rows.filter(row => TERMINAL.has(row?.kind) && validDebt(row)).map(debtId));
function debts(pending, rows) {
  const out = new Map(), closed = terminals(rows);
  for (const value of Object.values(pending)) if (validDebt(value) && !closed.has(debtId(value))) out.set(debtId(value), value);
  // Recover the crash window after a refused append was fsynced but before its pending rename.
  for (const row of rows) if (row?.kind === 'refused' && validDebt(row) && !closed.has(debtId(row))) out.set(debtId(row), row);
  return [...out.values()];
}
function transaction(files, callback, fallback, budget = {}) {
  const f = stateFiles(files);
  return locked([f.pending, f.ledger], owns => callback(f, readPending(f.pending), readLedger(f.ledger), owns), fallback, budget);
}
export function recordRefusal({ session, key, policies, ts, host, project, deadlineAt, nonBlocking }, files = {}) {
  if (!validDebt({ session, key, policies, ts })) return false;
  return transaction(files, (f, pending, rows, owns) => {
    const scope = scopeOf(host, project), id = pendingId({ session, key, ...scope });
    if (pending[id] && !validDebt(pending[id])) return false;
    const open = debts(pending, rows);
    const prior = open.find(value => value.session === session && value.key === key && sameScope(value, scope));
    if (open.length >= MAX_PENDING && !prior) return false; // defer; never abandon another owner to make room
    if (prior) appendLocked({ ...prior, kind: 'repeated', ts, refusalId: debtId(prior) }, f.ledger, owns);
    const debt = { session, key, policies, ts, ...scope, refusalId: randomUUID() };
    appendLocked({ ...debt, kind: 'refused' }, f.ledger, owns);
    pending[id] = debt; writePending(f.pending, pending, owns);
    return true;
  }, false, { deadlineAt, nonBlocking });
}
export function resolve({ session, key, allowed, ts, host, project, deadlineAt, nonBlocking }, files = {}) {
  if (typeof allowed !== 'boolean' || typeof session !== 'string' || typeof key !== 'string' || !Number.isFinite(ts)) return null;
  return transaction(files, (f, pending, rows, owns) => {
    const scope = scopeOf(host, project), id = pendingId({ session, key, ...scope });
    const debt = debts(pending, rows).find(value => value.session === session && value.key === key && sameScope(value, scope));
    if (!debt) {
      if (validDebt(pending[id]) && terminals(rows).has(debtId(pending[id]))) { delete pending[id]; writePending(f.pending, pending, owns); }
      return null;
    }
    const kind = allowed === true ? 'admitted-retry' : 'repeated';
    appendLocked({ kind, session, key, ...scope, policies: debt.policies, ts, refusalId: debtId(debt), afterMs: ts - debt.ts,
      evidence: 'pretool-decision-observation', repairVerified: false }, f.ledger, owns);
    if (validDebt(pending[id])) delete pending[id];
    writePending(f.pending, pending, owns);
    return kind;
  }, null, { deadlineAt, nonBlocking });
}
function closeDebts(files, ts, predicate, kind, budget = {}) {
  return transaction(files, (f, pending, rows, owns) => {
    const selected = debts(pending, rows).filter(predicate);
    for (const debt of selected) {
      appendLocked({ kind, session: debt.session, key: debt.key, host: debt.host || null, projectId: debt.projectId || null,
        policies: debt.policies, ts, refusalId: debtId(debt) }, f.ledger, owns);
      const id = pendingId(debt); if (validDebt(pending[id])) delete pending[id];
    }
    if (selected.length) writePending(f.pending, pending, owns);
    return selected.length;
  }, 0, budget);
}
/** A differing session is not evidence of abandonment; only proven observation age expires debt. */
export function sweepStale({ session, ts, maxAgeMs = 6 * 60 * 60_000, deadlineAt, nonBlocking }, files = {}) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || !Number.isFinite(ts)) return 0;
  return closeDebts(files, ts, debt => ts - debt.ts > maxAgeMs, 'expired', { deadlineAt, nonBlocking });
}
/** Explicit session closure only affects that named session; not an automatic lifecycle delivery claim. */
export function abandonSession(session, ts, files = {}, scopeInput = {}) {
  if (!Number.isFinite(ts)) return 0;
  let scope; try { scope = scopeOf(scopeInput.host, scopeInput.project); } catch { return 0; }
  return closeDebts(files, ts, debt => debt.session === session && sameScope(debt, scope), 'abandoned', scopeInput);
}
export function report(files = {}) {
  const unavailable = { available: false, metricBasis: 'pretool-admission-only', admittedRetryRate: null,
    correctedRate: null, repairSuccessRate: null, reason: 'decision measurement busy, full or unreadable' };
  return transaction(files, (f, pending, rows) => {
    const count = kind => rows.filter(row => row?.kind === kind).length;
    const legacyCorrectedRecords = count('corrected');
    const admittedRetries = count('admitted-retry') + legacyCorrectedRecords;
    const repeated = count('repeated'), abandoned = count('abandoned'), expired = count('expired');
    const resolved = admittedRetries + repeated + abandoned + expired, open = debts(pending, rows).length;
    const byPolicy = Object.create(null);
    for (const row of rows) {
      if (!TERMINAL.has(row?.kind)) continue;
      const field = ['corrected', 'admitted-retry'].includes(row.kind) ? 'admittedRetries' : row.kind;
      for (const policy of Array.isArray(row.policies) ? row.policies : []) {
        byPolicy[policy] ||= { admittedRetries: 0, repeated: 0, abandoned: 0, expired: 0 }; byPolicy[policy][field]++;
      }
    }
    const atCapacity = open >= MAX_PENDING || (regular(f.ledger)?.size || 0) >= MAX_LEDGER_BYTES;
    return { available: !atCapacity, completeCoverage: false, metricBasis: 'pretool-admission-only', refused: count('refused'), resolved, open,
      admittedRetries, legacyCorrectedRecords, repeated, abandoned, expired, byPolicy, atCapacity,
      foreignPendingRecords: Object.values(pending).filter(value => !validDebt(value)).length,
      admittedRetryRate: !atCapacity && resolved ? +(admittedRetries / resolved).toFixed(3) : null,
      correctedRate: null, repairSuccessRate: null };
  }, unavailable);
}
