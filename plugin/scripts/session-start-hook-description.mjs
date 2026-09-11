#!/usr/bin/env node
// session-start-hook-description.mjs — BANNER TRUTH. The banner used to say "the grounding hooks
// are active" unconditionally, in every state, on every version — false since 4.3.17 retired the
// grounding plane (plugin/hooks/hook-contracts.json's own `_note`: "Exactly two continuity handlers
// are permitted"). This module reads THAT file at runtime and describes whatever is actually
// registered, so the sentence can never drift from the real contract again — including forward, when
// the continuity lane bumps hook-contracts.json to a new `_version` with a different event set
// (e.g. capture hooks at Stop/PreCompact/SessionEnd, an advocacy route on UserPromptSubmit): this
// file does not hardcode which ids or events exist, only how to render whatever it finds.
import fs from 'node:fs';

// Friendly labels for ids this file KNOWS about today. Anything else still renders correctly via the
// fallback below — this dictionary only makes today's two contracts read naturally; it is never the
// thing that decides what counts as "active".
const KNOWN_ACTIONS = {
  'session-start': 'restore',
  'continuation-gate': 'continuation',
};

function friendlyAction(contract) {
  const known = KNOWN_ACTIONS[contract?.id];
  if (known) return known;
  const id = String(contract?.id || '').trim();
  return id ? id.replace(/-/g, ' ') : 'hook';
}

/** One factual sentence naming every {event, action} pair hook-contracts.json currently declares,
 * grouped by event. Never asserts a capability (like "grounding") the data does not name. */
export function describeLifecycleHooks(contractsDoc) {
  const contracts = Array.isArray(contractsDoc?.contracts) ? contractsDoc.contracts : [];
  if (!contracts.length) return 'No lifecycle hooks are currently registered.';
  const byEvent = new Map();
  for (const contract of contracts) {
    if (!contract?.event) continue;
    const list = byEvent.get(contract.event) || [];
    list.push(friendlyAction(contract));
    byEvent.set(contract.event, list);
  }
  const parts = [...byEvent.entries()].map(([event, actions]) => `${event} ${actions.join('/')}`);
  return parts.length ? `Lifecycle hooks: ${parts.join(', ')}.` : 'No lifecycle hooks are currently registered.';
}

export function readHookContracts(hookContractsPath) {
  try { return JSON.parse(fs.readFileSync(hookContractsPath, 'utf8')); } catch { return null; }
}
