// tests/integration/public-inputs-packaging.test.mjs — Step 3 (2026-09-13), property 4 AND the
// Dual-verification fix that followed it same day:
//
// "Every input declared in concepts.sources.json survives packaging with IDENTICAL bytes" --
// build-bundle.mjs's packaged output matches byte-for-byte what materializePublicInputs /
// buildConceptAggregate actually produced, not a re-derived or re-filtered copy.
//
// THE GAP an independent Dual verification pass found in the first Step 3 commit (52b94c7c):
// materializePublicInputs was centralized into ONE function, but it was still called from TWO
// production points -- reconciliation (corpus-aggregates.mjs's rebuildCorpusAggregates) AND
// packaging (build-bundle.mjs) -- and BOTH read from builderRoot/kb (checkout), not from whatever
// the FIRST call had already sealed into the assets directory. That violates "finalized corpus
// input is immutable; packaging reads it and writes only a disjoint output directory." It happened
// to produce identical bytes in CI only because nothing mutates checkout between the two calls
// within one job -- not because the guarantee was structurally real. If build-bundle.mjs is ever
// invoked against a reconciled assets directory that has since diverged from checkout (a later
// commit landed, a different checkout ref, a replay of an older candidate), packaging would
// silently ship different content than what concepts/gist construction actually sealed and hashed.
//
// THE FIX (build-bundle.mjs), as remediated in Step 5 (2026-09-13): the branch is chosen by an
// EXPLICIT condition, never by whether a file happens to exist. An EXTERNAL assets directory (any
// corpus that is not the checkout's own kb/) MUST carry materializePublicInputs' sealed
// PUBLIC-INPUT-SELECTION.json, and that receipt is VERIFIED on read (kind, schemaVersion, recomputed
// receiptSha256, every sealed file's bytes, no unsealed managed prose) before a single byte is
// trusted -- then packaging ships exactly the sealed set, never re-deriving. A STANDALONE run
// (corpus === kb/) always materializes fresh and never trusts a receipt already sitting in kb/.
//
// WHY SUBPROCESS for build-bundle.mjs: this suite is about the shipped CLI path end to end (same
// harness as tests/integration/build-bundle-fence.test.mjs). assembleBundle itself is importable and
// only throws; the in-process proofs live in tests/unit/assemble-bundle.test.mjs. No real network
// calls: observationSha256 is a synthetic hex64, and assembleBundle's org-count lookup is offline.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
process.env.RUVNET_BRAIN_IMPORT_ONLY = '1';
const { serverDependencies } = await import(path.join(REPO_ROOT, 'bin/install.mjs'));
const { materializePublicInputs, SELECTION_FILE } = await import(path.join(REPO_ROOT, 'scripts/public-inputs.mjs'));
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
  // Every test below writes its own checkout prose fixture (writeCheckoutProse) and, where a
  // separate reconciled assets directory is needed, its own concepts/RVF placeholders.
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** The checkout kb/ fixture every test starts from: one public repo, one private repo. */
function writeCheckoutProse(kbDir, { publicPrimer, privatePrimer, publicL2, privateL2 }) {
  fs.mkdirSync(path.join(kbDir, 'l2'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['private-repo'] }));
  fs.writeFileSync(path.join(kbDir, 'public-repo-primer.md'), publicPrimer);
  fs.writeFileSync(path.join(kbDir, 'private-repo-primer.md'), privatePrimer);
  fs.writeFileSync(path.join(kbDir, 'l2', 'public-topic.md'), publicL2);
  fs.writeFileSync(path.join(kbDir, 'l2', 'private-topic.md'), privateL2);
  fs.writeFileSync(path.join(kbDir, 'l2-topics.public-repo.json'), JSON.stringify([{ slug: 'public-topic' }]));
  fs.writeFileSync(path.join(kbDir, 'l2-topics.private-repo.json'), JSON.stringify([{ slug: 'private-topic' }]));
}

