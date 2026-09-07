#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { automaticHookRetirementStatus } from '../bin/install.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function main() {
  const result = automaticHookRetirementStatus(ROOT);
  if (!result.ok) {
    console.error(`hook-retirement-check: FAIL — ${result.registrations.length} automatic registration(s), ${result.errors.length} manifest error(s)`);
    for (const error of result.errors) console.error(`  ${error}`);
    for (const item of result.registrations) console.error(`  ${item.file} ${item.event}: ${item.command || '(empty command)'}`);
    return 1;
  }
  console.log(`hook-retirement-check: PASS — zero automatic Brain registrations across ${result.files.length} source, contract, and host-pointer surfaces`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
