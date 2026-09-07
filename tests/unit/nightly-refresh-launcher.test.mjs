import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function run(platform, mutant) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly & literal-'))); roots.push(root);
  // Windows Node includes adjacent npm, which outranks the fixture PATH. Run its real
  // executable in the fixture directory. POSIX Node may require install-relative dylibs.
  const node = process.platform === 'win32' ? path.join(root, 'node.exe') : process.execPath;
  if (process.platform === 'win32') {
    try { fs.linkSync(process.execPath, node); }
    catch { fs.copyFileSync(process.execPath, node); }
  }
  const runner = path.join(root, 'runner.mjs');
  fs.copyFileSync(new URL('../../bin/nightly-refresh.mjs', import.meta.url), runner);
  const pkg = path.join(root, 'node_modules/npm'); fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'npx.cmd'), '@echo unused');
  const entry = path.join(pkg, 'bin/npx-cli.js');
  fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode=7;');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: mutant === 'foreign' ? 'foreign' : 'npm', bin: { npx: mutant === 'escape' ? '../../outside.js' : 'bin/npx-cli.js' } }));
  if (mutant === 'missing-entry') fs.unlinkSync(entry);
  if (mutant === 'missing-shim') fs.unlinkSync(path.join(root, 'npx.cmd'));
  if (mutant === 'symlink-escape') {
    const outside = path.join(root, 'outside.js'); fs.renameSync(entry, outside); fs.symlinkSync(outside, entry);
  }
  const spec = path.join(root, 'candidate & %PATH% !literal!.tgz'); fs.writeFileSync(spec, 'sealed fixture');
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const registration = path.join(root, 'registration.json');
  fs.writeFileSync(registration, JSON.stringify({ schemaVersion: 2, kind: 'ruvnet-brain-nightly-scheduler', identity: 'com.ruvnet.brain-update', environment: { RUVNET_BRAIN_HOME: root, RUVNET_BRAIN_KB: path.join(root, 'custom-kb') }, runnerPath: runner, runnerSha256: hash(runner), nodePath: node, argv: [], packageTarget: { spec, sha256: hash(spec) }, bundleTarget: null }));
  const preload = path.join(root, 'preload.mjs');
  fs.writeFileSync(preload, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
    const original=cp.spawnSync;
    cp.spawnSync=(command,args,opts)=>{
      if(opts.shell!==false) throw Error('shell forbidden');
      if(opts.env.RUVNET_BRAIN_HOME!==${JSON.stringify(root)} || opts.env.RUVNET_BRAIN_KB!==${JSON.stringify(path.join(root, 'custom-kb'))}) throw Error('registered custom paths were lost');
      ${platform === 'win32' ? `if(command!==process.execPath) throw Error('Windows cannot directly execute cmd shim'); if(args[0]!==${JSON.stringify(entry)}) throw Error('launcher escaped fixture npm');` : `if(!command.endsWith('npx')) throw Error('POSIX invocation changed'); command=process.execPath; args=[${JSON.stringify(entry)},...args];`}
      return original(command,args,opts);
    }; syncBuiltinESMExports();`);
  return { spec, result: spawnSync(node, ['--import', pathToFileURL(preload).href, runner, '--registration', registration], { encoding: 'utf8', env: { PATH: root } }) };
}
it.each(['win32', 'darwin', 'linux'])('launches the registered target without shell argument rewriting on %s', platform => {
  const { spec, result } = run(platform);
  expect(result.status, result.stderr).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual(['--yes', spec, '--update', '--no-nightly-prompt']);
});
it.each(['foreign', 'escape', 'missing-entry', 'missing-shim', 'symlink-escape'])('rejects unsafe managed npm entry: %s', mutant => {
  const { result } = run('win32', mutant);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/managed npm/);
});
