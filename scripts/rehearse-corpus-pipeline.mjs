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
// WHAT IS BOUNDED, AND SAID OUT LOUD: `--repos N` (default 2) and `--gists M` (default 3). The C3
// diagnostic measures the same deterministic question sample corpus-seed.yml passes
// (`--accuracy-sample`, default C3_DIAGNOSTIC_SAMPLE_QUESTIONS; `--accuracy-sample full` for the
// whole oracle, which is ~1,164 queries against the full seed and runs well over an hour). A
// rehearsal receipt ALWAYS carries `bounds` and the banner below so nobody can mistake a 2-store
// rehearsal for a 194-store corpus build. Two further declared bounds keep the unsampled seed stores
// from being pruned (which would fail the repo-recall gate for every one of them, ADR-0091 V1): seed
// stores with a ledger sourceCommit stay in the observation FROZEN at that commit (not rebuilt, not
// pruned), and the repo-recall fixture in the disposable checkout is scoped to the repositories the
// candidate carries (seed stores with no sourceCommit cannot be frozen and are out of scope). Both are
// counted in the receipt. Everything else is the production code path.
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
//        [--accuracy-sample <n>|full] [--receipt <file>] [--seed <local ruvnet-brain.zip>] [--keep] [--tamper <mode>]
//        [--no-seed-selection] [--no-code-release-between] [--no-code-release-consumption]
//        [--inject-store-failure transient|qa] [--inject-generation <n>] [--recall-fixture scoped|committed]
//
// ADR-0091 D7: `--recall-fixture committed` keeps the COMMITTED 182-question fixture unedited instead of
// scoping it. The fixture repositories the bounded observation drops then have no row in a complete
// sealed observation, so the production repo-recall gate RETIRES them (D7.2) -- the rehearsal asserts it
// retired exactly those and asked the rest, and every reader re-verifies the claim from coverage (D7.3).
// Every candidate's manifest.json `corpus` block (D7.1) is checked against its sealed coverage in both modes.
//
// ADR-0091 D4 (V4): from generation 2 on, the seed is chosen by the REAL scripts/corpus-next-seed.mjs
// resolver from a local registry holding generation N (exactly the files release.mjs tried to upload)
// and two newer INCOMPATIBLE decoys, after a simulated code release has moved the checkout's runtime
// version. Every candidate's runtime surface is then checked by the real verifyApprovedRuntime against
// a pin traced to the checkout's own bytes. See scripts/rehearse-seed-selection.mjs.
//
// Done is an exit code, not an opinion: FAIL exits non-zero. A phase that could not run is a SKIP
// with a stated reason, never a silent pass.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAL_ROOT = path.resolve(HERE, '..');
const BANNER = 'BOUNDED REHEARSAL — a small explicitly-bounded subset, NOT a full corpus build';
const HEX64 = /^[a-f0-9]{64}$/;
const TAMPER_MODES = new Set(['none', 'extracted-byte', 'archive-byte', 'bypass-interception']);
// ADR-0091 D5 (V5): inject ONE store failure into a real reconciliation. `transient` fails the target's
// first `git clone` (it must be retried once, in a fresh worker directory, and recover); `qa` answers the
// target's forge-refresh with corpus-qa's refusal status without running it (it must NOT be retried, and
// the store must be carried at its re-hashed seed bytes as STALE + carry). Both are synthetic, declared
// in the receipt, and applied at the process-runner seam executeReconciliation already exposes.
const INJECTION_MODES = new Set(['none', 'transient', 'qa']);
const RECALL_FIXTURE_MODES = new Set(['scoped', 'committed']);
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
export function boundObservation({ observation, api, repoStores, gistCount, frozenSourceCommits = null }) {
  const storeOf = (row) => String(row.storeName || row.name).toLowerCase();
  const sampled = repoStores.length
    ? observation.repositories.rows.filter((row) => repoStores.includes(storeOf(row)))
    : [];
  // FROZEN AT SEED (2026-09-28, ADR-0091 V1). Observing ONLY the sampled repositories makes every
  // other seed store "not observed this round", and the production prune (correctly, for a real
  // nightly that always observes everything) deletes it -- after which the repo-recall gate, which
  // asks one frozen question of every fixture repository, fails 180/182 with `rvf not found`. So the
  // rehearsal keeps every OTHER repository the seed already carries in the observation, with its
  // head pinned to the seed's own ledger sourceCommit: planReconciliation sees it CURRENT (nothing to
  // rebuild) and pruneIneligibleStores sees it eligible (nothing to delete). Repositories the seed does
  // not carry are dropped, so a brand-new upstream repo can never turn a minutes-long rehearsal into a
  // full clone-and-embed. This rewrite is a declared rehearsal bound, recorded in the receipt; the
  // pipeline's own observation, planning and pruning code is untouched.
  const frozen = frozenSourceCommits
    ? observation.repositories.rows
      .filter((row) => !repoStores.includes(storeOf(row)) && frozenSourceCommits[storeOf(row)])
      .map((row) => ({
        ...row,
        defaultBranchRef: {
          name: row.defaultBranchRef?.name || 'main',
          target: { oid: frozenSourceCommits[storeOf(row)], committedDate: null },
        },
      }))
    : [];
  const chosen = [...sampled, ...frozen];
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

/** The seed ledger's own sourceCommit for every repository store OTHER than the sampled ones —
 * the commits boundObservation pins those stores to. Aggregates (ruv-gists, concepts) are rebuilt
 * from nothing every round and are never repository rows, so they are excluded. */
export function frozenSeedCommits(assetsDir, repoStores) {
  const ledger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
  const out = {};
  for (const [store, row] of Object.entries(ledger.stores || {})) {
    const folded = store.toLowerCase();
    if (['ruv-gists', 'concepts'].includes(folded) || repoStores.includes(folded)) continue;
    const sha = String(row?.sourceCommit || '').toLowerCase();
    if (/^[a-f0-9]{40}$/.test(sha)) out[folded] = sha;
  }
  return out;
}

/**
 * Scope the frozen repo-recall fixture to the repositories THIS bounded candidate carries (ADR-0091
 * V1). A seed store whose ledger sourceCommit is null (57 of 182 in the v4.3.26 seed) cannot be frozen
 * at a commit: the real nightly rebuilds it from upstream, which is hours, not minutes. Out of the
 * rehearsal's scope, it is pruned, and asking the fixture question of it could only report
 * `rvf not found`. Every in-scope question is kept byte for byte. Returns the scoped fixture document
 * plus exactly what was excluded, so the receipt says it out loud.
 */
export function scopeRecallFixture({ fixture, inScopeStores }) {
  const scope = new Set([...inScopeStores].map((store) => String(store).toLowerCase()));
  const kept = {};
  const excluded = [];
  for (const [store, row] of Object.entries(fixture.queries || {})) {
    if (scope.has(store.toLowerCase())) kept[store] = row;
    else excluded.push(store);
  }
  if (!Object.keys(kept).length) fail('scoping the repo-recall fixture left no questions; the bounded scope carries no fixture repository');
  return { fixture: { ...fixture, queries: kept }, kept: Object.keys(kept).length, excluded: excluded.sort() };
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
      if (row.kind === 'repository' && row.disposition === 'eligible') eligible.push(String(row.artifact.store).toLowerCase());
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

// The rehearsal's record of one generation's reconciliation. It never reads the acquisition history
// itself: it uses the disposable checkout's own summarizeReconciliation, the same reader main() uses
// (ADR-0091 D1). Its private copy of the old `rounds` read crashed exactly where main() did.
export function recordReconciliation({ summarize, reconciliation, durationMs }) {
  const summary = summarize(reconciliation);
  return {
    attempts: summary.attempts,
    observationSha256: summary.observationSha256,
    refreshed: summary.refreshed,
    pruned: summary.pruned.length,
    rebuilt: summary.rebuilt,
    durationMs,
  };
}

/**
 * ADR-0091 D7, read from the REAL sealed artifacts of one generation (never recomputed from inputs):
 *   D7.1 the assembled manifest.json `corpus` block names the sealed observation's observedAt (not the
 *        assembly time) and counts exactly the sealed coverage's eligible repository rows;
 *   D7.2 in `committed` mode the recall report retired EXACTLY the fixture repositories the bounded
 *        observation dropped, asked every other one, and bound the claim to the sealed coverage bytes.
 */
export function checkGenerationCurrency({ checkoutRoot, candidateDir, bundleFile, committedFixture, expectedRetired, expectedAsked }) {
  const coverageFile = path.join(checkoutRoot, 'data', 'source-coverage.json');
  const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  const corpus = JSON.parse(fs.readFileSync(path.join(candidateDir, 'manifest.json'), 'utf8')).corpus;
  const eligible = coverage.rows.filter((row) => row.kind === 'repository' && row.disposition === 'eligible');
  const count = (status) => eligible.filter((row) => row.status === status).length;
  const problems = [];
  if (!corpus || corpus.basis !== 'sealed-observation') problems.push(`manifest.corpus basis is ${corpus?.basis}`);
  if (corpus?.observedAt !== coverage.observedAt) problems.push(`manifest.corpus.observedAt ${corpus?.observedAt} is not the sealed observation's ${coverage.observedAt}`);
  const counts = corpus?.counts || {};
  for (const [key, status] of [['current', 'CURRENT'], ['stale', 'STALE'], ['missing', 'MISSING'], ['unverified', 'UNVERIFIED']]) {
    if (counts[key] !== count(status)) problems.push(`manifest.corpus.counts.${key}=${counts[key]}, sealed coverage has ${count(status)}`);
  }
  if (counts.eligible !== eligible.length) problems.push(`manifest.corpus.counts.eligible=${counts.eligible}, sealed coverage has ${eligible.length}`);
  const report = JSON.parse(fs.readFileSync(`${bundleFile}.recall.json`, 'utf8'));
  const want = [...new Set(expectedRetired.map((store) => store.toLowerCase()))].sort();
  const got = report.retirement?.stores ?? [];
  if (committedFixture) {
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`recall retired [${got.join(', ')}], expected exactly [${want.join(', ')}]`);
    if (report.totals.questions !== expectedAsked) problems.push(`recall asked ${report.totals.questions}, expected ${expectedAsked}`);
    if (want.length && report.retirement?.coverageSha256 !== sha256File(coverageFile)) problems.push('recall retirement is not bound to the sealed coverage bytes');
    if (counts.retired !== want.length) problems.push(`manifest.corpus.counts.retired=${counts.retired}, expected ${want.length}`);
  } else if (got.length) problems.push(`a scoped fixture retired [${got.join(', ')}]; nothing should retire`);
  if (problems.length) fail(`ADR-0091 D7 generation checks failed: ${problems.join('; ')}`);
  return { manifestCorpus: corpus, recall: { questions: report.totals.questions, retired: report.totals.retired ?? 0,
    retiredStores: got, coverageSha256: report.retirement?.coverageSha256 ?? null } };
}

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
  const seedLedger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
  generation.seedImport = { assetsDir, storesInSeed: Object.keys(seedLedger.stores || {}).length,
    // normalizeExtractedCorpus refused the import unless this runtime can consume the ledger (ADR-0091 D4).
    ledgerSchema: { schemaVersion: seedLedger.schemaVersion, kind: seedLedger.kind, brainVersion: seedLedger.brainVersion ?? null,
      verdict: 'consumable by this runtime' } };
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
  const injection = bounds.injectStoreFailure !== 'none' && index === bounds.injectGeneration ? bounds.injectStoreFailure : 'none';
  let injectTarget = null;
  if (injection !== 'none') {
    const upstreamOf = (store) => full.repositories.rows.find((row) => String(row.storeName || row.name).toLowerCase() === store)
      ?.defaultBranchRef?.target?.oid?.toLowerCase() || null;
    const seedCommitOf = (store) => String(Object.entries(seedLedger.stores || {})
      .find(([name]) => name.toLowerCase() === store)?.[1]?.sourceCommit || '').toLowerCase();
    // A carry needs seed bytes at a commit that DIFFERS from upstream; a transient retry needs neither.
    const carryable = (store) => /^[0-9a-f]{40}$/.test(seedCommitOf(store)) && upstreamOf(store) && seedCommitOf(store) !== upstreamOf(store);
    injectTarget = injection === 'transient' ? repoStores[0] : repoStores.find(carryable) || null;
    if (!injectTarget && injection === 'qa') {
      // The smallest bounded stores are often unchanged since the seed. A QA-injected store is never
      // embedded (its forge-refresh is answered synthetically), so adding the smallest carryable seed
      // store to the bounded set costs one clone. Declared in the receipt.
      const extra = [...full.repositories.rows]
        .sort((a, b) => (a.diskUsage ?? Number.MAX_SAFE_INTEGER) - (b.diskUsage ?? Number.MAX_SAFE_INTEGER))
        .map((row) => String(row.storeName || row.name).toLowerCase())
        .find((store) => !repoStores.includes(store) && carryable(store)) || null;
      if (extra) {
        repoStores.push(extra);
        generation.bounded.repositories = repoStores;
        generation.bounded.addedForInjection = extra;
        injectTarget = extra;
      }
    }
    if (!injectTarget) {
      fail(`--inject-store-failure ${injection}: no observed store has seed bytes at a commit that differs from upstream, `
        + 'so nothing could be carried');
    }
    generation.injection = { mode: injection, target: injectTarget, synthetic: true, events: [] };
    log(`[gen ${index}] INJECTING a synthetic ${injection} failure into store ${injectTarget}`);
  }
  if (bounds.forceRebuild) {
    // A QA-injected store keeps its seed bytes: they are what the carry must re-hash and keep.
    const forced = repoStores.filter((store) => !(injection === 'qa' && store === injectTarget));
    for (const store of forced) fs.rmSync(path.join(assetsDir, `${store}.big.rvf`), { force: true });
    generation.forcedRebuild = forced;
  }

  // Every other seed store stays in scope FROZEN at its seed sourceCommit (see boundObservation), so
  // the production prune leaves it alone and the repo-recall gate can ask its fixture question.
  const frozenSourceCommits = frozenSeedCommits(assetsDir, repoStores);
  generation.bounded.frozenAtSeed = Object.keys(frozenSourceCommits).length;
  log(`[gen ${index}] ${generation.bounded.frozenAtSeed} other seed store(s) kept in scope frozen at their seed sourceCommit (not rebuilt, not pruned)`);
  const boundedObserve = () => boundObservation({
    observation: observeFull(), api, repoStores, gistCount: bounds.gists, frozenSourceCommits });

  // The repo-recall gate asks one question per fixture repository. Scope it -- in the DISPOSABLE
  // checkout only, where repo-recall, corpus-candidate --verify and release.mjs all read the same file
  // -- to the repositories this bounded observation keeps. The committed original is preserved beside
  // it so every generation scopes from the same source.
  const fixtureFile = path.join(checkoutRoot, 'data', 'retrieval-query-evidence.json');
  const originalFixtureFile = path.join(workRoot, 'retrieval-query-evidence.committed.json');
  if (!fs.existsSync(originalFixtureFile)) fs.copyFileSync(fixtureFile, originalFixtureFile);
  const inScope = boundObservation({ observation: full, api, repoStores, gistCount: 0, frozenSourceCommits })
    .repositories.rows.map((row) => String(row.storeName || row.name));
  const scoped = scopeRecallFixture({
    fixture: JSON.parse(fs.readFileSync(originalFixtureFile, 'utf8')), inScopeStores: inScope });
  const committedFixture = bounds.recallFixture === 'committed';
  // ADR-0091 D7: in `committed` mode the fixture is NOT edited; the out-of-scope repositories are
  // retired by the production gate instead, which the checks after sealing hold to exactly this list.
  if (!committedFixture) fs.writeFileSync(fixtureFile, `${JSON.stringify(scoped.fixture, null, 2)}\n`);
  generation.bounded.recallFixture = { mode: bounds.recallFixture, questions: scoped.kept, excluded: scoped.excluded.length,
    excludedStores: scoped.excluded,
    reason: 'no seed sourceCommit to freeze at (the real nightly rebuilds these from upstream) or not observed upstream' };
  log(committedFixture
    ? `[gen ${index}] repo-recall fixture kept COMMITTED and unedited: ${scoped.excluded.length} out-of-scope repositories must be RETIRED by the gate (ADR-0091 D7), ${scoped.kept} asked`
    : `[gen ${index}] repo-recall fixture scoped to ${scoped.kept} in-scope repositories (${scoped.excluded.length} out of scope, listed in the receipt)`);

  // --- reconcile + assemble ONCE --------------------------------------------------------------
  const invocations = [];
  const recordingRun = (command, args, options = {}) => {
    const row = { command, script: path.basename(String(args?.[0] || '')), args: args.map(String) };
    invocations.push(row);
    const began = Date.now();
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    row.durationMs = Date.now() - began;
    row.exit = result.status ?? null;
    return result;
  };
  const injectingRun = (command, args, options) => {
    const events = generation.injection?.events;
    const target = generation.injection?.target;
    const clone = command === 'git' && args[0] === 'clone';
    const cloneDir = clone ? String(args.at(-1)) : '';
    if (target && clone && path.basename(path.dirname(cloneDir)) === target && injection === 'transient') {
      events.push({ event: 'git clone', dir: path.relative(workRoot, cloneDir), injected: 'transient failure (exit 128)' });
      return Promise.resolve({ status: 128, stdout: '', stderr: '[rehearsal] injected transient failure: connection reset' });
    }
    if (target && clone && path.basename(path.dirname(cloneDir)).startsWith(`${target}-retry`)) {
      events.push({ event: 'git clone', dir: path.relative(workRoot, cloneDir), injected: null });
    }
    const forge = command === process.execPath && String(args[0]).endsWith(`${path.sep}forge-refresh.mjs`);
    if (target && forge && args[args.indexOf('--name') + 1] === target) {
      if (injection === 'qa') {
        events.push({ event: 'forge-refresh', out: path.relative(workRoot, args[args.indexOf('--out') + 1]),
          injected: `corpus-qa refusal (exit ${api.CORPUS_QA_FAILED_EXIT}), forge not run` });
        return Promise.resolve({ status: api.CORPUS_QA_FAILED_EXIT, stdout: '', stderr: '[rehearsal] injected corpus-qa refusal' });
      }
      events.push({ event: 'forge-refresh', out: path.relative(workRoot, args[args.indexOf('--out') + 1]), injected: null });
    }
    return api.defaultRunAsync(command, args, options);
  };
  const reconcileStart = Date.now();
  const { reconciliation, candidate } = await api.reconcileAndPrepareCorpusCandidate({
    assetsDir, workspaceDir, root: checkoutRoot, owner: bounds.owner, builderSha: bounds.builderSha,
    candidateDir, receiptFile, coverageFile: path.join(checkoutRoot, 'data', 'source-coverage.json'),
    // reconcileAndPrepareCorpusCandidate reads `maxAttempts`; `maxRounds` was silently ignored after
    // cd0f032f, so --max-rounds never reached the acquisition loop.
    bootstrapIdentity, maxAttempts: bounds.maxRounds, accuracySample: bounds.accuracyQuestions,
    reconcile: (options) => api.acquireCorpusGeneration({ ...options, observe: boundedObserve,
      ...(injection !== 'none' ? { execute: (executeOptions) => api.executeReconciliation({ ...executeOptions, run: injectingRun }) } : {}) }),
    prepare: (options) => api.prepareCorpusCandidate({ ...options, run: recordingRun }),
  });
  generation.reconciliation = recordReconciliation({
    summarize: api.summarizeReconciliation, reconciliation, durationMs: Date.now() - reconcileStart });
  const assemblyInvocations = invocations.filter((row) => row.script === 'build-bundle.mjs');
  generation.assembly = {
    assembleBundleInvocations: assemblyInvocations.length,
    receiptInvocations: invocations.filter((row) => row.script === 'corpus-candidate.mjs').length,
    bundleFile: candidate.bundleFile,
    steps: invocations.map(({ script, durationMs, exit }) => ({ script, durationMs, exit })),
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
  generation.degraded = candidate.degraded || { carried: [], missing: [] };
  if (injection !== 'none') {
    const sealedCoverage = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'data', 'source-coverage.json'), 'utf8'));
    const row = sealedCoverage.rows.find((entry) => entry.kind === 'repository' && String(entry.artifact?.store).toLowerCase() === injectTarget);
    generation.injection.sealedRow = row ? { status: row.status, carry: row.carry ?? null, failure: row.failure ?? null,
      artifactSourceCommit: row.artifact?.sourceCommit ?? null, upstreamSha: row.upstream?.sha ?? null } : null;
    const events = generation.injection.events;
    const problems = [];
    if (injection === 'qa') {
      const carried = generation.degraded.carried.find((entry) => entry.store === injectTarget);
      if (!carried || carried.attempts !== 1 || !/^qa: /.test(carried.reason)) problems.push(`${injectTarget} was not carried once as a QA failure (${JSON.stringify(carried || null)})`);
      if (events.filter((entry) => entry.event === 'forge-refresh').length !== 1) problems.push('a QA failure was retried');
      if (row?.status !== 'STALE' || !row?.carry) problems.push(`the sealed coverage row is ${row?.status || 'absent'}${row?.carry ? '' : ' with no carry record'}, not STALE + carry`);
    } else {
      if (!generation.reconciliation.refreshed.includes(injectTarget)) problems.push(`${injectTarget} did not recover on its retry`);
      const clones = events.filter((entry) => entry.event === 'git clone');
      if (clones.length !== 2 || !clones[1].dir.includes(`${injectTarget}-retry1`)) problems.push(`expected one failed clone then one retry in ${injectTarget}-retry1 (${JSON.stringify(clones)})`);
      if (generation.degraded.carried.length || generation.degraded.missing.length) problems.push('a recovered transient failure left the generation degraded');
      if (row?.status !== 'CURRENT') problems.push(`the recovered store's sealed row is ${row?.status}, not CURRENT`);
    }
    generation.injection.verdict = problems.length ? 'FAIL' : 'PASS';
    if (problems.length) fail(`injected ${injection} failure did not behave as ADR-0091 D5 requires: ${problems.join('; ')}`);
    log(`[gen ${index}] injected ${injection} failure in ${injectTarget} behaved as required: `
      + `${injection === 'qa' ? 'not retried, carried at its seed bytes, sealed row STALE + carry' : 'retried once in a fresh directory and recovered'}`);
  }

  // --- ADR-0091 D7: the manifest's currency block and the recall gate's retirement, from real bytes --
  generation.d7 = checkGenerationCurrency({ checkoutRoot, candidateDir, bundleFile,
    committedFixture, expectedRetired: scoped.excluded, expectedAsked: scoped.kept });
  log(`[gen ${index}] ADR-0091 D7: manifest.corpus observedAt=${generation.d7.manifestCorpus.observedAt} `
    + `counts=${JSON.stringify(generation.d7.manifestCorpus.counts)}; recall asked ${generation.d7.recall.questions}, `
    + `retired ${generation.d7.recall.retired}`);

  // --- remove access to the originals, then verify the extracted bytes ------------------------
  generation.extractedByteVerification = await verifyExtractedBytesWithoutOriginals({
    checkoutRoot, assetsDir, bundleFile, receiptFile: candidate.receiptFile, verifyDir,
    tamper: index === bounds.tamperGeneration ? tamper : 'none', extractZip: api.extractZip,
  });
  log(`[gen ${index}] extracted-byte verification passed with staging revoked (${generation.extractedByteVerification.files} files)`);

  // --- ADR-0091 D5: a degraded generation inside the bound is published like any other, named -----
  const corpusTag = `corpus-sha256-${archiveSha256}`;
  if (generation.degraded.carried.length || generation.degraded.missing.length) {
    log(`[gen ${index}] degraded generation (${generation.degraded.carried.length} carried, `
      + `${generation.degraded.missing.length} missing) is published with its stores named in the sealed coverage`);
  }

  // --- rehearse the real product-consumption path, publication RECORDED not executed -----------
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
  // ADR-0091 D6.2: the sealed coverage travels to the publisher the way corpus-seed.yml stages it
  // (a copy of <checkout>/data/source-coverage.json beside the archive), and is published with it.
  const stagedCoverage = path.join(path.dirname(bundleFile), 'source-coverage.json');
  fs.copyFileSync(path.join(checkoutRoot, 'data', 'source-coverage.json'), stagedCoverage);
  const publish = run(process.execPath, [path.join(checkoutRoot, 'scripts', 'release.mjs'), '--corpus-seed',
    '--corpus-tag', corpusTag, '--corpus-bundle', bundleFile, '--corpus-receipt', candidate.receiptFile,
    '--corpus-coverage', stagedCoverage,
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
  // The detached C3 and repo-recall reports travel WITH the archive, exactly as release.mjs publishes
  // them (zip, sig, digest, receipt, .accuracy.json, .recall.json). verifySeedBaseline re-reads both
  // beside the seed, so handing over the zip alone failed every generation-2 import ("detached
  // repo-recall report missing") -- unseen until 2026-09-28 because no rehearsal had reached gen 2.
  for (const suffix of ['.accuracy.json', '.recall.json']) {
    const report = `${bundleFile}${suffix}`;
    if (!fs.existsSync(report)) fail(`candidate ${index} has no detached ${suffix} report to hand to generation ${index + 1}`);
    fs.copyFileSync(report, `${nextSeedFile}${suffix}`);
  }
  // ADR-0091 D7.3: the generation's sealed coverage travels with it, so the next import can verify a
  // retirement its recall report claims (the published CORPUS-COVERAGE.json is these exact bytes).
  const nextSeedCoverage = path.join(path.dirname(nextSeedFile), 'CORPUS-COVERAGE.json');
  fs.copyFileSync(stagedCoverage, nextSeedCoverage);
  generation.nextSeed = { tag: corpusTag, sha256: archiveSha256, bytes: archiveBytes, file: nextSeedFile,
    contentAddressed: true };
  generation.finishedAt = new Date().toISOString();
  const createRow = recordedNow.find((row) => row.args[0] === 'release' && row.args[1] === 'create' && row.args[2] === corpusTag);
  return {
    generation,
    nextSeed: { file: nextSeedFile, tag: corpusTag, sha256: archiveSha256, bytes: archiveBytes,
      channel: `candidate-generation-${index}`, allowPinnedTag: false, receiptFile: candidate.receiptFile, coverageFile: nextSeedCoverage },
    // ADR-0091 D4: exactly what release.mjs tried to upload, so the local registry invents nothing.
    published: { tag: corpusTag, createArgs: createRow ? createRow.args : [], receiptFile: candidate.receiptFile,
      recallFile: `${bundleFile}.recall.json`, accuracyFile: `${bundleFile}.accuracy.json`, sha256: archiveSha256, bytes: archiveBytes },
  };
}

// ---------------------------------------------------------------------------------------------
// ADR-0091 D4: seed selection through the real resolver (see scripts/rehearse-seed-selection.mjs)
// ---------------------------------------------------------------------------------------------

/** Candidate N, "published" into the local registry from release.mjs's own upload list, plus two
 * newer incompatible decoys the resolver must walk past. */
function publishLocally({ selectionMod, registryDir, published, workRoot, index }) {
  const files = selectionMod.uploadedFilesOf(published.createArgs);
  const names = files.map((file) => path.basename(file)).sort();
  const expectedNames = ['CORPUS-COVERAGE.json', 'corpus-receipt.json', 'coverage-receipt.json', 'ruvnet-brain.zip',
    'ruvnet-brain.zip.accuracy.json', 'ruvnet-brain.zip.recall.json'];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    fail(`release.mjs's recorded upload for generation ${index} is [${names.join(', ')}], expected [${expectedNames.join(', ')}]`);
  }
  const createdAtMs = Date.now();
  selectionMod.registerGeneration({ registryDir, tag: published.tag, createdAt: new Date(createdAtMs).toISOString(), files,
    note: `generation ${index}, from the files release.mjs --corpus-seed tried to upload` });
  const decoys = selectionMod.registerIncompatibleDecoys({ registryDir, createdAtMs,
    scratchDir: path.join(workRoot, `decoys-gen${index}`),
    real: { sha256: published.sha256, bytes: published.bytes, receiptFile: published.receiptFile,
      recallFile: published.recallFile, accuracyFile: published.accuracyFile } });
  return { ...published, decoys };
}

