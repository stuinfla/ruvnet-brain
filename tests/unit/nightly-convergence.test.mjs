import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const INSTALL = fs.readFileSync(path.join(ROOT, 'bin', 'install.mjs'), 'utf8');
const RUNNER = fs.readFileSync(path.join(ROOT, 'bin', 'nightly-refresh.mjs'), 'utf8');
const HOST_UPDATE = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'host-update.mjs'), 'utf8');

function argvFrom(source, anchor, terminator = '];') {
  const block = source.slice(source.indexOf(anchor));
  const end = block.indexOf(terminator);
  return [...block.slice(0, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe('automatic refresh paths use the product coordinator with explicit scope', () => {
  it('the nightly runner performs the full update; the plugin updater stays host-sync-only; the knowledge self-heal runs the nightly argv', () => {
    const session = argvFrom(HOST_UPDATE, "automaticInvocation(['--update', '--host-sync-only'", ']);');
    const knowledge = argvFrom(HOST_UPDATE, "automaticInvocation(['--update', '--no-nightly-prompt'], { source })", ');');
    expect(session).toContain('--host-sync-only');
    expect(knowledge.slice(0, 2)).toEqual(['--update', '--no-nightly-prompt']);
    expect(RUNNER).toContain("automaticInvocation(['--update', '--no-nightly-prompt']");
    expect(RUNNER).not.toContain('--host-sync-only');
    expect(RUNNER).toContain("registration.packageTarget.spec");
    expect(RUNNER).toContain("registration.packageTarget.spec !== 'ruvnet-brain@latest'");
    expect(RUNNER).toContain('registration.bundleTarget');
    expect(INSTALL).toContain('resolveNightlyProofBundle');
  });

  it('the installer registers the immutable runner through the shared scheduler module', () => {
    expect(INSTALL).toContain("source: path.join(REPO_ROOT, 'bin', 'nightly-refresh.mjs')");
    expect(INSTALL).toMatch(/installNightlyRunner\(/);
    expect(INSTALL).toMatch(/installScheduler\(registration/);
    expect(INSTALL).toMatch(/schedulerStatus\(/);
    expect(INSTALL).not.toMatch(/const NIGHTLY_ARGV/);
  });

  it('no scheduler path invokes the KB-only updater or a shell', () => {
    const scheduler = fs.readFileSync(path.join(ROOT, 'plugin', 'scripts', 'nightly-scheduler.mjs'), 'utf8');
    expect(scheduler).not.toMatch(/forge-update\.mjs/);
    expect(scheduler).not.toMatch(/\/bin\/sh|-c['"]/);
  });
});
