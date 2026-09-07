import { describe, expect, it } from 'vitest';
import { buildGateReceipt, summarizeRoutingReceipts, summarizeScore, assertEvolutionAllowed, assertPromotionAllowed } from '../../scripts/metaharness-gate.mjs';

const score = { harnessFit: 82, compileConfidence: 100, taskCoverage: 79, toolSafety: 100, memoryUsefulness: 40, estCostPerRunUsd: 0.048, recommendedMode: 'CLI + MCP', scaffoldReady: true };
const audit = { composite: { worst: 'clean' }, fingerprint: 'abc' };
const drift = { alert: false, verdict: 'near-identical', similarity: 0.99 };

describe('metaharness gate', () => {
  it('preserves measured score and routing cost without inventing missing values', () => {
    expect(summarizeScore({ data: score }).dimensions.harnessFit).toBe(82);
    expect(summarizeScore({ harnessFit: 82 }).status).toBe('unmeasured');
    expect(summarizeRoutingReceipts([{ model: 'cheap', est_cost: 0.02, saved: 0.1 }, { model: 'unknown' }])).toMatchObject({ count: 2, costUsd: 0.02, savedUsd: 0.1, unpriced: 1 });
  });

  it('keeps evolution blocked by default even with clean measured evidence', () => {
    const receipt = buildGateReceipt({ score, audit, drift, routingReceipts: [{ model: 'cheap', est_cost: 0.01 }], now: '2026-08-22T00:00:00.000Z' });
    expect(receipt.readiness).toBe('ready');
    expect(receipt.evolution.allowed).toBe(false);
    expect(receipt.evolution.reason).toMatch(/metered spend is disabled/);
    expect(() => assertEvolutionAllowed(receipt)).toThrow(/blocked/);
    expect(receipt.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows only a verified synthetic replay candidate to promote', () => {
    const candidate = { bundle_verified: true, data_source: 'SYNTHETIC' };
    const receipt = buildGateReceipt({ score, audit, drift, candidate });
    expect(receipt.promotion.allowed).toBe(true);
    expect(() => assertPromotionAllowed(receipt)).not.toThrow();
    expect(buildGateReceipt({ score, audit, drift, candidate: { bundle_verified: true, data_source: 'LIVE' } }).promotion.allowed).toBe(false);
  });

  it('blocks promotion on missing, degraded, or alerting evidence', () => {
    const candidate = { bundle_verified: true, data_source: 'SYNTHETIC' };
    const receipt = buildGateReceipt({ score, audit: { degraded: true, composite: { worst: 'clean' } }, drift, candidate });
    expect(receipt.readiness).toBe('blocked');
    expect(receipt.promotion.allowed).toBe(false);
    expect(receipt.promotion.reason).toMatch(/degraded/);
    const alert = buildGateReceipt({ score, audit, drift: { alert: true, verdict: 'major-drift' }, candidate });
    expect(alert.promotion.allowed).toBe(false);
    expect(alert.promotion.reason).toMatch(/drift/);
  });
});
