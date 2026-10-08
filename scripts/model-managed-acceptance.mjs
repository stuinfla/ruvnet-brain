// Pure validation only. Source IO, canonical receipts, native execution and review stay in the service.
const assert = (value, message) => { if (!value) throw new Error(message); };
const ID = /^[a-z][a-z0-9-]{0,79}$/;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const exact = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Bounded observed policy receipts are audit evidence, never completion or publication authority. */
export function boundedPolicyAuthorization(value, { write = false } = {}) {
  if (value === undefined || value === null) value = {enforced:false,evidence:[{enforced:false,status:'UNKNOWN_UNBOUND',authorization:'Authentic parent policy context and authorizeNative binding not observed'}]};
  assert(value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 16384
    && Array.isArray(value.evidence) && value.evidence.length <= 16, 'Bounded native policy authorization evidence required');
  const statuses = ['UNKNOWN_UNBOUND', 'UNENFORCED_LEGACY', 'UNENFORCED_OBSERVE', 'ENFORCED_AUTHORIZATION'];
  const evidence = value.evidence.map(item => {
    assert(item && statuses.includes(item.status) && typeof item.enforced === 'boolean', 'Typed native policy decision status required');
    const result = { enforced: item.enforced, status: item.status };
    for (const key of ['mode', 'projectRoot', 'receiptId', 'authorization', 'actionType']) if (item[key] !== undefined) {
      assert(typeof item[key] === 'string' && item[key].length <= 2000, 'Bounded native policy receipt fields required'); result[key] = item[key];
    }
    if (item.matchedRules !== undefined) {
      assert(Array.isArray(item.matchedRules) && item.matchedRules.length <= 64
        && item.matchedRules.every(id => typeof id === 'string' && id.length <= 200), 'Bounded native policy matched rules required');
      result.matchedRules = [...item.matchedRules];
    }
    return result;
  });
  const enforced = value.enforced === true && evidence.length > 0 && evidence.every(item => item.enforced === true
    && item.mode === 'enforce' && item.status === 'ENFORCED_AUTHORIZATION' && item.receiptId)
    && (!write || evidence.some(item => item.actionType === 'native.worker.apply'));
  return { enforced, scope: 'observed adapter launch/apply boundaries only; injected executor internals not covered', evidence,
    enforcementDiagnostic: enforced ? 'observed enforced boundary receipts; authorization is not completion'
      : 'legacy, observe or unbound domain authorization remains UNENFORCED',
    completionEligibility: 'not-established-by-authorization' };
}

export function validateTaskAcceptanceCriteria(task, registry, originalPromptDigest) {
  assert(Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0
    && task.acceptanceCriteria.length <= 32 && new Set(task.acceptanceCriteria.map(value => value?.id)).size === task.acceptanceCriteria.length
    && task.acceptanceCriteria.every(value => value && Object.keys(value).every(key => ['id', 'assertion', 'checkIds', 'sourceClaim'].includes(key))
    && ID.test(value?.id) && typeof value.assertion === 'string'
    && value.assertion.trim().length >= 12 && value.assertion.length <= 2000
    && Array.isArray(value.checkIds) && value.checkIds.length > 0
    && value.checkIds.every(id => task.checkIds.includes(id))
    && value.checkIds.some(id => { const check = registry.find(item => item.id === id);
      return (check?.kind === 'command' && !/\bnode\s+--check\b/.test(check.script ?? '') && !check.args?.includes('--check'))
      || (check?.kind === 'source-claim' && value.sourceClaim?.checkId === id
        && Object.keys(value.sourceClaim).every(key => ['checkId','claim'].includes(key))
        && typeof value.sourceClaim.claim === 'string' && value.sourceClaim.claim.trim().length >= 12
        && value.sourceClaim.claim.length <= 2000 && check.originalPromptDigest === originalPromptDigest); })),
    'Task-specific observable acceptance criteria must map to preexisting selected checker IDs');
}

export function evaluateSourceClaim({source,answer,criteria,checker,answerRef}) {
  const supported = criteria.length > 0 && criteria.every(criterion => {
    const claim = criterion.sourceClaim?.claim;
    if (typeof claim !== 'string' || criterion.sourceClaim.checkId !== checker.id) return false;
    const start = source.indexOf(claim), end = start + claim.length;
    const wholePassage = start >= 0 && (start === 0 || source[start - 1] === '\n')
      && (end === source.length || source[end] === '\n' || source.slice(end, end + 2) === '\r\n');
    return wholePassage && typeof answer.outcome === 'string' && answer.outcome.includes(claim)
      && answer.sourceClaims?.some(item => item.criterionId === criterion.id && item.checkId === checker.id
        && item.claim === claim && exact(item.sourceRef, checker.sourceRef)
        && item.originalPromptDigest === checker.originalPromptDigest);
  });
  return { passed: supported, kind: 'exact-source-claim', originalPromptDigest: checker.originalPromptDigest,
    sourceRef: checker.sourceRef, criterionIds: criteria.map(criterion => criterion.id),
    answerRef: answerRef, reason: supported ? 'Frozen literal source passage and actual reported claim match' : 'Unsupported source claim, substituted identity or incomplete report' };
}

export function validateIndependentReviewCoverage(tasks, verdict) {
  assert(tasks.every(task => task.acceptanceCriteria.every(criterion => verdict.criterionCoverage?.some(item =>
    item.taskId === task.id && item.criterionId === criterion.id && item.passed === true
    && exact(item.checkIds, criterion.checkIds)
    && Array.isArray(item.evidence) && item.evidence.length > 0))), 'Independent original-criterion acceptance coverage missing');
  assert(['entry', 'caller', 'consumer', 'config', 'error'].every(dimension => verdict.coverage?.some(item =>
    item.dimension === dimension && ['covered', 'not-applicable'].includes(item.state)
    && Array.isArray(item.evidence) && item.evidence.length > 0)), 'Typed independent source-path coverage missing');
  assert(Array.isArray(verdict.omissions) && verdict.omissions.every(item => item.relevant === false
    && typeof item.reason === 'string' && item.reason.trim() && item.sourceRef), 'Relevant or unresolved source omission blocks completion');
  return {criterionCoverage:verdict.criterionCoverage,coverage:verdict.coverage,omissions:verdict.omissions};
}
