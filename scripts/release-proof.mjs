#!/usr/bin/env node
export * from '../plugin/skills/release-proof/scripts/release-proof.mjs';
import { main } from '../plugin/skills/release-proof/scripts/release-proof.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
