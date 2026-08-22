#!/usr/bin/env node
import crypto from 'node:crypto';
import { canonicalJson } from './coverage-integrity.mjs';

export { canonicalJson };

export const RECEIPT_PREFIX = 'release-transaction-';
export const TERMINAL_STATES = new Set(['channels-converged', 'aborted']);

// `aborted` WAS UNREACHABLE, AND THAT BRICKED THE RELEASE RAIL (found 2026-08-07, issue #77).
//
// `aborted` has always been in TERMINAL_STATES, but no state below listed it as a target — so it
// was a terminal state nothing could ever enter. Combined with `manual-intervention-required`
// (which has NO outgoing transitions and is NOT terminal), an interrupted release had exactly two
// destinations and both were permanent non-terminal dead ends.
//
// That is not theoretical. The v4.0.7 transaction (b2ac9b69…) stopped at `npm-stage-intent` and
// stayed there. `runReleaseTransaction` treats every non-terminal receipt from another transaction
// as competing, so it refused EVERY later release with
//     `pending release b2ac9b69… blocks <new>`
// and there was no legal move that could clear it. npm was then hand-moved to 4.0.12, which also
// disqualified the provider's `settled` escape hatch (it requires receipt.version === npmLatest).
// So the rail deadlocked itself, hand-publishing became the only way to ship, and hand-publishing
// is precisely how npm and GitHub came to name different generations — the whole of #77.
//
// The fix is to give abandonment a legal move, which is what `aborted` was declared for. Any
// non-terminal state may now abort. This LOOSENS nothing about a live release: `aborted` is
// terminal, so a transaction that aborts can never resume and claim to have shipped, and the
// competing-transaction guard still refuses two genuinely in-flight releases.
const ABORTABLE = ['aborted'];

export const ALLOWED_TRANSITIONS = Object.freeze({
  'remote-prepared': ['asset-upload-intent', 'manual-intervention-required', ...ABORTABLE],
  'asset-upload-intent': ['npm-stage-intent', 'manual-intervention-required', ...ABORTABLE],
  'npm-stage-intent': ['npm-candidate-staged', 'manual-intervention-required', ...ABORTABLE],
  'npm-candidate-staged': ['remote-materialization-intent', 'manual-intervention-required', ...ABORTABLE],
  'remote-materialization-intent': ['prepared', 'manual-intervention-required', ...ABORTABLE],
  prepared: ['github-promote-intent', 'manual-intervention-required', ...ABORTABLE],
  'github-promote-intent': ['github-promoted-nonlatest', 'manual-intervention-required', ...ABORTABLE],
  'github-promoted-nonlatest': ['npm-promote-intent', 'manual-intervention-required', ...ABORTABLE],
  'npm-promote-intent': ['npm-promoted', 'compensation-intent', 'manual-intervention-required', ...ABORTABLE],
  // `defaults-promoted` added 2026-08-07: when GitHub is ALREADY latest at the moment npm is
  // promoted, the reducer correctly chooses `finalize` and the finalize path moves straight to
  // `defaults-promoted` (release-transaction.mjs:406) — there is no `github-latest-intent` to pass
  // through, because there is nothing left to intend. The table assumed that hop was mandatory, so
  // the 4.0.24 publish promoted BOTH channels successfully and then died on its own bookkeeping
  // with `illegal release transition npm-promoted -> defaults-promoted`. The publication was real;
  // only the ledger entry was refused. Both defaults genuinely are promoted in that state, so this
  // records what happened rather than permitting anything new.
  'npm-promoted': ['github-latest-intent', 'defaults-promoted', 'compensation-intent', 'manual-intervention-required', ...ABORTABLE],
  'github-latest-intent': ['defaults-promoted', 'compensation-intent', 'manual-intervention-required', ...ABORTABLE],
  'compensation-intent': ['compensated', 'manual-intervention-required', ...ABORTABLE],
  compensated: ['github-promote-intent', 'npm-promote-intent', 'manual-intervention-required', ...ABORTABLE],
  'defaults-promoted': ['finalize-intent', 'manual-intervention-required', ...ABORTABLE],
  'finalize-intent': ['channels-converged', 'manual-intervention-required', ...ABORTABLE],
  'manual-intervention-required': [],
  'channels-converged': [],
  aborted: [],
});

