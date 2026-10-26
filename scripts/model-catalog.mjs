#!/usr/bin/env node
// scripts/model-catalog.mjs — the accessor over data/model-catalog.json (the ADR-0016 verified data).
// The router-optimizer + console read the user's per-HOUSE frontier from here, so the escalation target
// and savings baseline are personalized to the person's own stack — Claude shop → Fable 5, ChatGPT/Codex
// shop → GPT-5.6 Sol, Gemini shop → Gemini 3.1 Pro, Grok shop → Grok 4.5 — never defaulted to one house.
// Every model returned here is gated by verify-model-catalog.mjs (a wrong/stale one fails the build).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export function loadCatalog(p) {
  const file = p || process.env.RUVNET_MODEL_CATALOG || path.join(ROOT, 'data/model-catalog.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Follow aliasOf (e.g. codex → openai). Returns {name, provider}. */
function resolve(catalog, name) {
  let p = catalog.providers?.[name];
  if (p?.aliasOf) { name = p.aliasOf; p = catalog.providers?.[name]; }
  return { name, provider: p };
}

const blend = (e) => (e && Number.isFinite(e.in) && Number.isFinite(e.out) ? +(((e.in + e.out) / 2)).toFixed(2) : null);

/**
 * Which house is this user? Precedence: explicit config.provider → $RUVNET_PROVIDER → an API key present
 * in env → the catalog default (Anthropic, because this IS a Claude Code plugin — a detected fact, which
 * the caller surfaces with source:'default' so it never reads as an arbitrary house preference).
 * Returns { provider, source: 'config'|'env'|'default' }.
 */
export function detectProvider(catalog, { provider, env = process.env } = {}) {
  const P = catalog.providers || {};
  const pick = provider || env.RUVNET_PROVIDER;
  if (pick && pick !== 'auto' && P[pick]) return { provider: pick, source: 'config' };
  // Running inside Claude Code, the dev house is genuinely Anthropic (a fact) — a stray OpenAI key in the
  // env does NOT make you an "OpenAI shop", so don't silently relabel; the person sets that explicitly.
  // Outside Claude Code (CI, standalone), fall to key detection.
  const inClaudeCode = env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT;
  if (!inClaudeCode) {
    for (const name of ['openai', 'google', 'xai', 'anthropic']) {
      const keys = (P[name]?.detect_env || []).filter((k) => !['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].includes(k));
      if (keys.some((k) => env[k])) return { provider: name, source: 'env' };
    }
  }
  return { provider: catalog.default_provider || 'anthropic', source: 'default' };
}

/** The frontier (flagship) for a house: {model, in, out, costPerMTok, rank, released, provider, label}. */
export function frontierFor(catalog, name) {
  const { name: r, provider: p } = resolve(catalog, name);
  if (!p?.frontier) return null;
  return { ...p.frontier, costPerMTok: blend(p.frontier), provider: r, label: p.label };
}

/** The full house ladder (cheap/mid/frontier — any may be null). */
export function ladderFor(catalog, name) {
  const { name: r, provider: p } = resolve(catalog, name);
  const t = (e) => (e ? { ...e, costPerMTok: blend(e) } : null);
  return { provider: r, label: p?.label || r, cheap: t(p?.cheap), mid: t(p?.mid), frontier: t(p?.frontier) };
}

export function providerLabel(catalog, name) { return resolve(catalog, name).provider?.label || name; }

/** The set of houses a user can pick, for the console selector: [{ id, label }]. */
export function providerChoices(catalog) {
  return Object.entries(catalog.providers || {}).map(([id, p]) => ({ id, label: p.label || id }));
}

if (isDirectInvocation(import.meta.url)) {
  const c = loadCatalog();
  const det = detectProvider(c, {});
  console.log(`detected house: ${det.provider} (${det.source})`);
  console.log('frontier:', JSON.stringify(frontierFor(c, det.provider)));
  console.log('choices:', providerChoices(c).map((x) => x.id).join(', '));
}
