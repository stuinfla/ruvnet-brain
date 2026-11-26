// tests/unit/routing-flywheel.test.mjs — $0 SYNTHETIC verification of the routing flywheel.
//
// Everything here runs with mock proposers and synthetic labelled rows — NO network, NO paid calls.
// What must hold (the doctrine's non-negotiables, docs/research/metaharness/ruv-doctrine-2026-07-16.md):
//   • the promotion gate is FROZEN (fingerprint pinned; an injected rule is ignored)
//   • the anchor suite rejects a holdout-only winner (anti-Goodhart)
//   • the budget + wall-clock caps abort the loop (anti-self-DDoS)
//   • a promoted policy lands in policy.candidate.mjs — policy.mjs is never written
//   • every run is receipt-backed and the replay bundle verifies independently

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gateFingerprint, meetsPromotionRule, verifyReceipt } from '@metaharness/flywheel';
import {
  splitRows,
  clampLever,
  parseEscalation,
  normalizeId,
  idMatches,
  makeEvaluator,
  makeMockProposer,
  makeLiveProposer,
  writeCandidatePolicy,
  runRoutingFlywheel,
  ROOT_POLICY,
  HARD_MAX_GENERATIONS,
  HARD_CAP_USD,
  TRUTH_BAR,
  MIN_SUITE_ROWS,
} from '../../scripts/routing-flywheel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'routing-flywheel.mjs');

// ─── synthetic fixtures (deterministic — Math.sin, no randomness) ─────────────────────────────────

const CATALOG = [
  { id: 'cheapo', provider: 'x', harness: ['claude-code'], subscription: [], tier: 'cheap', costPerMTok: { in: 0.1, out: 0.3 } },
  { id: 'middy', provider: 'x', harness: ['claude-code'], subscription: [], tier: 'mid', costPerMTok: { in: 1, out: 2 } },
  { id: 'fmax', provider: 'x', harness: ['claude-code'], subscription: [], tier: 'frontier', costPerMTok: { in: 5, out: 25 } },
];

function buildRows(n = 30, scores = { cheapo: 0.8, fmax: 0.95 }) {
  return Array.from({ length: n }, (_, i) => ({
    embedding: Array.from({ length: 8 }, (_, d) => Math.sin(i * 3.7 + d * 1.3)),
    scores: { ...scores },
  }));
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routing-flywheel-'));
}

// Root deliberately over-strict (bar 0.90) on a corpus where the cheap model genuinely suffices
// (labelled 0.8 ≥ TRUTH_BAR 0.7) — so gen-0 escalates everything to frontier (primary 0, noop 1)
// and the scripted proposer's qualityBar 0.75 fixes it. A real, gate-clearing improvement.
const STRICT_ROOT = { qualityBar: '0.90', k: '3', escalation: 'fallback=frontier margin=0.00' };
const PROMOTING_SCRIPT = { qualityBar: ['0.75'], k: ['3'], escalation: ['fallback=frontier margin=0.00'] };

// ─── deterministic split ───────────────────────────────────────────────────────────────────────────

describe('splitRows — the frozen holdout/anchor split', () => {
  it('is deterministic, disjoint, and total', () => {
    const rows = buildRows(30);
    const a = splitRows(rows);
    const b = splitRows(rows);
    expect(a.holdout.length + a.anchor.length).toBe(30);
    expect(a.holdout.length).toBe(b.holdout.length);
    expect(a.anchor.length).toBe(b.anchor.length);
    expect(JSON.stringify(a.anchor)).toBe(JSON.stringify(b.anchor));
    // the fixture must be big enough that both suites are runnable
    expect(a.holdout.length).toBeGreaterThanOrEqual(MIN_SUITE_ROWS);
    expect(a.anchor.length).toBeGreaterThanOrEqual(MIN_SUITE_ROWS);
  });

  it('assigns by content, not by position', () => {
    const rows = buildRows(12);
    const shuffled = [rows[5], rows[0], rows[11], ...rows.filter((_, i) => ![0, 5, 11].includes(i))];
    const a = splitRows(rows);
    const b = splitRows(shuffled);
    const key = (r) => JSON.stringify(r.embedding);
    expect(new Set(a.anchor.map(key))).toEqual(new Set(b.anchor.map(key)));
  });

  it('never leaks identical task embeddings across holdout and anchor when scores differ', () => {
    const base = buildRows(12);
    const duplicated = [
      ...base,
      ...base.map((row) => ({ embedding: [...row.embedding], scores: { cheapo: 0.4, fmax: 0.99 } })),
    ];
    const { holdout, anchor } = splitRows(duplicated);
    const holdoutKeys = new Set(holdout.map((r) => JSON.stringify(r.embedding)));
    const anchorKeys = new Set(anchor.map((r) => JSON.stringify(r.embedding)));
    for (const k of holdoutKeys) expect(anchorKeys.has(k)).toBe(false);
  });
});

