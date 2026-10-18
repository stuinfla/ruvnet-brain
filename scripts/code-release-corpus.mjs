#!/usr/bin/env node
// scripts/code-release-corpus.mjs — ADR-0091 D6: a code release is built from the newest compatible
// corpus generation, through one of TWO assembly paths chosen by where the seed came from.
//
//   seed origin                      path               what runs
//   -------------------------------  -----------------  ---------------------------------------------
//   published-generation             single-pass        observe-baseline, ONE build-bundle with the
//   (corpus-sha256-<digest>, with                       generation's sealed coverage. The generation's
//   its D6.2 coverage sidecar)                          bytes are NEVER mutated: no capability-only
//                                                       refresh, no index repair. Proven afterwards.
//   committed-bootstrap (v4.3.26,    legacy-two-pass    exactly the pre-D6 ci.yml sequence: capability-
//   pre-ADR-0091 Step 4)                                only refresh + index repair, observe-baseline,
//                                                       build / release-projection / build.
//
// This is a genuine dual path, not one path with a flag to retire: the bootstrap remains the recovery
// seed (ADR-0091 D6.1), and it predates every sealed-input contract the single-pass assembly checks.
// Running refreshCapabilityOnlyStore on a sealed generation would rewrite one store and prune another
// AFTER the generation's coverage measured them, so the coverage would describe bytes the release
// does not ship. The path choice lives in ONE function (assemblyPathFor) so a test can prove neither
// collapses into the other.
//
// It also owns the D6.6 publish-time guard (assertNoNewerCorpusGeneration), because it is the same
// resolver question asked a second time.
//
// Usage (ci.yml release-qe, after downloading and extracting the resolved seed):
//   node scripts/code-release-corpus.mjs assemble --descriptor <release-evidence/corpus-seed.json>
//        --seed-bundle <seed zip> --assets <extracted seed dir> --evidence-dir <release-evidence>
//        [--coverage <CORPUS-COVERAGE.json> --coverage-receipt <coverage-receipt.json>]   (single-pass only)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCoverageSidecar } from './corpus-coverage-sidecar.mjs';
import { resolveNextCorpusSeed } from './corpus-next-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_TAG = /^corpus-sha256-([0-9a-f]{64})$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const SINGLE_PASS = 'single-pass';
export const LEGACY_TWO_PASS = 'legacy-two-pass';
// The seed reader modules the legacy capability-only refresh embeds with -- the exact pins the pre-D6
// ci.yml step installed (npm package @ruvector/rvf 0.3.4: ruvector/npm/packages/rvf/package.json).
const LEGACY_READER_PACKAGES = ['@xenova/transformers@2.17.2', '@ruvector/rvf@0.3.4'];
// Every file of a store family build-bundle copies from the corpus (build-bundle.mjs step 3).
const STORE_SUFFIXES = ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json',
  '.symbols.json', '.sources.json'];

function fail(message) {
  throw new Error(`[code-release-corpus] ${message}`);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** The ONE place the path is chosen. Anything that is neither shape is refused, never defaulted. */
export function assemblyPathFor(descriptor) {
  if (descriptor?.origin === 'published-generation') {
    const match = CORPUS_TAG.exec(String(descriptor.tag || ''));
    if (!match || match[1] !== descriptor.sha256) fail(`generation seed tag ${descriptor.tag} does not name its own digest`);
    if (!descriptor.coverage || !HEX64.test(String(descriptor.coverage.sha256 || ''))) {
      fail(`generation seed ${descriptor.tag} was resolved without its coverage sidecar; resolve with --require-coverage`);
    }
    return SINGLE_PASS;
  }
  if (descriptor?.origin === 'committed-bootstrap') {
    if (CORPUS_TAG.test(String(descriptor.tag || ''))) fail('a committed bootstrap seed must be the pinned pre-ADR-0091 tag, not a generation tag');
    return LEGACY_TWO_PASS;
  }
  fail(`resolved seed has no recognised origin (${JSON.stringify(descriptor?.origin ?? null)}); `
    + 'it must come from scripts/corpus-next-seed.mjs');
}

/** Digest of every regular file under `dir` -- the "was the sealed generation touched?" proof. */
export function treeDigest(dir) {
  const rows = [];
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file, relative);
      else if (entry.isFile()) rows.push(`${relative}\0${sha256File(file)}`);
    }
  };
  walk(path.resolve(dir), '');
  rows.sort();
  return { files: rows.length, sha256: crypto.createHash('sha256').update(rows.join('\n')).digest('hex') };
}

/**
 * ADR-0091 V6a: the assembled archive ships the generation's store bytes, unchanged. The store set
 * must equal the generation's ledger, and every store-family file in the assembly must be
 * byte-identical to the generation's copy.
 */
