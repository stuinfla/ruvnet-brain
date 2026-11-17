// Pre-registration copies of the shared host files (wave 3), so uninstall puts back exactly the bytes
// that were there before version 5 registered: a file that did not exist is removed again, an empty
// object stays `{}`, an empty `"hooks": {}` stays. One copy per host file, in the brain home
// (state/host-backup/<sha256 of the path>.json, mode 0600: a host file can hold account data), with
// the sha256 of the bytes it holds and of the bytes registration wrote.
//
// The copy is used only while the host file is still exactly what registration wrote. When anything
// else changed the file since (the host itself, the user, 4.7), putting old bytes back would destroy
// that change, so uninstall removes only version 5's own entries instead (the surgical removal).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Where the copies live, relative to the brain home (the generated reference lists it). */
export const BACKUP_DIR = 'state/host-backup';
const sha = (text) => crypto.createHash('sha256').update(text ?? '\u0000absent').digest('hex');
const fileOf = (home, file) => path.join(home, ...BACKUP_DIR.split('/'), `${sha(path.resolve(file))}.json`);

function read(home, file) {
  try {
    const b = JSON.parse(fs.readFileSync(fileOf(home, file), 'utf8'));
    return b && b.file === path.resolve(file) ? b : null;
  } catch {
    return null;
  }
}

function write(home, file, value) {
  const f = fileOf(home, file);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}

export const dropBackup = (home, file) => fs.rmSync(fileOf(home, file), { force: true });

/**
 * Before registration writes `next` over `before` (null: the file does not exist). Keeps the first
 * copy while the file is still what registration last wrote; takes a new copy when the file carries
 * nothing of version 5 (`ours` false); otherwise no exact copy exists and none is kept.
 */
export function keepBackup(home, file, before, next, ours) {
  const b = read(home, file);
  if (b && b.after === sha(before)) return write(home, file, { ...b, after: sha(next) });
  if (!ours) return write(home, file, { file: path.resolve(file), existed: before !== null, text: before, sha256: sha(before), after: sha(next) });
  dropBackup(home, file);
}

/** Uninstall: { restored: true } when the copy was put back, else { restored: false } (use the surgical removal). */
export function restoreBackup(home, file, current) {
  const b = read(home, file);
  if (!b || b.after !== sha(current) || sha(b.text) !== b.sha256) return { restored: false };
  if (b.existed) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, b.text);
    fs.renameSync(tmp, file);
  } else fs.rmSync(file, { force: true });
  dropBackup(home, file);
  return { restored: true };
}
