#!/usr/bin/env node
// scripts/routing-flywheel.mjs — the MetaHarness FLYWHEEL over model routing.
//
// WHAT THIS IS. rUv's @metaharness/flywheel (verified on npm, 0.1.7, published by ruvnet) driving
// run → measure → mutate → verify → promote over THE EXECUTOR POLICY of our model router — the
// k-NN routing levers (qualityBar, k, escalation stance) that @metaharness/router consults on every
// routed prompt. ADR-226's measured lesson (a read-only advisor added ZERO resolves at 5.4× cost)
// says the winning lever is evolving the executor policy and promoting only proven changes — this
// file is exactly that, and nothing else.
//
// THE DISCIPLINE (docs/research/metaharness/ruv-doctrine-2026-07-16.md — non-negotiable):
//   • The gate is FROZEN: `meetsPromotionRule` from @metaharness/flywheel, never injectable here.
//     Its sha256 fingerprint is stamped on every receipt so an outsider can prove it never moved.
//   • The ANCHOR suite is never optimized against — a deterministic hash split of the labelled
//     routing outcomes; a holdout winner that regresses the anchor is REJECTED (engine-enforced).
//   • Injected seams: the Evaluator replays labelled rows at $0 (pure math, no model calls); the
//     Proposer is a real cheap model ONLY under --live with OPENROUTER_API_KEY — otherwise a mock,
//     and the whole run is labeled SYNTHETIC. A synthetic result is never dressed up as live.
//   • HARD caps (rUv's self-DDoS warning, from his own burned credits): ≤6 generations, ≤$0.50
//     proposer spend per run, ≤10 min wall clock. All three clamped, none overridable upward.
//   • NEVER ships an advisor, never touches the live path: a promoted policy is written to
//     policy.candidate.mjs — writing policy.mjs itself is refused in code. A HUMAN promotes.
//
// SEAM-LEVEL HONESTY NOTES (where this adapts the parent spec to the package's REAL API — verified
// against @metaharness/flywheel@0.1.7 dist/*.d.ts + run.js, not guessed):
//   • Score.regressed here = "evaluation hard-failed" (policy threw / no row evaluable). Anchor
//     degradation is enforced by the ENGINE's separate anchor-survival check (run.js line ~87),
//     not via the Score flag — the Evaluator scores one suite at a time and cannot see the anchor.
//   • The engine checks the budget at GENERATION boundaries only, so the live proposer ALSO
//     self-enforces per call: at/over cap (or past the wall clock) it returns the base lever
//     unchanged — a $0 no-op the frozen gate then rejects (noopRate must strictly improve).
//
// Usage:
//   node scripts/routing-flywheel.mjs [--dry-run|--synthetic|--live]
//        [--rows <jsonl>] [--cap <usd≤0.50>] [--max-generations <n≤6>]
//        [--out <candidate.mjs>] [--receipts <jsonl>] [--json]
//   --dry-run   (default) split + baseline scores of the live root policy. Reads only.
//   --synthetic full loop with the MOCK proposer — $0, labeled SYNTHETIC.
//   --live      real cheap proposer via OpenRouter. Requires OPENROUTER_API_KEY. Prints the spend
//               cap before the first call. Never run by automation — a human starts live runs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  runFlywheelGenerations,
  meetsPromotionRule,
  gateFingerprint,
  makeSigner,
  verifyReplayBundle,
  canon,
} from '@metaharness/flywheel';
import { effectivePrices, loadLabelledRows, OUTCOMES } from './metaharness-router.mjs';
import { assertEvolutionAllowed } from './metaharness-gate.mjs';
import { loadCatalog, applyProfile, loadProfile } from './model-router-engine.mjs';

// ─── HARD CAPS — the self-DDoS fence. Clamped, never raised by flags. ─────────────────────────────
export const HARD_MAX_GENERATIONS = 6;
export const HARD_CAP_USD = 0.5;
export const HARD_WALL_MS = 10 * 60 * 1000;

// ─── FROZEN evaluation constants. Not levers — a lever here would let the loop Goodhart the truth. ─
export const TRUTH_BAR = 0.7; // a labelled outcome ≥ this = that model genuinely sufficed
export const MIN_SUITE_ROWS = 3; // below this a "suite" is an anecdote, not evidence
const TIER_RANK = { cheap: 0, mid: 1, frontier: 2 };