/**
 * What corpus-identity + corpus-seed.yml do on the nightly, against the local registry: resolve with
 * the REAL corpus-next-seed resolver (judged by this checkout's readers), prove it skipped both decoys
 * before any archive download, then "download" the chosen archive and re-check it exactly as
 * corpus-seed.yml does (sha256 + bytes, repo-recall at ABSOLUTE_FLOOR, C3 binding).
 */
async function selectPublishedSeed({ index, api, selectionMod, checkoutRoot, workRoot, registryDir, repoSlug, expected, receipt, phase }) {
  const gh = selectionMod.registryGh(registryDir);
  const selection = await api.resolveNextCorpusSeed({ repo: repoSlug, root: checkoutRoot, run: gh.run, runtimeRoot: checkoutRoot });
  const consumingVersion = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const publishedReceipt = JSON.parse(fs.readFileSync(expected.receiptFile, 'utf8'));
  const record = {
    generation: index,
    selected: { origin: selection.seed.origin, tag: selection.seed.tag, builtUnder: selection.seed.brainVersion },
    consumingRuntime: consumingVersion,
    judged: selection.judged,
    expects: selection.expects,
    rejected: selection.rejected,
    ghCalls: gh.calls,
    archiveDownloadAttempts: gh.archiveDownloadAttempts().length,
    // The rule D4 removed, evaluated on the generation it would have judged. Recorded, not enforced.
    preD4RuntimeRule: publishedReceipt.archiveManifestVersion === consumingVersion ? 'would-accept'
      : `would-REJECT (generation shipped v${publishedReceipt.archiveManifestVersion}, consuming runtime is v${consumingVersion}) and reset to the bootstrap`,
  };
  receipt.seedSelection.push(record);
  const problems = [];
  if (selection.seed.origin !== 'published-generation' || selection.seed.tag !== expected.tag) {
    problems.push(`selected ${selection.seed.origin} ${selection.seed.tag}, expected the published generation ${expected.tag}`);
  }
  if (record.archiveDownloadAttempts !== 0) problems.push(`the resolver attempted ${record.archiveDownloadAttempts} archive download(s)`);
  for (const decoy of expected.decoys) {
    const row = selection.rejected.find((entry) => entry.tag === decoy.tag);
    const wanted = decoy.kind === 'model-mismatch' ? /^incompatible: .*different model\/dimensions/ : /^incompatible: recall report was measured against fixture/;
    if (!row || !wanted.test(row.reason)) problems.push(`decoy ${decoy.kind} was not skipped for its own reason (${row ? row.reason : 'not judged'})`);
    const recallFetched = gh.downloads().some((line) => line.includes(decoy.tag) && line.includes('--pattern ruvnet-brain.zip.recall.json '));
    if (decoy.kind === 'model-mismatch' && recallFetched) problems.push('the model-mismatch decoy was not rejected from its receipt alone');
    if (decoy.kind === 'fixture-mismatch' && !recallFetched) problems.push('the fixture-mismatch decoy was rejected without reading its recall report');
  }
  if (problems.length) {
    phase(`generation-${index}-seed-selection`, 'FAIL', { reason: problems.join('; ') });
    fail(`seed selection for generation ${index} failed: ${problems.join('; ')}`);
  }

  // The download corpus-seed.yml performs, then its defence-in-depth re-check -- which by construction
  // now only ever sees a generation the resolver already passed.
  const dir = path.join(workRoot, `seed-gen${index}-selected`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['ruvnet-brain.zip', 'corpus-receipt.json', 'ruvnet-brain.zip.recall.json', 'ruvnet-brain.zip.accuracy.json',
    'CORPUS-COVERAGE.json', 'coverage-receipt.json']) {
    fs.copyFileSync(path.join(registryDir, selection.seed.tag, 'assets', name), path.join(dir, name), fs.constants.COPYFILE_FICLONE);
  }
  const file = path.join(dir, 'ruvnet-brain.zip');
  const sha256 = sha256File(file);
  const bytes = fs.statSync(file).size;
  if (sha256 !== selection.seed.sha256 || bytes !== selection.seed.bytes) fail(`selected seed download does not match its descriptor (${sha256}/${bytes})`);
  const archive = { file: 'ruvnet-brain.zip', sha256, bytes };
  api.readDiagnosticAccuracyReport({ reportFile: `${file}.accuracy.json`, archive });
  // corpus-seed.yml's seed-recall-verify block: the seed's own sidecar coverage, verified, then handed to
  // the reader so a claimed retirement is recomputed rather than trusted (ADR-0091 D7.3).
  const coverageBytes = fs.readFileSync(path.join(dir, 'CORPUS-COVERAGE.json'));
  api.verifyCoverageSidecar({ sidecar: JSON.parse(fs.readFileSync(path.join(dir, 'coverage-receipt.json'), 'utf8')), coverageBytes,
    generationTag: selection.seed.tag, archiveSha256: sha256, archiveBytes: bytes });
  const fixture = api.loadFixture();
  const { report } = api.readRecallReport({ reportFile: `${file}.recall.json`, archive,
    expectedFixtureSha256: fixture.fixtureSha256, floorValue: 0, coverageBytes,
    fixtureStores: fixture.questions.map((question) => question.store) });
  record.downstreamRecheck = { repoCoverage: report.totals.repoCoverage, questions: report.totals.questions, hitTop5: report.totals.hitTop5,
    retired: report.totals.retired ?? 0 };
  phase(`generation-${index}-seed-selection`, 'PASS', {
    selected: selection.seed.tag, builtUnder: `v${selection.seed.brainVersion}`, consumingRuntime: `v${consumingVersion}`,
    skipped: selection.rejected.map((row) => `${row.tag.slice(0, 26)}...: ${row.reason}`),
    archiveDownloadAttempts: 0, preD4RuntimeRule: record.preD4RuntimeRule,
    reason: `the real corpus-next-seed resolver walked past ${expected.decoys.length} newer incompatible generation(s) without downloading an archive and chose generation ${index - 1}, built under an older runtime` });
  return { file, tag: selection.seed.tag, sha256, bytes, channel: 'published-generation-selected', allowPinnedTag: false,
    receiptFile: path.join(dir, 'corpus-receipt.json'), builtUnder: selection.seed.brainVersion,
    coverageFile: path.join(dir, 'CORPUS-COVERAGE.json') };
}

