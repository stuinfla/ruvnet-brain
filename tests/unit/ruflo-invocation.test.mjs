import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { rufloInvocation } from '../../plugin/scripts/ruflo-bin.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed cli & spaces-')); roots.push(root);
  const binary = path.join(root, 'ruflo.cmd'); fs.writeFileSync(binary, '@echo unsupported shell shim');
  const packageRoot = path.join(root, 'node_modules', 'ruflo'); fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'ruflo', bin: { ruflo: 'bin/ruflo.mjs' } }));
  const entry = path.join(packageRoot, 'bin/ruflo.mjs'); fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)))');
  return { binary, packageRoot, entry };
}
it('executes the declared Windows managed CLI via Node without a shell or argument rewriting', () => {
  const f = fixture();
  const args = ['memory', 'store', '--value', '{"text":"spaces & echo BAD | > file %PATH% !x! ^ \\"quoted\\""}', '--path', 'C:\\Project space & name\\.swarm\\memory.db'];
  const invocation = rufloInvocation(f.binary, args, { platform: 'win32' });
  expect(invocation).toEqual({ executable: process.execPath, args: [fs.realpathSync(f.entry), ...args] });
  const result = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', shell: false });
  expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(args);
});
it.each(['missing-package', 'foreign-package', 'escape', 'missing-entry'])('fails closed for %s without guessing another global installation', (mutant) => {
  const f = fixture();
  if (mutant === 'missing-package') fs.unlinkSync(path.join(f.packageRoot, 'package.json'));
  if (mutant === 'foreign-package') fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'other', bin: { ruflo: 'bin/ruflo.mjs' } }));
  if (mutant === 'escape') fs.writeFileSync(path.join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'ruflo', bin: { ruflo: '../../evil.mjs' } }));
  if (mutant === 'missing-entry') fs.unlinkSync(f.entry);
  expect(() => rufloInvocation(f.binary, ['memory'], { platform: 'win32' })).toThrow();
});
it('preserves native POSIX and Windows executable invocation', () => {
  const args = ['--value', 'literal & value'];
  expect(rufloInvocation('/managed/ruflo', args, { platform: 'darwin' })).toEqual({ executable: '/managed/ruflo', args });
  expect(rufloInvocation('C:\\managed\\ruflo.exe', args, { platform: 'win32' })).toEqual({ executable: 'C:\\managed\\ruflo.exe', args });
});
