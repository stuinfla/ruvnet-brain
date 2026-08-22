#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { finalizeReleaseTransaction } from './release-transaction.mjs';
import { liveReleaseProvider } from './release-transaction-provider.mjs';

const argument = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function regularJson(file, label) {
  const absolute = path.resolve(file || '');
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a trusted regular file`);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

export async function finalizePublicVerification({
  identityFile,
  aggregateFile,
  outputFile,
  privatePem = process.env.RUVNET_SIGNING_KEY,
  publicKeyFile = 'keys/ruvnet-brain-signing.pub.pem',
  adapter = liveReleaseProvider({ root: process.cwd() }),
} = {}) {
  if (!identityFile || !aggregateFile || !outputFile) throw new Error('--identity, --aggregate, and --out are required');
  const output = path.resolve(outputFile);
  if (fs.existsSync(output)) throw new Error(`refusing to overwrite install-verified receipt: ${output}`);
  if (!privatePem) throw new Error('RUVNET_SIGNING_KEY is required');
  const identity = regularJson(identityFile, 'release identity');
  const aggregate = regularJson(aggregateFile, 'public verification aggregate');
  const publicKey = crypto.createPublicKey(fs.readFileSync(path.resolve(publicKeyFile), 'utf8'));
  const receipt = await finalizeReleaseTransaction({ identity, aggregate, adapter,
    privateKey: crypto.createPrivateKey(privatePem), publicKey, aggregatePublicKey: publicKey });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return receipt;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const receipt = await finalizePublicVerification({
      identityFile: argument(args, '--identity'),
      aggregateFile: argument(args, '--aggregate'),
      outputFile: argument(args, '--out'),
    });
    process.stdout.write(`${JSON.stringify({ state: receipt.state, transactionId: receipt.transactionId,
      receiptDigest: receipt.receiptDigest }, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`public-verification-finalizer: ${error.message}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = await main();
