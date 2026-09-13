// tests/integration/public-inputs-packaging.test.mjs — Step 3 (2026-09-13), property 4:
// "Every input declared in concepts.sources.json survives packaging with IDENTICAL bytes" --
// build-bundle.mjs's packaged output matches byte-for-byte what materializePublicInputs /
// buildConceptAggregate actually produced, not a re-derived or re-filtered copy.
//
// Before this, build-bundle.mjs fabricated a circular concepts.sources.json whenever the real one
// was missing (its only declared "input" was its own already-packaged output), and independently
// re-discovered/re-filtered L2 + capability cards straight from checkout kb/ rather than trusting
// the reconciled assets directory. This test proves the fixed pipeline end to end: a real
// materializePublicInputs + buildConceptAggregate run (exactly what rebuildCorpusAggregates does in
// production) followed by a REAL build-bundle.mjs subprocess run, with byte-for-byte comparison.
//
// WHY SUBPROCESS for build-bundle.mjs: same reasoning as tests/integration/build-bundle-fence.test.mjs
// (loadPrivateStores() calls process.exit(1) at module top level; importing in-process would kill the
// test runner). No real network calls: observationSha256 is a synthetic hex64, not a live gh lookup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import(path.join(REPO_ROOT, 'bin/install.mjs'));
const { materializePublicInputs } = await import(path.join(REPO_ROOT, 'scripts/public-inputs.mjs'));
const { buildConceptAggregate } = await import(path.join(REPO_ROOT, 'scripts/corpus-aggregates.mjs'));

