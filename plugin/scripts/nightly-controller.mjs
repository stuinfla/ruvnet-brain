// nightly-controller.mjs — a thin adapter around the installer's one scheduler implementation.
//
// It does not write a plist, call launchctl, or invent platform behavior. Both the installer and the
// console reach the same `bin/install.mjs --enable-nightly/--disable-nightly` door; this adapter only
// supplies structured status and captures its exit result for the console.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ROOT is the tree that holds `bin/install.mjs`, and it is resolved by an EXACT layout test rather
// than by `..` — because `..` means two different things since this file moved into the payload
// (ADR-064). From `<root>/scripts/` it was the root; from `<root>/plugin/scripts/` it is
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
export const NIGHTLY_LABEL = 'com.ruvnet.brain-update';

export function nightlyArtifact({ env = process.env, platform = process.platform } = {}) {
  const home = env.HOME || os.homedir();
  return {
    supported: platform === 'darwin',
    platform,
    path: path.join(home, 'Library', 'LaunchAgents', `${NIGHTLY_LABEL}.plist`),
    label: NIGHTLY_LABEL,
  };
}

export function nightlyStatus(options = {}) {
  const artifact = nightlyArtifact(options);
  if (!artifact.supported) {
    return { state: 'unsupported', evidence: `No reversible scheduler adapter is implemented for ${artifact.platform}.`, artifact };
  }
  const present = fs.existsSync(artifact.path);
  return {
    state: present ? 'on' : 'off',
    evidence: present ? `LaunchAgent plist exists at ${artifact.path}` : `No LaunchAgent plist at ${artifact.path}`,
    artifact,
  };
}

export function applyNightlyChoice(enabled, options = {}) {
  if (typeof enabled !== 'boolean') return { ok: false, log: 'nightly must be true or false' };
  const env = options.env || process.env;
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
      ? `Nightly refresh is ${desired}; verified from ${after.artifact.path}.`
      : `Nightly refresh did not reach ${desired}: ${run.error?.message || run.stderr?.trim() || run.stdout?.trim() || `exit ${run.status}`}`,
  };
}