/**
 * THE DIGEST SERIALISER MUST AGREE WITH THE ONE THAT WRITES THE FILE.
 *
 * It did not, and it silently corrupted the terminal receipt of EVERY successful release. Measured
 * 2026-08-20 on v4.0.36 and v4.0.90-dev — both `channels-converged` receipts, both digest=BAD, both
 * with the same missing key:
 *
 *     canonicalJson({a: undefined})  ->  {"a":undefined}      key KEPT (and not even valid JSON)
 *     JSON.stringify({a: undefined}) ->  {}                   key DROPPED
 *
 * The converge observation carries optional fields — `hosts.verifier.error`, `claudeOnly`,
 * `codexOnly`, `dual` — and on a clean run `verified.error` is `undefined`. So the digest was
 * computed over `…"error":undefined…` while the bytes written omitted `error` entirely: a digest
 * over a shape that can never be read back. `runReleaseTransaction` appends a receipt, reads it
 * back and verifies it, so the publish then died with `release receipt digest mismatch` AFTER npm
 * and GitHub had both been promoted — the release shipped and the rail reported failure.
 *
 * Proven by reconstruction: restoring `observation.hosts.verifier.error = undefined` on the stored
 * receipt makes `digestReceipt` reproduce the stored digest exactly.
 *
 * Arrays have the same asymmetry (`JSON.stringify([undefined])` is `[null]`), so both are matched
 * here. This does not change the digest of any receipt that never held an undefined value, which is
 * every receipt that currently verifies.
 */
export const receiptPayload = (receipt) => {
  const { signature: _signature, receiptDigest: _digest, ...payload } = receipt;
  return canonicalJson(payload);
};

export const digestReceipt = (receipt) => crypto.createHash('sha256')
  .update(receiptPayload(receipt)).digest('hex');

export const transactionIdFor = (identity) => crypto.createHash('sha256').update(canonicalJson({
  schemaVersion: 2,
  repository: identity.repository,
  package: identity.package,
  version: identity.version,
  tag: identity.tag,
  candidateSha: identity.candidateSha,
  payloadId: identity.payloadId || null,
  evidenceDigest: identity.evidenceDigest || null,
  packageIntegrity: identity.packageIntegrity,
  packageSha256: identity.packageSha256 || null,
  packageAssetName: identity.packageAssetName || null,
  bundleSha256: identity.bundleSha256,
  bundleSignatureSha256: identity.bundleSignatureSha256 || null,
  bundleDigestSha256: identity.bundleDigestSha256 || null,
  ...(identity.corpusSeedSha256 ? { corpusSeedSha256: identity.corpusSeedSha256 } : {}),
  ...(identity.generationLedgerSha256 ? { generationLedgerSha256: identity.generationLedgerSha256 } : {}),
})).digest('hex');

export function signReceipt(receipt, privateKey) {
  const unsigned = { ...receipt, receiptDigest: digestReceipt(receipt) };
  return {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64'),
  };
}