// Gen-0 root = the engine's CURRENT live defaults (metaharness-router.mjs route(): qualityBar 0.7,
// k 5; escalate-to-frontier when nothing clears). The flywheel evolves FROM what actually runs.
export const ROOT_POLICY = Object.freeze({
  qualityBar: '0.70',
  k: '5',
  escalation: 'fallback=frontier margin=0.00',
});

export const CANDIDATE_PATH_DEFAULT = path.join(os.homedir(), '.claude', 'model-router', 'policy.candidate.mjs');
export const RECEIPTS_PATH_DEFAULT = path.join(os.homedir(), '.claude', 'metaharness', 'flywheel-receipts.jsonl');
// Cheapest tracked tool-capable model (catalog, price verified 2026-07-13 via OpenRouter API).
export const LIVE_PROPOSER_MODEL = 'deepseek/deepseek-v4-flash';

// ─── lever schema — the proposer's output is FILTERED on return ("a policy value can NEVER carry
// anything else", metaharness evals house rule). Unparseable proposals become $0 no-ops. ──────────
const LEVER_SCHEMA = {
  qualityBar: { kind: 'float', min: 0.5, max: 0.95, hint: 'min predicted quality (0.50–0.95) a candidate must clear to be picked' },
  k: { kind: 'int', min: 1, max: 15, hint: 'k-NN neighbours (1–15) used to predict per-model quality' },
  escalation: { kind: 'menu', hint: 'tokens only: "fallback=frontier|cheapest" (what to do when nothing clears the bar) and "margin=<0..0.2>" (extra quality headroom required)' },
};

export function parseEscalation(str) {
  const s = String(str ?? '');
  const fb = /fallback=(frontier|cheapest)/.exec(s);
  const mg = /margin=(\d+(?:\.\d+)?)/.exec(s);
  const margin = Math.max(0, Math.min(0.2, mg ? parseFloat(mg[1]) : 0));
  return { fallback: fb ? fb[1] : 'frontier', margin };
}

/** Clamp a proposed lever value to its schema. Menu levers are rebuilt from recognized tokens only —
 *  free prose never executes. On any failure the BASE value returns (an honest no-op, not a guess). */
export function clampLever(target, raw, baseValue) {
  const schema = LEVER_SCHEMA[target];
  if (!schema) return baseValue;
  const text = String(raw ?? '').trim();
  if (schema.kind === 'float' || schema.kind === 'int') {
    const m = /-?\d+(?:\.\d+)?/.exec(text);
    if (!m) return baseValue;
    let n = parseFloat(m[0]);
    if (!Number.isFinite(n)) return baseValue;
    n = Math.max(schema.min, Math.min(schema.max, n));
    return schema.kind === 'int' ? String(Math.round(n)) : n.toFixed(2);
  }
  // menu: extract only the tokens we execute; canonical form, nothing else survives.
  const e = parseEscalation(text);
  return `fallback=${e.fallback} margin=${e.margin.toFixed(2)}`;
}

// ─── the FROZEN deterministic split: holdout vs anchor, by content hash. No row is ever moved by a
// human or an optimizer; the anchor is defined by arithmetic, not by choice. ───────────────────────
export function splitRows(rows) {
  const holdout = [];
  const anchor = [];
  for (const row of rows) {
    const h = createHash('sha256').update(canon({ embedding: row.embedding, scores: row.scores })).digest('hex');
    (parseInt(h.slice(0, 8), 16) % 3 === 0 ? anchor : holdout).push(row);
  }
  return { holdout, anchor };
}

// ─── model-id resolution between outcome-row score keys and catalog ids (e.g. row "claude-haiku-4.5"
// vs catalog "claude-haiku-4-5-20251001"). Normalized prefix match — the same bug class as the
// {in,out} price-blend miss of 2026-07-16, killed here explicitly. ─────────────────────────────────
export function normalizeId(id) {
  return String(id).toLowerCase().replace(/\./g, '-');
}
export function idMatches(a, b) {
  const na = normalizeId(a);
  const nb = normalizeId(b);
  return na === nb || na.startsWith(nb + '-') || nb.startsWith(na + '-');
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
}