export function assertStoresUnmutated({ seedDir, bundleDir }) {
  const readLedger = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'RVF-GENERATIONS.json'), 'utf8'));
  const seedStores = Object.keys(readLedger(seedDir).stores || {}).map((name) => name.toLowerCase()).sort();
  const bundleStores = Object.keys(readLedger(bundleDir).stores || {}).sort();
  if (JSON.stringify(bundleStores.map((name) => name.toLowerCase())) !== JSON.stringify(seedStores)) {
    fail(`assembled store set differs from the generation's (${bundleStores.length} vs ${seedStores.length})`);
  }
  let compared = 0;
  const changed = [];
  for (const store of bundleStores) {
    for (const suffix of STORE_SUFFIXES) {
      const shipped = path.join(bundleDir, `${store}${suffix}`);
      if (!fs.existsSync(shipped)) continue;
      const sealed = path.join(seedDir, `${store}${suffix}`);
      if (!fs.existsSync(sealed) || sha256File(sealed) !== sha256File(shipped)) changed.push(`${store}${suffix}`);
      compared += 1;
    }
  }
  if (changed.length) fail(`assembly changed ${changed.length} store file(s) the generation sealed: ${changed.slice(0, 5).join(', ')}`);
  return { stores: bundleStores.length, files: compared };
}

const defaultRun = (command, args, options = {}) => spawnSync(command, args, { stdio: 'inherit', ...options });

function checkedRun(run, label, command, args, options) {
  const result = run(command, args, options) || {};
  if (result.error || result.status !== 0) {
    fail(`${label} failed (${result.error?.message || `exit ${result.status}`})`);
  }
  return result;
}

/**
 * Assemble the release bundle into <root>/dist from the resolved seed. `run` is the process seam: the
 * tests record it to prove which commands each path runs, and in which order.
 */
export function assembleCodeReleaseCorpus({
  root = ROOT, descriptor, seedBundle, assetsDir, evidenceDir, coverageFile = null, coverageReceiptFile = null,
  run = defaultRun, env = process.env,
} = {}) {
  const mode = assemblyPathFor(descriptor);
  const node = process.execPath;
  const script = (name) => path.join(root, 'scripts', name);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const assets = path.resolve(assetsDir || '');
  const evidence = path.resolve(evidenceDir || '');
  const baselineReceipt = path.join(evidence, 'baseline-observation-receipt.json');
  const observeBaseline = () => {
    checkedRun(run, 'observe-baseline', node, [script('public-verification-inputs.mjs'), 'observe-baseline',
      '--baseline-bundle', seedBundle, '--expected-tag', descriptor.tag, '--expected-sha256', descriptor.sha256,
      '--expected-bytes', String(descriptor.bytes), '--out', baselineReceipt], { cwd: root, env });
    return sha256File(baselineReceipt);
  };

  if (mode === LEGACY_TWO_PASS) {
    // The pre-D6 ci.yml sequence, unchanged. The public ruOS input is capabilities-only and the
    // bootstrap predates that policy, so its RVF is rebuilt from the curated summary; --repair also
    // re-seals stale ledger hashes after index persistence (the v4.2.1 seed exposed three roots whose
    // HNSW bytes advanced after their ledger rows were written).
    checkedRun(run, 'install seed reader dependencies', 'npm', ['install', '--prefix', assets, '--no-save',
      '--package-lock=false', '--ignore-scripts', ...LEGACY_READER_PACKAGES], { cwd: root, env });
    const embedEnv = { ...env, XENOVA_PATH: path.join(assets, 'node_modules', '@xenova', 'transformers'),
      RVF_MODULE_PATH: path.join(assets, 'node_modules') };
    checkedRun(run, 'capability-only refresh', node, [script('refresh-capability-only-store.mjs'), '--assets', assets],
      { cwd: root, env: embedEnv });
    checkedRun(run, 'index repair', node, [script('rvf-index-audit.mjs'), '--dir', assets, '--repair'], { cwd: root, env: embedEnv });
    const baselineSha256 = observeBaseline();
    const build = ['--version', `v${version}`, '--assets', assets, '--legacy-seed-projection'];
    checkedRun(run, 'legacy build pass 1', node, [script('build-bundle.mjs'), ...build], { cwd: root, env });
    const projection = path.join(path.dirname(evidence), 'release-projection');
    checkedRun(run, 'release projection', node, [script('release-projection.mjs'), '--corpus', 'data/source-coverage.json',
      '--assets', 'dist/ruvnet-brain', '--out', projection, '--version', version,
      '--source-snapshot', env.GITHUB_SHA || '', '--baseline-receipt-sha256', baselineSha256,
      '--seed-tag', descriptor.tag, '--seed-sha256', descriptor.sha256, '--seed-bytes', String(descriptor.bytes)], { cwd: root, env });
    checkedRun(run, 'legacy build pass 2', node, [script('build-bundle.mjs'), ...build,
      '--coverage', path.join(projection, 'COVERAGE.json'), '--projection', projection], { cwd: root, env });
    return { mode };
  }

  // SINGLE-PASS. The coverage file must be the one the resolver bound to this generation.
  const coverageBytes = fs.readFileSync(path.resolve(coverageFile || ''));
  const verified = verifyCoverageSidecar({ sidecar: JSON.parse(fs.readFileSync(path.resolve(coverageReceiptFile || ''), 'utf8')),
    coverageBytes, generationTag: descriptor.tag, archiveSha256: descriptor.sha256, archiveBytes: descriptor.bytes });
  if (crypto.createHash('sha256').update(coverageBytes).digest('hex') !== descriptor.coverage.sha256) {
    fail('the downloaded coverage is not the coverage the resolver sealed into the descriptor');
  }
  if (verified.degraded.carried.length || verified.degraded.missing.length) {
    fail(`generation ${descriptor.tag} is degraded (${verified.degraded.carried.length} carried, `
      + `${verified.degraded.missing.length} missing); a code release ships only an all-CURRENT corpus -- its install `
      + 'verification (scripts/public-verification-aggregate.mjs) requires every eligible store CURRENT');
  }
  const before = treeDigest(assets);
  // build-bundle reads the sealed coverage from the ONE canonical path (<root>/data/source-coverage.json),
  // exactly as prepareCorpusCandidate does. The committed file is restored afterwards so no later
  // release-QE step reads the generation's coverage believing it is the checkout's.
  const canonical = path.join(root, 'data', 'source-coverage.json');
  const committed = fs.existsSync(canonical) ? fs.readFileSync(canonical) : null;
  try {
    fs.writeFileSync(canonical, coverageBytes);
    const baselineSha256 = observeBaseline();
    checkedRun(run, 'single-pass build', node, [script('build-bundle.mjs'), '--version', `v${version}`, '--assets', assets,
      '--coverage', canonical, '--seed-tag', descriptor.tag, '--seed-sha256', descriptor.sha256,
      '--seed-bytes', String(descriptor.bytes), '--baseline-receipt-sha256', baselineSha256], { cwd: root, env });
  } finally {
    if (committed === null) fs.rmSync(canonical, { force: true });
    else fs.writeFileSync(canonical, committed);
  }
  const after = treeDigest(assets);
  if (after.sha256 !== before.sha256) fail(`the sealed generation directory was modified during assembly (${before.files} -> ${after.files} files)`);
  const unmutated = assertStoresUnmutated({ seedDir: assets, bundleDir: path.join(root, 'dist', 'ruvnet-brain') });
  return { mode, seedTree: before, unmutated };
}

