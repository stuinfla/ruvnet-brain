// tests/unit/assemble-bundle.test.mjs — Step 5 of the corpus-seed/release pipeline consolidation
// (2026-09-13), remediated after Dual's independent review of 86cbe798 found the sealed-input
// boundary was a file-existence toggle: `if (fs.existsSync(receipt))` was the whole check, and the
// original fixture's `receiptSha256: 'unused-in-fixture'` proved nothing validated it. Every fixture
// here is now sealed by the REAL producer (tests/helpers/assemble-bundle-fixture.mjs), and the risky
// axis is tested directly: an external corpus with no seal, a tampered seal, coverage drift, the full
// seed path end to end, and a candidate-archive round-trip.
//
// The five properties Dual's review named as REQUIRED are still here (proofs 1-5), now against
// genuine seals rather than fake ones.
//
// assembleBundle is a real async function (no process.exit anywhere in it — only the CLI wrapper at
// the bottom of build-bundle.mjs exits), so it is imported and called directly here, in-process.
// Stores are genuine .big.rvf files written by the real @ruvector/rvf runtime (2 vectors each, far
// below the 1,024-vector HNSW threshold, so the index audit PASSes). NO NETWORK: assembleBundle is
// offline by construction (orgRepoCount is called with a disabled live probe — proven below), and
// the only subprocess is the real local `zip`/`unzip` this repo's own build already depends on.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assembleBundle } from '../../scripts/build-bundle.mjs';
import { SELECTION_FILE, validateSelectionReceipt } from '../../scripts/public-inputs.mjs';
import { validateCoverageDirectory } from '../../plugin/scripts/coverage-integrity.mjs';
import { extractZip } from '../../kb/zip-extract.mjs';
import {
  SEED_IDENTITY, buildCorpus, buildRuntimeRoot, commitFor, readJson, sha256File, tempDir, treeIdentity,
  writeCoverage, writeProse, writeStore,
} from '../helpers/assemble-bundle-fixture.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });

const IDENTITY = { version: '7.7.7-fixture', sourceSnapshot: 'a'.repeat(40) };
const outDirFor = () => path.join(tempDir(dirs, 'out'), 'ruvnet-brain');
const PROSE = {
  primers: { alpha: '# alpha primer\n\nThe real, sealed alpha primer body.\n' },
  l2: { 'alpha-topic': '# Alpha Topic\nSealed public L2 content.\n' },
  topics: { alpha: [{ slug: 'alpha-topic' }] },
  cards: '## alpha\nThe real, correct capability text.\n',
  aliases: { alpha: ['alpha-brain'] },
};

/** A STANDALONE kb: the checkout's own kb/ IS the corpus (assembleBundle's `--assets kb` default). */
async function writeStandaloneKb(runtimeRoot, stores) {
  const kb = path.join(runtimeRoot, 'kb');
  const ledgerStores = {};
  const updaterStores = {};
  for (const name of stores) {
    ledgerStores[name] = await writeStore(kb, name);
    updaterStores[name] = { kbName: name, canonicalBundleUrl: `https://example.invalid/${name}/bundle.zip` };
  }
  fs.writeFileSync(path.join(kb, 'RVF-GENERATIONS.json'), JSON.stringify({ schemaVersion: 1, brainVersion: '0.0.0', releaseTag: 'v0.0.0', stores: ledgerStores }));
  fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', canonicalManifestUrl: 'https://example.invalid/manifest.json', stores: updaterStores }));
  return kb;
}

