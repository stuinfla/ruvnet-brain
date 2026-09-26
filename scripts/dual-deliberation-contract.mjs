// One response-schema owner for native Dual reviews and their strict validation.
import { canonicalJson, digest } from './coverage-integrity.mjs';
const correctionIdPattern = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const correctionFields = ['id', 'text'];
const resolutionFields = ['id', 'status', 'reason'];

export const STAGE_SCHEMAS = Object.freeze({
  proposal: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'proposal'], optional: ['task', 'plan', 'adr', 'ddd', 'qe', 'artifact', 'host'] },
  critique: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'findings'], optional: ['corrections', 'risks', 'verdict', 'host'] },
  synthesis: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'artifact'], optional: ['adr', 'ddd', 'qe', 'unresolved', 'host'] },
  revise: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'artifact'], optional: ['adr', 'ddd', 'qe', 'unresolved', 'host', 'resolutions'] },
  verify: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'verdict', 'corrections'], optional: ['findings', 'resolutions'] },
  reverify: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'verdict', 'corrections'], optional: ['findings', 'resolutions'] },
  review: { required: ['schemaVersion', 'stage', 'artifactSha256', 'contentDigest', 'verdict', 'score', 'findings', 'deductions', 'untested', 'reviewedAt', 'retrievalOracleReview'], optional: ['host', 'execution'] },
});

export function nativeStageJsonSchema(stage) {
  const contract = STAGE_SCHEMAS[stage];
  if (!contract) throw new Error(`${stage} response has an unknown stage`);
  const verifies = ['verify', 'reverify'].includes(stage);
  const adapterFields = new Set(verifies ? [] : stage === 'review'
    ? ['contentDigest', 'execution'] : ['artifactSha256', 'contentDigest']);
  const strings = names => Object.fromEntries(names.map(name => [name, { type: 'string', minLength: 1, pattern: '\\S' }]));
  const properties = { schemaVersion: { const: 1 }, stage: { const: stage },
      artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, contentDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      proposal: { type: 'object', minProperties: 1 }, artifact: { type: 'object' },
      verdict: verifies ? { enum: ['accept', 'changes', 'block'] } : stage === 'review' ? { enum: ['PASS', 'FAIL'] } : {},
      findings: { type: 'array', ...(stage === 'critique' ? { minItems: 1,
        items: { anyOf: [{ type: 'string', pattern: '\\S' }, { type: 'object', minProperties: 1 }] } } : {}) },
      score: { type: 'integer' }, deductions: { type: 'array' }, untested: { type: 'array' },
      reviewedAt: { type: 'string' }, retrievalOracleReview: { type: 'object' },
      corrections: { type: 'array', items: { type: 'object', additionalProperties: false, required: correctionFields,
        properties: { ...strings(correctionFields), id: { type: 'string', pattern: correctionIdPattern } } } },
      resolutions: { type: 'array', items: { type: 'object', additionalProperties: false, required: resolutionFields,
        properties: { ...strings(['id', 'reason']), status: { enum: ['resolved', 'rejected'] } } } } };
  return { type: 'object', additionalProperties: false,
    required: contract.required.filter(name => !adapterFields.has(name)),
    properties: Object.fromEntries([...contract.required, ...contract.optional]
      .filter(name => !adapterFields.has(name)).map(name => [name, properties[name] ?? {}])) };
}

