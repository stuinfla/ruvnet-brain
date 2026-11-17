// Free disk space where the brain home is (or will be): measured on the nearest folder that exists.
import fs from 'node:fs';
import path from 'node:path';

export const HEADROOM = 64 * 1024 * 1024;

/** Free bytes available to this user on the brain home's disk, or null when it cannot be measured. */
export function freeBytes(home) {
  let dir = path.resolve(home);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
