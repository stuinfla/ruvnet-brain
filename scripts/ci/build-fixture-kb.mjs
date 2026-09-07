#!/usr/bin/env node
// scripts/ci/build-fixture-kb.mjs — the fixture-staging logic shared by:
//   • tests/mutation/install-selfcheck-consumption-mutation.test.mjs (M-D8b, local)
//   • .github/workflows/stranger-matrix.yml (ADR-058 §D8, the stranger's-machine matrix)
//
// Stages a MINIMAL but REAL KB-bundle directory: the real forge-mcp-all.mjs (copied from kb/ at the
// candidate SHA — so `--drop-mcp` deleting it for the seeded-broken scenario is a real, meaningful
// mutation, not a synthetic one), a fake `.rvf` marker (gatherInstallState() only checks EXISTENCE,
// never content), and `file:`-referenced reader-dep stubs for @xenova/transformers and @ruvector/rvf
// (installReader() runs a REAL `npm i` inside the unpacked bundle — verified empirically that it
// PRUNES any node_modules entry not declared as a dependency, even against an otherwise-empty
// package.json, so a manually-placed stub does not survive; `file:` deps make npm install them for
// real, from local paths, with zero network and zero real package weight).
//
// Deliberately NEVER ships forge-ask-all.mjs: its absence is what keeps bin/install.mjs's
// smokeQuery() from trying to warm a real local embedding model, keeping every matrix cell fast,
// offline, and hermetic — the same convention tests/integration/install-smoke.mjs's own "COMPLETE
// brain dir" fixture and the M-D8b mutation test both already rely on.
//
// This script only STAGES a directory — it deliberately does not zip it (zip/unzip tooling differs
// per OS: `zip -r` on POSIX, PowerShell's `Compress-Archive` on Windows — that one step stays in the
// workflow YAML, native per runner).
//
//   node scripts/ci/build-fixture-kb.mjs --out <dir> [--drop-mcp] [--no-rvf]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { coverageGenerationFor, releaseCoverageGenerationFor, validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { validatePublicInventory } from '../public-inventory.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (flag, def = null) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const OUT = arg('--out');
const DROP_MCP = argv.includes('--drop-mcp'); // M-D8a: the seeded-broken scenario
const NO_RVF = argv.includes('--no-rvf');

if (!OUT) {
  console.error('usage: node scripts/ci/build-fixture-kb.mjs --out <dir> [--drop-mcp] [--no-rvf]');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });

if (!DROP_MCP) {
  fs.copyFileSync(path.join(REPO_ROOT, 'kb', 'forge-mcp-all.mjs'), path.join(OUT, 'forge-mcp-all.mjs'));
}

const xenStub = path.join(OUT, 'vendor', 'xenova-transformers-stub');
fs.mkdirSync(xenStub, { recursive: true });
fs.writeFileSync(path.join(xenStub, 'package.json'), '{"name":"@xenova/transformers","version":"0.0.0-fixture"}\n');
const ruvectorStub = path.join(OUT, 'vendor', 'ruvector-rvf-stub');
fs.mkdirSync(ruvectorStub, { recursive: true });
fs.writeFileSync(path.join(ruvectorStub, 'package.json'), '{"name":"@ruvector/rvf","version":"0.0.0-fixture"}\n');
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify({
  name: 'ruvnet-brain-kb-fixture',
  version: '0.0.0',
  private: true,
  dependencies: {
    '@xenova/transformers': 'file:vendor/xenova-transformers-stub',
    '@ruvector/rvf': 'file:vendor/ruvector-rvf-stub',
  },
}, null, 2));

