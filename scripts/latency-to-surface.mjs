#!/usr/bin/env node
/**
 * latency-to-surface.mjs — the metric ADR-028 calls "the single best summary metric", finally measured.
 *
 * ADR-028:103 defines it: "time between a capability becoming dormant and the user being told."
 * Target "hours, not weeks", against a 21-day baseline that the ADR says "this whole project exists
 * to destroy." An independent grader on 2026-07-24 charged -6 against the Proactive pillar for it,
 * with a fair description: the 21-day baseline was still prose. Nothing recorded when a capability
 * went dormant, so nothing could subtract.
 *
 * WHY IT COULD NOT BE COMPUTED BEFORE, and what actually had to be built. The advocacy ledger already
 * records when we SPOKE (`action:'offered'`, with an `at`). That is one end of the subtraction. The
 * other end — when the capability BECAME dormant — existed nowhere, because the registry is a pure
 * detector: it reports the state it observes right now and keeps no history. A detector with no
 * memory can say "this is off"; it can never say "this has been off since Tuesday."
 *
 * So this file adds the missing half: an append-only log of capability state TRANSITIONS.
 *
 * ONLY TRANSITIONS, and that is a correctness decision rather than a disk-space one. If every
 * observation were appended, "when did it become dormant" would depend on how often the console
 * happened to be opened — a capability observed hourly would look freshly dormant, and the same
 * capability observed weekly would look dormant for a week, from identical facts. Recording only
 * changes makes the onset a property OF THE CAPABILITY rather than of our sampling schedule.
 *
 * WHAT COUNTS AS DORMANT — off and idle only.
 *   off     → present and not running. Dormant.
 *   idle    → set up, proven, nothing calling it. Dormant, and the state this product exists for.
 *   absent  → NOT dormant. It was never installed; there is nothing lying unused.
 *   unknown → NOT dormant. We could not establish the state, and "we could not tell" must never be
 *             silently converted into "it is off" — that is the fabrication this repo's registry
 *             rule exists to prevent, and it would inflate the metric with invented dormancy.
 *
 * THE HONEST NULL. With no history, every latency is `null`, never `0`. A fresh install has not
 * achieved instant surfacing; it has no measurement at all, and the difference is the whole
 * difference between this product and one that lies. `summarize()` reports `measured: 0` in that
 * case and every caller must render it as "not measured yet".
 *
 * THE NUMBER THAT MATTERS MOST is not the average of what we surfaced — it is `stillDark`: things
 * dormant right now that we have NEVER told the user about, with their clocks still running. A
 * project that only averages its successes reports a beautiful latency while a capability quietly
 * rots. Those are counted separately and never folded into the mean.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const HOME = os.homedir();

export const STATE_LOG_PATH = process.env.RUVNET_CAPABILITY_STATE_LOG
  || path.join(HOME, '.config', 'ruvnet-brain', 'capability-states.jsonl');

/** The states that mean "you have this, and it is not doing anything." See the header. */
export const DORMANT = new Set(['off', 'idle']);

const MAX_KEY = 120;
const MAX_LINE = 512;

/** Same never-throws contract as the advocacy ledger: an unreadable log degrades to "no history". */
export function loadStateLog(file = STATE_LOG_PATH) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch { continue; }
    if (!r || typeof r.key !== 'string' || typeof r.state !== 'string') continue;
    if (!Number.isFinite(Date.parse(r.at))) continue;
    out.push(r);
  }
  return out;
}

/** The most recent recorded state per key — what a new observation is compared against. */
function lastStates(log) {
  const last = new Map();
  for (const r of log) last.set(r.key, r);   // log is append-ordered
  return last;
}

/**
 * Record an observation, writing ONLY the keys whose state actually changed.
 *
 * Returns the transitions written, so a caller can act on them (and so a test can assert that a
 * repeated identical observation writes nothing — the property the whole metric depends on).
 */
export function recordObservation(rows, { file = STATE_LOG_PATH, at = new Date() } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string' && typeof r.state === 'string');
  if (!list.length) return [];

  const last = lastStates(loadStateLog(file));
  const iso = (at instanceof Date && !Number.isNaN(at.getTime())) ? at.toISOString() : new Date().toISOString();

  const transitions = [];
  for (const r of list) {
    const prev = last.get(r.key);
    if (prev && prev.state === r.state) continue;   // unchanged — the sampling schedule must not leak in
    transitions.push({
      v: 1,
      key: r.key.slice(0, MAX_KEY),
      state: r.state,
      from: prev ? prev.state : null,   // null = first time we ever saw this capability
      at: iso,
    });
  }
  if (!transitions.length) return [];

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = transitions.map((t) => JSON.stringify(t)).join('\n') + '\n';
    if (payload.length > MAX_LINE * transitions.length * 2) return [];   // absurd input: refuse rather than corrupt
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { return []; }   // an unwritable log must never break the console; it degrades to no history

  return transitions;
}

