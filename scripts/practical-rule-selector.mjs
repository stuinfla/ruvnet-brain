// One deterministic advisory selector. Existing safety gates remain independently authoritative.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const catalogFile = fileURLToPath(new URL('../config/practical-rule-catalog.json', import.meta.url));
export const RULE_PHASES = Object.freeze(['planning','mutation','execution','checks','review','completion','recovery','compaction','release','memory','learning','evaluation','grounding','maintenance']);
const ACTIONS = new Set(['read','write','delete','implementation','source-inspection','architecture','source-change','memory-recall','memory-opt-out','checkpoint','recover','learn','capture','evaluate','rollback','model-call','dispatch','parallel-dispatch','privacy','ownership','config-change','unfinished-work','stalled','blocked','publish','version','build','knowledge','search','update','doctor','disk','check']);
let loaded;
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function loadPracticalCatalog() {
  if (loaded) return loaded;
  const bytes = fs.readFileSync(catalogFile); if (bytes.length > 512 * 1024) throw Error('Practical catalog exceeds bounded configuration size');
  const data = JSON.parse(bytes), ids = new Set();
  if (data.kind !== 'approved-practical-action-catalog' || data.rules?.length !== 100 || !/^[a-f0-9]{64}$/.test(data.auditSha256)) throw Error('Invalid source-bound practical catalog');
  for (const r of data.rules) {
    if (!/^P\d{3}$/.test(r.id) || r.cohort !== 'approved-practical' || ids.has(r.id) || !r.sourceRuleIds?.length || typeof r.actionRule !== 'string'
      || r.applicability.phases.some(p => !RULE_PHASES.includes(p)) || r.applicability.actions.some(a => !ACTIONS.has(a))) throw Error('Invalid approved practical rule');
    ids.add(r.id);
  }
  loaded = freeze({ data, projectionSha256: crypto.createHash('sha256').update(bytes).digest('hex') }); return loaded;
}

export function selectPracticalRules({ phase, actions = [], maxContextBytes = 2048, maxRules = 6 } = {}, catalog = loadPracticalCatalog()) {
  const base = { schemaVersion: 1, delivery: 'ADVISORY_ONLY', enforcement: 'NOT_ASSERTED_BY_SELECTOR',
    catalogAuditSha256: catalog.data.auditSha256, projectionSha256: catalog.projectionSha256,
    phase: RULE_PHASES.includes(phase) ? phase : null, actions: [], selectedIds: [], deferredIds: [], context: '' };
  if (!RULE_PHASES.includes(phase)) return { ...base, status: 'UNKNOWN_PHASE', reason: 'No broad fallback or all-rules injection' };
  if (!Array.isArray(actions) || actions.length > 16 || actions.some(a => !ACTIONS.has(a))) return { ...base, actions: [], status: 'UNKNOWN_ACTION', reason: 'Explicit supported action scope required' };
  if (!Number.isInteger(maxContextBytes) || maxContextBytes < 128 || maxContextBytes > 8192 || !Number.isInteger(maxRules) || maxRules < 1 || maxRules > 12) throw Error('Invalid practical context budget');
  const applicable = catalog.data.rules.filter(r => r.cohort === 'approved-practical' && /^P\d{3}$/.test(r.id)
    && r.sourceRuleIds?.length && r.applicability.phases.includes(phase)
    && (!r.applicability.actions.length || r.applicability.actions.some(a => actions.includes(a))))
    .sort((a,b) => a.applicability.priority - b.applicability.priority || a.id.localeCompare(b.id));
  const header = 'Applicable action guidance only; selecting a rule does not enforce it or replace existing gates.\n';
  let context = header; const selected = [], deferred = [];
  for (const rule of applicable) {
    const line = `[${rule.id}; declared ${rule.declaredEnforcement.kind}; advisory] ${rule.actionRule}\n`;
    if (selected.length >= maxRules || Buffer.byteLength(context + line) > maxContextBytes) { deferred.push(rule.id); continue; }
    selected.push(rule); context += line;
  }
  return { ...base, actions: [...new Set(actions)].sort(), status: selected.length ? 'SELECTED' : applicable.length ? 'BUDGET_DEFERRED' : 'NO_APPLICABLE_RULES',
    selectedIds: selected.map(r => r.id), deferredIds: deferred, context: selected.length ? context : '',
    contextBytes: selected.length ? Buffer.byteLength(context) : 0 };
}

export function practicalSelectionReceipt(selection) {
  return { schemaVersion: 1, phase: selection.phase, actions: selection.actions, status: selection.status,
    selectedIds: selection.selectedIds, deferredIds: selection.deferredIds, catalogAuditSha256: selection.catalogAuditSha256,
    projectionSha256: selection.projectionSha256, contextBytes: selection.contextBytes ?? 0,
    delivery: 'ADVISORY_ONLY', enforcement: 'NOT_ASSERTED_BY_SELECTOR' };
}
