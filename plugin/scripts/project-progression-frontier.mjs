/** Version 2: verified current state, immutable history references, explicit deferred archive audit. */
import { createProgressionSnapshot, digestCanonical, redactProgression, restoreProjectProgression,
  validateProgressionSnapshot } from './project-progression-contract.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';

export const FRONTIER_NAMESPACE = 'project-progression-v2';
export const LEGACY_NAMESPACE = 'project-progression';
export const FRONTIER_MIGRATION_ROWS = 64;
const SCHEMA = 'ruvnet-brain.project-progression-frontier';
const HISTORY_FIELDS = ['commands', 'observations'];
const PREFIX = { candidate: 'frontier-v2', publication: 'published-v2' };
const MAX_LIVE_BYTES = 32 * 1024;

const identity = (value) => digestCanonical(value);
const seal = (body) => ({ ...body, payloadDigest: identity(body) });
function assert(condition, message) { if (!condition) throw new Error(`progression frontier: ${message}`); }
function rowKey(kind, sequence, originalKey) {
  return `${PREFIX[kind]}-${String(sequence).padStart(12, '0')}${kind === 'candidate' ? `-${identity(originalKey)}` : ''}`;
}
function keyParts(key) {
  const match = /^(frontier-v2|published-v2)-(\d{12})(?:-([a-f0-9]{64}))?$/.exec(key);
  assert(match && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0, 'malformed v2 key');
  return { kind: match[1] === PREFIX.candidate ? 'candidate' : 'publication', sequence: Number(match[2]), suffix: match[3] };
}
function reference(row) { return { eventKey: row.eventKey, payloadDigest: row.payloadDigest }; }
function readRow(reader, key, projectIdentity) {
  const text = reader.readContent(FRONTIER_NAMESPACE, key);
  assert(typeof text === 'string', `missing referenced row ${key}`);
  let row;
  try { row = JSON.parse(text); } catch { throw new Error('progression frontier: non-JSON row'); }
  validateFrontierRecord(row, projectIdentity);
  assert(row.eventKey === key, 'exact key mismatch');
  return row;
}

export function validateFrontierRecord(row, projectIdentity) {
  assert(row && typeof row === 'object' && !Array.isArray(row), 'record is not an object');
  const { payloadDigest, ...body } = row;
  assert(row.schema === SCHEMA && row.schemaVersion === 2, 'unsupported reader contract');
  assert(identity(body) === payloadDigest, 'body digest mismatch');
  assert(identity(row.projectIdentity) === identity(projectIdentity), 'foreign project');
  assert(identity(redactProgression(body).value) === identity(body), 'unredacted record');
  const parts = keyParts(row.eventKey);
  assert(parts.kind === row.kind && parts.sequence === row.sequence, 'key/sequence mismatch');
  assert(row.base && Number.isSafeInteger(row.base.count) && row.base.count >= 0
    && /^[a-f0-9]{64}$/.test(row.base.keysDigest) && /^[a-f0-9]{64}$/.test(row.base.bodiesDigest), 'invalid base coverage');
  if (row.kind === 'publication') {
    assert(row.eventKey === rowKey('publication', row.sequence), 'publication must occupy its unique sequence slot');
    assert(keyParts(row.candidate?.eventKey).kind === 'candidate' && keyParts(row.candidate.eventKey).sequence === row.sequence
      && /^[a-f0-9]{64}$/.test(row.candidate.payloadDigest), 'publication does not bind candidate');
    assert(row.sequence === 1 ? row.previous === null : typeof row.previous?.eventKey === 'string', 'missing publication parent');
    return;
  }
  assert(row.kind === 'candidate' && typeof row.originalEventKey === 'string'
    && row.eventKey === rowKey('candidate', row.sequence, row.originalEventKey), 'invalid candidate identity');
  assert(row.sequence === 1 ? row.parent === null : row.parent?.publication && row.parent?.candidate, 'invalid parent reference');
  assert(row.history && HISTORY_FIELDS.every(field => Array.isArray(row.history[field]?.values)
    && ['append', 'replace'].includes(row.history[field]?.operation)), 'invalid historical delta');
  // Reuse the v1 state/identity/redaction contract, without materializing historical bodies.
  const snapshot = createProgressionSnapshot({ ...row.input, projectIdentity, sequence: row.sequence,
    completeProjectState: { ...row.liveState, commands: [], observations: [] } });
  assert(validateProgressionSnapshot(snapshot, { expectedProjectIdentity: projectIdentity }).ok, 'invalid live state');
  assert(Buffer.byteLength(JSON.stringify(row.liveState)) <= MAX_LIVE_BYTES, 'mandatory live state exceeds its bound');
}

