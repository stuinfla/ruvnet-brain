// Chooses the Node program to start the installer's real-server check with, at the moment it is
// needed, and tests it before use. Nothing remembers the answer (defect C1: a remembered path goes
// stale when a package manager replaces Node). Order: the program running now, then `node` in each
// absolute PATH folder (never the current folder, never an empty or relative PATH entry), then the
// usual install locations.
//
// Nothing inside the current project is ever run (review F02), by the same rule as the POSIX launcher
// (plugin/claude/bin/rb5): a candidate is refused when its folder, its real folder, its real file or
// that file's folder is the project (the current folder or CLAUDE_PROJECT_DIR, each as given and as
// its real path) or below it, checked before the candidate is probed. So an outside `node` link that
// points into the project is refused, and so is an absolute PATH entry inside the project. A
// "project" that is the home or temporary folder, or above one, counts only for itself, so a Node
// installed under the home folder stays usable in a session opened there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MIN_NODE } from '../contract/constants.mjs';

const WIN = process.platform === 'win32';
const USUAL = WIN
  ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe')]
  : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];

const recent = ([a, b]) => a > MIN_NODE[0] || (a === MIN_NODE[0] && b >= MIN_NODE[1]);
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
};
const norm = (p) => {
  const r = path.resolve(p);
  return WIN ? r.toLowerCase() : r;
};
const under = (d, p) => d === p || d.startsWith(p.endsWith(path.sep) ? p : p + path.sep);

/** The folders nothing may be run from: the project (current folder, CLAUDE_PROJECT_DIR), as given and real. */
export function projectRoots(env = process.env, cwd = process.cwd()) {
  const given = [cwd, env.CLAUDE_PROJECT_DIR].filter((x) => x && path.isAbsolute(x));
  return [...new Set(given.flatMap((p) => [p, real(p)]).filter(Boolean).map(norm))];
}

/** True when `file` (and where it really lives) is outside every project root. */
export function outsideProject(file, env = process.env, cwd = process.cwd()) {
  const roots = projectRoots(env, cwd);
  const homes = [os.homedir(), os.tmpdir(), env.HOME, env.TMPDIR, env.TEMP, env.TMP].filter((x) => x && path.isAbsolute(x)).flatMap((h) => [h, real(h)]).filter(Boolean).map(norm);
  const rf = real(file);
  const places = [path.dirname(file), real(path.dirname(file)), rf, rf && path.dirname(rf)].filter(Boolean).map(norm);
  // A root that is a home or temporary folder, or above one, covers only itself.
  const within = (d, p) => d === p || (!homes.some((h) => under(h, p)) && under(d, p));
  return !places.some((d) => roots.some((p) => within(d, p)));
}

export function pickNode(env = process.env, { running = process.execPath, cwd = process.cwd() } = {}) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = String(key ? env[key] : '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const seen = new Set();
  const tried = [];
  for (const c of [running, ...dirs.map((d) => path.join(d, WIN ? 'node.exe' : 'node')), ...USUAL]) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (!fs.existsSync(c)) continue;
    if (!outsideProject(c, env, cwd)) {
      tried.push(`${c} (inside the current project, never run)`);
      continue;
    }
    const r = spawnSync(c, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 15_000, cwd: os.tmpdir(), windowsHide: true });
    if (r.status === 0 && recent(r.stdout.trim().split('.').map(Number))) return c;
    tried.push(c);
  }
  throw new Error(`no working Node ${MIN_NODE.join('.')} or later was found${tried.length ? ` (tried ${tried.join(', ')})` : ''}`);
}