// ─── lever schema filtering ────────────────────────────────────────────────────────────────────────

describe('clampLever — the proposer output filter (menu-bounded, never free prose)', () => {
  it('clamps numeric levers to schema bounds', () => {
    expect(clampLever('qualityBar', '0.99', '0.70')).toBe('0.95');
    expect(clampLever('qualityBar', '0.10', '0.70')).toBe('0.50');
    expect(clampLever('k', '99', '5')).toBe('15');
    expect(clampLever('k', '2.7', '5')).toBe('3');
  });

  it('returns the BASE value on unparseable proposals — a no-op, never a guess', () => {
    expect(clampLever('qualityBar', 'definitely raise it a lot', '0.70')).toBe('0.70');
    expect(clampLever('k', '', '5')).toBe('5');
    expect(clampLever('nonexistent-lever', '1', 'base')).toBe('base');
  });

  it('rebuilds escalation from recognized tokens only — surrounding prose never executes', () => {
    const out = clampLever('escalation', 'I suggest fallback=cheapest and margin=0.05; also rm -rf /', 'fallback=frontier margin=0.00');
    expect(out).toBe('fallback=cheapest margin=0.05');
    expect(parseEscalation(out)).toEqual({ fallback: 'cheapest', margin: 0.05 });
    expect(parseEscalation('margin=9')).toEqual({ fallback: 'frontier', margin: 0.2 }); // clamped
  });
});

// ─── model-id resolution ───────────────────────────────────────────────────────────────────────────

