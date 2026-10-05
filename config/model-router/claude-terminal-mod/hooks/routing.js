import { classify } from './policy.default.mjs';
export const REFUSAL = 'Reviewed terminal routing unavailable; request refused without model fallback.';
export function refusal(e) {
  return { turnId: e.turnId, index: e.index, answer: REFUSAL, toolUses: [], stopReason: 'refusal', usage: null };
}
export async function* refusalStream(e) {
  yield { kind: 'text', index: 0, text: REFUSAL };
  yield { kind: 'stop', stopReason: 'refusal', usage: null };
  return refusal(e);
}
export function classificationText(text, attachments) {
  return text.trim() ? text : attachments?.length ? 'final substantive review of supplied attachments' : text;
}
export function inspectDecision(value, text, now, minimumClass) {
  if (value?.schemaVersion !== 1 || value.subscriptionCovered !== true ||
      !/^claude-[a-z0-9][a-z0-9.-]*$/.test(value.model || '') ||
      !['low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort) ||
      !Number.isFinite(value.expiresAt) ||
      !/^[a-f0-9]{64}$/.test(value.routeDigest || '')) throw new Error(REFUSAL);
  text = minimumClass === 'hard' ? 'final substantive review\n' + text : minimumClass === 'medium' ? 'review task\n' + text : text;
  const codeFences = Math.floor((text.match(/```/g) || []).length / 2);
  const hasCode = codeFences > 0 || /\b(function|const|let|def|class|import|=>|SELECT|async)\b/.test(text) || /[{};]\s*$/m.test(text);
  const rank = { fast: 0, medium: 1, hard: 2 };
  const floor = classify({ taskHints: text, hasCode }, 'claude-code');
  if (!Object.hasOwn(rank, value.taskClass) || rank[value.taskClass] < rank[floor]) throw new Error(REFUSAL);
  return Object.freeze({ model: value.model, effort: value.effort, taskClass: value.taskClass, expiresAt: value.expiresAt });
}
// Prompt text exists only in this bounded in-memory queue; Claude mints turnId later.
export function createTurnCache() {
  const pending = [];
  const active = new Map();
  return {
    enqueue(text, decision, now) {
      while (pending.length && now - pending[0].createdAt > 300000) pending.shift();
      if (pending.length >= 32) throw new Error(REFUSAL);
      const entry = { text, decision, createdAt: now }; pending.push(entry); return entry;
    },
    remove(entry) { const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1); },
    pending() { return pending[0]; },
    bind(e, now, replacement) {
      // Never substitute the most recent prompt or the model shown in the TUI.
      const entry = pending[0];
      if ((!entry && !replacement) || (!replacement && entry.text !== e.text) || (entry && now - entry.createdAt > 300000) ||
          active.has(e.turnId) || active.size >= 32) throw new Error(REFUSAL);
      if (entry) pending.shift(); active.set(e.turnId, replacement || entry.decision);
    },
    get(e, now) {
      const decision = active.get(e.turnId);
      if (!decision || e.agentId || !Number.isSafeInteger(e.index) || e.index < 0) throw new Error(REFUSAL);
      return decision;
    },
    complete(turnId) { active.delete(turnId); },
    clear() { pending.length = 0; active.clear(); },
  };
}