export function verifyReceipt(receipt, publicKey) {
  if (!receipt || ![1, 2].includes(receipt.schemaVersion) || !/^[a-f0-9]{64}$/.test(receipt.transactionId || '')) {
    throw new Error('invalid release transaction receipt');
  }
  const { signature, receiptDigest, ...unsigned } = receipt;
  if (digestReceipt(unsigned) !== receiptDigest) throw new Error('release receipt digest mismatch');
  if (!crypto.verify(null, Buffer.from(canonicalJson({ ...unsigned, receiptDigest })), publicKey, Buffer.from(signature || '', 'base64'))) {
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
    if (receipt.transactionId !== expectedId || canonicalJson(receipt.identity) !== canonicalJson(identity)) {
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

const stateReceipt = ({ identity, prior, state, observation = {}, privateKey }) => signReceipt({
  schemaVersion: 2,
  transactionId: transactionIdFor(identity),
  sequence: prior ? prior.sequence + 1 : 0,
  previousReceiptDigest: prior?.receiptDigest || null,
  state,
  identity,
  observation,
  createdAt: new Date().toISOString(),
}, privateKey);

const exact = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label} mismatch: ${actual ?? '(missing)'} != ${expected}`);
};

const npmCandidateExact = (snapshot, identity) => snapshot?.npm?.candidateVersion === identity.version
  && snapshot?.npm?.candidateIntegrity === identity.packageIntegrity
  && snapshot?.npm?.candidateTagVersion === identity.version;
const npmLatestIsB = (snapshot, identity) => snapshot?.npm?.latestVersion === identity.version;
const githubIsB = (snapshot, identity) => snapshot?.github?.sha === identity.candidateSha
  && snapshot?.github?.tag === identity.tag;

/**
 * Pure, total next-action selector. Receipt history is an audit chain, never permission to skip a
 * provider postcondition. Every invocation consumes one fresh cross-provider observation.
 */
export function reduceReleaseState({ lastReceipt, snapshot, identity, prior }) {
  if (!lastReceipt || !snapshot || snapshot.readError) return { action: 'manual', reason: 'provider observation unavailable' };
  const assetsExact = snapshot.github?.assetsExact === true;
  const candidateExact = npmCandidateExact(snapshot, identity);
  const npmB = npmLatestIsB(snapshot, identity);
  const githubB = githubIsB(snapshot, identity);
  const githubPublished = githubB && snapshot.github?.published === true;
  const githubLatest = githubPublished && snapshot.github?.latest === true;

  if (snapshot.npm?.candidateVersion === identity.version && snapshot.npm?.candidateIntegrity
    && snapshot.npm.candidateIntegrity !== identity.packageIntegrity) {
    return { action: 'manual', reason: 'immutable npm candidate bytes mismatch' };
  }
  if (snapshot.github?.tag === identity.tag && snapshot.github?.sha
    && snapshot.github.sha !== identity.candidateSha) {
    return { action: 'manual', reason: 'GitHub tag resolves to competing SHA' };
  }
  if (snapshot.github?.latestTag && snapshot.github.latestTag !== identity.tag
    && snapshot.github.latestTag !== prior?.githubLatest) {
    return { action: 'manual', reason: 'GitHub latest is neither captured A nor candidate B' };
  }
  if (npmB && snapshot.github?.draft === true) return { action: 'compensate-npm' };
  if (npmB && githubLatest) {
    if (lastReceipt.state === 'channels-converged') {
      return githubPublished && assetsExact && candidateExact
        && snapshot.publicReceiptExact && snapshot.publicHostsExact
        ? { action: 'complete' }
        : { action: 'manual', reason: 'terminal public state drifted' };
    }
    return { action: 'finalize' };
  }
  if (!assetsExact) return { action: 'upload-assets' };
  if (!candidateExact) return { action: 'stage-npm' };
  if (!githubPublished) return { action: 'publish-github-nonlatest' };
  if (!npmB) {
    if (snapshot.npm?.latestVersion !== prior?.npmLatest) {
      return { action: 'manual', reason: 'npm latest is neither captured A nor candidate B' };
    }
    return { action: 'promote-npm' };
  }
  if (!githubLatest) return { action: 'make-github-latest' };
  return { action: 'manual', reason: 'unclassified provider state' };
}

export async function pollObservation(read, predicate, {
  maxElapsedMs = 120_000,
  maxAttempts = 12,
  initialDelayMs = 1_000,
  maxDelayMs = 15_000,
  multiplier = 1.8,
  jitter = () => 0,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const started = now();
  let delay = initialDelayMs;
  let last;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts && now() - started <= maxElapsedMs; attempt += 1) {
    try {
      last = await read();
      const elapsedMs = now() - started;
      if (predicate(last) && elapsedMs <= maxElapsedMs) return { value: last, attempt, elapsedMs };
    } catch (error) {
      lastError = error;
    }
    if (attempt === maxAttempts) break;
    const remaining = maxElapsedMs - (now() - started);
    if (remaining <= 0) break;
    const wait = Math.max(0, Math.min(remaining, maxDelayMs, delay + jitter(delay, attempt)));
    await sleep(wait);
    delay = Math.min(maxDelayMs, Math.ceil(delay * multiplier));
  }
  const detail = lastError?.message || canonicalJson(last);
  throw new Error(`visibility deadline exceeded after ${now() - started}ms: ${detail}`);
}

export async function runReleaseTransaction({ identity, assets, adapter, privateKey, publicKey, hostVerifier }) {
  const expectedId = transactionIdFor(identity);
  const discovered = await adapter.discover(identity);
  const competing = discovered.pending?.filter((item) => item.transactionId !== expectedId) || [];
  if (competing.length) throw new Error(`pending release ${competing[0].transactionId} blocks ${expectedId}`);
  if ((discovered.matchingDrafts || []).length > 1) throw new Error('duplicate matching drafts require reconciliation');

  let chain = validateReceiptChain(discovered.receipts || [], identity, publicKey);
  let current = chain.at(-1) || null;
  const draft = discovered.matchingDrafts?.[0] || await adapter.createDraft(identity);
  const append = async (state, observation = {}) => {
    const recoveryCompensation = state === 'compensation-intent' && current
      && !TERMINAL_STATES.has(current.state) && current.state !== 'manual-intervention-required';
    if (current && !ALLOWED_TRANSITIONS[current.state]?.includes(state) && current.state !== state
      && !recoveryCompensation) {
      throw new Error(`illegal release transition ${current.state} -> ${state}`);
    }
    const receipt = stateReceipt({ identity, prior: current, state, observation, privateKey });
    await adapter.appendReceipt(draft, receipt, `${RECEIPT_PREFIX}${String(receipt.sequence).padStart(4, '0')}.json`);
    const observed = await adapter.readReceipt(draft, receipt.sequence);
    verifyReceipt(observed, publicKey);
    exact(observed.receiptDigest, receipt.receiptDigest, 'remote receipt');
    current = receipt;
    return receipt;
  };
  const transition = async (state, observation = {}) => {
    if (current?.state !== state) await append(state, observation);
  };

  if (!current) await append('remote-prepared', {
    draftId: draft.id,
    prior: discovered.prior,
    reconciledLegacyTransactions: discovered.legacySettled || [],
  });
  const prior = chain[0]?.observation?.prior || current.observation?.prior || discovered.prior;
  if (!prior?.npmLatest || !prior?.githubLatest) throw new Error('sequence-zero prior generation is incomplete');

  for (let step = 0; step < 32; step += 1) {
    const snapshot = await adapter.observeSnapshot(identity, draft, {
      forceAssets: current.state === 'finalize-intent' || current.state === 'channels-converged',
    });
    if (current.state === 'channels-converged') {
      const terminal = reduceReleaseState({ lastReceipt: current, snapshot, identity, prior });
      if (terminal.action === 'complete') return current;
      throw new Error(`terminal release drift: ${terminal.reason || terminal.action}`);
    }
    // A process may die after the provider side effect and before its observation receipt. Rebuild
    // that missing receipt from fresh state before asking the reducer for the next command.
    if (current.state === 'npm-stage-intent' && npmCandidateExact(snapshot, identity)) {
      await transition('npm-candidate-staged', { npm: snapshot.npm, recovered: true });
      continue;
    }
    if (current.state === 'remote-materialization-intent' && snapshot.github?.assetsExact
      && npmCandidateExact(snapshot, identity)) {
      await transition('prepared', { recovered: true });
      continue;
    }
    if (current.state === 'github-promote-intent' && githubIsB(snapshot, identity)
      && snapshot.github?.published && !snapshot.github?.latest) {
      await transition('github-promoted-nonlatest', { github: snapshot.github, recovered: true });
      continue;
    }
    if (current.state === 'npm-promote-intent' && npmLatestIsB(snapshot, identity)) {
      await transition('npm-promoted', { npm: snapshot.npm, recovered: true });
      continue;
    }
    if (current.state === 'github-latest-intent' && npmLatestIsB(snapshot, identity)
      && githubIsB(snapshot, identity) && snapshot.github?.latest) {
      await transition('defaults-promoted', { npm: snapshot.npm, github: snapshot.github, recovered: true });
      continue;
    }
    if (current.state === 'compensation-intent' && snapshot.npm?.latestVersion === prior.npmLatest) {
      await transition('compensated', { npm: snapshot.npm, github: snapshot.github, recovered: true });
      throw new Error('npm compensation recovered; resume the same transaction');
    }
    if (current.state === 'finalize-intent' && snapshot.publicReceiptExact && snapshot.publicHostsExact
      && npmCandidateExact(snapshot, identity) && npmLatestIsB(snapshot, identity)
      && githubIsB(snapshot, identity) && snapshot.github?.published && snapshot.github?.latest
      && snapshot.github?.assetsExact) {
      return append('channels-converged', { verdict: 'PASS', recovered: true });
    }
    const decision = reduceReleaseState({ lastReceipt: current, snapshot, identity, prior });
    const stageRecord = {
      event: 'release-stage',
      transactionId: expectedId,
      payloadId: identity.payloadId || null,
      sequence: current.sequence,
      state: current.state,
      action: decision.action,
    };
    console.log(process.env.GITHUB_ACTIONS === 'true'
      ? `::notice title=Release stage ${decision.action}::${JSON.stringify(stageRecord)}`
      : JSON.stringify(stageRecord));
    if (decision.action === 'complete') return current;
    if (decision.action === 'manual') {
      await transition('manual-intervention-required', { reason: decision.reason, snapshot });
      throw new Error(`release requires manual intervention: ${decision.reason}`);
    }
    if (decision.action === 'upload-assets') {
      await transition('asset-upload-intent', { payloadId: identity.payloadId || null });
      await adapter.uploadAssets(draft, assets, identity);
      // FORCE the digests, and never report a read failure as a mismatch (2026-08-07, #77).
      //
      // This read `observeSnapshot(identity, draft)` then `if (!observed.github?.assetsExact)`.
      // Two distinct failures collapsed into one misleading sentence:
      //   · the snapshot's own catch returns `{ readError }`, leaving `github` UNDEFINED — so a
      //     transient API error or an OOM hashing the ~529MB bundle reported "payload mismatch",
      //     which sends you hunting a corruption that never happened. Verified against the real
      //     staged draft: all four assets (zip, .sig, .sha256, .tgz) matched the sealed identity
      //     byte-for-byte, and GitHub's own asset digest agreed — yet this line still threw.
      //   · digests are memoised by `${asset.id}:${asset.size}`, so a value computed BEFORE the
      //     upload finished could satisfy a later check from cache. Immediately after uploading is
      //     exactly when that cache must not be trusted, so this observation forces a re-read.
      const observed = await adapter.observeSnapshot(identity, draft, { forceAssets: true });
      if (observed.readError) {
        throw new Error(`could not read the staged GitHub payload (this is NOT a digest mismatch): ${observed.readError}`);
      }
      if (!observed.github) throw new Error('staged GitHub draft not observable after upload');
      if (!observed.github.assetsExact) throw new Error('staged GitHub payload mismatch');
      await transition('npm-stage-intent', { github: observed.github });
      continue;
    }
    if (decision.action === 'stage-npm') {
      await transition('npm-stage-intent');
      await adapter.stageNpm(identity, assets.packagePath);
      const polled = await pollObservation(
        async () => ({ npm: await adapter.observeNpm(identity) }),
        (value) => npmCandidateExact(value, identity),
        adapter.observationPolicy,
      );
      await transition('npm-candidate-staged', { npm: polled.value.npm, visibility: polled });
      continue;
    }
    if (decision.action === 'publish-github-nonlatest') {
      if (current.state === 'npm-candidate-staged') await transition('remote-materialization-intent');
      if (current.state === 'remote-materialization-intent') {
        const staged = await adapter.materializeStagedAssets(draft, identity);
        try { await adapter.verifyMaterializedPayload?.(staged.assets, identity); } finally { staged.cleanup(); }
        await transition('prepared');
      }
      await transition('github-promote-intent');
      await adapter.publishDraftNonLatest(draft, identity);
      const observed = await adapter.observeSnapshot(identity, draft);
      if (!(githubIsB(observed, identity) && observed.github.published && !observed.github.latest)) {
        throw new Error('GitHub non-latest publication not observed');
      }
      await transition('github-promoted-nonlatest', { github: observed.github });
      continue;
    }
    if (decision.action === 'promote-npm') {
      await transition('npm-promote-intent');
      await adapter.promoteNpm(identity, prior.npmLatest);
      const polled = await pollObservation(
        async () => ({ npm: await adapter.observeNpm(identity) }),
        (value) => npmLatestIsB(value, identity),
        adapter.observationPolicy,
      );
      await transition('npm-promoted', { npm: polled.value.npm, visibility: polled });
      continue;
    }
    if (decision.action === 'make-github-latest') {
      await transition('github-latest-intent');
      await adapter.makeGithubLatest(draft, identity, prior.githubLatest);
      const observed = await adapter.observeSnapshot(identity, draft);
      if (!(npmLatestIsB(observed, identity) && observed.github?.latest && githubIsB(observed, identity))) {
        throw new Error('provider defaults not jointly observed at candidate B');
      }
      await transition('defaults-promoted', { npm: observed.npm, github: observed.github });
      continue;
    }
    if (decision.action === 'compensate-npm') {
      await transition('compensation-intent', { restore: prior.npmLatest });
      await adapter.restoreNpmLatest(prior.npmLatest, identity.version);
      const polled = await pollObservation(
        () => adapter.observeNpm(identity),
        (npm) => npm?.latestVersion === prior.npmLatest,
        adapter.observationPolicy,
      );
      await transition('compensated', { npm: polled.value, github: snapshot.github, visibility: polled });
      throw new Error('npm compensated to captured prior generation; resume the same transaction');
    }
    if (decision.action === 'finalize') {
      if (current.state !== 'defaults-promoted' && current.state !== 'finalize-intent') {
        await transition('defaults-promoted', { npm: snapshot.npm, github: snapshot.github });
      }
      await transition('finalize-intent');
      const final = await adapter.finalize(identity, current, hostVerifier);
      // SAY WHICH CONVERGENCE FAILED, AND WHY (2026-08-07). This threw the bare sentence
      // `final release convergence failed` while `finalize` had already returned exactly the reason
      // — hostVerifierError, hosts.verifier.error, publicationError or sealError — and the throw
      // discarded every one of them. That is the same defect that let `spawnSync ENOBUFS` masquerade
      // as `staged GitHub payload mismatch` for three days: an error that reports its category and
      // withholds its evidence. Publication had ALREADY succeeded on both channels here, so the
      // operator is reading this line while npm and GitHub are correct, with nothing to act on.
      if (final.verdict !== 'PASS') {
        const why = final.hostVerifierError
          || final.hosts?.verifier?.error
          || final.publicationError
          || final.sealError
          || `verdict=${final.verdict ?? '(none)'}`;
        const fixtures = final.hosts?.verifier?.fixtures;
        const detail = fixtures ? ` | fixtures: ${JSON.stringify(fixtures).slice(0, 400)}` : '';
        throw new Error(`final release convergence failed: ${why}${detail}`);
      }
      const reobserved = await adapter.observeSnapshot(identity, draft, { forceAssets: true });
      if (!(npmLatestIsB(reobserved, identity) && reobserved.github?.latest && githubIsB(reobserved, identity))) {
        throw new Error('provider defaults drifted during finalization');
      }
      if (!reobserved.github?.assetsExact || !reobserved.publicReceiptExact || !reobserved.publicHostsExact) {
        throw new Error('public receipt, host, or artifact evidence drifted during finalization');
      }
      return append('channels-converged', final);
    }
  }
  throw new Error('release reducer exceeded its bounded transition count');
}

export async function abortReleaseTransaction({ identity, receipts, reason, authorized, adapter, privateKey, publicKey }) {
  if (!authorized) throw new Error('release abort requires explicit human authorization');
  const chain = validateReceiptChain(receipts, identity, publicKey);
  const current = chain.at(-1);
  if (!current || TERMINAL_STATES.has(current.state)) throw new Error('release transaction is not abortable');
  const snapshot = await adapter.observeSnapshot(identity);
  const prior = chain[0]?.observation?.prior;
  if (!prior || snapshot.npm?.latestVersion === identity.version || snapshot.github?.latest === true
    || snapshot.npm?.latestVersion !== prior.npmLatest || snapshot.github?.latestTag !== prior.githubLatest) {
    throw new Error('release abort cannot prove both defaults at captured prior generation');
  }
  const receipt = stateReceipt({
    identity, prior: current, state: 'aborted',
    observation: { reason, authorized: true, snapshot }, privateKey,
  });
  await adapter.appendReceipt(null, receipt, `${RECEIPT_PREFIX}${String(receipt.sequence).padStart(4, '0')}.json`);
  return receipt;
}
