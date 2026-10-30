// scripts/issue-fix-lock.mjs — the single-writer lock shared by every issue-fix mode (ADR-050, ADR-107).
// Exclusive create (link(), the same EEXIST guarantee as O_EXCL) makes "who holds it" one atomic filesystem decision; the old exists-then-write pattern
// let two launches both see "no lock" and both write one.
import fs from 'node:fs';
import path from 'node:path';

const readHolder = (lockPath) => { try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; } };
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

/** @returns {{acquired:true}|{acquired:false, holder:{pid:number,startedAt:string,mode:string}}} */
export function acquireLock(lockPath, { now = Date.now(), pid = process.pid, mode = 'supervised' } = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // The lock appears complete or not at all: write a private file, then link() it into place. link() fails with
  // EEXIST exactly like open(O_EXCL) but, unlike open-then-write, never exposes an empty file that a racing
  // process could mistake for a dead holder and delete.
  const mine = `${lockPath}.${pid}.${now}.tmp`;
  fs.writeFileSync(mine, JSON.stringify({ pid, startedAt: new Date(now).toISOString(), mode }), { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.linkSync(mine, lockPath); return { acquired: true }; } catch (err) { if (err.code !== 'EEXIST') throw err; }
      const holder = readHolder(lockPath);
      if (holder && alive(holder.pid)) return { acquired: false, holder };
      if (attempt === 0) {
        const again = readHolder(lockPath); // only remove the very lock we judged dead
        if (JSON.stringify(again) === JSON.stringify(holder)) { try { fs.unlinkSync(lockPath); } catch { /* reclaimed by another */ } }
      }
    }
    return { acquired: false, holder: readHolder(lockPath) || { pid: 0, startedAt: '', mode: 'unknown' } };
  } finally { try { fs.unlinkSync(mine); } catch { /* already gone */ } }
}

/** Removes the lock only when this pid holds it. */
export function releaseLock(lockPath, { pid = process.pid } = {}) {
  const holder = readHolder(lockPath);
  if (!holder || holder.pid !== pid) return false;
  try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}
