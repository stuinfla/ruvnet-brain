#!/usr/bin/env node
import crypto from 'node:crypto';

export const RECEIPT_PREFIX = 'release-transaction-';
export const TERMINAL_STATES = new Set(['channels-converged', 'aborted']);

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const receiptPayload = (receipt) => {
  const { signature: _signature, receiptDigest: _digest, ...payload } = receipt;
  return canonical(payload);
};

export const digestReceipt = (receipt) => crypto.createHash('sha256')
  .update(receiptPayload(receipt)).digest('hex');

export const transactionIdFor = (identity) => crypto.createHash('sha256').update(canonical({
  repository: identity.repository,
  package: identity.package,
  version: identity.version,
  tag: identity.tag,
  candidateSha: identity.candidateSha,
  packageIntegrity: identity.packageIntegrity,
  bundleSha256: identity.bundleSha256,
})).digest('hex');

export function signReceipt(receipt, privateKey) {
  const unsigned = { ...receipt, receiptDigest: digestReceipt(receipt) };
  return {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64'),
  };
}

export function verifyReceipt(receipt, publicKey) {
  if (!receipt || receipt.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(receipt.transactionId || '')) {
    throw new Error('invalid release transaction receipt');
  }
  const { signature, receiptDigest, ...unsigned } = receipt;
  if (digestReceipt(unsigned) !== receiptDigest) throw new Error('release receipt digest mismatch');
  if (!crypto.verify(null, Buffer.from(canonical({ ...unsigned, receiptDigest })), publicKey, Buffer.from(signature || '', 'base64'))) {
    throw new Error('release receipt signature mismatch');
  }
  return receipt;
}

export function validateReceiptChain(receipts, identity, publicKey) {
  const expectedId = transactionIdFor(identity);
  const sorted = [...receipts].sort((a, b) => a.sequence - b.sequence);
  let previous = null;
  for (let index = 0; index < sorted.length; index += 1) {
    const receipt = verifyReceipt(sorted[index], publicKey);
    if (receipt.transactionId !== expectedId || canonical(receipt.identity) !== canonical(identity)) {
      throw new Error('release receipt identity conflict');
    }
    if (receipt.sequence !== index) throw new Error('release receipt sequence gap or replay');
    if ((receipt.previousReceiptDigest || null) !== (previous?.receiptDigest || null)) {
      throw new Error('release receipt chain conflict');
    }
    previous = receipt;
  }
  return sorted;
}

const stateReceipt = ({ identity, prior, state, fence, observation = {}, privateKey }) => signReceipt({
  schemaVersion: 1,
  transactionId: transactionIdFor(identity),
  sequence: prior ? prior.sequence + 1 : 0,
  previousReceiptDigest: prior?.receiptDigest || null,
  state,
  fence,
  identity,
  observation,
  createdAt: new Date().toISOString(),
}, privateKey);

