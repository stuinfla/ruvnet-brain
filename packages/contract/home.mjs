// The brain home layout (architecture 2.3) and the small file helpers every part shares.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULTS, HOME_ENV } from './constants.mjs';

export function brainHome(env = process.env) {
  return env[HOME_ENV] ? path.resolve(env[HOME_ENV]) : path.join(os.homedir(), '.cache', 'ruvnet-brain-5');
}

export const paths = (home) => ({
  current: path.join(home, 'current.json'),
  app: path.join(home, 'app'),
  packs: path.join(home, 'packs'),
  private: path.join(home, 'private'),
  state: path.join(home, 'state'),
  status: path.join(home, 'state', 'status'),
  config: path.join(home, 'state', 'config.json'),
  update: path.join(home, 'state', 'update.json'),
  updateCheck: path.join(home, 'state', 'update-check.json'),
});

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/** Write-then-rename, so a reader never sees half a file. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export const readPointer = (home) => readJson(paths(home).current, null);

export function readConfig(home) {
  return { ...DEFAULTS, ...readJson(paths(home).config, {}) };
}

/** Streamed hash: never reads a whole file into memory (no 2 GiB limit). */
export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** True when the module at `metaUrl` is the program node was started with. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(metaUrl));
  } catch {
    return false;
  }
}

/** Every file under dir as a posix relative path, sorted. */
export function listFiles(dir) {
  const out = [];
  (function rec(rel) {
    for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) rec(r);
      else if (ent.isFile()) out.push(r);
    }
  })('');
  return out.sort();
}