/**
 * ADR-0091 D6.6. `sealed` is the descriptor release QE sealed into the payload; `resolution` is a fresh
 * resolveNextCorpusSeed({ requireCoverage: true }) answer. Refuses on any difference, and on any
 * resolution that could not prove there is nothing newer (a failed list, view or small download).
 */
export function checkNoNewerCorpusGeneration({ sealed, resolution }) {
  if (!sealed?.origin || !sealed?.tag || !HEX64.test(String(sealed.sha256 || ''))) {
    fail('the sealed corpus seed descriptor carries no resolver origin/tag/sha256; it did not come from corpus-next-seed.mjs');
  }
  const indeterminate = (resolution?.rejected || []).filter((row) => row.indeterminate);
  if (indeterminate.length) {
    fail(`cannot prove no newer corpus generation was published (${indeterminate.map((row) => `${row.tag || '(list)'}: ${row.reason}`).join('; ')})`);
  }
  const now = resolution?.seed;
  if (now?.tag !== sealed.tag || now?.sha256 !== sealed.sha256) {
    fail(`corpus generation ${now?.tag} published after this release was QE'd from ${sealed.tag}; re-run release QE`);
  }
  return { origin: sealed.origin, tag: sealed.tag };
}

export async function assertNoNewerCorpusGeneration({ sealedFile, repo, runtimeRoot = ROOT, run = undefined,
  resolve = resolveNextCorpusSeed } = {}) {
  const sealed = JSON.parse(fs.readFileSync(sealedFile, 'utf8'));
  const resolution = await resolve({ repo, root: runtimeRoot, runtimeRoot, requireCoverage: true, ...(run ? { run } : {}) });
  return checkNoNewerCorpusGeneration({ sealed, resolution });
}

const arg = (argv, name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

export function main(argv = process.argv.slice(2)) {
  if (argv[0] !== 'assemble') {
    process.stderr.write('usage: code-release-corpus.mjs assemble --descriptor <f> --seed-bundle <f> --assets <d> --evidence-dir <d> [--coverage <f> --coverage-receipt <f>]\n');
    return 2;
  }
  const descriptor = JSON.parse(fs.readFileSync(arg(argv, '--descriptor'), 'utf8'));
  const result = assembleCodeReleaseCorpus({
    descriptor,
    seedBundle: arg(argv, '--seed-bundle'),
    assetsDir: arg(argv, '--assets'),
    evidenceDir: arg(argv, '--evidence-dir'),
    coverageFile: arg(argv, '--coverage'),
    coverageReceiptFile: arg(argv, '--coverage-receipt'),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, seed: descriptor.tag, ...result })}\n`);
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
