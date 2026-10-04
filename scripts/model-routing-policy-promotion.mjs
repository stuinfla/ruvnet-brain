// Promotion authority is a separate reviewed contract, never candidate self-evaluation.
// This module does not discover models, execute inference, alter profiles or control billing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonical = (v) => JSON.stringify(Array.isArray(v) ? v.map((x) => JSON.parse(canonical(x)))
  : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, JSON.parse(canonical(v[k]))])) : v);
export const candidateSha256 = (policy) => sha256(canonical(policy));
const same = (a, b) => canonical(a) === canonical(b);
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const hosts = { codex: 'openai', 'claude-code': 'anthropic' };
const kinds = ['availability', 'settings', 'handoff', 'role-quality'];
const time = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const fail = (reason) => ({ ok: false, status: 'blocked', reason });

function roleRoutes(policy) {
  const rows = [];
  for (const [host, routes] of Object.entries(policy.routes)) {
    if (!hosts[host] || !object(routes)) throw new Error('Unknown native harness');
    for (const [role, route] of Object.entries(routes)) {
      if (role === 'codingEffort') {
        if (typeof route !== 'string' || !routes.medium?.model) throw new Error('Invalid coding effort rule');
        rows.push({ host, role, model: routes.medium.model, effort: route });
      } else {
        if (!object(route) || typeof route.model !== 'string' || typeof route.effort !== 'string'
          || Object.keys(route).some((k) => !['model', 'effort', 'requiresNamedReason'].includes(k))
          || (route.requiresNamedReason !== undefined && typeof route.requiresNamedReason !== 'boolean')) throw new Error('Invalid role route');
        rows.push({ host, role, model: route.model, effort: route.effort });
      }
    }
  }
  return rows;
}

/** contract must come from the trusted reviewer/owner, independently of the proposal.
 * trustedReceipts binds exact immutable receipt bytes, not mutable source URLs or labels.
 * qualityFloors is role-specific: numeric metrics retain their native scales and direction.
 * Passing untrusted proposal data as contract defeats this trust boundary; the runner must not do so.
 */
