#!/usr/bin/env node
// scripts/app-model-router.mjs — Reusable Production App Model Router (Lens 2: Zero Hardcoded Models).
// Companion to docs/APP-MODEL-ROUTING-INTEGRATION.md.
//
// Projects import { resolveTier, callWithAutoEscalation } from this module instead of hardcoding
// vendor model IDs in business logic. The tier-to-model map updates dynamically via:
//   1. process.env.APP_MODEL_TIERS_JSON (instant zero-deploy override in Vercel/cloud env)
//   2. process.env.APP_MODEL_TIERS_PATH (local JSON registry refreshed by CI/cron)
//   3. Built-in AA v5.0.1 / Vals v2.2 / KingBench 4 optimal defaults
//
// Usage smoke test: node scripts/app-model-router.mjs --smoke

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIER_ORDER = Object.freeze(['fast', 'medium', 'substantial', 'hard', 'exceptional']);
const NEXT_TIER = Object.freeze({
  fast: 'medium',
  medium: 'substantial',
  substantial: 'hard',
  hard: 'exceptional',
});

// AA v5.0.1 / Vals v2.2 / KingBench 4 production API defaults (capped at high; never default max)
export const DEFAULT_PRODUCTION_TIERS = Object.freeze({
  fast:        { provider: 'google',    model: 'gemini-4-flash',   effort: 'low',    fallback: 'gpt-6-luna',        maxOutputTokens: 1024 },
  medium:      { provider: 'google',    model: 'gemini-4-neon',    effort: 'medium', fallback: 'claude-sonnet-5-5', maxOutputTokens: 4096 },
  substantial: { provider: 'google',    model: 'gemini-4-neon',    effort: 'high',   fallback: 'gpt-6.2-sol',       maxOutputTokens: 8192 },
  hard:        { provider: 'google',    model: 'gemini-4-neon',    effort: 'high',   fallback: 'claude-opus-5-5',   maxOutputTokens: 8192 },
  exceptional: { provider: 'anthropic', model: 'claude-fable-5-2', effort: 'high',   fallback: 'gemini-4-neon',     maxOutputTokens: 8192 },
});

function loadExternalOverrides() {
  if (process.env.APP_MODEL_TIERS_JSON) {
    try { return JSON.parse(process.env.APP_MODEL_TIERS_JSON); } catch { /* ignore malformed env */ }
  }
  if (process.env.APP_MODEL_TIERS_PATH && fs.existsSync(process.env.APP_MODEL_TIERS_PATH)) {
    try { return JSON.parse(fs.readFileSync(process.env.APP_MODEL_TIERS_PATH, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}

export function resolveTier(tier = 'medium') {
  const key = TIER_ORDER.includes(tier) ? tier : 'medium';
  const overrides = loadExternalOverrides();
  const merged = { ...DEFAULT_PRODUCTION_TIERS[key], ...(overrides[key] || {}) };
  // Guardrail: never allow routine tiers to accidentally drift to max effort
  if (key !== 'exceptional' && merged.effort === 'max') merged.effort = 'high';
  return merged;
}

export async function callWithAutoEscalation({
  tier = 'medium',
  purpose = 'unspecified',
  execute,
  validate = () => true,
  onReceipt = null,
} = {}) {
  if (typeof execute !== 'function') throw new Error('callWithAutoEscalation requires an execute(route) function');
  let current = TIER_ORDER.includes(tier) ? tier : 'medium';
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const route = resolveTier(current);
    const started = Date.now();
    try {
      const output = await execute(route, { attempt, tier: current, purpose });
      const valid = await validate(output);
      const receipt = {
        ts: new Date().toISOString(),
        purpose,
        requestedTier: tier,
        executedTier: current,
        model: route.model,
        effort: route.effort,
        provider: route.provider,
        escalated: attempt > 0,
        valid: Boolean(valid),
        durationMs: Date.now() - started,
      };
      if (typeof onReceipt === 'function') onReceipt(receipt);
      if (valid) return { output, receipt };
      lastError = new Error(`Validation failed at tier=${current} (${route.model}@${route.effort})`);
    } catch (err) {
      lastError = err;
    }
    if (!NEXT_TIER[current]) break;
    current = NEXT_TIER[current];
  }
  throw lastError || new Error(`All tiers exhausted starting from ${tier}`);
}

const isDirect = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isDirect && process.argv.includes('--smoke')) {
  const receipts = [];
  const res = await callWithAutoEscalation({
    tier: 'fast',
    purpose: 'smoke-test-auto-escalation',
    execute: async (route, { attempt }) => ({ ok: attempt === 1, model: route.model, effort: route.effort }),
    validate: (out) => out.ok === true,
    onReceipt: (r) => receipts.push(r),
  });
  console.log(JSON.stringify({ ok: true, escalated: res.receipt.escalated, finalRoute: `${res.receipt.model}@${res.receipt.effort}`, receipts }, null, 2));
}