/**
 * THE EVALUATOR SEAM — pure, deterministic, $0. Replays a suite of labelled routing outcomes
 * ({embedding, scores}) against a candidate policy:
 *   predict  per-model quality by leave-one-out k-NN WITHIN the suite (holdout never sees anchor
 *            rows and vice versa — the anchor stays fully isolated),
 *   pick     the cheapest (effective price: subscription ⇒ $0) candidate clearing bar+margin,
 *            else the escalation fallback,
 *   judge    against the row's own labels: correct tier = tier of the cheapest model whose LABELLED
 *            quality ≥ TRUTH_BAR (frozen), frontier if none sufficed.
 * Score axes (projected per @metaharness/flywheel's Score):
 *   primary    = fraction of correct-tier picks
 *   noopRate   = fraction routed to frontier unnecessarily (the wasted-capacity signal)
 *   costPerWin = Σ effective blended $/Mtok of picks ÷ wins — 999 sentinel on zero wins, so a
 *                policy that wins nothing can never look "cheap"
 *   regressed  = evaluation hard-failure only (anchor degradation is the engine's separate check)
 */
export function makeEvaluator({ catalog, profile }) {
  const pool = applyProfile(catalog, profile).filter(
    (c) => (c.harness || []).includes('claude-code') && TIER_RANK[c.tier] !== undefined
  );
  const prices = effectivePrices(pool, profile);
  const priceOf = (id) => (Number.isFinite(prices[id]) ? prices[id] : 999); // unpriced = penalized, never free

  const scoreFor = (scores, cand) => {
    for (const key of Object.keys(scores)) if (idMatches(key, cand.id)) return scores[key];
    return null;
  };

  return async function evaluate(policy, suite) {
    const rows = suite.items;
    const bar = Math.max(0.5, Math.min(0.95, parseFloat(policy.qualityBar) || 0.7));
    const k = Math.max(1, Math.min(15, Math.round(parseFloat(policy.k) || 5)));
    const esc = parseEscalation(policy.escalation);

    let evaluated = 0;
    let correct = 0;
    let unnecessaryFrontier = 0;
    let costSum = 0;
    let errors = 0;

    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i];
        // ground truth: which tier did the labels prove sufficient?
        const sufficient = pool.filter((c) => {
          const s = scoreFor(row.scores, c);
          return typeof s === 'number' && s >= TRUTH_BAR;
        });
        const anyResolvable = pool.some((c) => scoreFor(row.scores, c) !== null);
        if (!anyResolvable) continue; // no resolvable labels ⇒ no ground truth ⇒ excluded, not faked
        const correctTier = sufficient.length
          ? Object.keys(TIER_RANK).find((t) => TIER_RANK[t] === Math.min(...sufficient.map((c) => TIER_RANK[c.tier])))
          : 'frontier';

        // predict: leave-one-out k-NN within THIS suite (index-asc tiebreak ⇒ fully deterministic)
        const neighbours = rows
          .map((r, j) => ({ r, j, sim: j === i ? -Infinity : cosine(row.embedding, r.embedding) }))
          .filter((x) => x.j !== i)
          .sort((a, b) => b.sim - a.sim || a.j - b.j)
          .slice(0, k);
        const predicted = pool
          .map((c) => {
            const vals = neighbours.map((n) => scoreFor(n.r.scores, c)).filter((v) => typeof v === 'number');
            return vals.length ? { c, q: vals.reduce((s, v) => s + v, 0) / vals.length } : null;
          })
          .filter(Boolean);

        // pick: cheapest clearing candidate, else the escalation fallback
        const clearing = predicted
          .filter((p) => p.q >= bar + esc.margin)
          .sort((a, b) => priceOf(a.c.id) - priceOf(b.c.id) || TIER_RANK[a.c.tier] - TIER_RANK[b.c.tier] || a.c.id.localeCompare(b.c.id));
        let pick;
        if (clearing.length) pick = clearing[0].c;
        else if (esc.fallback === 'cheapest') {
          pick = pool.slice().sort((a, b) => priceOf(a.id) - priceOf(b.id) || TIER_RANK[a.tier] - TIER_RANK[b.tier])[0];
        } else {
          pick = pool
            .filter((c) => c.tier === 'frontier')
            .sort((a, b) => priceOf(a.id) - priceOf(b.id))[0] || pool[0];
        }
        if (!pick) throw new Error('empty candidate pool');

        evaluated++;
        if (pick.tier === correctTier) correct++;
        if (pick.tier === 'frontier' && correctTier !== 'frontier') unnecessaryFrontier++;
        costSum += priceOf(pick.id);
      } catch {
        errors++;
      }
    }

    if (evaluated === 0) return { primary: 0, noopRate: 1, costPerWin: 999, regressed: true };
    return {
      primary: correct / evaluated,
      noopRate: unnecessaryFrontier / evaluated,
      costPerWin: correct === 0 ? 999 : +(costSum / correct).toFixed(6),
      regressed: errors > 0,
    };
  };
}