// Both clients pass this admission boundary, regardless of decoder support.
// Reject model-authored adapter fields before binding can replace their values.
export function validateNativeStageValue(stage, value) {
  const schema = nativeStageJsonSchema(stage);
  if (!record(value)) throw new Error(`${stage} native response is not an object`);
  const unknown = Object.keys(value).find(key => !Object.hasOwn(schema.properties, key));
  if (unknown) throw new Error(`${stage} native response has forbidden field: ${unknown}`);
  const missing = schema.required.find(key => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${stage} native response is missing ${missing}`);
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, key) || !field.type) continue;
    const item = value[key];
    const matches = field.type === 'object' ? record(item) : field.type === 'array' ? Array.isArray(item)
      : field.type === 'integer' ? Number.isInteger(item) : typeof item === field.type;
    if (!matches) throw new Error(`${stage} native response has invalid ${key} type`);
  }
  return validateStageValue(stage, bindStageContent(stage, value));
}

// Fresh content is hashed by the adapter after receipt. A verifier instead names
// an existing subject; never replace its supplied identities to make it agree.
// These identities bind primary content only. Full stage fields, corrections and
// ADR/DDD metadata are separately bound by native evidence and causal trace replay.
export function bindStageContent(stage, value) {
  if (stage === 'review' && value && Array.isArray(value.findings)) return { ...value, contentDigest:digest(value.findings) };
  if (!['proposal', 'critique', 'synthesis', 'revise'].includes(stage)) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const content = stage === 'proposal' ? value.proposal : stage === 'critique' ? value.findings : value.artifact;
  if (content === undefined) return value;
  return { ...value, contentDigest: digest(content),
    artifactSha256: digest({ schemaVersion: 1, kind: 'dual-planning-artifact', stage, content }) };
}

export function validateStageValue(stage, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.text !== undefined) {
    throw new Error(`${stage} response is not a structured stage object`);
  }
  const schema = STAGE_SCHEMAS[stage];
  if (!schema) throw new Error(`${stage} response has an unknown stage`);
  const allowed = new Set([...schema.required, ...schema.optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${stage} response has unknown field: ${unknown.sort()[0]}`);
  const missing = schema.required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${stage} response is missing ${missing}`);
  if (value.schemaVersion !== 1 || value.stage !== stage || !/^[a-f0-9]{64}$/.test(String(value.artifactSha256))
    || !/^[a-f0-9]{64}$/.test(String(value.contentDigest))) {
    throw new Error(`${stage} response identity is invalid`);
  }
  if (stage === 'proposal' && (!value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal)
    || Object.keys(value.proposal).length === 0)) {
    throw new Error('proposal response is not substantive');
  }
  if (stage === 'critique' && (!Array.isArray(value.findings) || value.findings.length === 0
    || value.findings.some(finding => !nonblank(finding)
      && !(record(finding) && Object.keys(finding).length > 0)))) {
    throw new Error('critique findings are not substantive');
  }
  if (stage === 'critique' && value.corrections !== undefined) {
    if (!validCorrections(value.corrections)) {
      throw new Error('critique corrections are invalid');
    }
  }
  if (['synthesis', 'revise'].includes(stage)
    && (!value.artifact || typeof value.artifact !== 'object' || Array.isArray(value.artifact))) {
    throw new Error(`${stage} artifact is not substantive`);
  }
  if (stage === 'review' && (!['PASS', 'FAIL'].includes(value.verdict) || !Number.isInteger(value.score)
    || !Array.isArray(value.findings) || !Array.isArray(value.deductions) || !Array.isArray(value.untested)
    || typeof value.reviewedAt !== 'string' || !value.retrievalOracleReview || typeof value.retrievalOracleReview !== 'object')) {
    throw new Error('review response is not substantive');
  }
  const boundContent = ['verify', 'reverify'].includes(stage) ? undefined : value.proposal ?? value.findings ?? value.artifact;
  if (boundContent !== undefined && digest(boundContent) !== value.contentDigest) {
    throw new Error(`${stage} response artifact digest differs from substantive content`);
  }
  if (['verify', 'reverify'].includes(stage)) {
    if (!['accept', 'changes', 'block'].includes(value.verdict)) throw new Error(`${stage} verdict is invalid`);
    if (!validCorrections(value.corrections)) {
      throw new Error(`${stage} corrections are invalid`);
    }
    if (value.verdict === 'accept' && value.corrections.length) throw new Error(`${stage} acceptance has unresolved corrections`);
    if (value.verdict === 'changes' && value.corrections.length === 0) throw new Error(`${stage} changes require corrections`);
  }
  if (value.resolutions !== undefined && (!Array.isArray(value.resolutions) || value.resolutions.some(row => !record(row)
      || Object.keys(row).some(key => !resolutionFields.includes(key)) || !nonblank(row.id)
      || !['resolved', 'rejected'].includes(row.status) || !nonblank(row.reason)))) {
    throw new Error(`${stage} correction resolutions are invalid`);
  }
  return value;
}

function validCorrections(rows) {
  return Array.isArray(rows) && rows.every(row => record(row)
    && Object.keys(row).every(key => correctionFields.includes(key))
    && typeof row.id === 'string' && new RegExp(correctionIdPattern).test(row.id) && nonblank(row.text));
}

// Top subscription models verified on the native hosts on 2026-09-10.
// Keep these explicit: an implicit host default silently weakens the dual review.
export const TOP_SUBSCRIPTION_MODELS = Object.freeze({
  'claude-code': 'claude-fable-5-1',
  codex: 'gpt-6-astra',
});

export function correctionLedgerFromCritiques(critiques) {
  const rows = Object.keys(critiques).sort().flatMap(host => (critiques[host].corrections || []).map((correction) => ({
    id: correction.id, text: correction.text, status: 'open', source: critiques[host].host || 'critique',
  })));
  const byId = new Map();
  for (const row of rows) {
    if (byId.has(row.id) && byId.get(row.id).text !== row.text) throw new Error('critique correction IDs conflict');
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

function assertCorrectionResolutions(ledger, resolutions, originalArtifact, revisedArtifact, requireChange) {
  if (!ledger.length) return;
  if (requireChange && canonicalJson(originalArtifact) === canonicalJson(revisedArtifact)) throw new Error('corrections require a changed artifact');
  if (!Array.isArray(resolutions)) throw new Error('correction resolution ledger is missing');
  const byId = new Map(resolutions.map((row) => [row?.id, row]));
  if (byId.size !== resolutions.length || resolutions.some(row=>!ledger.some(correction=>correction.id===row?.id))) {
    throw new Error('correction resolutions are duplicated or unknown');
  }
  for (const correction of ledger) {
    const row = byId.get(correction.id);
    if (!row || !['resolved', 'rejected'].includes(row.status) || typeof row.reason !== 'string' || !row.reason.trim()) {
      throw new Error(`correction ${correction.id} lacks a reasoned verifier disposition`);
    }
  }
}

export function mergeVerifierCorrections(ledger, verification, verifier) {
  for (const correction of verification.corrections) {
    const existing = ledger.find(row => row.id === correction.id);
    if (existing && existing.text !== correction.text) throw new Error('verification correction IDs conflict');
    if (!existing) ledger.push({...correction,status:'open',source:verifier});
  }
  return ledger;
}

// One causal/correction replay shared by live deliberation and persisted admission.
// Receipt flags never repair an incomplete debate or authorize unresolved corrections.
export function validateDeliberationTrace(records, {roles, brief} = {}) {
  const hosts = ['codex','claude-code'];
  if (!roles || roles.scribe === roles.verifier || !hosts.includes(roles.scribe)
    || !hosts.includes(roles.verifier)) throw new Error('invalid native Dual roles');
  const stages = new Map();
  const same = (actual, expected, message) => {
    if (actual === undefined || digest(actual) !== digest(expected)) throw new Error(message);
  };
  for (const row of records) {
    const key = `${row.host}:${row.stage}`;
    if (!hosts.includes(row.host) || stages.has(key)) throw new Error('duplicate or unknown native Dual stage');
    validateStageValue(row.stage,row.value);
    if (brief) {
      same(row.payload?.implementation?.brief, brief, 'native stage reviewed another brief');
      same(row.payload.implementation.briefDigest,digest(brief),'native stage brief digest differs');
    }
    stages.set(key,row);
  }
  const used = new Set();
  const get = (host,stage) => {
    const key = `${host}:${stage}`, row = stages.get(key);
    if (!row) throw new Error(`native Dual ${key} is missing`);
    used.add(key); return row;
  };
  const task = get(hosts[0],'proposal').payload?.task;
  if (typeof task !== 'string' || !task.trim()) throw new Error('native task is missing');
  for (const row of records) same(row.payload?.task,task,'native stages reviewed different tasks');
  const proposals = Object.fromEntries(hosts.map(host=>[host,get(host,'proposal').value]));
  const critiques = Object.fromEntries(hosts.map(host=> {
    const row = get(host,'critique');
    same(row.payload.proposal,proposals[hosts.find(other=>other!==host)],'native cross-critique subject differs');
    return [host,row.value];
  }));
  const ledger = correctionLedgerFromCritiques(critiques);
  const synthesis = get(roles.scribe,'synthesis');
  for (const [key,expected] of Object.entries({proposals,critiques,correctionLedger:ledger})) {
    same(synthesis.payload[key],expected,`native synthesis ${key} differs`);
  }
  const verify = (stage,artifact) => {
    const row = get(roles.verifier,stage);
    same(row.payload.artifact,artifact,'native verifier subject differs');
    same(row.payload.correctionLedger,ledger,'native verifier correction ledger differs');
    if (row.value.contentDigest !== artifact.contentDigest || row.value.artifactSha256 !== artifact.artifactSha256) {
      throw new Error('native verification subject digest differs');
    }
    return row;
  };
  let artifact = synthesis.value, verification = verify('verify',artifact);
  const revised = verification.value.verdict === 'changes';
  if (revised) {
    mergeVerifierCorrections(ledger,verification.value,roles.verifier);
    const revision = get(roles.scribe,'revise');
    same(revision.payload.artifact,artifact,'native revision subject differs');
    same(revision.payload.corrections,verification.value.corrections,'native revision corrections differ');
    same(revision.payload.correctionLedger,ledger,'native revision ledger differs');
    artifact = revision.value;
    verification = verify('reverify',artifact);
    same(verification.payload.resolutions,revision.value.resolutions ?? [],'native revision resolutions differ');
  }
  if (used.size !== stages.size) throw new Error('native evidence has unrelated stages');
  if (verification.value.verdict !== 'accept') throw new Error('native verification has not accepted');
  assertCorrectionResolutions(ledger,verification.value.resolutions,synthesis.value.artifact,artifact.artifact,revised);
  return {artifact,verification:verification.value};
}