export function validateRoutingProposal({ currentPolicy, candidatePolicy, evidence = [], contract, sourceSha,
  now = Date.now(), overrides = {} } = {}) {
  try {
    if (!object(currentPolicy) || !object(candidatePolicy) || currentPolicy.schemaVersion !== 1
      || candidatePolicy.schemaVersion !== 1 || !time(currentPolicy.reviewedAt) || !object(currentPolicy.routes) || !object(candidatePolicy.routes)) return fail('Invalid policy schema');
    const omit = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !['routes', 'reviewedAt', 'policyRevisionAt'].includes(k)));
    if (!same(omit(currentPolicy), omit(candidatePolicy))) return fail('Non-route settings or billing/control mutation');
    if (!time(candidatePolicy.reviewedAt) || Date.parse(candidatePolicy.reviewedAt) > now
      || Date.parse(candidatePolicy.reviewedAt) < Date.parse(currentPolicy.reviewedAt)) return fail('Invalid review date');
    if (candidatePolicy.policyRevisionAt !== currentPolicy.policyRevisionAt
      && (!time(candidatePolicy.policyRevisionAt) || Date.parse(candidatePolicy.policyRevisionAt) > now)) return fail('Invalid revision date');
    if (contract?.schemaVersion !== undefined && ![1, 2].includes(contract.schemaVersion)) return fail('Unsupported qualification contract version');
    const configuredTurnEvidence = contract?.schemaVersion === 2;
    if (configuredTurnEvidence && (contract.identityEvidence !== 'native-configured-turn' || contract.backendIdentityProved !== false
      || !object(contract.reviewer) || typeof contract.reviewer.model !== 'string' || typeof contract.reviewer.effort !== 'string'
      || !hosts[contract.reviewer.host])) return fail('Explicit native configured-turn qualification boundary required');
    const prior = roleRoutes(currentPolicy); const next = roleRoutes(candidatePolicy);
    if (!same(prior.map((r) => [r.host, r.role]).sort(), next.map((r) => [r.host, r.role]).sort())) return fail('Native provider or role expansion');
    const changed = next.filter((r) => !same(r, prior.find((p) => p.host === r.host && p.role === r.role)));
    if (!changed.length && candidatePolicy.reviewedAt === currentPolicy.reviewedAt
      && candidatePolicy.policyRevisionAt === currentPolicy.policyRevisionAt) return { ok: true, status: 'unchanged', candidateSha: candidateSha256(candidatePolicy), qualifiedRoles: [] };
    if (!sha(sourceSha) || !object(contract) || contract.sourceSha !== sourceSha || contract.authority !== 'independent-reviewed'
      || !sha(contract.contractSha256) || contract.contractSha256 !== candidateSha256(Object.fromEntries(Object.entries(contract).filter(([k]) => k !== 'contractSha256')))) return fail('Missing or unmatched reviewed authority contract');
    if (!object(contract.allowedRoutes) || !object(contract.qualityFloors) || !object(contract.trustedReceipts)
      || !Array.isArray(contract.trustedSourceIds) || !contract.trustedSourceIds.length || contract.trustedSourceIds.some((id) => !sha(id))
      || !Number.isFinite(contract.maxEvidenceAgeMs) || contract.maxEvidenceAgeMs <= 0) return fail('Incomplete qualification contract');
    const digest = candidateSha256(candidatePolicy);
    // Research freshness has its own receipt. Unchanged approved routes never become a
    // promotion, nor acquire a new policy review date from inventory or semantic research.
    if (!changed.length) return fail('Unchanged routes preserve policy dates; record research review separately');
    const required = changed;
    for (const route of next) {
      const allowed = contract.allowedRoutes[`${route.host}/${route.role}`];
      if (changed.some((r) => r.host === route.host && r.role === route.role) && (!Array.isArray(allowed) || !allowed.some((a) => a.model === route.model && a.effort === route.effort
        && a.provider === hosts[route.host] && a.nativeSubscription === true))) return fail(`Unsupported native allocation: ${route.host}/${route.role}`);
      if (overrides[route.host]?.[route.role] !== undefined
        && !same(route, prior.find((p) => p.host === route.host && p.role === route.role))) return fail('Explicit user override is preserved');
      const old = currentPolicy.routes[route.host][route.role]; const value = candidatePolicy.routes[route.host][route.role];
      if (object(old) && old.requiresNamedReason !== value.requiresNamedReason) return fail('Named-reason control is preserved');
    }
    for (const route of required) {
      const binding = (row) => row.sourceSha === sourceSha && row.candidateSha === digest && row.host === route.host
        && row.role === route.role && row.model === route.model && row.effort === route.effort
        && row.nativeObservedIdentity === route.model && row.nativeObservedEffort === route.effort
        && row.harness === route.host && typeof row.harnessVersion === 'string' && !!row.harnessVersion;
      for (const kind of kinds) {
        const row = evidence.find((r) => object(r) && r.kind === kind && binding(r));
        if (!row || !Array.isArray(row.sourceIds) || !row.sourceIds.length
          || row.sourceIds.some((id) => !sha(id) || !contract.trustedSourceIds.includes(id)) || !time(row.checkedAt) || Date.parse(row.checkedAt) > now || now - Date.parse(row.checkedAt) > contract.maxEvidenceAgeMs
          || !sha(row.receiptSha256) || contract.trustedReceipts[row.receiptSha256] !== candidateSha256(Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'receiptSha256')))) return fail(`Missing trusted ${kind} evidence: ${route.host}/${route.role}`);
        if (configuredTurnEvidence && (row.identityEvidence !== 'native-configured-turn' || row.backendIdentityProved !== false
          || typeof row.nativeSessionId !== 'string' || !row.nativeSessionId || typeof row.nativeTurnId !== 'string' || !row.nativeTurnId
          || !sha(row.transcriptSha256))) return fail('Completed native configured-turn transcript binding missing');
        if (kind === 'availability' && (row.available !== true || row.nativeSubscription !== true || row.provider !== hosts[route.host])) return fail('Native subscription availability unverified');
        if (kind === 'settings' && row.supported !== true) return fail('Native settings unsupported');
        if (configuredTurnEvidence && kind === 'handoff' && row.identityReturnedBasis !== 'native-host-confirmed-configuration') return fail('Native handoff configured identity basis missing');
        if (kind === 'handoff' && (row.completed !== true || row.identityReturned !== true || row.effortObserved !== true)) return fail('Native handoff identity/effort unverified');
        if (kind === 'role-quality') {
          if (configuredTurnEvidence && (row.reviewerHost !== contract.reviewer.host || row.reviewerModel !== contract.reviewer.model || row.reviewerEffort !== contract.reviewer.effort
            || row.reviewerModel === route.model)) return fail('Separately frozen independent model reviewer required');
          const floors = contract.qualityFloors[`${route.host}/${route.role}`];
          if (row.reviewedBy !== 'independent-reviewer' || row.reviewedOutcome !== 'accepted' || row.selfEvaluation === true
            || !object(row.benchmark) || !row.benchmark.suite || !row.benchmark.version || !object(row.metrics)
            || !object(floors) || !Object.keys(floors).length) return fail('Independent role-quality qualification missing');
          for (const [metric, floor] of Object.entries(floors)) {
            if (!object(floor) || !Number.isFinite(floor.value) || !['minimum', 'maximum'].includes(floor.direction)
              || !Number.isFinite(row.metrics[metric]) || row.benchmark.suite !== floor.suite || row.benchmark.version !== floor.version
              || (floor.direction === 'minimum' ? row.metrics[metric] < floor.value : row.metrics[metric] > floor.value)) return fail(`Role-quality floor unmet: ${metric}`);
          }
        }
      }
    }
    return { ok: true, status: 'qualified', candidateSha: digest, qualifiedRoles: required.map((r) => `${r.host}/${r.role}`) };
  } catch (error) { return fail(error.message); }
}

