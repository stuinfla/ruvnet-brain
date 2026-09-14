// ADR-086 Step 15 — the C3 retrieval-accuracy gate.
//
// Dual's proof text names six things that MUST block candidate acceptance and publication:
//
//   "One below-threshold repository, missing partition, timeout, changed oracle, altered archive or
//    missing accuracy report blocks candidate acceptance and publication."
//
// Every one of them has a case below, and every case is written so that removing the guard it names
// makes it fail. The metric, threshold arithmetic and bounded-vs-complete marker are proven
// separately, because a gate whose arithmetic rounds or whose bounded run reads as a pass is not a
// gate at all.

import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  HIT_AT_K, QUERY_MODES, meetsThreshold, scoreEvidenceHit, validateAccuracyOracle,
  validateAccuracyReport, runRetrievalAccuracy, sha256Of,
} from '../../scripts/oracle/retrieval-accuracy.mjs';
import { createCorpusReceipt, verifyCorpusReceipt } from '../../scripts/corpus-candidate.mjs';
import {
  accuracyOracle, accuracyReportFor, buildAssets, fixtureReleaseRoot, seal, sealedCorpusBundle,
  writeAccuracyReport, SOURCE_COMMIT,
} from '../helpers/corpus-seed-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function temp(prefix = 'accuracy-gate-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** A sealed oracle file on disk, matching what scripts/oracle/retrieval-accuracy.mjs will re-derive. */
function writeOracle(dir, { partitions, labels, emptySources = [], mutate = (o) => o } = {}) {
  const body = mutate({
    schemaVersion: 1,
    kind: 'ruvnet-brain-retrieval-accuracy-oracle',
    oracleVersion: 'fixture/1',
    partitions,
    emptySources,
    labels,
    seal: {
      labelsSha256: sha256Of(canonical(labels.map((row) => ({
        id: row.id, partition: row.partition, question: row.question, span: row.span,
        sourcePath: row.sourcePath, blobSha: row.blobSha, unitSha256: row.unitSha256,
      })))),
      partitionsSha256: sha256Of(canonical(partitions.map((row) => ({
        partition: row.partition, kind: row.kind, store: row.store, sourceCommit: row.sourceCommit,
      })))),
    },
  });
  const file = path.join(dir, 'oracle.json');
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return file;
}

/** A search stub that answers from the oracle itself, so the harness measures the GATE, not retrieval. */
function answeringSearch({ hitFor = () => true, timeoutFor = () => false, throwFor = () => false, labels } = {}) {
  const byQuestion = new Map(labels.map((row) => [row.question, row]));
  return async ({ query, mode }) => {
    const label = byQuestion.get(query);
    if (throwFor(label, mode)) throw new Error('simulated retrieval failure');
    if (timeoutFor(label, mode)) return { timedOut: true, results: [] };
    if (!hitFor(label, mode)) {
      // A near-miss on purpose: the right FILE, no supporting span. C3 says this fails.
      return { timedOut: false, results: [{ store: label.partition, path: label.sourcePath, text: 'unrelated prose' }] };
    }
    return { timedOut: false, results: [{ store: label.partition, path: label.sourcePath, text: `... ${label.span} ...` }] };
  };
}

