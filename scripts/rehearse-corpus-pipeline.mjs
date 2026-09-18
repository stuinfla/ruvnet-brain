#!/usr/bin/env node
// scripts/rehearse-corpus-pipeline.mjs — ADR-086 Step 8.
//
// Run the complete corpus preparation and future product-consumption path in a DISPOSABLE checkout,
// end to end, with REAL seed import, REAL source acquisition, REAL local embeddings and REAL RVF
// indexes — on an explicitly bounded subset so the loop takes minutes instead of the ~6 hours a
// GitHub Actions corpus-seed dispatch takes. It exists because a 6-hour CI round trip is not a
// debugging loop, and because Dual made a local rehearsal a hard gate before any real dispatch.
//
// THIS IS AN ORCHESTRATOR. It calls the existing entry points; it reimplements none of them:
//   scripts/corpus-reconcile.mjs  assertBootstrapIdentity, normalizeExtractedCorpus, syncCorpusInputs,
//                                 seedPrivateFenceEvidence, acquireCorpusGeneration,
//                                 reconcileAndPrepareCorpusCandidate, prepareCorpusCandidate
//   scripts/source-coverage.mjs   observeSourceUniverse, canonicalSourceObservation, buildCoverage
//   scripts/build-bundle.mjs      assembleBundle (invoked exactly once per candidate, via its CLI,
//                                 by prepareCorpusCandidate — counted, never reimplemented)
//   scripts/corpus-candidate.mjs  --verify (CLI) and verifySeedBaseline
//   scripts/release.mjs           --corpus-seed (CLI, the real future product-consumption path)
//
// WHAT IS BOUNDED, AND SAID OUT LOUD: `--repos N` (default 2) and `--gists M` (default 3). A
// rehearsal receipt ALWAYS carries `bounds` and the banner below so nobody can mistake a 2-store
// rehearsal for a 194-store corpus build. Everything else is the production code path.
//
// SAFETY — publication mutations are RECORDED, NEVER EXECUTED, and the interception is PROVEN:
//   1. The explicit seam the code offers (`RUVNET_GH_COMMAND` / `RUVNET_GH_SCRIPT`, read by
//      scripts/release.mjs) is used FIRST, because it cannot be defeated by a PATH reassignment.
//   2. A PATH shim is installed as well (belt and braces), for any caller that has no such seam.
//   3. GH_TOKEN / GITHUB_TOKEN are poisoned for the publication phase, so even a leaked real `gh`
//      cannot authenticate against the live repository.
//   4. The harness PROVES its own interception with a probe before trusting any result, and FAILS
//      CLOSED when the probe shows it was bypassed. `--tamper bypass-interception` demonstrates
//      that detection by deliberately reassigning PATH the way scripts/nightly-gists.sh does.
//   A recorder that cannot detect its own bypass is exactly the silent failure this repo already
//   documented once (tests/integration/nightly-gists-error-paths.test.mjs).
//
// Usage:
//   node scripts/rehearse-corpus-pipeline.mjs [--repos 2] [--gists 3] [--generations 2]
//        [--receipt <file>] [--seed <local ruvnet-brain.zip>] [--keep] [--tamper <mode>]
//
// Done is an exit code, not an opinion: FAIL exits non-zero. A phase that could not run is a SKIP
// with a stated reason, never a silent pass.

import { isIngestibleDisposition } from './coverage-integrity.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAL_ROOT = path.resolve(HERE, '..');
const BANNER = 'BOUNDED REHEARSAL — a small explicitly-bounded subset, NOT a full corpus build';
const HEX64 = /^[a-f0-9]{64}$/;
const TAMPER_MODES = new Set(['none', 'extracted-byte', 'archive-byte', 'bypass-interception']);
const PROBE_ARG = '__rehearsal_probe__';

// Every `gh`/`npm` invocation that would MUTATE anything outside this process. Matched against the
// argument vector; a match is recorded and answered from the recorder, never executed. Expressed as
// data (not functions) so the generated recorder needs no eval to reconstruct it.
export const MUTATION_RULES = {
  gh: {
    verbsBySubject: {
      release: ['create', 'edit', 'delete', 'upload', 'delete-asset'],
      workflow: ['run', 'enable', 'disable'],
      pr: ['create', 'merge', 'close', 'edit', 'ready', 'review'],
      issue: ['create', 'close', 'edit', 'delete', 'transfer'],
      gist: ['create', 'edit', 'delete', 'rename'],
      secret: ['set', 'delete'],
      variable: ['set', 'delete'],
      ruleset: ['create', 'edit', 'delete'],
      repo: ['create', 'delete', 'edit', 'fork', 'rename', 'sync', 'archive'],
      cache: ['delete'],
      label: ['create', 'delete', 'edit', 'clone'],
    },
    // `gh api` against a REST path is a read only while it stays a GET: an explicit non-GET
    // --method, or any field flag (which makes gh send POST), marks it as a write.
    restWriteFlags: ['-f', '-F', '--input'],
    methodFlags: ['-X', '--method'],
    // `gh api graphql` ALWAYS sends POST and ALWAYS carries `-f query=...`, so the REST rule above
    // would classify every ordinary repository/gist enumeration as a mutation. MEASURED: it did —
    // the first rehearsal with whole-process interception failed with "GitHub repository
    // enumeration returned no repository connection" because the observation's own GraphQL read had
    // been stubbed out. For GraphQL the operation keyword in the document is the real signal.
    graphqlMutationSource: '(^|[\\s{}])mutation[\\s({]',
  },
  npm: { verbs: ['publish', 'unpublish', 'deprecate', 'dist-tag', 'access', 'owner', 'version', 'token'] },
};

function fail(message) {
  throw new Error(`[rehearse-corpus-pipeline] ${message}`);
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const digestOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
}

function runOrFail(label, command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error || result.status !== 0) {
    const detail = String(result.error?.message || result.stderr || result.stdout || `exit ${result.status}`).trim();
    fail(`${label} failed (${detail.slice(0, 800)})`);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Isolation snapshots. These are ASSERTIONS the run makes about itself, not comments: the real
// working tree and the installed brain at ~/.cache/ruvnet-brain/kb must be byte-unchanged after a
// rehearsal, and the receipt says so with a digest taken before and after.
// ---------------------------------------------------------------------------------------------

/** name/size/mtime/mode inventory of a tree — a cheap, complete change detector (any write to any
 * file changes size or mtime; any create/delete changes the entry set). Never opens file contents:
 * the installed brain is 1.4 GB and is READ-ONLY to this script. */
export function inventoryTree(dir, { maxEntries = 200_000 } = {}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) return { dir: root, present: false, entries: 0, digest: null };
  const rows = [];
  const visit = (current, prefix) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) {
      rows.push({ p: prefix, unreadable: String(error.code || error.message) });
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (rows.length > maxEntries) fail(`tree inventory exceeded ${maxEntries} entries (${root})`);
      let stat;
      try { stat = fs.lstatSync(absolute); } catch { rows.push({ p: relative, gone: true }); continue; }
      if (stat.isDirectory()) { rows.push({ p: `${relative}/`, m: stat.mode }); visit(absolute, relative); }
      else rows.push({ p: relative, s: stat.size, t: Math.trunc(stat.mtimeMs), m: stat.mode });
    }
  };
  visit(root, '');
  return { dir: root, present: true, entries: rows.length, digest: digestOf(rows) };
}