describe('assembleBundle — required proof 1: supplied corpus bytes win EXCLUSIVELY', () => {
  it('never falls back to a poisoned checkout copy of SOURCE.json, capability-cards.md, a primer, ruv-gists.sources.json, or concepts.sources.json', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, {
      runtimeRoot, stores: ['alpha', 'ruv-gists', 'concepts'], derived: ['concepts'],
      overrides: {
        'ruv-gists.sources.json': JSON.stringify({ real: true, marker: 'genuine-ruv-gists-receipt' }),
        'concepts.sources.json': JSON.stringify({ real: true, marker: 'genuine-concepts-receipt' }),
      },
    });
    // The corpus is sealed. NOW poison every same-named file in the checkout.
    const kb = path.join(runtimeRoot, 'kb');
    fs.writeFileSync(path.join(kb, 'SOURCE.json'), JSON.stringify({ builder: 'POISONED', canonicalManifestUrl: 'https://poisoned.invalid/manifest.json',
      stores: { alpha: { kbName: 'alpha', sourceCommit: 'f'.repeat(40), sourceRepo: 'https://poisoned.invalid/alpha' } } }));
    fs.writeFileSync(path.join(kb, 'capability-cards.md'), '## alpha\nPOISONED capability text that must never ship.\n');
    fs.writeFileSync(path.join(kb, 'alpha-primer.md'), '# alpha primer\n\nPOISONED primer body.\n');
    fs.writeFileSync(path.join(kb, 'ruv-gists.sources.json'), JSON.stringify({ poisoned: true }));
    fs.writeFileSync(path.join(kb, 'concepts.sources.json'), JSON.stringify({ poisoned: true }));
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores.sort()).toEqual(['alpha', 'concepts', 'ruv-gists']);
    const source = readJson(path.join(outDir, 'SOURCE.json'));
    expect(source.builder).toBe('rvf-kb-forge');
    expect(source.canonicalManifestUrl).toBe('https://example.invalid/manifest.json');
    expect(source.stores.alpha.sourceRepo).toBe('https://github.com/ruvnet/alpha');
    expect(source.stores.alpha.sourceCommit).toBe(commitFor('alpha'));
    expect(JSON.stringify(source)).not.toMatch(/POISON/i);
    for (const [file, sealed] of [['capability-cards.md', PROSE.cards], ['alpha-primer.md', PROSE.primers.alpha]]) {
      expect(fs.readFileSync(path.join(outDir, file), 'utf8')).toBe(sealed);
    }
    expect(readJson(path.join(outDir, 'ruv-gists.sources.json'))).toEqual({ real: true, marker: 'genuine-ruv-gists-receipt' });
    expect(readJson(path.join(outDir, 'concepts.sources.json'))).toEqual({ real: true, marker: 'genuine-concepts-receipt' });
  });
});

describe('assembleBundle — required proof 2: unchanged input hashes', () => {
  it('every corpus file in the archive — stores, sealed prose, and the receipt itself — is byte-identical to the corpus copy', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = outDirFor();

    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    const receipt = readJson(path.join(corpusDir, SELECTION_FILE));
    const sealedPaths = receipt.files.map((row) => row.path);
    expect(sealedPaths).toEqual(expect.arrayContaining(['alpha-primer.md', 'l2/alpha-topic.md', 'l2-topics.alpha.json', 'capability-cards.md', 'repo-aliases.json']));
    for (const name of ['alpha.big.rvf', 'alpha.big.rvf.idmap.json', 'alpha.big.rvf.embed.json', 'alpha.passages.jsonl',
      'alpha.meta.json', SELECTION_FILE, ...sealedPaths]) {
      expect(sha256File(path.join(outDir, name)), `${name} must be byte-identical to the corpus copy`)
        .toBe(sha256File(path.join(corpusDir, name)));
    }
  });
});

describe('assembleBundle — required proof 3: exact selected stores', () => {
  it('the assembled archive contains precisely the corpus-selected stores — no extra, no missing', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta', 'gamma'] });
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores.sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(fs.readdirSync(outDir).filter((f) => /\.big\.rvf$/.test(f)).sort()).toEqual(['alpha.big.rvf', 'beta.big.rvf', 'gamma.big.rvf']);
    expect(Object.keys(readJson(path.join(outDir, 'RVF-GENERATIONS.json')).stores).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(readJson(path.join(outDir, 'manifest.json')).builtRepos.map((r) => r.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('excludes a store the checkout private-store fence marks private, in every shipped artifact', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { privateStores: ['secret'] });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'secret'] });
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores).toEqual(['alpha']);
    expect(fs.existsSync(path.join(outDir, 'secret.big.rvf'))).toBe(false);
    expect(readJson(path.join(outDir, 'manifest.json')).builtRepos.map((r) => r.name)).not.toContain('secret');
    expect(Object.keys(readJson(path.join(outDir, 'SOURCE.json')).stores)).toEqual(['alpha']);
  });
});

