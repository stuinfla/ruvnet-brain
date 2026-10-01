#!/usr/bin/env node
// scripts/corpus-canary.mjs — the CONSUMER must accept a corpus before the producer may promote it.
//
// THE FAILURE THIS EXISTS TO END (2026-08-21 .. 2026-09-30, measured on the owner's Mac). The nightly
// corpus pipeline published generations to releases/latest that no installed customer could apply:
// the archive carried no COVERAGE.json, and kb/forge-update.mjs refused it every night with
// "staged ReleaseCoverage failed integrity: COVERAGE.json is missing". Every producer-side gate was
// green — receipt verified, signature verified, runtime pin verified — because every one of them asked
// the PRODUCER's question ("is this archive what we built?"). Nobody asked the CONSUMER's question
// ("can a customer actually install it?"), so nobody's Brain moved for 40 days and nothing paged.
//
// So this canary asks exactly the consumer's question, the consumer's way, on a runner that holds no
// repository secret:
//
//   1. INSTALL the approved runtime as a stranger does: `npm install ruvnet-brain@<approved>` into a
//      throwaway prefix, then that package's own bin/install.mjs --version v<approved> into an isolated
//      HOME. That downloads, signature-checks and unpacks the approved release's own archive, places
//      the trusted coverage validator and stamps RUNTIME-IDENTITY.json — the installer's real path.
//   2. POINT the installed updater at the candidate. A customer's SOURCE.json says
//      `canonicalManifestUrl: https://api.github.com/repos/<repo>/releases/latest`. The candidate is
//      staged as a PRERELEASE (never latest), so the one change made is a pure function of the
//      candidate tag: `releases/latest` -> `releases/tags/<tag>`. GitHub serves the same release object
//      shape from both endpoints. Nothing else is touched: the updater's embedded public key, its
//      signature check, the installed coverage validator and the runtime-identity gate all run as
//      shipped. The rewrite refuses any SOURCE.json that does not poll releases/latest.
//   3. APPLY with the updater INSIDE that install: `node <kb>/forge-update.mjs --apply --result-file`.
//      Never `npx ruvnet-brain --update`: that command falls back to a fresh install of releases/latest
//      when the updater fails, which would turn a refused candidate into a green canary.
//   4. JUDGE what landed (judgeCanary below) and write a verdict bound to this run and to the exact
//      asset digests it tested. release.mjs --promote-staged refuses promotion without a PASS verdict
//      whose assets still equal the release's (scripts/corpus-promotion.mjs evaluateCanaryVerdict).
//
// The child processes get a CONSTRUCTED environment, never process.env: GH_TOKEN / GITHUB_TOKEN never
// reach the customer install. PATH is node's own directory plus /usr/bin:/bin, so no `claude` or
// `codex` host is wired — this is the knowledge channel, not the host matrix.
//
//   node scripts/corpus-canary.mjs --repo owner/name --tag corpus-sha256-<64hex> --approved-version X.Y.Z
//        --work <dir> --verdict-out <file> [--api-base URL] [--installed-kb <dir> --home <dir>]
//   exit 0 = PASS, 1 = FAIL (verdict written either way), 2 = usage.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CANARY_VERDICT_KIND, CORPUS_TAG_PATTERN, REQUIRED_CANARY_CHECKS } from './corpus-promotion.mjs';

export const PUBLIC_API = 'https://api.github.com';
export const FRESHNESS_LIMIT_MS = 48 * 3_600_000;
const SEMVER = /^\d+\.\d+\.\d+$/;
// Exit 2 is the updater's "network / manifest unreachable, nothing touched" (kb/forge-update.mjs:62-71).
// It is the only code worth retrying: the unauthenticated API a customer polls is shared per runner IP.
const NETWORK_EXIT = 2;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export const customerManifestUrl = ({ apiBase = PUBLIC_API, repo }) => `${apiBase}/repos/${repo}/releases/latest`;
export const candidateManifestUrl = ({ apiBase = PUBLIC_API, repo, tag }) => `${apiBase}/repos/${repo}/releases/tags/${tag}`;

/**
 * The ONE change the canary makes to a customer install: the manifest it polls. Refuses anything but
 * a customer that polls releases/latest, so a config drift in the shipped SOURCE.json is a FAIL here
 * rather than a canary that silently tests some other channel.
 */
