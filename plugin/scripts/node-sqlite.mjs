/**
 * node-sqlite.mjs — the ONE way plugin code loads `node:sqlite`, lazily and without hook noise.
 *
 * WHY (measured 2026-10-01, Node 22.13.1 locally and Node 22 on the Linux CI full suite, run 36894944735):
 * on Node 22 the first load of `node:sqlite` prints
 *   (node:PID) ExperimentalWarning: SQLite is an experimental feature and might change at any time
 * to stderr. SessionStart reads the store through project-progression-reader.mjs, so every SessionStart
 * in an adopted git project on Node 22 carried that line — hook noise a customer sees on every session.
 * Node 24 does not warn, which is why the owner's machine never showed it.
 *
 * WHAT: the module is required only when a caller actually needs it (never at import time), and during
 * that one synchronous require `process.emitWarning` drops exactly ONE warning shape — type
 * ExperimentalWarning whose message names SQLite — and passes every other warning through untouched.
 * The original `process.emitWarning` is restored before returning, whether the require worked or not.
 * Node's emitExperimentalWarning calls the public process.emitWarning synchronously while the builtin
 * is being compiled (node:internal/util emitExperimentalWarning), which is what makes the scope exact.
 */
import { createRequire } from 'node:module';

const requireBuiltin = createRequire(import.meta.url);
let loaded;

/** True for the one warning this module exists to keep out of hook output. */
export function isSqliteExperimentalWarning(warning, typeOrOptions) {
  const type = typeof typeOrOptions === 'string' ? typeOrOptions : typeOrOptions?.type;
  const name = warning && typeof warning === 'object' ? warning.name : undefined;
  const message = typeof warning === 'string' ? warning : warning?.message;
  return (type === 'ExperimentalWarning' || name === 'ExperimentalWarning') && /\bSQLite\b/.test(String(message ?? ''));
}

/** The `node:sqlite` module, or null where this Node has none. Loaded once; never warns about SQLite. */
export function loadNodeSqlite({ load = (id) => requireBuiltin(id) } = {}) {
  if (loaded !== undefined) return loaded;
  const original = process.emitWarning;
  process.emitWarning = function emitWarningExceptSqlite(warning, ...rest) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return undefined;
    return original.call(this, warning, ...rest);
  };
  try { loaded = load('node:sqlite'); } catch { loaded = null; } finally { process.emitWarning = original; }
  return loaded;
}
