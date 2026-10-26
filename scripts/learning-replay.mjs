#!/usr/bin/env node
/** Thin compatibility surface for the source-bound learning replay harness. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './learning-replay-cli.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

export * from './learning-replay-contract.mjs';
export * from './learning-replay-execution.mjs';
export * from './learning-replay-fixture.mjs';
export * from './learning-replay-proof.mjs';
export { main, measurePortfolio, checkWire } from './learning-replay-cli.mjs';

const invokedDirectly = isDirectInvocation(import.meta.url);
if (invokedDirectly) process.exit(await main());
