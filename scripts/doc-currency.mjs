#!/usr/bin/env node
// Compatibility entrypoint; the canonical evaluator ships with the owned plugin runtime.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../plugin/scripts/doc-currency.mjs';
export * from '../plugin/scripts/doc-currency.mjs';
let direct = false;
try { direct = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (direct) process.exit(main());
