import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageExactBundle, validateTwoRunEvidence } from '../../scripts/nightly-two-run-proof.mjs';
import { REQUIRED_REFRESH_PHASES } from '../../kb/refresh-run.mjs';
import { validateRefreshReceiptEnvelope } from '../../plugin/scripts/nightly-scheduler.mjs';
import { managedStorageInventory } from '../../kb/update-storage-transaction.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const inventory = (copies = 0, bytes = 100) => ({ additionalFullCorpusCopyCount: copies,
  totalManagedBytes: bytes });
// Structural fixtures only: these do not represent actual scheduler executions.
const receipt = (runId, terminalVerdict) => ({ runId, schedulerIdentity: 'proof', terminalVerdict,
  schemaVersion: 3, kind: 'ruvnet-brain-refresh-run', status: 'SUCCEEDED',
  requiredPhaseOrder: [...REQUIRED_REFRESH_PHASES],
  startedAt: '2026-09-05T10:00:00Z', finishedAt: '2026-09-05T10:01:00Z',
  phases: REQUIRED_REFRESH_PHASES.map((phase) => ({ phase, status: 'PASS', at: '2026-09-05T10:00:30Z',
    evidence: { execution: { kind: 'executed', runId } } })),
  detail: { storageDelta: { redundantCopyCount: 0, additionalFullCorpusCopyDelta: 0 } } });
const envelope = (value) => ({ ok: ['applied', 'noop'].includes(value.terminalVerdict), why: 'bad envelope' });

describe('native two-run nightly proof', () => {
  it.each(['kb.install-preserved-old', 'kb.install-prior-crash', '.kb.install-stage-partial'])(
    'rejects bounded retention with observed installer copy %s', (name) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-extra-copy-'));
      roots.push(root);
      const live = path.join(root, 'kb');
      fs.mkdirSync(live);
      fs.writeFileSync(path.join(live, 'public.txt'), 'public');
      fs.mkdirSync(path.join(root, name));
      fs.writeFileSync(path.join(root, name, 'private.txt'), 'retained private bytes');
      const measured = managedStorageInventory(live);
      const result = validateTwoRunEvidence({ first: receipt('one', 'applied'), second: receipt('two', 'noop'),
        inventoryBefore: measured, inventoryAfterFirst: measured, inventoryAfterSecond: measured,
        retention: { withinBudget: true, unsafe: [], before: { bytes: 0 }, after: { bytes: 0 } },
        validateEnvelope: envelope, identity: 'proof' });
      expect(result.ok).toBe(false);
      expect(result.failures.join(' ')).toContain('redundant corpus copies');
      expect(fs.readFileSync(path.join(root, name, 'private.txt'), 'utf8')).toBe('retained private bytes');
    });

  it.each(['imported-release', 'validated-legacy'])('does not promote old %s evidence into current-run execution', (kind) => {
    const first = receipt('one', 'applied');
    const second = receipt('two', 'noop');
    for (const run of [first, second]) {
      run.phases[0].evidence = { sourceObservationAt: '2020-01-01T00:00:00Z',
        execution: { kind, upstreamFreshness: 'UNKNOWN' } };
      expect(validateRefreshReceiptEnvelope(run).ok).toBe(true);
    }
    const result = validateTwoRunEvidence({ first, second,
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: validateRefreshReceiptEnvelope, identity: 'proof' });
    expect(result.ok).toBe(false);
    expect(result.failures.join(' ')).toMatch(/source-enumeration.*current.run execution/i);
  });

  it.each(['wrong-run', 'old-time', 'missing-evidence'])('rejects %s execution provenance', (mutant) => {
    const first = receipt('one', 'applied');
    if (mutant === 'wrong-run') first.phases[0].evidence.execution.runId = 'another-run';
    if (mutant === 'old-time') first.phases[0].at = '2020-01-01T00:00:00Z';
    if (mutant === 'missing-evidence') delete first.phases[0].evidence;
    expect(validateTwoRunEvidence({ first, second: receipt('two', 'noop'),
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: envelope, identity: 'proof' }).ok).toBe(false);
  });

  it('stages and cryptographically binds the exact regular candidate bundle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-proof-bundle-'));
    roots.push(root);
    const packageRoot = path.join(root, 'package');
    const bundle = path.join(root, 'candidate.zip');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(bundle, 'exact candidate bytes');

    const staged = stageExactBundle({ bundlePath: bundle, packageRoot });

    expect(staged.sourcePath).toBe(bundle);
    expect(staged.stagedPath).toBe(path.join(packageRoot, 'dist', 'ruvnet-brain.zip'));
    expect(staged.bytes).toBe(21);
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(staged.stagedPath, 'utf8')).toBe('exact candidate bytes');
  });

  it('rejects a symlink or non-zip input instead of staging ambiguous bundle bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-proof-bundle-'));
    roots.push(root);
    const packageRoot = path.join(root, 'package');
    const target = path.join(root, 'target.zip');
    const link = path.join(root, 'link.zip');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(target, 'bytes');
    fs.symlinkSync(target, link);

    expect(() => stageExactBundle({ bundlePath: link, packageRoot })).toThrow(/regular candidate bundle/);
    expect(() => stageExactBundle({ bundlePath: target.replace(/\.zip$/, '.tgz'), packageRoot }))
      .toThrow(/regular candidate bundle/);
  });

  it('requires two distinct converged runs, a second-run no-op, no redundant corpus, and bounded evidence', () => {
    expect(validateTwoRunEvidence({ first: receipt('one', 'applied'), second: receipt('two', 'noop'),
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: envelope, identity: 'proof' })).toEqual({ ok: true, failures: [] });
  });

  it.each([
    ['same run', { second: receipt('one', 'noop') }],
    ['second applied', { second: receipt('two', 'applied') }],
    ['redundant copy', { inventoryAfterSecond: inventory(1) }],
    ['over budget', { retention: { withinBudget: false, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } } }],
    ['unsafe evidence', { retention: { withinBudget: true, unsafe: [{}], before: { bytes: 5 }, after: { bytes: 5 } } }],
  ])('rejects %s', (_label, override) => {
    const input = { first: receipt('one', 'applied'), second: receipt('two', 'noop'),
      inventoryBefore: inventory(), inventoryAfterFirst: inventory(), inventoryAfterSecond: inventory(),
      retention: { withinBudget: true, unsafe: [], before: { bytes: 5 }, after: { bytes: 5 } },
      validateEnvelope: envelope, identity: 'proof', ...override };
    expect(validateTwoRunEvidence(input).ok).toBe(false);
  });
});