function readLegacy(reader, keys, projectIdentity) {
  return keys.map(key => {
    const text = reader.readContent(LEGACY_NAMESPACE, key);
    assert(typeof text === 'string', 'missing legacy body');
    const row = JSON.parse(text);
    assert(row.eventKey === key && validateProgressionSnapshot(row, { expectedProjectIdentity: projectIdentity }).ok,
      'invalid historical legacy body');
    return row;
  });
}
function baseCoverage(keys, snapshots) {
  return { count: keys.length, keysDigest: identity(keys),
    bodiesDigest: identity(snapshots.map(row => reference(row)).sort((a, b) => a.eventKey.localeCompare(b.eventKey))) };
}
function checkMembership(reader, base) {
  const keys = reader.listKeys(LEGACY_NAMESPACE, { maxEntries: 100_000 });
  assert(keys.length === base.count && identity(keys) === base.keysDigest, 'legacy membership changed after migration');
  return keys;
}

/** One canonical read transaction; keys establish membership, old content is audited only on request. */
export function readFrontier(reader, projectIdentity, { fullAudit = false } = {}) {
  const keys = reader.listKeys(FRONTIER_NAMESPACE, { maxEntries: 100_000 });
  if (!keys.length) return null;
  const publications = new Map();
  const candidates = new Set();
  for (const key of keys) {
    const part = keyParts(key);
    if (part.kind === 'candidate') candidates.add(key);
    else {
      assert(!publications.has(part.sequence), 'concurrent published heads');
      publications.set(part.sequence, key);
    }
  }
  // An exact-readback candidate without publication has no authority; a crashed writer may retry it.
  if (!publications.size) return null;
  const sequences = [...publications.keys()].sort((a, b) => a - b);
  assert(sequences.every((value, index) => value === index + 1), 'missing published ancestry');
  let previousPublication = null;
  let publication;
  for (const sequence of sequences) {
    publication = readRow(reader, publications.get(sequence), projectIdentity);
    assert(identity(publication.previous) === identity(previousPublication ? reference(previousPublication) : null), 'publication header chain digest mismatch');
    assert(candidates.has(publication.candidate.eventKey), 'published candidate absent');
    previousPublication = publication;
  }
  assert(candidates.has(publication.candidate.eventKey), 'published candidate absent');
  const candidate = readRow(reader, publication.candidate.eventKey, projectIdentity);
  assert(candidate.payloadDigest === publication.candidate.payloadDigest
    && identity(candidate.base) === identity(publication.base), 'publication/candidate mismatch');
  if (candidate.sequence > 1) {
    assert(candidate.parent.publication.eventKey === publications.get(candidate.sequence - 1), 'parent publication coverage mismatch');
    const parentPublication = readRow(reader, publications.get(candidate.sequence - 1), projectIdentity);
    assert(identity(candidate.parent.publication) === identity(reference(parentPublication))
      && identity(candidate.parent.candidate) === identity(parentPublication.candidate), 'current parent digest mismatch');
  }
  const legacyKeys = checkMembership(reader, candidate.base);
  const state = { ...structuredClone(candidate.liveState), commands: [], observations: [],
    historyReferences: { schemaVersion: 2, ...reference(candidate), publication: reference(publication),
      historicalContentAudit: fullAudit ? 'verified' : 'deferred' } };
  const result = { candidate, publication, heads: [candidate.eventKey], state,
    sequence: candidate.sequence, structurallyEnumerated: keys.length + legacyKeys.length,
    historicalContentAudit: fullAudit ? 'verified' : 'deferred', unpublishedCandidates: candidates.size - publications.size };
  if (fullAudit) result.state = auditFrontierHistory(reader, projectIdentity, result, publications, legacyKeys);
  return result;
}

export function loadFrontier(dbPath, projectIdentity, options) {
  const result = withProgressionReader(dbPath, reader => readFrontier(reader, projectIdentity, options), { consistentSnapshot: true });
  assert(result.ok, `authoritative v2 reader unavailable (${result.reason})`);
  return result.value;
}

