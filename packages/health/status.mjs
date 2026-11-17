// Per-process status files (state/status/<pid>.json) and the one evidence reader all health
// readers use. Each server writes only its own file, by write-then-rename.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths, readJson, readConfig } from '../contract/home.mjs';

/**
 * Writes one server's status file, only while the home is installed (review F12): with no
 * current.json (uninstalled) it writes nothing, and it never creates the home or state/, so a server
 * left running in an open session cannot bring an uninstalled home back. Returns whether it wrote.
 */
export function writeStatus(home, status) {
  const p = paths(home);
  if (!fs.existsSync(p.current)) return false;
  try {
    fs.mkdirSync(p.status);
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
  }
  const file = path.join(p.status, `${status.pid}.json`);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return true;
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
    .map((n) => [n, readJson(path.join(paths(home).status, n), null)])
    .filter(([n, s]) => s && s.schema === 'ruvnet-brain/status' && s.version === 1 && Number.isInteger(s.pid) && n === `${s.pid}.json`)
    .map(([, s]) => s)
    .map((s) => ({ ...s, alive: isAlive(s.pid) }));
}

/**
 * Everything the verdict needs, read from disk: the live servers' status files (engine self-test,
 * heartbeat, last search), the installed release record (current.json), the last update result
 * (update.json) and the last update check (update-check.json). Reads only; writes nothing.
 */
export function readEvidence(home, { now = Date.now(), pids = null } = {}) {
  const p = paths(home);
  const cfg = readConfig(home);
  const servers = readStatuses(home).filter((s) => !pids || pids.includes(s.pid));
  const pointer = readJson(p.current, null);
  return {
    now,
    installed: fs.existsSync(p.current),
    pointer,
    servers,
    update: readJson(p.update, null),
    updateCheck: readJson(p.updateCheck, null),
    staleAfterMs: cfg.staleAfterMs,
    rollbackNoticeMs: cfg.rollbackNoticeMs,
    probeIntervalMs: cfg.probeIntervalMs,
    autoUpdate: cfg.autoUpdate,
    updateUrl: cfg.updateUrl,
    // Hosts registered without version 5's server (state/hosts.json, written by the host registration).
    unserved: readJson(path.join(p.state, 'hosts.json'), null)?.unserved ?? [],
  };
}