describe('assembleBundle — required proof 4: consistent explicit version, no silent checkout fallback', () => {
  it('the explicit identity appears everywhere it is supposed to, never a different value read from the checkout', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = outDirFor();
    // A fabricated identity, derived into variables (never repeated as literals in the assertions)
    // so this file itself never restates the one fact it proves is derived.
    const explicitTag = `v9.${Date.now() % 1000}.1-explicit`;
    const { stripTag, getVersionTag } = await import('../../scripts/version.mjs');
    const bareVersion = stripTag(explicitTag);
    const identity = { version: explicitTag, sourceSnapshot: 'b'.repeat(40) };

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity });

    expect(result.archiveManifest.version).toBe(bareVersion);
    expect(result.archiveManifest.releaseTag).toBe(explicitTag);
    const source = readJson(path.join(outDir, 'SOURCE.json'));
    expect(source.brainVersion).toBe(bareVersion);
    expect(source.releaseTag).toBe(explicitTag);
    const ledger = readJson(path.join(outDir, 'RVF-GENERATIONS.json'));
    expect(ledger.brainVersion).toBe(bareVersion);
    expect(ledger.releaseTag).toBe(explicitTag);
    expect(ledger.sourceSnapshot).toBe(identity.sourceSnapshot);
    expect(readJson(path.join(outDir, 'manifest.json')).brainVersion).toBe(bareVersion);
    expect(fs.readFileSync(path.join(outDir, 'README.md'), 'utf8')).toContain(`# RuvNet Brain — ${explicitTag}`);
    const realTag = getVersionTag();
    expect(realTag).not.toBe(explicitTag);
    expect(JSON.stringify(result.archiveManifest)).not.toContain(realTag);
    expect(JSON.stringify(source)).not.toContain(realTag);
  });
});

describe('assembleBundle — required proof 5: one ZIP invocation', () => {
  it('EXECUTES `zip` exactly once, and attempts no network call, across a whole assembly', async () => {
    // Dual, 2026-09-14, on the assertions this replaces: the old regex at :174-176 "proves one ZIP
    // call site, not one execution", and the old offline assertion at :192 "permits a failed network
    // attempt; it does not detect one". Both are now DETECTORS. A shim directory is prepended to
    // PATH: its `zip` appends a line per invocation and then delegates to the real binary, and its
    // `gh`/`curl` write a marker and fail. A global fetch spy covers the in-process path. So a second
    // zip execution, or ANY outbound attempt through these four doors, fails this test.
    const shim = tempDir(dirs, 'shim');
    const counter = path.join(shim, 'zip-invocations');
    const netMarker = path.join(shim, 'network-attempt');
    const realZip = spawnSync('sh', ['-c', 'command -v zip'], { encoding: 'utf8' }).stdout.trim();
    expect(realZip, 'the real zip binary must be on PATH for this proof to mean anything').toBeTruthy();
    fs.writeFileSync(path.join(shim, 'zip'), `#!/bin/sh\necho invoked >> '${counter}'\nexec '${realZip}' "$@"\n`, { mode: 0o755 });
    for (const tool of ['gh', 'curl', 'wget']) {
      fs.writeFileSync(path.join(shim, tool), `#!/bin/sh\necho "${tool} $*" >> '${netMarker}'\nexit 1\n`, { mode: 0o755 });
    }
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outDir = outDirFor();
    const zipFile = `${outDir}.zip`;
    expect(fs.existsSync(zipFile)).toBe(false);
    const originalPath = process.env.PATH;
    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = (...args) => { fetchCalls.push(String(args[0])); throw new Error('network is not available during assembly'); };
    process.env.PATH = `${shim}${path.delimiter}${originalPath}`;
    let result;
    try {
      result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });
    } finally {
      process.env.PATH = originalPath;
      globalThis.fetch = originalFetch;
    }

    expect(fs.existsSync(counter), 'the shimmed zip must actually have been used').toBe(true);
    expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(netMarker) ? fs.readFileSync(netMarker, 'utf8') : '').toBe('');
    expect(fetchCalls).toEqual([]);
    expect(result.zipFile).toBe(zipFile);
    expect(fs.existsSync(zipFile)).toBe(true);
    expect(readJson(path.join(outDir, 'ARCHIVE-MANIFEST.json')).fileCount).toBe(result.archiveManifest.fileCount);
    // The org total is the committed record or honestly unknown — never a value a live probe produced.
    expect(['recorded', 'unknown']).toContain(readJson(path.join(outDir, 'manifest.json')).coverage.orgTotalSource);
  });
});

