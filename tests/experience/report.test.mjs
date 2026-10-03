// tests/experience/report.test.mjs — ADR-058 D2: proves tests/experience/report.mjs is
// load-bearing, not decorative.
//
// The ADR names mutants that MUST make the report go red:
//   1. delete one scenario's classification -> report red
//   2. point one scenario at a non-existent workflow job/file -> report red
//   3. point a proof at a missing path OR an existing path the named job never invokes -> red
//
// Both are exercised here as real subprocess runs against MUTATED COPIES of the real
// scenarios.json (never the live file, and never in-process — a fresh process is what the real CI
// step runs). A control run against the REAL, unmodified scenarios.json is asserted green first, so
// a red result from either mutant can only be attributed to the mutation, never to a pre-existing
// break. Runs via `node --test` (node:test format, matching tests/integration/install-smoke.mjs and
// tests/integration/require-brain-lane.mjs's idiom) — no network, no bundle, no brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualificationInvocationFiles as parseQualificationInvocationFiles } from './qualification-invocation.mjs';
import { qualificationPlan } from '../../scripts/release-qualification.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const REPORT = path.join(HERE, 'report.mjs');
const REAL_SCENARIOS = JSON.parse(fs.readFileSync(path.join(HERE, 'scenarios.json'), 'utf8'));

function qualificationInvocationFiles(body) {
  // Synthetic step declarations use the same enclosing section as real jobs.
  return parseQualificationInvocationFiles(/^ {4}steps:/m.test(body) ? body : `    steps:\n${body}`);
}

test('qualification adapter expands the actual integration workflow from the producer plan', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/integration-linux.yml'), 'utf8');
  assert.deepEqual([...qualificationInvocationFiles(workflow)], qualificationPlan('integration').files);
  const removed = workflow.replace(/^.*run: node scripts\/release-qualification\.mjs.*$/m, '        run: true');
  assert.notEqual(removed, workflow, 'must remove the actual producer declaration');
  assert.equal(qualificationInvocationFiles(removed).size, 0);
});

test('qualification adapter follows an explicit dynamic suite, including continued run commands', () => {
  for (const suite of ['source', 'integration']) {
    const body = `        run: |\n          node scripts/release-qualification.mjs \\\n            --suite ${suite} --platform linux --report /tmp/qualification.json`;
    assert.deepEqual([...qualificationInvocationFiles(body)], qualificationPlan(suite).files);
  }
});

test('qualification adapter fails closed for absent, omitted, wrong, and unknown suites', () => {
  const integrationOnly = qualificationPlan('integration').files.find(file => !qualificationPlan('source').files.includes(file));
  assert.ok(integrationOnly);
  for (const body of [
    '        run: node scripts/other.mjs --suite integration --report /tmp/report.json',
    '        run: node scripts/release-qualification.mjs --report /tmp/report.json',
    '        run: node scripts/release-qualification.mjs --suite integration',
    '        run: node scripts/release-qualification.mjs --suite source --report /tmp/report.json',
    '        run: node scripts/release-qualification.mjs --suite unknown --report /tmp/report.json',
    '        run: node scripts/release-qualification.mjs --suite integration --suite source --report /tmp/report.json',
  ]) assert.equal(qualificationInvocationFiles(body).has(integrationOnly), false, body);
});