export function snapshotRepoState(root) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root });
  const status = run('git', ['status', '--porcelain'], { cwd: root });
  return {
    root: path.resolve(root),
    head: String(head.stdout || '').trim() || null,
    porcelain: String(status.stdout || ''),
    digest: digestOf([String(head.stdout || '').trim(), String(status.stdout || '')]),
  };
}

// ---------------------------------------------------------------------------------------------
// The command recorder. Publication mutations are recorded and never executed; reads pass through.
// ---------------------------------------------------------------------------------------------

function recorderSource({ tool, recordFile, token, stubDir }) {
  return `#!/usr/bin/env node
// GENERATED by scripts/rehearse-corpus-pipeline.mjs — a command recorder, not a tool.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = ${JSON.stringify(tool)};
const RECORD = ${JSON.stringify(recordFile)};
const TOKEN = ${JSON.stringify(token)};
const STUB_DIR = ${JSON.stringify(stubDir)};
const RULES = ${JSON.stringify(MUTATION_RULES)};
const args = process.argv.slice(2);

function isMutation(argv) {
  if (TOOL === 'npm') return RULES.npm.verbs.includes(argv[0]);
  if (argv[0] === 'api') {
    const methodIndex = argv.findIndex((token) => RULES.gh.methodFlags.includes(token));
    const method = methodIndex >= 0 ? String(argv[methodIndex + 1] || '').toUpperCase() : null;
    if (method && method !== 'GET') return true;
    if (argv[1] === 'graphql') {
      const document = argv.filter((token) => /^query=/.test(token)).map((token) => token.slice('query='.length)).join('\\n');
      return new RegExp(RULES.gh.graphqlMutationSource).test(document);
    }
    return RULES.gh.restWriteFlags.some((flag) => argv.includes(flag));
  }
  const verbs = RULES.gh.verbsBySubject[argv[0]];
  return Array.isArray(verbs) && verbs.includes(argv[1]);
}

function record(row) {
  fs.appendFileSync(RECORD, \`\${JSON.stringify({ tool: TOOL, args, at: new Date().toISOString(), token: TOKEN, ...row })}\\n\`);
}

if (args[0] === ${JSON.stringify(PROBE_ARG)}) {
  record({ classification: 'probe', executed: false });
  process.stdout.write(\`RUVNET-REHEARSAL-STUB-OK \${TOKEN}\\n\`);
  process.exit(0);
}

if (isMutation(args)) {
  record({ classification: 'publication-mutation', executed: false });
  process.stderr.write(\`[rehearsal-recorder] RECORDED, NOT EXECUTED: \${TOOL} \${args.join(' ')}\\n\`);
  process.stdout.write('{"ok":true,"recordedByRehearsalRecorder":true}\\n');
  process.exit(0);
}

// \`gh release view <tag>\` on a not-yet-published content-addressed tag: answered here so the
// absence proof never depends on the network or on an authenticated token. Recorded as a stubbed
// read, never as a passthrough — the receipt must not claim a network round trip that never happened.
if (TOOL === 'gh' && args[0] === 'release' && args[1] === 'view') {
  record({ classification: 'stubbed-read', executed: false });
  process.stderr.write('release not found\\n');
  process.exit(1);
}

const PATH_DIRS = String(process.env.PATH || '').split(path.delimiter)
  .concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])
  .filter((dir) => dir && path.resolve(dir) !== path.resolve(STUB_DIR));
const real = PATH_DIRS.map((dir) => path.join(dir, TOOL)).find((file) => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
});
if (!real) {
  record({ classification: 'passthrough-read', executed: false, error: \`no real \${TOOL} on PATH\` });
  process.stderr.write(\`[rehearsal-recorder] no real \${TOOL} found for passthrough\\n\`);
  process.exit(127);
}
const result = spawnSync(real, args, { stdio: 'inherit', env: process.env });
record({ classification: 'passthrough-read', executed: true, exit: result.status ?? null });
process.exit(result.status ?? 1);
`;
}

/**
 * Install the recorder. Returns the env additions plus the two things a caller must use before
 * trusting anything: `proveIntercepting()` and `recorded()`.
 */
