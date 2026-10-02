// brain-location.mjs — where the Brain really lives, and whether that disk is there.
//
// The supported way to put the Brain on another disk is a symlink at the default path:
// ~/.cache/ruvnet-brain -> /Volumes/<disk>/ruvnet-brain (made by `npx ruvnet-brain --move-brain <dir>`).
// Every reader keeps using the default path and follows the link; nothing else has to know. The one new
// failure is the disk being absent (unplugged, unmounted). Then the link dangles, and every caller must
// say so in ONE line — never an ENOENT, never "reinstall", never a fresh brain re-created in ~/.cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultBrainHome = (home = os.homedir()) => path.join(home, '.cache', 'ruvnet-brain');

/** The volume a path lives on, as a person would name it (the mount point). */
export function volumeOf(target) {
  const p = path.resolve(target);
  const mac = p.match(/^\/Volumes\/[^/]+/);
  if (mac) return mac[0];
  const media = p.match(/^\/(?:run\/)?media\/[^/]+\/[^/]+/) || p.match(/^\/mnt\/[^/]+/);
  if (media) return media[0];
  const drive = p.match(/^[A-Za-z]:\\/);
  if (drive) return drive[0];
  let missing = p; // the highest missing ancestor is what is "not there"
  while (path.dirname(missing) !== missing && !fs.existsSync(path.dirname(missing))) missing = path.dirname(missing);
  return missing;
}

/**
 * @returns {{ path: string, state: 'absent'|'local'|'linked'|'unmounted', real?: string, target?: string,
 *   volume?: string, message?: string }}
 */
export function brainLocation({ home = os.homedir(), brainHome = defaultBrainHome(home) } = {}) {
  let stat;
  try { stat = fs.lstatSync(brainHome); } catch { return { path: brainHome, state: 'absent' }; }
  if (!stat.isSymbolicLink()) return { path: brainHome, state: 'local', real: brainHome };
  const target = path.resolve(path.dirname(brainHome), fs.readlinkSync(brainHome));
  if (fs.existsSync(target)) return { path: brainHome, state: 'linked', real: fs.realpathSync(brainHome), target };
  const volume = volumeOf(target);
  return { path: brainHome, state: 'unmounted', target, volume,
    message: `RuvNet Brain's disk ${volume} is not mounted (${brainHome} -> ${target}). Mount it, then retry; nothing was changed. Do NOT reinstall.` };
}

/** One clear line when the Brain's disk is missing, '' otherwise. For hooks and readers. */
export function unmountedNotice(options) {
  const where = brainLocation(options);
  return where.state === 'unmounted' ? where.message : '';
}
