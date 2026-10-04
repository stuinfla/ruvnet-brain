#!/usr/bin/env node
// Human-labeled deterministic classifier evaluation. Never dispatches or makes inference calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { classify } from '../config/model-router/policy.default.mjs';
import { extractFeatures } from './model-router-engine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CASES = path.join(ROOT, 'config/model-router/routing-eval-cases.json');
const CLASSES = ['fast', 'medium', 'substantial', 'hard', 'exceptional'];
const ROLES = ['mechanical-work', 'ordinary-work', 'substantial-implementation', 'bounded-difficult-reasoning', 'exceptional-reasoning'];
const RISKS = ['low', 'moderate', 'high', 'critical'];
const rank = (value) => CLASSES.indexOf(value);
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function validateCases(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Evaluation requires at least one labeled case');
  const ids = new Set();
  for (const row of cases) {
    if (!row.id || ids.has(row.id)) throw new Error('Case IDs must be nonempty and unique');
    ids.add(row.id);
    if (typeof row.request !== 'string' || !row.request.trim() || !row.rationale || !row.group) throw new Error(`Case ${row.id} needs an original request, group and label rationale`);
    const { minimumClass, maximumClass, minimumRole } = row.expected || {};
    if (rank(minimumClass) < 0 || rank(maximumClass) < rank(minimumClass)) throw new Error(`Case ${row.id} has an invalid expected class range`);
    if (minimumRole !== ROLES[rank(minimumClass)] || !RISKS.includes(row.risk)) throw new Error(`Case ${row.id} has an invalid role or risk label`);
  }
  return cases;
}

const percentile = (values, fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;
const round = (value) => Number(value.toFixed(6));

export function evaluateRouting(cases, { classifier = classify, clock = () => performance.now(), generatedAt = new Date().toISOString() } = {}) {
  validateCases(cases);
  const results = cases.map((row) => {
    const features = extractFeatures(row.request, 'codex', row.taskFacts);
    const began = clock();
    let observedClass = null; let error = null;
    try {
      observedClass = classifier(features, 'codex');
      if (rank(observedClass) < 0) throw new Error(`Classifier returned unknown class: ${String(observedClass)}`);
    } catch (caught) { error = caught?.message || String(caught); }
    const latencyMs = round(Math.max(0, clock() - began));
    const underroute = !error && rank(observedClass) < rank(row.expected.minimumClass);
    const dangerousUnderroute = underroute && ['high', 'critical'].includes(row.risk);
    const needlessEscalation = !error && rank(observedClass) > rank(row.expected.maximumClass);
    return {
      ...row, observedClass, observedRole: error ? null : ROLES[rank(observedClass)], latencyMs,
      underroute, dangerousUnderroute, needlessEscalation,
      verdict: error || underroute || needlessEscalation ? 'FAIL' : 'PASS',
      ...(error ? { error } : {}),
    };
  });
  const latencies = results.map((row) => row.latencyMs).sort((a, b) => a - b);
  const count = (field) => results.filter((row) => row[field]).length;
  const failures = results.filter((row) => row.verdict === 'FAIL').length;
  return {
    schemaVersion: 1, kind: 'ruvnet-brain.model-routing-classifier-evaluation', generatedAt,
    evidenceScope: 'classifier-only', harness: 'codex', verdict: failures ? 'FAIL' : 'PASS',
    metrics: {
      cases: results.length, passed: results.length - failures, failed: failures,
      underroute: count('underroute'), dangerousUnderroute: count('dangerousUnderroute'),
      needlessEscalation: count('needlessEscalation'), classifierErrors: count('error'),
      classificationLatencyMs: { count: latencies.length, median: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1),
        scope: 'one classifier invocation per case; excludes feature extraction and module startup' },
    },
    nativeHandoff: { status: 'unsupported', qualified: false, attempted: false,
      reason: 'This evaluation calls classify directly; it does not select a model, dispatch a native host, or observe model/effort/continuation.' },
    limitations: ['Human labels are reviewable policy expectations, not measured model capability.',
      'One bounded synthetic corpus is not population accuracy or project-specific optimality.',
      'Latency describes local deterministic classification, not inference or completion speed.',
      'A passing classifier verdict never qualifies native handoff.'],
    results,
  };
}

export function runEvaluation({ caseFile = DEFAULT_CASES, generatedAt } = {}) {
  const raw = fs.readFileSync(caseFile);
  const dataset = JSON.parse(raw);
  if (dataset.schemaVersion !== 1 || dataset.harness !== 'codex') throw new Error('Unsupported case dataset');
  const report = evaluateRouting(dataset.cases, { generatedAt });
  const policyFile = path.join(ROOT, 'config/model-router/policy.default.mjs');
  const featureFile = path.join(ROOT, 'scripts/model-router-engine.mjs');
  report.source = {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    policyPath: path.relative(ROOT, policyFile), policySha256: digest(fs.readFileSync(policyFile)),
    featureExtractorPath: path.relative(ROOT, featureFile), featureExtractorSha256: digest(fs.readFileSync(featureFile)),
    evaluatorPath: path.relative(ROOT, fileURLToPath(import.meta.url)), evaluatorSha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
    casePath: path.relative(ROOT, caseFile), casesSha256: digest(raw),
    labelBasis: dataset.labelBasis,
  };
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/model-routing-eval.mjs [--out <report.json>]');
  const report = runEvaluation();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.length) fs.writeFileSync(path.resolve(args[1]), json);
  else process.stdout.write(json);
  // Write the full honest report before returning a failed semantic qualification status.
  process.exitCode = report.verdict === 'PASS' ? 0 : 1;
}
