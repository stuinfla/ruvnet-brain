#!/usr/bin/env node
import crypto from 'node:crypto';
import { validateQualificationReceipt } from './release-qualification.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXCLUSION_POLICY = 'release-linux-v1';

const ALLOWED_LINUX_SKIP_TITLES = new Set([
  'stores, exact-retrieves, and strictly deduplicates through a temp real AgentDB',
  'bridges, ranks, and is delivered as additionalContext at the write-code decision point',
  'TEETH: an UNTAGGED row travels no further than the store — the chain is genuinely load-bearing',
  'TEETH: a lesson tagged for a DIFFERENT moment does not fire at this one',
  'TEETH: a value too long to read from search output resolves in FULL via retrieve',
  'a USER-LEVEL store at an explicit --path is reachable the same way',
  'TEETH: a MISSING key reports not-found rather than inventing content',
  '`-y` alone does NOT install the nightly LaunchAgent',
  '`--yes` alone does NOT install the spend-watchdog LaunchAgent',
  'embeds only the changed file on pass two and preserves the unchanged stable ID',
]);

const digestNames = (names) => crypto.createHash('sha256')
  .update(`${JSON.stringify([...names].sort())}\n`)
  .digest('hex');

export function buildIntegrationEvidence(report, { sourceSha, runId, runAttempt }) {
  const total = Number(report.numTotalTests || 0);
  const failed = Number(report.numFailedTests || 0) + Number(report.numFailedTestSuites || 0);
  const skipped = Number(report.numPendingTests || 0);
  const todo = Number(report.numTodoTests || 0);
  const passed = Number(report.numPassedTests || 0);
  const assertions = (report.testResults || []).flatMap((suite) => suite.assertionResults || []);
  // Vitest 4 calls skipped assertions `skipped` while older JSON reporters called them
  // `pending`; numPendingTests remains the aggregate count in both schemas.
  const skippedTests = assertions.filter(({ status }) => status === 'skipped' || status === 'pending')
    .map(({ fullName, title }) => ({ fullName: fullName || title, title }))
    .filter(({ fullName, title }) => Boolean(fullName && title));
  const todoTests = assertions.filter(({ status }) => status === 'todo')
    .map(({ fullName, title }) => fullName || title)
    .filter(Boolean);
  const unknownSkips = skippedTests.filter(({ title }) => !ALLOWED_LINUX_SKIP_TITLES.has(title));
  if (total <= 0 || failed !== 0 || passed + todo + skipped !== total
    || skippedTests.length !== skipped || todoTests.length !== todo || unknownSkips.length > 0) {
    const names = unknownSkips.map(({ fullName }) => fullName).join('; ');
    throw new Error(`integration report is not an exact governed pass (${passed} passed, ${todo} todo, ${total} total, ${skipped} skipped; unknown skips: ${names || 'none'})`);
  }
  return {
    schemaVersion: 1, kind: 'ruvnet-brain-integration-evidence', sourceSha,
    workflow: 'integration-linux', runId: Number(runId), runAttempt: Number(runAttempt),
    total, passed, failed: 0, skipped,
    skippedTests: skippedTests.map(({ fullName }) => fullName).sort(),
    todo, todoTests: todoTests.sort(), exclusionPolicy: EXCLUSION_POLICY,
    exclusionsSha256: digestNames([
      ...skippedTests.map(({ fullName }) => `skip:${fullName}`),
      ...todoTests.map((name) => `todo:${name}`),
    ]),
    verdict: 'PASS',
  };
}

export const RELEASE_QUALIFICATION_POLICY = 'reviewed-release-integration-v1';
export function buildQualifiedIntegrationEvidence(report, identity) {
  validateQualificationReceipt(report, { suite: 'integration', platform: 'linux', sourceSha: identity.sourceSha });
  const evidence = buildIntegrationEvidence(report.testReport, identity);
  return { ...evidence, exclusionPolicy: RELEASE_QUALIFICATION_POLICY,
    qualificationReceiptSha256: report.receiptSha256, requirements: report.requirements };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  const build = process.argv.includes('--qualified') ? buildQualifiedIntegrationEvidence : buildIntegrationEvidence;
  const receipt = build(JSON.parse(fs.readFileSync(value('--report'), 'utf8')), {
    sourceSha: value('--sha'), runId: value('--run-id'), runAttempt: value('--run-attempt'),
  });
  fs.writeFileSync(value('--out'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
}