// ─── THE PROPOSER SEAMS ────────────────────────────────────────────────────────────────────────────

/** Mock proposer — deterministic scripted lever values, schema-clamped. $0. Any run driven by this
 *  is labeled SYNTHETIC: it proves the machinery, it is NOT evidence a live loop would find lift. */
export function makeMockProposer(script) {
  const DEFAULT_SCRIPT = {
    qualityBar: ['0.75', '0.72', '0.68', '0.80', '0.65', '0.70'],
    k: ['7', '3', '9', '5', '2', '11'],
    escalation: [
      'fallback=cheapest margin=0.00',
      'fallback=frontier margin=0.05',
      'fallback=cheapest margin=0.02',
      'fallback=frontier margin=0.10',
      'fallback=cheapest margin=0.05',
      'fallback=frontier margin=0.00',
    ],
  };
  const seen = {};
  return async (base, target) => {
    const seq = (script && script[target]) || DEFAULT_SCRIPT[target] || [];
    const i = (seen[target] = (seen[target] ?? -1) + 1);
    const raw = seq[i % Math.max(1, seq.length)] ?? base.policy[target];
    return clampLever(target, raw, base.policy[target]);
  };
}

/** Live proposer — ONE cheap model call per (lever, generation) via OpenRouter. Self-enforcing:
 *  at/over the cap or past the wall clock it returns the base value unchanged ($0 no-op) because the
 *  engine only checks the budget at generation boundaries. Spend = real usage tokens × verified
 *  catalog price; a response without usage is counted by chars/4 estimate, never as free. */
export function makeLiveProposer({ apiKey, model, price, spend, capUSD, deadline, clock = Date.now, fetchImpl = fetch }) {
  if (!price || typeof price.in !== 'number' || typeof price.out !== 'number') {
    throw new Error(`live proposer refused: no verified price for ${model} — an unpriced spend loop is the self-DDoS rUv warned about`);
  }
  return async (base, target) => {
    if (spend.usd >= capUSD || clock() >= deadline) {
      spend.aborted = true;
      return base.policy[target]; // $0 no-op — the frozen gate will reject the unchanged candidate
    }
    const schema = LEVER_SCHEMA[target];
    const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 60,
        messages: [
          {
            role: 'system',
            content: 'You tune ONE lever of a cost-optimal model-routing policy. Goal: more correct-tier picks, fewer unnecessary frontier escalations, lower cost per win. Reply with the new lever value ONLY — no prose.',
          },
          {
            role: 'user',
            content: `Lever "${target}" (${schema.hint}). Current policy: ${JSON.stringify(base.policy)}. Propose a better value for "${target}".`,
          },
        ],
      }),
    });
    const j = await res.json().catch(() => ({}));
    const pt = j?.usage?.prompt_tokens ?? 200; // conservative fallback — never count a call as free
    const ct = j?.usage?.completion_tokens ?? 60;
    spend.usd += (pt * price.in + ct * price.out) / 1e6;
    spend.calls++;
    if (spend.usd >= capUSD) spend.aborted = true;
    const text = j?.choices?.[0]?.message?.content ?? '';
    return clampLever(target, text, base.policy[target]);
  };
}

// ─── candidate artifact — NEVER the live policy. A human promotes. ─────────────────────────────────

