// tests/unit/corpus-aggregates.test.mjs — Step 3 (2026-09-13): buildConceptAggregate no longer
// does its own private fencing (materializePublicInputs already did it, exactly once, upstream) and
// rebuildCorpusAggregates now REQUIRES the concepts observation identity to exactly equal corpus
// coverage's own observation identity (rule 8), rather than trusting an accidental shared reference.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildConceptAggregate, rebuildCorpusAggregates } from '../../scripts/corpus-aggregates.mjs';
import { materializePublicInputs } from '../../scripts/public-inputs.mjs';

const temps = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-aggregates-test-'));
  temps.push(dir);
  return dir;
}
afterEach(() => { while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true }); });

const HEX64_A = crypto.createHash('sha256').update('observation-a').digest('hex');
const HEX64_B = crypto.createHash('sha256').update('observation-b').digest('hex');

function makeBuilderRoot() {
  const root = temp();
  const kb = path.join(root, 'kb');
  fs.mkdirSync(path.join(kb, 'l2'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  fs.writeFileSync(path.join(kb, 'sample-repo-primer.md'), '# sample-repo\n\nprimer body.');
  return root;
}

describe('buildConceptAggregate — trusts an already-fenced publicInputDir, does no fencing itself', () => {
  it('requires a valid public input selection receipt', () => {
    const root = makeBuilderRoot();
    expect(() => buildConceptAggregate({
      publicInputDir: path.join(root, 'kb'), selectionReceipt: null,
      observationSha256: HEX64_A, outDir: temp(),
    })).toThrow(/valid public input selection receipt/i);
  });

  it('builds passages from whatever is in publicInputDir, using the receipt\'s resolved ownership', () => {
    const root = makeBuilderRoot();
    const kb = path.join(root, 'kb');
    const publicInputs = materializePublicInputs({ builderRoot: root, outDir: kb });
    const out = temp();
    const result = buildConceptAggregate({
      publicInputDir: kb, selectionReceipt: publicInputs.selectionReceipt,
      observationSha256: HEX64_A, outDir: out,
    });
    expect(result.passages).toBeGreaterThan(0);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'concepts.sources.json'), 'utf8'));
    expect(receipt.observationSha256).toBe(HEX64_A);
    expect(receipt.selectionReceiptSha256).toBe(publicInputs.selectionReceipt.receiptSha256);
    // Rule 9: freshly generated every time, never merged with a stale checkout copy.
    const classes = JSON.parse(fs.readFileSync(path.join(out, 'public-store-classes.json'), 'utf8'));
    expect(classes).toEqual({ schemaVersion: 1, derived: [{ store: 'concepts', receipt: 'concepts.sources.json' }] });
  });
});

describe('rebuildCorpusAggregates — rule 8: concepts observation must exactly equal coverage\'s own', () => {
  const stubBuildVector = async ({ assetsDir, store }) => {
    // A real forge-big.mjs run embeds; here we just stand up the minimal RVF-shaped sidecars the
    // rest of the pipeline (writeRvfGeneration, promoteArtifactSet) expects to find.
    fs.writeFileSync(path.join(assetsDir, `${store}.big.rvf`), '');
    fs.writeFileSync(path.join(assetsDir, `${store}.big.rvf.idmap.json`), '{}');
    fs.writeFileSync(path.join(assetsDir, `${store}.big.rvf.embed.json`), '{}');
  };

  it('throws when coverage is omitted entirely', async () => {
    const root = makeBuilderRoot();
    const assets = temp();
    await expect(rebuildCorpusAggregates({
      assetsDir: assets, root,
      observation: { observationSha256: HEX64_A, gists: { rows: [] } },
      buildVector: stubBuildVector,
    })).rejects.toThrow(/exactly equal the corpus coverage observation identity/i);
  });

  it('throws when coverage.sourceObservationSha256 differs from the observation actually used', async () => {
    const root = makeBuilderRoot();
    const assets = temp();
    await expect(rebuildCorpusAggregates({
      assetsDir: assets, root,
      observation: { observationSha256: HEX64_A, gists: { rows: [] } },
      coverage: { sourceObservationSha256: HEX64_B },
      buildVector: stubBuildVector,
    })).rejects.toThrow(/exactly equal the corpus coverage observation identity/i);
  });

  it('succeeds and rebuilds concepts when the two observation identities exactly match', async () => {
    const root = makeBuilderRoot();
    const assets = temp();
    const result = await rebuildCorpusAggregates({
      assetsDir: assets, root,
      observation: { observationSha256: HEX64_A, gists: { rows: [] } },
      coverage: { sourceObservationSha256: HEX64_A },
      buildVector: stubBuildVector,
    });
    expect(result.rebuilt).toEqual(['concepts']);
    expect(fs.existsSync(path.join(assets, 'concepts.sources.json'))).toBe(true);
    expect(fs.existsSync(path.join(assets, 'sample-repo-primer.md'))).toBe(true);
  });
});
