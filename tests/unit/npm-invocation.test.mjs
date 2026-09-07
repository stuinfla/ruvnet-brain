import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { npmInvocation } from '../helpers/npm-invocation.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
it('uses the positively identified npm entry and preserves metacharacters as argv', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm & fixture-'))); roots.push(root);
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const entry = path.join(bin, 'npm-cli.js');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: 'bin/npm-cli.js' } }));
  fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['pack', '--pack-destination', 'directory spaces & | %VALUE% !name!'];
  const invocation = npmInvocation(args, { env: { npm_execpath: entry } });
  expect(invocation).toEqual({ executable: process.execPath, args: [entry, ...args] });
  const result = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', shell: false });
  expect(result.status).toBe(0); expect(JSON.parse(result.stdout)).toEqual(args);
});
it('reports missing installed npm without downloading or shell fallback', () => {
  expect(() => npmInvocation([], { env: {}, nodePath: path.join(os.tmpdir(), 'absent-managed-node', 'node') }))
    .toThrow(/requires installed npm/);
});
