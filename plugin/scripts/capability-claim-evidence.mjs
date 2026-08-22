#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const HOSTS = Object.freeze(['claude', 'codex']);
const OS_LANES = Object.freeze(['linux', 'macos', 'windows']);
const CLAIM_CLASSES = Object.freeze(['installation', 'behavior', 'currentVersion', 'latestVersion', 'health']);
const VERSION = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;
const RUVNET_TOOL = '(?:Ruflo|Claude Flow|Agentic Flow|Agentic QE|RuVector|Agent Browser|Ruv Swarm|AgentDB|RuLake|RuvNet Brain)';
const MAX_AGE_MS = 10 * 60_000;
const MAX_LEDGER_BYTES = 1024 * 1024;
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'can', 'could', 'does', 'for', 'has', 'have',
  'is', 'it', 'not', 'of', 'or', 'the', 'this', 'to', 'version', 'with', 'would']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const digest = (value) => sha256(canonicalJson(value));
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').replace(/[.!?]+$/g, '').trim().toLowerCase();
const tokens = (value) => String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  .match(/[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]/g) || [];
const significant = (value) => tokens(value).filter((token) => !STOPWORDS.has(token));
const overlap = (left, right) => {
  const rightSet = new Set(significant(right));
  return significant(left).filter((token) => rightSet.has(token));
};
const safeMessage = (message) => String(message || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`\n]*`/g, ' ')
  .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ')
  .replace(/^\s*>.*$/gm, ' ');
const toolId = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const executableFor = (name) => ({
  ruflo: 'ruflo', 'claude-flow': 'claude-flow', 'agentic-flow': 'agentic-flow',
  'agentic-qe': 'agentic-qe', ruvector: 'ruvector', 'agent-browser': 'agent-browser',
  'ruv-swarm': 'ruv-swarm',
})[toolId(name)] || null;

function liveEvidenceFile(env = process.env) {
  if (env.RUVNET_CAPABILITY_LIVE_EVIDENCE) return path.resolve(env.RUVNET_CAPABILITY_LIVE_EVIDENCE);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  return path.join(brainHome, 'capability-live-evidence.jsonl');
}

function groundingEvidenceFile(env = process.env) {
  if (env.RUVNET_EVIDENCE_FILE) return path.resolve(env.RUVNET_EVIDENCE_FILE);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const brainHome = env.RUVNET_BRAIN_HOME || path.join(home, '.cache', 'ruvnet-brain');
  return path.join(brainHome, 'evidence.jsonl');
}

function sourcePayload(receipt) {
  const { receiptSha256: _receiptSha256, ...payload } = receipt || {};
  return payload;
}

export function validateSourceClaimReceipt(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'ruvnet-brain-source-claim'
    || receipt.verdict !== 'PASS' || !HEX64.test(String(receipt.claimDigest || ''))
    || !HEX64.test(String(receipt.groundingReceiptDigest || ''))
    || !HEX64.test(String(receipt.source?.sha256 || '')) || !receipt.source?.repo || !receipt.source?.path
    || !HEX64.test(String(receipt.receiptSha256 || ''))
    || digest(sourcePayload(receipt)) !== receipt.receiptSha256) {
    throw new Error('source claim receipt is malformed or digest-invalid');
  }
  return receipt;
}

function sourceBindsClaim(claim, source, query) {
  const negative = /\b(?:cannot|can't|does\s+not|doesn't|not\s+(?:support|provide|implement|export|expose))\b/i.test(claim);
  if (negative) {
    return (source.negatives || []).some(({ symbol, quote }) =>
      (symbol && normalize(claim).includes(normalize(symbol))) || overlap(claim, quote).length >= 2);
  }
  const boundQuery = source.claimBinding?.query || query;
  if (source.claimBinding?.method === 'tight-source-token-pair' && overlap(claim, boundQuery).length >= 2) return true;
  if ((source.symbols || []).some(({ name }) => normalize(claim).includes(normalize(name)))) return true;
  return (source.posture || []).some((posture) => overlap(claim, posture).length >= 2);
}

