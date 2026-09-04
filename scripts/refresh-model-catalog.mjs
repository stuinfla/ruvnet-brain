#!/usr/bin/env node
// scripts/refresh-model-catalog.mjs — pulls the LIVE OpenRouter model catalog and writes the committed
// snapshot data/openrouter-catalog-snapshot.json (with a pulledAt stamp) and synchronizes the catalog's
// factual prices. verify-model-catalog.mjs then
// enforces, offline in CI, that every model in data/model-catalog.json exists and is priced correctly
// against this snapshot — and that the snapshot is fresh. Run weekly (the anti-rot mechanism) + on demand.
// ADR-0016.
//
// It ALSO flags drift so a new flagship (e.g. a GPT-5.6-class release) surfaces instead of rotting:
// any catalog model that has VANISHED from the live catalog. OpenRouter /models is a free metadata
// endpoint (no generation, no spend).
//
// Usage: node scripts/refresh-model-catalog.mjs [--check]   (--check: fail if the pull would change the snapshot)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'data/openrouter-catalog-snapshot.json');
const CATALOG = path.join(ROOT, 'data/model-catalog.json');

/** Turn OpenRouter's /models `data` array into a compact {id: {in,out}} price map ($/Mtok). */
export function priceMap(orData) {
  const models = {};
  for (const m of orData || []) {
    const p = m.pricing || {};
    models[m.id] = { in: +(+p.prompt * 1e6).toFixed(4), out: +(+p.completion * 1e6).toFixed(4) };
  }
  return models;
}

/** Which catalog models are no longer present in the live map (tolerating bare Claude ids)? */
export function detectDrift(catalog, models) {
  const missing = [];
  for (const [pid, p] of Object.entries(catalog.providers || {})) {
    if (p.aliasOf) continue;
    for (const tier of ['frontier', 'mid', 'cheap']) {
      const id = p[tier]?.model;
      if (!id) continue;
      const found = models[id] || (!id.includes('/') && models['anthropic/' + id]);
      if (!found) missing.push(`${pid}.${tier} "${id}"`);
    }
  }
  return missing;
}

/** Synchronize factual catalog prices from the same live map that backs the snapshot. */
export function syncCatalogPrices(catalog, models, pulledAt) {
  const changes = [];
  for (const [provider, entry] of Object.entries(catalog.providers || {})) {
    if (entry.aliasOf) continue;
    for (const tier of ['frontier', 'mid', 'cheap']) {
      const candidate = entry[tier];
      if (!candidate?.model) continue;
      const live = models[candidate.model]
        || (!candidate.model.includes('/') ? models[`anthropic/${candidate.model}`] : null);
      if (!live) continue;
      if (candidate.in !== live.in || candidate.out !== live.out) {
        changes.push({ provider, tier, model: candidate.model, from: { in: candidate.in, out: candidate.out }, to: live });
        candidate.in = live.in;
        candidate.out = live.out;
      }
    }
  }
  if (catalog._meta?.sources) {
    catalog._meta.sources.prices = `OpenRouter /api/v1/models live catalog, pulled ${pulledAt.slice(0, 10)} (in/out USD per Mtok).`;
  }
  return changes;
}

export function shapeSnapshot(models, pulledAt) {
  return { _meta: { source: 'OpenRouter /api/v1/models (live metadata)', pulledAt, modelCount: Object.keys(models).length }, models };
}

function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* no .env */ }
  return null;
}

async function pullLive() {
  const key = loadKey();
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
  return priceMap((await res.json()).data || []);
}

async function main() {
  const check = process.argv.includes('--check');
  const models = await pullLive();
  if (Object.keys(models).length < 50) throw new Error(`live catalog returned only ${Object.keys(models).length} models — refusing to overwrite the snapshot with a suspiciously thin pull`);

  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const missing = detectDrift(catalog, models);
  const pulledAt = new Date().toISOString();
  const snapshot = shapeSnapshot(models, pulledAt);
  const next = JSON.stringify(snapshot, null, 2) + '\n';

  if (check) {
    const cur = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).models : null;
    if (JSON.stringify(cur) !== JSON.stringify(models)) {
      console.error('✗ snapshot is out of date vs the live OpenRouter catalog — run: node scripts/refresh-model-catalog.mjs');
      process.exit(1);
    }
    console.log(`✓ snapshot matches live (${Object.keys(models).length} models).`);
    return;
  }

  const priceChanges = syncCatalogPrices(catalog, models, pulledAt);
  fs.writeFileSync(SNAPSHOT, next);
  fs.writeFileSync(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`✓ wrote ${SNAPSHOT.replace(ROOT + '/', '')} — ${Object.keys(models).length} live models, pulledAt ${snapshot._meta.pulledAt}`);
  console.log(`✓ synchronized ${priceChanges.length} catalog price field(s) from the same live response`);
  if (missing.length) {
    console.log(`\n⚠ DRIFT: ${missing.length} catalog model(s) no longer in the live catalog — update data/model-catalog.json:`);
    for (const m of missing) console.log('  - ' + m);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('refresh-model-catalog FAILED:', e.message); process.exit(1); });
}