describe('C3 metric and threshold arithmetic', () => {
  it('compares 20 x successes >= 19 x N as exact integers — it never rounds a near miss up', () => {
    expect(meetsThreshold(19, 20)).toBe(true);
    expect(meetsThreshold(18, 19)).toBe(false); // 360 < 361 — 94.7% is not 95%, and rounding would pass it
    expect(meetsThreshold(95, 100)).toBe(true);
    expect(meetsThreshold(94, 100)).toBe(false);
    expect(meetsThreshold(38, 40)).toBe(true);
    expect(meetsThreshold(37, 40)).toBe(false);
  });

  it('treats N=0 as NOT MEASURED, never as a vacuous pass', () => {
    expect(meetsThreshold(0, 0)).toBe(false);
  });

  it('fails a matching file path that does not carry the supporting span', () => {
    const label = { id: 'x', sourcePath: 'docs/zero.md', span: 'alpha passage zero' };
    expect(scoreEvidenceHit({
      results: [{ path: 'docs/zero.md', text: 'a different sentence entirely' }], label,
    })).toEqual({ hit: false, reason: 'path-matched-without-supporting-span' });
  });

  it('fails a supporting span that is attributed to the wrong source', () => {
    const label = { id: 'x', sourcePath: 'docs/zero.md', span: 'alpha passage zero' };
    expect(scoreEvidenceHit({
      results: [{ path: 'docs/elsewhere.md', text: 'alpha passage zero' }], label,
    }).hit).toBe(false);
  });

  it('passes only correctly attributed source evidence, and only within the first five results', () => {
    const label = { id: 'x', sourcePath: 'docs/zero.md', span: 'alpha passage zero' };
    const good = { path: 'docs/zero.md', text: 'prelude alpha passage zero coda' };
    const filler = { path: 'docs/other.md', text: 'noise' };
    expect(scoreEvidenceHit({ results: [good], label }).hit).toBe(true);
    expect(scoreEvidenceHit({ results: [...Array(HIT_AT_K - 1).fill(filler), good], label }).hit).toBe(true);
    // Rank six: the customer never sees it, so it is not a hit.
    expect(scoreEvidenceHit({ results: [...Array(HIT_AT_K).fill(filler), good], label }).hit).toBe(false);
  });

  it('normalizes whitespace so a re-wrapped passage still counts, without loosening to fuzzy matching', () => {
    const label = { id: 'x', sourcePath: 'docs/zero.md', span: 'alpha   passage\n zero' };
    expect(scoreEvidenceHit({ results: [{ path: 'docs/zero.md', text: 'alpha passage zero' }], label }).hit).toBe(true);
    expect(scoreEvidenceHit({ results: [{ path: 'docs/zero.md', text: 'alpha passage one' }], label }).hit).toBe(false);
  });
});

