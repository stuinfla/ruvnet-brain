import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function verdictOf(results) {
  if (results.some(({ status }) => ['FAIL', 'TIMEOUT', 'BLOCKED'].includes(status))) return 'FAIL';
  return results.length && results.every(({ status }) => status === 'PASS') ? 'PASS' : 'UNKNOWN';
}

// A source digest includes dirty tracked files and untracked source, never ignored build outputs.
export function sourceIdentity(root) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let sha = null;
  try { sha = git(['rev-parse', 'HEAD']).trim(); } catch { /* unborn repository */ }
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    const file = path.join(root, relative);
    let bytes = Buffer.from('deleted');
    try {
      const stat = fs.lstatSync(file);
      bytes = stat.isSymbolicLink() ? Buffer.from(`symlink:${fs.readlinkSync(file)}`)
        : stat.isFile() ? Buffer.concat([Buffer.from(`${stat.mode & 0o777}:`), fs.readFileSync(file)]) : Buffer.from('directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    hash.update(JSON.stringify([relative, createHash('sha256').update(bytes).digest('hex')]));
  }
  return { sha, dirty: Boolean(git(['status', '--porcelain']).trim()), digest: hash.digest('hex'), files: files.length, recipe: 'git-source-bytes-v1' };
}

export async function runLanes(lanes, execute, concurrency = 2) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('invalid QA concurrency');
  const names = new Set(lanes.map(({ name }) => name));
  if (names.size !== lanes.length || lanes.some((lane) => (lane.dependsOn || []).some((name) => !names.has(name)))) throw new Error('invalid QA dependency');
  const pending = [...lanes], completed = new Map();
  while (pending.length) {
    const resources = new Set(), batch = [];
    for (const lane of pending) {
      if (!(lane.dependsOn || []).every((name) => completed.has(name))) continue;
      if ((lane.dependsOn || []).some((name) => completed.get(name).status !== 'PASS')) {
        completed.set(lane.name, { name: lane.name, status: 'BLOCKED', reason: 'required prerequisite did not pass' });
        continue;
      }
      if (batch.length >= concurrency || (lane.resource && resources.has(lane.resource))) continue;
      batch.push(lane); resources.add(lane.resource);
    }
    if (!batch.length && !pending.some(({ name }) => completed.has(name))) throw new Error('QA dependency cycle');
    await Promise.all(batch.map(async (lane) => {
      let result;
      try { result = await execute(lane); }
      catch (error) { result = { name: lane.name, status: 'FAIL', reason: error.message }; }
      completed.set(lane.name, result);
    }));
    for (let index = pending.length - 1; index >= 0; index--) if (completed.has(pending[index].name)) pending.splice(index, 1);
  }
  return lanes.map(({ name }) => completed.get(name));
}
