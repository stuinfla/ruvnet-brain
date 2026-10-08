import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { qualifyVitestLane, vitestLaneFiles, verdictOf } from '../../scripts/qa-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-vitest-proof-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
// Report fixtures exercise the strict assessor. Native execution evidence comes from the real CLI tests below.
function reportFixture(root, statuses = ['passed']) {
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0,
    numTodoTests: 0, numTotalTests: statuses.length, numPassedTests: statuses.length,
    testResults: [{ name: path.join(root, 'tests/mesh/one.test.mjs'), status: 'passed',
      assertionResults: statuses.map(status => ({ status })) }] };
}
function assess(report, mutate = () => {}) {
  const root = temporary(), evidenceFile = path.join(root, 'report.json');
  const value = report(root); mutate(value); fs.writeFileSync(evidenceFile, JSON.stringify(value));
  return qualifyVitestLane({ status: 'PASS', exitCode: 0 }, { root, evidenceFile, files: ['tests/mesh/one.test.mjs'] });
}
describe('shared QA uses strict executed Vitest evidence', () => {
  it('zero, pending, failed and incomplete case evidence cannot PASS', () => {
    expect(assess(root => reportFixture(root, [])).status).toBe('UNKNOWN');
    expect(assess(root => reportFixture(root, ['pending'])).status).toBe('UNKNOWN');
    expect(assess(reportFixture, report => { report.numPendingTests = 1; }).status).toBe('UNKNOWN');
    expect(assess(root => reportFixture(root, ['failed'])).status).toBe('UNKNOWN');
    expect(assess(reportFixture, report => { report.testResults = []; }).status).toBe('UNKNOWN');
  });
  it('PASS cannot replace missing report, nonzero exit or missing test summary', () => {
    expect(qualifyVitestLane({ status: 'PASS', exitCode: 0 }, { root: '/tmp', evidenceFile: '/no-report', files: ['tests/one.test.mjs'] }).status).toBe('UNKNOWN');
    expect(qualifyVitestLane({ status: 'PASS', exitCode: 1 }, {}).status).toBe('UNKNOWN');
    expect(verdictOf([{ status: 'PASS', testEvidenceRequired: true }])).toBe('UNKNOWN');
    expect(verdictOf([{ status: 'PASS', testEvidenceRequired: true, tests: { total: 0, passed: 0, failed: 0, skipped: 0 } }])).toBe('UNKNOWN');
  });
  it('matches exact expected files instead of trusting self-selected report inventory', () => {
    expect(assess(reportFixture, report => { report.testResults[0].name = '/foreign/one.test.mjs'; }).status).toBe('UNKNOWN');
    const root = temporary(); fs.mkdirSync(path.join(root, 'tests/mesh'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/mesh/one.test.mjs'), '');
    fs.writeFileSync(path.join(root, 'tests/mesh/two.test.mjs'), '');
    expect(vitestLaneFiles({ testTargets: ['tests/mesh'] }, root)).toEqual(['tests/mesh/one.test.mjs', 'tests/mesh/two.test.mjs']);
    expect(() => vitestLaneFiles({ testTargets: ['tests/mesh', 'tests/mesh'] }, root)).toThrow(/duplicated/);
  });
  it('valid complete report passes with its exact JSON byte hash', () => {
    const result = assess(reportFixture); expect(result.status).toBe('PASS');
    expect(result.tests).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/); expect(verdictOf([result])).toBe('PASS');
  });
});
function realLane(body, removeEvidenceGuard = false) {
  const root = temporary();
  for (const file of ['scripts/qa-runner.mjs', 'scripts/qa-lanes.mjs', 'scripts/qa-contract.mjs',
    'scripts/release-qualification.mjs', 'scripts/release-qualification-contract.mjs',
    'scripts/coverage-integrity.mjs', 'plugin/scripts/coverage-integrity.mjs']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(ROOT, file), target);
  }
  if (removeEvidenceGuard) {
    const runner = path.join(root, 'scripts/qa-runner.mjs');
    const before = fs.readFileSync(runner, 'utf8');
    const after = before.replace("resolve(lane.report === 'vitest' ? qualifyVitestLane(result, { root, evidenceFile, files }) : result);", 'resolve(result);');
    expect(after).not.toBe(before); fs.writeFileSync(runner, after);
  }
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'node_modules')), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(root, 'tests/mesh'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/mesh/one.test.mjs'), body);
  spawnSync('git', ['init', '-q', root]);
  const child = spawnSync(process.execPath, ['scripts/qa-runner.mjs', '--lane', 'mesh'], {
    cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, QA_TIMEOUT_MS: '10000' } });
  const summary = child.stdout.split('\n').filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).at(-1);
  expect(summary, child.stderr + child.stdout).toBeTruthy(); roots.push(summary.receiptDir);
  return { child, aggregate: JSON.parse(fs.readFileSync(path.join(summary.receiptDir, 'aggregate.json'))), receiptDir: summary.receiptDir };
}
describe('actual shared runner joins native Vitest JSON, exit and current source', () => {
  it('real executed passing test produces a source-bound PASS receipt', () => {
    const { child, aggregate, receiptDir } = realLane("import {it,expect} from 'vitest'; it('actual arithmetic',()=>expect(2+3).toBe(5));\n");
    expect(child.status).toBe(0); expect(aggregate.status).toBe('PASS'); expect(aggregate.sourceStable).toBe(true);
    expect(aggregate.selectedLanes).toEqual(['mesh']); expect(aggregate.omittedLanes.length).toBeGreaterThan(0);
    expect(aggregate.omittedLanes.every(lane => lane.status === 'NOT_RUN' && lane.reason)).toBe(true);
    expect(aggregate.selectionComplete).toBe(false); expect(aggregate.allRegisteredLanesPassed).toBe(false);
    const lane = aggregate.results[0]; expect(lane.exitCode).toBe(0); expect(lane.tests.total).toBe(1);
    expect(lane.evidenceSha256).toBe(sha(fs.readFileSync(lane.evidenceFile)));
    expect(JSON.parse(fs.readFileSync(path.join(receiptDir, 'mesh.json'))).source).toEqual(aggregate.source);
  }, 25000);
  it('real skipped-only Vitest exit0 remains UNKNOWN', () => {
    const { child, aggregate } = realLane("import {it} from 'vitest'; it.skip('not executed',()=>{});\n");
    expect(aggregate.results[0].exitCode).toBe(0); expect(aggregate.results[0].status).toBe('UNKNOWN');
    expect(aggregate.status).toBe('UNKNOWN'); expect(child.status).toBe(4);
  }, 25000);
  it('removing the evidence guard reproduces the old exit0 false PASS', () => {
    const { child, aggregate } = realLane("import {it} from 'vitest'; it.skip('not executed',()=>{});\n", true);
    expect(aggregate.results[0].exitCode).toBe(0); expect(aggregate.status).toBe('PASS');
    expect(child.status).toBe(0);
  }, 25000);
  it('real passing test that changes source cannot qualify the original bytes', () => {
    const { child, aggregate } = realLane("import {it} from 'vitest'; import fs from 'node:fs'; it('changes source',()=>fs.writeFileSync('changed.txt','changed'));\n");
    expect(aggregate.results[0].status).toBe('PASS'); expect(aggregate.sourceStable).toBe(false);
    expect(aggregate.status).toBe('UNKNOWN'); expect(child.status).toBe(4);
  }, 25000);
});
