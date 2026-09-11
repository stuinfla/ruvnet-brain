#!/usr/bin/env node
// session-start-fsutil.mjs — the small set of fail-silent fs/process helpers every SessionStart
// stage module needs. Extracted 2026-09-11 so session-start-core.mjs's own file could shrink below
// 500 lines by moving stage bodies into their own modules without each one re-implementing the same
// six helpers. Every function here is deliberately fail-open: SessionStart is advisory and must
// never throw a session over a missing file or a slow subprocess.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const read = (file, fallback = '') => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
};

export const json = (file, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export const exists = (file) => {
  try { return fs.existsSync(file); } catch { return false; }
};

export const mkdir = (dir) => {
  try { fs.mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
};

export const write = (file, value) => {
  try { mkdir(path.dirname(file)); fs.writeFileSync(file, String(value)); return true; } catch { return false; }
};

export const mtimeMs = (file) => {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
};

export const firstVersion = (text) => String(text).split(/\r?\n/).find((line) =>
  /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(line.trim()))?.trim() || '';

/** spawnSync a node script, fail-silent: a missing file, a spawn error, or a timeout all resolve to
 * null — never thrown. SessionStart is advisory; no stage may fail a session over a subprocess. */
export const runNode = (file, args = [], options = {}) => {
  if (!exists(file)) return null;
  try {
    return spawnSync(process.execPath, [file, ...args], {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: options.stdio || 'ignore',
      timeout: options.timeout,
      windowsHide: true,
    });
  } catch { return null; }
};

/** Launch a maintenance job OUT of this process's own wait — via the shared detach.mjs launcher,
 * which forks a truly detached child and returns in ~40ms (see plugin/scripts/detach.mjs's own
 * header). `timeout: 2000` bounds ONLY the launch step (spawning the detached grandchild), never the
 * job itself, whose lifetime is `ttl` seconds inside detach.mjs's own supervisor. */
export const dispatchDetached = (hookDir, ttl, log, command, args = [], env = process.env) =>
  runNode(path.join(hookDir, 'detach.mjs'), [
    String(ttl), log, command, ...args,
  ], { env, stdio: 'ignore', timeout: 2000 })?.status === 0;
