/**
 * Regression Gates (W5-B)
 *
 * These tests fail if performance metrics regress beyond SLO thresholds.
 * Run after every significant change: npm run bench:gates
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __file = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__file);
const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_FILE = path.join(ROOT, '.release-evidence', 'performance-baseline.json');

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function getData(baseline) {
  return baseline?.measurements || baseline?.benchmarks || [];
}

function findBench(baseline, metric) {
  const data = getData(baseline);
  return data.find((b) => b.metric === metric);
}

describe('Regression Gates — Performance SLO Compliance', () => {
  it('Baseline file exists', () => {
    expect(fs.existsSync(BASELINE_FILE)).toBe(true);
  });

  it('Baseline is valid JSON', () => {
    const baseline = loadBaseline();
    expect(baseline).toBeDefined();
    expect(Array.isArray(getData(baseline))).toBe(true);
  });

  it('Session-start recall p95: <550ms (10% margin)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'session_start_recall_cold');
    if (!bench?.measured) {
      console.log('Skipping: session-start benchmark not found');
      return;
    }

    const p95 = bench.measured.p95;
    console.log(`Session-Start Recall p95: ${p95.toFixed(2)}ms (limit: 550ms)`);
    expect(p95).toBeLessThan(550);
  });

  it('Memory store write p95: <110ms (10% margin)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'memory_store_write');
    if (!bench?.measured) {
      console.log('Skipping: memory-write benchmark not found');
      return;
    }

    const p95 = bench.measured.p95;
    console.log(`Memory Store Write p95: ${p95.toFixed(2)}ms (limit: 110ms)`);
    expect(p95).toBeLessThan(110);
  });

  it('ADR enforcement check p95: <55ms (10% margin)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'adr_enforce_check');
    if (!bench?.measured) {
      console.log('Skipping: ADR enforcement benchmark not found');
      return;
    }

    const p95 = bench.measured.p95;
    console.log(`ADR Enforcement p95: ${p95.toFixed(2)}ms (limit: 55ms)`);
    expect(p95).toBeLessThan(55);
  });

  it('Session-start recall p99: <880ms (10% margin)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'session_start_recall_cold');
    if (!bench?.measured?.p99) return;

    const p99 = bench.measured.p99;
    console.log(`Session-Start Recall p99: ${p99.toFixed(2)}ms (limit: 880ms)`);
    expect(p99).toBeLessThan(880);
  });

  it('Memory store write p99: <220ms (10% margin)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'memory_store_write');
    if (!bench?.measured?.p99) return;

    const p99 = bench.measured.p99;
    console.log(`Memory Store Write p99: ${p99.toFixed(2)}ms (limit: 220ms)`);
    expect(p99).toBeLessThan(220);
  });
});

describe('Regression Gates — Hard Limits', () => {
  it('Session-start recall p95: <750ms (hard limit)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'session_start_recall_cold');
    if (!bench?.measured) return;

    const p95 = bench.measured.p95;
    console.log(`Session-Start Hard Limit p95: ${p95.toFixed(2)}ms (hard limit: 750ms)`);
    expect(p95).toBeLessThan(750);
  });

  it('Memory store write p95: <150ms (hard limit)', () => {
    const baseline = loadBaseline();
    if (!baseline) return;

    const bench = findBench(baseline, 'memory_store_write');
    if (!bench?.measured) return;

    const p95 = bench.measured.p95;
    console.log(`Memory Write Hard Limit p95: ${p95.toFixed(2)}ms (hard limit: 150ms)`);
    expect(p95).toBeLessThan(150);
  });
});
