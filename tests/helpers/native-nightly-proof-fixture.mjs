import crypto from 'node:crypto';
import { REQUIRED_REFRESH_PHASES } from '../../kb/refresh-run.mjs';
import { digest } from '../../scripts/coverage-integrity.mjs';
import { releaseCoverageGenerationFor } from '../../plugin/scripts/coverage-integrity.mjs';

const inventory = (copies = 0, bytes = 100) => ({ additionalFullCorpusCopyCount: copies,
  totalManagedBytes: bytes });
// Structural fixtures only: these do not represent actual scheduler executions.
const receipt = (runId, terminalVerdict) => ({ runId, schedulerIdentity: 'proof', terminalVerdict,
  schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', status: 'SUCCEEDED',
  requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES],
  startedAt: runId === 'two' ? '2026-09-05T10:01:00Z' : '2026-09-05T10:00:00Z',
  finishedAt: runId === 'two' ? '2026-09-05T10:02:00Z' : '2026-09-05T10:01:00Z',
  phases: REQUIRED_REFRESH_PHASES.map((phase) => ({ phase, status: 'PASS', at: runId === 'two' ? '2026-09-05T10:01:30Z' : '2026-09-05T10:00:30Z',
    evidence: { execution: { kind: 'executed', runId } } })),
  detail: { storageDelta: { redundantCopyCount: 0, additionalFullCorpusCopyDelta: 0 } } });

export function nativeNightlyProofFixture({ platform, version, sourceSha, packageSha256, bundleSha256, workflowRunId = '12345', privateKey }) {
  const identity = 'com.ruvnet.brain-update.proof-fixture';
  const coverage = { schemaVersion: 1, kind: 'ruvnet-brain-release-coverage',
    generatorSourceSha: '1'.repeat(64), snapshotRoot: '2'.repeat(64), sourceObservationSha256: '3'.repeat(64),
    releaseIdentity: { version: version, tag: `v${version}`, sourceSnapshot: sourceSha },
    corpusSeed: { tag: 'corpus-seed-fixture', archiveSha256: '4'.repeat(64), archiveBytes: 100, receiptSha256: '5'.repeat(64) },
    corpusCoverage: { sha256: '6'.repeat(64), coverageGeneration: '7'.repeat(64) },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: '8'.repeat(64), bytes: 200, storeCount: 1 },
    publicInventoryPartitionSha256: '9'.repeat(64), installedProjectionSchema: 2, rows: [],
    totals: { repositories: 0, gists: 0, rows: 0, byStatus: {} },
    enumerationReceipt: { schemaVersion: 1, terminal: true, duplicateKeys: 0,
      repositories: { expected: 0, pages: [] }, gists: { expected: 0, pages: [] } },
    policy: { policyDispositionDigests: [], exemptionDigests: [] } };
  coverage.releaseCoverageGeneration = releaseCoverageGenerationFor(coverage);
  const raw = JSON.stringify(coverage);
  const projection = { raw, sha256: crypto.createHash('sha256').update(raw).digest('hex'), observedAt: '2026-09-05T10:02:00Z' };
  const prefix = platform === 'win32' ? 'D:\\fixture\\' : '/fixture/';
  const registration = { recordPath: `${prefix}registration.json`, nodePath: `${prefix}node`, runnerPath: `${prefix}runner.mjs`, runnerSha256: 'd'.repeat(64) };
  const body = { schemaVersion: 1, kind: 'ruvnet-brain-native-two-run-nightly-proof', platform,
    scope: 'installed-update', upstreamFreshness: 'UNKNOWN', registration,
    sourceSha: sourceSha, workflowRunId,
    observedAt: '2026-09-05T10:02:00Z', identity,
    candidate: { version: version, sha256: packageSha256, bundle: { sha256: bundleSha256,
      signatureBase64: crypto.sign(null, Buffer.from(bundleSha256, 'hex'), privateKey).toString('base64') } },
    runs: [receipt('one', 'applied'), receipt('two', 'noop')].map((row) => {
      row.schedulerIdentity = identity;
      row.executableIdentity = { schedulerIdentity: identity, registrationPath: registration.recordPath,
        nodePath: registration.nodePath, runnerPath: registration.runnerPath, runnerSha256: registration.runnerSha256, argv: [] };
      for (const phase of row.phases) {
        if (['update', 'host-convergence', 'cleanup'].includes(phase.phase)) continue;
        phase.evidence.execution = phase.phase === 'local-overlay-restoration' ? { kind: 'not-executed' }
          : { kind: 'imported-release', sourceSnapshot: sourceSha, upstreamFreshness: 'UNKNOWN' };
        if (phase.phase === 'local-overlay-restoration') phase.evidence.restoredStores = 0;
        if (phase.phase === 'source-enumeration') Object.assign(phase.evidence, { sourceObservationSha256: coverage.sourceObservationSha256, rows: 0, terminal: true });
        if (phase.phase === 'ingestion') Object.assign(phase.evidence, { eligibleCurrent: 0, storeCount: 1 });
        if (phase.phase === 'bundle-assembly') Object.assign(phase.evidence, { version, sourceSnapshot: sourceSha });
        if (phase.phase === 'generation-ledger-reconciliation') phase.evidence.sha256 = coverage.generationLedger.sha256;
        if (phase.phase === 'coverage-generation') Object.assign(phase.evidence, {
          coverageSha256: projection.sha256, releaseCoverageGeneration: coverage.releaseCoverageGeneration });
      }
      return { runId: row.runId, terminalVerdict: row.terminalVerdict, receipt: row, receiptSha256: digest(row),
        installedCoverage: { ...projection, observedAt: row.finishedAt }, trigger: { kind: { linux: 'cron-tick', darwin: 'launchctl-kickstart', win32: 'schtasks-run' }[platform], identity } };
    }), inventory: { before: inventory(), afterFirst: inventory(), afterSecond: inventory() },
    retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
    validation: { ok: true, failures: [] } };
  return { ...body, receiptSha256: digest(body) };
}