describe('assembleBundle — P1-a: a standalone assembly never writes to, or prunes, its source checkout', () => {
  /** A real git checkout whose kb/ mirrors the exact shape Dual named in the repo: a primer for a
   * FENCED repo, and an l2/ subdirectory the selection does not own. Both are tracked. */
  async function trackedCheckout() {
    const runtimeRoot = buildRuntimeRoot(dirs, {
      privateStores: ['cognitum-api'],
      prose: { ...PROSE, primers: { ...PROSE.primers, 'cognitum-api': '# cognitum-api primer\n\nFENCED, and TRACKED.\n' } },
    });
    const kb = await writeStandaloneKb(runtimeRoot, ['alpha']);
    fs.mkdirSync(path.join(kb, 'l2', 'rejected'), { recursive: true });
    fs.writeFileSync(path.join(kb, 'l2', 'rejected', 'adr-029-decide-about.md'), '# rejected: adr-029\nTracked, not shipped.\n');
    fs.writeFileSync(path.join(kb, 'l2', 'rejected', 'adr-coverage.md'), '# rejected: adr-coverage\nTracked, not shipped.\n');
    const git = (...args) => {
      const run = spawnSync('git', args, { cwd: runtimeRoot, encoding: 'utf8' });
      expect(run.status, `git ${args.join(' ')}: ${run.stderr}`).toBe(0);
      return run.stdout;
    };
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    // EVERYTHING under kb/ is tracked, so an empty `git status --porcelain -- kb/` afterwards means
    // exactly one thing: nothing was added, modified, or deleted anywhere in the source tree.
    git('add', 'kb');
    git('commit', '-q', '-m', 'fixture: tracked kb');
    return { runtimeRoot, kb, git };
  }

  it('leaves `git status --porcelain -- kb/` EMPTY, and the fenced primer and both l2/rejected files byte-unchanged', async () => {
    const { runtimeRoot, kb, git } = await trackedCheckout();
    const tracked = ['cognitum-api-primer.md', 'l2/rejected/adr-029-decide-about.md', 'l2/rejected/adr-coverage.md'];
    const before = Object.fromEntries(tracked.map((file) => [file, sha256File(path.join(kb, file))]));
    expect(git('status', '--porcelain', '--', 'kb/')).toBe('');

    const result = await assembleBundle({ corpusDir: kb, runtimeRoot, outDir: outDirFor(), identity: IDENTITY });

    expect(result.selectedStores).toEqual(['alpha']);
    // THE INVARIANT. `<repo>/kb` is a gitignored BUILD WORKSPACE by design (kb/store-root.mjs's own
    // header: the canonical root is ~/.cache/ruvnet-brain/kb), so writing build artifacts there is
    // legitimate and this test does NOT forbid it. What a standalone assembly must never do is
    // DELETE or OVERWRITE a git-TRACKED file — which is precisely what the fence-driven prune and
    // the wholesale l2/ promotion did. `-uno` scopes the check to tracked paths, so it states that
    // invariant exactly.
    expect(git('status', '--porcelain', '-uno', '--', 'kb/')).toBe('');
    // This implementation happens to be stricter — it materializes into a private staging directory
    // and writes nothing into kb/ at all — so the untracked set is unchanged too. Asserted second
    // and separately, so a future change that legitimately adds a build artifact fails HERE, with an
    // obvious diagnosis, instead of looking like a tracked-file regression.
    expect(git('status', '--porcelain', '--', 'kb/')).toBe('');
    for (const file of tracked) {
      expect(fs.existsSync(path.join(kb, file)), `${file} must still exist`).toBe(true);
      expect(sha256File(path.join(kb, file)), `${file} must be byte-unchanged`).toBe(before[file]);
    }
  });

  it('still ships the correctly-fenced selection: the fenced primer and the unowned l2 subtree never reach the archive', async () => {
    const { runtimeRoot, kb } = await trackedCheckout();
    const outDir = outDirFor();

    await assembleBundle({ corpusDir: kb, runtimeRoot, outDir, identity: IDENTITY });

    expect(fs.existsSync(path.join(outDir, 'cognitum-api-primer.md'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'l2', 'rejected'))).toBe(false);
    expect(fs.readFileSync(path.join(outDir, 'alpha-primer.md'), 'utf8')).toBe(PROSE.primers.alpha);
    const receipt = readJson(path.join(outDir, SELECTION_FILE));
    expect(receipt.excluded.primers.map((row) => row.repo)).toContain('cognitum-api');
  });
});

