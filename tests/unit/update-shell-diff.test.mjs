import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ENGINE = path.join(ROOT, 'plugin', 'scripts', 'update-apply.mjs');
const roots = [];
let shellDiff;

beforeAll(async () => {
  process.env.RUVNET_BRAIN_IMPORT_ONLY = 'update-shell-test';
  ({ shellDiff } = await import('../../plugin/scripts/update-apply.mjs'));
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-diff-'));
  roots.push(root);
  for (const rel of [
    'hooks/hooks.json', 'scripts/hook-shim.mjs', 'scripts/hook-shim-bash.mjs',
    'scripts/development-maintenance.mjs', 'mcp/server.mjs', '.mcp.json',
    'skills/example/SKILL.md', 'commands/example.md', 'scripts/body.mjs',
  ]) {
    const file = path.join(root, 'a', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `same:${rel}`);
    const peer = path.join(root, 'b', rel);
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    fs.writeFileSync(peer, `same:${rel}`);
  }
  return { root, a: path.join(root, 'a'), b: path.join(root, 'b') };
}

describe('Stable Spine shell-change detection', () => {
  it('detects content changes in frozen imports and boot-loaded markdown', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.b, 'scripts', 'hook-shim-bash.mjs'), 'changed');
    fs.writeFileSync(path.join(f.b, 'scripts', 'development-maintenance.mjs'), 'changed');
    fs.writeFileSync(path.join(f.b, 'skills', 'example', 'SKILL.md'), 'changed');
    fs.writeFileSync(path.join(f.b, 'commands', 'example.md'), 'changed');
    expect(shellDiff(f.a, f.b)).toEqual(expect.arrayContaining([
      'scripts/hook-shim-bash.mjs', 'scripts/development-maintenance.mjs', 'skills/', 'commands/',
    ]));
  });

  it('ignores body-only changes', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.b, 'scripts', 'body.mjs'), 'new body');
    expect(shellDiff(f.a, f.b)).toEqual([]);
  });

  it('retains a shell-change boundary across a later body-only generation', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-shell-state-'));
    roots.push(home);
    const payload = (version, shell = false) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `payload-${version}-`));
      roots.push(dir);
      fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scripts', 'body.mjs'), `console.log(${JSON.stringify(version)});`);
      fs.writeFileSync(path.join(dir, 'scripts', 'hook-shim.mjs'), `console.log(${JSON.stringify(shell ? 'shell-change' : 'stable-shell')});`);
      fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}');
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ruvnet-brain', version }));
      return dir;
    };
    const run = (dir) => spawnSync(process.execPath, [ENGINE, '--from-dir', dir], {
      encoding: 'utf8', env: { ...process.env, RUVNET_BRAIN_HOME: home, RUVNET_BRAIN_IMPORT_ONLY: '' },
    });
    expect(run(payload('1.0.0'))).toMatchObject({ status: 0 });
    expect(run(payload('1.1.0', true))).toMatchObject({ status: 0 });
    expect(run(payload('1.2.0', true))).toMatchObject({ status: 0 });
    const active = JSON.parse(fs.readFileSync(path.join(home, 'active.json'), 'utf8'));
    expect(active.shellChanged).toBe(false);
    expect(active.shellChangedSinceVersion).toBe('1.0.0'); // sync-version-ignore: fixture generation built by payload('1.0.0') above, not the product's version
    expect(active.shellChangedAtVersion).toBe('1.1.0');    // sync-version-ignore: fixture generation built by payload('1.1.0') above, not the product's version
  });
});
