/**
 * hook-failures.mjs — the reader half of "a failed advisory hook is a status line" (ADR-106).
 *
 * hook-shim.mjs appends one line to `<Brain home>/hook-failures.jsonl` whenever an advisory body
 * exits nonzero, is killed, or cannot spawn (the writer is inlined there because the shim is
 * boot-frozen). SessionStart calls failureLine() once: it summarizes failures recorded since the
 * last summary and advances a byte cursor, so each failure is reported exactly once, never per fire.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const FAILURE_FILE = 'hook-failures.jsonl';
export const FAILURE_LINE_PREFIX = '[RuvNet Brain — HOOK FAILURES]';
const CURSOR_FILE = 'hook-failures.cursor';
const MAX_READ = 256 * 1024;

/** Summarize failures recorded after the cursor; advance it. Returns '' when there is nothing new. */
export function failureLine(brainHome, { advance = true } = {}) {
  const file = path.join(brainHome, FAILURE_FILE);
  const cursorFile = path.join(brainHome, CURSOR_FILE);
  let size;
  try { size = fs.statSync(file).size; } catch { return ''; }
  let offset = 0;
  try { offset = Number(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).offset) || 0; } catch { /* first read */ }
  if (offset > size) offset = 0; // rotated by the writer
  if (offset === size) return '';
  const start = Math.max(offset, size - MAX_READ);
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  const rows = buf.toString('utf8').split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  if (advance) { try { fs.writeFileSync(cursorFile, JSON.stringify({ offset: size })); } catch { /* re-reported next session */ } }
  if (!rows.length) return '';
  const byHook = new Map();
  for (const r of rows) {
    const id = String(r.hook || 'unknown').slice(0, 40);
    const why = r.note ? String(r.note).split(':')[0].slice(0, 48) : r.error ? String(r.error).slice(0, 40) : r.signal ? String(r.signal) : `exit ${r.status}`;
    const e = byHook.get(id) || { n: 0, why: new Set() };
    e.n += 1; e.why.add(why); byHook.set(id, e);
  }
  const parts = [...byHook.entries()].sort((a, b) => b[1].n - a[1].n)
    .map(([id, e]) => `${id} ×${e.n} (${[...e.why].slice(0, 3).join(', ')})`);
  return `${FAILURE_LINE_PREFIX} ${rows.length} advisory hook run(s) did not complete or did not resolve since ${rows[0].at}: ${parts.join('; ')}. `
    + `They failed open. Details: ${file}`;
}

/**
 * The writer for bodies that run OUTSIDE the shim's watchdog (a refused `ruflo memory store`, a failed
 * exact readback). Same file, same row shape as hook-shim.mjs's inlined recordFailure, so the next
 * SessionStart's failureLine() reports it. Never throws: an unrecordable failure must not become a second one.
 */
export function recordHookFailure(fields, { brainHome = process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache', 'ruvnet-brain') } = {}) {
  try {
    const file = path.join(brainHome, FAILURE_FILE);
    fs.mkdirSync(brainHome, { recursive: true });
    try { if (fs.statSync(file).size > 256 * 1024) fs.renameSync(file, `${file}.1`); } catch { /* absent */ }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...fields })}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}
