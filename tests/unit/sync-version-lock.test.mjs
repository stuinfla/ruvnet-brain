import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, {recursive:true, force:true})));

it('detects and repairs KB lock drift through the real version CLI without changing dependency pins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-version-sync-'));
  roots.push(root);
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(root,file)), {recursive:true}); fs.writeFileSync(path.join(root,file),text); };
  const version = '9.8.7';
  for (const file of ['sync-version.mjs', 'version.mjs', 'rvf-generation.mjs']) {
    put(`scripts/${file}`, fs.readFileSync(new URL(`../../scripts/${file}`, import.meta.url)));
  }
  put('plugin/.claude-plugin/plugin.json', JSON.stringify({version}));
  put('kb/package.json', JSON.stringify({name:'fixture',version}));
  const lock = {name:'fixture',version:'9.8.6',lockfileVersion:3,packages:{
    '':{name:'fixture',version:'9.8.5',dependencies:{dependency:'1.2.3'}},
    'node_modules/dependency':{version:'1.2.3',integrity:'fixture-integrity'},
  }};
  put('kb/package-lock.json', JSON.stringify(lock,null,2)+'\n');
  put('README.md', `![RuvNet Brain version ${version} — updated today](https://img.shields.io/badge/version_${version}-updated_today)\n`);
  const run = (...args) => spawnSync(process.execPath, ['scripts/sync-version.mjs', ...args], {cwd:root,encoding:'utf8'});
  const red = run('--check');
  expect(red.status).toBe(1);
  expect(red.stderr).toContain('kb/package-lock.json = mixed(9.8.6, 9.8.5)');
  const repaired = run();
  expect(repaired.status, repaired.stderr).toBe(0);
  const actual = JSON.parse(fs.readFileSync(path.join(root,'kb/package-lock.json')));
  expect(actual).toEqual({...lock,version,packages:{...lock.packages,'':{...lock.packages[''],version}}});
  const green = run('--check');
  expect(green.status,green.stderr).toBe(0);
  const before = fs.readFileSync(path.join(root,'kb/package-lock.json'),'utf8');
  expect(run().status).toBe(0);
  expect(fs.readFileSync(path.join(root,'kb/package-lock.json'),'utf8')).toBe(before);
});
