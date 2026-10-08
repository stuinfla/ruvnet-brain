import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../../scripts/source-scope-receipt.mjs';
import {
  PRODUCT_INTEGRITY_OBLIGATIONS,
  PRODUCT_INTEGRITY_PROCESSES,
  buildProductIntegrityTrace,
  renderProductIntegrityTraceMarkdown,
  validateProductIntegrityContract,
  validateProductIntegrityTrace,
} from '../../scripts/product-integrity-contract.mjs';

const clone = () => ({ processes: structuredClone(PRODUCT_INTEGRITY_PROCESSES),
  obligations: structuredClone(PRODUCT_INTEGRITY_OBLIGATIONS) });

describe('ADR-072 executable product-integrity contract', () => {
  it('a required obligation cannot retire its only proof by relabeling it obsolete', () => {
    const input = clone(), behavior = input.obligations[0].behaviors[0];
    Object.assign(behavior, { class: 'obsolete', commands: [], positive: [], adversarial: [], receiptKinds: [] });
    expect(() => validateProductIntegrityContract(input)).toThrow(/no active essential behavior/);
  });

  const retirement = () => {
    const input = clone(), row = input.obligations[0], active = row.behaviors[0];
    row.behaviors.push({ id: `${row.id}.legacy`, class: 'obsolete', commands: [], positive: [], adversarial: [],
      receiptKinds: [], replacementBehaviorId: active.id });
    return input;
  };

  it('permits explicit same-obligation active essential replacement and optional support', () => {
    const input = retirement(), row = input.obligations[0];
    row.behaviors.push({ id: `${row.id}.optional`, class: 'supporting', commands: [], positive: [], adversarial: [], receiptKinds: [] });
    const contract = validateProductIntegrityContract(input);
    expect(contract.obligations[0].behaviors.at(-2).replacementBehaviorId).toBe(row.behaviors[0].id);
    expect(contract.obligations[0].behaviors.at(-1).class).toBe('supporting');
  });

  it.each(['missing', 'stale', 'foreign', 'self', 'supporting'])('rejects %s replacement instead of silently losing essential proof', kind => {
    const input = retirement(), row = input.obligations[0], retired = row.behaviors.at(-1);
    if (kind === 'missing') delete retired.replacementBehaviorId;
    if (kind === 'stale') retired.replacementBehaviorId = 'removed-behavior';
    if (kind === 'foreign') retired.replacementBehaviorId = input.obligations[1].behaviors[0].id;
    if (kind === 'self') retired.replacementBehaviorId = retired.id;
    if (kind === 'supporting') {
      row.behaviors.push({ id: 'support-only', class: 'supporting', commands: [], positive: [], adversarial: [], receiptKinds: [] });
      retired.replacementBehaviorId = 'support-only';
    }
    expect(() => validateProductIntegrityContract(input)).toThrow(/no active essential replacement/);
  });

  it('a replacement must retain the existing actual positive/adversarial proof requirements', () => {
    for (const field of ['commands', 'positive', 'adversarial', 'receiptKinds']) {
      const input = retirement(); input.obligations[0].behaviors[0][field] = [];
      expect(() => validateProductIntegrityContract(input)).toThrow(new RegExp(`no ${field}`));
    }
  });

  it('defines the exact eight-process graph and S-1 through S-12 with derived ownership', () => {
    const contract = validateProductIntegrityContract();
    expect(contract.processes).toHaveLength(8);
    expect(contract.obligations.map(({ id }) => id)).toEqual(Array.from({ length: 12 }, (_, index) => `S-${index + 1}`));
    expect(contract.processes.find(({ id }) => id === 'ProductIntegrityCase').owns).toEqual(['S-8', 'S-9', 'S-10', 'S-11', 'S-12']);
    expect(contract.obligations.find(({ id }) => id === 'S-11').architecture).toEqual(
      expect.arrayContaining(['ADR-073', 'DDD-0019']),
    );
    expect(contract.obligations.find(({ id }) => id === 'S-12').architecture).toEqual(
      expect.arrayContaining(['ADR-074', 'DDD-0020']),
    );
    expect(contract.obligations.find(({ id }) => id === 'S-12')).toMatchObject({
      implementation: expect.arrayContaining([
        'plugin/scripts/capability-claim-evidence.mjs',
        'plugin/mcp/managed-cli-interface.mjs',
      ]),
      behaviors: [expect.objectContaining({
        receiptKinds: expect.arrayContaining([
          'ruvnet-brain-source-claim',
          'ruvnet-brain-live-surface',
          'ruvnet-brain-capability-claim-aggregate',
        ]),
      })],
    });
  });

  it.each([
    ['missing process', (input) => input.processes.pop(), /exact eight processes/],
    ['unknown upstream', (input) => input.processes[1].upstream.push('unknown'), /invalid upstream/],
    ['cycle', (input) => input.processes[0].upstream.push('ProductIntegrityCase'), /cycle/],
    ['missing obligation', (input) => input.obligations.pop(), /missing, duplicated, or out of order/],
    ['duplicate obligation', (input) => { input.obligations[1].id = 'S-1'; }, /missing, duplicated, or out of order/],
    ['invalid owner', (input) => { input.obligations[0].owner = 'WorkflowYaml'; }, /no valid sole owner/],
    ['owner contributor', (input) => input.obligations[0].contributors.push('CorpusGeneration'), /invalid contributor/],
    ['missing implementation', (input) => { input.obligations[0].implementation = []; }, /no implementation/],
    ['missing positive proof', (input) => { input.obligations[0].behaviors[0].positive = []; }, /no positive/],
    ['missing adversarial proof', (input) => { input.obligations[0].behaviors[0].adversarial = []; }, /no adversarial/],
    ['invalid proof strength', (input) => { input.obligations[0].behaviors[0].positive[0].strength = 'string'; }, /invalid proof/],
  ])('fails closed for %s', (_label, mutate, expected) => {
    const input = clone(); mutate(input);
    expect(() => validateProductIntegrityContract(input)).toThrow(expected);
  });

  it('builds a source-bound trace and rejects verdict, source, digest, and governed-byte mutations', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-trace-'));
    const contract = validateProductIntegrityContract();
    const governed = [...new Set([...contract.architecture.map(({ path: file }) => file),
      ...contract.obligations.flatMap(({ implementation, behaviors }) => [...implementation,
        ...behaviors.flatMap(({ positive, adversarial }) => [...positive, ...adversarial].map(({ file }) => file))])])];
    for (const file of governed) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), file); }
    const inventory = () => [...governed].sort(); const sourceSha = 'a'.repeat(40);
    const trace = buildProductIntegrityTrace({ root, sourceSha, contract, inventory });
    expect(trace).toMatchObject({ schemaVersion: 2, evidenceScope: 'contract-and-source-byte-inventory', semanticReviewVerified: false, behaviorVerified: false, untested: ['semantic-review', 'behavior-execution'] });
    expect(trace.sourceScope.semanticReview).toEqual({ status: 'UNKNOWN', performed: false });
    expect(validateProductIntegrityTrace(trace, { root, sourceSha, inventory })).toBe(trace);
    for (const mutate of [
      (copy) => { copy.verdict = 'FAIL'; }, (copy) => { copy.sourceSha = 'b'.repeat(40); },
      (copy) => { copy.schemaVersion = 1; }, (copy) => { copy.semanticReviewVerified = true; },
      (copy) => { copy.untested = []; }, (copy) => { copy.contractSha256 = '0'.repeat(64); }, (copy) => { copy.traceSha256 = '0'.repeat(64); },
    ]) { const copy = structuredClone(trace); mutate(copy); expect(() => validateProductIntegrityTrace(copy, { root, sourceSha, inventory })).toThrow(); }
    // Valid digests cannot turn a legacy or inflated claim into current authority.
    for (const mutate of [
      (copy) => { copy.schemaVersion = 1; delete copy.evidenceScope; delete copy.semanticReviewVerified; delete copy.behaviorVerified; copy.untested = []; },
      (copy) => { copy.semanticReviewVerified = true; },
      (copy) => { copy.behaviorVerified = true; },
      (copy) => { copy.untested = []; },
    ]) {
      const copy = structuredClone(trace); mutate(copy);
      const { traceSha256, ...unsigned } = copy; copy.traceSha256 = digest(unsigned);
      expect(() => validateProductIntegrityTrace(copy, { root, sourceSha, inventory })).toThrow(/identity is invalid or legacy/);
    }
    fs.writeFileSync(path.join(root, governed[0]), 'mutated');
    expect(() => validateProductIntegrityTrace(trace, { root, sourceSha, inventory })).toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('replacement migration trace remains source-only and rejects resealed retirement of its active target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-retirement-trace-'));
    try {
      const contract = validateProductIntegrityContract(retirement());
      const governed = [...new Set([...contract.architecture.map(row => row.path), ...contract.obligations.flatMap(row => [
        ...row.implementation, ...row.behaviors.flatMap(behavior => [...behavior.positive, ...behavior.adversarial].map(proof => proof.file)),
      ])])];
      for (const file of governed) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), file); }
      const inventory = () => [...governed].sort(), sourceSha = 'a'.repeat(40);
      const trace = buildProductIntegrityTrace({ root, sourceSha, contract, inventory });
      expect(validateProductIntegrityTrace(trace, { root, sourceSha, inventory })).toBe(trace);
      expect(trace).toMatchObject({ evidenceScope: 'contract-and-source-byte-inventory', semanticReviewVerified: false, behaviorVerified: false });
      const forged = structuredClone(trace); forged.contract.obligations[0].behaviors[0].class = 'supporting';
      forged.contractSha256 = digest(forged.contract); const { traceSha256, ...body } = forged; forged.traceSha256 = digest(body);
      expect(() => validateProductIntegrityTrace(forged, { root, sourceSha, inventory })).toThrow(/no active essential behavior/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('renders the generated Markdown deterministically' , () => {
    expect(renderProductIntegrityTraceMarkdown()).toBe(renderProductIntegrityTraceMarkdown());
    expect(renderProductIntegrityTraceMarkdown()).toContain('| ProductIntegrityCase |');
  });
});
