import path from 'node:path';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { qualificationPlan } from '../../scripts/release-qualification.mjs';
import { describe, expect, it } from 'vitest';
import { buildIntegrationEvidence, buildQualifiedIntegrationEvidence } from '../../scripts/integration-evidence.mjs';

const report = (assertionResults) => ({
  numTotalTests: assertionResults.length,
  numPassedTests: assertionResults.filter(({ status }) => status === 'passed').length,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPendingTests: assertionResults.filter(({ status }) => status === 'skipped' || status === 'pending').length,
  numTodoTests: assertionResults.filter(({ status }) => status === 'todo').length,
  testResults: [{ assertionResults }],
});

describe('integration evidence exclusions', () => {
  it('records exact governed exclusions without counting them as passed', () => {
    const receipt = buildIntegrationEvidence(report([
      { status: 'passed', title: 'executed', fullName: 'suite executed' },
      { status: 'skipped', title: '`-y` alone does NOT install the nightly LaunchAgent', fullName: 'suite mac-only' },
      { status: 'todo', title: 'future proof', fullName: 'suite future proof' },
    ]), { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 });
    expect(receipt).toMatchObject({ passed: 1, skipped: 1, todo: 1, exclusionPolicy: 'release-linux-v1' });
    expect(receipt.skippedTests).toEqual(['suite mac-only']);
    expect(receipt.todoTests).toEqual(['suite future proof']);
  });

  it('rejects any new or renamed skip', () => {
    expect(() => buildIntegrationEvidence(report([
      { status: 'skipped', title: 'unexpected skip', fullName: 'suite unexpected skip' },
    ]), { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 })).toThrow(/unknown skips: suite unexpected skip/);
  });

  it('accepts the legacy pending spelling for older Vitest JSON receipts', () => {
    const receipt = buildIntegrationEvidence(report([
      { status: 'pending', title: '`--yes` alone does NOT install the spend-watchdog LaunchAgent', fullName: 'suite legacy skip' },
    ]), { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 });
    expect(receipt.skippedTests).toEqual(['suite legacy skip']);
  });
});

describe('reviewed release integration boundary', () => {
  const identity = { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 };
  const qualification = () => {
    const plan = qualificationPlan('integration');
    const value = { schemaVersion: 1, kind: 'ruvnet-brain-release-qualification',
      suite: 'integration', platform: 'linux', checkoutRoot: '/fixture/repository',
      source: { sha: identity.sourceSha, dirty: false, digest: 'c'.repeat(64) },
      sourceAfter: { sha: identity.sourceSha, dirty: false, digest: 'c'.repeat(64) },
      sourceStable: true, status: 'PASS', requirements: plan.requirements.map(row => row.id),
      contractSha256: plan.contractSha256, files: plan.files,
      results: [{ name: 'installed-update', status: 'PASS', exitCode: 0 }],
      tests: { total: plan.files.length, passed: plan.files.length, failed: 0, skipped: 0 },
      testReport: { success: true, numTotalTests: plan.files.length, numPassedTests: plan.files.length,
        numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0,
        testResults: plan.files.map(file => ({ name: path.posix.resolve('/fixture/repository', file), status: 'passed',
          assertionResults: [{ status: 'passed', title: 'installed update', fullName: 'installed update' }] })) } };
    return { ...value, receiptSha256: digest(value) };
  };
  it('binds an actual fully passing reviewed report to exact source and run', () => {
    expect(buildQualifiedIntegrationEvidence(qualification(), identity)).toMatchObject({
      sourceSha: identity.sourceSha, runId: 1, passed: qualificationPlan('integration').files.length, skipped: 0, todo: 0,
      exclusionPolicy: 'reviewed-release-integration-v1', qualificationReceiptSha256: qualification().receiptSha256 });
  });
  it.each(['wrong-source', 'dirty', 'changed-source', 'failed', 'zero-tests', 'skipped', 'count-mismatch', 'after-source', 'failed-command'])('rejects %s rather than manufacturing pass', mutation => {
    const value = qualification();
    if (mutation === 'wrong-source') value.source.sha = 'b'.repeat(40);
    if (mutation === 'dirty') value.source.dirty = true;
    if (mutation === 'changed-source') value.sourceStable = false;
    if (mutation === 'failed') value.status = 'FAIL';
    if (mutation === 'zero-tests') value.testReport = report([]);
    if (mutation === 'skipped') value.testReport = report([{ status: 'skipped', title: '`-y` alone does NOT install the nightly LaunchAgent', fullName: 'legacy skip' }]);
    if (mutation === 'count-mismatch') value.tests.total = 2;
    if (mutation === 'after-source') value.sourceAfter.digest = 'd'.repeat(64);
    if (mutation === 'failed-command') value.results[0].exitCode = 1;
    const { receiptSha256: _old, ...body } = value; value.receiptSha256 = digest(body);
    expect(() => buildQualifiedIntegrationEvidence(value, identity)).toThrow();
  });
});