describe('oracle ground truth must trace to upstream bytes', () => {
  const base = () => {
    const { partitions, labels } = accuracyOracle({ labels: 2 });
    return { partitions, labels };
  };

  it('accepts a sealed oracle whose rows carry upstream blob and unit identities', () => {
    const dir = temp();
    const file = writeOracle(dir, base());
    expect(() => validateAccuracyOracle(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toThrow();
  });

  it('rejects a label with no upstream git blob identity — the shape a passage-sidecar-derived label has', () => {
    const dir = temp();
    const { partitions, labels } = base();
    const file = writeOracle(dir, {
      partitions,
      labels,
      mutate: (oracle) => { delete oracle.labels[0].blobSha; return oracle; },
    });
    expect(() => validateAccuracyOracle(JSON.parse(fs.readFileSync(file, 'utf8'))))
      .toThrow(/carries no upstream git blob identity/i);
  });

  it('rejects a row edited in place after sealing', () => {
    const dir = temp();
    const { partitions, labels } = base();
    const file = writeOracle(dir, {
      partitions,
      labels,
      mutate: (oracle) => { oracle.labels[0].span = 'something else entirely'; return oracle; },
    });
    expect(() => validateAccuracyOracle(JSON.parse(fs.readFileSync(file, 'utf8'))))
      .toThrow(/seal does not match/i);
  });

  it('rejects an empty-source claim with no independent emptiness evidence', () => {
    const dir = temp();
    const { partitions, labels } = base();
    const file = writeOracle(dir, {
      partitions,
      labels,
      emptySources: [{ store: 'ghost', sourceCommit: SOURCE_COMMIT }],
    });
    expect(() => validateAccuracyOracle(JSON.parse(fs.readFileSync(file, 'utf8'))))
      .toThrow(/independent emptiness evidence/i);
  });
});

describe('the benchmark measures the extracted final archive and marks bounded runs as bounded', () => {
  async function bench(overrides = {}, oracleOverrides = {}) {
    const dir = temp();
    const { bundle } = await sealedCorpusBundle(dir, { accuracy: null });
    const { partitions, labels } = accuracyOracle({ labels: 20 });
    const oracleFile = writeOracle(dir, { partitions, labels, ...oracleOverrides });
    const { report } = await runRetrievalAccuracy({
      bundleFile: bundle,
      oracleFile,
      outFile: path.join(dir, 'accuracy.json'),
      search: answeringSearch({ labels, ...overrides }),
      now: () => '2026-09-14T00:00:00.000Z',
      ...overrides.run,
    });
    return { dir, bundle, report, labels, oracleFile };
  }

  it('produces a complete, all-PASS report bound to the exact archive digest', async () => {
    const { bundle, report } = await bench();
    expect(report.coverage.complete).toBe(true);
    expect(report.coverage.bounded).toBeNull();
    expect(report.state).toBe('PASS');
    expect(report.archive.sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'));
    // Both modes, separately, for the one shipped partition.
    expect(report.partitions.map((row) => row.mode).sort()).toEqual([...QUERY_MODES].sort());
    expect(report.partitions.every((row) => row.n === 20 && row.successes === 20)).toBe(true);
  });

  it('MUST BLOCK: one below-threshold repository fails its partition and the whole run', async () => {
    // Two misses in twenty is 18/20: 360 < 380. One miss (19/20) would still pass, which is the point.
    let misses = 0;
    const { report } = await bench({ hitFor: () => (misses++ < 2 ? false : true) });
    const failing = report.partitions.filter((row) => row.state !== 'PASS');
    expect(failing.length).toBeGreaterThan(0);
    expect(failing[0].successes + failing[0].failures).toBe(failing[0].n);
    expect(report.state).toBe('FAIL');
  });

  it('MUST BLOCK: a timeout counts as a failure in the denominator AND fails the run outright', async () => {
    let once = false;
    const { report } = await bench({ timeoutFor: () => { if (once) return false; once = true; return true; } });
    const timedOut = report.partitions.find((row) => row.timeouts > 0);
    expect(timedOut).toBeTruthy();
    expect(timedOut.successes + timedOut.failures).toBe(timedOut.n); // never excluded from N
    expect(timedOut.state).toBe('FAIL'); // 19/20 clears 20x>=19x, so ONLY the timeout rule can fail it
    expect(report.state).toBe('FAIL');
  });

  it('counts an erroring query as a failure rather than dropping it from the denominator', async () => {
    let once = false;
    const { report } = await bench({ throwFor: () => { if (once) return false; once = true; return true; } });
    const errored = report.partitions.find((row) => row.errors > 0);
    expect(errored.successes + errored.failures).toBe(errored.n);
    expect(errored.failedLabels.some((row) => /^error: /.test(row.reason))).toBe(true);
  });

  it('a bounded --sample run is marked incomplete even when every answer is a hit', async () => {
    const dir = temp();
    const { bundle } = await sealedCorpusBundle(dir, { accuracy: null });
    const { partitions, labels } = accuracyOracle({ labels: 20 });
    const oracleFile = writeOracle(dir, { partitions, labels });
    const { report } = await runRetrievalAccuracy({
      bundleFile: bundle, oracleFile, outFile: path.join(dir, 'accuracy.json'),
      sampleLimit: 5, search: answeringSearch({ labels }), now: () => '2026-09-14T00:00:00.000Z',
    });
    expect(report.partitions.every((row) => row.successes === row.n)).toBe(true); // 5/5 in both modes
    expect(report.coverage.complete).toBe(false);
    expect(report.coverage.bounded.reasons.join(' ')).toMatch(/--sample 5/);
    expect(report.state).toBe('FAIL'); // a bounded run is never presentable as a corpus-wide pass
  });

  it('MUST BLOCK: a shipped store with no oracle partition leaves the run incomplete', async () => {
    const dir = temp();
    const bundleDir = await buildAssets(dir);
    // A second shipped store that the oracle says nothing about — "an aggregate score cannot hide
    // one missing gist".
    fs.copyFileSync(path.join(bundleDir, 'alpha.big.rvf'), path.join(bundleDir, 'beta.big.rvf'));
    const bundle = seal(dir, bundleDir, { accuracy: null });
    const { partitions, labels } = accuracyOracle({ labels: 20 });
    const oracleFile = writeOracle(dir, { partitions, labels });
    const { report } = await runRetrievalAccuracy({
      bundleFile: bundle, oracleFile, outFile: path.join(dir, 'accuracy.json'),
      search: answeringSearch({ labels }), now: () => '2026-09-14T00:00:00.000Z',
    });
    expect(report.coverage.uncoveredArchiveStores).toContain('beta');
    expect(report.coverage.complete).toBe(false);
    expect(report.state).toBe('FAIL');
  });
});

describe('validateAccuracyReport re-derives every number rather than trusting the report', () => {
  const archive = { file: 'ruvnet-brain.zip', sha256: 'a'.repeat(64), bytes: 10 };
  const report = (overrides = {}) => {
    const base = accuracyReportFor(__filename); // placeholder archive identity, replaced below
    return { ...base, archive, ...overrides };
  };

  it('accepts a complete, all-PASS report bound to the archive', () => {
    expect(() => validateAccuracyReport({ report: report(), archive })).not.toThrow();
  });

  it('MUST BLOCK: an altered archive breaks the binding', () => {
    expect(() => validateAccuracyReport({ report: report(), archive: { ...archive, sha256: 'b'.repeat(64) } }))
      .toThrow(/not bound to this exact final archive/i);
  });

  it('MUST BLOCK: a changed oracle', () => {
    expect(() => validateAccuracyReport({
      report: report(), archive, expectedOracleSha256: 'f'.repeat(64),
    })).toThrow(/different retrieval oracle/i);
  });

  it('MUST BLOCK: a patched benchmark generator', () => {
    expect(() => validateAccuracyReport({
      report: report(), archive, expectedGeneratorSha256: 'f'.repeat(64),
    })).toThrow(/different benchmark generator/i);
  });

  it('MUST BLOCK: a report claiming PASS while a partition is below threshold', () => {
    const tampered = report();
    tampered.partitions = tampered.partitions.map((row) => ({ ...row, successes: 18, failures: 2, state: 'PASS' }));
    expect(() => validateAccuracyReport({ report: tampered, archive })).toThrow(/below threshold: 18\/20/);
  });

  it('MUST BLOCK: a partition that changed its denominator after the fact', () => {
    const tampered = report();
    tampered.partitions = tampered.partitions.map((row) => ({ ...row, n: 18, successes: 18, failures: 2 }));
    expect(() => validateAccuracyReport({ report: tampered, archive })).toThrow(/changed its denominator/i);
  });

  it('MUST BLOCK: a missing query mode', () => {
    const tampered = report();
    tampered.partitions = tampered.partitions.filter((row) => row.mode === 'full-corpus');
    tampered.modes = ['full-corpus'];
    expect(() => validateAccuracyReport({ report: tampered, archive })).toThrow(/both the explicit-repository and full-corpus/i);
  });

  it('MUST BLOCK: N=0 is NOT MEASURED, not a pass', () => {
    const tampered = report();
    tampered.partitions = tampered.partitions.map((row) => ({ ...row, n: 0, successes: 0, failures: 0 }));
    expect(() => validateAccuracyReport({ report: tampered, archive })).toThrow(/NOT MEASURED/i);
  });

  it('MUST BLOCK: a bounded measurement presented for acceptance', () => {
    const tampered = report();
    tampered.coverage = { ...tampered.coverage, complete: false, bounded: { reasons: ['--stores 2'] } };
    expect(() => validateAccuracyReport({ report: tampered, archive })).toThrow(/BOUNDED measurement, not a corpus-wide pass/i);
  });

  it('MUST BLOCK: a timeout recorded anywhere in the run', () => {
    const tampered = report();
    tampered.partitions = tampered.partitions.map((row) => ({ ...row, timeouts: 1, successes: 19, failures: 1 }));
    expect(() => validateAccuracyReport({ report: tampered, archive })).toThrow(/timeout/i);
  });
});

describe('corpus receipt schema 3 binds the detached accuracy report', () => {
  async function sealed({ accuracy = {} } = {}) {
    const dir = temp();
    const { bundle, bundleDir } = await sealedCorpusBundle(dir, { accuracy });
    const receiptFile = path.join(dir, 'corpus-receipt.json');
    return { dir, bundle, bundleDir, receiptFile };
  }

  it('seals schemaVersion 3 with accuracyReport {file, sha256, bytes} (correction A6)', async () => {
    const { bundle, receiptFile } = await sealed();
    const receipt = await createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: 'a'.repeat(40), createdAt: '2026-09-14T00:00:00.000Z',
    });
    expect(receipt.schemaVersion).toBe(3);
    expect(Object.keys(receipt.accuracyReport).sort()).toEqual(['bytes', 'file', 'sha256']);
    expect(receipt.accuracyReport.file).toBe('ruvnet-brain.zip.accuracy.json');
    expect(receipt.accuracyReport.sha256)
      .toBe(crypto.createHash('sha256').update(fs.readFileSync(`${bundle}.accuracy.json`)).digest('hex'));
    await expect(verifyCorpusReceipt({ bundleFile: bundle, receiptFile })).resolves.toBeTruthy();
  });

  it('MUST BLOCK: a missing accuracy report cannot be sealed', async () => {
    const { bundle, receiptFile } = await sealed({ accuracy: null });
    await expect(createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: 'a'.repeat(40), createdAt: '2026-09-14T00:00:00.000Z',
    })).rejects.toThrow(/detached retrieval-accuracy report missing/i);
  });

  it('MUST BLOCK: an altered archive leaves the report bound to bytes that no longer exist', async () => {
    const { dir, bundle, bundleDir, receiptFile } = await sealed();
    await createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: 'a'.repeat(40), createdAt: '2026-09-14T00:00:00.000Z',
    });
    // Re-assemble the archive WITHOUT re-measuring it — exactly the "insert into an already measured
    // ZIP and keep its old identity" move the detached report exists to make impossible.
    fs.writeFileSync(path.join(bundleDir, 'alpha.meta.json'), fs.readFileSync(path.join(bundleDir, 'alpha.meta.json')) + ' ');
    seal(dir, bundleDir, { accuracy: null });
    await expect(verifyCorpusReceipt({ bundleFile: bundle, receiptFile }))
      .rejects.toThrow(/archive sha256 or byte length differs|not bound to this exact final archive/i);
  });

  it('MUST BLOCK: a tampered accuracy report is caught by re-derivation', async () => {
    const { bundle, receiptFile } = await sealed();
    await createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: 'a'.repeat(40), createdAt: '2026-09-14T00:00:00.000Z',
    });
    // Same measurement, one extra byte: the digest the receipt bound no longer describes the file.
    fs.appendFileSync(`${bundle}.accuracy.json`, '\n');
    await expect(verifyCorpusReceipt({ bundleFile: bundle, receiptFile }))
      .rejects.toThrow(/does not match the exact corpus archive contents/i);
  });

  it('MUST BLOCK: a bounded report cannot seal a candidate', async () => {
    const { bundle, receiptFile } = await sealed({ accuracy: null });
    writeAccuracyReport(bundle, {
      overrides: { coverage: { complete: false, bounded: { reasons: ['--stores 2'] }, archiveStores: ['alpha'], unmeasuredPartitions: [], uncoveredArchiveStores: [] } },
    });
    await expect(createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: 'a'.repeat(40), createdAt: '2026-09-14T00:00:00.000Z',
    })).rejects.toThrow(/BOUNDED measurement/i);
  });

  it('MUST BLOCK: a schema-2 receipt is unverifiable — schema-2 seeds become unpublishable', async () => {
    const { bundle, receiptFile } = await sealed();
    const receipt = await createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: 'a'.repeat(40), createdAt: '2026-09-14T00:00:00.000Z',
    });
    delete receipt.accuracyReport;
    fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, schemaVersion: 2 }, null, 2));
    await expect(verifyCorpusReceipt({ bundleFile: bundle, receiptFile }))
      .rejects.toThrow(/schema downgrade/i);
  });
});