function writeRvfPlaceholders(assets, stores) {
  for (const store of stores) {
    fs.writeFileSync(path.join(assets, `${store}.big.rvf`), '');
    fs.writeFileSync(path.join(assets, `${store}.big.rvf.idmap.json`), '{}');
    fs.writeFileSync(path.join(assets, `${store}.big.rvf.embed.json`), '{}');
    if (store !== 'concepts') {
      fs.writeFileSync(path.join(assets, `${store}.passages.jsonl`), '{}\n');
      fs.writeFileSync(path.join(assets, `${store}.meta.json`), '{}');
    }
  }
}

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

describe('build-bundle.mjs — never re-derives an already-reconciled public-input selection', () => {
  it('trusts a sealed selection byte-for-byte and never re-derives from a checkout that has since drifted', () => {
    const kb = path.join(tmp, 'kb');
    const assets = path.join(tmp, 'release-assets'); // a SEPARATE reconciled directory, not kb/
    writeCheckoutProse(kb, {
      publicPrimer: '# public-repo primer\n\nSEALED public body -- this is what reconciliation saw.',
      privatePrimer: '# private-repo primer\n\nSEALED SECRET body.',
      publicL2: '# Public Topic\nSEALED public L2 content.',
      privateL2: '# Private Topic\nSEALED SECRET L2 content.',
    });

    // Simulate reconciliation exactly as rebuildCorpusAggregates does: seal the public-input tree
    // and the concepts aggregate into the SEPARATE assets directory.
    const publicInputs = materializePublicInputs({ builderRoot: tmp, outDir: assets });
    buildConceptAggregate({
      publicInputDir: assets, selectionReceipt: publicInputs.selectionReceipt,
      observationSha256: FAKE_OBSERVATION_SHA256, outDir: assets,
    });
    writeRvfPlaceholders(assets, ['concepts', 'public-repo']);
    stampGenerationLedger(assets, ['concepts', 'public-repo']);
    // Step 5 remediation: a sealed corpus also carries the installed updater's configuration, one
    // entry per repository store (corpus SOURCE.json is a required input, never silently defaulted).
    fs.writeFileSync(path.join(assets, 'SOURCE.json'), JSON.stringify({
      builder: 'rvf-kb-forge', canonicalManifestUrl: 'https://example.invalid/manifest.json',
      stores: { 'public-repo': { kbName: 'public-repo' } },
    }));
    expect(fs.existsSync(path.join(assets, SELECTION_FILE))).toBe(true);

    const sealedPrimer = fs.readFileSync(path.join(assets, 'public-repo-primer.md'));
    const sealedL2 = fs.readFileSync(path.join(assets, 'l2', 'public-topic.md'));
    const sealedConceptsReceipt = fs.readFileSync(path.join(assets, 'concepts.sources.json'));

    // Reconciliation is done. Checkout now moves on -- a later commit lands with DIFFERENT prose.
    // Packaging must NEVER see this: it must ship exactly what was sealed above.
    fs.writeFileSync(path.join(kb, 'public-repo-primer.md'),
      '# public-repo primer\n\nDRIFTED body -- reconciliation never saw this, MUST NOT SHIP.');
    fs.writeFileSync(path.join(kb, 'l2', 'public-topic.md'), '# Public Topic\nDRIFTED L2 content -- MUST NOT SHIP.');

    const result = runBuildBundle({}, ['--assets', assets]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/trusting already-reconciled public-input selection/);
    expect(result.stdout).not.toMatch(/materializePublicInputs excluded/); // logged only on a fresh materialize

    const outDir = path.join(tmp, 'dist/ruvnet-brain');
    expect(fs.readFileSync(path.join(outDir, 'public-repo-primer.md'))).toEqual(sealedPrimer);
    expect(fs.readFileSync(path.join(outDir, 'l2', 'public-topic.md'))).toEqual(sealedL2);
    expect(fs.readFileSync(path.join(outDir, 'concepts.sources.json'))).toEqual(sealedConceptsReceipt);
    const shippedPrimer = fs.readFileSync(path.join(outDir, 'public-repo-primer.md'), 'utf8');
    expect(shippedPrimer).not.toContain('DRIFTED');
    expect(shippedPrimer).toContain('SEALED');
  });

  it('materializes fresh when ASSETS has no sealed selection yet (the genuine standalone/local-dev case)', () => {
    const kb = path.join(tmp, 'kb'); // default ASSETS === builderRoot's own kb -- nothing reconciled yet
    writeCheckoutProse(kb, {
      publicPrimer: '# public-repo primer\n\nFRESH public body.',
      privatePrimer: '# private-repo primer\n\nFRESH SECRET body.',
      publicL2: '# Public Topic\nFRESH public L2 content.',
      privateL2: '# Private Topic\nFRESH SECRET L2 content.',
    });
    writeRvfPlaceholders(kb, ['public-repo']);
    stampGenerationLedger(kb, ['public-repo']);
    expect(fs.existsSync(path.join(kb, SELECTION_FILE))).toBe(false);

    const result = runBuildBundle();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/trusting already-reconciled/);

    const outDir = path.join(tmp, 'dist/ruvnet-brain');
    expect(fs.readFileSync(path.join(outDir, 'public-repo-primer.md'), 'utf8')).toContain('FRESH public body');
    expect(fs.existsSync(path.join(outDir, 'private-repo-primer.md'))).toBe(false);
    expect(fs.readdirSync(path.join(outDir, 'l2'))).not.toContain('private-topic.md');
    // P1-a (Dual, 2026-09-14): this used to assert the opposite — that materializing "DID seal a
    // selection into kb/ as a side effect". That side effect is the defect: materializePublicInputs
    // prunes every managed entry the round did not reproduce and replaces l2/ wholesale, so writing
    // it into the source checkout DELETED tracked files. Standalone selection is now materialized
    // into a private staging directory; kb/ is an input only, and the seal ships in the archive.
    expect(fs.existsSync(path.join(kb, SELECTION_FILE))).toBe(false);
    expect(fs.existsSync(path.join(outDir, SELECTION_FILE))).toBe(true);
    // And the checkout's own private prose is still THERE, unfenced-but-unpruned, exactly as written.
    expect(fs.readFileSync(path.join(kb, 'private-repo-primer.md'), 'utf8')).toContain('FRESH SECRET body');
    expect(fs.existsSync(path.join(kb, 'l2', 'private-topic.md'))).toBe(true);
  });
});

