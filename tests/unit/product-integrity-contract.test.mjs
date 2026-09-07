import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(validateProductIntegrityTrace(trace, { root, sourceSha, inventory })).toBe(trace);
    for (const mutate of [
      (copy) => { copy.verdict = 'FAIL'; }, (copy) => { copy.sourceSha = 'b'.repeat(40); },
      (copy) => { copy.contractSha256 = '0'.repeat(64); }, (copy) => { copy.traceSha256 = '0'.repeat(64); },
    ]) { const copy = structuredClone(trace); mutate(copy); expect(() => validateProductIntegrityTrace(copy, { root, sourceSha, inventory })).toThrow(); }
    fs.writeFileSync(path.join(root, governed[0]), 'mutated');
    expect(() => validateProductIntegrityTrace(trace, { root, sourceSha, inventory })).toThrow();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('renders the generated Markdown deterministically', () => {
    expect(renderProductIntegrityTraceMarkdown()).toBe(renderProductIntegrityTraceMarkdown());
    expect(renderProductIntegrityTraceMarkdown()).toContain('| ProductIntegrityCase |');
  });
});
