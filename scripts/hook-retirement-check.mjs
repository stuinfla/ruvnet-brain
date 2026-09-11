#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { automaticHookRetirementStatus } from '../bin/install.mjs';
import { continuityRegistrations } from '../plugin/scripts/continuity-hook-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function main() {
  const result = automaticHookRetirementStatus(ROOT);
  if (!result.ok) {
    console.error(`hook-policy-check: FAIL — ${result.registrations.length} legacy/invalid registration(s), ${result.errors.length} manifest error(s)`);
    for (const error of result.errors) console.error(`  ${error}`);
    for (const item of result.registrations) console.error(`  ${item.file} ${item.event}: ${item.command || '(empty command)'}`);
    return 1;
  }
  // NAME THE PLANE, don't describe it from memory. The previous line said "SessionStart + guarded
  // Stop" and kept saying it after the plane changed — a green check that describes the wrong
  // system is worse than no check, because it is the thing people read instead of the manifest.
  const plane = continuityRegistrations()
    .map((spec) => `${spec.event}:${spec.id}[${spec.hosts.join('+')}]`).join(' ');
  console.log(`hook-policy-check: PASS — continuity-only lifecycle plane (${plane});`
    + ` all legacy Brain gates retired across ${result.files.length} source, contract, and host-pointer surfaces`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