export function installCommandRecorder({ dir, tools = ['gh', 'npm'] }) {
  const stubDir = path.resolve(dir);
  fs.mkdirSync(stubDir, { recursive: true });
  const recordFile = path.join(stubDir, 'recorded-commands.jsonl');
  fs.writeFileSync(recordFile, '');
  const token = crypto.randomBytes(12).toString('hex');
  const scripts = {};
  for (const tool of tools) {
    const script = path.join(stubDir, `${tool}-recorder.mjs`);
    fs.writeFileSync(script, recorderSource({ tool, recordFile, token, stubDir }));
    const shim = path.join(stubDir, tool);
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    fs.chmodSync(shim, 0o755);
    scripts[tool] = script;
  }
  const env = {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
    // The explicit seam scripts/release.mjs already offers. Preferred over PATH games precisely
    // because a script that reassigns PATH cannot defeat it.
    RUVNET_GH_COMMAND: process.execPath,
    RUVNET_GH_SCRIPT: scripts.gh,
    RUVNET_REHEARSAL_RECORD: recordFile,
  };

  const readProbe = (result) => String(result.stdout || '').includes(`RUVNET-REHEARSAL-STUB-OK ${token}`);

  return {
    stubDir,
    recordFile,
    token,
    env,
    scripts,
    recorded: () => fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    /**
     * Prove BOTH interception channels actually intercept, before any result is trusted. Returns
     * `{ ok, channels }`; a caller that gets `ok: false` must FAIL CLOSED, never proceed — a
     * bypassed recorder means the next `gh release create` would be real.
     */
    proveIntercepting: (extraEnv = {}) => {
      const merged = { ...process.env, ...env, ...extraEnv };
      const viaPath = run('gh', [PROBE_ARG], { env: merged });
      const viaSeam = run(merged.RUVNET_GH_COMMAND, [merged.RUVNET_GH_SCRIPT, PROBE_ARG], { env: merged });
      const channels = {
        pathShim: { intercepted: readProbe(viaPath), exit: viaPath.status ?? null },
        explicitSeam: { intercepted: readProbe(viaSeam), exit: viaSeam.status ?? null },
        resolvedGh: String(run('sh', ['-c', 'command -v gh'], { env: merged }).stdout || '').trim() || null,
      };
      channels.pathShimResolvesInsideStubDir = channels.resolvedGh
        ? path.resolve(path.dirname(channels.resolvedGh)) === stubDir : false;
      return { ok: channels.pathShim.intercepted && channels.explicitSeam.intercepted
        && channels.pathShimResolvesInsideStubDir, channels };
    },
    /**
     * The bypass DEMONSTRATION: reassign PATH exactly the way scripts/nightly-gists.sh:1 does
     * (`export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"` — a REASSIGNMENT, not an
     * append) and drop the explicit seam. A correct harness must observe that its interception is
     * gone. If this returns `intercepted: true`, the detector itself is broken.
     */
    demonstrateBypass: () => {
      const hostile = { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' };
      delete hostile.RUVNET_GH_COMMAND;
      delete hostile.RUVNET_GH_SCRIPT;
      const probe = run('gh', [PROBE_ARG], { env: hostile });
      return {
        technique: 'PATH reassignment (the scripts/nightly-gists.sh pattern) plus removal of RUVNET_GH_COMMAND/RUVNET_GH_SCRIPT',
        intercepted: readProbe(probe),
        resolvedGh: String(run('sh', ['-c', 'command -v gh'], { env: hostile }).stdout || '').trim() || null,
        exit: probe.status ?? null,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Disposable checkout
// ---------------------------------------------------------------------------------------------

/**
 * A real, self-contained git checkout of the current HEAD in a throwaway directory, with the two
 * installed dependency trees symlinked in (never copied, never mutated). It is a real repository so
 * every `git rev-parse HEAD` in the pipeline resolves to THIS checkout, and so the rehearsal's
 * builderSha is genuinely its own source identity rather than a borrowed one.
 */
export function createDisposableCheckout({ sourceRoot, targetRoot }) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  fs.mkdirSync(target, { recursive: true });
  const archive = path.join(path.dirname(target), 'checkout.tar');
  runOrFail('git archive of the source checkout', 'git', ['archive', '--format=tar', '-o', archive, 'HEAD'], { cwd: source });
  runOrFail('tar extract into the disposable checkout', 'tar', ['-xf', archive, '-C', target]);
  fs.rmSync(archive, { force: true });
  for (const relative of ['node_modules', path.join('kb', 'node_modules')]) {
    const from = path.join(source, relative);
    if (!fs.existsSync(from)) fail(`dependency tree missing in the source checkout (${from}); run npm ci there first`);
    fs.mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
    fs.symlinkSync(from, path.join(target, relative));
  }
  runOrFail('git init in the disposable checkout', 'git', ['init', '-q'], { cwd: target });
  runOrFail('git add in the disposable checkout', 'git', ['add', '-A'], { cwd: target });
  runOrFail('git commit in the disposable checkout', 'git', [
    '-c', 'user.email=rehearsal@localhost', '-c', 'user.name=corpus rehearsal',
    'commit', '-q', '-m', 'disposable rehearsal checkout',
  ], { cwd: target });
  const head = String(runOrFail('git rev-parse in the disposable checkout', 'git', ['rev-parse', 'HEAD'], { cwd: target }).stdout).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) fail('disposable checkout produced no usable HEAD');
  return { root: target, head, sourceHead: snapshotRepoState(source).head };
}

// ---------------------------------------------------------------------------------------------
// Seed acquisition — real, or an explicit SKIP. Never a silent substitute.
// ---------------------------------------------------------------------------------------------

/**
 * Acquire the exact bytes `data/corpus-seed.json` pins. Network first (the way corpus-seed.yml
 * does it, `gh release download`); an offline fall-back is accepted ONLY when the local file's
 * sha256 AND byte length equal the pinned descriptor exactly — that is the same identity contract,
 * not a substitute. Anything else is reported as UNAVAILABLE and the caller SKIPs, loudly.
 */
export function acquireSeed({ descriptor, repo, downloadDir, env, localCandidates = [] }) {
  const attempts = [];
  fs.mkdirSync(downloadDir, { recursive: true });
  const target = path.join(downloadDir, descriptor.asset || 'ruvnet-brain.zip');

  const network = run('gh', ['release', 'download', descriptor.tag, '--repo', repo,
    '--pattern', descriptor.asset || 'ruvnet-brain.zip', '--dir', downloadDir], { env });
  if (!network.error && network.status === 0 && fs.existsSync(target)) {
    attempts.push({ channel: 'network', outcome: 'downloaded' });
    const sha256 = sha256File(target);
    if (sha256 === descriptor.sha256 && fs.statSync(target).size === descriptor.bytes) {
      return { ok: true, channel: 'network', file: target, sha256, bytes: fs.statSync(target).size, attempts };
    }
    attempts.push({ channel: 'network', outcome: 'digest-mismatch', sha256 });
    fs.rmSync(target, { force: true });
  } else {
    attempts.push({ channel: 'network', outcome: 'unavailable',
      detail: String(network.error?.message || network.stderr || `exit ${network.status}`).trim().slice(0, 300) });
  }

  for (const candidate of localCandidates.filter(Boolean)) {
    const file = path.resolve(candidate);
    if (!fs.existsSync(file)) { attempts.push({ channel: 'local', file, outcome: 'absent' }); continue; }
    const bytes = fs.statSync(file).size;
    if (bytes !== descriptor.bytes) { attempts.push({ channel: 'local', file, outcome: 'byte-length-mismatch', bytes }); continue; }
    const sha256 = sha256File(file);
    if (sha256 !== descriptor.sha256) { attempts.push({ channel: 'local', file, outcome: 'digest-mismatch', sha256 }); continue; }
    fs.copyFileSync(file, target);
    attempts.push({ channel: 'local', file, outcome: 'digest-verified' });
    return { ok: true, channel: 'local-cache-digest-verified', file: target, sha256, bytes, attempts };
  }
  return { ok: false, attempts,
    reason: 'the pinned bootstrap seed asset could not be downloaded and no local copy matched the pinned sha256/bytes exactly' };
}

// ---------------------------------------------------------------------------------------------
// Bounded observation
// ---------------------------------------------------------------------------------------------

/**
 * The ONE deliberate reduction in this rehearsal: the live source universe is observed for real
 * (`observeSourceUniverse`, real `gh`) and then RESTRICTED to `repos` repositories and `gists`
 * gists before being re-sealed through the production `canonicalSourceObservation`. Everything
 * downstream — planning, cloning, embedding, indexing, pruning, aggregation, assembly, sealing —
 * is the production code path over that smaller universe.
 */
export function boundObservation({ observation, api, repoStores, gistCount }) {
  const chosen = repoStores.length
    ? observation.repositories.rows.filter((row) => repoStores.includes(String(row.storeName || row.name).toLowerCase()))
    : [];
  const gistRows = observation.gists.rows.slice(0, gistCount);
  return api.canonicalSourceObservation({
    schemaVersion: observation.schemaVersion,
    kind: observation.kind,
    owner: observation.owner,
    observedAt: observation.observedAt,
    repositories: { rows: chosen, expected: chosen.length },
    gists: { rows: gistRows, expected: gistRows.length },
  });
}

/** Deterministically pick the `count` smallest ELIGIBLE repositories, measured by the observation's
 * own diskUsage, so a rehearsal clones and embeds real upstream source in minutes. Eligibility is
 * decided by the production classifier (`buildCoverage`), never by a guess here. */
function selectBoundedRepoStores({ api, observation, assetsDir, count }) {
  const ordered = [...observation.repositories.rows]
    .sort((a, b) => (a.diskUsage ?? Number.MAX_SAFE_INTEGER) - (b.diskUsage ?? Number.MAX_SAFE_INTEGER)
      || String(a.name).localeCompare(String(b.name)));
  const eligible = [];
  for (let window = Math.max(count, 4); window <= ordered.length && eligible.length < count; window *= 2) {
    const slice = ordered.slice(0, window);
    const probe = api.canonicalSourceObservation({
      schemaVersion: observation.schemaVersion, kind: observation.kind, owner: observation.owner,
      observedAt: observation.observedAt,
      repositories: { rows: slice, expected: slice.length },
      gists: { rows: [], expected: 0 },
    });
    const coverage = api.buildCoverage({ owner: observation.owner, kbDir: assetsDir, policyDir: assetsDir, observation: probe });
    eligible.length = 0;
    for (const row of coverage.rows) {
      if (row.kind === 'repository' && isIngestibleDisposition(row.disposition)) eligible.push(String(row.artifact.store).toLowerCase());
      if (eligible.length >= count) break;
    }
  }
  if (eligible.length < count) {
    fail(`fewer than ${count} eligible repositories in the observed universe (found ${eligible.length})`);
  }
  return eligible.slice(0, count);
}

// ---------------------------------------------------------------------------------------------
// Extracted-byte verification with the originals REVOKED
// ---------------------------------------------------------------------------------------------

/**
 * Make the staging assets unreachable, then prove the produced archive stands entirely on its own:
 * the extracted bytes must reproduce ARCHIVE-MANIFEST.json exactly, the real
 * `corpus-candidate.mjs --verify` must pass against them, and nothing inside the archive may quote
 * the staging path. This is the clause that catches an assembly which silently depends on the
 * checkout it was built in.
 */
export async function verifyExtractedBytesWithoutOriginals({
  checkoutRoot, assetsDir, bundleFile, receiptFile, verifyDir, tamper = 'none', extractZip,
}) {
  const revoked = `${assetsDir}.revoked`;
  fs.renameSync(assetsDir, revoked);
  fs.chmodSync(revoked, 0o000);
  const findings = { revokedDir: revoked, originalsReachable: null, tamper, files: 0, totalBytes: 0 };
  try {
    try { fs.readdirSync(revoked); findings.originalsReachable = true; }
    catch { findings.originalsReachable = false; }
    if (findings.originalsReachable) fail('staging assets are still reachable after revocation — the isolation this phase depends on did not hold');

    fs.mkdirSync(verifyDir, { recursive: true });
    await extractZip(bundleFile, verifyDir);

    const manifestFile = (function locate(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { const hit = locate(file); if (hit) return hit; }
        else if (entry.name === 'ARCHIVE-MANIFEST.json') return file;
      }
      return null;
    })(verifyDir);
    if (!manifestFile) fail('extracted archive carries no ARCHIVE-MANIFEST.json');
    const root = path.dirname(manifestFile);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

    if (tamper === 'extracted-byte') {
      const victim = fs.readdirSync(root).filter((name) => name.endsWith('.big.rvf')).sort()[0];
      if (!victim) fail('deliberate corruption requested but the extracted archive ships no .big.rvf');
      const file = path.join(root, victim);
      const fd = fs.openSync(file, 'r+');
      try {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, 64);
        byte[0] ^= 0xff;
        fs.writeSync(fd, byte, 0, 1, 64);
      } finally { fs.closeSync(fd); }
      findings.tamperedFile = victim;
    }

    // Independent recomputation from the extracted bytes — the manifest is a claim until it is
    // recomputed, and it is recomputed here from files the staging directory can no longer supply.
    const mismatches = [];
    for (const row of manifest.files || []) {
      const file = path.join(root, row.path);
      if (!fs.existsSync(file)) { mismatches.push(`${row.path}: absent from the extracted tree`); continue; }
      const sha256 = sha256File(file);
      const bytes = fs.statSync(file).size;
      if (sha256 !== row.sha256 || bytes !== row.bytes) {
        mismatches.push(`${row.path}: extracted bytes sha256=${sha256} bytes=${bytes} differ from ARCHIVE-MANIFEST sha256=${row.sha256} bytes=${row.bytes}`);
      }
      findings.files += 1;
      findings.totalBytes += bytes;
    }
    if (mismatches.length) fail(`extracted bytes do not reproduce ARCHIVE-MANIFEST.json:\n  ${mismatches.slice(0, 5).join('\n  ')}`);

    // No file inside the archive may quote the staging path: that would be a build that leaked its
    // own scratch directory into shipped bytes.
    const leaks = [];
    for (const row of manifest.files || []) {
      if (!/\.(json|jsonl|md|txt|mjs|js)$/.test(row.path)) continue;
      const text = fs.readFileSync(path.join(root, row.path), 'utf8');
      if (text.includes(revoked) || text.includes(assetsDir)) leaks.push(row.path);
    }
    findings.stagingPathLeaks = leaks.length;
    if (leaks.length) fail(`shipped files quote the revoked staging directory: ${leaks.slice(0, 5).join(', ')}`);

    const verified = run(process.execPath, [path.join(checkoutRoot, 'scripts', 'corpus-candidate.mjs'),
      '--verify', '--bundle', bundleFile, '--receipt', receiptFile], { cwd: checkoutRoot });
    findings.corpusCandidateVerify = { exit: verified.status ?? null,
      stderr: String(verified.stderr || '').trim().slice(0, 400) };
    if (verified.error || verified.status !== 0) {
      fail(`corpus-candidate.mjs --verify rejected the sealed archive with its originals revoked (${findings.corpusCandidateVerify.stderr || `exit ${verified.status}`})`);
    }
    return findings;
  } finally {
    try { fs.chmodSync(revoked, 0o700); } catch { /* best effort; the temp root is removed anyway */ }
  }
}

// ---------------------------------------------------------------------------------------------
// One generation: import seed N, reconcile bounded, assemble once, verify extracted bytes,
// rehearse publication with the recorder, and emit candidate N as the seed for generation N+1.
// ---------------------------------------------------------------------------------------------

async function runGeneration({ index, api, checkoutRoot, workRoot, seed, bounds, recorder, tamper, log }) {
  const generation = { index, startedAt: new Date().toISOString(), seed: { tag: seed.tag, sha256: seed.sha256, bytes: seed.bytes, channel: seed.channel } };
  const assetsDir = path.join(workRoot, `assets-gen${index}`);
  const workspaceDir = path.join(workRoot, `clones-gen${index}`);
  const candidateDir = path.join(workRoot, `candidate-gen${index}`, 'ruvnet-brain');
  const receiptFile = path.join(workRoot, `candidate-gen${index}`, 'corpus-receipt.json');
  const verifyDir = path.join(workRoot, `extract-gen${index}`);

  // --- real seed import, exactly as scripts/corpus-reconcile.mjs main() does it ---------------
  log(`[gen ${index}] importing seed ${seed.tag} (${seed.bytes} bytes, ${seed.channel})`);
  const bootstrap = api.assertBootstrapIdentity({
    archiveFile: seed.file, tag: seed.tag, sha256: seed.sha256, allowPinnedTag: seed.allowPinnedTag === true,
  });
  const extractParent = fs.mkdtempSync(path.join(workRoot, `.seed-extract-gen${index}-`));
  await api.extractZip(seed.file, extractParent);
  api.normalizeExtractedCorpus({ extractedDir: extractParent, assetsDir });
  const fence = path.join(checkoutRoot, 'kb', 'PRIVATE-STORES.json');
  if (!fs.existsSync(fence)) fail(`canonical private-store fence missing (${fence})`);
  fs.copyFileSync(fence, path.join(assetsDir, 'PRIVATE-STORES.json'), fs.constants.COPYFILE_EXCL);
  fs.rmSync(extractParent, { recursive: true, force: true });
  api.syncCorpusInputs({ root: checkoutRoot, assetsDir });
  const bootstrapIdentity = { tag: bootstrap.tag, sha256: bootstrap.sha256,
    privateFenceEvidence: api.seedPrivateFenceEvidence(assetsDir) };
  generation.seedImport = { assetsDir, storesInSeed: Object.keys(
    JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8')).stores || {}).length };
  log(`[gen ${index}] seed imported: ${generation.seedImport.storesInSeed} stores in the ledger`);

  // --- bounded observation over the REAL live source universe ---------------------------------
  const externalFile = path.join(assetsDir, 'external-sources.json');
  const externalSources = fs.existsSync(externalFile)
    ? JSON.parse(fs.readFileSync(externalFile, 'utf8')).sources || [] : [];
  const observeFull = () => api.observeSourceUniverse({ owner: bounds.owner, externalSources });
  log(`[gen ${index}] observing the live source universe (real gh)`);
  const full = observeFull();
  const repoStores = selectBoundedRepoStores({ api, observation: full, assetsDir, count: bounds.repos });
  generation.bounded = { repositories: repoStores, gists: bounds.gists,
    observedUniverse: { repositories: full.repositories.rows.length, gists: full.gists.rows.length } };
  log(`[gen ${index}] bounded to repositories [${repoStores.join(', ')}] + ${bounds.gists} gist(s) out of ${full.repositories.rows.length} repos / ${full.gists.rows.length} gists`);

  // Force genuine source acquisition + embedding + indexing for the bounded stores: drop their
  // seed RVF bytes so planReconciliation must rebuild them from upstream. Without this a seed whose
  // stores are already CURRENT would exercise no acquisition at all, and the rehearsal would prove
  // nothing about the expensive half of the pipeline.
  if (bounds.forceRebuild) {
    for (const store of repoStores) fs.rmSync(path.join(assetsDir, `${store}.big.rvf`), { force: true });
    generation.forcedRebuild = repoStores;
  }

  const boundedObserve = () => boundObservation({ observation: observeFull(), api, repoStores, gistCount: bounds.gists });

  // --- reconcile + assemble ONCE --------------------------------------------------------------
  const invocations = [];
  const recordingRun = (command, args, options = {}) => {
    invocations.push({ command, script: path.basename(String(args?.[0] || '')), args: args.map(String) });
    return spawnSync(command, args, { encoding: 'utf8', ...options });
  };
  const reconcileStart = Date.now();
  const { reconciliation, candidate } = await api.reconcileAndPrepareCorpusCandidate({
    assetsDir, workspaceDir, root: checkoutRoot, owner: bounds.owner, builderSha: bounds.builderSha,
    candidateDir, receiptFile, coverageFile: path.join(checkoutRoot, 'data', 'source-coverage.json'),
    bootstrapIdentity, maxAttempts: bounds.maxRounds,
    reconcile: (options) => api.acquireCorpusGeneration({ ...options, observe: boundedObserve }),
    prepare: (options) => api.prepareCorpusCandidate({ ...options, run: recordingRun }),
  });
  generation.reconciliation = {
    rounds: reconciliation.attempts.length,
    observationSha256: reconciliation.observation.observationSha256,
    refreshed: reconciliation.attempts.flatMap((round) => round.refreshed || []),
    pruned: reconciliation.attempts.flatMap((round) => round.pruned || []).length,
    rebuilt: reconciliation.attempts.flatMap((round) => round.rebuilt || []),
    durationMs: Date.now() - reconcileStart,
  };
  const assemblyInvocations = invocations.filter((row) => row.script === 'build-bundle.mjs');
  generation.assembly = {
    assembleBundleInvocations: assemblyInvocations.length,
    receiptInvocations: invocations.filter((row) => row.script === 'corpus-candidate.mjs').length,
    bundleFile: candidate.bundleFile,
  };
  if (assemblyInvocations.length !== 1) {
    fail(`assembly must happen exactly once per candidate; build-bundle.mjs ran ${assemblyInvocations.length} time(s)`);
  }
  const bundleFile = candidate.bundleFile;
  // An exit code of 0 is not evidence that a file was written. prepareCorpusCandidate's `checked()`
  // inspects only the child's status, so a CLI that silently no-ops (see the realpath note on
  // workRoot) passes every gate above while producing nothing. Name that possibility here rather
  // than surfacing it as a bare ENOENT three lines later.
  for (const [label, file] of [['candidate archive', bundleFile], ['candidate receipt', candidate.receiptFile]]) {
    if (!fs.existsSync(file)) {
      fail(`assembly reported success but produced no ${label} (${file}). The child processes exited 0 without writing — `
        + 'check that scripts/build-bundle.mjs and scripts/corpus-candidate.mjs actually entered their CLI blocks '
        + '(their `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` guard is false under a symlinked path).');
    }
  }
  const archiveSha256 = sha256File(bundleFile);
  const archiveBytes = fs.statSync(bundleFile).size;
  generation.candidate = { bundleFile, sha256: archiveSha256, bytes: archiveBytes,
    receiptFile: candidate.receiptFile, receiptSha256: sha256File(candidate.receiptFile) };
  const receipt = JSON.parse(fs.readFileSync(candidate.receiptFile, 'utf8'));
  generation.candidate.storeCount = receipt.storeCount;
  generation.candidate.stores = receipt.stores.map(({ name, kind }) => ({ name, kind }));
  log(`[gen ${index}] sealed candidate ${archiveSha256.slice(0, 16)} — ${receipt.storeCount} stores, ${archiveBytes} bytes`);

  // --- remove access to the originals, then verify the extracted bytes ------------------------
  generation.extractedByteVerification = await verifyExtractedBytesWithoutOriginals({
    checkoutRoot, assetsDir, bundleFile, receiptFile: candidate.receiptFile, verifyDir,
    tamper: index === bounds.tamperGeneration ? tamper : 'none', extractZip: api.extractZip,
  });
  log(`[gen ${index}] extracted-byte verification passed with staging revoked (${generation.extractedByteVerification.files} files)`);

  // --- rehearse the real product-consumption path, publication RECORDED not executed -----------
  const corpusTag = `corpus-sha256-${archiveSha256}`;
  const proof = recorder.proveIntercepting();
  if (!proof.ok) {
    generation.publication = { status: 'FAIL', reason: 'command interception could not be proven; refusing to run a publication path that might reach the network', proof };
    fail('command interception could not be proven before the publication rehearsal — failing closed');
  }
  const publishEnv = {
    ...process.env,
    ...recorder.env,
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: 'protected-release',
    GITHUB_REPOSITORY: 'stuinfla/ruvnet-brain',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_PROTECTED: 'true',
    GITHUB_SHA: bounds.builderSha,
    // Poisoned on purpose: even a leaked real `gh` cannot authenticate against the live repository.
    GH_TOKEN: 'rehearsal-invalid-token-do-not-use',
    GITHUB_TOKEN: 'rehearsal-invalid-token-do-not-use',
  };
  const publish = run(process.execPath, [path.join(checkoutRoot, 'scripts', 'release.mjs'), '--corpus-seed',
    '--corpus-tag', corpusTag, '--corpus-bundle', bundleFile, '--corpus-receipt', candidate.receiptFile,
    '--target', bounds.builderSha, '--repo', 'stuinfla/ruvnet-brain'], { cwd: checkoutRoot, env: publishEnv });
  const recordedNow = recorder.recorded().filter((row) => row.classification === 'publication-mutation');
  generation.publication = {
    status: publish.status === 0 ? 'PASS' : 'FAIL',
    entrypoint: 'scripts/release.mjs --corpus-seed',
    corpusTag,
    exit: publish.status ?? null,
    stdout: String(publish.stdout || '').trim().slice(0, 800),
    stderr: String(publish.stderr || '').trim().slice(0, 800),
    interceptionProof: proof.channels,
    recordedMutations: recordedNow.map((row) => `${row.tool} ${row.args.join(' ')}`.slice(0, 400)),
    executedMutations: recordedNow.filter((row) => row.executed).length,
  };
  if (publish.status !== 0) fail(`the product-consumption path (release.mjs --corpus-seed) failed: ${generation.publication.stderr || `exit ${publish.status}`}`);
  if (generation.publication.executedMutations !== 0) fail('a publication mutation was EXECUTED rather than recorded — the hard fence was crossed');
  if (!recordedNow.some((row) => row.args[0] === 'release' && row.args[1] === 'create')) {
    fail('the publication rehearsal recorded no `gh release create` — the recorder captured nothing, so nothing is proven');
  }
  log(`[gen ${index}] publication path rehearsed: ${recordedNow.length} mutation(s) RECORDED, 0 executed`);

  // --- candidate N becomes seed N+1 -----------------------------------------------------------
  // The file NAME is part of the sealed identity (`archive.file` inside the schema-2 receipt), so
  // candidate N must be handed to generation N+1 under its own basename, in its own directory.
  const nextSeedFile = path.join(workRoot, `seed-gen${index + 1}`, path.basename(bundleFile));
  fs.mkdirSync(path.dirname(nextSeedFile), { recursive: true });
  fs.copyFileSync(bundleFile, nextSeedFile);
  generation.nextSeed = { tag: corpusTag, sha256: archiveSha256, bytes: archiveBytes, file: nextSeedFile,
    contentAddressed: true };
  generation.finishedAt = new Date().toISOString();
  return {
    generation,
    nextSeed: { file: nextSeedFile, tag: corpusTag, sha256: archiveSha256, bytes: archiveBytes,
      channel: `candidate-generation-${index}`, allowPinnedTag: false, receiptFile: candidate.receiptFile },
  };
}

// ---------------------------------------------------------------------------------------------
// The rehearsal
// ---------------------------------------------------------------------------------------------

export async function rehearseCorpusPipeline({
  sourceRoot = REAL_ROOT,
  repos = 2,
  gists = 3,
  generations = 2,
  maxRounds = 3,
  owner = 'ruvnet',
  tamper = 'none',
  tamperGeneration = 1,
  forceRebuild = true,
  seedOverride = null,
  keep = false,
  workRootParent = null,
  installedBrainDir = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb'),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (!TAMPER_MODES.has(tamper)) fail(`unknown --tamper mode ${tamper} (expected: ${[...TAMPER_MODES].join(', ')})`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const receipt = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-corpus-rehearsal-receipt',
    banner: BANNER,
    startedAt,
    host: { node: process.version, platform: `${process.platform}/${process.arch}` },
    bounds: { repos, gists, generations, maxRounds, owner, forceRebuild, tamper, tamperGeneration },
    phases: [],
    generations: [],
    verdict: 'FAIL',
  };
  const phase = (name, status, detail = {}) => {
    receipt.phases.push({ phase: name, status, ...detail });
    log(`[${status}] ${name}${detail.reason ? ` — ${detail.reason}` : ''}`);
    return status;
  };

  // REALPATH, deliberately. On macOS `os.tmpdir()` is `/var/folders/...`, a symlink to
  // `/private/var/folders/...`. Node's module resolver realpaths `import.meta.url` but leaves
  // `process.argv[1]` as typed, so the repo's standard CLI guard
  // (`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`) is FALSE for every script
  // invoked through a symlinked path — and those CLIs then exit 0 having done nothing at all.
  // MEASURED here on 2026-09-14: build-bundle.mjs and corpus-candidate.mjs both silently no-opped
  // under `/var/folders/...` and prepareCorpusCandidate reported success with no archive and no
  // receipt on disk. Rehearsing under the real path removes that variable from the rehearsal; the
  // defect itself is reported, not patched here (those files belong to other work).
  const workRoot = fs.mkdtempSync(path.join(
    fs.realpathSync(path.resolve(workRootParent || os.tmpdir())), 'corpus-rehearsal-'));
  const checkoutRoot = path.join(workRoot, 'checkout');
  let recorder = null;
  let restoreProcessEnv = null;
  try {
    // ---- phase 1: isolation baseline ---------------------------------------------------------
    const beforeRepo = snapshotRepoState(sourceRoot);
    const beforeBrain = inventoryTree(installedBrainDir);
    receipt.isolation = { sourceRoot: path.resolve(sourceRoot), installedBrainDir, before: {
      repo: beforeRepo.digest, installedBrain: beforeBrain.digest, installedBrainEntries: beforeBrain.entries } };
    phase('isolation-baseline', 'PASS', { repoHead: beforeRepo.head, installedBrainEntries: beforeBrain.entries });

    // ---- phase 2: disposable checkout --------------------------------------------------------
    const checkout = createDisposableCheckout({ sourceRoot, targetRoot: checkoutRoot });
    receipt.disposableCheckout = { root: checkout.root, head: checkout.head, sourceHead: checkout.sourceHead,
      materializedFrom: 'git archive HEAD — the COMMITTED tree only; uncommitted working-tree changes are NOT rehearsed' };
    phase('disposable-checkout', 'PASS', { root: checkout.root, head: checkout.head, sourceHead: checkout.sourceHead });

    // ---- phase 3: command recorder, proven before anything trusts it -------------------------
    recorder = installCommandRecorder({ dir: path.join(workRoot, 'stub-bin') });
    // Cover THIS process too, not only the children it spawns. observeSourceUniverse and
    // gist-receipts shell out to `gh` from inside the rehearsal's own process; leaving those on the
    // real binary would mean the fence covered the publication path alone. With the recorder on
    // this process's PATH and explicit seam, EVERY `gh` — in-process or spawned, at any depth —
    // resolves to it: reads pass through, mutations are recorded and refused. MEASURED before this
    // change: a passing rehearsal's ledger showed a single passthrough-read, because every
    // observation call had gone straight to /opt/homebrew/bin/gh.
    restoreProcessEnv = Object.fromEntries(Object.keys(recorder.env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, recorder.env);
    const proof = recorder.proveIntercepting();
    receipt.commandRecorder = { stubDir: recorder.stubDir, recordFile: recorder.recordFile, proof: proof.channels,
      scope: 'this process and every descendant — the PATH shim and the RUVNET_GH_COMMAND/RUVNET_GH_SCRIPT seam are both set on process.env' };
    if (!proof.ok) {
      phase('command-recorder-interception', 'FAIL', { reason: 'interception could not be proven', proof: proof.channels });
      fail('command interception could not be proven — refusing to run a pipeline that can publish');
    }
    phase('command-recorder-interception', 'PASS', { channels: proof.channels });

    if (tamper === 'bypass-interception') {
      const bypass = recorder.demonstrateBypass();
      receipt.commandRecorder.bypassDemonstration = bypass;
      if (bypass.intercepted) {
        phase('deliberate-bypass-detection', 'FAIL', { reason: 'the harness did NOT notice its interception was bypassed', bypass });
        fail('deliberate bypass was not detected — the recorder cannot prove its own integrity');
      }
      phase('deliberate-bypass-detection', 'PASS', {
        reason: `interception correctly detected as ABSENT under ${bypass.technique}`, bypass });
      fail(`interception bypass demonstrated (--tamper bypass-interception): PATH reassignment defeated the shim and the harness failed closed rather than proceeding; real gh would have been ${bypass.resolvedGh}`);
    }

    // ---- phase 4: load the disposable checkout's own modules ---------------------------------
    const load = (relative) => import(pathToFileURL(path.join(checkoutRoot, relative)).href);
    const [reconcileMod, coverageMod, candidateMod, zipMod] = await Promise.all([
      load('scripts/corpus-reconcile.mjs'), load('scripts/source-coverage.mjs'),
      load('scripts/corpus-candidate.mjs'), load('kb/zip-extract.mjs'),
    ]);
    const api = {
      assertBootstrapIdentity: reconcileMod.assertBootstrapIdentity,
      normalizeExtractedCorpus: reconcileMod.normalizeExtractedCorpus,
      seedPrivateFenceEvidence: reconcileMod.seedPrivateFenceEvidence,
      syncCorpusInputs: reconcileMod.syncCorpusInputs,
      acquireCorpusGeneration: reconcileMod.acquireCorpusGeneration,
      reconcileAndPrepareCorpusCandidate: reconcileMod.reconcileAndPrepareCorpusCandidate,
      prepareCorpusCandidate: reconcileMod.prepareCorpusCandidate,
      observeSourceUniverse: coverageMod.observeSourceUniverse,
      canonicalSourceObservation: coverageMod.canonicalSourceObservation,
      buildCoverage: coverageMod.buildCoverage,
      verifySeedBaseline: candidateMod.verifySeedBaseline,
      extractZip: zipMod.extractZip,
    };
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== 'function') fail(`the disposable checkout does not export ${name}`);
    }
    phase('load-pipeline-entrypoints', 'PASS', { entrypoints: Object.keys(api).length });

    // ---- phase 5: real seed acquisition (or an explicit SKIP) --------------------------------
    const descriptor = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'data', 'corpus-seed.json'), 'utf8'));
    if (!HEX64.test(String(descriptor.sha256 || ''))) fail('data/corpus-seed.json does not pin a usable sha256');
    const repoSlug = (String(run('git', ['remote', 'get-url', 'origin'], { cwd: sourceRoot }).stdout || '')
      .trim().match(/github\.com[:/]+([^/]+\/[^/.]+)/) || [])[1] || 'stuinfla/ruvnet-brain';
    const acquisition = acquireSeed({
      descriptor, repo: repoSlug, downloadDir: path.join(workRoot, 'seed-download'),
      env: { ...process.env, ...recorder.env },
      localCandidates: [seedOverride, process.env.RUVNET_REHEARSAL_SEED,
        path.join(os.homedir(), 'RVF-KnowledgeBases', 'corpus-20260912', 'seed', 'ruvnet-brain.zip')],
    });
    receipt.seedAcquisition = { descriptor, repository: repoSlug, ...acquisition };
    if (!acquisition.ok) {
      phase('real-seed-import', 'SKIP', { reason: acquisition.reason, attempts: acquisition.attempts });
      receipt.verdict = 'FAIL';
      receipt.skipped = 'real seed import unavailable; every downstream phase depends on it';
      return { receipt, workRoot };
    }
    phase('real-seed-import', 'PASS', { channel: acquisition.channel, sha256: acquisition.sha256, bytes: acquisition.bytes,
      reason: acquisition.channel === 'network' ? undefined
        : 'the pinned release asset was unreachable; a local copy whose sha256 AND byte length equal the pinned descriptor exactly was used — same identity contract, not a substitute' });

    // ---- phase 6..N: the generations ---------------------------------------------------------
    let seed = { file: acquisition.file, tag: descriptor.tag, sha256: descriptor.sha256, bytes: descriptor.bytes,
      channel: acquisition.channel, allowPinnedTag: true };
    for (let index = 1; index <= generations; index += 1) {
      if (index > 1) {
        // Import candidate N as seed N+1 through the SAME baseline verifier the future consumer
        // uses — the content-addressed tag, the archive bytes, and the schema-2 receipt together.
        const baseline = await api.verifySeedBaseline({
          seedDescriptor: { tag: seed.tag, sha256: seed.sha256, bytes: seed.bytes },
          bundleFile: seed.file, receiptFile: seed.receiptFile,
        });
        phase(`generation-${index}-seed-baseline`, 'PASS', {
          tag: baseline.tag, sha256: baseline.sha256, stores: baseline.receipt.storeCount,
          reason: `candidate from generation ${index - 1} accepted as the generation ${index} seed — the chain closes` });
      }
      const result = await runGeneration({
        index, api, checkoutRoot, workRoot, seed, recorder, tamper, log,
        bounds: { repos, gists, owner, maxRounds, builderSha: checkout.head, forceRebuild, tamperGeneration },
      });
      receipt.generations.push(result.generation);
      phase(`generation-${index}`, 'PASS', {
        candidateSha256: result.generation.candidate.sha256,
        stores: result.generation.candidate.storeCount,
        durationMs: result.generation.reconciliation.durationMs });
      seed = result.nextSeed;
    }

    // ---- final phase: isolation re-assertion --------------------------------------------------
    const afterRepo = snapshotRepoState(sourceRoot);
    const afterBrain = inventoryTree(installedBrainDir);
    receipt.isolation.after = { repo: afterRepo.digest, installedBrain: afterBrain.digest, installedBrainEntries: afterBrain.entries };
    receipt.isolation.workingTreeUnchanged = afterRepo.digest === beforeRepo.digest;
    receipt.isolation.installedBrainUnchanged = afterBrain.digest === beforeBrain.digest;
    if (!receipt.isolation.workingTreeUnchanged || !receipt.isolation.installedBrainUnchanged) {
      // Strict by design — any difference is reported, including one a human made in another
      // window while the rehearsal ran. So name the exact lines that moved: a bare boolean would
      // make an unrelated concurrent edit indistinguishable from a pipeline that wrote outside its
      // sandbox, and the whole point of this phase is to tell those two apart.
      const before = new Set(beforeRepo.porcelain.split('\n'));
      const after = new Set(afterRepo.porcelain.split('\n'));
      receipt.isolation.workingTreeDelta = {
        headBefore: beforeRepo.head, headAfter: afterRepo.head,
        appeared: [...after].filter((line) => line && !before.has(line)),
        disappeared: [...before].filter((line) => line && !after.has(line)),
      };
      phase('isolation-unchanged', 'FAIL', { reason: 'the real working tree or the installed brain changed during the rehearsal',
        workingTreeUnchanged: receipt.isolation.workingTreeUnchanged,
        installedBrainUnchanged: receipt.isolation.installedBrainUnchanged,
        workingTreeDelta: receipt.isolation.workingTreeDelta });
      fail('the real working tree or the installed brain changed during the rehearsal');
    }
    phase('isolation-unchanged', 'PASS', { workingTree: 'byte-unchanged', installedBrain: 'byte-unchanged' });

    receipt.recordedPublicationCommands = recorder.recorded()
      .filter((row) => row.classification === 'publication-mutation')
      .map((row) => ({ tool: row.tool, command: row.args.join(' '), executed: row.executed, at: row.at }));
    receipt.commandLedger = recorder.recorded().reduce((totals, row) => {
      totals[row.classification] = (totals[row.classification] || 0) + 1;
      return totals;
    }, {});
    receipt.verdict = receipt.phases.some(({ status }) => status === 'FAIL') ? 'FAIL' : 'PASS';
    return { receipt, workRoot };
  } catch (error) {
    receipt.error = String(error?.message || error);
    receipt.verdict = 'FAIL';
    if (recorder) {
      receipt.recordedPublicationCommands = recorder.recorded()
        .filter((row) => row.classification === 'publication-mutation')
        .map((row) => ({ tool: row.tool, command: row.args.join(' '), executed: row.executed, at: row.at }));
    }
    if (!receipt.phases.some(({ status }) => status === 'FAIL')) {
      receipt.phases.push({ phase: 'rehearsal', status: 'FAIL', reason: receipt.error });
    }
    return { receipt, workRoot };
  } finally {
    if (restoreProcessEnv) {
      for (const [key, value] of Object.entries(restoreProcessEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    receipt.finishedAt = new Date().toISOString();
    receipt.durationMs = Date.now() - started;
    receipt.workRoot = workRoot;
    receipt.workRootRetained = keep;
    if (!keep) {
      try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch { /* temp dir */ }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function arg(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}

export async function main(argv = process.argv.slice(2)) {
  const receiptOut = arg(argv, '--receipt', null);
  const { receipt } = await rehearseCorpusPipeline({
    repos: Number(arg(argv, '--repos', 2)),
    gists: Number(arg(argv, '--gists', 3)),
    generations: Number(arg(argv, '--generations', 2)),
    maxRounds: Number(arg(argv, '--max-rounds', 3)),
    owner: arg(argv, '--owner', 'ruvnet'),
    tamper: arg(argv, '--tamper', 'none'),
    tamperGeneration: Number(arg(argv, '--tamper-generation', 1)),
    forceRebuild: !argv.includes('--no-force-rebuild'),
    seedOverride: arg(argv, '--seed', null),
    keep: argv.includes('--keep'),
    workRootParent: arg(argv, '--work-root', null),
  });
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (receiptOut) {
    fs.mkdirSync(path.dirname(path.resolve(receiptOut)), { recursive: true });
    fs.writeFileSync(path.resolve(receiptOut), text);
  }
  process.stdout.write(text);
  return receipt.verdict === 'PASS' ? 0 : 1;
}

if (((() => { try { return process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })())) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