const exact = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} mismatch: ${actual ?? '(missing)'} != ${expected}`);
};

export async function runReleaseTransaction({ identity, assets, adapter, privateKey, publicKey, hostVerifier }) {
  const expectedId = transactionIdFor(identity);
  const discovered = await adapter.discover(identity);
  const competing = discovered.pending?.filter((item) => item.transactionId !== expectedId) || [];
  if (competing.length) throw new Error(`pending release ${competing[0].transactionId} blocks ${expectedId}`);
  if ((discovered.matchingDrafts || []).length > 1) throw new Error('duplicate matching drafts require reconciliation');

  let chain = validateReceiptChain(discovered.receipts || [], identity, publicKey);
  let current = chain.at(-1) || null;
  const fence = current?.fence || discovered.fence || crypto.randomUUID();
  const draft = discovered.matchingDrafts?.[0] || await adapter.createDraft(identity, fence);
  const completed = new Set(chain.map(({ state }) => state));
  const append = async (state, observation = {}) => {
    const receipt = stateReceipt({ identity, prior: current, state, fence, observation, privateKey });
    await adapter.appendReceipt(draft, receipt, `${RECEIPT_PREFIX}${String(receipt.sequence).padStart(4, '0')}.json`);
    const observed = await adapter.readReceipt(draft, receipt.sequence);
    verifyReceipt(observed, publicKey);
    exact(observed.receiptDigest, receipt.receiptDigest, 'remote receipt');
    current = receipt;
    completed.add(state);
    return receipt;
  };
  const intend = async (state, observation = {}) => {
    if (!completed.has(state)) await append(state, observation);
  };

  if (!current) await append('remote-prepared', { draftId: draft.id, prior: discovered.prior });
  if (TERMINAL_STATES.has(current.state)) return current;
  if (current.fence !== fence) throw new Error('stale release transaction fence');

  if (!completed.has('local-hosts-verified')) {
    await intend('asset-upload-intent');
    await adapter.uploadAssets(draft, assets, identity);
    await intend('host-verification-intent', { source: 'sealed-local-assets' });
    const localHosts = await hostVerifier.verify({ source: 'local', identity, assets });
    if (localHosts.verdict !== 'PASS') throw new Error('local staged host verification failed');
    await append('local-hosts-verified', { hosts: localHosts });
  }

  if (!completed.has('npm-candidate-staged')) {
    await intend('npm-stage-intent');
    await adapter.stageNpm(identity, assets.packagePath);
    const stagedNpm = await adapter.observeNpmCandidate(identity);
    exact(stagedNpm.version, identity.version, 'npm candidate version');
    exact(stagedNpm.integrity, identity.packageIntegrity, 'npm candidate integrity');
    await append('npm-candidate-staged', { npm: stagedNpm });
  }

  if (!completed.has('prepared')) {
    await intend('remote-host-verification-intent');
    const staged = await adapter.materializeStagedAssets(draft, identity);
    try {
      const remoteHosts = await hostVerifier.verify({ source: 'staged', identity, assets: staged.assets, draft });
      if (remoteHosts.verdict !== 'PASS') throw new Error('remote staged host verification failed');
      await append('prepared', { hosts: remoteHosts });
    } finally {
      staged.cleanup();
    }
  }

  if (!completed.has('github-promoted-nonlatest')) {
    await intend('github-promote-intent');
    await adapter.publishDraftNonLatest(draft, identity);
    const github = await adapter.observeGithub(identity);
    exact(github.sha, identity.candidateSha, 'GitHub candidate SHA');
    if (github.latest) throw new Error('GitHub candidate advanced latest before npm convergence');
    await append('github-promoted-nonlatest', { github });
  }

  if (!completed.has('npm-promoted')) {
    await intend('npm-promote-intent');
    try {
      await adapter.promoteNpm(identity);
    } catch (error) {
      throw new Error(`npm promotion pending for ${identity.version}: ${error.message}`);
    }
    const npmLatest = await adapter.observeNpmLatest();
    exact(npmLatest.version, identity.version, 'npm latest');
    await append('npm-promoted', { npm: npmLatest });
  }

  // A failed GitHub-latest promotion is compensated back to A. The historical npm-promoted
  // receipt remains true, but is no longer the current external state, so a clean-runner retry
  // must explicitly re-promote B before it may retry GitHub.
  if (current.state === 'compensated') {
    await append('npm-repromote-intent');
    await adapter.promoteNpm(identity);
    const npmLatest = await adapter.observeNpmLatest();
    exact(npmLatest.version, identity.version, 'npm latest after compensation retry');
    await append('npm-repromoted', { npm: npmLatest });
  }

  if (!completed.has('defaults-promoted')) {
    await intend('github-latest-intent');
    try {
      await adapter.makeGithubLatest(draft, identity);
    } catch (error) {
      const observed = await adapter.observeNpmLatest();
      if (observed.version !== identity.version) throw new Error('npm latest changed during compensation');
      await intend('compensation-intent', { restore: discovered.prior?.npmLatest });
      await adapter.restoreNpmLatest(discovered.prior?.npmLatest, identity.version);
      exact((await adapter.observeNpmLatest()).version, discovered.prior?.npmLatest, 'npm compensation');
      await append('compensated', { reason: error.message });
      throw new Error(`GitHub latest promotion failed; npm compensated: ${error.message}`);
    }
    const githubLatest = await adapter.observeGithubLatest();
    exact(githubLatest.tag, identity.tag, 'GitHub latest');
    await append('defaults-promoted', { github: githubLatest });
  }

  await intend('finalize-intent');
  const final = await adapter.finalize(identity, current, hostVerifier);
  if (final.verdict !== 'PASS') throw new Error('final release convergence failed');
  return append('channels-converged', final);
}

export async function abortReleaseTransaction({ identity, receipts, reason, authorized, adapter, privateKey, publicKey }) {
  if (!authorized) throw new Error('release abort requires explicit human authorization');
  const chain = validateReceiptChain(receipts, identity, publicKey);
  const current = chain.at(-1);
  if (!current || TERMINAL_STATES.has(current.state)) throw new Error('release transaction is not abortable');
  const receipt = stateReceipt({
    identity, prior: current, state: 'aborted', fence: current.fence,
    observation: { reason, authorized: true }, privateKey,
  });
  await adapter.appendReceipt(null, receipt, `${RECEIPT_PREFIX}${String(receipt.sequence).padStart(4, '0')}.json`);
  return receipt;
}