test('qualification adapter never expands comments, echo output, or embedded source fixtures', () => {
  const producer = 'node scripts/release-qualification.mjs --suite integration --report /tmp/report.json';
  for (const body of [
    `        # run: ${producer}`,
    `        run: |\n          # ${producer}`,
    `        run: echo '${producer}'`,
    `        name: ${producer}\n        run: true`,
    `        run: |\n          cat <<'EOF' > fixture.sh\n          ${producer}\n          EOF`,
    `        run: |\n          source='${producer}'`,
    `        run: |\n          source='\n          ${producer}\n          '`,
    `        run: |\n          source=\`\n          ${producer}\n          \``,
    `        run: |\n          echo fixture \\\n            ${producer}`,
    `        run: >\n          echo\n          ${producer}`,
    `        run: |\n          exit 0\n          ${producer}`,
    `        run: |\n          if false; then\n            ${producer}\n          fi`,
    `        run: |\n          unused() {\n            ${producer}\n          }`,
    `        env:\n          FIXTURE: |\n            run: ${producer}\n        run: true`,
    `    env:\n      FIXTURE: |\n        run: ${producer}\n    steps:\n      - run: true`,
    `    env:\n      FIXTURE: | # fixture\n        run: ${producer}\n    steps:\n      - run: true`,
    `    env:\n      FIXTURE: |2- # fixture\n        run: ${producer}\n    steps:\n      - run: true`,
    `    env:\n      "FIXTURE": | # fixture\n        run: ${producer}\n    steps:\n      - run: true`,
    `    env:\n      FIXTURE: "source\n        run: ${producer}\n        source"\n    steps:\n      - run: true`,
  ]) assert.equal(qualificationInvocationFiles(body).size, 0, body);
});

function runReport(scenarioDoc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-report-'));
  const file = path.join(dir, 'scenarios.json');
  fs.writeFileSync(file, JSON.stringify(scenarioDoc, null, 2));
  try {
    return spawnSync(process.execPath, [REPORT, file], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('CONTROL — the real, unmodified scenarios.json passes (exit 0)', () => {
  const r = runReport(REAL_SCENARIOS);
  assert.equal(r.status, 0, `expected the real scenario list to pass, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});

test('MUTANT 1 — deleting one scenario\'s classification makes the report red', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  delete mutated.scenarios[0].classification; // ADR-058's named mutant, verbatim
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected a non-zero exit once a classification is deleted, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /UNCLASSIFIED/, 'must name the unclassified scenario as the reason');
});

test('MUTANT 2 — pointing one scenario at a non-existent workflow job makes the report red', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  const target = mutated.scenarios.find((s) => s.classification === 'ci');
  assert.ok(target, 'fixture assumption: at least one ci-classified scenario must exist to mutate');
  target.proofs[0].job = 'this-job-does-not-exist';
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected a non-zero exit once a scenario names a fictional job, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /this-job-does-not-exist/, 'must name the offending job in the failure output');
  assert.match(r.stdout, /job .* does not exist/, 'must say the job does not exist, not merely that something failed');
});

test('MUTANT 2b — pointing a scenario at a non-existent workflow FILE also makes the report red', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  const target = mutated.scenarios.find((s) => s.classification === 'ci');
  target.proofs[0].workflow = 'no-such-file.yml';
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected a non-zero exit once a scenario names a fictional workflow file, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /does not exist in \.github\/workflows/);
});

test('MUTANT 3a — a proof path that does not exist makes the report red', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  const target = mutated.scenarios.find((s) => s.classification === 'ci');
  target.proofs[0].path = 'tests/unit/removed-by-mutant.test.mjs';
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected a missing proof path to fail, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /not an existing repo file/);
});

test('MUTANT 3b — an existing path the named job never invokes makes the report red', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  const target = mutated.scenarios.find((s) => s.id === 'S23');
  assert.ok(target, 'fixture assumption: S23 is the scheduled published-surface probe');
  target.proofs[0].path = 'tests/unit/codex-wiring.test.mjs'; // exists, but probe job never runs it
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected an uninvoked existing proof path to fail, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /does not invoke/);
});

test('manual-share cap: pushing manual above 20% of the list makes the report red', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  for (const s of mutated.scenarios) { s.classification = 'manual'; s.owner = 'Stuart Kerr'; } // 100% manual
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected a non-zero exit once manual exceeds the cap, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /manual scenarios are 100\.0% of the list/);
});

test('a manual scenario with no owner is itself a failure (not just a silent pass)', () => {
  const mutated = structuredClone(REAL_SCENARIOS);
  const target = mutated.scenarios.find((s) => s.classification === 'manual');
  assert.ok(target, 'fixture assumption: at least one manual-classified scenario must exist');
  target.owner = '';
  const r = runReport(mutated);
  assert.notEqual(r.status, 0, `expected a non-zero exit for an ownerless manual scenario, got ${r.status}\n${r.stdout}`);
  assert.match(r.stdout, /requires a named owner/);
});