describe('build-bundle.mjs — property 4: concepts packaging is byte-identical, never re-derived', () => {
  it('packages concepts.sources.json + public-store-classes.json byte-for-byte, and never re-discovers private prose', () => {
    // Self-materializing case: builderRoot === outDir === tmp/kb, exactly what rebuildCorpusAggregates
    // does when assetsDir happens to equal the checkout. This seals PUBLIC-INPUT-SELECTION.json into
    // kb/ as a side effect. The build-bundle.mjs run below is a STANDALONE run (corpus === kb/), which
    // since the Step 5 remediation ALWAYS re-materializes from the checkout and never trusts a receipt
    // already in kb/ -- so the byte-identity assertions below hold because the same prose produces the
    // same selection, and concepts.sources.json / public-store-classes.json are copied, not re-derived.
    const kb = path.join(tmp, 'kb');
    writeCheckoutProse(kb, {
      publicPrimer: '# public-repo primer\n\npublic primer body.',
      privatePrimer: '# private-repo primer\n\nSECRET primer body.',
      publicL2: '# Public Topic\npublic L2 content.',
      privateL2: '# Private Topic\nSECRET L2 content.',
    });
    const publicInputs = materializePublicInputs({ builderRoot: tmp, outDir: kb });
    const built = buildConceptAggregate({
      publicInputDir: kb,
      selectionReceipt: publicInputs.selectionReceipt,
      observationSha256: FAKE_OBSERVATION_SHA256,
      outDir: kb,
    });
    expect(built.passages).toBeGreaterThan(0);

    writeRvfPlaceholders(kb, ['concepts', 'public-repo']);
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
