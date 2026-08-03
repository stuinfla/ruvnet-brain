import fs from 'node:fs';
import path from 'node:path';
import { createSessionSnapshot } from './session-snapshot-contract.mjs';

function regularOrAbsent(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function writeSessionSnapshot(projectDir, event) {
  const swarm = path.join(projectDir, '.swarm');
  const target = path.join(swarm, 'agentdb-sessions.jsonl');
  try {
    if (fs.existsSync(swarm)) {
      const stat = fs.lstatSync(swarm);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    } else {
      fs.mkdirSync(swarm, { recursive: false, mode: 0o700 });
    }
    if (!regularOrAbsent(target)) return false;
    fs.appendFileSync(target, `${JSON.stringify(createSessionSnapshot({ event }))}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('session-snapshot-hook.mjs')) {
  writeSessionSnapshot(process.env.CLAUDE_PROJECT_DIR || process.cwd(), process.argv[2] || 'SessionEnd');
}
