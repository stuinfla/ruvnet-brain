// Test preload (node --import): records every process the program starts, through any child_process
// call, into the file named by WP4_SPAWN_LOG, one JSON line each. Inherited by child Node processes
// through NODE_OPTIONS, so the whole process tree is watched.
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const log = process.env.WP4_SPAWN_LOG;
for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const orig = cp[fn];
  cp[fn] = function (file, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    try {
      fs.appendFileSync(log, JSON.stringify({ from: process.pid, fn, file: String(file), args: args.map(String) }) + '\n');
    } catch {}
    return orig.call(this, file, ...rest);
  };
}
syncBuiltinESMExports();