// ---------------------------------------------------------------------------------------------
// ADR-0091 D6 (V6a/V6c): a CODE RELEASE consumes the published generation
// ---------------------------------------------------------------------------------------------

/**
 * What ci.yml's release-qe does after D6, against the local registry: resolve in code-release mode
 * (the real resolver, --require-coverage: decoys without a coverage sidecar are skipped), download the
 * generation plus its sidecar, and assemble through the REAL orchestrator on the single-pass path --
 * a real build-bundle run with the generation's sealed coverage and seed identity, which had never
 * been exercised against a generation before. V6a: the generation directory is byte-unchanged and the
 * archive's store bytes equal the generation's. D6.4: the frozen fixture is judged against the live
 * eligible set by the shared denominator.
 */
async function rehearseCodeRelease({ index, api, selectionMod, checkoutRoot, workRoot, registryDir, repoSlug, expected, receipt, phase, log }) {
  const name = `code-release-from-generation-${index}`;
  const gh = selectionMod.registryGh(registryDir);
  const selection = await api.resolveNextCorpusSeed({ repo: repoSlug, root: checkoutRoot, run: gh.run, runtimeRoot: checkoutRoot,
    requireCoverage: true });
  const record = { generation: index, selected: { origin: selection.seed.origin, tag: selection.seed.tag },
    rejected: selection.rejected, archiveDownloadAttempts: gh.archiveDownloadAttempts().length };
  receipt.codeReleaseConsumption = [...(receipt.codeReleaseConsumption || []), record];
  if (selection.seed.origin !== 'published-generation' || selection.seed.tag !== expected.tag || !selection.seed.coverage) {
    phase(name, 'FAIL', { reason: `code-release resolution chose ${selection.seed.origin} ${selection.seed.tag}, expected ${expected.tag} with its coverage` });
    fail(`${name}: the code-release resolver did not choose the published generation`);
  }
  const dir = path.join(workRoot, `code-release-gen${index}`);
  const evidence = path.join(dir, 'release-evidence');
  const extracted = path.join(dir, 'extracted');
  fs.mkdirSync(evidence, { recursive: true });
  for (const asset of ['ruvnet-brain.zip', 'CORPUS-COVERAGE.json', 'coverage-receipt.json']) {
    fs.copyFileSync(path.join(registryDir, selection.seed.tag, 'assets', asset), path.join(dir, asset), fs.constants.COPYFILE_FICLONE);
  }
  const zip = path.join(dir, 'ruvnet-brain.zip');
  if (sha256File(zip) !== selection.seed.sha256) fail(`${name}: downloaded generation does not match its descriptor`);
  await api.extractZip(zip, extracted);
  const descriptorFile = path.join(evidence, 'corpus-seed.json');
  fs.writeFileSync(descriptorFile, `${JSON.stringify(selection.seed, null, 2)}\n`);
  const outputs = [];
  const capture = (command, args, options = {}) => {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
    outputs.push({ script: path.basename(String(args?.[0] || command)), exit: result.status,
      tail: result.status === 0 ? undefined : String(result.stderr || result.stdout || '').trim().slice(-800) });
    return result;
  };
  const started = Date.now();
  let assembled;
  try {
    assembled = api.assembleCodeReleaseCorpus({ root: checkoutRoot, descriptor: selection.seed, seedBundle: zip, assetsDir: extracted,
      evidenceDir: evidence, coverageFile: path.join(dir, 'CORPUS-COVERAGE.json'),
      coverageReceiptFile: path.join(dir, 'coverage-receipt.json'), run: capture, env: { ...process.env } });
  } catch (error) {
    record.steps = outputs;
    phase(name, 'FAIL', { reason: error.message, steps: outputs });
    throw error;
  }
  record.assembly = { mode: assembled.mode, durationMs: Date.now() - started, steps: outputs, unmutated: assembled.unmutated,
    seedTree: assembled.seedTree };
  const releaseCoverage = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'dist', 'ruvnet-brain', 'COVERAGE.json'), 'utf8'));
  // ADR-0091 D7.1: a code release built FROM a generation names it, and dates itself by its observation.
  const releaseCorpus = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'dist', 'ruvnet-brain', 'manifest.json'), 'utf8')).corpus;
  const generationCoverage = JSON.parse(fs.readFileSync(path.join(dir, 'CORPUS-COVERAGE.json'), 'utf8'));
  record.manifestCorpus = releaseCorpus;
  if (releaseCorpus?.basis !== 'sealed-observation' || releaseCorpus.generationTag !== selection.seed.tag
    || releaseCorpus.observedAt !== generationCoverage.observedAt) {
    phase(name, 'FAIL', { reason: `code-release manifest.corpus does not name its generation and observation: ${JSON.stringify(releaseCorpus)}` });
    fail(`${name}: manifest.corpus is ${JSON.stringify(releaseCorpus)}`);
  }
  const fixture = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'data', 'retrieval-query-evidence.json'), 'utf8'));
  const denominator = api.fixtureDenominator({ coverage: releaseCoverage, fixtureStores: Object.keys(fixture.queries) });
  record.canaryDenominator = { fixture: denominator.fixture.length, questioned: denominator.questioned.length,
    retired: denominator.retired, blocking: denominator.blocking, unfixturedEligible: denominator.unfixturedEligible.length,
    corpusSeed: releaseCoverage.corpusSeed };
  if (assembled.mode !== 'single-pass' || denominator.blocking.length || releaseCoverage.corpusSeed?.tag !== selection.seed.tag) {
    phase(name, 'FAIL', { reason: `mode=${assembled.mode}, blocking=${JSON.stringify(denominator.blocking)}, coverage seed=${releaseCoverage.corpusSeed?.tag}` });
    fail(`${name}: the code release did not assemble single-pass from the generation with an admissible canary denominator`);
  }
  const guard = api.checkNoNewerCorpusGeneration({ sealed: selection.seed,
    resolution: await api.resolveNextCorpusSeed({ repo: repoSlug, root: checkoutRoot, run: selectionMod.registryGh(registryDir).run,
      runtimeRoot: checkoutRoot, requireCoverage: true }) });
  record.publishGuardBeforeNextGeneration = guard;
  phase(name, 'PASS', { mode: assembled.mode, durationMs: record.assembly.durationMs, unmutated: assembled.unmutated,
    canary: `${denominator.questioned.length}/${denominator.fixture.length} fixture stores questioned, ${denominator.retired.length} retired, `
      + `${denominator.unfixturedEligible.length} unfixtured eligible recorded`,
    reason: `release built single-pass from ${selection.seed.tag.slice(0, 26)}...: ${assembled.unmutated.files} store files byte-equal to the generation, `
      + 'generation directory unchanged, no capability-only refresh or index repair; the publish guard passes while no newer generation exists' });
  log(`[${name}] single-pass code release assembled in ${record.assembly.durationMs} ms`);
  return { sealed: selection.seed, record };
}