describe('assembleBundle — P1-b: a selection sealed under an OLDER fence is rejected, not shipped', () => {
  /** Seal prose while `repo` is public, then fence it in runtimeRoot/kb/PRIVATE-STORES.json — the
   * exact drift Dual described. `prose` decides WHICH of the four surfaces carries the stale item. */
  async function driftedCorpus(prose, repo) {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    // The fence moves AFTER the seal. The corpus keeps its (now stale) sealed selection.
    fs.writeFileSync(path.join(runtimeRoot, 'kb', 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [repo] }));
    return { runtimeRoot, corpusDir };
  }
  const attempt = ({ runtimeRoot, corpusDir }) =>
    assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY });

  it('rejects a stale PRIMER', async () => {
    await expect(attempt(await driftedCorpus({ primers: { alpha: '# alpha\nbody\n', beta: '# beta\nsecret later\n' } }, 'beta')))
      .rejects.toThrow(/incompatible with the CURRENT private fence[\s\S]*primer beta-primer\.md/);
  });

  it('rejects a stale TOPICS file', async () => {
    await expect(attempt(await driftedCorpus({
      primers: { alpha: '# alpha\nbody\n', beta: '# beta\nbody\n' }, topics: { beta: [{ slug: 'beta-topic' }] },
    }, 'beta'))).rejects.toThrow(/incompatible with the CURRENT private fence[\s\S]*topics l2-topics\.beta\.json/);
  });

  it('rejects a stale L2 ARTICLE, by the slug its owner claims', async () => {
    await expect(attempt(await driftedCorpus({
      primers: { alpha: '# alpha\nbody\n', beta: '# beta\nbody\n' },
      topics: { beta: [{ slug: 'beta-topic' }] }, l2: { 'beta-topic': '# Beta Topic\nnow-private prose\n' },
    }, 'beta'))).rejects.toThrow(/incompatible with the CURRENT private fence[\s\S]*l2\/beta-topic\.md \(owned by "beta"/);
  });

  it('rejects a stale CAPABILITY-CARD SECTION — the surface a store-inventory check can never reach', async () => {
    // `beta` has NO selected RVF store at all here, so nothing in the store/ledger/coverage rails
    // looks at it. Its card text ships anyway unless the prose policy itself is re-checked.
    const drift = await driftedCorpus({
      primers: { alpha: '# alpha\nbody\n' }, cards: '## alpha\npublic\n## beta\nbeta capability text\n',
    }, 'beta');
    await expect(attempt(drift))
      .rejects.toThrow(/incompatible with the CURRENT private fence[\s\S]*capability-cards\.md section "## beta"/);
  });

  it('rejects, never filters: no output directory is produced, so the derived aggregates must be rebuilt', async () => {
    const drift = await driftedCorpus({ primers: { alpha: '# alpha\nbody\n', beta: '# beta\nbody\n' } }, 'beta');
    const outDir = outDirFor();
    await expect(assembleBundle({ corpusDir: drift.corpusDir, runtimeRoot: drift.runtimeRoot, outDir, identity: IDENTITY }))
      .rejects.toThrow(/Rejected, not filtered/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('a selection sealed under the SAME fence still assembles (the check is drift-sensitive, not fence-hostile)', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { privateStores: ['beta'], prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY })).resolves.toBeTruthy();
  });
});

