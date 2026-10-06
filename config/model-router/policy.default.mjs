// Per-user reviewed allocation: correctness first, subscription allowance second, completion time third.
// Free-text classification is a conservative heuristic, not an optimality or uncertainty detector.
// Structured taskFacts describe the caller's assessment; missing information/environment trouble alone
// never imply difficult reasoning. Claude keeps its separately reviewed three-class policy.
const CODING = /\b(implement|implementation|code|coding|debug|refactor|test|endpoint|API|repository|module|function)\b/i;
const HARD = /cryptograph|consensus|race condition|irreversible|final review|independent review|difficult planning|complex architecture|security audit|security vulnerability|unresolved architectur|production incident|prove correctness/i;
const MECHANICAL = /\b(summari[sz]e|classify|extract|translate|rephrase|format|typo|alphabetical order|two-column|markdown table)\b/i;
const WORK = /\b(implement|build|add|replace|repair|fix|debug|trace|investigate|determine|choose|design|plan|review|assess|recommend)\b/i;

// Conjunctions describe consequence and requested reasoning, not difficulty from length or a
// single domain word. They remain incomplete heuristics; callers should supply assessed facts.
function consequenceFloor(text) {
  const money = /\b(card|charg\w*|payment\w*|billing|settlement|ledger|funds)\b/i.test(text);
  const financialFailure = money && /\b(twice|duplicate\w*|double[- ]?charg\w*|los[est]\w*|failover|failed|rollback)\b/i.test(text);
  const liveMigration = /\b(live|production|both versions|concurrent)\b/i.test(text) &&
    /\b(migrat\w*|schema|moving|move)\b/i.test(text) && /\b(records|payments|data|traffic)\b/i.test(text);
  const isolation = /\b(tenant|account|user)\b/i.test(text) &&
    /\b(another|different|cross[- ]?(?:tenant|account)|other (?:tenant|account|user)|unauthori[sz]ed)\b/i.test(text) &&
    /\b(see|read|access|expos\w*|leak\w*|bind|replay\w*)\b/i.test(text);
  const verification = /\b(signed|signature|token|verifier|credential|authentication)\b/i.test(text) &&
    /\b(replay\w*|forg\w*|bypass\w*|bind|binding)\b/i.test(text);
  const durability = /\b(durable|durability|replicat\w*|acknowledg\w*|writer\w*|leader)\b/i.test(text) &&
    /\b(choose|choosing|trade[- ]?off|design|loss|losing|fail\w*|vanish\w*|survive)\b/i.test(text);
  const coupledSystems = [/\b(scheduler|queue)\b/i, /\b(worker|consumer)\b/i, /\b(database|storage|broker)\b/i]
    .filter((signal) => signal.test(text)).length >= 2;
  const coupledFailure = coupledSystems && /\b(failover|retri\w*|reconnect\w*|restart\w*)\b/i.test(text) &&
    /\b(vanish\w*|los[est]\w*|interaction|only when|duplicate\w*)\b/i.test(text);
  return financialFailure || liveMigration || isolation || verification || durability || coupledFailure;
}

function assessmentText(text) {
  // An explicitly supplied document title is data in a headings-only transformation, not an audit.
  // Remove only that title clause, leaving every other requested action/consequence visible.
  if (/^\s*(summari[sz]e|extract|copy)\b/i.test(text) && /\bsupplied document\b/i.test(text) &&
      /\bdo not assess\b/i.test(text)) return text.replace(/\btitled\s+[^;\n]+(?=[;\n])/i, '');
  return text;
}

export function validateTaskFacts(facts) {
  if (facts === undefined) return undefined;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('taskFacts must be an object');
  const keys = new Set(['taskType','scope','uncertainty','consequentialPlanning','finalSubstantiveReview','exceptionalReason','verifiedTaskQualityFailure']);
  if (Object.keys(facts).some((key) => !keys.has(key))) throw new Error('Unknown taskFacts field');
  if (facts.taskType !== undefined && !['mechanical','coding','research','planning','review'].includes(facts.taskType)) throw new Error('Invalid taskFacts taskType');
  if (facts.scope !== undefined && !['routine','substantial'].includes(facts.scope)) throw new Error('Invalid taskFacts scope');
  if (facts.uncertainty !== undefined && !['none','architecture','coupled-implementation','missing-information','environment'].includes(facts.uncertainty)) throw new Error('Invalid taskFacts uncertainty');
  for (const key of ['consequentialPlanning','finalSubstantiveReview','verifiedTaskQualityFailure']) {
    if (facts[key] !== undefined && typeof facts[key] !== 'boolean') throw new Error(`taskFacts ${key} must be boolean`);
  }
  if (facts.exceptionalReason !== undefined && !/^[a-z][a-z0-9-]{2,79}$/.test(facts.exceptionalReason)) {
    throw new Error('exceptionalReason must be an explicit named reason slug (3-80 characters)');
  }
  return facts;
}