export function buildSourceClaimReceipt({ claim, groundingReceipt, sourcePath, observedAt = new Date().toISOString() } = {}) {
  if (typeof claim !== 'string' || !claim.trim() || !groundingReceipt || !Array.isArray(groundingReceipt.sources)) {
    throw new Error('source claim receipt requires a claim and grounding receipt');
  }
  const source = groundingReceipt.sources.find((row) => `${row.repo}/${row.path}` === sourcePath);
  if (!source || !HEX64.test(String(source.sha || '')) || source.enforceable !== true) {
    throw new Error('grounding source lacks a full content identity or enforceable evidence');
  }
  if (!sourceBindsClaim(claim, source, groundingReceipt.query)) throw new Error('grounding source does not bind the claim');
  const payload = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-source-claim',
    observedAt,
    claim: claim.trim(),
    claimDigest: digest(normalize(claim)),
    groundingReceiptId: String(groundingReceipt.id || ''),
    groundingReceiptDigest: digest(groundingReceipt),
    source: { repo: source.repo, path: source.path, sha256: source.sha },
    binding: source.claimBinding?.method || ((source.negatives || []).length ? 'explicit-negative' : 'explicit-source-fact'),
    verdict: 'PASS',
  };
  return validateSourceClaimReceipt({ ...payload, receiptSha256: digest(payload) });
}

function livePayload(receipt) {
  const { receiptSha256: _receiptSha256, ...payload } = receipt || {};
  return payload;
}

export function validateLiveSurfaceReceipt(receipt) {
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== 'ruvnet-brain-live-surface'
    || !['claude', 'codex', 'shared'].includes(receipt.host) || !receipt.executable
    || !['current-version', 'health'].includes(receipt.observationClass)
    || !HEX64.test(String(receipt.outputSha256 || '')) || !HEX64.test(String(receipt.receiptSha256 || ''))
    || digest(livePayload(receipt)) !== receipt.receiptSha256) {
    throw new Error('live surface receipt is malformed or digest-invalid');
  }
  if (receipt.observationClass === 'current-version' && !VERSION.test(String(receipt.observedVersion || ''))) {
    throw new Error('live version receipt has no observed semantic version');
  }
  if (receipt.observationClass === 'health' && !['PASS', 'FAIL', 'UNKNOWN'].includes(receipt.healthVerdict)) {
    throw new Error('live health receipt has no typed verdict');
  }
  return receipt;
}

function appendReceipt(file, receipt) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > MAX_LEDGER_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200);
      const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporary, `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  } catch { /* evidence capture cannot break the managed CLI boundary */ }
}

export function recordManagedCliObservation({ toolName, executable, argv, execution, env = process.env,
  observedAt = new Date().toISOString() } = {}) {
  try {
    const output = [execution?.stdout, execution?.stderr].filter(Boolean).join('\n');
    const reachable = execution?.code === 0 && !execution?.error;
    const version = VERSION.exec(output)?.[1] || null;
    let observationClass = null;
    let fields = {};
    if (reachable && version && (toolName === 'ruvnet_cli_help'
      || (argv || []).some((arg) => ['--version', '-V', 'version'].includes(arg)))) {
      observationClass = 'current-version';
      fields = { observedVersion: version };
    } else if (['doctor', 'status'].includes(String(argv?.[0] || ''))) {
      observationClass = 'health';
      const negative = /\b(?:critical|degraded|error|failed|failure|unhealthy)\b/i.test(output);
      const positive = /\b(?:all checks passed|healthy|overall\s*[:=-]?\s*(?:ok|pass)|status\s*[:=-]\s*(?:ok|pass|healthy))\b/i.test(output);
      fields = { healthVerdict: negative ? 'FAIL' : reachable && positive ? 'PASS' : 'UNKNOWN', reachable };
    }
    if (!observationClass) return null;
    const payload = {
      schemaVersion: 1,
      kind: 'ruvnet-brain-live-surface',
      host: HOSTS.includes(env.RUVNET_HOOK_HOST) ? env.RUVNET_HOOK_HOST : 'shared',
      observedAt,
      toolName,
      executable,
      argv: [...(argv || [])],
      observationClass,
      outputSha256: sha256(output),
      ...fields,
    };
    const receipt = validateLiveSurfaceReceipt({ ...payload, receiptSha256: digest(payload) });
    appendReceipt(liveEvidenceFile(env), receipt);
    return receipt;
  } catch { return null; }
}

export function readLiveSurfaceReceipts({ file = null, env = process.env, limit = 100 } = {}) {
  try {
    const lines = fs.readFileSync(file || liveEvidenceFile(env), 'utf8').split('\n').filter(Boolean);
    const receipts = [];
    for (let index = lines.length - 1; index >= 0 && receipts.length < limit; index -= 1) {
      try { receipts.push(validateLiveSurfaceReceipt(JSON.parse(lines[index]))); } catch { /* reject torn/tampered rows */ }
    }
    return receipts;
  } catch { return []; }
}

function extractClaims(message) {
  const claims = [];
  for (const sentence of safeMessage(message).split(/(?<=[.!?])\s+|\n+/).map((value) => value.trim()).filter(Boolean)) {
    let match = new RegExp(`\\b(${RUVNET_TOOL})\\b[^.!?]{0,48}\\b(?:current|installed)\\s+version\\s+(?:is\\s+)?v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)`, 'i').exec(sentence);
    if (match) { claims.push({ class: 'current-version', text: sentence, tool: match[1], version: match[2] }); continue; }
    match = new RegExp(`\\b(${RUVNET_TOOL})\\b[^.!?]{0,32}\\bv?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?)\\b[^.!?]{0,32}\\blatest\\s+version`, 'i').exec(sentence);
    if (match) { claims.push({ class: 'latest-version', text: sentence, tool: match[1], version: match[2] }); continue; }
    match = new RegExp(`\\b(${RUVNET_TOOL})\\b\\s+is\\s+(healthy|unhealthy|reachable|unreachable|available|down)\\b`, 'i').exec(sentence);
    if (match) { claims.push({ class: 'health', text: sentence, tool: match[1], state: match[2].toLowerCase() }); continue; }
    match = new RegExp(`\\b(${RUVNET_TOOL})\\b\\s+(?:can(?:not|'t)?|supports?|does\\s+not\\s+support|provides?|does\\s+not\\s+provide|implements?|does\\s+not\\s+implement|exports?|does\\s+not\\s+export|exposes?|does\\s+not\\s+expose|requires?|uses?)\\s+([^.!?]{1,160})`, 'i').exec(sentence);
    if (match) claims.push({ class: 'behavior', text: sentence, tool: match[1] });
  }
  return claims;
}

