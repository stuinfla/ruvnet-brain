// Per-process status files (state/status/<pid>.json) and the one evidence reader all health
// readers use. Each server writes only its own file, by write-then-rename.
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, readConfig, writeJsonAtomic } from '../contract/home.mjs';

export function writeStatus(home, status) {
  writeJsonAtomic(path.join(paths(home).status, `${status.pid}.json`), status);
}

export function removeStatus(home, pid) {
  try {
    fs.unlinkSync(path.join(paths(home).status, `${pid}.json`));
  } catch {}
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function readStatuses(home) {
  let names = [];
  try {
    names = fs.readdirSync(paths(home).status).filter((n) => /^\d+\.json$/.test(n));
  } catch {}
  return names
    .map((n) => readJson(path.join(paths(home).status, n), null))
    .filter((s) => s && Number.isInteger(s.pid))
    .map((s) => ({ ...s, alive: isAlive(s.pid) }));
}

/** Everything verdict() needs, read from disk. Reads only; writes nothing. */
export function readEvidence(home, { now = Date.now(), pids = null } = {}) {
  const cfg = readConfig(home);
  const servers = readStatuses(home).filter((s) => !pids || pids.includes(s.pid));
  return {
    now,
    installed: fs.existsSync(paths(home).current),
    servers,
    update: readJson(paths(home).update, null),
    staleAfterMs: cfg.staleAfterMs,
    rollbackNoticeMs: cfg.rollbackNoticeMs,
  };
}