describe('assembleBundle — the sealed-input boundary is a verified seal, not a file-existence toggle', () => {
  it('(8a) an EXTERNAL corpus with no selection receipt is rejected and never self-materialized into', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'], seal: false });
    const before = fs.readdirSync(corpusDir).sort();
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/carries no sealed public-input selection/);
    // Untouched: no receipt was written into it, no prose was copied in from the checkout.
    expect(fs.readdirSync(corpusDir).sort()).toEqual(before);
    expect(fs.existsSync(path.join(corpusDir, 'alpha-primer.md'))).toBe(false);
  });

  it('(8a) a STANDALONE kb (corpus IS runtimeRoot/kb) with no receipt succeeds via fresh materialization — into STAGING, not kb', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const kb = await writeStandaloneKb(runtimeRoot, ['alpha']);
    expect(fs.existsSync(path.join(kb, SELECTION_FILE))).toBe(false);
    const before = treeIdentity(kb);
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir: kb, runtimeRoot, outDir, identity: IDENTITY });

    expect(result.selectedStores).toEqual(['alpha']);
    // P1-a (Dual 2026-09-14). This used to assert `fs.existsSync(kb/SELECTION_FILE) === true` —
    // i.e. it REQUIRED the very write that pruned the tracked checkout. The real property is the
    // opposite one: the source tree is an INPUT and comes out byte-identical, receipt included
    // (it is never created there at all). The archive still carries a genuine, verifiable seal.
    expect(treeIdentity(kb)).toEqual(before);
    expect(fs.existsSync(path.join(kb, SELECTION_FILE))).toBe(false);
    expect(() => validateSelectionReceipt({ receipt: readJson(path.join(outDir, SELECTION_FILE)), dir: outDir })).not.toThrow();
    expect(fs.readFileSync(path.join(outDir, 'alpha-primer.md'), 'utf8')).toBe(PROSE.primers.alpha);
  });

  it('(fix 4) a STANDALONE kb never trusts a receipt already sitting in it: the stale receipt cannot flip the toggle', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const kb = await writeStandaloneKb(runtimeRoot, ['alpha']);
    // A stale-but-well-formed receipt from an earlier round that sealed DIFFERENT prose.
    const earlier = await buildCorpus(dirs, { runtimeRoot: buildRuntimeRoot(dirs, { prose: { primers: { alpha: 'STALE earlier primer\n' } } }), stores: ['alpha'] });
    fs.copyFileSync(path.join(earlier, SELECTION_FILE), path.join(kb, SELECTION_FILE));
    const staleReceipt = readJson(path.join(kb, SELECTION_FILE));
    const outDir = outDirFor();

    await assembleBundle({ corpusDir: kb, runtimeRoot, outDir, identity: IDENTITY });

    // Re-materialized from the CURRENT checkout prose: what SHIPS is current, and the stale file in
    // the source tree is left exactly as it was (P1-a: kb is an input, never an output).
    expect(fs.readFileSync(path.join(outDir, 'alpha-primer.md'), 'utf8')).toBe(PROSE.primers.alpha);
    expect(readJson(path.join(outDir, SELECTION_FILE)).receiptSha256).not.toBe(staleReceipt.receiptSha256);
    expect(readJson(path.join(kb, SELECTION_FILE)).receiptSha256).toBe(staleReceipt.receiptSha256);
  });

  it('(8b) a tampered receipt is rejected on read: wrong digest, empty object, missing sealed file, changed bytes, unsealed managed file', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const build = async (tamper) => {
      const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
      tamper(corpusDir);
      return assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY });
    };
    const receiptFile = (corpusDir) => path.join(corpusDir, SELECTION_FILE);
    await expect(build((c) => {
      const receipt = readJson(receiptFile(c));
      receipt.receiptSha256 = 'a'.repeat(64);
      fs.writeFileSync(receiptFile(c), JSON.stringify(receipt));
    })).rejects.toThrow(/receiptSha256 does not match/);
    // Dual's exact case: `{}` used to take the trusted branch through the `excluded || {...}` default.
    await expect(build((c) => fs.writeFileSync(receiptFile(c), '{}'))).rejects.toThrow(/kind is undefined/);
    await expect(build((c) => fs.rmSync(path.join(c, 'alpha-primer.md')))).rejects.toThrow(/sealed file alpha-primer\.md is missing/);
    await expect(build((c) => fs.appendFileSync(path.join(c, 'alpha-primer.md'), 'tampered'))).rejects.toThrow(/alpha-primer\.md bytes differ/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'rogue-primer.md'), '# unsealed prose riding along\n')))
      .rejects.toThrow(/not sealed by the receipt.*rogue-primer\.md/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'l2', 'rogue.md'), '# unsealed l2 article\n')))
      .rejects.toThrow(/not sealed by the receipt.*l2\/rogue\.md/);
  });
});

