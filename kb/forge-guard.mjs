#!/usr/bin/env node
// forge-guard.mjs — ANTI-TRUNCATION + INTEGRITY GUARD for an rvf-kb-forge knowledge base.
//
// Run AFTER a build. FAILS (exit 1) if the KB looks broken, so a bad build can never ship.
// This guard is the institutional memory of the failure rvf-kb-forge exists to prevent:
// once, full chunks were embedded into the .rvf but only a 240-char preview was stored to a
// shippable file — queries returned a teaser, not the content. The guard makes that
// un-shippable.
//
// Checks:
//   1. PARITY     — passages.jsonl line count == meta entry count == idmap entry count.
//   2. TRUNCATION — FAILS if any passage is empty; if >= MIN_CAP_COUNT and > MAX_CAP_FRACTION of passages sit
//                   EXACTLY at a legacy preview cap (200/240) ending mid-content (the old bug);
//                   if a passage is shorter than its own meta preview (impossible unless cut);
//                   if many passages equal their preview AND sit at a cap.
//   3. LIVE QUERY — a canned semantic query must return >=1 hit WITH non-empty full text
//                   (proves .rvf reads, embedder runs, ids join to passages).
//
// Usage:
//   node forge-guard.mjs --dir <kb-dir> --name <kb-name> [--query "canned question"]
//   node forge-guard.mjs <kb-dir> <kb-name> ["canned question"]

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { searchKb } from './forge-ask.mjs';

const LEGACY_CAPS = [200, 240];
const CAP_TOLERANCE = 0;
const MAX_CAP_FRACTION = 0.02;
// A percentage of a tiny store is a coincidence, not evidence: one passage that happens to be exactly 200
// or 240 chars long is 2.2% of a 45-passage store. The old bug clipped passages wholesale, so require a
// minimum absolute count before the fraction rule can fire (measured 2026-09-30: agentic-employment, 1/45,
// refused an otherwise valid corpus generation in the customer canary).
const MIN_CAP_COUNT = 3;
const CLIP_FAIL_COUNT = 25;

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : undefined; };
  if (a.includes('--dir') || a.includes('--name')) {
    return { dir: get('--dir'), name: get('--name'), query: get('--query'), variant: get('--variant') };
  }
  return { dir: a[0], name: a[1], query: a[2], variant: a[3] };
}

function countIdmapEntries(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j)) return j.length;
    if (j && typeof j === 'object') {
      if (j.idToLabel && typeof j.idToLabel === 'object') return Object.keys(j.idToLabel).length;
      if (j.labelToId && typeof j.labelToId === 'object') return Object.keys(j.labelToId).length;
      if (j.entries && typeof j.entries === 'object') return Object.keys(j.entries).length;
      if (Array.isArray(j.ids)) return j.ids.length;
      if (j.idmap && typeof j.idmap === 'object') return Object.keys(j.idmap).length;
      return Object.keys(j).length;
    }
  } catch { /* unreadable */ }
  return null;
}

function loadMetaPreviews(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = j.entries || {};
  const previews = new Map();
  for (const [id, m] of Object.entries(entries)) {
    if (m && typeof m.preview === 'string') previews.set(String(id), m.preview);
  }
  return { count: Object.keys(entries).length, previews, model: j.model, dim: j.dimensions, metric: j.metric };
}

function streamPassages(file, onLine) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let n = 0;
    rl.on('line', (line) => { if (!line.trim()) return; n++; try { onLine(JSON.parse(line), n); } catch { onLine(null, n); } });
    rl.on('close', () => resolve(n));
    rl.on('error', reject);
  });
}

