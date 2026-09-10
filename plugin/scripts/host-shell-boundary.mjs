// host-shell-boundary.mjs — one definition of the files a running host freezes at boot.
//
// Body files are reached through the Stable Spine and can change in place. These paths are the
// host declarations or boot-loaded surfaces whose change must be reported honestly to a running
// Claude/Codex session. Both the updater and the installer consume this one list so they cannot
// disagree about whether a release needs a restart.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SHELL_PATHS = Object.freeze([
  'hooks/hooks.json',
  'scripts/hook-shim.mjs',
  'scripts/hook-shim-bash.mjs',
  'scripts/development-maintenance.mjs',
  'mcp/server.mjs',
  '.mcp.json',
]);

function treeDigest(root, relative) {
  const target = path.join(root, relative);
  let stat;
  try { stat = fs.lstatSync(target); } catch { return '<missing>'; }
  if (stat.isSymbolicLink()) return '<symlink>';
  if (stat.isFile()) return `file:${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  if (!stat.isDirectory()) return `<special:${stat.mode}>`;
  const entries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return `dir:${entries.map((entry) => `${entry.name}:${treeDigest(target, entry.name)}`).join('|')}`;
}
/** Return the boot-loaded paths that differ between two plugin payload roots. */
export function shellDiff(prevRootAbs, nextRootAbs) {
  if (!prevRootAbs || !nextRootAbs) throw new Error('both plugin roots are required for shell comparison');
  const changed = [];
  for (const rel of SHELL_PATHS) {
    if (treeDigest(prevRootAbs, rel) !== treeDigest(nextRootAbs, rel)) changed.push(rel);
  }
  // skills/ and commands/ are markdown surfaces loaded at host boot. Any file-set or content
  // difference is a boot-surface change, even though they are not executable hook declarations.
  for (const dir of ['skills', 'commands']) {
    if (treeDigest(prevRootAbs, dir) !== treeDigest(nextRootAbs, dir)) changed.push(`${dir}/`);
  }
  return changed;
}
