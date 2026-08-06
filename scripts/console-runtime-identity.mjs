// ONE definition of "what the persistent Console runtime is" and "which generation is running".
//
// #79 reported a Console that survived an update: the browser was served the new frontend from disk
// while the Node process kept its pre-update router in memory, and every relaunch said "already
// running". The reuse check compared a `sourceSha256` computed from a SINGLE file —
// scripts/onboarding-console.mjs — while the runtime the server actually executes is this whole
// surface: ~230 modules it imports plus the frontend it serves. Two genuinely different candidates
// whose entrypoint bytes happened to match produced byte-identical identities, so an update that
// changed console-engine.mjs, capability-registry.mjs or console/app.js was invisible to the
// launcher. The identity has to derive from something an update cannot leave behind, which is the
// installed bytes themselves — all of them.
//
// #76 reported the same disease at the asset boundary: the runtime copied plugin/scripts without
// the sibling docs/ and manifest that plugin/scripts/whats-new.mjs reads, so the executable
// travelled and its assets did not. The copy list and the identity list were two separate
// enumerations of one payload; they are one list now, so an asset added to the runtime is part of
// its generation by construction.
//
// The installer hashes the staged tree with this function and the running server hashes its own
// root with this function, over this list. Neither side can define the fact differently.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Every path the persistent Console runtime carries, relative to both the candidate source root and
 * the installed runtime root (they are laid out identically). This is simultaneously the installer's
 * copy list and the generation's digest input — one enumeration, so they cannot drift.
 */
export const CONSOLE_RUNTIME_SURFACE = Object.freeze([
  'console',
  'scripts',
  'plugin/scripts',
  // whats-new.mjs resolves its version manifest and curated notes relative to its own plugin root
  // (#76). Shipping the executable without them is how the installed skill lost its release notes.
  'plugin/docs',
  'plugin/.claude-plugin',
  'data/model-catalog.json',
  'kb/brain-profile.mjs',
  'bin/install.mjs',
  'package.json',
]);

/** The runtime's own identity file, written by the installer INTO the tree — never part of its own digest. */
export const CONSOLE_RUNTIME_IDENTITY_FILE = 'runtime-identity.json';

/**
 * Deterministic content digest of the runtime surface under `root`.
 *
 * A path that is absent is hashed as absent rather than skipped: a runtime that lost a file is a
 * different generation, not the same one, and a launcher must be able to see that.
 *
 * @param {string} root runtime root (an installed `.console-runtime`, a marketplace clone, or a checkout)
 * @returns {string} hex sha256
 */
export function consoleRuntimeDigest(root) {
  const hash = crypto.createHash('sha256');
  const visit = (absolute, relative) => {
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { hash.update(`absent\0${relative}\0`); return; }
    if (stat.isDirectory()) {
      hash.update(`d\0${relative}\0`);
      let entries = [];
      try { entries = fs.readdirSync(absolute).sort(); } catch { hash.update(`unreadable\0${relative}\0`); return; }
      for (const entry of entries) visit(path.join(absolute, entry), `${relative}/${entry}`);
      return;
    }
    hash.update(`f\0${relative}\0`);
    try { hash.update(fs.readFileSync(absolute)); } catch { hash.update(`unreadable\0${relative}\0`); }
  };
  for (const relative of CONSOLE_RUNTIME_SURFACE) visit(path.join(root, relative), relative);
  return hash.digest('hex');
}
