// plugin/scripts/hook-timeout-overrides.mjs — a durable, opt-in way to raise (or lower) one shipped
// hook's `timeout` in the installed hooks.json, without hand-editing a file `claude plugin
// install`/`update` overwrites on every run.
//
// Measured (#423): `ground-ruvnet`'s UserPromptSubmit hook shipped at a 10s host timeout; on a loaded
// machine the host reported "UserPromptSubmit hook … timed out after 10s — output discarded" and the
// only fix anyone could find was hand-editing hooks.json inside
// ~/.claude/plugins/cache/ruvnet-brain/ruvnet-brain/<version>/ — which the NEXT `claude plugin update`
// silently reverts, because that whole directory is a disposable copy `wirePlugin()` asks the `claude`
// CLI to recreate (bin/install.mjs never writes it directly).
//
// The fix is not a bigger default for everyone (a loaded machine is not the common case), and not an
// env var (hook-shim.mjs's own registeredTimeoutMs() proves the HOST's kill timer reads hooks.json's
// `timeout` field directly — an env var the shim reads cannot move a limit the host itself enforces).
// It has to be the file itself, re-applied every time `wirePlugin()` asks `claude` to rewrite it.
//
// ~/.cache/ruvnet-brain/hook-timeouts.json (schemaVersion 1) holds the user's choice, the same way
// ~/.cache/ruvnet-brain/developer-update-config.json already holds the developer-update channel/scope
// choice (CONTRIBUTING.md, "Coordinated developer updates"). Format: { "schemaVersion": 1, "timeouts":
// { "<hookId>": <seconds> } }. A hookId is the same token hook-shim.mjs and hooks.json already use
// (e.g. "ground-ruvnet", "unprompted-speech") — not a file path, not a command line.
//
// Known limitation (intentionally out of scope here): plugin/scripts/developer-update.mjs's
// synchronizePlugins() updates arbitrary scopes/plugins generically (project/local scopes it
// deliberately never touches unattended) and deserves its own review before this is wired in there
// too; today this only re-applies from bin/install.mjs's wirePlugin() (`npx ruvnet-brain` /
// `npx ruvnet-brain --update`), the install path the fix was measured against.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_HOOK_TIMEOUT_OVERRIDES_PATH = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'hook-timeouts.json');
export const MIN_HOOK_TIMEOUT_SECONDS = 3;
export const MAX_HOOK_TIMEOUT_SECONDS = 120;

/**
 * Read the user's saved overrides. Never throws: a missing file, bad JSON, or the wrong shape all
 * resolve to {} (no override), the same "absent config = default behavior" contract
 * ~/.cache/ruvnet-brain/turn-capture/policy.json already uses.
 */
export function loadHookTimeoutOverrides(overridesPath = DEFAULT_HOOK_TIMEOUT_OVERRIDES_PATH) {
  try {
    const doc = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    const timeouts = doc?.timeouts;
    if (!timeouts || typeof timeouts !== 'object' || Array.isArray(timeouts)) return {};
    return timeouts;
  } catch {
    return {};
  }
}

// Same hook-id-to-command match hook-shim.mjs's registeredTimeoutMs() uses, so an override lands on
// exactly the hooks.json entry the shim itself would resolve for that id — never a different hook
// whose command happens to share a substring.
function commandMatchesHookId(command, hookId) {
  const c = String(command || '').replace(/\s+\|\|\s+true\s*$/, '');
  const want = ['hook-shim.mjs"', hookId].join(' ');
  return c.endsWith(want) || c.includes(`${want} `);
}

/**
 * Patch the installed hooks.json's `timeout` fields in place from the user's saved overrides.
 * - No overrides file, or nothing matches: a no-op, file untouched, `{changed:false}`.
 * - An override outside [MIN_HOOK_TIMEOUT_SECONDS, MAX_HOOK_TIMEOUT_SECONDS] is clamped and logged,
 *   never silently dropped and never silently honored past the range.
 * - A non-finite / non-numeric override, or a hookId matching no hook in this manifest, is logged and
 *   skipped — this never throws, so it can sit after a successful install/update unconditionally.
 */
export function applyHookTimeoutOverrides({
  installPath,
  overridesPath = DEFAULT_HOOK_TIMEOUT_OVERRIDES_PATH,
  minSeconds = MIN_HOOK_TIMEOUT_SECONDS,
  maxSeconds = MAX_HOOK_TIMEOUT_SECONDS,
  log = () => {},
} = {}) {
  const overrides = loadHookTimeoutOverrides(overridesPath);
  const ids = Object.keys(overrides);
  if (ids.length === 0) return { changed: false, applied: {} };

  const hooksJsonPath = path.join(installPath, 'hooks', 'hooks.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch (error) {
    log(`hook-timeout-overrides: could not read ${hooksJsonPath}: ${error.message}`);
    return { changed: false, applied: {}, error: error.message };
  }

  const applied = {};
  let changed = false;
  for (const id of ids) {
    const raw = overrides[id];
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      log(`hook-timeout-overrides: ignoring ${id}=${JSON.stringify(raw)} (not a positive number of seconds)`);
      continue;
    }
    const clamped = Math.min(maxSeconds, Math.max(minSeconds, seconds));
    if (clamped !== seconds) log(`hook-timeout-overrides: ${id}=${seconds}s is outside [${minSeconds}, ${maxSeconds}]; using ${clamped}s`);

    let matchedAny = false;
    for (const groups of Object.values(manifest.hooks || {})) {
      for (const g of groups || []) {
        for (const h of g.hooks || []) {
          if (!commandMatchesHookId(h.command, id)) continue;
          matchedAny = true;
          if (h.timeout !== clamped) { h.timeout = clamped; changed = true; }
          applied[id] = clamped;
        }
      }
    }
    if (!matchedAny) log(`hook-timeout-overrides: no hook named "${id}" in this manifest; ignoring`);
  }

  if (changed) {
    try {
      fs.writeFileSync(hooksJsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch (error) {
      log(`hook-timeout-overrides: could not write ${hooksJsonPath}: ${error.message}`);
      return { changed: false, applied: {}, error: error.message };
    }
  }
  return { changed, applied };
}
