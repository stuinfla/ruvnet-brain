#!/usr/bin/env node
// scripts/verify-model-catalog.mjs — THE WALL for model facts.
//
// Every model in data/model-catalog.json must EXIST in the live OpenRouter catalog and be priced
// correctly. A missing model, a wrong price, or a stale snapshot is a HARD FAILURE (exit 1). This is the
// enforcement of Rule 0 for the one place it kept getting skipped: model/version claims. The fact no
// longer lives in anyone's memory where it can be asserted lazily — it lives in verified data, and this
// gate refuses to let a wrong or stale one through. ADR-0016.
//
// CI runs it offline against the committed snapshot (data/openrouter-catalog-snapshot.json, refreshed
// nightly by refresh-model-catalog.mjs). Run with --live to check against OpenRouter directly.
//
// Usage: node scripts/verify-model-catalog.mjs [--live]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'data/model-catalog.json');
const SNAPSHOT = path.join(ROOT, 'data/openrouter-catalog-snapshot.json');

/** Resolve a catalog model id against the live-catalog map, tolerating bare Claude ids. */
export function findModel(models, id) {
  if (models[id]) return models[id];
  if (!id.includes('/') && models['anthropic/' + id]) return models['anthropic/' + id];
  return null;
}

/**
 * Pure verifier: check every catalog model against a {pulledAt, models} source. Returns
 * { ok, checked, ageDays, fails[] }. No I/O — fully unit-testable, which a wall must be.
 */
export function verifyCatalog(catalog, source, { now = Date.now(), maxAgeDays = 14, priceTol = 0.05 } = {}) {
  const models = source.models || {};
  const fails = [];
  const ageDays = (now - new Date(source.pulledAt).getTime()) / 86400000;
  if (!(ageDays <= maxAgeDays)) fails.push(`STALE: source pulled ${source.pulledAt} (${ageDays.toFixed(1)}d old > ${maxAgeDays}d) — run refresh-model-catalog.mjs`);

  let checked = 0;
  for (const [pid, p] of Object.entries(catalog.providers || {})) {
    if (p.aliasOf) continue;
    // Every provider MUST have a verified frontier (the personalized escalation + savings baseline);
    // mid/cheap are optional because real provider lineups vary in depth (e.g. xAI has no budget SKU).
    if (!p.frontier) fails.push(`INCOMPLETE: ${pid} has no frontier tier`);
    for (const tier of ['frontier', 'mid', 'cheap']) {
      const e = p[tier];
      if (!e) continue;
      checked++;
      const live = findModel(models, e.model);
      if (!live) { fails.push(`MISSING: ${pid}.${tier} "${e.model}" is NOT in the live OpenRouter catalog`); continue; }
      for (const k of ['in', 'out']) {
        const rel = live[k] === 0 ? (e[k] === 0 ? 0 : 1) : Math.abs(e[k] - live[k]) / live[k];
        if (rel > priceTol) fails.push(`PRICE: ${pid}.${tier} "${e.model}" ${k} = catalog $${e[k]} vs live $${live[k]} (${(rel * 100).toFixed(0)}% off)`);
      }
    }
  }
  return { ok: fails.length === 0, checked, ageDays, fails };
}

function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* none */ }
  return null;
}

async function liveSource() {
  const key = loadKey();
  const res = await fetch('https://openrouter.ai/api/v1/models', { headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
  const data = (await res.json()).data || [];
  const models = {};
  for (const m of data) { const p = m.pricing || {}; models[m.id] = { in: +(+p.prompt * 1e6).toFixed(4), out: +(+p.completion * 1e6).toFixed(4) }; }
  return { pulledAt: new Date().toISOString(), models };
}

export async function main(argv = process.argv) {
  const live = argv.includes('--live');
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  let source;
  if (live) source = await liveSource();
  else {
    if (!fs.existsSync(SNAPSHOT)) { console.error('✗ no snapshot — run: node scripts/refresh-model-catalog.mjs'); process.exit(1); }
    const s = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    source = { pulledAt: s._meta.pulledAt, models: s.models };
  }
  const r = verifyCatalog(catalog, source);
  if (!r.ok) {
    console.error(`\n✗ model-catalog verification FAILED — ${r.fails.length} issue(s) [source: ${live ? 'LIVE OpenRouter' : 'snapshot'} @ ${source.pulledAt}]:`);
    for (const f of r.fails) console.error('  - ' + f);
    console.error('\nA model fact cannot ship unless it is verified live. Fix data/model-catalog.json (or refresh the snapshot).');
    process.exit(1);
  }
  console.log(`✓ model-catalog VERIFIED: ${r.checked} model facts match the ${live ? 'LIVE OpenRouter' : 'committed snapshot'} catalog (pulled ${source.pulledAt}, ${r.ageDays.toFixed(1)}d old ≤ 14d).`);
}

if (isDirectInvocation(import.meta.url)) {
  main().catch((e) => { console.error('verify-model-catalog error:', e.message); process.exit(1); });
}