export function pointUpdaterAtCandidate({ kbDir, apiBase = PUBLIC_API, repo, tag }) {
  const file = path.join(kbDir, 'SOURCE.json');
  const before = readJson(file);
  const expected = customerManifestUrl({ apiBase, repo });
  if (before.canonicalManifestUrl !== expected) {
    throw new Error(`installed SOURCE.json polls ${JSON.stringify(before.canonicalManifestUrl)}, not the customer channel ${expected}`);
  }
  const manifestUrl = candidateManifestUrl({ apiBase, repo, tag });
  fs.writeFileSync(file, `${JSON.stringify({ ...before, canonicalManifestUrl: manifestUrl }, null, 2)}\n`);
  return { before, manifestUrl };
}

/** Top-level installed packages (scoped names expanded), e.g. ['@ruvector/rvf', '@xenova/transformers']. */
export function installedModules(kbDir) {
  const root = path.join(kbDir, 'node_modules');
  if (!fs.existsSync(root)) return [];
  const names = [];
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(root, entry))) names.push(`${entry}/${scoped}`);
    } else names.push(entry);
  }
  return names.sort();
}

/** Every directory under `home` that is a KB tree (SOURCE.json + forge-update.mjs), and every .big.rvf. */
function scanHome(home) {
  const trees = [];
  const rvfs = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('SOURCE.json') && names.has('forge-update.mjs')) trees.push(dir);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.big.rvf')) rvfs.push(full);
    }
  };
  walk(home);
  return { trees: trees.sort(), rvfs: rvfs.sort() };
}

function coverageRows(file) {
  if (!fs.existsSync(file)) return null;
  const coverage = readJson(file);
  return { observedAt: coverage.observedAt, rows: Array.isArray(coverage.rows) ? coverage.rows : [] };
}

/**
 * Per-store freshness, judged from the generation's own sealed coverage (CORPUS-COVERAGE.json inside
 * the installed tree): the upstream observation must be under 48h old, and no store may carry a commit
 * other than the upstream commit observed then. Together those ARE the 48h guarantee. There is
 * deliberately NO rule on a store's own ingestedAt: a store keeps the ingestion time of the last night
 * its upstream moved (measured 2026-09-30: one generation holds ingestedAt from 2026-07-30 to
 * 2026-09-30), so a "moved store must be ingested within 48h of now" rule would wrongly refuse a
 * perfectly fresh generation about three nights after every code release.
 * MISSING/INELIGIBLE rows are the coverage validator's business (it already ran), not a freshness question.
 */
export function storeFreshness({ after, before = null, now }) {
  if (!after) return { ok: false, detail: 'CORPUS-COVERAGE.json is missing from the installed tree' };
  const observed = Date.parse(after.observedAt);
  if (!Number.isFinite(observed)) return { ok: false, detail: `unreadable coverage observedAt ${JSON.stringify(after.observedAt)}` };
  const age = now - observed;
  const problems = [];
  if (age > FRESHNESS_LIMIT_MS || age < 0) problems.push(`upstream observed ${(age / 3_600_000).toFixed(1)}h ago (limit 48h)`);
  const priorCommit = new Map((before?.rows || []).map((row) => [row.key, row.artifact?.sourceCommit || null]));
  const stale = [];
  let moved = 0;
  for (const row of after.rows) {
    if (row.status === 'INELIGIBLE') continue;
    const upstream = row.upstream?.sha || null;
    const built = row.artifact?.sourceCommit || null;
    if (!upstream || !built) continue;
    if (upstream !== built) { stale.push(row.artifact?.store || row.key); continue; }
    if (before && priorCommit.get(row.key) !== upstream) moved += 1;
  }
  if (stale.length) problems.push(`${stale.length} store(s) built from a commit older than their observed upstream: ${stale.slice(0, 10).join(', ')}`);
  return problems.length
    ? { ok: false, detail: problems.join('; ') }
    : { ok: true, detail: `observed ${(age / 3_600_000).toFixed(1)}h ago; ${after.rows.length} row(s), 0 stale; ${before ? `${moved} moved since the installed generation, all at their observed upstream commit` : 'no prior coverage to diff against'}` };
}

/**
 * The verdict. Pure over what is on disk plus what the updater reported. Every check in
 * REQUIRED_CANARY_CHECKS is always present, so a missing check can never read as a pass.
 */