export function deriveSourceClaimReceipts(message, { file = null, env = process.env,
  now = new Date().toISOString(), maxAgeMs = 24 * 60 * 60_000 } = {}) {
  const behaviors = extractClaims(message).filter(({ class: claimClass }) => claimClass === 'behavior');
  if (!behaviors.length) return [];
  let lines;
  try { lines = fs.readFileSync(file || groundingEvidenceFile(env), 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
  const currentTime = Date.parse(now);
  const grounding = [];
  for (let index = lines.length - 1; index >= 0 && grounding.length < 60; index -= 1) {
    try {
      const receipt = JSON.parse(lines[index]);
      const age = currentTime - Date.parse(receipt.ts);
      if (receipt?.v === 1 && Array.isArray(receipt.sources) && Number.isFinite(age) && age >= 0 && age <= maxAgeMs) {
        grounding.push(receipt);
      }
    } catch { /* torn or malformed evidence cannot authorize a claim */ }
  }
  const sourceClaims = [];
  for (const claim of behaviors) {
    let bound = null;
    for (const receipt of grounding) {
      for (const source of receipt.sources || []) {
        try {
          bound = buildSourceClaimReceipt({ claim: claim.text, groundingReceipt: receipt,
            sourcePath: `${source.repo}/${source.path}`, observedAt: now });
        } catch { /* this source does not bind this exact claim */ }
        if (bound) break;
      }
      if (bound) break;
    }
    if (bound) sourceClaims.push(bound);
  }
  return sourceClaims;
}

export function auditCurrentCapabilityEvidence(message, { env = process.env,
  now = new Date().toISOString() } = {}) {
  return auditEvidenceBoundCapabilityClaims(message, {
    sourceClaims: deriveSourceClaimReceipts(message, { env, now }),
    liveSurfaces: readLiveSurfaceReceipts({ env }),
    host: HOSTS.includes(env.RUVNET_HOOK_HOST) ? env.RUVNET_HOOK_HOST : null,
    now,
  });
}

export function auditEvidenceBoundCapabilityClaims(message, {
  sourceClaims = [], liveSurfaces = [], host = null,
  now = new Date().toISOString(), maxAgeMs = MAX_AGE_MS,
} = {}) {
  const claims = extractClaims(message);
  const contradictions = [];
  const unresolved = [];
  const passed = [];
  const currentTime = Date.parse(now);
  const live = liveSurfaces.flatMap((receipt) => {
    try {
      validateLiveSurfaceReceipt(receipt);
      const age = currentTime - Date.parse(receipt.observedAt);
      const hostMatches = !host || receipt.host === 'shared' || receipt.host === host;
      return hostMatches && Number.isFinite(age) && age >= 0 && age <= maxAgeMs ? [receipt] : [];
    } catch { return []; }
  });
  const sources = sourceClaims.flatMap((receipt) => { try { return [validateSourceClaimReceipt(receipt)]; } catch { return []; } });
  for (const claim of claims) {
    if (claim.class === 'behavior') {
      const match = sources.find((receipt) => receipt.claimDigest === digest(normalize(claim.text)));
      (match ? passed : unresolved).push({ ...claim, evidence: match?.receiptSha256,
        reason: match ? 'exact behavior claim is source-bound' : 'behavior claim has no exact source receipt' });
      continue;
    }
    const executable = executableFor(claim.tool);
    const candidates = live.filter((receipt) => receipt.executable === executable);
    if (claim.class === 'current-version') {
      const observed = candidates.find((receipt) => receipt.observationClass === 'current-version');
      if (!observed) unresolved.push({ ...claim, reason: 'current version has no fresh live receipt' });
      else if (observed.observedVersion !== claim.version) contradictions.push({ ...claim,
        reason: `live current version is ${observed.observedVersion}`, evidence: observed.receiptSha256 });
      else passed.push({ ...claim, evidence: observed.receiptSha256, reason: 'current version matches live receipt' });
    } else if (claim.class === 'latest-version') {
      unresolved.push({ ...claim, reason: 'latest version has no fresh registry receipt' });
    } else {
      const observed = candidates.find((receipt) => receipt.observationClass === 'health');
      let state = 'UNKNOWN';
      if (observed && claim.state === 'healthy') state = observed.healthVerdict === 'PASS' ? 'PASS'
        : observed.healthVerdict === 'FAIL' ? 'FAIL' : 'UNKNOWN';
      else if (observed && claim.state === 'unhealthy') state = observed.healthVerdict === 'FAIL' ? 'PASS'
        : observed.healthVerdict === 'PASS' ? 'FAIL' : 'UNKNOWN';
      else if (observed && ['reachable', 'available'].includes(claim.state)) state = observed.reachable === true ? 'PASS' : 'FAIL';
      else if (observed && ['unreachable', 'down'].includes(claim.state)) state = observed.reachable === false ? 'PASS' : 'FAIL';
      if (state === 'PASS') passed.push({ ...claim, evidence: observed.receiptSha256 });
      else if (state === 'FAIL') contradictions.push({ ...claim, evidence: observed.receiptSha256,
        reason: 'fresh live health receipt contradicts the claim' });
      else unresolved.push({ ...claim, reason: 'health or reachability claim has no conclusive fresh live receipt' });
    }
  }
  return { schemaVersion: 1, kind: 'ruvnet-brain-evidence-bound-capability-audit', claims, passed,
    contradictions, unresolved, verdict: contradictions.length ? 'FAIL' : unresolved.length ? 'UNKNOWN' : 'PASS' };
}

function aggregatePayload(aggregate) {
  const { aggregateSha256: _aggregateSha256, signature: _signature, ...payload } = aggregate || {};
  return payload;
}

function validateAggregatePayload(payload) {
  if (payload?.schemaVersion !== 1 || payload?.kind !== 'ruvnet-brain-capability-claim-aggregate'
    || !HEX40.test(String(payload.identity?.sourceSha || '')) || !HEX64.test(String(payload.identity?.artifactSha256 || ''))
    || !Array.isArray(payload.lanes) || !Array.isArray(payload.untested)
    || !Array.isArray(payload.sourceClaimDigests) || !Array.isArray(payload.liveSurfaceDigests)
    || payload.sourceClaimDigests.some((value) => !HEX64.test(String(value)))
    || payload.liveSurfaceDigests.some((value) => !HEX64.test(String(value)))) {
    throw new Error('capability claim aggregate payload is malformed');
  }
  const laneIds = new Set();
  for (const lane of payload.lanes) {
    const id = `${lane.os}/${lane.host}`;
    const claims = lane.claims || {};
    const claimVerdicts = CLAIM_CLASSES.map((name) => claims[name]);
    const derivedVerdict = claimVerdicts.includes('FAIL') ? 'FAIL'
      : claimVerdicts.includes('UNKNOWN') ? 'PARTIAL' : 'PASS';
    if (!OS_LANES.includes(lane.os) || !HOSTS.includes(lane.host) || laneIds.has(id)
      || claimVerdicts.some((verdict) => !['PASS', 'FAIL', 'UNKNOWN'].includes(verdict))
      || lane.verdict !== derivedVerdict
      || !HEX64.test(String(lane.receiptSha256 || ''))) throw new Error('capability claim aggregate lane is incomplete');
    laneIds.add(id);
  }
  const os = [...new Set(payload.lanes.map(({ os: laneOs }) => laneOs))].sort();
  const hosts = [...new Set(payload.lanes.map(({ host }) => host))].sort();
  if (canonicalJson(os) !== canonicalJson(payload.os) || canonicalJson(hosts) !== canonicalJson(payload.hosts)) {
    throw new Error('capability claim aggregate lane projection differs');
  }
  const complete = OS_LANES.every((laneOs) => HOSTS.every((host) => laneIds.has(`${laneOs}/${host}`)));
  const laneVerdicts = payload.lanes.map(({ verdict }) => verdict);
  const derivedVerdict = laneVerdicts.includes('FAIL') ? 'FAIL'
    : !complete || payload.untested.length || laneVerdicts.includes('PARTIAL') ? 'PARTIAL' : 'PASS';
  if (payload.verdict !== derivedVerdict) throw new Error('capability claim aggregate verdict differs from its lanes');
  if (payload.verdict === 'PASS' && (!complete || payload.untested.length)) {
    throw new Error('capability claim PASS lacks the complete OS and host matrix');
  }
  if (payload.verdict === 'PARTIAL' && !payload.untested.length && !laneVerdicts.includes('PARTIAL')) {
    throw new Error('capability claim PARTIAL has no disclosed incomplete scope');
  }
  return payload;
}

export function signCapabilityClaimAggregate(input, privateKey) {
  const lanes = [...(input.lanes || [])].sort((a, b) => `${a.os}/${a.host}`.localeCompare(`${b.os}/${b.host}`));
  const complete = OS_LANES.every((laneOs) => HOSTS.every((host) =>
    lanes.some((lane) => lane.os === laneOs && lane.host === host)));
  const laneVerdicts = lanes.map(({ verdict }) => verdict);
  const untested = [...new Set(input.untested || [])].sort();
  const verdict = laneVerdicts.includes('FAIL') ? 'FAIL'
    : !complete || untested.length || laneVerdicts.includes('PARTIAL') ? 'PARTIAL' : 'PASS';
  const payload = validateAggregatePayload({
    schemaVersion: 1, kind: 'ruvnet-brain-capability-claim-aggregate', identity: input.identity,
    os: [...new Set(lanes.map(({ os: laneOs }) => laneOs))].sort(),
    hosts: [...new Set(lanes.map(({ host }) => host))].sort(), lanes,
    sourceClaimDigests: [...new Set(input.sourceClaimDigests || [])].sort(),
    liveSurfaceDigests: [...new Set(input.liveSurfaceDigests || [])].sort(),
    verdict,
    untested,
  });
  const aggregateSha256 = digest(payload);
  const signed = { ...payload, aggregateSha256 };
  return { ...signed, signature: crypto.sign(null, Buffer.from(canonicalJson(signed)), privateKey).toString('base64') };
}

export function verifyCapabilityClaimAggregate(aggregate, publicKey, expectedIdentity = null) {
  if (!HEX64.test(String(aggregate?.aggregateSha256 || '')) || typeof aggregate?.signature !== 'string') {
    throw new Error('capability claim aggregate signature envelope is malformed');
  }
  const payload = validateAggregatePayload(aggregatePayload(aggregate));
  if (digest(payload) !== aggregate.aggregateSha256) throw new Error('capability claim aggregate digest mismatch');
  const signed = { ...payload, aggregateSha256: aggregate.aggregateSha256 };
  if (!crypto.verify(null, Buffer.from(canonicalJson(signed)), publicKey, Buffer.from(aggregate.signature, 'base64'))) {
    throw new Error('capability claim aggregate signature mismatch');
  }
  if (expectedIdentity && canonicalJson(expectedIdentity) !== canonicalJson(aggregate.identity)) {
    throw new Error('capability claim aggregate identity differs');
  }
  return aggregate;
}
