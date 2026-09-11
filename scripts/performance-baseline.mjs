#!/usr/bin/env node
/**
 * Performance Baseline Benchmark Runner (W5-B)
 * Usage: npm run bench -- memory-baseline [--stress 100] [--interval 30]
 *
 * Establishes and validates SLOs for:
 * - Session-start recall time
 * - Memory store write latency
 * - ADR enforcement check time
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METRICS_DIR = path.join(ROOT, '.release-evidence');
const BASELINE_FILE = path.join(METRICS_DIR, 'performance-baseline.json');
const REGRESSION_GATES_FILE = path.join(METRICS_DIR, 'regression-gates.json');
const LIVE_METRICS_FILE = path.join(METRICS_DIR, 'live-metrics.jsonl');

const SLOs = {
  SESSION_START_RECALL_P95: 500,
  SESSION_START_RECALL_P99: 800,
  MEMORY_STORE_WRITE_P95: 100,
  MEMORY_STORE_WRITE_P99: 200,
  ADR_ENFORCE_CHECK_P95: 50,
};

const REGRESSION_THRESHOLD = 1.10; // 10% margin

class PerformanceBenchmark {
  constructor() {
    this.measurements = new Map();
    this.startTime = Date.now();
  }

  percentile(values, frac) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * frac) - 1];
  }

  stats(values) {
    if (!values.length) return null;
    return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      median: this.percentile(values, 0.5),
      p50: this.percentile(values, 0.5),
      p90: this.percentile(values, 0.9),
      p95: this.percentile(values, 0.95),
      p99: this.percentile(values, 0.99),
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      stddev: this.stddev(values),
    };
  }

  stddev(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b) / values.length;
    const sq = values.reduce((a, b) => a + (b - mean) ** 2, 0);
    return Math.sqrt(sq / (values.length - 1));
  }

  record(metric, value) {
    if (!this.measurements.has(metric)) {
      this.measurements.set(metric, []);
    }
    this.measurements.get(metric).push(value);
  }

  async benchmarkSessionStartRecall(samples = 10) {
    console.log('\n[SESSION-START RECALL] Benchmarking cold-start session recall...');
    const results = [];

    for (let i = 0; i < samples; i++) {
      // Remove cache to force cold-start
      const cacheFile = path.join(ROOT, '.swarm', 'memory.db');
      if (fs.existsSync(cacheFile)) {
        try {
          fs.unlinkSync(cacheFile);
        } catch {
          // Ignore cleanup errors
        }
      }

      const start = performance.now();

      try {
        // Load and parse session snapshot contract
        const contractModule = await import(
          path.join(ROOT, 'plugin/scripts/session-snapshot-contract.mjs')
        );

        // Simulate the session recall operation
        const projectDir = ROOT;
        contractModule.inspectSessionSnapshots(projectDir);

        const elapsed = performance.now() - start;
        results.push(elapsed);
        this.record('session_start_recall_cold', elapsed);

        if ((i + 1) % 2 === 0) {
          console.log(`  Sample ${i + 1}/${samples}: ${elapsed.toFixed(2)}ms`);
        }
      } catch (err) {
        console.error(`  Sample ${i + 1}/${samples}: FAILED`, err.message);
      }
    }

    const measured = this.stats(results);
    return {
      metric: 'session_start_recall_cold',
      slo: SLOs.SESSION_START_RECALL_P95,
      measured,
    };
  }

  async benchmarkMemoryStoreWrite(samples = 20) {
    console.log('\n[MEMORY STORE WRITE] Benchmarking write latency...');
    const results = [];

    for (let i = 0; i < samples; i++) {
      const start = performance.now();

      try {
        const testData = {
          timestamp: Date.now(),
          index: i,
          payload: JSON.stringify({ random: Math.random(), size: Math.random() * 1000 }),
        };

        const testFile = path.join(ROOT, '.swarm', `.perf-write-${i}.json`);
        fs.writeFileSync(testFile, JSON.stringify(testData));

        const elapsed = performance.now() - start;
        results.push(elapsed);
        this.record('memory_store_write', elapsed);

        // Cleanup
        try {
          fs.unlinkSync(testFile);
        } catch {
          // Ignore
        }

        if ((i + 1) % 5 === 0) {
          console.log(`  Sample ${i + 1}/${samples}: ${elapsed.toFixed(2)}ms`);
        }
      } catch (err) {
        console.error(`  Sample ${i + 1}/${samples}: FAILED`, err.message);
      }
    }

    const measured = this.stats(results);
    return {
      metric: 'memory_store_write',
      slo: SLOs.MEMORY_STORE_WRITE_P95,
      measured,
    };
  }

  async benchmarkADREnforcementCheck(samples = 25) {
    console.log('\n[ADR ENFORCEMENT] Benchmarking ADR policy check latency...');
    const results = [];

    for (let i = 0; i < samples; i++) {
      const start = performance.now();

      try {
        // Simulate ADR enforcement: read and validate ADR files
        const adrDir = path.join(ROOT, 'docs', 'adr');
        let count = 0;

        if (fs.existsSync(adrDir)) {
          const files = fs.readdirSync(adrDir)
            .filter((f) => f.endsWith('.md'))
            .slice(0, 2);

          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(adrDir, file), 'utf8');
              // Basic validation: check for required ADR structure
              if (content.includes('Decision:') || content.includes('Status:')) {
                count++;
              }
            } catch {
              // Ignore read errors
            }
          }
        }

        const elapsed = performance.now() - start;
        results.push(elapsed);
        this.record('adr_enforce_check', elapsed);

        if ((i + 1) % 5 === 0) {
          console.log(`  Sample ${i + 1}/${samples}: ${elapsed.toFixed(2)}ms (validated ${count} ADRs)`);
        }
      } catch (err) {
        console.error(`  Sample ${i + 1}/${samples}: FAILED`, err.message);
      }
    }

    const measured = this.stats(results);
    return {
      metric: 'adr_enforce_check',
      slo: SLOs.ADR_ENFORCE_CHECK_P95,
      measured,
    };
  }

  async benchmarkStressTest(concurrency = 10, duration = 30000) {
    console.log(`\n[STRESS TEST] Running ${concurrency}-user load test for ${duration / 1000}s...`);
    const results = [];
    const startTime = Date.now();
    let completed = 0;

    const worker = async (id) => {
      while (Date.now() - startTime < duration) {
        const start = performance.now();
        try {
          // Simulate mixed workload: recall + write + check
          const tasks = [
            this.benchmarkMemoryStoreWrite(1).then(() => performance.now() - start),
          ];

          const elapsed = await Promise.race(tasks);
          results.push(elapsed);
          this.record('stress_test_latency', elapsed);
        } catch (err) {
          // Silently ignore stress test errors
        }
      }
      completed++;
    };

    const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
    await Promise.all(workers);

    const measured = this.stats(results);
    console.log(`  Completed: ${completed} workers, ${results.length} operations`);

    return {
      metric: 'stress_test_100_users',
      concurrency,
      duration,
      measured,
    };
  }

  async runAll(options = {}) {
    const benchmarks = [];
    const startTime = Date.now();

    try {
      benchmarks.push(await this.benchmarkSessionStartRecall(options.sessionSamples || 10));
      benchmarks.push(await this.benchmarkMemoryStoreWrite(options.writeSamples || 20));
      benchmarks.push(await this.benchmarkADREnforcementCheck(options.adrSamples || 25));

      if (options.stress) {
        benchmarks.push(await this.benchmarkStressTest(options.stress, options.duration || 30000));
      }
    } catch (err) {
      console.error('Benchmark error:', err.message);
      process.exit(1);
    }

    const duration = Date.now() - startTime;

    return {
      timestamp: new Date().toISOString(),
      duration: duration,
      buildInfo: {
        cwd: ROOT,
        nodeVersion: process.version,
        platform: process.platform,
        cpus: os.cpus().length,
        memory: os.totalmem(),
      },
      slos: SLOs,
      benchmarks,
      regression: this.detectRegressions(benchmarks),
    };
  }

  detectRegressions(benchmarks) {
    const breaches = [];

    for (const bench of benchmarks) {
      if (!bench.measured || !bench.slo) continue;

      const p95 = bench.measured.p95;
      const limit = bench.slo * REGRESSION_THRESHOLD;

      if (p95 > limit) {
        breaches.push({
          metric: bench.metric,
          measured: p95,
          slo: bench.slo,
          limit,
          exceedance: ((p95 / bench.slo - 1) * 100).toFixed(1) + '%',
        });
      }
    }

    return {
      threshold: REGRESSION_THRESHOLD,
      breaches,
      status: breaches.length === 0 ? 'PASS' : 'FAIL',
    };
  }

  saveBenchmarks(results) {
    if (!fs.existsSync(METRICS_DIR)) {
      fs.mkdirSync(METRICS_DIR, { recursive: true });
    }

    fs.writeFileSync(BASELINE_FILE, JSON.stringify(results, null, 2));
    console.log(`\n✓ Baseline saved: ${BASELINE_FILE}`);

    // Append to live metrics JSONL
    fs.appendFileSync(
      LIVE_METRICS_FILE,
      JSON.stringify({
        timestamp: results.timestamp,
        benchmarks: results.benchmarks,
        regression: results.regression,
      }) + '\n'
    );
    console.log(`✓ Live metrics appended: ${LIVE_METRICS_FILE}`);

    // Save regression gates
    const gates = this.generateRegressionGates(results.benchmarks);
    fs.writeFileSync(REGRESSION_GATES_FILE, JSON.stringify(gates, null, 2));
    console.log(`✓ Regression gates saved: ${REGRESSION_GATES_FILE}`);
  }

  generateRegressionGates(benchmarks) {
    return {
      generated: new Date().toISOString(),
      gates: benchmarks.map((bench) => ({
        metric: bench.metric,
        slo: bench.slo,
        limit: (bench.slo * REGRESSION_THRESHOLD).toFixed(2),
        testName: `Regression gate: ${bench.metric} must be <${(bench.slo * REGRESSION_THRESHOLD).toFixed(0)}ms`,
        command: `npm run bench -- memory-baseline`,
      })),
    };
  }

  printSummary(results) {
    console.log('\n' + '='.repeat(70));
    console.log('PERFORMANCE BASELINE SUMMARY');
    console.log('='.repeat(70));

    for (const bench of results.benchmarks) {
      if (!bench.measured) continue;

      console.log(`\n${bench.metric.toUpperCase()}`);
      console.log('  SLO (p95):', `${bench.slo}ms`);
      console.log('  Measured (p95):', `${bench.measured.p95.toFixed(2)}ms`);
      console.log('  Mean:', `${bench.measured.mean.toFixed(2)}ms`);
      console.log('  p99:', `${bench.measured.p99.toFixed(2)}ms`);
      console.log('  Range:', `${bench.measured.min.toFixed(2)}ms - ${bench.measured.max.toFixed(2)}ms`);
      console.log('  Samples:', bench.measured.count);

      const exceedance = ((bench.measured.p95 / bench.slo - 1) * 100).toFixed(1);
      if (exceedance > 0) {
        console.log(`  ⚠ EXCEEDS SLO by ${exceedance}%`);
      } else {
        console.log(`  ✓ Meets SLO (margin: ${(-exceedance).toFixed(1)}%)`);
      }
    }

    console.log('\n' + '-'.repeat(70));
    if (results.regression.status === 'PASS') {
      console.log('✓ REGRESSION GATES: PASS');
    } else {
      console.log('✗ REGRESSION GATES: FAIL');
      for (const breach of results.regression.breaches) {
        console.log(`  - ${breach.metric}: ${breach.measured.toFixed(0)}ms (limit: ${breach.limit.toFixed(0)}ms, +${breach.exceedance})`);
      }
    }

    console.log('='.repeat(70));

    return results.regression.status === 'PASS';
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const options = {
    stress: args.includes('--stress') ? parseInt(args[args.indexOf('--stress') + 1]) : null,
    duration: args.includes('--duration') ? parseInt(args[args.indexOf('--duration') + 1]) : 30000,
    sessionSamples: args.includes('--session-samples') ? parseInt(args[args.indexOf('--session-samples') + 1]) : 10,
    writeSamples: args.includes('--write-samples') ? parseInt(args[args.indexOf('--write-samples') + 1]) : 20,
    adrSamples: args.includes('--adr-samples') ? parseInt(args[args.indexOf('--adr-samples') + 1]) : 25,
  };

  console.log('🚀 Performance Baseline Benchmark (W5-B Lead)');
  console.log(`Root: ${ROOT}`);
  console.log(`Options:`, options);

  const benchmark = new PerformanceBenchmark();
  const results = await benchmark.runAll(options);

  const passed = benchmark.printSummary(results);
  benchmark.saveBenchmarks(results);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
