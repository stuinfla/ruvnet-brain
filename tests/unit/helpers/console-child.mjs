// console-child.mjs — run a console gather function in a CHILD process whose HOME / console root /
// KB / settings all point into a throwaway directory. The console reads those roots at module load,
// so an in-process import would bind to the developer's real machine (see console-advocacy-dial).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CONSOLE_MJS = path.join(REPO, 'scripts/onboarding-console.mjs');
export const APP_JS = path.join(REPO, 'console/app.js');
export const IMPORT = `const m = await import(${JSON.stringify(pathToFileURL(CONSOLE_MJS).href)});`;

export function scratch(prefix = 'console-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeRunner(tmp) {
  const run = (src, extraEnv = {}) => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
      env: {
        ...process.env,
        // HOME alone isolates the console: consoleRootFromEnvironment() falls back to os.homedir(),
        // and the scheduler reads its LaunchAgent path from HOME too. Setting RUVNET_CONSOLE_ROOT as
        // well trips nightly-controller's "console root must not be the real home" guard, because
        // under this env the scratch dir IS os.homedir().
        HOME: tmp, USERPROFILE: tmp,
        RUVNET_SETTINGS_FILE: path.join(tmp, 'settings.json'),
        RUVNET_BRAIN_KB: path.join(tmp, 'kb'),
        RUVNET_BRAIN_COMPLETE_SOURCE: path.join(tmp, 'no-such-bundle'),
        RUVNET_BRAIN_HOME: path.join(tmp, '.cache', 'ruvnet-brain'),
        ...extraEnv,
      },
      encoding: 'utf8', timeout: 60_000,
    });
    if (r.status !== 0) throw new Error(`child exited ${r.status}\nSTDOUT: ${r.stdout}\nSTDERR: ${r.stderr}`);
    return r.stdout;
  };
  return { run, runJSON: (src, env) => JSON.parse(run(src, env)) };
}

/** Seed a ruflo-shaped memory store with N rows via the sqlite3 CLI the console itself reads with. */
export function seedMemoryDb(file, rows, { checkpoint = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stmts = ['CREATE TABLE memory_entries(key TEXT, value TEXT, updated_at INTEGER, embedding BLOB);'];
  for (let i = 0; i < rows; i++) {
    const key = checkpoint && i === 0 ? `project-state-current-${Date.now()}` : `row-${i}`;
    stmts.push(`INSERT INTO memory_entries VALUES ('${key}', 'v', ${Date.now()}, X'01');`);
  }
  const r = spawnSync('sqlite3', [file, stmts.join(' ')], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sqlite3 seed failed: ${r.stderr}`);
  return file;
}