describe('assembleBundle — coverage is a sealed input bound to THIS corpus', () => {
  it('(8c) the full seed path: createReleaseProjection and bindAssembledReleaseProjection run end to end from assembleBundle', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    const coverage = writeCoverage(runtimeRoot, corpusDir);
    const outDir = outDirFor();

    const result = await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: SEED_IDENTITY });

    expect(result.projection).not.toBeNull();
    // Dual, 2026-09-14: this test "can pass after removing the in-process bind call at
    // build-bundle.mjs:752". It cannot now — the bind's OWN RETURN VALUE is carried in the result,
    // so deleting the call leaves `binding` undefined and these three assertions fail. (The
    // independent re-validation at the bottom of this test would still pass; it is a second reader,
    // not evidence that assembly ran one.)
    expect(result.projection.binding, 'bindAssembledReleaseProjection must have run inside assembleBundle').toBeDefined();
    expect(result.projection.binding.valid).toBe(true);
    expect(result.projection.binding.failures).toEqual([]);
    for (const file of ['COVERAGE.json', 'CORPUS-COVERAGE.json', 'PUBLIC-RVF-GENERATIONS.json', 'RVF-GENERATIONS.json']) {
      expect(fs.existsSync(path.join(outDir, file)), file).toBe(true);
    }
    const release = readJson(path.join(outDir, 'COVERAGE.json'));
    expect(release.kind).toBe('ruvnet-brain-release-coverage');
    expect(release.corpusSeed.tag).toBe(SEED_IDENTITY.tag);
    expect(release.releaseIdentity).toEqual({ version: IDENTITY.version, tag: `v${IDENTITY.version}`, sourceSnapshot: IDENTITY.sourceSnapshot });
    // Algorithm step 9, through the real path: rows/totals arrive UNCHANGED from the sealed coverage.
    expect(release.rows).toEqual(coverage.rows);
    expect(release.totals).toEqual(coverage.totals);
    expect(readJson(path.join(outDir, 'CORPUS-COVERAGE.json'))).toEqual(coverage);
    expect(readJson(path.join(outDir, 'PUBLIC-RVF-GENERATIONS.json')).kind).toBe('ruvnet-brain-public-generation-ledger');
    expect(readJson(path.join(outDir, 'RVF-GENERATIONS.json')).kind).toBe('ruvnet-brain-runtime-generation-ledger');
    // The independent activation-boundary reader agrees with everything assembleBundle wrote.
    const directory = validateCoverageDirectory(outDir, { expectedVersion: IDENTITY.version, expectedSourceSnapshot: IDENTITY.sourceSnapshot });
    expect(directory.failures).toEqual([]);
    expect(directory.valid).toBe(true);
  });

  it('(fix 6) a PARTIAL seed identity is rejected before any output is written, never downgraded to a non-release build', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusDir);
    const outDir = outDirFor();
    const { baselineReceiptSha256: _dropped, ...partial } = SEED_IDENTITY;
    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY, seedIdentity: partial }))
      .rejects.toThrow(/seed identity is incomplete or malformed/);
    expect(fs.existsSync(outDir)).toBe(false);
  });

  it('(8d) coverage drift is rejected: corpus RVF rebuilt after the coverage was sealed', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusDir);
    // The corpus moves on: alpha is rebuilt with different bytes and its ledger row updated, so the
    // corpus is internally consistent — but the sealed coverage measured the OLD bytes.
    const rvfPath = path.join(corpusDir, 'alpha.big.rvf');
    fs.rmSync(rvfPath); fs.rmSync(`${rvfPath}.idmap.json`);
    const { createRequire } = await import('node:module');
    const { RvfDatabase } = createRequire(new URL('../../kb/package.json', import.meta.url))('@ruvector/rvf');
    const db = await RvfDatabase.create(rvfPath, { dimensions: 3, metric: 'cosine' });
    await db.ingestBatch([{ id: 'v-0', vector: [1, 0, 0] }, { id: 'v-1', vector: [0, 1, 0] }, { id: 'v-2', vector: [0, 0, 1] }]);
    await db.close();
    const ledgerFile = path.join(corpusDir, 'RVF-GENERATIONS.json');
    const ledger = readJson(ledgerFile);
    ledger.stores.alpha = { ...ledger.stores.alpha, sha256: sha256File(rvfPath), bytes: fs.statSync(rvfPath).size };
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));

    await expect(assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/measured against different alpha RVF bytes/);
  });

  it('(8d) coverage drift is rejected: a store the coverage names is absent, a store on disk is unclassified, or the coverage digest is broken', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const ghostRow = (rows) => rows.push({ ...rows[0], key: 'repo:ruvnet/ghost', name: 'ghost', url: 'https://github.com/ruvnet/ghost', artifact: { ...rows[0].artifact, store: 'ghost' } });
    const corpusA = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusA, { mutate: ghostRow });
    await expect(assembleBundle({ corpusDir: corpusA, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/does not match its sealed coverage/);

    const corpusB = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha', 'beta'] });
    writeCoverage(runtimeRoot, corpusB, { mutate: (rows) => rows.splice(rows.findIndex((row) => row.name === 'beta'), 1) });
    await expect(assembleBundle({ corpusDir: corpusB, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/does not match its sealed coverage/);

    const corpusC = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    writeCoverage(runtimeRoot, corpusC);
    const coverageFile = path.join(runtimeRoot, 'data', 'source-coverage.json');
    const coverage = readJson(coverageFile);
    coverage.rows[0].status = 'STALE'; // edited after sealing: the generation digest no longer recomputes
    fs.writeFileSync(coverageFile, JSON.stringify(coverage));
    await expect(assembleBundle({ corpusDir: corpusC, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/sealed corpus coverage is invalid/);
  });
});

describe('assembleBundle — corpus SOURCE.json and public-store-classes.json fail loud (fix 6)', () => {
  it('rejects a corpus with no SOURCE.json, an unparseable one, or a repository store with no updater entry', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const build = async (tamper) => {
      const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
      tamper(corpusDir);
      return assembleBundle({ corpusDir, runtimeRoot, outDir: outDirFor(), identity: IDENTITY });
    };
    await expect(build((c) => fs.rmSync(path.join(c, 'SOURCE.json')))).rejects.toThrow(/corpus SOURCE\.json is missing/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'SOURCE.json'), '{ not json'))).rejects.toThrow(/corpus SOURCE\.json is unreadable/);
    await expect(build((c) => fs.writeFileSync(path.join(c, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', stores: {} }))))
      .rejects.toThrow(/alpha: sealed corpus SOURCE\.json carries no updater entry/);
  });

  it('rejects an external corpus with no public-store-classes.json, an unparseable one, and a standalone kb whose concepts store cannot be classified', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const external = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    fs.rmSync(path.join(external, 'public-store-classes.json'));
    await expect(assembleBundle({ corpusDir: external, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/carries no public-store-classes\.json/);

    const corrupt = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    fs.writeFileSync(path.join(corrupt, 'public-store-classes.json'), '{ nope');
    await expect(assembleBundle({ corpusDir: corrupt, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/public-store-classes\.json is present but unreadable/);

    const kb = await writeStandaloneKb(runtimeRoot, ['alpha', 'concepts']);
    await expect(assembleBundle({ corpusDir: kb, runtimeRoot, outDir: outDirFor(), identity: IDENTITY }))
      .rejects.toThrow(/concepts store is present but public-store-classes\.json is missing/);
  });

  it('keeps every per-store updater field the corpus recorded (updateManaged, a per-store releaseTag) while binding identity from the ledger', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs);
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const sourceFile = path.join(corpusDir, 'SOURCE.json');
    const source = readJson(sourceFile);
    source.stores.alpha = { ...source.stores.alpha, updateManaged: false, releaseTag: 'v0.0.1-store', sourceCommit: 'f'.repeat(40) };
    fs.writeFileSync(sourceFile, JSON.stringify(source));
    const outDir = outDirFor();

    await assembleBundle({ corpusDir, runtimeRoot, outDir, identity: IDENTITY });

    const shipped = readJson(path.join(outDir, 'SOURCE.json')).stores.alpha;
    expect(shipped.updateManaged).toBe(false);
    expect(shipped.releaseTag).toBe('v0.0.1-store');
    expect(shipped.canonicalBundleUrl).toBe('https://example.invalid/alpha/bundle.zip');
    expect(shipped.sourceCommit).toBe(commitFor('alpha')); // the ledger's generation wins over the stale SOURCE copy
  });
});

describe('assembleBundle — candidate archive round-trip', () => {
  it('(8e) an assembled archive re-assembles from its own extracted bytes and preserves the selection receipt byte-for-byte', async () => {
    const runtimeRoot = buildRuntimeRoot(dirs, { prose: PROSE });
    const corpusDir = await buildCorpus(dirs, { runtimeRoot, stores: ['alpha'] });
    const outA = outDirFor();
    const first = await assembleBundle({ corpusDir, runtimeRoot, outDir: outA, identity: IDENTITY });

    const extracted = tempDir(dirs, 'extracted');
    await extractZip(first.zipFile, extracted);
    // The extracted archive IS a corpus: it carries its receipt, its sealed prose, its ledger, and
    // its updater configuration — so it re-assembles with nothing re-derived.
    const outB = outDirFor();
    const second = await assembleBundle({ corpusDir: extracted, runtimeRoot, outDir: outB, identity: IDENTITY });

    expect(second.selectedStores).toEqual(first.selectedStores);
    for (const name of [SELECTION_FILE, 'alpha.big.rvf', 'alpha-primer.md', 'capability-cards.md', 'l2/alpha-topic.md']) {
      expect(sha256File(path.join(outB, name)), name).toBe(sha256File(path.join(corpusDir, name)));
    }
    expect(fs.readFileSync(path.join(outB, SELECTION_FILE))).toEqual(fs.readFileSync(path.join(outA, SELECTION_FILE)));
  });
});
