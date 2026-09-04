import { describe, expect, it } from 'vitest';
import { buildIntegrationEvidence } from '../../scripts/integration-evidence.mjs';

const report = (assertionResults) => ({
  numTotalTests: assertionResults.length,
  numPassedTests: assertionResults.filter(({ status }) => status === 'passed').length,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  numPendingTests: assertionResults.filter(({ status }) => status === 'pending').length,
  numTodoTests: assertionResults.filter(({ status }) => status === 'todo').length,
  testResults: [{ assertionResults }],
});

describe('integration evidence exclusions', () => {
  it('records exact governed exclusions without counting them as passed', () => {
    const receipt = buildIntegrationEvidence(report([
      { status: 'passed', title: 'executed', fullName: 'suite executed' },
      { status: 'pending', title: '`-y` alone does NOT install the nightly LaunchAgent', fullName: 'suite mac-only' },
      { status: 'todo', title: 'future proof', fullName: 'suite future proof' },
    ]), { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 });
    expect(receipt).toMatchObject({ passed: 1, skipped: 1, todo: 1, exclusionPolicy: 'release-linux-v1' });
    expect(receipt.skippedTests).toEqual(['suite mac-only']);
    expect(receipt.todoTests).toEqual(['suite future proof']);
  });

  it('rejects any new or renamed skip', () => {
    expect(() => buildIntegrationEvidence(report([
      { status: 'pending', title: 'unexpected skip', fullName: 'suite unexpected skip' },
    ]), { sourceSha: 'a'.repeat(40), runId: 1, runAttempt: 1 })).toThrow(/unknown skips: suite unexpected skip/);
  });
});
