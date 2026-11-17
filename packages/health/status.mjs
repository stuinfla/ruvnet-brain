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
