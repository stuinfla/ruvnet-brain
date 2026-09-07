// nightly-controller.mjs — a thin adapter around the installer's one scheduler implementation.
//
// It does not write a plist, call launchctl, or invent platform behavior. Both the installer and the
// console reach the same `bin/install.mjs --enable-nightly/--disable-nightly` door; this adapter only
// supplies structured status and captures its exit result for the console.

import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NIGHTLY_LABEL, nightlyArtifact, schedulerStatus } from './nightly-scheduler.mjs';
export { NIGHTLY_LABEL, nightlyArtifact } from './nightly-scheduler.mjs';

// ROOT is the tree that holds `bin/install.mjs`, and it is resolved by an EXACT layout test rather
// than by `..` — because `..` means two different things since this file moved into the payload
// (ADR-065). From `<root>/scripts/` it was the root; from `<root>/plugin/scripts/` it is
// `<root>/plugin`, and `<root>/plugin/bin/install.mjs` does not exist. Caught live by
// console-apply-timings.test.mjs, which drove a real /api/apply through the console and got
// `Error: Cannot find module '<root>/plugin/bin/install.mjs'` back inside a 200 response — a remedy
// that reported failure honestly, but failed for a packaging reason nobody would have guessed.
//
// The test is exact, not a heuristic: this file's directory IS `<candidate>/plugin/scripts` if and
// only if `<candidate>` is a non-flattened root. A flattened install (the Spine's versions/<gen>/,
// the plugin cache's <ver>/) has no `plugin/` level, so `../..` is some unrelated parent and the
// answer falls back to `..` — where `bin/` also does not exist, and applyNightlyChoice() then
// reports that honestly instead of silently spawning nothing. nightlyStatus() only reads a plist and
// needs no installer at all, so status stays correct in every layout.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', 'plugin', 'scripts') === HERE
  ? path.resolve(HERE, '..', '..')
  : path.resolve(HERE, '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.mjs');

/**
 * THE NIGHTLY JOB'S NAME, stated once for everything that has to recognise it.
 *
 * Exported because issue #113 was two files disagreeing about this exact string with nothing to
 * notice: bin/install.mjs writes a LaunchAgent labelled `com.ruvnet.brain-update`, while
 * capability-registry.mjs looked for launchd jobs matching `/(nightly|refresh)/` — so the console
 * reported "not installed" about the very job the installer had loaded, scheduled and run. A label
 * is an interface between the writer and everyone who looks for it; spelling it out per reader is
 * how the two drift apart silently.
 *
 * bin/install.mjs still holds its own literal (installer-owned code, changed under its own review);
 * tests/unit/nightly-job-identity.test.mjs asserts the two are the same string, so a drift is a red
 * test rather than a capability that quietly disappears from the console.
 */
function schedulerEnvironment(env) {
  const fixtureRoot = env.RUVNET_CONSOLE_ROOT;
  if (!fixtureRoot) return env;
  if (env.RUVNET_BRAIN_TEST !== '1') {
    throw new Error('RUVNET_CONSOLE_ROOT scheduler isolation requires RUVNET_BRAIN_TEST=1');
  }
  if (!path.isAbsolute(fixtureRoot)) {
    throw new Error('RUVNET_CONSOLE_ROOT must be an absolute path');
  }
  const isolatedHome = path.resolve(fixtureRoot);
  if (isolatedHome === path.resolve(os.homedir())) {
    throw new Error('RUVNET_CONSOLE_ROOT must not be the real user home in test mode');
  }
  return { ...env, HOME: isolatedHome, USERPROFILE: isolatedHome };
}
export function nightlyStatus(options = {}) {
  const env = schedulerEnvironment(options.env || process.env);
  const brainHome = options.brainHome || env.RUVNET_BRAIN_HOME
    || path.join(env.HOME || env.USERPROFILE || '', '.cache', 'ruvnet-brain');
  return schedulerStatus({ ...options, env, brainHome, kbDir: options.kbDir || env.RUVNET_BRAIN_KB,
    testMode: options.testMode ?? env.RUVNET_BRAIN_SCHEDULER_TEST === '1' });
}

export function applyNightlyChoice(enabled, options = {}) {
  if (typeof enabled !== 'boolean') return { ok: false, log: 'nightly must be true or false' };
  const env = schedulerEnvironment(options.env || process.env);
  const before = nightlyStatus({ ...options, env });
  if (!before.artifact.supported) return { ok: false, state: before, log: before.evidence };
  const run = spawnSync(process.execPath, [
    options.installer || INSTALLER,
    enabled ? '--enable-nightly' : '--disable-nightly',
  ], {
    env: { ...env, RUVNET_BRAIN_IMPORT_ONLY: '0' },
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeout || 30_000,
  });
  const after = nightlyStatus({ ...options, env });
  const desired = enabled ? 'on' : 'off';
  const ok = !run.error && run.status === 0 && after.state === desired;
  return {
    ok,
    before,
    after,
    log: ok
      ? `Nightly refresh is ${desired}; ${after.evidence}.`
      : `Nightly refresh did not reach ${desired}: ${run.error?.message || run.stderr?.trim() || run.stdout?.trim() || `exit ${run.status}`}`,
  };
}
