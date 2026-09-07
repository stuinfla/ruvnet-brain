import { digest } from '../../scripts/coverage-integrity.mjs';
import { expect, it } from 'vitest';
import path from 'node:path';
import { assessTestReport, qualificationPlan, validateQualificationReceipt } from '../../scripts/release-qualification.mjs';
const file = 'tests/unit/example.test.mjs';
const root = process.cwd();
const report = () => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0,
  numPendingTests: 0, numTodoTests: 0, numTotalTests: 1, numPassedTests: 1,
  testResults: [{ name: path.join(root, file), status: 'passed', assertionResults: [{ fullName: 'actual case', status: 'passed' }] }] });
it('accepts only the exact executed file and case inventory', () => {
  expect(assessTestReport(report(), [file], root)).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
  expect(() => assessTestReport(report(), ['tests/unit/different.test.mjs'], root)).toThrow();
  const duplicated = report(); duplicated.testResults.push(duplicated.testResults[0]);
  expect(() => assessTestReport(duplicated, [file], root)).toThrow('inventory');
});
for (const status of ['failed', 'pending', 'skipped', 'todo']) {
  it(`rejects ${status} cases even if aggregate counters claim success`, () => {
    const value = report(); value.testResults[0].assertionResults[0].status = status;
    expect(() => assessTestReport(value, [file], root)).toThrow('execute and pass');
  });
}
it('rejects an empty suite, missing cases, and forged totals', () => {
  expect(() => assessTestReport({ testResults: [] }, [file], root)).toThrow('inventory');
  const value = report(); value.numTotalTests = 2;
  expect(() => assessTestReport(value, [file], root)).toThrow('execute and pass');
  value.numTotalTests = 1; value.testResults[0].assertionResults = [];
  expect(() => assessTestReport(value, [file], root)).toThrow('execute and pass');
});
it('rejects undefined qualification classes rather than falling back to the historical suite', () => {
  expect(() => qualificationPlan('all')).toThrow('unknown');
  for (const suite of ['source', 'integration']) {
    expect(qualificationPlan(suite).files.length).toBeGreaterThan(0);
  }
});

const reseal = value => { const { receiptSha256: _old, ...body } = value; return { ...body, receiptSha256: digest(body) }; };
function receipt(platform = 'windows') {
  const plan = qualificationPlan('source');
  const checkoutRoot = platform === 'windows' ? 'D:\\a\\ruvnet-brain\\ruvnet-brain' : '/home/runner/work/ruvnet-brain/ruvnet-brain';
  const paths = platform === 'windows' ? path.win32 : path.posix;
  const testReport = { ...report(), numTotalTests: plan.files.length, numPassedTests: plan.files.length,
    testResults: plan.files.map(file => ({ name: paths.join(checkoutRoot, file), status: 'passed',
      assertionResults: [{ fullName: 'actual reviewed case', status: 'passed' }] })) };
  const source = { sha: 'a'.repeat(40), dirty: false, digest: 'b'.repeat(64) };
  return reseal({ schemaVersion: 1, kind: 'ruvnet-brain-release-qualification', suite: 'source', platform,
    checkoutRoot, status: 'PASS', source, sourceAfter: { ...source }, sourceStable: true,
    files: plan.files, requirements: plan.requirements.map(row => row.id), contractSha256: plan.contractSha256,
    testReport, tests: { total: plan.files.length, passed: plan.files.length, failed: 0, skipped: 0 },
    results: [{ name: 'executed', status: 'PASS', exitCode: 0 }] });
}
it.each(['linux', 'macos', 'windows'])('collector validates %s absolute test names without host-path assumptions', platform => {
  const value = receipt(platform);
  expect(validateQualificationReceipt(value, { suite: 'source', platform, sourceSha: value.source.sha })).toEqual(value.tests);
});
it.each(['failed-case', 'extra-file', 'relative-file', 'outside-root', 'wrong-root', 'missing-root', 'false-summary',
  'command-failed', 'command-exit', 'missing-command', 'after-sha', 'after-digest', 'after-dirty', 'before-dirty'])('rejects resealed malformed receipt: %s', mutation => {
  const value = receipt();
  if (mutation === 'failed-case') value.testReport.testResults[0].assertionResults[0].status = 'failed';
  if (mutation === 'extra-file') value.testReport.testResults.push(value.testReport.testResults[0]);
  if (mutation === 'relative-file') value.testReport.testResults[0].name = value.files[0];
  if (mutation === 'outside-root') value.testReport.testResults[0].name = path.win32.join('D:\\other', value.files[0]);
  if (mutation === 'wrong-root') value.checkoutRoot = 'D:\\other';
  if (mutation === 'missing-root') delete value.checkoutRoot;
  if (mutation === 'false-summary') value.tests.total++;
  if (mutation === 'command-failed') value.results[0].status = 'FAIL';
  if (mutation === 'command-exit') value.results[0].exitCode = 1;
  if (mutation === 'missing-command') value.results = [];
  if (mutation === 'after-sha') value.sourceAfter.sha = 'c'.repeat(40);
  if (mutation === 'after-digest') value.sourceAfter.digest = 'c'.repeat(64);
  if (mutation === 'after-dirty') value.sourceAfter.dirty = true;
  if (mutation === 'before-dirty') value.source.dirty = true;
  expect(() => validateQualificationReceipt(reseal(value), { suite: 'source', platform: 'windows', sourceSha: 'a'.repeat(40) })).toThrow();
});
it('accepts Windows separator normalization but does not collapse a different test inventory', () => {
  const value = receipt();
  value.testReport.testResults.forEach(row => { row.name = row.name.replaceAll('\\', '/'); });
  expect(validateQualificationReceipt(reseal(value), { suite: 'source', platform: 'windows', sourceSha: 'a'.repeat(40) })).toEqual(value.tests);
});