/**
 * When did this capability most recently BECOME dormant, and has it left dormancy since?
 * Returns the ISO instant of the latest entry into a dormant state that it is still in, else null.
 */
function currentDormancyOnset(entries) {
  let onset = null;
  for (const e of entries) {
    if (DORMANT.has(e.state)) { if (onset === null) onset = e.at; }
    else onset = null;   // left dormancy (on / absent / unknown) — any earlier clock is void
  }
  return onset;
}

/**
 * Join the state log against the advocacy ledger and compute the metric.
 *
 * `outcomes` is the advocacy ledger's rows (loadOutcomes()). Only `action:'offered'` counts as
 * "the user was told" — an apply or a dismissal is a REPLY to having been told, and using it would
 * measure the user's reaction time rather than ours.
 */
export function computeLatencies({ stateLog = loadStateLog(), outcomes = [], now = Date.now() } = {}) {
  const byKey = new Map();
  for (const e of stateLog) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }

  const toldAt = new Map();   // key → earliest 'offered' instant
  for (const o of outcomes) {
    if (!o || o.action !== 'offered' || typeof o.id !== 'string') continue;
    const t = Date.parse(o.at);
    if (!Number.isFinite(t)) continue;
    const prev = toldAt.get(o.id);
    if (prev === undefined || t < prev) toldAt.set(o.id, t);
  }

  const results = [];
  for (const [key, entries] of byKey) {
    const onsetIso = currentDormancyOnset(entries);
    if (onsetIso === null) continue;   // not dormant right now — nothing to measure
    const onset = Date.parse(onsetIso);
    if (!Number.isFinite(onset)) continue;

    // Only an offer made AT OR AFTER this dormancy began counts. An offer from a previous dormant
    // spell says nothing about whether we surfaced THIS one, and crediting it would let a single old
    // notification make every future lapse look instantly surfaced.
    const told = toldAt.get(key);
    const surfaced = Number.isFinite(told) && told >= onset;

    results.push({
      key,
      dormantSince: onsetIso,
      surfaced,
      latencyMs: surfaced ? told - onset : null,
      darkMs: surfaced ? null : Math.max(0, now - onset),
    });
  }
  return results;
}

/**
 * The reportable rollup. Everything here is `null` rather than `0` when unmeasured — see the header.
 */
export function summarize(rows) {
  const measuredRows = rows.filter((r) => r.surfaced && Number.isFinite(r.latencyMs));
  const dark = rows.filter((r) => !r.surfaced);
  const lat = measuredRows.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    dormantNow: rows.length,
    measured: lat.length,
    medianMs: lat.length ? lat[Math.floor((lat.length - 1) / 2)] : null,
    worstMs: lat.length ? lat[lat.length - 1] : null,
    // The number that matters most: dormant, never surfaced, clock running. Never averaged in.
    stillDark: dark.length,
    longestDarkMs: dark.length ? Math.max(...dark.map((r) => r.darkMs ?? 0)) : null,
    baselineDays: 21,   // ADR-028:103 — the number this project exists to destroy
  };
}

export function humanMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'not measured';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────
if (isDirectInvocation(import.meta.url)) {
  const { loadOutcomes } = await import('./advocacy-outcomes.mjs');
  const rows = computeLatencies({ outcomes: loadOutcomes() });
  const s = summarize(rows);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ summary: s, rows }, null, 2));
  } else {
    console.log('latency-to-surface — ADR-028\'s "single best summary metric"');
    console.log(`  baseline to beat : ${s.baselineDays}d`);
    console.log(`  dormant now      : ${s.dormantNow}`);
    if (!s.measured && !s.stillDark) {
      console.log('  measured         : nothing yet — no capability has gone dormant since logging began.');
      console.log('                     (This is "no data", NOT "instant". The distinction is the product.)');
    } else {
      console.log(`  median latency   : ${humanMs(s.medianMs)}  (from ${s.measured} surfaced)`);
      console.log(`  worst latency    : ${humanMs(s.worstMs)}`);
      if (s.stillDark) {
        console.log(`  STILL DARK       : ${s.stillDark} dormant and never surfaced — longest ${humanMs(s.longestDarkMs)} and counting`);
        console.log('                     These are excluded from the median on purpose: averaging only');
        console.log('                     the successes is how a rotting capability hides behind a good number.');
      }
    }
  }
}
