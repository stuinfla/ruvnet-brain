// plugin/scripts/entrypoint.mjs — the ONE answer to "was this module run as the program, or imported?"
//
// Every dual-purpose file in this repo (a library when imported, a CLI when run) asks that question.
// The copy-pasted answer compared `process.argv[1]` with `import.meta.url` directly, e.g.
//     path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
//     import.meta.url === pathToFileURL(process.argv[1]).href
// argv[1] is the path as the caller typed it, symlinks included; Node resolves symlinks before it sets
// import.meta.url. Run through a symlink (npm bin shims, wrapper scripts, a symlinked checkout, every
// os.tmpdir() path on macOS) the two sides differ, main() never runs, and the process exits 0 having
// done nothing. A release gate that exits 0 without checking anything passes. Dream Cycle PRs #295,
// #317, #333, #367, #412 and #484 each found one more copy by hand.
//
// Usage:
//     import { isDirectInvocation } from './entrypoint.mjs';   // path relative to this file
//     if (isDirectInvocation(import.meta.url)) main();
//
// tests/unit/entrypoint-guard-sweep.test.mjs fails when a raw comparison reappears outside this file,
// and runs a script through a symlink to prove this helper makes it execute.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `moduleUrl` (pass `import.meta.url`) is the file Node was asked to run. Both sides are
 * compared as real paths. Never throws: `realpathSync` throws on a path that does not resolve (under
 * a test runner argv[1] need not be a real file), and an imported module must not crash its importer.
 */
export function isDirectInvocation(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1 || !moduleUrl) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
