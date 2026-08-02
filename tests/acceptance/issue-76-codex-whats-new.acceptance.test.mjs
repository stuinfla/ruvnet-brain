import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CODEX = process.env.RUVNET_CODEX_BIN || 'codex';
const temps = [];

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  temps.push(dir);
  return dir;
}

function runCodex(home, args, cwd = ROOT) {
  return spawnSync(CODEX, args, {
    cwd,
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
}

function findFile(root, suffix) {
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && child.endsWith(suffix)) return child;
    }
  }
  return null;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('issue #76 real Codex installed boundary', () => {
  const available = spawnSync(CODEX, ['--version'], { encoding: 'utf8' }).status === 0;
  const auth = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const test = available && fs.existsSync(auth) ? it : it.skip;

  test('loads the installed skill and runs its cached executable after marketplace source removal', () => {
    const codexHome = tempDir('brain-issue76-codex-');
    const marketplace = tempDir('brain-issue76-market-');
    const unrelatedCwd = tempDir('brain-issue76-cwd-');
    fs.cpSync(path.join(ROOT, 'plugin'), marketplace, { recursive: true });

    const added = runCodex(codexHome, ['plugin', 'marketplace', 'add', marketplace, '--json']);
    expect(added.status, added.stderr || added.stdout).toBe(0);
    const installed = runCodex(codexHome, ['plugin', 'add', 'ruvnet-brain@ruvnet-brain', '--json']);
    expect(installed.status, installed.stderr || installed.stdout).toBe(0);
    fs.rmSync(marketplace, { recursive: true, force: true });

    const rendered = runCodex(codexHome, ['debug', 'prompt-input', '$ruvnet-brain:whats-new'], unrelatedCwd);
    expect(rendered.status, rendered.stderr || rendered.stdout).toBe(0);
    expect(rendered.stdout).toContain('ruvnet-brain:whats-new');

    const executable = findFile(path.join(codexHome, 'plugins', 'cache'), path.join('scripts', 'whats-new.mjs'));
    expect(executable).toBeTruthy();
    const manifestFile = findFile(path.dirname(path.dirname(executable)), path.join('.codex-plugin', 'plugin.json'));
    expect(manifestFile).toBeTruthy();
    const version = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).version;
    const invoked = spawnSync(process.execPath, [executable], { cwd: unrelatedCwd, encoding: 'utf8' });
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(invoked.stdout).toContain(`RuvNet Brain ${version}`);
    expect(invoked.stdout).toContain("# RuvNet-Brain 4.0 line — what's new");

    fs.symlinkSync(auth, path.join(codexHome, 'auth.json'));
    const host = runCodex(codexHome, [
      'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--sandbox', 'read-only', '--json',
      '$ruvnet-brain:whats-new Run the installed skill, report its exact Brain version, then end with HOST_ACCEPTED.',
    ], unrelatedCwd);
    expect(host.status, host.stderr || host.stdout).toBe(0);
    expect(host.stdout).toContain('HOST_ACCEPTED');
    expect(host.stdout).toContain(version);
  }, 60_000);
});
