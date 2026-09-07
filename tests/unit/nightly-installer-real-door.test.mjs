import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('the supported nightly installer door', () => {
  it('writes a direct-exec plist without evaluating XML comments as JavaScript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-installer-door-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const kb = path.join(root, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    fs.writeFileSync(path.join(kb, 'forge-update.mjs'), '// fixture: existence is the enable precondition\n');
    const repo = path.resolve(import.meta.dirname, '../..');
    const run = spawnSync(process.execPath, [path.join(repo, 'bin', 'install.mjs'), '--enable-nightly'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, RUVNET_BRAIN_KB: kb, RUVNET_BRAIN_TEST: '1' },
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const plist = path.join(home, 'Library', 'LaunchAgents', 'com.ruvnet.brain-update.plist');
    expect(fs.existsSync(plist)).toBe(true);
    const xml = fs.readFileSync(plist, 'utf8');
    expect(xml).toContain('<string>com.ruvnet.brain-update</string>');
    expect(xml).not.toContain('<string>/bin/sh</string>');
    expect(xml).not.toContain('<string>/bin/bash</string>');
    expect(xml).toContain(`${home}/.npm-global/bin`);
    expect(xml).toContain(`${home}/.local/bin`);
  });
});