describe('the CLI entry-point guard survives a symlinked invocation', () => {
  // The guard used to compare a NON-realpath argv[1] against a realpath'd module URL, so through any
  // symlink it decided it was not the entry point, ran nothing, and EXITED 0. On macOS every
  // os.tmpdir() path is symlinked, so every caller that stages work in a temp directory hit it:
  // build-bundle.mjs and corpus-candidate.mjs both silently no-opped while prepareCorpusCandidate
  // reported SUCCESS with no archive and no receipt on disk. Same defect and same fix as
  // plugin/scripts/hook-input.mjs:518. A test that only ran the real path would never have caught it,
  // so these invoke through a symlink on purpose.
  it.each([
    ['scripts/corpus-candidate.mjs', ['--bundle', '/definitely/missing.zip'], /bundle missing/i],
    ['scripts/oracle/retrieval-accuracy.mjs', ['--bundle', '/definitely/missing.zip'], /archive missing/i],
    ['scripts/corpus-reconcile.mjs', ['--seed-archive', '/definitely/missing.zip'], /bootstrap requires|seed archive missing/i],
  ])('%s actually runs when reached through a symlink', (rel, args, expected) => {
    const dir = temp('symlinked-cli-');
    const link = path.join(dir, path.basename(rel));
    fs.symlinkSync(path.join(ROOT, rel), link);
    const result = spawnSync(process.execPath, [link, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    // Exit 0 with empty output is the signature of the silent no-op this guards against.
    expect(`${result.stdout}${result.stderr}`.trim(), 'the CLI silently did nothing through a symlink').not.toBe('');
    expect(result.stderr).toMatch(expected);
    expect(result.status).toBe(1);
  });
});

describe('publication requires both bindings and the committed oracle', () => {
  // scripts/release.mjs has no main-module guard — importing it runs the whole release flow — so the
  // publication gate is exercised the way every other release-authority test exercises it: by
  // spawning it. The fixture root symlinks the REAL scripts/kb/plugin/keys (so the publisher and its
  // generator-identity hashes are genuine) and owns only `data/`, which is where the committed
  // retrieval-accuracy oracle a test needs can live without ever touching the tracked checkout.
  async function publishable({ reportOptions = {} } = {}) {
    const dir = temp('accuracy-publish-');
    const fixtureRoot = fixtureReleaseRoot(path.join(dir, 'root'));
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const log = path.join(dir, 'gh-calls.jsonl');
    const gh = path.join(bin, 'gh-fixture.mjs');
    fs.writeFileSync(gh, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') { console.error('release not found'); process.exit(1); }
process.exit(0);
`);
    fs.chmodSync(gh, 0o755);

    const { bundle } = await sealedCorpusBundle(dir, { accuracy: null });
    writeAccuracyReport(bundle, {
      oracleSha256: fixtureRoot.oracleSha256,
      generatorSha256: fixtureRoot.generatorSha256,
      ...reportOptions,
    });
    const receiptFile = path.join(dir, 'corpus-receipt.json');
    const receipt = await createCorpusReceipt({
      bundleFile: bundle, receiptFile, builderSourceSha: HEAD, createdAt: '2026-09-14T00:00:00.000Z',
    });
    const env = {
      ...process.env,
      GH_CALL_LOG: log,
      GITHUB_ACTIONS: 'true', GITHUB_WORKFLOW: 'protected-release', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: HEAD, GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
      GH_TOKEN: 'fixture-token',
      RUVNET_GH_COMMAND: process.execPath,
      RUVNET_GH_SCRIPT: gh,
    };
    const argv = [
      '--corpus-seed', '--corpus-tag', `corpus-sha256-${receipt.archive.sha256}`,
      '--corpus-bundle', bundle, '--corpus-receipt', receiptFile,
      '--target', HEAD, '--repo', 'stuinfla/ruvnet-brain',
    ];
    const run = ({ release = fixtureRoot.release } = {}) => spawnSync(
      process.execPath, [...fixtureRoot.nodeArgs, release, ...argv],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
    );
    const ghCalls = () => (fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : []);
    return { dir, bundle, receiptFile, receipt, run, ghCalls, fixtureRoot };
  }

  it('publishes the archive, the receipt AND the detached accuracy report as assets', async () => {
    const f = await publishable();
    const result = f.run();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const create = f.ghCalls().find((args) => args.includes('create'));
    expect(create).toContain(f.bundle);
    expect(create).toContain(f.receiptFile);
    expect(create).toContain(`${f.bundle}.accuracy.json`);
  });

  it('MUST BLOCK: a missing accuracy report beside the archive', async () => {
    const f = await publishable();
    fs.rmSync(`${f.bundle}.accuracy.json`);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/detached retrieval-accuracy report missing beside the archive/i);
    expect(f.ghCalls()).toHaveLength(0); // never reached gh
  });

  it('MUST BLOCK: a changed oracle — the report was measured against a different one than is committed', async () => {
    const f = await publishable();
    fs.writeFileSync(f.fixtureRoot.oracleFile, `${JSON.stringify({ fixture: 'a different oracle' })}\n`);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/different retrieval oracle/i);
    expect(f.ghCalls()).toHaveLength(0);
  });

  it('MUST BLOCK: an accuracy report whose bytes differ from the receipt binding', async () => {
    const f = await publishable();
    fs.appendFileSync(`${f.bundle}.accuracy.json`, '\n');
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/report bytes do not match the corpus receipt/i);
    expect(f.ghCalls()).toHaveLength(0);
  });

  it('MUST BLOCK: one below-threshold repository, even with the receipt forged to bind it', async () => {
    // A below-threshold report can never be SEALED (the candidate gate refuses it first), so the only
    // way it reaches publication is a forged receipt that binds the bad report's digest. That forgery
    // survives every well-formedness check and is caught here, before any gh call.
    const f = await publishable();
    const bad = accuracyReportFor(f.bundle, {
      oracleSha256: f.fixtureRoot.oracleSha256, generatorSha256: f.fixtureRoot.generatorSha256, successes: 18,
    });
    const reportFile = `${f.bundle}.accuracy.json`;
    fs.writeFileSync(reportFile, `${JSON.stringify(bad, null, 2)}\n`);
    const forged = {
      ...f.receipt,
      accuracyReport: {
        file: path.basename(reportFile),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(reportFile)).digest('hex'),
        bytes: fs.statSync(reportFile).size,
      },
    };
    fs.writeFileSync(f.receiptFile, JSON.stringify(forged, null, 2));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/below threshold: 18\/20/);
    expect(f.ghCalls()).toHaveLength(0);
  });

  it('MUST BLOCK: a schema-2 receipt is refused by runProtectedCorpusSeed', async () => {
    const f = await publishable();
    const downgraded = { ...f.receipt, schemaVersion: 2 };
    delete downgraded.accuracyReport;
    fs.writeFileSync(f.receiptFile, JSON.stringify(downgraded, null, 2));
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/bindings are incomplete or invalid/i);
    expect(f.ghCalls()).toHaveLength(0);
  });

  it('MUST BLOCK: a root with no committed retrieval-accuracy oracle at all', async () => {
    // The honest state of ADR-086 as of Step 15: the gate is wired and fail-closed, and the oracle it
    // demands is Step 14's deliverable. Until that oracle is committed, the real repository root
    // takes exactly this branch and corpus publication is blocked.
    const f = await publishable();
    fs.rmSync(f.fixtureRoot.oracleFile);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/committed retrieval-accuracy oracle is missing/i);
    expect(f.ghCalls()).toHaveLength(0);
  });
});
