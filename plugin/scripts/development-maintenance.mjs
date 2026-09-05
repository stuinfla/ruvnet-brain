// Local configuration only: no Git subprocess, network, hook bodies, or writes on the read path.
import fs from 'node:fs';
import path from 'node:path';

export function repositoryScope(cwd = process.cwd()) {
  let dir = fs.realpathSync(cwd);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let stat;
    try { stat = fs.lstatSync(dotgit); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) {
      if (stat.isSymbolicLink()) throw new Error('Refusing symlink .git');
      let gitdir = dotgit;
      if (stat.isFile()) {
        const match = /^gitdir: (.+)\r?\n?$/.exec(fs.readFileSync(dotgit, 'utf8'));
        if (!match) throw new Error('Invalid worktree .git file');
        gitdir = path.resolve(dir, match[1].trim());
      } else if (!stat.isDirectory()) throw new Error('Invalid .git metadata');
      let common = gitdir;
      try { common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      common = fs.realpathSync(common);
      const owner = fs.statSync(common);
      if (!owner.isDirectory() || (process.getuid && owner.uid !== process.getuid())) throw new Error('Repository metadata is not owned by this user');
      return { project: dir, commonDir: common, statePath: path.join(common, 'ruvnet-brain-maintenance.json') };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function maintenanceStatus(cwd = process.cwd()) {
  const scope = repositoryScope(cwd);
  if (!scope) return { project: null, suspended: false };
  let stat;
  try { stat = fs.lstatSync(scope.statePath); }
  catch (error) { if (error.code === 'ENOENT') return { ...scope, suspended: false }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Maintenance state must be a user-owned regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o022)) throw new Error('Maintenance state is writable by other users');
  const state = JSON.parse(fs.readFileSync(scope.statePath, 'utf8'));
  if (state.schema !== 1 || state.commonDir !== scope.commonDir || state.suspended !== true) throw new Error('Invalid maintenance state for this repository');
  return { ...scope, ...state };
}

export function developmentHooksSuspended(cwd = process.cwd()) {
  // A malformed local configuration is not authority to bypass a hook.
  try { return maintenanceStatus(cwd).suspended; } catch { return false; }
}