export function classify(features, harness = features.harness || 'codex') {
  const text = String(features.taskHints || '');
  const coding = features.hasCode || CODING.test(text);
  const assessedText = assessmentText(text);
  const securityActions = assessedText.replace(/\bdo not (?:assess|recommend)[^.;\n]*/gi, '');
  const securityReview = /\b(security|risks?)\b/i.test(securityActions) &&
    /\b(review|assess(?:ment)?|audit|evaluat\w*|analy[sz]\w*|identify|determine)\b/i.test(securityActions);
  const consequential = /\b(consequential planning|substantive planning|substantive review|final substantive review|plan (?:a |the )?new system|design (?:a |the )?new architecture|ambiguous architecture|architecture ambiguity|architectur\w* tradeoff|tightly coupled uncertain implementation|uncertain tightly coupled implementation)\b/i.test(text);
  const architectureAmbiguity = /architectur\w*/i.test(text) && /\b(ambiguous|ambiguity|unresolved|uncertain|trade[- ]?off)\b/i.test(text);
  const coupledUncertainty = /tightly coupled/i.test(text) && /implementation|coding/i.test(text) && /uncertain|unresolved|ambiguous/i.test(text);
  const hardText = HARD.test(assessedText) || securityReview || consequenceFloor(assessedText) || consequential || architectureAmbiguity || coupledUncertainty;
  const substantialText = /\b(substantial (?:implementation|coding|feature|task)|cross-module (?:implementation|feature|refactor)|multi-file (?:implementation|feature|refactor)|end-to-end implementation|broad refactor)\b/i.test(text);
  const facts = validateTaskFacts(features.taskFacts);
  // Partial caller metadata supplements the assessment; it cannot lower explicit high-consequence text.
  if (facts?.exceptionalReason) return harness === 'claude-code' ? 'hard' : 'exceptional';
  if (hardText || facts?.verifiedTaskQualityFailure) return 'hard';
  if (facts && (['architecture','coupled-implementation'].includes(facts.uncertainty) ||
      facts.consequentialPlanning || facts.finalSubstantiveReview ||
      ((facts.scope === 'substantial' || substantialText) && ['planning','review'].includes(facts.taskType)))) return 'hard';
  const implementation = /\b(implement|build|add|replace|refactor)\b/i.test(text);
  const surfaces = [/\b(storage|database|backend|importer\w*)\b/i, /\b(endpoint\w*|API|permissions)\b/i,
    /\b(UI|client|dashboard)\b/i, /\b(integration|coverage|fixtures)\b/i].filter((signal) => signal.test(text)).length;
  const broadImplementation = implementation && (surfaces >= 3 ||
    (/\b(every|all|across)\b/i.test(text) && surfaces >= 2 && /\b(compatibility|integration|fixtures)\b/i.test(text)));
  if (harness !== 'claude-code' && (facts?.scope === 'substantial' || substantialText || broadImplementation)) return 'substantial';
  // Metadata alone never proves a closed-input transformation. Routine reviews and operative
  // repair/planning requests retain ordinary effort even when they also contain mechanical words.
  const permittedActions = assessedText.replace(/\bdo not (?:assess|recommend)[^.;\n]*/gi, '');
  const mechanical = MECHANICAL.test(text) && !coding && facts?.taskType !== 'review' &&
    (!WORK.test(permittedActions) || /^\s*fix only the typo\b/i.test(text));
  return mechanical ? 'fast' : 'medium';

}

export function choose({ features, candidates, harness, profile, selection }) {
  const taskClass = classify(features, harness);
  const reviewed = selection?.routes?.[harness];
  const allocation = profile?.allocation?.[harness]?.[taskClass] || reviewed?.[taskClass];
  const model = typeof allocation === 'string' ? allocation : allocation?.model;
  let effort = typeof allocation === 'object' ? allocation.effort : reviewed?.[taskClass]?.effort;
  if (harness === 'claude-code' && taskClass === 'medium' && (features.hasCode || CODING.test(features.taskHints || ''))) {
    effort = profile?.allocation?.[harness]?.codingEffort || reviewed?.codingEffort || effort;
  }
  const pick = candidates.find((m) => m.id === model && (m.harness || []).includes(harness) && (m.subscription || []).includes(harness));
  return { model: pick?.id || null, provider: pick?.provider || null, tier: pick?.tier || null,
    taskClass, effort, exceptionalReason: taskClass === 'exceptional' ? features.taskFacts?.exceptionalReason : undefined,
    classificationSource: harness === 'codex' && features.taskFacts ? 'caller-task-facts' : 'free-text-heuristic', confidence: 0.5,
    reason: pick ? `task-fit allocation: ${taskClass}, ${effort} effort; native subscription only`
      : `requested qualified ${taskClass} native subscription route unavailable: ${model}; no medium or paid fallback` };
}