export function renderCandidateModule({ rootPolicy, finalPolicy, provenance }) {
  const params = {
    qualityBar: parseFloat(finalPolicy.qualityBar),
    k: Math.round(parseFloat(finalPolicy.k)),
    escalation: parseEscalation(finalPolicy.escalation),
  };
  const diff = Object.keys(rootPolicy)
    .map((t) => `//   ${t}: ${JSON.stringify(rootPolicy[t])}${rootPolicy[t] === finalPolicy[t] ? ' (unchanged)' : ` -> ${JSON.stringify(finalPolicy[t])}`}`)
    .join('\n');
  return `// ~/.claude/model-router/policy.candidate.mjs — FLYWHEEL-PROMOTED CANDIDATE. NOT LIVE.
// Written by scripts/routing-flywheel.mjs (ruvnet-brain). The flywheel NEVER writes policy.mjs —
// a HUMAN promotes, after reviewing this diff and the signed receipt:
//   review, then:  cp ~/.claude/model-router/policy.candidate.mjs ~/.claude/model-router/policy.mjs
//
// Diff vs gen-0 root (the engine's live defaults):
${diff}
//
// PROVENANCE (frozen gate ${provenance.gate_fingerprint.slice(0, 16)}…, data_source=${provenance.data_source}):
// ${JSON.stringify({ ts: provenance.ts, lift_curve: provenance.lift_curve, chain: provenance.chain, signer_public_key: provenance.signer_public_key })}
//
// routerParams = the EVOLVED executor levers for the @metaharness/router call (metaharness-router.mjs
// route() currently uses its own defaults; wiring it to read a promoted policy's routerParams is the
// human's promotion step, alongside the cp above).
export const levers = ${JSON.stringify(finalPolicy, null, 2)};
export const routerParams = ${JSON.stringify(params, null, 2)};
export const provenance = ${JSON.stringify(provenance, null, 2)};
// The cold-start fallback heuristic is deliberately UNCHANGED — the flywheel evolved the k-NN
// routing levers above, not the prose heuristic. Same-directory re-export keeps it byte-identical.
export { choose } from './policy.default.mjs';
`;
}