/** V6c: once generation N+1 is published, a release QE'd from generation N must be refused at publish. */
async function rehearsePublishGuard({ sealed, index, api, selectionMod, checkoutRoot, registryDir, repoSlug, record, phase }) {
  const name = `publish-guard-after-generation-${index}`;
  const resolution = await api.resolveNextCorpusSeed({ repo: repoSlug, root: checkoutRoot, run: selectionMod.registryGh(registryDir).run,
    runtimeRoot: checkoutRoot, requireCoverage: true });
  try {
    api.checkNoNewerCorpusGeneration({ sealed, resolution });
  } catch (error) {
    record.publishGuardAfterNextGeneration = { refused: true, reason: error.message, newest: resolution.seed.tag };
    if (!/re-run release QE/.test(error.message)) {
      phase(name, 'FAIL', { reason: `refused for the wrong reason: ${error.message}` });
      fail(`${name}: the guard refused for the wrong reason`);
    }
    phase(name, 'PASS', { reason: `publication of the release QE'd from ${sealed.tag.slice(0, 26)}... was REFUSED: ${error.message}` });
    return;
  }
  phase(name, 'FAIL', { reason: `generation ${index} was published after QE, yet the publish guard allowed the older release` });
  fail(`${name}: the backward-move guard did not refuse`);
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
  injectStoreFailure = 'none',
  injectGeneration = 1,
  recallFixture = 'scoped',
  forceRebuild = true,
  seedOverride = null,
  // ADR-0091 D4. seedSelection: generation N+1's seed is chosen by the real corpus-next-seed resolver
  // from a local registry of published generations (plus incompatible decoys), not handed over
  // directly. codeReleaseBetween: cut a version bump in the disposable checkout between generations,
  // so the chosen seed was built under an OLDER runtime than the one consuming it.
  seedSelection = true,
  codeReleaseBetween = true,
  // ADR-0091 D6: after generation N is published locally, a code release consumes it (single-pass,
  // real build) and, once generation N+1 is published, the publish-time guard must refuse that release.
  codeReleaseConsumption = true,
  // null = the checkout's own C3_DIAGNOSTIC_SAMPLE_QUESTIONS (what CI runs); 'full' = no sample.
  accuracySample = null,
  keep = false,
  workRootParent = null,
  installedBrainDir = path.join(os.homedir(), '.cache', 'ruvnet-brain', 'kb'),
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (!TAMPER_MODES.has(tamper)) fail(`unknown --tamper mode ${tamper} (expected: ${[...TAMPER_MODES].join(', ')})`);
  if (!RECALL_FIXTURE_MODES.has(recallFixture)) {
    fail(`unknown --recall-fixture mode ${recallFixture} (expected: ${[...RECALL_FIXTURE_MODES].join(', ')})`);
  }
  if (!INJECTION_MODES.has(injectStoreFailure)) {
    fail(`unknown --inject-store-failure mode ${injectStoreFailure} (expected: ${[...INJECTION_MODES].join(', ')})`);
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const receipt = {
    schemaVersion: 1,
    kind: 'ruvnet-brain-corpus-rehearsal-receipt',
    banner: BANNER,
    startedAt,
    host: { node: process.version, platform: `${process.platform}/${process.arch}` },
    bounds: { repos, gists, generations, maxRounds, owner, forceRebuild, tamper, tamperGeneration, accuracySample,
      seedSelection, codeReleaseBetween, codeReleaseConsumption, injectStoreFailure, injectGeneration, recallFixture },
    phases: [],
    generations: [],
    seedSelection: [],
    approvedRuntime: [],
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
    const [reconcileMod, coverageMod, candidateMod, zipMod, accuracyMod, nextSeedMod, approvedMod, recallMod, selectionMod, failureMod] = await Promise.all([
      load('scripts/corpus-reconcile.mjs'), load('scripts/source-coverage.mjs'),
      load('scripts/corpus-candidate.mjs'), load('kb/zip-extract.mjs'), load('scripts/oracle/retrieval-accuracy.mjs'),
      load('scripts/corpus-next-seed.mjs'), load('scripts/approved-runtime.mjs'), load('scripts/oracle/repo-recall.mjs'),
      load('scripts/rehearse-seed-selection.mjs'), load('scripts/corpus-store-failure.mjs'),
    ]);
    const [codeReleaseMod, denominatorMod, sidecarMod] = await Promise.all([
      load('scripts/code-release-corpus.mjs'), load('scripts/fixture-denominator.mjs'), load('scripts/corpus-coverage-sidecar.mjs')]);
    // The same C3 question sample CI runs (ADR-0091 D2), unless the caller asked for the full audit.
    const accuracyQuestions = accuracySample === 'full' ? null
      : accuracySample == null ? accuracyMod.C3_DIAGNOSTIC_SAMPLE_QUESTIONS : Number(accuracySample);
    if (accuracyQuestions != null && (!Number.isSafeInteger(accuracyQuestions) || accuracyQuestions <= 0)) {
      fail(`--accuracy-sample must be a positive integer or 'full' (got ${accuracySample})`);
    }
    receipt.bounds.accuracySample = accuracyQuestions ?? 'full';
    const api = {
      assertBootstrapIdentity: reconcileMod.assertBootstrapIdentity,
      normalizeExtractedCorpus: reconcileMod.normalizeExtractedCorpus,
      seedPrivateFenceEvidence: reconcileMod.seedPrivateFenceEvidence,
      syncCorpusInputs: reconcileMod.syncCorpusInputs,
      acquireCorpusGeneration: reconcileMod.acquireCorpusGeneration,
      reconcileAndPrepareCorpusCandidate: reconcileMod.reconcileAndPrepareCorpusCandidate,
      summarizeReconciliation: reconcileMod.summarizeReconciliation,
      prepareCorpusCandidate: reconcileMod.prepareCorpusCandidate,
      executeReconciliation: reconcileMod.executeReconciliation,
      defaultRunAsync: reconcileMod.defaultRunAsync,
      observeSourceUniverse: coverageMod.observeSourceUniverse,
      canonicalSourceObservation: coverageMod.canonicalSourceObservation,
      buildCoverage: coverageMod.buildCoverage,
      verifySeedBaseline: candidateMod.verifySeedBaseline,
      extractZip: zipMod.extractZip,
      resolveNextCorpusSeed: nextSeedMod.resolveNextCorpusSeed,
      verifyApprovedRuntime: approvedMod.verifyApprovedRuntime,
      emitApprovedRuntime: approvedMod.emitApprovedRuntime,
      readArchiveManifestFromZip: approvedMod.readArchiveManifestFromZip,
      isRuntimeFile: approvedMod.isRuntimeFile,
      readRecallReport: recallMod.readRecallReport,
      loadFixture: recallMod.loadFixture,
      readDiagnosticAccuracyReport: accuracyMod.readDiagnosticAccuracyReport,
      assembleCodeReleaseCorpus: codeReleaseMod.assembleCodeReleaseCorpus,
      checkNoNewerCorpusGeneration: codeReleaseMod.checkNoNewerCorpusGeneration,
      fixtureDenominator: denominatorMod.fixtureDenominator,
      verifyCoverageSidecar: sidecarMod.verifyCoverageSidecar,
    };
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== 'function') fail(`the disposable checkout does not export ${name}`);
    }
    api.CORPUS_QA_FAILED_EXIT = failureMod.CORPUS_QA_FAILED_EXIT;
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
      channel: acquisition.channel, allowPinnedTag: true, builtUnder: String(descriptor.tag).replace(/^v/, '') };
    let builderSha = checkout.head;
    const registryDir = path.join(workRoot, 'release-registry');
    fs.mkdirSync(registryDir, { recursive: true });
    let lastPublished = null;
    let codeRelease = null;
    for (let index = 1; index <= generations; index += 1) {
      if (index > 1 && codeReleaseBetween) {
        const release = selectionMod.simulateCodeRelease({ checkoutRoot });
        builderSha = release.head;
        receipt.codeReleases = [...(receipt.codeReleases || []), { beforeGeneration: index, ...release }];
        phase(`code-release-before-generation-${index}`, 'PASS', { from: release.from, to: release.to, head: release.head,
          committed: release.committed,
          reason: `a code release (v${release.from} -> v${release.to}) landed between generations, the event that reset the pre-D4 seed chain` });
      }
      if (index > 1 && seedSelection) {
        seed = await selectPublishedSeed({ index, api, selectionMod, checkoutRoot, workRoot, registryDir, repoSlug,
          expected: lastPublished, receipt, phase });
      }
      if (index > 1) {
        // Import candidate N as seed N+1 through the SAME baseline verifier the future consumer
        // uses — the content-addressed tag, the archive bytes, and the schema-2 receipt together.
        const baseline = await api.verifySeedBaseline({
          seedDescriptor: { tag: seed.tag, sha256: seed.sha256, bytes: seed.bytes },
          bundleFile: seed.file, receiptFile: seed.receiptFile, coverageFile: seed.coverageFile ?? null,
        });
        phase(`generation-${index}-seed-baseline`, 'PASS', {
          tag: baseline.tag, sha256: baseline.sha256, stores: baseline.receipt.storeCount,
          reason: `candidate from generation ${index - 1} accepted as the generation ${index} seed — the chain closes` });
      }
      const result = await runGeneration({
        index, api, checkoutRoot, workRoot, seed, recorder, tamper, log,
        bounds: { repos, gists, owner, maxRounds, builderSha, forceRebuild, tamperGeneration, accuracyQuestions,
          injectStoreFailure, injectGeneration, recallFixture },
      });
      receipt.generations.push(result.generation);
      phase(`generation-${index}`, 'PASS', {
        candidateSha256: result.generation.candidate.sha256,
        stores: result.generation.candidate.storeCount,
        durationMs: result.generation.reconciliation.durationMs });

      // ADR-0091 D4 / V4: the candidate's runtime surface, judged by the real verifyApprovedRuntime
      // against a pin traced to the CHECKOUT's own bytes (never emitted from the candidate).
      const manifest = api.readArchiveManifestFromZip(result.generation.candidate.bundleFile);
      const version = JSON.parse(fs.readFileSync(path.join(checkoutRoot, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version;
      const { pin, traced, untraced } = selectionMod.checkoutRuntimePin({
        checkoutRoot, manifest, approvedCodeSha: builderSha, version, api });
      const verdict = api.verifyApprovedRuntime({ manifest, pin });
      const runtimeCheck = { generation: index, seedTag: seed.tag, seedBuiltUnder: seed.builtUnder ?? null,
        consumingRuntime: `v${version}`, pinnedFromCheckout: traced, untraced, verdict: verdict.verdict,
        checked: verdict.checked, failures: verdict.failures };
      receipt.approvedRuntime.push(runtimeCheck);
      if (verdict.verdict !== 'PASS') {
        phase(`generation-${index}-approved-runtime`, 'FAIL', { ...runtimeCheck, reason: verdict.failures.slice(0, 5).join('; ') });
        fail(`generation ${index}'s candidate fails verifyApprovedRuntime against the checkout: ${verdict.failures.slice(0, 5).join('; ')}`);
      }
      phase(`generation-${index}-approved-runtime`, 'PASS', { ...runtimeCheck,
        reason: `verifyApprovedRuntime PASS: ${verdict.checked} runtime files equal the checkout's, none unpinned, seed ${seed.tag} did not leak an executable` });

      const consumeNow = seedSelection && codeReleaseConsumption && !codeRelease;
      if (seedSelection && (index < generations || codeRelease)) {
        lastPublished = publishLocally({ selectionMod, registryDir, published: result.published, workRoot, index });
      }
      if (codeRelease) {
        await rehearsePublishGuard({ sealed: codeRelease.sealed, index, api, selectionMod, checkoutRoot, registryDir, repoSlug,
          record: codeRelease.record, phase });
        codeRelease = null;
      } else if (consumeNow && index < generations) {
        codeRelease = await rehearseCodeRelease({ index, api, selectionMod, checkoutRoot, workRoot, registryDir, repoSlug,
          expected: lastPublished, receipt, phase, log });
      }
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
    injectStoreFailure: arg(argv, '--inject-store-failure', 'none'),
    injectGeneration: Number(arg(argv, '--inject-generation', 1)),
    recallFixture: arg(argv, '--recall-fixture', 'scoped'),
    forceRebuild: !argv.includes('--no-force-rebuild'),
    seedOverride: arg(argv, '--seed', null),
    seedSelection: !argv.includes('--no-seed-selection'),
    codeReleaseBetween: !argv.includes('--no-code-release-between'),
    codeReleaseConsumption: !argv.includes('--no-code-release-consumption'),
    accuracySample: arg(argv, '--accuracy-sample', null),
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

if (isDirectInvocation(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
