#!/usr/bin/env node
// scripts/app-model-router.mjs — Reusable Production App Model Router (Fork 2: Zero Hardcoded Models).
// Companion to docs/APP-MODEL-ROUTING-INTEGRATION.md.
//
// 3-Layer Zero-Redeploy Production Architecture:
//   Layer 1 — Admin / Operator UI Picker Overrides (capability -> provider/model, backed by a
//             refreshable & cacheable provider /models catalog — zero app redeploy)
//   Layer 2 — Externalized 5-Tier Registry (APP_MODEL_TIERS_JSON / APP_MODEL_TIERS_PATH / AA v5.0.1 defaults)
//   Layer 3 — Automatic Cross-Provider Failover + Validation-Failure (+1 Tier) Auto-Escalation
//
// Usage smoke test: node scripts/app-model-router.mjs --smoke

import fs from 'node:fs';
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
  fast:        { provider: 'google',    model: 'gemini-4-flash',   effort: 'low',    fallback: 'gpt-6-luna',        fallbackProvider: 'openai',    maxOutputTokens: 1024 },
  medium:      { provider: 'google',    model: 'gemini-4-neon',    effort: 'medium', fallback: 'claude-sonnet-5-5', fallbackProvider: 'anthropic', maxOutputTokens: 4096 },
  substantial: { provider: 'google',    model: 'gemini-4-neon',    effort: 'high',   fallback: 'gpt-6.2-sol',       fallbackProvider: 'openai',    maxOutputTokens: 8192 },
  hard:        { provider: 'google',    model: 'gemini-4-neon',    effort: 'high',   fallback: 'claude-opus-5-5',   fallbackProvider: 'anthropic', maxOutputTokens: 8192 },
  exceptional: { provider: 'anthropic', model: 'claude-fable-5-2', effort: 'high',   fallback: 'gemini-4-neon',     fallbackProvider: 'google',    maxOutputTokens: 8192 },
});

