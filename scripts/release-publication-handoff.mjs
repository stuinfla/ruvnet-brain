import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, transactionIdFor, verifyReceipt } from './release-transaction.mjs';

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function trustedEvidenceDirectory(root) {
  const evidenceRoot = path.join(path.resolve(root), 'release-evidence');
  let stat;
  try { stat = fs.lstatSync(evidenceRoot); } catch { throw new Error('release-evidence directory is missing'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('release-evidence must be a trusted directory');
  }
  return evidenceRoot;
}

export function resolvePublicationHandoffPaths({ root, identityPath, receiptPath } = {}) {
  const evidenceRoot = trustedEvidenceDirectory(root);
  const resolveTarget = (configured, label) => {
    if (typeof configured !== 'string' || !configured.trim()) throw new Error(`${label} output is required`);
    const target = path.resolve(root, configured);
    if (path.dirname(target) !== evidenceRoot || path.extname(target) !== '.json') {
      throw new Error(`${label} output must be a direct JSON file inside release-evidence`);
    }
    if (fs.existsSync(target)) throw new Error(`${label} output must be a new file`);
    return target;
  };
  const identity = resolveTarget(identityPath, 'release identity');
  const receipt = resolveTarget(receiptPath, 'channel receipt');
  if (identity === receipt) throw new Error('release identity and channel receipt outputs must differ');
  return { evidenceRoot, identity, receipt };
}

export function validatePublicationHandoff({ identity, receipt, publicKey } = {}) {
  verifyReceipt(receipt, publicKey);
  if (receipt.schemaVersion !== 3 || receipt.state !== 'channels-converged'
    || receipt.observation?.verdict !== 'PUBLISHED_NOT_VERIFIED') {
    throw new Error('channel receipt is not signed PUBLISHED_NOT_VERIFIED convergence evidence');
  }
  if (receipt.transactionId !== transactionIdFor(identity)
    || canonicalJson(receipt.identity) !== canonicalJson(identity)) {
    throw new Error('channel receipt identity differs from the release identity');
  }
  return receipt;
}

function writePrivateTemp(directory, label, bytes) {
  const temp = path.join(directory, `.${label}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  let closed = false;
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    closed = true;
    return temp;
  } catch (error) {
    if (!closed) {
      try { fs.closeSync(fd); } catch { /* preserve the write failure */ }
    }
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function removeOwnedLink(destination, temporary) {
  try {
    const linked = fs.lstatSync(destination);
    const source = fs.lstatSync(temporary);
    if (linked.dev === source.dev && linked.ino === source.ino) fs.unlinkSync(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function materializePublicationHandoff({ paths, identity, receipt, publicKey } = {}) {
  if (!paths?.evidenceRoot || path.dirname(paths.identity || '') !== paths.evidenceRoot
    || path.dirname(paths.receipt || '') !== paths.evidenceRoot || paths.identity === paths.receipt) {
    throw new Error('publication handoff paths were not validated');
  }
  validatePublicationHandoff({ identity, receipt, publicKey });
  const temporary = [];
  let identityLinked = false;
  let receiptLinked = false;
  try {
    temporary.push(writePrivateTemp(paths.evidenceRoot, 'release-identity', jsonBytes(identity)));
    temporary.push(writePrivateTemp(paths.evidenceRoot, 'channels-converged', jsonBytes(receipt)));
    fs.linkSync(temporary[0], paths.identity);
    identityLinked = true;
    fs.linkSync(temporary[1], paths.receipt);
    receiptLinked = true;
  } catch (error) {
    if (receiptLinked) removeOwnedLink(paths.receipt, temporary[1]);
    if (identityLinked) removeOwnedLink(paths.identity, temporary[0]);
    throw new Error(`publication handoff materialization failed: ${error.message}`);
  } finally {
    for (const temp of temporary) fs.rmSync(temp, { force: true });
  }
  return { identityPath: paths.identity, receiptPath: paths.receipt };
}