function syncDir(dir) {
  // Windows cannot flush directory descriptors through Node. File contents still fsync
  // before rename; do not claim POSIX directory-entry crash durability on Windows.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(path.dirname(file));
}
function atomicReplace(file, bytes) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { writeExclusive(temporary, bytes); fs.renameSync(temporary, file); syncDir(path.dirname(file)); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function locked(policyPath, action) {
  const lock = `${policyPath}.promotion.lock`; let acquired = false;
  try { writeExclusive(lock, JSON.stringify({ pid: process.pid })); acquired = true; return action(); }
  catch (error) { return fail(error.code === 'EEXIST' && !acquired ? 'Concurrent promotion owns lock' : error.message); }
  finally { if (acquired) { fs.unlinkSync(lock); syncDir(path.dirname(lock)); } }
}

/** CAS under an exclusive lock; only policyPath changes. Existing profile/policy.mjs overrides are untouched. */
export function promoteRoutingPolicy({ policyPath, candidatePolicy, expectedPriorSha, evidence, contract, sourceSha,
  now = Date.now(), overrides, beforeCommit } = {}) {
  if (!sha(expectedPriorSha) || typeof policyPath !== 'string' || !path.isAbsolute(policyPath)) return fail('Absolute policy path and expected prior SHA required');
  return locked(policyPath, () => {
    if (fs.lstatSync(policyPath).isSymbolicLink()) return fail('Policy symlink mutation refused');
    const prior = fs.readFileSync(policyPath); const currentPolicy = JSON.parse(prior);
    const bytes = Buffer.from(`${JSON.stringify(candidatePolicy, null, 2)}\n`); const nextSha = sha256(bytes);
    const archiveDir = `${policyPath}.history`;
    if (sha256(prior) !== expectedPriorSha) {
      const receiptPath = path.join(archiveDir, `${nextSha}.receipt.json`);
      if (sha256(prior) === nextSha && fs.existsSync(receiptPath)) {
        const receipt = JSON.parse(fs.readFileSync(receiptPath));
        if (receipt.sourceSha === sourceSha && receipt.priorSha === expectedPriorSha) return { ok: true, status: 'idempotent', ...receipt };
      }
      return fail('Prior policy changed; fencing rejected');
    }
    const validation = validateRoutingProposal({ currentPolicy, candidatePolicy, evidence, contract, sourceSha, now, overrides });
    if (!validation.ok || validation.status === 'unchanged') return validation;
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(archiveDir).isSymbolicLink()) return fail('Archive symlink mutation refused');
    const previousPath = path.join(archiveDir, `${expectedPriorSha}.policy.json`);
    const candidatePath = path.join(archiveDir, `${new Date(now).toISOString().replaceAll(':', '-')}-${nextSha}.policy.json`);
    for (const [file, body] of [[previousPath, prior], [candidatePath, bytes]]) {
      if (fs.existsSync(file)) { if (sha256(fs.readFileSync(file)) !== sha256(body)) return fail('Archive digest mismatch'); }
      else writeExclusive(file, body);
    }
    const receipt = { schemaVersion: 1, directorySync: process.platform === 'win32' ? 'unsupported' : 'performed', promotedAt: new Date(now).toISOString(), sourceSha,
      candidateSha: validation.candidateSha, priorSha: expectedPriorSha, policySha: nextSha,
      previousPath, candidatePath, contractSha256: contract.contractSha256, qualifiedRoles: validation.qualifiedRoles,
      ...(contract.schemaVersion === 2 ? { identityEvidence: 'native-configured-turn', backendIdentityProved: false,
        qualificationScope: 'bounded local role non-regression; not general superiority or subscription savings' } : {}) };
    const receiptPath = path.join(archiveDir, `${nextSha}.receipt.json`);
    if (!fs.existsSync(receiptPath)) writeExclusive(receiptPath, JSON.stringify(receipt, null, 2));
    if (beforeCommit) beforeCommit(); // fault injection / integration fence; no arbitrary proposal callback.
    if (sha256(fs.readFileSync(policyPath)) !== expectedPriorSha) return fail('Prior policy changed before atomic commit');
    try { atomicReplace(policyPath, bytes); } catch (error) {
      // A rename may have succeeded before directory fsync failed: restore under the same fence.
      if (sha256(fs.readFileSync(policyPath)) === nextSha) {
        try { atomicReplace(policyPath, prior); }
        catch { return { ok: false, status: 'degraded', reason: 'Commit durability failed and rollback failed', policyMayHaveChanged: true }; }
      }
      return fail(`Atomic commit failed; prior policy retained: ${error.message}`);
    }
    return { ok: true, status: 'promoted', ...receipt };
  });
}

export function rollbackRoutingPolicy({ policyPath, expectedCurrentSha, previousSha } = {}) {
  if (typeof policyPath !== 'string' || !path.isAbsolute(policyPath) || !sha(expectedCurrentSha) || !sha(previousSha)) return fail('Rollback requires exact policy SHA fence');
  return locked(policyPath, () => {
    if (fs.lstatSync(policyPath).isSymbolicLink()) return fail('Policy symlink mutation refused');
    const current = fs.readFileSync(policyPath);
    if (sha256(current) !== expectedCurrentSha) return fail('Rollback fencing rejected');
    const receipt = JSON.parse(fs.readFileSync(path.join(`${policyPath}.history`, `${expectedCurrentSha}.receipt.json`)));
    if (receipt.priorSha !== previousSha) return fail('Rollback is not this promotion predecessor');
    const prior = fs.readFileSync(path.join(`${policyPath}.history`, `${previousSha}.policy.json`));
    if (sha256(prior) !== previousSha) return fail('Rollback archive digest mismatch');
    atomicReplace(policyPath, prior);
    return { ok: true, status: 'rolled-back', policySha: previousSha };
  });
}