// Built-in offline fallback catalog for Admin / Operator UI Pickers
export const BUILTIN_PROVIDER_CATALOG = Object.freeze([
  { id: 'google/gemini-4-flash',       provider: 'google',    model: 'gemini-4-flash',   tierHint: 'fast',        efforts: ['low', 'medium'],               costNote: '~$0.15/$0.60 Mtok' },
  { id: 'openai/gpt-6-luna',           provider: 'openai',    model: 'gpt-6-luna',       tierHint: 'fast',        efforts: ['low', 'medium'],               costNote: '~$0.10/$0.50 Mtok' },
  { id: 'anthropic/claude-haiku-5-5',  provider: 'anthropic', model: 'claude-haiku-5-5', tierHint: 'fast',        efforts: ['low', 'medium'],               costNote: 'Fast & low-latency' },
  { id: 'xai/grok-4.7',                provider: 'xai',       model: 'grok-4.7',         tierHint: 'medium',      efforts: ['low', 'medium', 'high'],       costNote: 'Fast parallel edits' },
  { id: 'google/gemini-4-neon',        provider: 'google',    model: 'gemini-4-neon',    tierHint: 'hard',        efforts: ['low', 'medium', 'high', 'xhigh'], costNote: '$0 implicit cache-write · Sweet Spot' },
  { id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', model: 'claude-sonnet-5-5',tierHint: 'medium',      efforts: ['low', 'medium', 'high'],       costNote: 'Warm-cache coordinator' },
  { id: 'openai/gpt-6.2-sol',          provider: 'openai',    model: 'gpt-6.2-sol',      tierHint: 'substantial', efforts: ['low', 'medium', 'high'],       costNote: 'Strong code & synthesis' },
  { id: 'anthropic/claude-opus-5-5',   provider: 'anthropic', model: 'claude-opus-5-5',  tierHint: 'hard',        efforts: ['medium', 'high'],              costNote: 'Deep reasoning (cap at high)' },
  { id: 'openai/gpt-6.2-astra',        provider: 'openai',    model: 'gpt-6.2-astra',    tierHint: 'hard',        efforts: ['medium', 'high', 'xhigh'],     costNote: 'Adversarial review & architecture' },
  { id: 'anthropic/claude-fable-5-2',  provider: 'anthropic', model: 'claude-fable-5-2', tierHint: 'exceptional', efforts: ['high'],                        costNote: 'Escalation-only frontier' },
]);

function inferProvider(model = '') {
  const m = String(model).toLowerCase();
  if (m.includes('/')) return m.split('/')[0];
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  if (m.startsWith('grok')) return 'xai';
  return null;
}

function loadExternalOverrides() {
  if (process.env.APP_MODEL_TIERS_JSON) {
    try { return JSON.parse(process.env.APP_MODEL_TIERS_JSON); } catch { /* ignore malformed env */ }
  }
  if (process.env.APP_MODEL_TIERS_PATH && fs.existsSync(process.env.APP_MODEL_TIERS_PATH)) {
    try { return JSON.parse(fs.readFileSync(process.env.APP_MODEL_TIERS_PATH, 'utf8')); } catch { /* ignore */ }
  }
  return {};
}

// ── Layer 1: Refreshable & Cacheable Provider Model Catalog ─────────────────────
let catalogCache = { fetchedAt: 0, source: 'builtin', models: [...BUILTIN_PROVIDER_CATALOG] };

export async function getProviderCatalog({
  refresh = false,
  ttlMs = 3_600_000,
  fetcher = globalThis.fetch,
} = {}) {
  const now = Date.now();
  const cachePath = process.env.APP_MODEL_CATALOG_CACHE_PATH;
  if (!refresh && catalogCache.fetchedAt > 0 && (now - catalogCache.fetchedAt) < ttlMs) {
    return { ...catalogCache, cached: true };
  }
  if (!refresh && cachePath && fs.existsSync(cachePath)) {
    try {
      const disk = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (disk?.fetchedAt && (now - disk.fetchedAt) < ttlMs && Array.isArray(disk.models) && disk.models.length > 0) {
        catalogCache = disk;
        return { ...catalogCache, cached: true };
      }
    } catch { /* ignore corrupt cache */ }
  }

  // On-demand live refresh from OpenRouter /models when OPENROUTER_API_KEY is available
  let liveModels = null;
  if (refresh && typeof fetcher === 'function' && process.env.OPENROUTER_API_KEY) {
    try {
      const r = await fetcher('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      });
      if (r?.ok) {
        const json = await r.json();
        if (Array.isArray(json?.data) && json.data.length > 0) {
          liveModels = json.data.map((m) => ({
            id: m.id,
            provider: inferProvider(m.id) || 'openrouter',
            model: m.id,
            name: m.name || m.id,
            contextLength: m.context_length || null,
            pricing: m.pricing || null,
            efforts: ['low', 'medium', 'high'],
          }));
        }
      }
    } catch { /* fall back cleanly to built-in catalog */ }
  }

  catalogCache = {
    fetchedAt: now,
    source: liveModels ? 'openrouter-live' : 'builtin-canonical',
    models: liveModels || [...BUILTIN_PROVIDER_CATALOG],
  };
  if (cachePath) {
    try { fs.writeFileSync(cachePath, JSON.stringify(catalogCache, null, 2) + '\n', 'utf8'); } catch {}
  }
  return { ...catalogCache, cached: false };
}

// ── Layer 1B: Admin / Operator UI Picker Capability Overrides (Zero-Redeploy) ──
const runtimeCapabilityOverrides = new Map();

function loadCapabilityOverridesFromEnvOrDisk() {
  const out = {};
  if (process.env.APP_CAPABILITY_OVERRIDES_JSON) {
    try { Object.assign(out, JSON.parse(process.env.APP_CAPABILITY_OVERRIDES_JSON)); } catch {}
  }
  const p = process.env.APP_CAPABILITY_OVERRIDES_PATH;
  if (p && fs.existsSync(p)) {
    try { Object.assign(out, JSON.parse(fs.readFileSync(p, 'utf8'))); } catch {}
  }
  for (const [cap, cfg] of runtimeCapabilityOverrides.entries()) out[cap] = cfg;
  return out;
}

export function setCapabilityOverride(capability, { provider, model, effort = 'medium', maxOutputTokens = 4096, allowMax = false } = {}) {
  if (!capability || !model) throw new Error('setCapabilityOverride requires capability and model');
  const safeEffort = (!allowMax && effort === 'max') ? 'high' : effort;
  const entry = {
    provider: provider || inferProvider(model) || 'openrouter',
    model,
    effort: safeEffort,
    maxOutputTokens,
    updatedAt: new Date().toISOString(),
  };
  runtimeCapabilityOverrides.set(capability, entry);
  const p = process.env.APP_CAPABILITY_OVERRIDES_PATH;
  if (p) {
    try { fs.writeFileSync(p, JSON.stringify(loadCapabilityOverridesFromEnvOrDisk(), null, 2) + '\n', 'utf8'); } catch {}
  }
  return entry;
}

export function clearCapabilityOverride(capability) {
  const deleted = runtimeCapabilityOverrides.delete(capability);
  const p = process.env.APP_CAPABILITY_OVERRIDES_PATH;
  if (p) {
    try { fs.writeFileSync(p, JSON.stringify(loadCapabilityOverridesFromEnvOrDisk(), null, 2) + '\n', 'utf8'); } catch {}
  }
  return deleted;
}

export function getCapabilityOverrides() {
  return loadCapabilityOverridesFromEnvOrDisk();
}

export async function getAdminPickerState({ refreshCatalog = false } = {}) {
  const catalog = await getProviderCatalog({ refresh: refreshCatalog });
  return {
    catalogSource: catalog.source,
    catalogFetchedAt: new Date(catalog.fetchedAt).toISOString(),
    models: catalog.models,
    tiers: Object.fromEntries(TIER_ORDER.map((t) => [t, resolveTier(t)])),
    capabilityOverrides: getCapabilityOverrides(),
  };
}

// ── Layer 2: Tier Registry Resolution ───────────────────────────────────────────
export function resolveTier(tier = 'medium') {
  const key = TIER_ORDER.includes(tier) ? tier : 'medium';
  const overrides = loadExternalOverrides();
  const merged = { ...DEFAULT_PRODUCTION_TIERS[key], ...(overrides[key] || {}) };
  // Guardrail: never allow routine tiers to accidentally drift to max effort
  if (key !== 'exceptional' && merged.effort === 'max') merged.effort = 'high';
  return merged;
}

export function resolveRoute({ tier = 'medium', capability = null } = {}) {
  const tierRoute = resolveTier(tier);
  if (capability) {
    const capMap = loadCapabilityOverridesFromEnvOrDisk();
    if (capMap[capability]?.model) {
      return {
        ...tierRoute,
        ...capMap[capability],
        fallback: tierRoute.model,
        fallbackProvider: tierRoute.provider,
        routeSource: 'admin-picker',
      };
    }
  }
  return { ...tierRoute, routeSource: 'tier-registry' };
}

// ── Layer 3: Auto-Escalation & Cross-Provider Failover ──────────────────────────
export async function callWithAutoEscalation({
  tier = 'medium',
  capability = null,
  purpose = 'unspecified',
  execute,
  validate = () => true,
  onReceipt = null,
} = {}) {
  if (typeof execute !== 'function') throw new Error('callWithAutoEscalation requires an execute(route) function');
  const capKey = capability || (purpose !== 'unspecified' ? purpose : null);
  let current = TIER_ORDER.includes(tier) ? tier : 'medium';
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const route = attempt === 0 ? resolveRoute({ tier: current, capability: capKey }) : { ...resolveTier(current), routeSource: 'tier-escalation' };
    const candidates = [route];
    if (route.fallback && route.fallback !== route.model) {
      candidates.push({
        ...route,
        model: route.fallback,
        provider: route.fallbackProvider || inferProvider(route.fallback) || route.provider,
        usedFallback: true,
      });
    }
    let validationFailed = false;
    for (const candidate of candidates) {
      const started = Date.now();
      try {
        const output = await execute(candidate, { attempt, tier: current, purpose, capability: capKey, isFallback: Boolean(candidate.usedFallback) });
        const valid = await validate(output);
        const receipt = {
          ts: new Date().toISOString(),
          purpose,
          capability: capKey,
          routeSource: candidate.routeSource || 'tier-registry',
          requestedTier: tier,
          executedTier: current,
          model: candidate.model,
          effort: candidate.effort,
          provider: candidate.provider,
          usedFallback: Boolean(candidate.usedFallback),
          escalated: attempt > 0,
          valid: Boolean(valid),
          durationMs: Date.now() - started,
        };
        if (typeof onReceipt === 'function') onReceipt(receipt);
        if (valid) return { output, receipt };
        lastError = new Error(`Validation failed at tier=${current} (${candidate.model}@${candidate.effort})`);
        validationFailed = true;
        break; // semantic/validation failure -> escalate +1 tier instead of lateral fallback
      } catch (err) {
        lastError = err; // provider outage/429 -> try lateral fallback model first, then escalate
      }
    }
    if (!NEXT_TIER[current]) break;
    current = NEXT_TIER[current];
    void validationFailed;
  }
  throw lastError || new Error(`All tiers exhausted starting from ${tier}`);
}

const isDirect = Boolean(process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)));
if (isDirect && process.argv.includes('--smoke')) {
  const receipts = [];
  // 1. Verify Admin/Operator UI Picker capability override + cached catalog
  const catalog = await getProviderCatalog();
  setCapabilityOverride('extract-invoice-json', { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' });
  const picked = resolveRoute({ tier: 'fast', capability: 'extract-invoice-json' });
  const pickerOk = picked.routeSource === 'admin-picker' && picked.model === 'claude-sonnet-5-5' && picked.fallback === 'gemini-4-flash';
  clearCapabilityOverride('extract-invoice-json');

  // 2. Verify automatic +1 tier escalation on validation failure
  const res = await callWithAutoEscalation({
    tier: 'fast',
    purpose: 'smoke-test-auto-escalation',
    execute: async (route, { attempt }) => ({ ok: attempt === 1, model: route.model, effort: route.effort }),
    validate: (out) => out.ok === true,
    onReceipt: (r) => receipts.push(r),
  });
  console.log(JSON.stringify({
    ok: pickerOk && res.receipt.escalated === true,
    catalogModels: catalog.models.length,
    adminPickerVerified: pickerOk,
    escalated: res.receipt.escalated,
    finalRoute: `${res.receipt.model}@${res.receipt.effort}`,
    receipts,
  }, null, 2));
}