export async function judgeCanary({
  tag, approvedVersion, release, updater, before, beforeModules, beforeCoverage, kbDir, home, now = Date.now(),
}) {
  const archiveSha256 = tag.slice('corpus-sha256-'.length);
  const checks = [];
  const check = async (name, fn) => {
    try {
      const { ok, detail } = await fn();
      checks.push({ name, ok: ok === true, detail: String(detail) });
    } catch (error) {
      checks.push({ name, ok: false, detail: `check threw: ${error.message}` });
    }
  };
  const after = fs.existsSync(path.join(kbDir, 'SOURCE.json')) ? readJson(path.join(kbDir, 'SOURCE.json')) : null;
  const result = updater?.result || null;

  await check('candidate-release', () => {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const zip = assets.find((asset) => asset?.name === 'ruvnet-brain.zip');
    const sig = assets.find((asset) => asset?.name === 'ruvnet-brain.zip.sig');
    const problems = [];
    if (release?.tag_name !== tag) problems.push(`payload names ${release?.tag_name}`);
    if (release?.draft !== false) problems.push('release is a draft (customers cannot download it)');
    if (zip?.digest !== `sha256:${archiveSha256}`) problems.push(`ruvnet-brain.zip digest ${zip?.digest || '(none)'} is not the tag digest`);
    if (!sig) problems.push('no detached ruvnet-brain.zip.sig asset');
    return problems.length ? { ok: false, detail: problems.join('; ') }
      : { ok: true, detail: `${tag} serves ruvnet-brain.zip sha256:${archiveSha256.slice(0, 12)}… and its .sig` };
  });
  await check('updater-exit', () => ({
    ok: updater?.exitCode === 0 && result?.terminalVerdict === 'applied',
    detail: `exit ${updater?.exitCode}, terminal verdict ${result?.terminalVerdict || '(no result receipt)'}, ${updater?.attempts ?? 0} attempt(s)`,
  }));
  await check('signature-verified', () => {
    const line = /✓ signature verified — signature valid \(sha256 ([0-9a-f]{12})…\)/.exec(String(updater?.output || ''));
    const ok = Boolean(line) && line[1] === archiveSha256.slice(0, 12) && result?.bundleSha256 === archiveSha256;
    return { ok, detail: ok ? `the shipped updater verified the candidate bytes against its embedded key (${line[1]}…)`
      : `signature line ${line ? line[1] : '(absent)'}; applied bundle ${result?.bundleSha256 || '(none)'}; expected ${archiveSha256}` };
  });
  await check('staged-coverage', async () => {
    const validatorFile = path.join(kbDir, 'coverage-integrity.mjs');
    if (!fs.existsSync(validatorFile)) return { ok: false, detail: 'the installer-placed coverage validator is missing' };
    const { validateCoverageDirectory } = await import(pathToFileURL(validatorFile).href);
    const verdict = validateCoverageDirectory(kbDir, { expectedVersion: approvedVersion });
    const coverageFile = path.join(kbDir, 'COVERAGE.json');
    const bound = fs.existsSync(coverageFile) && result?.coverageSha256 === sha256File(coverageFile);
    return { ok: verdict.valid === true && bound,
      detail: verdict.valid ? (bound ? `valid for runtime ${approvedVersion}; COVERAGE.json is the one the updater applied`
        : 'COVERAGE.json on disk is not the one the updater reported') : verdict.failures.join('; ') };
  });
  await check('source-advanced', () => {
    const problems = [];
    if (!after) return { ok: false, detail: 'no SOURCE.json after apply' };
    if (after.corpusReleaseTag !== tag) problems.push(`corpusReleaseTag ${after.corpusReleaseTag || '(none)'}`);
    if (!(Date.parse(after.builtUtc) > Date.parse(before?.builtUtc))) problems.push(`builtUtc ${after.builtUtc} did not advance past ${before?.builtUtc}`);
    if (after.brainVersion !== approvedVersion) problems.push(`brainVersion ${after.brainVersion} is not the approved ${approvedVersion}`);
    return problems.length ? { ok: false, detail: problems.join('; ') }
      : { ok: true, detail: `${before?.builtUtc} -> ${after.builtUtc}; corpusReleaseTag ${tag.slice(0, 26)}…` };
  });
  await check('runtime-identity', () => {
    const file = path.join(kbDir, 'RUNTIME-IDENTITY.json');
    if (!fs.existsSync(file)) return { ok: false, detail: 'RUNTIME-IDENTITY.json is gone (the next corpus check would refuse)' };
    const identity = readJson(file);
    return { ok: identity.brainVersion === approvedVersion, detail: `installed runtime ${identity.brainVersion}` };
  });
  await check('node-modules', () => {
    const manifest = path.join(kbDir, 'package.json');
    const declared = fs.existsSync(manifest) ? Object.keys(readJson(manifest).dependencies || {}) : [];
    const required = [...new Set([...declared, ...(beforeModules || [])])].sort();
    const missing = required.filter((name) => !fs.existsSync(path.join(kbDir, 'node_modules', name, 'package.json')));
    if (!required.length) return { ok: false, detail: 'the install had no node_modules to preserve (reader deps never installed)' };
    return { ok: missing.length === 0, detail: missing.length ? `dropped by the update: ${missing.join(', ')}` : `${required.length} reader package(s) intact` };
  });
  await check('single-kb-tree', () => {
    const { trees, rvfs } = scanHome(home);
    const outside = rvfs.filter((file) => path.dirname(file) !== kbDir);
    const ok = trees.length === 1 && trees[0] === kbDir && outside.length === 0 && rvfs.length > 0;
    return { ok, detail: `${trees.length} KB tree(s) [${trees.map((tree) => path.relative(home, tree)).join(', ')}], `
      + `${rvfs.length} .big.rvf, ${outside.length} outside the live KB` };
  });
  await check('store-freshness', () => storeFreshness({
    after: coverageRows(path.join(kbDir, 'CORPUS-COVERAGE.json')), before: beforeCoverage, now,
  }));

  for (const name of REQUIRED_CANARY_CHECKS) {
    if (!checks.some((entry) => entry.name === name)) checks.push({ name, ok: false, detail: 'check never ran' });
  }
  return { verdict: checks.every((entry) => entry.ok) ? 'PASS' : 'FAIL', checks };
}