async function checkStore({ dir, name, query, variant }) {
  // Guard the requested variant's files. 'big' adds the .big tag; default/'small' guards <name>.*.
  // The big build copies passages+meta verbatim, so the SAME parity/truncation checks apply.
  const tag = variant === 'big' ? '.big' : '';
  const rvf = path.join(dir, `${name}${tag}.rvf`);
  const variantPassages = path.join(dir, `${name}${tag}.passages.jsonl`);
  const canonicalPassages = path.join(dir, `${name}.passages.jsonl`);
  const passages = variant === 'big' && !fs.existsSync(variantPassages)
    ? canonicalPassages
    : variantPassages;
  const metaCands = [path.join(dir, `${name}${tag}.meta.json`), path.join(dir, `${name}${tag}.ids.json`),
    path.join(dir, `${name}.meta.json`), path.join(dir, `${name}.ids.json`)];
  const meta = metaCands.find((f) => fs.existsSync(f)) || metaCands[0];
  const idmap = path.join(dir, `${name}${tag}.rvf.idmap.json`);
  const fails = [], notes = [];
  for (const f of [rvf, passages, meta]) {
    if (!fs.existsSync(f)) fails.push(`MISSING file: ${path.basename(f)}`);
  }
  if (fails.length) return { fails, notes };

  const idx = loadMetaPreviews(meta);
  const idmapCount = countIdmapEntries(idmap);

  let capExact = 0, clippedAtCap = 0, shorterThanPreview = 0, emptyText = 0;
  let minLen = Infinity, maxLen = 0;
  const lineCount = await streamPassages(passages, (o) => {
    if (!o || typeof o.text !== 'string') { emptyText++; return; }
    const t = o.text, L = t.length;
    if (L === 0) emptyText++;
    minLen = Math.min(minLen, L); maxLen = Math.max(maxLen, L);
    const atCap = LEGACY_CAPS.some((cap) => Math.abs(L - cap) <= CAP_TOLERANCE);
    if (atCap) capExact++;
    const pv = idx.previews.get(String(o.id));
    if (pv != null) {
      const pvTrim = pv.replace(/\s+/g, ' ').trim();
      const collapsed = t.slice(0, pv.length).replace(/\s+/g, ' ').trim();
      const lastChar = t[t.length - 1];
      const clipped = !'\n.!?,;:)]"\'`>'.includes(lastChar);
      if (atCap && collapsed === pvTrim && L <= pv.length + 2 && clipped) clippedAtCap++;
      if (L < pvTrim.length) shorterThanPreview++;
    }
  });

  // 1. PARITY
  if (lineCount !== idx.count) fails.push(`PARITY: passages lines (${lineCount}) != meta entries (${idx.count})`);
  else notes.push(`parity OK: passages=${lineCount} == meta=${idx.count}`);
  if (idmapCount != null) {
    const drift = Math.abs(idmapCount - lineCount) / Math.max(1, lineCount);
    if (idmapCount !== lineCount && drift > 0.01) fails.push(`PARITY: idmap entries (${idmapCount}) != passages (${lineCount})`);
    else notes.push(`idmap parity OK: ${idmapCount} (within 1% of ${lineCount})`);
  } else notes.push('idmap entry count unparseable — skipped (soft)');

  // 2. TRUNCATION
  if (emptyText > 0) fails.push(`TRUNCATION: ${emptyText} passage(s) have empty/invalid text`);
  // A tiny store (13 of 199 real stores hold 1-2 passages) can never reach CLIP_FAIL_COUNT or the cap
  // fraction's minimum count; if EVERY passage is clipped exactly like the old bug, that is the old bug.
  const allClipped = lineCount > 0 && clippedAtCap === lineCount;
  if (clippedAtCap >= CLIP_FAIL_COUNT || allClipped) fails.push(`TRUNCATION: ${clippedAtCap} passages equal their preview AND sit at a 200/240 cap mid-content (the old bug)${allClipped ? ' — every passage in the store' : ''}`);
  else if (clippedAtCap > 0) notes.push(`clip scan: ${clippedAtCap} at-cap+equal-preview (< ${CLIP_FAIL_COUNT}, informational)`);
  else notes.push('clip scan: 0 at-cap clipped-preview passages');
  if (shorterThanPreview > 0) fails.push(`TRUNCATION: ${shorterThanPreview} passage(s) shorter than their own preview`);
  const capFraction = lineCount ? capExact / lineCount : 0;
  if (capExact >= MIN_CAP_COUNT && capFraction > MAX_CAP_FRACTION) fails.push(`TRUNCATION: ${capExact}/${lineCount} (${(capFraction * 100).toFixed(1)}%) passages clipped at a legacy cap (200/240)`);
  else notes.push(`truncation OK: ${capExact} at-cap (${(capFraction * 100).toFixed(2)}%; fails only at >= ${MIN_CAP_COUNT} AND > ${MAX_CAP_FRACTION * 100}%), len range ${minLen}..${maxLen}`);

  // 3. LIVE QUERY
  const q = query || 'what is this repository and how is it organized';
  try {
    const hits = await searchKb({ dir, name, query: q, k: 3, variant });
    const withText = hits.filter((h) => h.text && h.text.trim() && !h.text.startsWith('(NO PASSAGE'));
    if (withText.length === 0) fails.push(`LIVE QUERY "${q}" returned 0 hits with text`);
    else notes.push(`live query OK: "${q}" -> ${withText.length} hits w/ text (top: ${withText[0].path}, ${withText[0].text.length} chars)`);
  } catch (e) {
    fails.push(`LIVE QUERY failed: ${e.message}`);
  }

  return { fails, notes, model: idx.model, dim: idx.dim, metric: idx.metric };
}

async function main() {
  const { dir, name, query, variant } = parseArgs();
  if (!dir || !name) { console.error('Usage: node forge-guard.mjs --dir <kb-dir> --name <kb-name> [--query "q"] [--variant big|small]'); process.exit(2); }
  // If no variant is requested, guard EVERY variant that exists on disk (small + big). Both must PASS.
  let variants;
  if (variant) variants = [variant];
  else {
    variants = [];
    if (fs.existsSync(path.join(dir, `${name}.rvf`))) variants.push('small');
    if (fs.existsSync(path.join(dir, `${name}.big.rvf`))) variants.push('big');
    // Preserve detailed diagnostics when nothing exists: checkStore() names every missing member
    // of the trio, while an early generic exit erases the actionable failure contract.
    if (variants.length === 0) variants.push('small');
  }

  let anyFail = false;
  for (const v of variants) {
    process.stdout.write(`\n=== GUARD: ${name} KB [${v}] (${dir}) ===\n`);
    const r = await checkStore({ dir, name, query, variant: v });
    if (r.model) console.log(`  model: ${r.model} | dim ${r.dim} | ${r.metric}`);
    for (const n of r.notes) console.log(`  [ok]   ${n}`);
    for (const f of r.fails) { console.log(`  [FAIL] ${f}`); anyFail = true; }
    console.log(`  result: ${r.fails.length ? 'FAIL' : 'PASS'}`);
  }
  console.log(`\n=== OVERALL: ${anyFail ? 'FAIL' : 'PASS'} ===`);
  process.exit(anyFail ? 1 : 0);
}
main().catch((e) => { console.error('forge-guard crashed:', e); process.exit(1); });
