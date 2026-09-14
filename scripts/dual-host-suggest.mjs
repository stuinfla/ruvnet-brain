#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { hardProblem } from './dual-host-deliberation.mjs';
import { probeSubscriptionHosts } from './subscription-hosts.mjs';

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

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  process.exitCode = main();
}
