#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { hardProblem } from './dual-host-deliberation.mjs';
import { probeSubscriptionHosts } from './subscription-hosts.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const HOSTS = Object.freeze([
  ['claude', 'claude-code'],
  ['codex', 'codex'],
]);

export function recommendDualHost(task, options = {}) {
  if (!hardProblem(task)) {
    return {
      action: 'single-host',
      hardProblem: false,
      hosts: [],
      missing: [],
      billing: 'subscription-only',
      apiKeyFallback: false,
    };
  }

  const probes = options.probes ?? probeSubscriptionHosts();
  const hosts = HOSTS
    .filter(([key]) => probes[key]?.eligible)
    .map(([, host]) => host);
  const missing = HOSTS
    .filter(([key]) => !probes[key]?.eligible)
    .map(([, host]) => host);

  return {
    action: missing.length === 0 ? 'duel' : 'login-required',
    hardProblem: true,
    hosts,
    missing,
    billing: 'subscription-only',
    apiKeyFallback: false,
  };
}

export function main(argv = process.argv.slice(2), {
  probes,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const task = argv.join(' ').trim();
  if (!task) {
    stderr.write('Usage: dual-host-suggest.mjs "<task>"\n');
    return 64;
  }
  stdout.write(`${JSON.stringify(recommendDualHost(task, { probes }), null, 2)}\n`);
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main();
}
