// tests/unit/assemble-bundle.test.mjs — Step 5 of the corpus-seed/release pipeline consolidation
// (2026-09-13): scripts/build-bundle.mjs's assembleBundle is the ONE canonical assembly entry point,
// replacing the old ad hoc discover/copy/rebind script body. This proves the five properties Dual's
// review named as REQUIRED before this step could be considered shipped:
//
//   1. supplied corpus bytes win EXCLUSIVELY over poisoned checkout copies of the same-named files
//   2. corpus files land in the archive byte-identical, never re-derived or re-serialized
//   3. the assembled archive contains precisely the corpus's selected stores — no extra, no missing
//   4. the explicit identity appears everywhere it is supposed to, with no silent checkout fallback
//   5. the archive is built via exactly ONE zip-creation call, never build-then-rebuild
//
// assembleBundle is a real async function (no process.exit anywhere in it — only the CLI wrapper at
// the bottom of build-bundle.mjs exits), so it is imported and called directly here, in-process, with
// a REAL (but minimal) finalized-corpus directory: genuine .big.rvf stores written via the actual
// @ruvector/rvf runtime (RvfDatabase.create), each with 2 vectors — far below the 1,024-vector HNSW
// threshold auditRvfIndexes enforces, so no persisted index is required and the audit always PASSes.
// No network calls; no subprocess other than the real local `zip`/`unzip` this repo's own build
// already depends on.
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assembleBundle } from '../../scripts/build-bundle.mjs';

const requireFromKb = createRequire(new URL('../../kb/package.json', import.meta.url));
const { RvfDatabase } = requireFromKb('@ruvector/rvf');

const ENTRYPOINTS = [
  'forge-ask.mjs', 'forge-ask-all.mjs', 'forge-mcp.mjs', 'forge-mcp-all.mjs',
  'forge-rerank.mjs', 'forge-guard.mjs', 'forge-update.mjs', 'verify-citation.mjs',
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = (c, salt = '') => crypto.createHash('sha256').update(`${c}${salt}`).digest('hex').slice(0, 40);

async function writeMinimalRvf(rvfPath) {
  const db = await RvfDatabase.create(rvfPath, { dimensions: 3, metric: 'cosine' });
  await db.ingestBatch([{ id: 'v-0', vector: [1, 0, 0] }, { id: 'v-1', vector: [0, 1, 0] }]);
  await db.close();
}

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `assemble-bundle-${label}-`));
  dirs.push(dir);
  return dir;
}

/** A minimal but REAL code checkout: a kb/ with trivial (zero-import) entry points, so
 * resolveModuleGraph's walk terminates immediately, plus everything else assembleBundle reads
 * directly from `runtimeRoot` (never from the finalized corpus). `poison` optionally seeds files here
 * that the corpus ALSO carries, deliberately with DIFFERENT content, to prove they are never read. */
