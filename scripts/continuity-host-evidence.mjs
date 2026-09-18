/** Pure host event and rollout evidence helpers for continuity acceptance. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function redactedErrorPrefix(value) {
  if (String(value).startsWith('clamping SessionEnd hook timeout to ')) return 'session-end-timeout-clamped';
  if (String(value).startsWith('Skill descriptions were shortened to fit the skills context budget.')) return 'skill-descriptions-shortened';
  return 'unclassified-host-error';
}

export function nativeFinalAnswer(host, stdout) {
  if (host === 'codex') {
    const messages = [];
    for (const line of String(stdout).split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value.type === 'item.completed' && value.item?.type === 'agent_message') messages.push(String(value.item.text || ''));
      } catch { /* non-JSON diagnostic line */ }
    }
    return messages.at(-1) || '';
  }
  try {
    const value = JSON.parse(String(stdout));
    return typeof value.result === 'string' ? value.result : '';
  } catch { return ''; }
}

/** Read only disposable synthetic rollouts; retain structural facts, never message text. */
export function nativeRolloutContextEvidence(codexHome, nonce, { syntheticContextText = false } = {}) {
  const evidence = { files: 0, hookEvents: [], messages: [] };
  const sessions = path.join(codexHome, 'sessions');
  if (!fs.existsSync(sessions)) return evidence;
  const files = fs.readdirSync(sessions, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath, entry.name)).slice(0, 8);
  for (const file of files) {
    if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
    evidence.files++;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const value = row.payload;
      if (row.type === 'event_msg' && value?.type === 'hook_completed') {
        evidence.hookEvents.push({ eventName: value.run?.event_name ?? value.run?.eventName,
          status: value.run?.status, entries: (value.output ?? value.entries ?? []).map((entry) => ({
            kind: entry.kind, bytes: Buffer.byteLength(entry.text || ''),
            nonceCount: nonce ? String(entry.text || '').split(nonce).length - 1 : 0,
          })) });
      }
      if (row.type !== 'response_item' || value?.type !== 'message') continue;
      const body = (value.content || []).map((part) => part.text || '').join('\n');
      evidence.messages.push({ role: value.role, phase: value.phase || null, bytes: Buffer.byteLength(body),
        sha256: sha(body), nonceCount: nonce ? body.split(nonce).length - 1 : 0,
        nonceOffset: nonce ? body.indexOf(nonce) : -1,
        continuityHeader: body.includes('PROJECT CONTINUITY RESTORED'),
        hookContext: body.includes('hook'),
        ...(syntheticContextText && value.role === 'developer' && body.includes('PROJECT CONTINUITY RESTORED') && body.includes(nonce)
          ? { syntheticContextText: body } : {}),
      });
    }
  }
  return evidence;
}

/** Structural diagnostics only: never retain native prompt/output text. */
export function nativeEventStructure(host, stdout) {
  if (host !== 'codex') return { format: 'claude-json', eventTypes: [], itemTypes: [], turnCompleted: 0, turnFailed: 0, errorEvents: 0, lastType: null };
  const events = [];
  for (const line of String(stdout).split('\n')) {
    try {
      const value = JSON.parse(line);
      const eventType = typeof value.type === 'string' ? value.type : 'unknown';
      const itemType = typeof value.item?.type === 'string' ? value.item.type : null;
      const isErrorObject = eventType === 'error' || itemType === 'error';
      const errorMessage = isErrorObject ? String(value.error?.message || value.item?.error?.message || value.item?.message || value.item?.text || '') : '';
      events.push({ eventType, itemType, itemFields: value.item && typeof value.item === 'object' ? Object.keys(value.item).sort() : [], errorFields: value.error && typeof value.error === 'object' ? Object.keys(value.error).sort() : [], errorCode: typeof value.error?.code === 'string' ? value.error.code : (typeof value.item?.error?.code === 'string' ? value.item.error.code : null), hasErrorMessage: Boolean(errorMessage), errorMessageBytes: Buffer.byteLength(errorMessage, 'utf8'), errorMessageSha256: errorMessage ? sha(errorMessage) : null, errorMessagePrefix: errorMessage ? redactedErrorPrefix(errorMessage) : null });
    } catch { /* structural parser ignores diagnostics */ }
  }
  return {
    format: 'codex-jsonl', eventTypes: events.map((event) => event.eventType), itemTypes: events.map((event) => event.itemType).filter(Boolean),
    turnCompleted: events.filter((event) => event.eventType === 'turn.completed').length,
    turnFailed: events.filter((event) => event.eventType === 'turn.failed').length,
    errorEvents: events.filter((event) => event.hasErrorMessage || event.eventType === 'error' || event.itemType === 'error').length,
    errorMessageBytes: events.reduce((sum, event) => sum + event.errorMessageBytes, 0), errorCodes: events.map((event) => event.errorCode).filter(Boolean), errorShapes: events.filter((event) => event.itemType === 'error' || event.eventType === 'error').map(({ eventType, itemType, itemFields, errorFields, errorCode, errorMessageBytes, errorMessageSha256, errorMessagePrefix }) => ({ eventType, itemType, itemFields, errorFields, errorCode, errorMessageBytes, errorMessageSha256, errorMessagePrefix })), lastType: events.at(-1)?.eventType || null,
  };
}

export function nativeTerminalSuccess(host, stdout) {
  if (host === 'codex') {
    let completed = false;
    for (const line of String(stdout).split('\n')) {
      try {
        const value = JSON.parse(line);
        if (value.type === 'item.completed' && value.item?.type === 'error') {
          const message = String(value.item.message || '');
          const benign = message.startsWith('clamping SessionEnd hook timeout to ') || message.startsWith('Skill descriptions were shortened to fit the skills context budget.');
          if (!benign) return false;
        }
        if (value.type === 'turn.failed' || value.type === 'error') return false;
        if (value.type === 'turn.completed') completed = true;
      } catch {}
    }
    return completed;
  }
  try { const value = JSON.parse(String(stdout)); return value.is_error !== true && value.subtype === 'success'; } catch { return false; }
}
