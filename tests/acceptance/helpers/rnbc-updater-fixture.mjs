// A real coordinator over an explicitly empty private prefix: no user tool can be selected.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getVersion } from '../../../scripts/version.mjs';
export function isolateDeveloperUpdateOwners(fixture) {
  const prefix = path.join(fixture.home, '.npm-global');
  const root = path.join(prefix, 'lib/node_modules');
  const bin = path.join(fixture.home, 'bin');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  const version = getVersion();
  const script = path.join(bin, 'npm-owner.mjs');
  fs.writeFileSync(script, `const args = process.argv.slice(2);
const prefix = ${JSON.stringify(prefix)}, root = ${JSON.stringify(root)};
if (args[0] === 'prefix') console.log(prefix);
else if (args[0] === 'root') console.log(root);
else if (args[0] === '--version') console.log('11.0.0');
else if (args[0] === 'view') console.log(args.includes('--json') ? JSON.stringify({latest:${JSON.stringify(version)}}) : ${JSON.stringify(version)});
else { console.error('fixture refuses mutation: '+args.join(' ')); process.exitCode=1; }
`);
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  const brew = process.platform === 'win32' ? null : path.join(bin, 'brew');
  const brewLog = path.join(fixture.root, 'brew-owner-calls.jsonl');
  if (brew) {
    const brewScript = path.join(bin, 'brew-owner.mjs');
    fs.writeFileSync(brewScript, `import fs from 'node:fs';
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(brewLog)},JSON.stringify({args,pid:process.pid})+'\\n');
if(args[0]==='info' && args.includes('--installed')) console.log(JSON.stringify({formulae:[],casks:[]}));
else if(args[0]==='update' || args[0]==='upgrade' && args[1]==='--formula') process.exitCode=0;
else {console.error('fixture Homebrew refuses unreviewed command');process.exitCode=1;}
`);
    fs.writeFileSync(brew, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(brewScript)} "$@"\n`, { mode: 0o755 });
  }
  // The source-bound corpus door still executes, but this fixture's corpus is already current.
  fs.writeFileSync(path.join(fixture.kb, 'forge-update.mjs'), `import fs from 'node:fs';
const args=process.argv.slice(2), file=args[args.indexOf('--result-file')+1];
if (!args.includes('--check') || !file) throw Error('fixture corpus mutations refused');
fs.writeFileSync(file,JSON.stringify({kind:'ruvnet-brain-check-result',recordedAt:new Date().toISOString(),currencyVerdict:'CURRENT'}));
`);
  fixture.env.PATH = [bin, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
  fixture.env.npm_config_prefix = prefix;
  return { prefix, root, brew, brewLog, receipt: path.join(fixture.brainHome, 'nightly-suite-update.json'), policy: path.join(fixture.brainHome, 'developer-update-config.json') };
}

export function coordinatorExecutionFiles(fixture) {
  const entry = path.join(fixture.runtime, 'plugin', 'scripts', 'developer-update.mjs');
  const installer = pathToFileURL(path.join(fixture.runtime, 'bin', 'install.mjs')).href;
  const program = `import path from 'node:path'; const {serverDependencies}=await import(${JSON.stringify(installer)});
console.log(JSON.stringify([${JSON.stringify(entry)},...serverDependencies(${JSON.stringify(entry)}).map(item=>item.from)]
.filter(file=>file.endsWith('.mjs')).map(file=>path.basename(file)).sort()));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: fixture.project, env: { ...fixture.env, RUVNET_BRAIN_IMPORT_ONLY: '1' }, encoding: 'utf8', timeout: 20_000,
  });
  if (result.error || result.status !== 0) throw Error(`packed execution-closure inspection failed: ${result.error?.message || result.stderr}`);
  return JSON.parse(result.stdout);
}