function buildRuntimeRoot({ poison = {} } = {}) {
  const root = tempDir('runtime');
  const kb = path.join(root, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'primer'), { recursive: true });
  fs.writeFileSync(path.join(kb, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  for (const name of ENTRYPOINTS) fs.writeFileSync(path.join(kb, name), `// fixture entry point: ${name}\nexport const ok = true;\n`);
  fs.writeFileSync(path.join(kb, 'package.json'), JSON.stringify({ name: 'fixture-kb', version: '0.0.0' }));
  fs.writeFileSync(path.join(kb, 'package-lock.json'), JSON.stringify({ name: 'fixture-kb', lockfileVersion: 3 }));
  fs.writeFileSync(path.join(kb, 'package-owners.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(root, 'data', 'registry.tiers.json'), JSON.stringify({ tiers: {} }));
  fs.writeFileSync(path.join(root, 'scripts', 'verify-bundle.mjs'), '// fixture verify-bundle.mjs\n');
  fs.writeFileSync(path.join(root, 'keys', 'ruvnet-brain-signing.pub.pem'), '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n');
  for (const [name, body] of Object.entries(poison)) {
    fs.writeFileSync(path.join(kb, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

/** A minimal but REAL finalized corpus directory: `stores` names get genuine .big.rvf stores (via
 * the real @ruvector/rvf runtime) plus every REQUIRED sidecar; `sourcedContent` optionally overrides
 * SOURCE.json/capability-cards.md/etc with specific (correct) content, to be compared against a
 * DIFFERENT (poisoned) copy in the runtime checkout. Every store gets a distinct, deterministic
 * sourceCommit so cross-store binding bugs (e.g. accidentally reusing one store's identity for
 * another) would be caught, not masked by every store sharing one SHA. */
async function buildCorpus({ stores, sourcedContent = {} }) {
  const root = tempDir('corpus');
  const ledgerStores = {};
  const sourceStores = {};
  for (const name of stores) {
    const rvfPath = path.join(root, `${name}.big.rvf`);
    await writeMinimalRvf(rvfPath);
    fs.writeFileSync(`${rvfPath}.embed.json`, JSON.stringify({ model: 'fixture-model', dimensions: 3 }));
    fs.writeFileSync(path.join(root, `${name}.passages.jsonl`), `${JSON.stringify({ id: '0', text: name, path: name })}\n`);
    fs.writeFileSync(path.join(root, `${name}.meta.json`), JSON.stringify({ model: 'fixture-model', dimensions: 3, entries: { 0: { path: name } } }));
    const sourceCommit = sha('commit', name);
    ledgerStores[name] = { file: `${name}.big.rvf`, sha256: sha256(rvfPath), bytes: fs.statSync(rvfPath).size,
      model: 'fixture-model', dimensions: 3, sourceCommit, builtUtc: '2026-09-13T00:00:00.000Z' };
    sourceStores[name] = { kbName: name, sourceRepo: `https://github.com/ruvnet/${name}`, sourceCommit,
      sourceDescribe: name, builtUtc: '2026-09-13T00:00:00.000Z', builder: 'rvf-kb-forge',
      canonicalManifestUrl: `https://example.invalid/${name}/manifest.json`,
      canonicalBundleUrl: `https://example.invalid/${name}/bundle.zip`, selfUpdate: `node forge-update.mjs ${name}` };
  }
  fs.writeFileSync(path.join(root, 'RVF-GENERATIONS.json'), JSON.stringify({ schemaVersion: 1, brainVersion: '0.0.0', releaseTag: 'v0.0.0', stores: ledgerStores }));
  fs.writeFileSync(path.join(root, 'SOURCE.json'), JSON.stringify(sourcedContent.sourceJson
    || { builder: 'rvf-kb-forge', stores: sourceStores }));
  fs.writeFileSync(path.join(root, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
  // A sealed selection receipt so assembleBundle trusts this corpus's own prose byte-for-byte and
  // never calls materializePublicInputs against the (deliberately different) runtime checkout.
  fs.writeFileSync(path.join(root, 'PUBLIC-INPUT-SELECTION.json'), JSON.stringify({
    schemaVersion: 1, kind: 'ruvnet-brain-public-input-selection-receipt', builderSha: null,
    generatedAt: '2026-09-13T00:00:00.000Z',
    included: { primers: [], topics: [], l2: [], cards: [], aliases: false },
    excluded: { primers: [], topics: [], l2: [], cards: [] }, ownership: {}, receiptSha256: 'unused-in-fixture',
  }));
  if (sourcedContent.capabilityCards !== undefined) {
    fs.writeFileSync(path.join(root, 'capability-cards.md'), sourcedContent.capabilityCards);
  }
  if (sourcedContent.ruvGistsSources !== undefined) {
    fs.writeFileSync(path.join(root, 'ruv-gists.sources.json'), JSON.stringify(sourcedContent.ruvGistsSources));
  }
  if (sourcedContent.conceptsSources !== undefined) {
    fs.writeFileSync(path.join(root, 'concepts.sources.json'), JSON.stringify(sourcedContent.conceptsSources));
    fs.writeFileSync(path.join(root, 'public-store-classes.json'),
      JSON.stringify({ schemaVersion: 1, derived: [{ store: 'concepts', receipt: 'concepts.sources.json' }] }));
  }
  return root;
}

const IDENTITY = { version: '7.7.7-fixture', sourceSnapshot: 'a'.repeat(40) };

describe('assembleBundle — required proof 1: supplied corpus bytes win EXCLUSIVELY', () => {
  it('never falls back to a poisoned checkout copy of SOURCE.json, capability-cards.md, ruv-gists.sources.json, or concepts.sources.json', async () => {
    const runtimeRoot = buildRuntimeRoot({
      poison: {
        'SOURCE.json': { builder: 'POISONED', stores: { alpha: { kbName: 'alpha', sourceCommit: sha('POISON', 'alpha'), sourceRepo: 'https://poisoned.invalid/alpha' } } },
        'capability-cards.md': '## alpha\nPOISONED capability text that must never ship.\n',
        'ruv-gists.sources.json': { poisoned: true },
        'concepts.sources.json': { poisoned: true },
      },
    });
    const corpusDir = await buildCorpus({
      stores: ['alpha', 'ruv-gists', 'concepts'],
      sourcedContent: {
        capabilityCards: '## alpha\nThe real, correct capability text.\n',
        ruvGistsSources: { real: true, marker: 'genuine-ruv-gists-receipt' },
        conceptsSources: { real: true, marker: 'genuine-concepts-receipt' },
      },
    });
    const outDir = path.join(tempDir('out'), 'ruvnet-brain');

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores.sort()).toEqual(['alpha', 'concepts', 'ruv-gists']);
    const source = JSON.parse(fs.readFileSync(path.join(outDir, 'SOURCE.json'), 'utf8'));
    expect(source.builder).toBe('rvf-kb-forge');
    expect(source.stores.alpha.sourceRepo).toBe('https://github.com/ruvnet/alpha');
    expect(source.stores.alpha.sourceCommit).toBe(sha('commit', 'alpha'));
    expect(JSON.stringify(source)).not.toMatch(/POISON/i);

    expect(fs.readFileSync(path.join(outDir, 'capability-cards.md'), 'utf8')).toBe('## alpha\nThe real, correct capability text.\n');
    expect(fs.readFileSync(path.join(outDir, 'capability-cards.md'), 'utf8')).not.toMatch(/POISON/i);

    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'ruv-gists.sources.json'), 'utf8'))).toEqual({ real: true, marker: 'genuine-ruv-gists-receipt' });
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'concepts.sources.json'), 'utf8'))).toEqual({ real: true, marker: 'genuine-concepts-receipt' });
  });
});