const FAKE_OBSERVATION_SHA256 = crypto.createHash('sha256').update('fixture-observation').digest('hex');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-inputs-packaging-'));
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'kb', 'l2'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'plugin/.claude-plugin'), { recursive: true });

  // Same derived-dependency-graph pattern as tests/integration/build-bundle-fence.test.mjs: copy
  // build-bundle.mjs's REAL import graph (now including scripts/public-inputs.mjs) rather than a
  // hand-typed dependency list that silently drifts.
  const src = path.join(REPO_ROOT, 'scripts/build-bundle.mjs');
  fs.copyFileSync(src, path.join(tmp, 'scripts/build-bundle.mjs'));
  for (const dep of serverDependencies(src)) {
    const target = path.resolve(path.join(tmp, 'scripts'), dep.spec);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(dep.from, target);
  }
  fs.writeFileSync(path.join(tmp, 'scripts/rvf-index-audit.mjs'),
    'export async function auditRvfIndexes(paths) { return paths.map((path) => ({ path, state: "PASS" })); }\n');
  fs.writeFileSync(path.join(tmp, 'data/registry.tiers.json'), JSON.stringify({ tiers: {} }));
  fs.writeFileSync(path.join(tmp, 'plugin/.claude-plugin/plugin.json'), JSON.stringify({ version: '0.0.0-test' }));
  fs.writeFileSync(path.join(tmp, 'kb/SOURCE.json'), JSON.stringify({
    brainVersion: '0.0.0-previous', releaseTag: 'v0.0.0-previous',
  }));
  // The rest of build-bundle.mjs's required-file gate, reached only once a real run gets past the
  // fence (build-bundle-fence.test.mjs never needs these -- every one of its scenarios FATALs
  // earlier). zip-extract.mjs is loaded via a literal dynamic import(), invisible to
  // serverDependencies' static-import walk, so it is copied explicitly, verbatim (Node builtins only).
  fs.copyFileSync(path.join(REPO_ROOT, 'kb/zip-extract.mjs'), path.join(tmp, 'kb/zip-extract.mjs'));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts/verify-bundle.mjs'), path.join(tmp, 'scripts/verify-bundle.mjs'));
  fs.mkdirSync(path.join(tmp, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'keys/ruvnet-brain-signing.pub.pem'), '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n');
  fs.writeFileSync(path.join(tmp, 'kb/package.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'kb/package-lock.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'kb/package-owners.json'), '{}');

  // Public-prose fixture: one public repo, one private repo, so this test also proves private
  // prose stays excluded end-to-end through the full packaging pipeline.
  fs.writeFileSync(path.join(tmp, 'kb/PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['private-repo'] }));
  fs.writeFileSync(path.join(tmp, 'kb/public-repo-primer.md'), '# public-repo primer\n\npublic primer body.');
  fs.writeFileSync(path.join(tmp, 'kb/private-repo-primer.md'), '# private-repo primer\n\nSECRET primer body.');
  fs.writeFileSync(path.join(tmp, 'kb/l2/public-topic.md'), '# Public Topic\npublic L2 content.');
  fs.writeFileSync(path.join(tmp, 'kb/l2/private-topic.md'), '# Private Topic\nSECRET L2 content.');
  fs.writeFileSync(path.join(tmp, 'kb/l2-topics.public-repo.json'), JSON.stringify([{ slug: 'public-topic' }]));
  fs.writeFileSync(path.join(tmp, 'kb/l2-topics.private-repo.json'), JSON.stringify([{ slug: 'private-topic' }]));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function stampGenerationLedger(assets, stores) {
  const rows = {};
  for (const store of stores) {
    const file = `${store}.big.rvf`;
    const bytes = fs.readFileSync(path.join(assets, file));
    rows[store] = {
      file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      model: 'fixture-model', dimensions: 384, sourceCommit: 'a'.repeat(40),
      builtUtc: '2026-08-21T00:00:00.000Z',
    };
  }
  const existing = fs.existsSync(path.join(assets, 'RVF-GENERATIONS.json'))
    ? JSON.parse(fs.readFileSync(path.join(assets, 'RVF-GENERATIONS.json'), 'utf8')) : { stores: {} };
  fs.writeFileSync(path.join(assets, 'RVF-GENERATIONS.json'), JSON.stringify({
    schemaVersion: 1, brainVersion: '0.0.0-test', releaseTag: 'v0.0.0-test',
    stores: { ...existing.stores, ...rows },
  }));
}

function runBuildBundle(env = {}, args = []) {
  return spawnSync('node', ['scripts/build-bundle.mjs', ...args], {
    cwd: tmp, env: { ...process.env, ...env }, encoding: 'utf8',
  });
}

describe('build-bundle.mjs — property 4: concepts packaging is byte-identical, never re-derived', () => {
  it('packages concepts.sources.json + public-store-classes.json byte-for-byte, and never re-discovers private prose', () => {
    // Exactly what rebuildCorpusAggregates does in production: materialize the public tree, then
    // build the concepts aggregate from it -- directly into tmp/kb (self-materializing; already
    // proven safe by tests/unit/public-inputs.test.mjs's own self-materialization test).
    const kb = path.join(tmp, 'kb');
    const publicInputs = materializePublicInputs({ builderRoot: tmp, outDir: kb });
    const built = buildConceptAggregate({
      publicInputDir: kb,
      selectionReceipt: publicInputs.selectionReceipt,
      observationSha256: FAKE_OBSERVATION_SHA256,
      outDir: kb,
    });
    expect(built.passages).toBeGreaterThan(0);

    // Placeholder RVF families -- discoverBuilt() and the stubbed index audit match by filename
    // only, never open the file, matching tests/integration/build-bundle-fence.test.mjs's pattern.
    for (const store of ['concepts', 'public-repo']) {
      fs.writeFileSync(path.join(kb, `${store}.big.rvf`), '');
      fs.writeFileSync(path.join(kb, `${store}.big.rvf.idmap.json`), '{}');
      fs.writeFileSync(path.join(kb, `${store}.big.rvf.embed.json`), '{}');
    }
    fs.writeFileSync(path.join(kb, 'public-repo.passages.jsonl'), '{}\n');
    fs.writeFileSync(path.join(kb, 'public-repo.meta.json'), '{}');
    stampGenerationLedger(kb, ['concepts', 'public-repo']);

    const beforeConceptsReceipt = fs.readFileSync(path.join(kb, 'concepts.sources.json'));
    const beforeClasses = fs.readFileSync(path.join(kb, 'public-store-classes.json'));
    const receipt = JSON.parse(beforeConceptsReceipt.toString('utf8'));

    // Prove the receipt is not circular: it names REAL source inputs, never its own packaged output.
    const inputPaths = receipt.inputs.map((row) => row.path);
    expect(inputPaths).not.toContain('concepts.passages.jsonl');
    expect(inputPaths.some((p) => p.startsWith('l2/'))).toBe(true);
    expect(inputPaths).toContain('public-repo-primer.md');
    expect(inputPaths).not.toContain('private-repo-primer.md');

    const result = runBuildBundle();
    expect(result.status, result.stderr).toBe(0);

    const outDir = path.join(tmp, 'dist/ruvnet-brain');
    // BYTE-FOR-BYTE, never re-derived or re-filtered at packaging time.
    expect(fs.readFileSync(path.join(outDir, 'concepts.sources.json'))).toEqual(beforeConceptsReceipt);
    expect(fs.readFileSync(path.join(outDir, 'public-store-classes.json'))).toEqual(beforeClasses);
    expect(fs.readFileSync(path.join(outDir, 'concepts.passages.jsonl')))
      .toEqual(fs.readFileSync(path.join(kb, 'concepts.passages.jsonl')));

    // Private prose never reaches the shipped bundle -- through the FULL packaging pipeline, not
    // just materializePublicInputs in isolation.
    expect(fs.existsSync(path.join(outDir, 'private-repo-primer.md'))).toBe(false);
    expect(fs.readdirSync(path.join(outDir, 'l2'))).not.toContain('private-topic.md');
    expect(fs.readFileSync(path.join(outDir, 'concepts.passages.jsonl'), 'utf8')).not.toContain('SECRET');
  });
});