/** The environment a stranger has: no inherited tokens, an isolated HOME, only node/npm and the base system. */
export function customerEnv({ home, work }) {
  const brainHome = path.join(home, '.cache', 'ruvnet-brain');
  return {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    RUVNET_BRAIN_HOME: brainHome,
    RUVNET_BRAIN_KB: path.join(brainHome, 'kb'),
    TMPDIR: path.join(work, 'tmp'),
    npm_config_cache: path.join(work, 'npm-cache'),
    npm_config_update_notifier: 'false',
    CI: 'true',
    LANG: 'C.UTF-8',
  };
}

function runLogged(command, args, { env, cwd, timeoutMs, log }) {
  const result = spawnSync(command, args, { env, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  log(`$ ${path.basename(command)} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0]} failed (${result.error?.message || `exit ${result.status}`}): ${String(result.stderr || result.stdout || '').trim().slice(-2000)}`);
  }
  return result;
}

/** Phase 1: the approved runtime, installed exactly as `npx ruvnet-brain@<version>` would. */
export function installCustomer({ approvedVersion, work, home, log = () => {} }) {
  const env = customerEnv({ home, work });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const prefix = path.join(work, 'npx');
  fs.mkdirSync(prefix, { recursive: true });
  const npm = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  runLogged(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-save', `ruvnet-brain@${approvedVersion}`],
    { env, cwd: prefix, timeoutMs: 600_000, log });
  const installer = path.join(prefix, 'node_modules', 'ruvnet-brain', 'bin', 'install.mjs');
  const installed = readJson(path.join(prefix, 'node_modules', 'ruvnet-brain', 'package.json')).version;
  if (installed !== approvedVersion) throw new Error(`npm served ruvnet-brain ${installed}, not the approved ${approvedVersion}`);
  runLogged(process.execPath, [installer, '--yes', '--force', '--version', `v${approvedVersion}`, '--no-nightly-prompt',
    '--no-telemetry', '--no-stack', '--no-enhance', '--no-statusline', '--no-selfcheck'],
  { env, cwd: home, timeoutMs: 1_800_000, log });
  return { kbDir: env.RUVNET_BRAIN_KB };
}

function runUpdater({ kbDir, env, resultFile }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(kbDir, 'forge-update.mjs'), '--apply', '--result-file', resultFile],
      { cwd: kbDir, env });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve({ exitCode: null, output: `${output}\n${error.message}` }));
    child.on('close', (exitCode) => resolve({ exitCode, output }));
  });
}

