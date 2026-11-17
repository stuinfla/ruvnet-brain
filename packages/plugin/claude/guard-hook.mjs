// The optional write guard's tool-use hook, started by the launcher (`bin/rb5 guard`, `bin/rb5.cmd
// guard`) with a Node it has checked. OFF unless state/config.json says guard: true (contract DEFAULTS
// guard: false; only `ruvnet-brain guard on` sets it): when off it reads nothing more and exits 0 at
// once. When on it runs the guard of the installed app named by the pointer file (packages/guard), which
// prints at most one line and exits 2 only to refuse a write. Anything that stops the guard from
// starting allows the write with one line. It never runs or imports anything from the current project.
import './runtime.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brainHome, paths, readConfig, readPointer } from '../../contract/home.mjs';

const home = brainHome();
if (readConfig(home).guard === true) {
  try {
    const ptr = readPointer(home);
    if (!ptr?.app) throw new Error('RuvNet Brain 5 is not installed');
    const guard = await import(pathToFileURL(path.join(paths(home).app, ptr.app, 'guard', 'guard.mjs')).href);
    process.exitCode = await guard.hook({ home });
  } catch (e) {
    const why = String(e?.message ?? e).split('\n')[0].slice(0, 120);
    process.stdout.write(`${JSON.stringify({ systemMessage: `[RuvNet Brain guard] advisory only: the guard could not start (${why}), so the write is allowed` })}\n`);
    process.exitCode = 0;
  }
}
