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

export async function main(args = process.argv.slice(2)) {
  try {
    const identityFile = argument(args, '--identity');
    const aggregateFile = argument(args, '--aggregate');
    if (!identityFile || !aggregateFile) throw new Error('--identity and --aggregate are required');
    const identity = JSON.parse(fs.readFileSync(path.resolve(identityFile), 'utf8'));
    const aggregate = JSON.parse(fs.readFileSync(path.resolve(aggregateFile), 'utf8'));
    const privatePem = process.env.RUVNET_SIGNING_KEY;
    if (!privatePem) throw new Error('RUVNET_SIGNING_KEY is required');
    const publicKey = crypto.createPublicKey(fs.readFileSync(path.resolve('keys/ruvnet-brain-signing.pub.pem'), 'utf8'));
    const receipt = await finalizeReleaseTransaction({ identity, aggregate, adapter: liveReleaseProvider({ root: process.cwd() }),
      privateKey: crypto.createPrivateKey(privatePem), publicKey, aggregatePublicKey: publicKey });
    process.stdout.write(`${JSON.stringify({ state: receipt.state, transactionId: receipt.transactionId,
      receiptDigest: receipt.receiptDigest }, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`public-verification-finalizer: ${error.message}`);
    return 1;
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = await main();