// Synthetic coverage uses the production validators; it is not release evidence.
{
  const dir = OUT;
  const source = { brainVersion: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'))).version, stores: { fixture: {} } };
  fs.writeFileSync(path.join(dir, 'SOURCE.json'), JSON.stringify(source));
  const storeNames = ['fixture'];
  const sourceSnapshot = 'd'.repeat(40);
  const publicLedger = { schemaVersion: 2, kind: 'ruvnet-brain-public-generation-ledger',
    brainVersion: source.brainVersion, releaseTag: `v${source.brainVersion}`, sourceSnapshot, stores: {} };
  for (const name of storeNames) {
    const bytes = Buffer.alloc(512, 7);
    fs.writeFileSync(path.join(dir, `${name}.big.rvf`), bytes);
    publicLedger.stores[name] = { file: `${name}.big.rvf`, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length, sourceCommit: source.stores[name].sourceCommit || null,
      model: 'fixture-model', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z' };
  }
  const publicLedgerBytes = Buffer.from(`${JSON.stringify(publicLedger)}\n`);
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), `${JSON.stringify({ ...publicLedger,
    kind: 'ruvnet-brain-runtime-generation-ledger' })}\n`);
  fs.writeFileSync(path.join(dir, 'PUBLIC-RVF-GENERATIONS.json'), publicLedgerBytes);
  fs.writeFileSync(path.join(dir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  fs.writeFileSync(path.join(dir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
  const rows = storeNames.map((name) => ({ key: `repo:${name}`, kind: 'repository', name,
    url: `https://github.com/ruvnet/${name}`, status: 'CURRENT', disposition: 'eligible', upstream: {},
    artifact: { store: name }, reasons: [] }));
  const enumerationReceipt = { schemaVersion: 1, terminal: true, duplicateKeys: 0,
    repositories: { expected: rows.length, pages: [] }, gists: { expected: 0, pages: [] } };
  const generatorSourceSha = 'a'.repeat(64);
  const snapshotRoot = 'b'.repeat(64);
  const sourceObservationSha256 = 'c'.repeat(64);
  const policy = { policyDispositionDigests: [], exemptionDigests: [] };
  const corpus = { schemaVersion: 1, kind: 'ruvnet-brain-corpus-coverage', generatorSourceSha,
    snapshotRoot, sourceObservationSha256, rows, enumerationReceipt, policy,
    totals: { rows: rows.length, repositories: rows.length, gists: 0, byStatus: { CURRENT: rows.length } } };
  corpus.coverageGeneration = coverageGenerationFor({ generatorSourceSha, snapshotRoot,
    sourceObservationSha256, rows, enumerationReceipt, policyDispositionDigests: [], exemptionDigests: [] });
  const corpusBytes = `${JSON.stringify(corpus, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'CORPUS-COVERAGE.json'), corpusBytes);
  const publicInventory = validatePublicInventory({ assetsDir: dir, coverage: corpus, ledger: publicLedger });
  const release = { ...structuredClone(corpus), kind: 'ruvnet-brain-release-coverage',
    releaseIdentity: { version: source.brainVersion, tag: `v${source.brainVersion}`, sourceSnapshot },
    corpusSeed: { tag: `corpus-sha256-${'e'.repeat(64)}`, archiveSha256: 'e'.repeat(64), archiveBytes: 1,
      receiptSha256: 'f'.repeat(64) },
    corpusCoverage: { file: 'CORPUS-COVERAGE.json', sha256: crypto.createHash('sha256').update(corpusBytes).digest('hex'),
      coverageGeneration: corpus.coverageGeneration },
    generationLedger: { file: 'PUBLIC-RVF-GENERATIONS.json', sha256: crypto.createHash('sha256').update(publicLedgerBytes).digest('hex'),
      bytes: publicLedgerBytes.length, storeCount: storeNames.length },
    publicInventoryPartitionSha256: publicInventory.partitionSha256,
    installedProjectionSchema: 2 };
  delete release.coverageGeneration;
  release.releaseCoverageGeneration = releaseCoverageGenerationFor(release);
  fs.writeFileSync(path.join(dir, 'COVERAGE.json'), JSON.stringify(release));
  const validation = validateCoverageDirectory(dir, { expectedVersion: source.brainVersion });
  if (!validation.valid) throw new Error(validation.failures.join('; '));
  // Deliberately corrupt the validated fixture only for the early integrity-failure scenario.
  if (NO_RVF) fs.rmSync(path.join(dir, 'fixture.big.rvf'));
}

console.log(`[build-fixture-kb] staged ${OUT} (mcp: ${!DROP_MCP}, rvf: ${!NO_RVF})`);
