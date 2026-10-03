/**
 * turn-capture-state.mjs — the persistent switches and the truthful status of turn capture
 * (turn-outcome-capture.mjs), kept apart so doctor and the SessionStart brief read them cheaply.
 *
 *   <brain home>/turn-capture/settings.json  { capture: 'on'|'off', projects: { <canonical root>: 'on'|'off' },
 *                                              unadopted: 'nothing'|'global' }   — read at every Stop (ADR-0102 G-001/G-002)
 *   <brain home>/turn-capture/receipts.jsonl  one row per worker step; a store row is ok only after an exact
 *                                              read-back (G-014)
 *
 *   node turn-capture-state.mjs --capture off [--project <dir>]   persistent opt-out (machine, or one project)
 *   node turn-capture-state.mjs --unadopted global                 opt in: projects without a store record machine-wide
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { ensurePrivateDir } from './project-progression-store.mjs';

// ── persistent settings (G-001 opt-out, G-002 opt-in) ─────────────────────────────────────────────
export const brainHomeOf = ({ env = process.env, home = os.homedir() } = {}) => env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
export const turnCaptureSettingsPath = (opts) => path.join(brainHomeOf(opts), 'turn-capture', 'settings.json');

/** Absent = defaults. Present but unreadable or malformed = FAIL CLOSED (the owner wrote something). */
export function readTurnCaptureSettings(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    return error?.code === 'ENOENT' ? { ok: true, settings: {} } : { ok: false, reason: `unreadable (${error?.code || 'error'})` };
  }
  try {
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
    return { ok: true, settings };
  } catch { return { ok: false, reason: 'not valid JSON' }; }
}

/** Persist one setting change (atomic, 0600 in a 0700 directory). */
export function writeTurnCaptureSetting({ capture, project, unadopted, env = process.env, home = os.homedir() } = {}) {
  const file = turnCaptureSettingsPath({ env, home });
  const current = readTurnCaptureSettings(file);
  const next = current.ok ? { ...current.settings } : {};
  if (capture !== undefined && !['on', 'off'].includes(capture)) throw new Error('--capture takes on or off');
  if (unadopted !== undefined && !['nothing', 'global'].includes(unadopted)) throw new Error('--unadopted takes nothing or global');
  if (capture !== undefined && project) {
    const root = resolveProjectStore({ projectDir: project }).projectRoot;
    next.projects = { ...(next.projects || {}), [root]: capture };
  } else if (capture !== undefined) next.capture = capture;
  if (unadopted !== undefined) next.unadopted = unadopted;
  fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true, mode: 0o700 });
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return { file, settings: next };
}

/** Append one line to a private (0600) regular file; refuses a symlink (O_NOFOLLOW) or a hard link. */
export function appendPrivate(file, line) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error(`${path.basename(file)} is not a private regular file`);
    if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o600) fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, line);
  } finally { fs.closeSync(fd); }
}


/** Turn-store receipts for one store over a window: { total, failed, lastError, lastOkAt }. */
export function turnRecordingStatus({ db, env = process.env, home = os.homedir(), now = Date.now(), windowMs = 7 * 86_400_000 } = {}) {
  const file = path.join(brainHomeOf({ env, home }), 'turn-capture', 'receipts.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').slice(-5000); } catch { return { total: 0, failed: 0, lastError: null, lastOkAt: null }; }
  const status = { total: 0, failed: 0, lastError: null, lastOkAt: null };
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.kind !== 'store' || (db && row.db !== db) || now - Date.parse(row.at) > windowMs) continue;
    // Receipts written before G-014 carry no read-back verdict (`ok`): neither proof of a write nor of a failure.
    if (typeof row.ok !== 'boolean') continue;
    status.total += 1;
    if (row.ok === true) status.lastOkAt = row.at;
    else { status.failed += 1; status.lastError = row.error || `ruflo exited ${row.status}`; }
  }
  return status;
}

/** One line for doctor and the SessionStart brief; null when this store has no turn receipts yet. */
export function turnRecordingLine(status) {
  if (!status?.total) return null;
  if (status.failed) return `turn recording failing ${status.failed}/${status.total} in 7d — last error: ${status.lastError}`;
  return `turn recording ✓ ${status.total}/${status.total} in 7d read back by exact key`;
}


function cliValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (cliValue('--capture') === undefined && cliValue('--unadopted') === undefined) {
    process.stderr.write('usage: turn-capture-state.mjs --capture on|off [--project <dir>] | --unadopted nothing|global\n');
    process.exit(2);
  }
  try {
    const { file, settings } = writeTurnCaptureSetting({ capture: cliValue('--capture'), project: cliValue('--project'), unadopted: cliValue('--unadopted') });
    process.stdout.write(`turn capture settings saved to ${file}: ${JSON.stringify(settings)}\n`);
  } catch (error) { process.stderr.write(`turn capture settings not changed: ${error.message}\n`); process.exit(1); }
}