function auditFrontierHistory(reader, projectIdentity, current, publications, legacyKeys) {
  const legacy = readLegacy(reader, legacyKeys, projectIdentity);
  assert(identity(baseCoverage(legacyKeys, legacy)) === identity(current.candidate.base), 'historical coverage digest changed');
  const restored = restoreProjectProgression(legacy, { expectedProjectIdentity: projectIdentity });
  assert(!legacy.length || restored.ok, 'historical legacy ancestry incoherent');
  let histories = Object.fromEntries(HISTORY_FIELDS.map(field => [field, restored.state?.[field] ?? []]));
  let previous = null;
  for (let sequence = 1; sequence <= current.sequence; sequence++) {
    const publication = readRow(reader, publications.get(sequence), projectIdentity);
    const candidate = readRow(reader, publication.candidate.eventKey, projectIdentity);
    assert(candidate.payloadDigest === publication.candidate.payloadDigest && identity(candidate.base) === identity(current.candidate.base), 'historical publication mismatch');
    assert(sequence === 1 ? candidate.parent === null : identity(candidate.parent) === identity(previous), 'historical parent digest mismatch');
    for (const field of HISTORY_FIELDS) {
      const delta = candidate.history[field];
      assert(delta.operation === 'replace' || Array.isArray(histories[field]), `conflicting ${field} requires explicit resolution`);
      histories[field] = delta.operation === 'replace' ? delta.values : [...histories[field], ...delta.values];
    }
    previous = { publication: reference(publication), candidate: reference(candidate) };
  }
  const state = { ...structuredClone(current.candidate.liveState), ...histories };
  return state;
}

/** Build an immutable current-state candidate. Migration audits ALL v1 bodies once, without deleting any. */
export function prepareFrontier(reader, snapshot, projectIdentity) {
  const current = readFrontier(reader, projectIdentity);
  const legacyKeys = reader.listKeys(LEGACY_NAMESPACE, { maxEntries: 100_000 });
  if (!current && legacyKeys.length < FRONTIER_MIGRATION_ROWS) return null;
  let base = current?.candidate.base;
  let previousState = current?.state;
  let expectedHeads = current?.heads;
  if (!current) {
    const legacy = readLegacy(reader, legacyKeys, projectIdentity);
    const restored = restoreProjectProgression(legacy, { expectedProjectIdentity: projectIdentity });
    assert(restored.ok, 'migration needs coherent complete legacy ancestry');
    base = baseCoverage(legacyKeys, legacy);
    previousState = restored.state;
    expectedHeads = restored.heads;
  }
  assert(identity([...snapshot.parentEventKeys].sort()) === identity([...expectedHeads].sort()), 'capture was built from stale heads');
  const liveState = structuredClone(snapshot.completeProjectState);
  const history = {};
  for (const field of HISTORY_FIELDS) {
    let values = liveState[field] ?? [];
    assert(Array.isArray(values), `conflicting ${field} cannot be silently discarded`);
    let operation = liveState.historyUpdates?.[field] ?? 'append';
    if (!current && operation !== 'replace') {
      const prior = previousState[field] ?? [];
      if (!Array.isArray(prior)) operation = 'replace';
      else {
        assert(values.length >= prior.length && identity(values.slice(0, prior.length)) === identity(prior), 'migration history differs from verified legacy state');
        values = values.slice(prior.length);
      }
    }
    if (current) assert(liveState.historyReferences?.eventKey === current.candidate.eventKey
      && liveState.historyReferences?.payloadDigest === current.candidate.payloadDigest, 'missing exact current history reference');
    history[field] = { operation, values };
    delete liveState[field];
  }
  delete liveState.historyReferences;
  delete liveState.historyUpdates;
  const sequence = (current?.sequence ?? 0) + 1;
  const { completeProjectState: _state, payloadDigest: _digest, eventKey: _key, schema: _schema,
    schemaVersion: _version, redactions: _redactions, ...input } = snapshot;
  const candidate = seal({ schema: SCHEMA, schemaVersion: 2, kind: 'candidate', sequence,
    eventKey: rowKey('candidate', sequence, snapshot.eventKey), originalEventKey: snapshot.eventKey,
    projectIdentity, base, input, liveState, history,
    parent: current ? { publication: reference(current.publication), candidate: reference(current.candidate) } : null });
  validateFrontierRecord(candidate, projectIdentity);
  const publication = seal({ schema: SCHEMA, schemaVersion: 2, kind: 'publication', sequence,
    eventKey: rowKey('publication', sequence, snapshot.eventKey), projectIdentity, base, candidate: reference(candidate),
    previous: current ? reference(current.publication) : null });
  validateFrontierRecord(publication, projectIdentity);
  return { candidate, publication };
}

export function frontierResumePayload(current, projectIdentity, pendingReplay) {
  const state = structuredClone(current.state);
  for (const field of HISTORY_FIELDS) state[field] = { kind: 'historical-reference', field,
    eventKey: current.candidate.eventKey, payloadDigest: current.candidate.payloadDigest,
    namespace: FRONTIER_NAMESPACE, historicalContentAudit: 'deferred' };
  return { schema: 'ruvnet-brain.project-resume', schemaVersion: 2, projectIdentity,
    heads: current.heads, state, evidence: { readPath: 'node:sqlite', pendingReplay,
      historicalContentAudit: 'deferred', structurallyEnumerated: current.structurallyEnumerated,
      unpublishedCandidates: current.unpublishedCandidates } };
}