async function fetchRelease({ apiBase, repo, tag }) {
  const response = await fetch(candidateManifestUrl({ apiBase, repo, tag }), { headers: { accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`release ${tag} returned HTTP ${response.status}`);
  return response.json();
}

/**
 * The whole canary. `install` is the phase-1 seam: CI uses installCustomer (the real npm package + real
 * installer); the unit suite hands in a customer tree built offline so the updater, the judge and the
 * verdict run for real without a 555 MB download.
 */
export async function runCanary({
  repo, tag, approvedVersion, work, apiBase = PUBLIC_API, install = installCustomer, home = path.join(work, 'home'),
  env = process.env, now = () => Date.now(), retryDelayMs = 30_000, maxAttempts = 3, log = () => {},
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo || ''))) throw new Error('--repo must be owner/name');
  if (!CORPUS_TAG_PATTERN.test(String(tag || ''))) throw new Error('--tag must be corpus-sha256-<64 hex>');
  if (!SEMVER.test(String(approvedVersion || ''))) throw new Error('--approved-version must be X.Y.Z');
  fs.mkdirSync(home, { recursive: true });
  const started = now();
  const { kbDir } = await install({ approvedVersion, work, home, log });
  const release = await fetchRelease({ apiBase, repo, tag });
  const beforeModules = installedModules(kbDir);
  const beforeCoverage = coverageRows(path.join(kbDir, 'CORPUS-COVERAGE.json'));
  const { before } = pointUpdaterAtCandidate({ kbDir, apiBase, repo, tag });
  const childEnv = { ...customerEnv({ home, work }), RUVNET_BRAIN_KB: kbDir };
  fs.mkdirSync(childEnv.TMPDIR, { recursive: true });

  const resultFile = path.join(work, 'update-result.json');
  let updater = { exitCode: null, output: '', attempts: 0 };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    fs.rmSync(resultFile, { force: true });
    const run = await runUpdater({ kbDir, env: childEnv, resultFile });
    updater = { ...run, attempts: attempt };
    log(`--- forge-update.mjs --apply (attempt ${attempt}) exit ${run.exitCode}\n${run.output}`);
    if (run.exitCode !== NETWORK_EXIT || attempt === maxAttempts) break;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
  }
  updater.result = fs.existsSync(resultFile) ? readJson(resultFile) : null;
  const judged = await judgeCanary({ tag, approvedVersion, release, updater, before, beforeModules, beforeCoverage,
    kbDir: fs.realpathSync(kbDir), home: fs.realpathSync(home), now: now() });
  return {
    schemaVersion: 1,
    kind: CANARY_VERDICT_KIND,
    verdict: judged.verdict,
    repo,
    tag,
    archiveSha256: tag.slice('corpus-sha256-'.length),
    approvedVersion,
    runId: env.GITHUB_RUN_ID || null,
    runAttempt: env.GITHUB_RUN_ATTEMPT || null,
    checkedAt: new Date(now()).toISOString(),
    elapsedMs: now() - started,
    assets: (release.assets || []).map((asset) => ({ name: asset.name, size: asset.size, digest: asset.digest || null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    updater: { exitCode: updater.exitCode, attempts: updater.attempts, terminalVerdict: updater.result?.terminalVerdict || null,
      bundleSha256: updater.result?.bundleSha256 || null, coverageSha256: updater.result?.coverageSha256 || null },
    checks: judged.checks,
  };
}

async function main(argv = process.argv.slice(2)) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const work = opt('--work') && path.resolve(opt('--work'));
  const verdictOut = opt('--verdict-out') && path.resolve(opt('--verdict-out'));
  if (!work || !verdictOut) {
    process.stderr.write('usage: corpus-canary.mjs --repo o/n --tag corpus-sha256-<hex> --approved-version X.Y.Z --work <dir> --verdict-out <file> [--api-base URL] [--installed-kb <dir> --home <dir>]\n');
    return 2;
  }
  fs.mkdirSync(work, { recursive: true });
  const logFile = path.join(work, 'canary.log');
  const log = (text) => { fs.appendFileSync(logFile, `${text}\n`); };
  const installedKb = opt('--installed-kb');
  const install = installedKb ? () => ({ kbDir: path.resolve(installedKb) }) : installCustomer;
  let record;
  try {
    record = await runCanary({ repo: opt('--repo'), tag: opt('--tag'), approvedVersion: opt('--approved-version'), work,
      apiBase: opt('--api-base') || PUBLIC_API, install, home: path.resolve(opt('--home') || path.join(work, 'home')), log });
  } catch (error) {
    // Could not even reach a judgement = the consumer did not accept. Still a written verdict.
    record = { schemaVersion: 1, kind: CANARY_VERDICT_KIND, verdict: 'FAIL', repo: opt('--repo') || null, tag: opt('--tag') || null,
      approvedVersion: opt('--approved-version') || null, runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null, checkedAt: new Date().toISOString(), assets: [],
      checks: [{ name: 'canary-ran', ok: false, detail: error.message }] };
  }
  fs.mkdirSync(path.dirname(verdictOut), { recursive: true });
  fs.writeFileSync(verdictOut, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`corpus-canary ${record.verdict} ${record.tag}\n`);
  for (const entry of record.checks) process.stdout.write(`  [${entry.ok ? 'ok' : 'FAIL'}] ${entry.name}: ${entry.detail}\n`);
  return record.verdict === 'PASS' ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().then((code) => { process.exitCode = code; });
}
