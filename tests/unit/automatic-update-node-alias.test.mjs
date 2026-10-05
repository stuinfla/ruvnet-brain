// Homebrew-style executable alias execution is a POSIX prerequisite; portable owner policy
// and routing controls remain in automatic-update.test.mjs for every release platform.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stableNode } from '../../plugin/scripts/automatic-update.mjs';
import { installNightlyRunner, readNightlyRegistration } from '../../plugin/scripts/nightly-scheduler.mjs';
const roots = [];
function scratch() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnb-node-alias-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('stable supported Node registration', () => {
  it('derives the active Homebrew opt alias and accepts its later retargeting by realpath identity', () => {
    const root = scratch();
    const binary = fs.realpathSync(process.execPath);
    const old = path.join(root, 'Cellar', 'node@24', '24.0.0', 'bin', 'node');
    const next = path.join(root, 'Cellar', 'node@24', '24.1.0', 'bin', 'node');
    const alias = path.join(root, 'opt', 'node@24', 'bin', 'node');
    for (const item of [old, next, alias]) fs.mkdirSync(path.dirname(item), { recursive: true });
    // Symlinks to the actual supported interpreter keep execution real without installing Node.
    fs.symlinkSync(binary, old, 'file'); fs.symlinkSync(binary, next, 'file'); fs.symlinkSync(old, alias, 'file');
    expect(stableNode({ executable: old })).toBe(alias);
    fs.unlinkSync(alias); fs.symlinkSync(next, alias, 'file'); fs.unlinkSync(old);
    expect(stableNode({ executable: next })).toBe(alias);
    expect(spawnSync(alias, ['--version'], { encoding: 'utf8' }).status).toBe(0);
    const source = path.resolve(import.meta.dirname, '../../bin/nightly-refresh.mjs');
    const record = installNightlyRunner({ brainHome: path.join(root, 'brain'), source, nodePath: alias, env: { HOME: root, PATH: '/poison' } });
    expect(readNightlyRegistration({ brainHome: path.join(root, 'brain') }).ok).toBe(true);
    expect(record.environment.PATH).not.toContain('/poison');
    // Mutated dependency bytes must refuse before importing executable policy.
    fs.appendFileSync(record.updateModules['automatic-update.mjs'].path, '// changed');
    expect(readNightlyRegistration({ brainHome: path.join(root, 'brain') }).ok).toBe(false);
  });
  it('refuses stale or mismatched aliases, unsupported versions and transient npx Node paths', () => {
    const version = () => ({ status: 0, stdout: 'v16.0.0' });
    expect(() => stableNode({ run: version })).toThrow(/Node 18/);
    expect(() => stableNode({ executable: '/prefix/Cellar/node/1/bin/node', realpath: value => value.includes('/opt/') ? '/wrong' : '/right' })).toThrow(/mismatched/);
    expect(() => stableNode({ executable: '/home/owner/.npm/_npx/transient/bin/node' })).toThrow(/stable Node/);
    expect(() => stableNode({ explicit: 'node' })).toThrow(/absolute/);
  });
});
