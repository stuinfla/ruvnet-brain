// Chooses the Node program to start the installer's real-server check with, at the moment it is
// needed, and tests it before use. Nothing remembers the answer (defect C1: a remembered path goes
// stale when a package manager replaces Node). Order: the program running now, then `node` in each
// absolute PATH folder (never the current folder, never an empty or relative PATH entry), then the
// usual install locations.
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

export function pickNode(env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = String(key ? env[key] : '').split(path.delimiter).filter((d) => d && path.isAbsolute(d));
  const seen = new Set();
  const tried = [];
  for (const c of [process.execPath, ...dirs.map((d) => path.join(d, WIN ? 'node.exe' : 'node')), ...USUAL]) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (!fs.existsSync(c)) continue;
    const r = spawnSync(c, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 15_000, cwd: os.tmpdir(), windowsHide: true });
    if (r.status === 0 && recent(r.stdout.trim().split('.').map(Number))) return c;
    tried.push(c);
  }
  throw new Error(`no working Node ${MIN_NODE.join('.')} or later was found${tried.length ? ` (tried ${tried.join(', ')})` : ''}`);
}
