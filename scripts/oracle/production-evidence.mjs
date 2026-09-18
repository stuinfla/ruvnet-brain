import { digest, canonicalJson as canonical } from '../coverage-integrity.mjs';
/** Trusted runner attestation; model-authored verdicts alone are diagnostic. */
import crypto from 'node:crypto';

export const MAX_UNIT_CHARS = 6000;
const keyDigest = key => crypto.createHash('sha256').update((key.type === 'public' ? key : crypto.createPublicKey(key)).export({ type: 'spki', format: 'der' })).digest('hex');
const payload = labels => { const { attestation, ...body } = labels; return body; };

export function canonicalModel(host, model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const value = model.trim();
  if (host === 'claude' && value === 'claude-fable-5-1') return value;
  if (host === 'codex' && value === 'gpt-6-astra') return value;
  return value;
}

export function attestProduction(labels, privateKey) {
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('oracle attestation requires Ed25519');
  const body = { kind: 'oracle-production-attestation', schemaVersion: 1,
    labelsDigest: digest(payload(labels)),
    keyId: keyDigest(key) };
  return { ...body, signature: crypto.sign(null, Buffer.from(canonical(body)), key).toString('base64') };
}

export function verifyProductionEvidence(labels, trustedPublicKey) {
  try {
    if (!trustedPublicKey) throw new Error('trusted production public key is missing');
    const key = trustedPublicKey?.type === 'public' ? trustedPublicKey : crypto.createPublicKey(trustedPublicKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('oracle attestation requires Ed25519');
    const evidence = labels.attestation;
    if (!evidence || evidence.kind !== 'oracle-production-attestation' || evidence.schemaVersion !== 1
      || evidence.labelsDigest !== digest(payload(labels))
      || evidence.keyId !== keyDigest(key)) throw new Error('production attestation identity mismatch');
    const { signature, ...body } = evidence;
    if (!crypto.verify(null, Buffer.from(canonical(body)), key, Buffer.from(signature, 'base64'))) throw new Error('production signature mismatch');
    if (labels.kind !== 'oracle-labels' || labels.schemaVersion !== 1 || labels.diagnosticLegacy
      || labels.suspended !== null || labels.productionComplete !== true
      || !['claude', 'codex'].includes(labels.roles?.generator) || !['claude', 'codex'].includes(labels.roles?.judge)
      || labels.roles.generator === labels.roles.judge) throw new Error('production roles or completion are invalid');
    const calls = Array.isArray(labels.calls) ? labels.calls : [];
    for (const stage of ['generator', 'judge']) {
      const host = labels.roles[stage];
      if (!labels.authentication?.[host]?.eligible || labels.producer?.[stage]?.host !== host
        || !calls.some(call => call.stage === stage && call.host === host && call.ok && call.status === 0 && !call.timedOut
          && /^[a-f0-9]{64}$/.test(call.requestDigest || '') && /^[a-f0-9]{64}$/.test(call.transportDigest || '')
          && Array.isArray(call.observedModels) && call.observedModels.length > 0
          && call.observedModels.every(model => canonicalModel(host, model) === canonicalModel(host, labels.producer[stage].requestedModel)))) {
        throw new Error(`authenticated ${stage} execution is missing`);
      }
    }
    if (!labels.labels?.length) throw new Error('production labels are empty');
    if (calls.some(call => !call.callId) || new Set(calls.map(call => call.callId)).size !== calls.length) throw new Error('call ids are missing or duplicated');
    const callById = new Map(calls.map(call => [call.callId, call]));
    const validCall = (id, stage, host) => {
      const call = callById.get(id);
      const requested = labels.producer[stage]?.requestedModel;
      return call && call.stage === stage && call.host === host && call.ok && call.status === 0 && !call.timedOut
        && !call.error && !(call.hostErrors?.length) && call.requestedModel === requested
        && Array.isArray(call.observedModels) && call.observedModels.length > 0
        && call.observedModels.every(model => canonicalModel(host, model) === canonicalModel(host, requested))
        && /^[a-f0-9]{64}$/.test(call.requestDigest || '') && /^[a-f0-9]{64}$/.test(call.transportDigest || '');
    };
    for (const label of labels.labels) {
      if (label.accountedMiss) {
        if (!['unit_exceeds_producer_context', 'judge_verdict_no'].includes(label.missReason)) throw new Error('unrecognized accounted miss');
        if (label.missReason === 'judge_verdict_no' && (!validCall(label.producerCallId, 'generator', labels.roles.generator)
          || label.judge?.host !== labels.roles.judge
          || canonicalModel(labels.roles.judge, label.judge?.model) !== canonicalModel(labels.roles.judge, labels.producer.judge.requestedModel)
          || !validCall(label.judge?.callId, 'judge', labels.roles.judge)
          || ['direct', 'paraphrase', 'equivalent'].some(side => !['yes', 'no'].includes(label.judge?.[side]?.answers))
          || !['direct', 'paraphrase', 'equivalent'].some(side => label.judge?.[side]?.answers === 'no')))
          throw new Error('judge accounted miss is not linked to a successful negative verdict');
        continue;
      }
      if (label.judge?.host !== labels.roles.judge
        || canonicalModel(labels.roles.judge, label.judge?.model) !== canonicalModel(labels.roles.judge, labels.producer.judge.requestedModel)) throw new Error('judge identity differs from producer');
      if (!validCall(label.producerCallId, 'generator', labels.roles.generator)
        || !validCall(label.judge?.callId, 'judge', labels.roles.judge)
        || !['direct', 'paraphrase', 'equivalent'].every(side => label.judge?.[side]?.answers === 'yes')) throw new Error('label is not linked to a successful call');
    }
    return { verified: true, labelsDigest: evidence.labelsDigest, keyId: evidence.keyId };
  } catch (error) { return { verified: false, reason: error.message }; }
}

/** Portable source proof identity; snapshotDir locates verified bytes but is not their identity. */
export function sourceEvidenceDigest(evidence) {
  const portable = Object.fromEntries(Object.entries(evidence).map(([id, proof]) => {
    const { snapshotDir: _localPath, ...identity } = proof;
    return [id, identity];
  }));
  return digest(portable);
}
