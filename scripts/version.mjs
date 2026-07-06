// version.mjs — THE single source of truth for the product version (SEC-0010 #2 / ADR-0009 decision 1).
// plugin/.claude-plugin/plugin.json `version` is the one hand-edited number. EVERY other surface
// (installer, stamp, bundle, README, manifest, npm package) inherits it — at runtime via getVersion()
// for code paths, or written once by sync-version.mjs for files that must carry a literal.
// Never hardcode a version string anywhere else; scripts/sync-version.mjs --check fails the build if you do.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_JSON = path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json');

/** The product version, e.g. "1.9.1-dev" — read live from the single source of truth. */
export function getVersion() {
  const v = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
  if (!v || typeof v !== 'string') throw new Error(`no version in ${PLUGIN_JSON}`);
  return v;
}

/** The product version with a leading "v", e.g. "v1.9.1-dev" (Release-tag form). */
export function getVersionTag() {
  return `v${getVersion()}`;
}

// CLI: `node scripts/version.mjs` prints the version (handy for shell scripts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(getVersion() + '\n');
}
