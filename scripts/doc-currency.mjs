#!/usr/bin/env node
// Compatibility entrypoint; the canonical evaluator ships with the owned plugin runtime.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main } from '../plugin/scripts/doc-currency.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';
export * from '../plugin/scripts/doc-currency.mjs';
let direct = false;
try { direct = isDirectInvocation(import.meta.url); } catch {}
if (direct) process.exit(main());