describe('assembleBundle — required proof 2: unchanged input hashes', () => {
  it('every file copied from corpusDir into the archive is byte-identical, never re-derived or re-serialized', async () => {
    const runtimeRoot = buildRuntimeRoot();
    const corpusDir = await buildCorpus({ stores: ['alpha'] });
    const outDir = path.join(tempDir('out'), 'ruvnet-brain');

    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
      const name = `alpha${suffix}`;
      expect(sha256(path.join(outDir, name)), `${name} must be byte-identical to the corpus copy`)
        .toBe(sha256(path.join(corpusDir, name)));
    }
  });
});

describe('assembleBundle — required proof 3: exact selected stores', () => {
  it('the assembled archive contains precisely the corpus-selected stores — no extra, no missing', async () => {
    const runtimeRoot = buildRuntimeRoot();
    const corpusDir = await buildCorpus({ stores: ['alpha', 'beta', 'gamma'] });
    const outDir = path.join(tempDir('out'), 'ruvnet-brain');

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores.sort()).toEqual(['alpha', 'beta', 'gamma']);
    const shipped = fs.readdirSync(outDir).filter((f) => /\.big\.rvf$/.test(f)).sort();
    expect(shipped).toEqual(['alpha.big.rvf', 'beta.big.rvf', 'gamma.big.rvf']);
    const ledger = JSON.parse(fs.readFileSync(path.join(outDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(Object.keys(ledger.stores).sort()).toEqual(['alpha', 'beta', 'gamma']);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.builtRepos.map((r) => r.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('excludes a store the corpus private-store fence marks private, in every shipped artifact', async () => {
    const runtimeRoot = buildRuntimeRoot();
    fs.writeFileSync(path.join(runtimeRoot, 'kb', 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
    const corpusDir = await buildCorpus({ stores: ['alpha', 'secret'] });
    const outDir = path.join(tempDir('out'), 'ruvnet-brain');

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores).toEqual(['alpha']);
    expect(fs.existsSync(path.join(outDir, 'secret.big.rvf'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.builtRepos.map((r) => r.name)).not.toContain('secret');
  });
});

describe('assembleBundle — required proof 4: consistent explicit version, no silent checkout fallback', () => {
  it('the explicit identity appears everywhere it is supposed to, never a different value read from the checkout', async () => {
    const runtimeRoot = buildRuntimeRoot();
    const corpusDir = await buildCorpus({ stores: ['alpha'] });
    const outDir = path.join(tempDir('out'), 'ruvnet-brain');
    // A fabricated, arbitrary identity -- deliberately never the checkout's own real version/SHA --
    // so this test can prove every artifact echoes THIS exact input, never a value read elsewhere.
    // Derived into `bareVersion`/`tag`/`sourceSnapshot` variables (not repeated as literals in each
    // assertion below) so this file itself never restates the one fact it is proving is derived.
    const explicitTag = `v9.${Date.now() % 1000}.1-explicit`;
    const { stripTag } = await import('../../scripts/version.mjs');
    const bareVersion = stripTag(explicitTag);
    const identity = { version: explicitTag, sourceSnapshot: 'b'.repeat(40) };

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity });

    expect(result.archiveManifest.version).toBe(bareVersion);
    expect(result.archiveManifest.releaseTag).toBe(explicitTag);
    const source = JSON.parse(fs.readFileSync(path.join(outDir, 'SOURCE.json'), 'utf8'));
    expect(source.brainVersion).toBe(bareVersion);
    expect(source.releaseTag).toBe(explicitTag);
    const ledger = JSON.parse(fs.readFileSync(path.join(outDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(ledger.brainVersion).toBe(bareVersion);
    expect(ledger.releaseTag).toBe(explicitTag);
    expect(ledger.sourceSnapshot).toBe(identity.sourceSnapshot);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.brainVersion).toBe(bareVersion);
    expect(fs.readFileSync(path.join(outDir, 'README.md'), 'utf8')).toContain(`# RuvNet Brain — ${explicitTag}`);
    // Never the repo's OWN real version/tag (getVersionTag()) leaking in as a silent fallback.
    const { getVersionTag } = await import('../../scripts/version.mjs');
    const realTag = getVersionTag();
    expect(realTag).not.toBe(explicitTag); // the whole test is void if these ever collide
    expect(JSON.stringify(result.archiveManifest)).not.toContain(realTag);
    expect(JSON.stringify(source)).not.toContain(realTag);
  });
});

describe('assembleBundle — required proof 5: one ZIP invocation', () => {
  // The historical bug this proof guards was never "assembleBundle zips twice internally" — a single
  // function body only ever had one zip call site. It was the OUTER orchestration (ci.yml, and
  // scripts/release-projection.mjs's own former CLI) invoking the whole build-bundle.mjs PROCESS
  // TWICE — once to seed a ledger release-projection.mjs could read, once for the real, coverage-
  // scoped rebuild — so a real release run created and discarded a full archive before building the
  // one that shipped. assembleBundle's single in-process pass removes the outer round-trip entirely
  // (see this file's header and .github/workflows/ci.yml's "Build the immutable knowledge bundle
  // exactly once" step). The proof here is therefore two-part: (a) a static guard that assembleBundle
  // itself contains exactly one zip-creation call site, so that invariant can never silently regress
  // internally, and (b) a dynamic proof that one call to assembleBundle produces one complete, valid
  // archive at the expected path.
  it('scripts/build-bundle.mjs contains exactly one zip-creation call site', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/build-bundle.mjs'), 'utf8');
    const zipCallSites = src.match(/spawnSync\(\s*'zip'/g) || [];
    expect(zipCallSites).toHaveLength(1);
  });

  it('one call to assembleBundle produces the release archive exactly once, at the expected path', async () => {
    const runtimeRoot = buildRuntimeRoot();
    const corpusDir = await buildCorpus({ stores: ['alpha'] });
    const outDir = path.join(tempDir('out'), 'ruvnet-brain');
    const zipFile = `${outDir}.zip`;
    expect(fs.existsSync(zipFile)).toBe(false);

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.zipFile).toBe(zipFile);
    expect(fs.existsSync(zipFile)).toBe(true);
    // A genuine, complete archive (not a placeholder): assembleBundle already extracted and
    // RVF-index-audited these exact bytes internally before returning, so reaching this line at all
    // is itself part of the proof; also assert its own manifest agrees with what is on disk.
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'ARCHIVE-MANIFEST.json'), 'utf8'));
    expect(manifest.fileCount).toBe(result.archiveManifest.fileCount);
  });
});
