#!/usr/bin/env node
/** Copy a generated asset from a tunneled host to a user's client Downloads folder. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const assetArg = args.find((arg) => arg.startsWith('--asset='));
const client = (args.find((arg) => arg.startsWith('--client='))?.slice(9) || 'm4').toLowerCase();
const clients = {
  m4: 'stuartkerr@100.95.179.114',
  air: 'macbook-air',
};
const host = args.find((arg) => arg.startsWith('--host='))?.slice(7) || clients[client];
const remoteDir = args.find((arg) => arg.startsWith('--remote-dir='))?.slice(13) || '/Users/stuartkerr/Downloads';
if (!assetArg || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/handoff-asset.mjs --asset=/absolute/path/to/file [--client=m4|air] [--host=user@client] [--remote-dir=/Users/user/Downloads]');
  process.exit(assetArg ? 0 : 2);
}
if (!host) { console.error(`Unknown client '${client}'. Use --client=m4, --client=air, or an explicit --host.`); process.exit(2); }
const asset = path.resolve(assetArg.slice(8));
if (!existsSync(asset)) { console.error(`Asset does not exist: ${asset}`); process.exit(2); }
const filename = path.basename(asset);
const localHash = createHash('sha256').update(readFileSync(asset)).digest('hex');
const copy = spawnSync('scp', ['-q', asset, `${host}:${remoteDir}/${filename}`], { encoding: 'utf8' });
if (copy.status !== 0) { console.error(copy.stderr || `scp failed with exit ${copy.status}`); process.exit(copy.status || 1); }
const verify = spawnSync('ssh', ['-o', 'BatchMode=yes', host, `shasum -a 256 ${JSON.stringify(`${remoteDir}/${filename}`)}`], { encoding: 'utf8' });
const remoteHash = verify.stdout.trim().split(/\s+/)[0];
if (verify.status !== 0 || remoteHash !== localHash) {
  console.error(`Checksum verification failed for ${filename}: local=${localHash} remote=${remoteHash || 'unavailable'}`);
  process.exit(1);
}
console.log(JSON.stringify({ host, path: `${remoteDir}/${filename}`, sha256: localHash, verified: true }, null, 2));
