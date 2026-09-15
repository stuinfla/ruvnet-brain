/**
 * scripts/oracle/unit-sampling.mjs — deterministic stratified selection of min(100, U) source units.
 *
 * ADR-086:248: "Deterministically stratify and select min(100, U) units across modules and source
 * types." The exact procedure below is the one the EXTEND_FIRST Dual verdict (2026-09-14) specified:
 *
 *   stratum   = (source type, module), module = first repository-relative path component, root files
 *               assigned to the "(root)" module;
 *   K         = min(100, U);
 *   if |nonempty strata| <= K: one slot per stratum, then the remaining K - |strata| slots by HAMILTON
 *               (largest remainder) allocation proportional to each stratum's remaining capacity, ties
 *               broken by a published seeded hash ordering;
 *   if |nonempty strata| > K:  choose K strata by the seeded hash ordering, one unit each, and publish
 *               the omitted strata rather than claim comprehensive representation;
 *   within a stratum: order unit ids by SHA-256 of the canonical tuple
 *               [seed, repository, tree, stratum, unit id] and take the allocated prefix.
 *
 * Pure: no filesystem, no clock, no randomness. The same input yields the same selection in any process.
 */
import crypto from 'node:crypto';

export const SAMPLING_VERSION = 'oracle-unit-sampling/1';
export const MAX_SELECTED = 100;
export const DEFAULT_SEED = 'adr-086-c3/1';
export const ROOT_MODULE = '(root)';
// The tuple is encoded as a JSON array of strings. JSON.stringify on an array of strings is canonical:
// no key ordering exists and string escaping is fully specified.
export const TUPLE_ENCODING = 'json-array-of-strings/utf-8';

const sha256Hex = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const byHashThenId = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function moduleOf(unitPath) {
  const parts = String(unitPath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : ROOT_MODULE;
}

export function stratumOf(unit) {
  if (!unit?.sourceType) throw new Error(`unit ${unit?.unitId ?? '(unnamed)'} has no sourceType`);
  return `${unit.sourceType}|${moduleOf(unit.path)}`;
}

export function orderKey({ seed, repo, treeSha, stratum, unitId }) {
  return sha256Hex(JSON.stringify([seed, repo, treeSha, stratum, unitId]));
}

function stratumKey({ seed, repo, treeSha, stratum }) {
  return sha256Hex(JSON.stringify([seed, repo, treeSha, stratum]));
}

/** Slots per stratum. `sizes` maps stratum -> eligible unit count (> 0). */
export function allocate({ sizes, K, seed, repo, treeSha }) {
  const strata = [...sizes.entries()].filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id, n, key: stratumKey({ seed, repo, treeSha, stratum: id }) }))
    .sort(byHashThenId);
  const total = strata.reduce((s, x) => s + x.n, 0);
  if (!Number.isSafeInteger(K) || K < 0 || K > total) throw new Error(`cannot allocate K=${K} slots over ${total} units`);
  const slots = new Map(strata.map((s) => [s.id, 0]));
  if (K === 0) return { slots, omittedStrata: strata.map((s) => s.id) };

  if (strata.length > K) {
    // More strata than slots: K strata by seeded hash order, one unit each; the rest are published as omitted.
    strata.slice(0, K).forEach((s) => slots.set(s.id, 1));
    return { slots, omittedStrata: strata.slice(K).map((s) => s.id) };
  }

  strata.forEach((s) => slots.set(s.id, 1));
  let remaining = K - strata.length;
  const capacity = strata.map((s) => ({ ...s, cap: s.n - 1 }));
  const capTotal = capacity.reduce((s, x) => s + x.cap, 0);
  if (remaining > 0 && capTotal > 0) {
    // Hamilton: floor of each exact quota, then the leftover to the largest remainders. Remainders are
    // compared as exact integer numerators (remaining * cap mod capTotal) — no floating point.
    const quotas = capacity.map((s) => ({
      ...s,
      floor: Math.floor((remaining * s.cap) / capTotal),
      remainder: (remaining * s.cap) % capTotal,
    }));
    for (const q of quotas) slots.set(q.id, slots.get(q.id) + q.floor);
    let leftover = remaining - quotas.reduce((s, q) => s + q.floor, 0);
    const byRemainder = quotas
      .filter((q) => slots.get(q.id) < q.n)
      .sort((a, b) => (b.remainder - a.remainder) || byHashThenId(a, b));
    for (const q of byRemainder) {
      if (leftover === 0) break;
      slots.set(q.id, slots.get(q.id) + 1);
      leftover -= 1;
    }
    remaining = leftover;
  }
  if (remaining !== 0) throw new Error(`allocation left ${remaining} slot(s) unassigned`);
  return { slots, omittedStrata: [] };
}

/**
 * Select min(100, U) of `units` (each: { unitId, path, sourceType }). Returns the full publication record
 * the Dual verdict requires: U, K, seed, algorithm identity, per-stratum allocations, omitted strata and
 * the exact selected ids in selection order.
 */
export function selectUnits({ units, repo, treeSha, seed = DEFAULT_SEED, maxSelected = MAX_SELECTED }) {
  if (!repo || !treeSha) throw new Error('selectUnits requires the repository and tree identity it samples');
  const seen = new Set();
  const byStratum = new Map();
  for (const unit of units) {
    if (seen.has(unit.unitId)) throw new Error(`duplicate unit id ${unit.unitId}`);
    seen.add(unit.unitId);
    const stratum = stratumOf(unit);
    if (!byStratum.has(stratum)) byStratum.set(stratum, []);
    byStratum.get(stratum).push({ id: unit.unitId, key: orderKey({ seed, repo, treeSha, stratum, unitId: unit.unitId }) });
  }
  const U = units.length;
  const K = Math.min(maxSelected, U);
  const sizes = new Map([...byStratum].map(([s, list]) => [s, list.length]));
  const { slots, omittedStrata } = allocate({ sizes, K, seed, repo, treeSha });
  const selected = [];
  const allocations = [];
  for (const stratum of [...byStratum.keys()].sort()) {
    const take = slots.get(stratum) || 0;
    const ordered = byStratum.get(stratum).sort(byHashThenId);
    allocations.push({ stratum, eligible: ordered.length, selected: take });
    selected.push(...ordered.slice(0, take).map((u) => u.id));
  }
  if (selected.length !== K) throw new Error(`selected ${selected.length} units, expected K=${K}`);
  return {
    samplingVersion: SAMPLING_VERSION, tupleEncoding: TUPLE_ENCODING, seed, repo, treeSha,
    U, K, N: 2 * K, allocations, omittedStrata, selected,
  };
}
