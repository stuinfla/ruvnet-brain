// Directory ownership protocol shared with agentic-kit. Inherited children do not release the parent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const brainRoot = brainHome => brainHome || process.env.RUVNET_BRAIN_HOME || path.join(os.homedir(), '.cache/ruvnet-brain');
export function sharedLockStatus({ brainHome, alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } } } = {}) {
  const directory = path.join(brainRoot(brainHome), 'developer-update.lock');
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error('not an owned directory');
    const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || owner.token.length < 16) throw Error('invalid owner');
    return { state: alive(owner.pid) ? 'running' : 'stale', directory, owner };
  } catch (error) { return { state: error.code === 'ENOENT' && !fs.existsSync(directory) ? 'idle' : 'unknown', directory, error: error.message }; }
}
export function acquireDeveloperLock({ brainHome, token = process.env.RUVNET_DEVELOPER_UPDATE_TOKEN, pid = process.pid, alive } = {}) {
  const status = sharedLockStatus({ brainHome, alive });
  if (token && status.state === 'running' && status.owner.token === token) return { token, ownerPid: status.owner.pid, inherited: true, release() {} };
  if (status.state !== 'idle') throw Error(`developer update lock ${status.state}; ${status.directory}`);
  fs.mkdirSync(path.dirname(status.directory), { recursive: true });
  fs.mkdirSync(status.directory, { mode: 0o700 }); // atomic claim; racing owners get EEXIST
  const owner = { pid, token: crypto.randomUUID(), startedAt: new Date().toISOString() };
  try { fs.writeFileSync(path.join(status.directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
  catch (error) { fs.rmdirSync(status.directory); throw error; }
  return { token: owner.token, ownerPid: pid, inherited: false, release() {
    const current = sharedLockStatus({ brainHome, alive });
    if (current.owner?.token !== owner.token || current.owner?.pid !== pid) throw Error('developer update lock ownership changed');
    fs.unlinkSync(path.join(status.directory, 'owner.json')); fs.rmdirSync(status.directory);
  } };
}
