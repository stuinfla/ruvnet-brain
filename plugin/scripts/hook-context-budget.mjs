import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const FRAME_KIND = 'brain-owned-context-blocks';
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const bytes = (value) => Buffer.byteLength(value, 'utf8');
export function advisoryBudgetFor(handler, event) {
  if (handler === 'ground-ruvnet') return 8192;
  if (handler === 'decision-gate') return 4096;
  if (handler === 'unprompted-speech') return event === 'UserPromptSubmit' ? 2048 : 1024;
  return null;
}
export function contextBlock(text, { id = 'block', critical = false } = {}) {
  return { id: `${id.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 64)}:${digest(text).slice(0, 16)}`, text, critical };
}
export function contextFrame(handler, event, blocks) {
  return { kind: FRAME_KIND, schemaVersion: 1, handler, event, blocks };
}
export function readContextFrame(raw) {
  let value; try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (value?.kind !== FRAME_KIND || value.schemaVersion !== 1 || !Array.isArray(value.blocks)
    || Object.keys(value).some((key) => !['kind','schemaVersion','handler','event','blocks'].includes(key))
    || typeof value.handler !== 'string' || typeof value.event !== 'string'
    || value.blocks.some((block) => typeof block?.id !== 'string' || block.id.length > 96
      || typeof block.text !== 'string' || typeof block.critical !== 'boolean')) return null;
  return value;
}
export function selectContextFrame(frame, limit = advisoryBudgetFor(frame.handler, frame.event)) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('No safe advisory allocation');
  const seen = new Set(); const selected = []; const deferred = [];
  let advisoryBytes = 0; let criticalBytes = 0;
  for (const block of frame.blocks) {
    const identity = JSON.stringify(block);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (block.critical) { selected.push(block); criticalBytes += bytes(block.text) + 2; continue; }
    const cost = bytes(block.text) + 2;
    if (advisoryBytes + cost > limit) deferred.push(block.id);
    else { selected.push(block); advisoryBytes += cost; }
  }
  const selectedIds = selected.map((block) => block.id);
  return { frame: { ...frame, blocks: selected }, receipt: { handler: frame.handler, event: frame.event,
    budgetBytes: limit, advisoryBytes, criticalBytes, criticalExemption: criticalBytes > 0,
    selectedIds: selectedIds.slice(0, 8), selectedCount: selectedIds.length,
    deferredIds: deferred.slice(0, 8), deferredCount: deferred.length,
    idsDigest: digest(JSON.stringify({ selectedIds, deferred })), scope: 'typed-advisories-per-event-not-whole-turn' } };
}
export function renderContextFrame(frame, { rawText = false } = {}) {
  const text = frame.blocks.map((block) => block.text).join('\n\n');
  return rawText ? text : JSON.stringify({ hookSpecificOutput: { hookEventName: frame.event, additionalContext: text } });
}
export function recordContextBudget(receipt, env = process.env) {
  if (env.RUVNET_BRAIN_METER === '0') return;
  try {
    const directory = path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'ruvnet-brain');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) return;
    const file = path.join(directory, 'token-ledger.jsonl');
    if (fs.existsSync(file)) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return; }
    const line = JSON.stringify({ ts: new Date().toISOString(), source: 'hook', class: 'context-budget', ...receipt });
    if (bytes(line) > 2048) return;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try { fs.writeSync(fd, line + '\n'); } finally { fs.closeSync(fd); }
  } catch { /* Metrics never alter a guard or permission decision. */ }
}
export function emitOwnedContext(frame, { env = process.env, rawText = false } = {}) {
  const selected = selectContextFrame(frame);
  recordContextBudget(selected.receipt, env);
  return env.RUVNET_CODEX_CONTEXT_FRAMES === '1' ? JSON.stringify(selected.frame) : renderContextFrame(selected.frame, { rawText });
}

let direct = false;
try { direct = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (direct && process.argv[2] === '--ground-dir') {
  const directory = process.argv[3]; const blocks = [];
  for (const id of fs.readdirSync(directory).filter((id) => /^\d+-\d+-[\w-]+$/.test(id)).sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))) {
    let picked; try { picked = fs.readFileSync(path.join(directory, id + '.pick'), 'utf8').trim(); } catch { continue; }
    if (!['full', 'short'].includes(picked)) continue;
    const text = fs.readFileSync(path.join(directory, id + (picked === 'short' ? '.short' : '')), 'utf8');
    blocks.push(contextBlock(text, { id, critical: id.split('-')[1] === '0' }));
  }
  try {
    const deferred = fs.readFileSync(path.join(directory, '.budget-deferred'), 'utf8').split('\n').filter(Boolean);
    if (deferred.length) recordContextBudget({ handler: 'ground-ruvnet', event: 'UserPromptSubmit', scope: 'pre-mark-budget-deferral', deferredCount: deferred.length, deferredIds: deferred.slice(0, 8) });
  } catch { /* No optional block was deferred by the existing assembler. */ }
  process.stdout.write(emitOwnedContext(contextFrame('ground-ruvnet', 'UserPromptSubmit', blocks), { rawText: true }));
}
