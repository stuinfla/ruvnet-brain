/** Canonical Ruflo append-only writer for v2; publication never precedes verified candidate bytes. */
import crypto from 'node:crypto';
import { digestCanonical } from './project-progression-contract.mjs';
import { FRONTIER_NAMESPACE, prepareFrontier, readFrontier, validateFrontierRecord } from './project-progression-frontier.mjs';

function fenced(canCommit) {
  if (typeof canCommit !== 'function' || !canCommit()) throw new Error('progression frontier lost replay fencing');
}
function exactRead(store, record) {
  const result = store.readFast(reader => reader.readContent(FRONTIER_NAMESPACE, record.eventKey));
  if (!result.ok || typeof result.value !== 'string') throw new Error('progression frontier exact canonical read unavailable');
  const readback = JSON.parse(result.value);
  validateFrontierRecord(readback, store.resolution.projectIdentity);
  if (digestCanonical(readback) !== digestCanonical(record)) throw new Error('progression frontier exact readback mismatch');
}
const rawDigest = record => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
function append(store, record, canCommit, onPhase, conditions = null) {
  fenced(canCommit);
  const result = store.run(['memory', 'store', '--key', record.eventKey, '--value', JSON.stringify(record),
    '--namespace', FRONTIER_NAMESPACE, '--no-upsert', '--no-embedding', '--require-native', '--append-only',
    ...(conditions ? ['--append-conditions', JSON.stringify(conditions)] : []), '--provenance', 'system_observation',
    '--path', store.resolution.canonicalAgentDbPath]);
  onPhase(`${record.kind}-stored`);
  fenced(canCommit);
  exactRead(store, record);
  onPhase(`${record.kind}-readback-verified`);
  fenced(canCommit);
  return { eventKey: record.eventKey, payloadDigest: record.payloadDigest, readbackDigest: record.payloadDigest,
    alreadyStored: result.status !== 0, committedAt: store.clock() };
}
function publicationFor(candidate) {
  const body = { schema: candidate.schema, schemaVersion: 2, kind: 'publication', sequence: candidate.sequence,
    eventKey: `published-v2-${String(candidate.sequence).padStart(12, '0')}`,
    projectIdentity: candidate.projectIdentity, base: candidate.base,
    candidate: { eventKey: candidate.eventKey, payloadDigest: candidate.payloadDigest },
    previous: candidate.parent?.publication ?? null };
  return { ...body, payloadDigest: digestCanonical(body) };
}

export function captureFrontierCandidate(store, candidate, { canCommit, onPhase = () => {} } = {}) {
  fenced(canCommit);
  if (!store.frontierProviderCapability) {
    const help = store.run(['memory', 'store', '--help']);
    const output = String(help.stdout ?? '');
    if (help.status !== 0 || !['--append-conditions', '--require-native', '--append-only', '--embedding'].every(flag => output.includes(flag))) {
      throw new Error('progression frontier requires a supported native conditional-append Ruflo provider');
    }
    store.frontierProviderCapability = true;
  }
  if (!store.frontierAuthority) throw new Error('progression frontier publication requires canonical authority epoch');
  validateFrontierRecord(candidate, store.resolution.projectIdentity);
  store.requireCaptureConsent({ sourceIdentity: candidate.input.sourceIdentity });
  const publication = publicationFor(candidate);
  const checkAuthority = () => {
    fenced(canCommit);
    const result = store.readFast(reader => readFrontier(reader, store.resolution.projectIdentity));
    if (!result.ok) throw new Error('progression frontier authority read unavailable');
    const current = result.value;
    if (current?.candidate.eventKey === candidate.eventKey) {
      if (current.candidate.payloadDigest !== candidate.payloadDigest) throw new Error('progression frontier publication collision');
      return 'published';
    }
    if ((current?.publication.eventKey ?? null) !== (candidate.parent?.publication.eventKey ?? null)) {
      throw new Error('progression frontier publication lost parent authority');
    }
    // Compare all retained legacy membership immediately before promotion, including genesis.
    const membership = store.readFast(reader => reader.listKeys('project-progression', { maxEntries: 100_000 }));
    if (!membership.ok || membership.value.length !== candidate.base.count
      || digestCanonical(membership.value) !== candidate.base.keysDigest) throw new Error('progression frontier legacy coverage changed');
    return 'parent';
  };
  checkAuthority();
  store.outbox.appendSnapshot(candidate);
  onPhase('candidate-outbox-fsynced');
  fenced(canCommit);
  const receipt = append(store, candidate, canCommit, onPhase);
  checkAuthority();
  onPhase('publication-authority-verified');
  fenced(canCommit);
  const conditions = [
    { namespace: FRONTIER_NAMESPACE, key: candidate.eventKey, sha256: rawDigest(candidate) },
    { namespace: 'project-progression', keysSha256: candidate.base.keysDigest, count: candidate.base.count },
    store.frontierAuthority,
  ];
  if (candidate.parent) {
    const parent = store.readFast(reader => JSON.parse(reader.readContent(FRONTIER_NAMESPACE, candidate.parent.publication.eventKey)));
    if (!parent.ok) throw new Error('progression frontier exact parent unavailable');
    conditions.push({ namespace: FRONTIER_NAMESPACE, key: parent.value.eventKey, sha256: rawDigest(parent.value), latestPrefix: 'published-v2-' });
  } else conditions.push({ namespace: FRONTIER_NAMESPACE, absent: true, latestPrefix: 'published-v2-' });
  append(store, publication, canCommit, onPhase, conditions);
  checkAuthority();
  store.outbox.markCommitted(receipt);
  onPhase('publication-committed');
  return { snapshot: candidate, receipt };
}

export function captureVersionedProgression(store, snapshot, options) {
  // Source prototype only. No activation through unconditional global Ruflo writes: an official
  // native conditional-append provider and canonical authority epoch are mandatory prerequisites.
  if (!store.frontierAuthority) return null;
  const plan = store.readFast(reader => prepareFrontier(reader, snapshot, store.resolution.projectIdentity));
  if (!plan.ok) throw new Error('progression frontier preparation unavailable');
  if (!plan.value) return null;
  return captureFrontierCandidate(store, plan.value.candidate, options);
}
