/**
 * ruflo-bin.mjs — the ONE place this repo decides WHERE the global `ruflo` binary is.
 *
 * WHY THIS FILE EXISTS. Issues #99 and #105 are one defect filed twice: `scripts/distill-project.mjs`
 * and `plugin/scripts/learn-flush.mjs` each hardcoded `~/.npm-global/bin/ruflo` — the owner's npm
 * prefix, nobody else's. On a Homebrew, nvm, Volta, or plain `npm -g` install that path does not
 * exist, so #99 died with "ruflo is not at ~/.npm-global/bin/ruflo" and #105 failed every feed
 * silently — both on machines where ruflo was installed and sitting on PATH the whole time.
 *
 * `health-repair.mjs` had already fixed exactly this, and its header says why: "Telling someone their
 * tool is missing when it is on their PATH is the product lying, and it is unfalsifiable from their
 * side: they cannot see why we looked in one place." That fix lived as a private function inside one
 * file, so its two siblings kept the bug — the identical shape ADR-021 was written about ("One class,
 * fixed in one file, regenerated in the sibling"). So the resolver moves here instead of being pasted
 * a third time.
 *
 * MECHANISM — the hardened form, not the first draft. Two resolvers already existed in this repo:
 *   • health-repair.mjs      (2026-07-21)  preferred path, then `sh -lc 'command -v ruflo'`
 *   • capability-registry.mjs (2026-07-22)  preferred path, then a plain PATH walk, NO shell
 * The second IS the first one, hardened, and it says so in place: `-l` sources the user's entire
 * profile — every export, shim, and one-off line anyone has ever pasted into .profile — as the price
 * of answering "where is ruflo?". Resolving a name against directories is all `command -v` was ever
 * wanted for here, and it needs no shell at all. This module takes that version. Adopting the older
 * mechanism would mean re-introducing, in a shared module, a bug the repo had already fixed one file
 * over.
 *
 * ORDER, and each step earns its place:
 *   1. RUFLO_BIN, if set, is AUTHORITATIVE — returned as given, whether or not it exists. An explicit
 *      override that quietly falls back to some other ruflo is not an override, and the caller's
 *      "not at <path>" message has to name the path the user actually asked for.
 *   2. ~/.npm-global/bin/ruflo — Rule 21's ONE global binary, checked first so a machine that has it
 *      never depends on PATH ordering.
 *   3. A PATH walk — the entire point of #99/#105: an installed ruflo living anywhere else.
 *   4. null — "I could not find it", said plainly. Never guess a path and then blame the user for it.
 *
 * Rule 21 is untouched by this: still ONE ruflo, still the global one, never `npx ruflo@latest`. This
 * resolves WHERE that one global binary is rather than assuming everyone's prefix matches the owner's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Locate the global ruflo. LOCATES, NEVER EXECUTES — no shell, no daemon, no side effects.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string|null} path to ruflo, or null when it is genuinely not on this machine.
 */
export function resolveRuflo({ env = process.env, home = os.homedir() } = {}) {
  if (env.RUFLO_BIN) return env.RUFLO_BIN;

  // On Windows a global npm ruflo is `ruflo.cmd`; the extensionless sibling is a POSIX shell wrapper
  // that Node cannot exec (and refuses to spawn without a shell since CVE-2024-27980).
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];

  // The preferred path needs that SAME rule. It first checked a bare `ruflo` only, so on Windows it
  // either missed the real `ruflo.cmd` entirely or returned the POSIX wrapper the comment above
  // says is unrunnable — and the caller then reported "ruflo is not at ~/.npm-global/bin/ruflo" to
  // someone who had ruflo installed. That is the exact complaint #99 and #105 were filed about,
  // reintroduced one platform over.
  const preferredDir = path.join(home, '.npm-global', 'bin');
  for (const ext of exts) {
    const cand = path.join(preferredDir, `ruflo${ext}`);
    try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch { /* unreadable */ }
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, `ruflo${ext}`);
      try { if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand; } catch { /* unreadable PATH entry */ }
    }
  }
  return null;
}

/**
 * What to say when resolveRuflo() returns null. ONE wording, so every caller reports the same thing
 * and names both places it looked — the diagnostic #99 and #105 never gave anyone.
 */
export const RUFLO_MISSING = 'ruflo was not found in ~/.npm-global/bin or anywhere on your PATH'
  + ' — install it with `npm i -g ruflo@latest`, or set RUFLO_BIN to its full path';
