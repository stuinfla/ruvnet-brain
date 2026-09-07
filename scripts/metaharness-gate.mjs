#!/usr/bin/env node
/** Compose measured MetaHarness read surfaces into one fail-closed gate. */
import crypto from 'node:crypto';

const REQUIRED_SCORE_FIELDS = Object.freeze(['harnessFit', 'compileConfidence', 'taskCoverage', 'toolSafety', 'memoryUsefulness']);
function unwrap(value) { return value && value.data && typeof value.data === 'object' ? value.data : value; }
function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function severity(value) { const key = String(value ?? '').toLowerCase(); return ['clean', 'low', 'medium', 'high'].includes(key) ? key : null; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function summarizeScore(input) {
  const score = unwrap(input);
  if (!score || score.degraded === true) return { status: 'unmeasured', degraded: true, reason: score?.reason || 'score unavailable' };
  const dimensions = Object.fromEntries(REQUIRED_SCORE_FIELDS.map((key) => [key, finite(score[key])]));
  const missing = REQUIRED_SCORE_FIELDS.filter((key) => dimensions[key] === null);
  return { status: missing.length ? 'unmeasured' : 'measured', dimensions, missing, costPerRunUsd: finite(score.estCostPerRunUsd), recommendedMode: typeof score.recommendedMode === 'string' ? score.recommendedMode : null, scaffoldReady: typeof score.scaffoldReady === 'boolean' ? score.scaffoldReady : null };
}

export function summarizeAudit(input) {
  const audit = unwrap(input);
  const worst = severity(audit?.composite?.worst ?? audit?.worst);
  const degraded = audit?.degraded === true || Object.values(audit?.components || {}).some((v) => v?.degraded === true);
  return { status: worst ? 'measured' : 'unmeasured', worst, degraded, fingerprint: typeof audit?.fingerprint === 'string' ? audit.fingerprint : null };
}

export function summarizeDrift(input) {
  const drift = unwrap(input);
  const alert = typeof drift?.alert === 'boolean' ? drift.alert : null;
  const verdict = typeof drift?.verdict === 'string' ? drift.verdict : null;
  return { status: alert === null && !verdict ? 'unmeasured' : 'measured', alert, verdict, similarity: finite(drift?.similarity), reason: drift?.reason || null };
}

export function summarizeRoutingReceipts(rows = []) {
  if (!Array.isArray(rows)) return { status: 'unmeasured', count: 0, costUsd: null, savedUsd: null };
  const valid = rows.filter((r) => r && typeof r === 'object' && typeof r.model === 'string');
  const withCost = valid.filter((r) => finite(r.est_cost) !== null);
  const withSaved = valid.filter((r) => finite(r.saved) !== null);
  return { status: valid.length ? 'measured' : 'unmeasured', count: valid.length, costUsd: withCost.length ? withCost.reduce((sum, r) => sum + r.est_cost, 0) : null, savedUsd: withSaved.length ? withSaved.reduce((sum, r) => sum + r.saved, 0) : null, unpriced: valid.length - withCost.length };
}

/** Read-only composition. `allowMetered` defaults false: readiness never authorizes spend. */
export function buildGateReceipt({ score, audit, drift, routingReceipts = [], candidate = null, allowMetered = false, now = new Date().toISOString() } = {}) {
  const measuredScore = summarizeScore(score), measuredAudit = summarizeAudit(audit), measuredDrift = summarizeDrift(drift), routing = summarizeRoutingReceipts(routingReceipts);
  const reasons = [];
  if (measuredScore.status !== 'measured') reasons.push('score is missing required measured dimensions');
  if (measuredAudit.status !== 'measured') reasons.push('OIA audit has no measured composite severity');
  if (measuredAudit.degraded) reasons.push('OIA audit is degraded');
  if (measuredDrift.status !== 'measured') reasons.push('drift result is unmeasured');
  if (measuredDrift.alert === true || /major|high|regress/i.test(measuredDrift.verdict || '')) reasons.push('drift is alerting');
  if (measuredAudit.worst === 'high') reasons.push('OIA audit is high severity');
  const ready = reasons.length === 0;
  const candidateVerified = candidate?.bundle_verified === true && candidate?.data_source === 'SYNTHETIC';
  const receipt = { schemaVersion: 1, kind: 'metaharness-gate', ts: now, score: measuredScore, audit: measuredAudit, drift: measuredDrift, routing, readiness: ready ? 'ready' : 'blocked', evolution: { allowed: ready && allowMetered === true, reason: ready ? (allowMetered ? 'measured preflight passed and metered spend explicitly allowed' : 'metered spend is disabled') : reasons.join('; ') }, promotion: { allowed: ready && candidateVerified, reason: !ready ? reasons.join('; ') : candidateVerified ? 'verified synthetic replay candidate' : 'candidate is absent or not a verified synthetic replay' } };
  return { ...receipt, evidenceDigest: digest(receipt) };
}

export function assertEvolutionAllowed(receipt) { if (!receipt?.evolution?.allowed) throw new Error(`MetaHarness evolution blocked: ${receipt?.evolution?.reason || 'missing gate receipt'}`); return receipt; }
export function assertPromotionAllowed(receipt) { if (!receipt?.promotion?.allowed) throw new Error(`MetaHarness promotion blocked: ${receipt?.promotion?.reason || 'missing gate receipt'}`); return receipt; }
