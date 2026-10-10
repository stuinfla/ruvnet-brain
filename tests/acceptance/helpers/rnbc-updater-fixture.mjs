// A real coordinator over an explicitly empty private prefix: no user tool can be selected.
import fs from 'node:fs';
import path from 'node:path';
export function isolateDeveloperUpdateOwners(fixture) {
  const prefix = path.join(fixture.home, '.npm-global');
  const root = path.join(prefix, 'lib/node_modules');
  const bin = path.join(fixture.root, 'update-owner-bin');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'npm-owner.mjs');
  fs.writeFileSync(script, `const args = process.argv.slice(2);
const prefix = ${JSON.stringify(prefix)}, root = ${JSON.stringify(root)};
if (args[0] === 'prefix') console.log(prefix);
else if (args[0] === 'root') console.log(root);
else if (args[0] === '--version') console.log('11.0.0');
else if (args[0] === 'view') console.log(args.includes('--json') ? JSON.stringify({latest:'4.6.0'}) : '4.6.0');
else { console.error('fixture refuses mutation: '+args.join(' ')); process.exitCode=1; }
`);
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  // The source-bound corpus door still executes, but this fixture's corpus is already current.
  fs.writeFileSync(path.join(fixture.kb, 'forge-update.mjs'), `import fs from 'node:fs';
const args=process.argv.slice(2), file=args[args.indexOf('--result-file')+1];
if (!args.includes('--check') || !file) throw Error('fixture corpus mutations refused');
fs.writeFileSync(file,JSON.stringify({kind:'ruvnet-brain-check-result',recordedAt:new Date().toISOString(),currencyVerdict:'CURRENT'}));
`);
  fixture.env.PATH = [bin, ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(path.delimiter);
  fixture.env.npm_config_prefix = prefix;
  return { prefix, root, receipt: path.join(fixture.brainHome, 'nightly-suite-update.json'), policy: path.join(fixture.brainHome, 'developer-update-config.json') };
}