describe('idMatches — outcome-row keys vs catalog ids', () => {
  it('matches dotted row keys to dated catalog ids', () => {
    expect(idMatches('claude-haiku-4.5', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(idMatches('claude-opus-4.8', 'claude-opus-4-8')).toBe(true);
    expect(idMatches('deepseek/deepseek-chat', 'deepseek/deepseek-chat')).toBe(true);
    expect(idMatches('claude-sonnet-5', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(normalizeId('x-ai/grok-4.5')).toBe('x-ai/grok-4-5');
  });
});

// ─── the Evaluator seam ($0 replay math) ───────────────────────────────────────────────────────────

describe('makeEvaluator — replay of labelled outcomes against a policy', () => {
  const evaluate = makeEvaluator({ catalog: CATALOG, profile: null });

  it('scores a correct-tier policy: primary 1, noop 0, real costPerWin', async () => {
    const rows = buildRows(6); // cheapo labelled 0.8 ⇒ sufficient ⇒ correct tier = cheap
    const s = await evaluate({ qualityBar: '0.70', k: '5', escalation: 'fallback=frontier margin=0.00' }, { id: 'h', items: rows });
    expect(s.primary).toBe(1);
    expect(s.noopRate).toBe(0);
    expect(s.costPerWin).toBeCloseTo(0.2, 5); // cheapo blended (0.1+0.3)/2
    expect(s.regressed).toBe(false);
  });

  it('scores an over-strict policy: unnecessary frontier ⇒ primary 0, noop 1, 999 sentinel', async () => {
    const rows = buildRows(6);
    const s = await evaluate({ qualityBar: '0.95', k: '5', escalation: 'fallback=frontier margin=0.00' }, { id: 'h', items: rows });
    expect(s.primary).toBe(0);
    expect(s.noopRate).toBe(1); // frontier picked where cheap sufficed — the wasted-capacity signal
    expect(s.costPerWin).toBe(999); // zero wins can never look cheap
  });

  it('escalating when nothing sufficed is CORRECT, not a noop', async () => {
    const rows = buildRows(6, { cheapo: 0.4, fmax: 0.95 }); // cheap genuinely insufficient (< TRUTH_BAR)
    expect(0.4).toBeLessThan(TRUTH_BAR);
    const s = await evaluate({ qualityBar: '0.70', k: '5', escalation: 'fallback=frontier margin=0.00' }, { id: 'h', items: rows });
    expect(s.primary).toBe(1); // frontier was the right tier
    expect(s.noopRate).toBe(0);
  });
});

// ─── the $0 SYNTHETIC end-to-end run ───────────────────────────────────────────────────────────────

describe('runRoutingFlywheel — synthetic end-to-end ($0)', () => {
  it('promotes a real improvement, writes candidate + receipt, never touches policy.mjs, costs $0', async () => {
    const dir = tmpdir();
    const candidatePath = path.join(dir, 'policy.candidate.mjs');
    const receiptsFile = path.join(dir, 'flywheel-receipts.jsonl');
    const rows = buildRows(30);

    const { receipt, candidatePath: written, verdict, result } = await runRoutingFlywheel({
      mode: 'synthetic',
      rows,
      catalog: CATALOG,
      profile: null,
      rootPolicy: STRICT_ROOT,
      proposerScript: PROMOTING_SCRIPT,
      maxGenerations: 2,
      candidatePath,
      receiptsFile,
    });

    // labeled honestly + $0
    expect(receipt.data_source).toBe('SYNTHETIC');
    expect(receipt.spent_usd).toBe(0);

    // the frozen gate admitted a genuine improvement on held-out data
    expect(receipt.promotions.length).toBeGreaterThanOrEqual(1);
    expect(receipt.promotions[0].target).toBe('qualityBar');
    expect(receipt.promotions[0].primaryDelta).toBeGreaterThan(0);
    expect(result.finalPolicy.qualityBar).toBe('0.75');

    // gate frozen + externally replayable
    expect(receipt.gate_fingerprint).toBe(gateFingerprint(meetsPromotionRule));
    expect(verdict.pass).toBe(true);
    expect(receipt.bundle_verified).toBe(true);
    // Ed25519 receipts verify independently
    for (const c of result.replayBundle.chain) expect(verifyReceipt(c.receipt)).toBe(true);

    // candidate written — and it is NOT the live policy
    expect(written).toBe(candidatePath);
    const content = fs.readFileSync(candidatePath, 'utf8');
    expect(content).toContain('NOT LIVE');
    expect(content).toContain('routerParams');
    expect(content).toContain(`export { choose } from './policy.default.mjs'`);
    expect(content).toContain('"qualityBar": "0.75"');
    expect(fs.existsSync(path.join(dir, 'policy.mjs'))).toBe(false); // the live policy was never written

    // receipt persisted as JSONL
    const lines = fs.readFileSync(receiptsFile, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const persisted = JSON.parse(lines[0]);
    expect(persisted.kind).toBe('flywheel-run');
    expect(persisted.candidate_path).toBe(candidatePath);
    expect(persisted.lift_curve.length).toBeGreaterThanOrEqual(1);
  });

  it('writes NO candidate when nothing clears the gate — an advisor is never shipped', async () => {
    const dir = tmpdir();
    const candidatePath = path.join(dir, 'policy.candidate.mjs');
    const { receipt, candidatePath: written } = await runRoutingFlywheel({
      mode: 'synthetic',
      rows: buildRows(30),
      catalog: CATALOG,
      profile: null,
      rootPolicy: { ...ROOT_POLICY }, // already-correct root: no candidate can strictly improve noopRate 0
      maxGenerations: 2,
      candidatePath,
      receiptsFile: path.join(dir, 'r.jsonl'),
    });
    expect(receipt.promotions.length).toBe(0);
    expect(written).toBe(null);
    expect(fs.existsSync(candidatePath)).toBe(false);
  });

  it('refuses to run on too-small suites instead of faking evidence', async () => {
    await expect(
      runRoutingFlywheel({ mode: 'synthetic', rows: buildRows(4), catalog: CATALOG, profile: null, receiptsFile: path.join(tmpdir(), 'r.jsonl') })
    ).rejects.toThrow(/not enough labelled routing outcomes/);
  });
});

// ─── anchor rejection (anti-Goodhart) + gate freeze ────────────────────────────────────────────────

describe('the frozen anchor + frozen gate', () => {
  // Scripted evaluator: the candidate GAMES the holdout (all axes better) but regresses the anchor.
  const gamingEvaluator = async (policy, suite) => {
    const isRoot = policy.qualityBar === '0.90';
    if (suite.id === 'routing-holdout') {
      return isRoot
        ? { primary: 0.5, noopRate: 0.5, costPerWin: 10, regressed: false }
        : { primary: 0.9, noopRate: 0.1, costPerWin: 5, regressed: false };
    }
    return isRoot
      ? { primary: 0.8, noopRate: 0.2, costPerWin: 10, regressed: false }
      : { primary: 0.6, noopRate: 0.2, costPerWin: 10, regressed: false }; // anchor DEGRADES
  };

  it('rejects a holdout winner that regresses the anchor — and ignores an injected gate', async () => {
    const dir = tmpdir();
    const candidatePath = path.join(dir, 'policy.candidate.mjs');
    const { receipt, candidatePath: written, result } = await runRoutingFlywheel({
      mode: 'synthetic',
      rows: buildRows(30),
      catalog: CATALOG,
      profile: null,
      rootPolicy: { qualityBar: '0.90' },
      proposerScript: { qualityBar: ['0.75'] },
      evaluator: gamingEvaluator,
      maxGenerations: 1,
      candidatePath,
      receiptsFile: path.join(dir, 'r.jsonl'),
      // an attempt to soften the gate MUST be ignored — there is no such seam
      promotionRule: () => ({ promote: true, reasons: [] }),
    });

    expect(receipt.promotions.length).toBe(0);
    expect(written).toBe(null);
    expect(fs.existsSync(candidatePath)).toBe(false);
    const rejected = result.replayBundle.all_commits.find((c) => c.verdict === 'REJECTED');
    expect(rejected.failureReasons).toContain('anchor_regressed');
    // the fingerprint proves the FROZEN default gate ran, not the injected one
    expect(receipt.gate_fingerprint).toBe(gateFingerprint(meetsPromotionRule));
  });
});

// ─── hard caps: budget, wall clock, generations ────────────────────────────────────────────────────

describe('hard caps — the anti-self-DDoS fence', () => {
  const flatEvaluator = async () => ({ primary: 0.5, noopRate: 0.5, costPerWin: 10, regressed: false });

  it('aborts the loop when proposer spend crosses the cap', async () => {
    const dir = tmpdir();
    const spendState = { usd: 0, calls: 0, aborted: false };
    const { receipt } = await runRoutingFlywheel({
      mode: 'synthetic',
      rows: buildRows(30),
      catalog: CATALOG,
      profile: null,
      rootPolicy: { qualityBar: '0.90' },
      evaluator: flatEvaluator,
      proposer: async (base, target) => {
        spendState.usd = 0.6; // a paid proposer blowing the cap mid-generation
        return base.policy[target];
      },
      spendState,
      maxGenerations: 6,
      candidatePath: path.join(dir, 'policy.candidate.mjs'),
      receiptsFile: path.join(dir, 'r.jsonl'),
    });
    expect(receipt.generations_run).toBe(1); // gen 2 never started
    expect(receipt.budget_aborted).toBe(true);
    expect(receipt.promotions.length).toBe(0);
  });

  it('aborts the loop when the wall clock expires', async () => {
    const dir = tmpdir();
    let calls = 0;
    const clock = () => (++calls <= 2 ? 1_000 : 1_000 + 10 * 60 * 1000 + 1); // expires after gen 1 starts
    const { receipt } = await runRoutingFlywheel({
      mode: 'synthetic',
      rows: buildRows(30),
      catalog: CATALOG,
      profile: null,
      rootPolicy: { qualityBar: '0.90' },
      evaluator: flatEvaluator,
      clock,
      maxGenerations: 6,
      candidatePath: path.join(dir, 'policy.candidate.mjs'),
      receiptsFile: path.join(dir, 'r.jsonl'),
    });
    expect(receipt.generations_run).toBe(1);
    expect(receipt.budget_aborted).toBe(true);
  });

  it('clamps generations and spend cap — flags can lower them, never raise them', async () => {
    const dir = tmpdir();
    const { receipt } = await runRoutingFlywheel({
      mode: 'synthetic',
      rows: buildRows(30),
      catalog: CATALOG,
      profile: null,
      rootPolicy: { qualityBar: '0.90' },
      evaluator: flatEvaluator,
      maxGenerations: 50,
      capUSD: 10,
      candidatePath: path.join(dir, 'policy.candidate.mjs'),
      receiptsFile: path.join(dir, 'r.jsonl'),
    });
    expect(receipt.max_generations).toBe(HARD_MAX_GENERATIONS);
    expect(receipt.cap_usd).toBe(HARD_CAP_USD);
    expect(receipt.generations_run).toBe(HARD_MAX_GENERATIONS);
  });
});

// ─── the live proposer (unit-tested with a FAKE fetch — no network, no spend) ──────────────────────

describe('makeLiveProposer — spend accounting without a single real call', () => {
  const price = { in: 0.077, out: 0.154 };
  const base = { id: 'root', generation: 1, parents: [], policy: { ...ROOT_POLICY } };

  it('counts real usage tokens × verified price and clamps the reply', async () => {
    const spend = { usd: 0, calls: 0, aborted: false };
    let fetched = 0;
    const fetchImpl = async () => ({
      json: async () => ({ usage: { prompt_tokens: 1000, completion_tokens: 100 }, choices: [{ message: { content: '0.83' } }] }),
      ok: !!++fetched,
    });
    const propose = makeLiveProposer({ apiKey: 'k', model: 'm', price, spend, capUSD: 0.5, deadline: Date.now() + 60_000, fetchImpl });
    const v = await propose(base, 'qualityBar');
    expect(v).toBe('0.83');
    expect(spend.calls).toBe(1);
    expect(spend.usd).toBeCloseTo((1000 * 0.077 + 100 * 0.154) / 1e6, 10);
  });

  it('becomes a $0 no-op at the cap — no fetch, base value returned', async () => {
    const spend = { usd: 0.5, calls: 0, aborted: false };
    let fetched = 0;
    const fetchImpl = async () => { fetched++; return { json: async () => ({}) }; };
    const propose = makeLiveProposer({ apiKey: 'k', model: 'm', price, spend, capUSD: 0.5, deadline: Date.now() + 60_000, fetchImpl });
    const v = await propose(base, 'qualityBar');
    expect(v).toBe(ROOT_POLICY.qualityBar);
    expect(fetched).toBe(0);
    expect(spend.aborted).toBe(true);
  });

  it('refuses an unpriced proposer model outright', () => {
    expect(() => makeLiveProposer({ apiKey: 'k', model: 'm', price: null, spend: { usd: 0 }, capUSD: 0.5, deadline: 0 })).toThrow(/no verified price/);
  });
});

// ─── the live-policy write guard ───────────────────────────────────────────────────────────────────

describe('writeCandidatePolicy — the flywheel can never ship itself', () => {
  it('refuses policy.mjs and policy.default.mjs by name', () => {
    const dir = tmpdir();
    expect(() => writeCandidatePolicy(path.join(dir, 'policy.mjs'), 'x')).toThrow(/refusing/);
    expect(() => writeCandidatePolicy(path.join(dir, 'policy.default.mjs'), 'x')).toThrow(/refusing/);
    expect(fs.existsSync(path.join(dir, 'policy.mjs'))).toBe(false);
  });
});

// ─── CLI ───────────────────────────────────────────────────────────────────────────────────────────

describe('CLI', () => {
  function writeFixtures(dir) {
    const rowsFile = path.join(dir, 'rows.jsonl');
    fs.writeFileSync(rowsFile, buildRows(30).map((r) => JSON.stringify(r)).join('\n') + '\n');
    const catalogFile = path.join(dir, 'catalog.json');
    fs.writeFileSync(catalogFile, JSON.stringify({ candidates: CATALOG }));
    return { rowsFile, catalogFile };
  }

  it('--dry-run prints split + baseline as JSON and writes nothing', () => {
    const dir = tmpdir();
    const { rowsFile, catalogFile } = writeFixtures(dir);
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--rows', rowsFile], {
      encoding: 'utf8',
      env: { ...process.env, MODEL_ROUTER_CATALOG: catalogFile, MODEL_ROUTER_PROFILE: path.join(dir, 'no-profile.json') },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.mode).toBe('dry-run');
    expect(out.rows.usable).toBe(30);
    expect(out.runnable).toBe(true);
    expect(out.gate_fingerprint).toBe(gateFingerprint(meetsPromotionRule));
    expect(out.baseline.holdout.primary).toBeGreaterThanOrEqual(0);
    expect(out.baseline.anchor.costPerWin).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'policy.candidate.mjs'))).toBe(false);
  });

  it('--synthetic runs the full loop end-to-end from the shell', () => {
    const dir = tmpdir();
    const { rowsFile, catalogFile } = writeFixtures(dir);
    const receiptsFile = path.join(dir, 'receipts.jsonl');
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--synthetic', '--rows', rowsFile, '--out', path.join(dir, 'policy.candidate.mjs'), '--receipts', receiptsFile, '--json'],
      { encoding: 'utf8', env: { ...process.env, MODEL_ROUTER_CATALOG: catalogFile, MODEL_ROUTER_PROFILE: path.join(dir, 'no-profile.json') } }
    );
    expect(r.status).toBe(0);
    const receipt = JSON.parse(r.stdout);
    expect(receipt.data_source).toBe('SYNTHETIC');
    expect(receipt.spent_usd).toBe(0);
    expect(fs.existsSync(receiptsFile)).toBe(true);
  });

  it('--live refuses to start without OPENROUTER_API_KEY — before any call', () => {
    const env = { ...process.env };
    delete env.OPENROUTER_API_KEY;
    const r = spawnSync(process.execPath, [SCRIPT, '--live'], { encoding: 'utf8', env });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('OPENROUTER_API_KEY');
    expect(r.stdout).not.toContain('LIVE flywheel run'); // the cap banner is the start line; it never printed
  });
});