export function writeCandidatePolicy(filePath, content) {
  const base = path.basename(filePath);
  if (base === 'policy.mjs' || base === 'policy.default.mjs') {
    throw new Error(`refusing to write ${base} — the flywheel never touches the live policy; candidates go to policy.candidate.mjs and a HUMAN promotes`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function appendReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
}

// ─── THE RUN ───────────────────────────────────────────────────────────────────────────────────────

export async function runRoutingFlywheel(opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'synthetic';
  // HARD caps — Math.min means a flag can lower them, never raise them.
  const capUSD = Math.min(opts.capUSD ?? HARD_CAP_USD, HARD_CAP_USD);
  const maxGenerations = Math.min(opts.maxGenerations ?? HARD_MAX_GENERATIONS, HARD_MAX_GENERATIONS);
  const wallMs = Math.min(opts.wallMs ?? HARD_WALL_MS, HARD_WALL_MS);
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const deadline = t0 + wallMs;

  const loaded = opts.rows ? { rows: opts.rows, unusable: 0 } : loadLabelledRows(opts.rowsFile || OUTCOMES);
  const { holdout, anchor } = splitRows(loaded.rows);
  if (holdout.length < MIN_SUITE_ROWS || anchor.length < MIN_SUITE_ROWS) {
    throw new Error(
      `not enough labelled routing outcomes to run honestly: holdout=${holdout.length}, anchor=${anchor.length} (need ≥${MIN_SUITE_ROWS} each, from ${loaded.rows.length} usable rows). ` +
        `Every routed task appends a label (metaharness-router recordOutcome) — this unblocks with use, not with synthetic padding.`
    );
  }

  const catalog = opts.catalog ?? loadCatalog();
  const profile = opts.profile !== undefined ? opts.profile : loadProfile();
  const evaluator = opts.evaluator ?? makeEvaluator({ catalog, profile });

  const spend = opts.spendState ?? { usd: 0, calls: 0, aborted: false };
  let proposer;
  let dataSource;
  if (mode === 'live') {
    // A live proposer is the only path that can spend metered credits. Require an external,
    // measured score/OIA/drift receipt and its explicit spend opt-in before constructing it.
    // Synthetic replay remains available without this gate and never makes a paid call.
    assertEvolutionAllowed(opts.gateReceipt);
    if (!opts.apiKey) throw new Error('--live requires OPENROUTER_API_KEY');
    const model = opts.proposerModel ?? LIVE_PROPOSER_MODEL;
    const entry = catalog.find((c) => c.id === model);
    proposer = makeLiveProposer({
      apiKey: opts.apiKey,
      model,
      price: entry?.costPerMTok,
      spend,
      capUSD,
      deadline,
      clock,
      fetchImpl: opts.fetchImpl,
    });
    dataSource = 'LIVE';
  } else {
    proposer = opts.proposer ?? makeMockProposer(opts.proposerScript);
    dataSource = 'SYNTHETIC'; // any mock- or injected-proposer run is synthetic, full stop
  }

  const signer = makeSigner();
  const rootPolicy = { ...(opts.rootPolicy ?? ROOT_POLICY) };
  const runIso = new Date().toISOString();

  const result = await runFlywheelGenerations({
    rootPolicy,
    proposer,
    evaluator,
    // THE FROZEN GATE. Deliberately NOT read from opts — there is no seam to soften it.
    promotionRule: meetsPromotionRule,
    holdout: { id: 'routing-holdout', items: holdout },
    anchor: { id: 'routing-anchor', items: anchor },
    maxGenerations,
    signer,
    // wall-clock folded into spent(): past the deadline the budget reads as exhausted.
    budget: { total: capUSD, spent: () => spend.usd + (clock() >= deadline ? capUSD : 0) },
    now: (g) => `${runIso}#gen${g}`,
    dataSource,
  });

  const fp = gateFingerprint(meetsPromotionRule);
  const verdict = verifyReplayBundle(result.replayBundle, { pinnedGateFingerprint: fp, promotionRule: meetsPromotionRule });
  const promoted = result.promotions.filter((c) => c.verdict === 'PROMOTED');
  // If a caller supplied the measured MetaHarness preflight, its promotion decision is an
  // additional fail-closed wall. Live evolution may run only after explicit spend consent, but
  // it never self-promotes; synthetic replay can be promoted only when the caller's receipt says
  // so. The historical no-receipt path remains compatible for the $0 unit harness.
  const promotionGate = opts.gateReceipt ? opts.gateReceipt.promotion?.allowed === true : true;

  let candidatePath = null;
  if (promoted.length && promotionGate) {
    const provenance = {
      ts: runIso,
      mode,
      data_source: dataSource,
      gate_fingerprint: fp,
      lift_curve: result.replayBundle.lift_curve,
      chain: promoted.map((c) => ({ id: c.id, target: c.mutation?.target, primaryDelta: c.primaryDelta, anchorScore: c.anchorScore, receipt: c.receipt })),
      signer_public_key: signer.publicKey(),
      bundle_verified: verdict.pass,
      rows: { usable: loaded.rows.length, holdout: holdout.length, anchor: anchor.length },
    };
    candidatePath = writeCandidatePolicy(
      opts.candidatePath ?? CANDIDATE_PATH_DEFAULT,
      renderCandidateModule({ rootPolicy, finalPolicy: result.finalPolicy, provenance })
    );
  }

  const receipt = {
    kind: 'flywheel-run',
    ts: runIso,
    mode,
    data_source: dataSource,
    gate_fingerprint: fp,
    bundle_verified: verdict.pass,
    bundle_checks: verdict.checks,
    rows: { usable: loaded.rows.length, unusable: loaded.unusable, holdout: holdout.length, anchor: anchor.length },
    root_policy: rootPolicy,
    final_policy: result.finalPolicy,
    generations_run: result.generationsRun,
    max_generations: maxGenerations,
    cap_usd: capUSD,
    wall_ms: clock() - t0,
    spent_usd: +spend.usd.toFixed(6),
    proposer_calls: spend.calls,
    budget_aborted: spend.aborted || spend.usd + (clock() >= deadline ? capUSD : 0) >= capUSD,
    promotions: promoted.map((c) => ({ id: c.id, target: c.mutation?.target, primaryDelta: +c.primaryDelta.toFixed(4), anchorScore: c.anchorScore })),
    rejected: result.replayBundle.all_commits.filter((c) => c.verdict === 'REJECTED').length,
    lift_curve: result.replayBundle.lift_curve,
    milestone_reached: result.milestoneReached,
    candidate_path: candidatePath,
    promotion_gate: opts.gateReceipt ? { allowed: promotionGate, reason: opts.gateReceipt.promotion?.reason || null } : null,
    signer_public_key: signer.publicKey(),
  };
  appendReceipt(opts.receiptsFile ?? RECEIPTS_PATH_DEFAULT, receipt);

  return { result, receipt, verdict, candidatePath, suites: { holdout: holdout.length, anchor: anchor.length } };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { mode: 'dry-run', json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.mode = 'dry-run';
    else if (k === '--synthetic') a.mode = 'synthetic';
    else if (k === '--live') a.mode = 'live';
    else if (k === '--rows') a.rowsFile = argv[++i];
    else if (k === '--cap') a.capUSD = parseFloat(argv[++i]);
    else if (k === '--max-generations') a.maxGenerations = parseInt(argv[++i], 10);
    else if (k === '--out') a.candidatePath = argv[++i];
    else if (k === '--receipts') a.receiptsFile = argv[++i];
    else if (k === '--json') a.json = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function printLeverDiff(root, final) {
  for (const t of Object.keys(root)) {
    const changed = root[t] !== final[t];
    process.stdout.write(`  ${t}: ${root[t]}${changed ? ` -> ${final[t]}  (CHANGED)` : '  (unchanged)'}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    // lines 33–42 = the "// Usage:" block in this file's header comment
    process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(32, 40).join('\n') + '\n');
    return;
  }

  if (args.mode === 'dry-run') {
    const loaded = loadLabelledRows(args.rowsFile || OUTCOMES);
    const { holdout, anchor } = splitRows(loaded.rows);
    const out = {
      mode: 'dry-run',
      rows: { usable: loaded.rows.length, unusable: loaded.unusable, holdout: holdout.length, anchor: anchor.length },
      root_policy: ROOT_POLICY,
      gate_fingerprint: gateFingerprint(meetsPromotionRule),
      baseline: null,
      runnable: holdout.length >= MIN_SUITE_ROWS && anchor.length >= MIN_SUITE_ROWS,
    };
    if (out.runnable) {
      const evaluate = makeEvaluator({ catalog: loadCatalog(), profile: loadProfile() });
      out.baseline = {
        holdout: await evaluate(ROOT_POLICY, { id: 'routing-holdout', items: holdout }),
        anchor: await evaluate(ROOT_POLICY, { id: 'routing-anchor', items: anchor }),
      };
    } else {
      out.note = `need ≥${MIN_SUITE_ROWS} rows in BOTH suites before a run is honest — every routed task appends a label`;
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  const opts = { ...args, mode: args.mode };
  if (args.mode === 'live') {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      process.stderr.write('routing-flywheel: --live requires OPENROUTER_API_KEY in the environment. Refusing to start.\n');
      process.exit(2);
    }
    opts.apiKey = apiKey;
    const cap = Math.min(args.capUSD ?? HARD_CAP_USD, HARD_CAP_USD);
    // The cap banner PRINTS BEFORE the first paid call — rUv's self-DDoS lesson, stated up front.
    process.stdout.write(
      `LIVE flywheel run — HARD caps: proposer spend ≤ $${cap.toFixed(2)}, wall clock ≤ ${HARD_WALL_MS / 60000} min, ` +
        `generations ≤ ${Math.min(args.maxGenerations ?? HARD_MAX_GENERATIONS, HARD_MAX_GENERATIONS)}. ` +
        `Proposer: ${LIVE_PROPOSER_MODEL} via OpenRouter. At the cap the proposer becomes a $0 no-op and the run winds down.\n`
    );
  }

  const { receipt, candidatePath } = await runRoutingFlywheel(opts);

  if (args.json) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  } else {
    process.stdout.write(`flywheel run (${receipt.data_source}) — ${receipt.generations_run} generation(s), ${receipt.promotions.length} promotion(s), ${receipt.rejected} rejection(s)\n`);
    process.stdout.write(`gate ${receipt.gate_fingerprint.slice(0, 16)}… frozen; replay bundle verified: ${receipt.bundle_verified}\n`);
    process.stdout.write(`suites: holdout=${receipt.rows.holdout} anchor=${receipt.rows.anchor} (from ${receipt.rows.usable} labelled rows)\n`);
    process.stdout.write(`spend: $${receipt.spent_usd} of $${receipt.cap_usd} cap, ${receipt.proposer_calls} proposer call(s), ${receipt.wall_ms}ms\n`);
    process.stdout.write('levers (gen-0 -> final):\n');
    printLeverDiff(receipt.root_policy, receipt.final_policy);
    if (candidatePath) {
      process.stdout.write(`\nPROMOTED CANDIDATE written to ${candidatePath} — NOT live.\n`);
      process.stdout.write(`A HUMAN promotes: review the file, then  cp ${candidatePath} ${path.join(path.dirname(candidatePath), 'policy.mjs')}\n`);
      process.stdout.write(`signed head receipt: ${JSON.stringify(receipt.promotions[0])}\n`);
    } else {
      process.stdout.write('\nNo candidate cleared the frozen gate — nothing was written. That is the gate working, not a failure (ADR-226: assume no improvement loop helps until the gate says it did).\n');
    }
    process.stdout.write(`receipt appended: ${args.receiptsFile ?? RECEIPTS_PATH_DEFAULT}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`routing-flywheel: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
