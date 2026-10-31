// scripts/release-prepush-checks.mjs — the individual checks behind `npm run release:prepush`.
//
// Each check is `async (ctx) => ({ ok, detail, warnings? })`. Every effect (git, gh, node, network)
// goes through `ctx.deps`, so the unit tests drive the checks with no real git, gh or network.
// The rules here restate nothing: the commands come from package.json, the census rules from
// scripts/claims-verify.mjs, the test inventory from scripts/release-qualification.mjs.

import path from 'node:path';

export const RELEASE_BRANCH = /^release\/(\d+\.\d+\.\d+)$/;
export const MAX_ADDED_BYTES = 5 * 1024 * 1024;
export const QUALIFICATION_SUITES = ['source', 'integration'];
export const QUALIFICATION_PLATFORMS = ['linux', 'macos', 'windows'];
export const ANCHOR_TEST_DIRS = ['tests/mesh/', 'tests/mutation/', 'tests/regression/', 'tests/unit/'];
// Repo-wide rules over test files: run whenever any test changed (4.7.28 lost a unit-suite run to
// no-restated-truth, and to a unit test pinning a changed source line, neither of which preflight runs).
export const TEST_RULE_TESTS = ['tests/unit/no-restated-truth.test.mjs'];
// Unit tests are anchored to changed CODE only: version surfaces (package.json, plugin.json, README) are
// named by hundreds of unit tests and change on every release, so anchoring on them selects most of the suite.
export const VERSION_SURFACE = /^kb\/(?:package\.json|RVF-GENERATIONS\.json)$/;
export const UNIT_ANCHOR_SOURCE = /^(?:scripts|bin|kb|plugin\/scripts|plugin\/mcp|plugin\/hooks|\.github\/workflows)\/.+\.(?:mjs|cjs|js|sh|yml|json)$/;
const CHANGED_TEST = /^tests\/(?:unit|integration|mesh|mutation|regression)\/.+\.test\.mjs$/;
export const RECENT_PRERELEASE_MS = 3 * 60 * 60 * 1000;
export const SEED_LINE = /\[corpus-next-seed\] (published-generation|committed-bootstrap) (\S+)/g;

// The preflight's first-push gates, by the npm script that defines each (never a restated flag), plus
// the two the preflight runs directly (.github/workflows/release-candidate-preflight.yml).
export const STATIC_GATES = [
  { name: 'node-check-release', argv: ['--check', 'scripts/release.mjs'] },
  { name: 'version-check', script: 'version:check' },
  { name: 'release-authority', script: 'release:authority' },
  { name: 'architecture-review-lock', argv: ['scripts/architecture-review-lock.mjs'] },
  { name: 'convergence-check', script: 'convergence:check' },
  { name: 'hooks-check', script: 'hooks:check' },
  { name: 'single-source-check', script: 'single-source:check' },
  { name: 'wired-check', script: 'wired:check' },
  { name: 'substitution-check', script: 'substitution:check' },
];

/**
 * Stray-artifact rules for files ADDED on the branch. Every pattern is anchored to a path segment or a
 * basename suffix: a loose `agentdb*` or `*.rvf*` would match legitimate tracked files such as
 * kb/l2/agentdb.md or plugin/scripts/package-cards.rvf.
 */
export const STRAY_PATTERNS = [
  { name: 'ruflo/agentdb working store (.swarm/)', re: /(^|\/)\.swarm\// },
  { name: 'database file', re: /\.db(-wal|-shm)?$/ },
  { name: 'local Claude settings', re: /(^|\/)\.claude\/settings\.local[^/]*$/ },
  { name: 'backup file (*.bak*)', re: /(^|\/)[^/]*\.bak(?:$|[-._\d])[^/]*$/ },
  { name: 'opencode workspace', re: /(^|\/)\.opencode\// },
  { name: 'VS Code workspace', re: /(^|\/)\.vscode\// },
];

export function strayFindings(added, { rootFilesAtMain, sizes }) {
  const findings = [];
  for (const file of added) {
    for (const rule of STRAY_PATTERNS) if (rule.re.test(file)) findings.push(`${file}: ${rule.name}`);
    if (!file.includes('/') && !rootFilesAtMain.has(file)) findings.push(`${file}: new root-level file (absent at origin/main)`);
    const size = sizes.get(file);
    if (size > MAX_ADDED_BYTES) findings.push(`${file}: ${(size / 1048576).toFixed(1)} MB added (limit 5 MB)`);
  }
  return findings;
}

const lines = (text) => String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
const fail = (detail, extra = {}) => ({ ok: false, detail, ...extra });
const pass = (detail, extra = {}) => ({ ok: true, detail, ...extra });

async function git(ctx, args) {
  const result = await ctx.deps.exec('git', args, { cwd: ctx.root });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

/** (a) release/X.Y.Z branch, X.Y.Z = package.json version, no tracked changes. */
export async function branchIdentity(ctx) {
  const branch = (await git(ctx, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const version = JSON.parse(await git(ctx, ['show', 'HEAD:package.json'])).version;
  const dirty = lines(await git(ctx, ['status', '--porcelain', '--untracked-files=no']));
  const problems = [];
  const match = RELEASE_BRANCH.exec(branch);
  if (!match) problems.push(`HEAD is on "${branch}", not a release/X.Y.Z branch`);
  else if (match[1] !== version) problems.push(`branch says ${match[1]} but package.json says ${version}`);
  if (dirty.length) problems.push(`${dirty.length} tracked change(s) not committed: ${dirty.slice(0, 5).join(', ')}`);
  return problems.length ? fail(problems.join('; ')) : pass(`${branch} = package.json ${version}; tracked tree clean`);
}

/** (b) one static gate; its exit status is the verdict, its last output lines the detail. */
export function staticGate(gate) {
  return async (ctx) => {
    let argv = gate.argv;
    if (gate.script) {
      const command = ctx.packageScripts[gate.script];
      if (!command) return fail(`package.json has no "${gate.script}" script`);
      const node = /^node\s+(.+)$/.exec(command.trim());
      argv = node && !/[|&;<>$`]/.test(node[1]) ? node[1].split(/\s+/) : null;
      if (!argv) {
        const npm = await ctx.deps.exec('npm', ['run', '--silent', gate.script], { cwd: ctx.root });
        return npm.status === 0 ? pass(`npm run ${gate.script}`) : fail(tail(npm));
      }
    }
    const result = await ctx.deps.exec(process.execPath, argv, { cwd: ctx.root });
    return result.status === 0 ? pass(`node ${argv.join(' ')}`) : fail(`node ${argv.join(' ')} exited ${result.status}: ${tail(result)}`);
  };
}
const tail = (result) => lines(`${result.stdout || ''}\n${result.stderr || ''}`).slice(-6).join(' | ').slice(0, 1200);

/** (c) the qualification inventory builds for every suite and platform, and every file is tracked at HEAD. */
export async function qualificationInventory(ctx) {
  const tracked = new Set(lines(await git(ctx, ['ls-tree', '-r', '--name-only', 'HEAD'])));
  const { qualificationPlan } = await ctx.deps.importModule(path.join(ctx.root, 'scripts/release-qualification.mjs'));
  const problems = [];
  let files = 0;
  for (const suite of QUALIFICATION_SUITES) for (const platform of QUALIFICATION_PLATFORMS) {
    try {
      const plan = qualificationPlan(suite, platform);
      files += plan.files.length;
      for (const file of plan.files) if (!tracked.has(file)) problems.push(`${suite}/${platform}: ${file} is not tracked at HEAD`);
    } catch (error) { problems.push(`${suite}/${platform}: ${error.message}`); }
  }
  return problems.length ? fail(problems.join('; ')) : pass(`6 plans, ${files} listed files, all tracked at HEAD`);
}

/** (d) nothing stray was added on the branch. */
export async function strayArtifacts(ctx) {
  const base = (await git(ctx, ['merge-base', 'origin/main', 'HEAD'])).trim();
  const added = lines(await git(ctx, ['diff', '--name-only', '--no-renames', '--diff-filter=A', base, 'HEAD']));
  const rootFilesAtMain = new Set(lines(await git(ctx, ['ls-tree', '--name-only', 'origin/main'])));
  const sizes = new Map();
  for (const row of lines(await git(ctx, ['ls-tree', '-r', '-l', 'HEAD']))) {
    const m = /^\S+ blob \S+\s+(\d+)\t(.+)$/.exec(row);
    if (m) sizes.set(m[2], Number(m[1]));
  }
  const findings = strayFindings(added, { rootFilesAtMain, sizes });
  return findings.length ? fail(findings.join('; ')) : pass(`${added.length} added file(s) since ${base.slice(0, 8)}; none stray`);
}

/** The surface rules of scripts/claims-verify.mjs (qualifyCensusArtifacts), with old and new numbers named. */
export function surfaceCensusProblems(file, text, census, { SURFACE_CLAIM_RULES }) {
  const expected = { ...census, builtStores: census.publicStores };
  const problems = [];
  const want = census.chunks.toLocaleString('en-US');
  if (!text.includes(want)) problems.push(`${file}: chunk count ${want} absent`);
  for (const rule of SURFACE_CLAIM_RULES) for (const match of text.matchAll(rule.re)) for (const group of rule.groups) {
    const found = Number(match[group.i].replace(/,/g, ''));
    if (found !== expected[rule.key]) {
      problems.push(`${file}: ${rule.name} ${found.toLocaleString('en-US')} -> ${expected[rule.key].toLocaleString('en-US')}`);
    }
  }
  return problems;
}

async function surfacesAgainst(ctx, rev, census) {
  const claims = await ctx.deps.importModule(path.join(ctx.root, 'scripts/claims-verify.mjs'));
  const problems = [];
  for (const file of claims.CHUNK_SURFACES) {
    const text = await git(ctx, ['show', `${rev}:${file}`]);
    problems.push(...surfaceCensusProblems(file, text, census, claims));
  }
  return { problems, surfaces: claims.CHUNK_SURFACES.length };
}

/** Which generation is the newest NOW (or the one named for a replay). */
async function targetGeneration(ctx) {
  if (ctx.generation) return { tag: ctx.generation, bytes: null, origin: 'named' };
  const seed = await ctx.deps.resolveSeed();
  return { tag: seed.tag, bytes: seed.bytes ?? null, origin: seed.origin };
}

async function corpusWarnings(ctx) {
  const warnings = [];
  const now = ctx.deps.now();
  const releases = await ctx.deps.exec('gh', ['release', 'list', '--repo', ctx.repo, '--limit', '20', '--json', 'tagName,isPrerelease,publishedAt'], { cwd: ctx.root });
  if (releases.status !== 0) warnings.push('could not list releases to look for a fresh corpus prerelease');
  else for (const row of JSON.parse(releases.stdout || '[]')) {
    const age = now - Date.parse(row.publishedAt);
    if (row.isPrerelease && /^corpus-sha256-/.test(row.tagName) && age < RECENT_PRERELEASE_MS) {
      warnings.push(`${row.tagName} is a prerelease published ${Math.round(age / 60000)} min ago — a newer generation may promote soon`);
    }
  }
  const runs = await ctx.deps.exec('gh', ['run', 'list', '--repo', ctx.repo, '--workflow', 'protected-release.yml', '--limit', '10', '--json', 'databaseId,displayTitle,status'], { cwd: ctx.root });
  if (runs.status !== 0) warnings.push('could not list protected-release runs to look for a corpus publish in flight');
  else for (const run of JSON.parse(runs.stdout || '[]')) {
    if (run.status !== 'completed' && /^protected-release corpus\b/.test(run.displayTitle || '')) {
      warnings.push(`corpus publish run ${run.databaseId} is ${run.status} — the newest generation may change under this release`);
    }
  }
  return warnings;
}

/** (e) every committed claim surface quotes the census of the newest generation. */
export async function censusCheck(ctx) {
  const generation = await targetGeneration(ctx);
  const [census, warnings] = await Promise.all([
    ctx.deps.census({ tag: generation.tag, bytes: generation.bytes }),
    corpusWarnings(ctx).catch((error) => [`corpus activity check failed: ${error.message}`]),
  ]);
  const { problems, surfaces } = await surfacesAgainst(ctx, 'HEAD', census);
  const summary = `${generation.tag} (${generation.origin}): ${census.publicStores} public stores, ${census.chunks.toLocaleString('en-US')} chunks`;
  return problems.length
    ? fail(`${summary}; stale surfaces: ${problems.join('; ')} — restamp with scripts/sync-census.mjs`, { warnings })
    : pass(`${summary}; all ${surfaces} surfaces agree`, { warnings });
}

/** (f) text-anchored mesh/mutation/regression/unit tests for changed source, plus changed tests and the test-file rules. */
export async function anchoredTests(ctx) {
  const base = (await git(ctx, ['merge-base', 'origin/main', 'HEAD'])).trim();
  const changed = lines(await git(ctx, ['diff', '--name-only', '--no-renames', base, 'HEAD']));
  const tracked = lines(await git(ctx, ['ls-tree', '-r', '--name-only', 'HEAD']));
  const trackedSet = new Set(tracked);
  const sources = changed.filter((file) => !file.startsWith('tests/') && trackedSet.has(file));
  const selected = new Set(changed.filter((file) => CHANGED_TEST.test(file) && trackedSet.has(file)));
  for (const file of tracked) {
    if (!file.endsWith('.test.mjs') || !ANCHOR_TEST_DIRS.some((dir) => file.startsWith(dir))) continue;
    const text = await ctx.deps.readFile(path.join(ctx.root, file));
    const anchors = file.startsWith('tests/unit/') ? sources.filter((source) => UNIT_ANCHOR_SOURCE.test(source) && !VERSION_SURFACE.test(source)) : sources;
    if (anchors.some((source) => text.includes(source))) selected.add(file);
  }
  if ([...selected].length) for (const rule of TEST_RULE_TESTS) if (trackedSet.has(rule)) selected.add(rule);
  const files = [...selected].sort();
  if (!files.length) return pass(`no anchored or changed tests for ${sources.length} changed source file(s)`, { files });
  const result = await ctx.deps.exec(process.execPath, [path.join(ctx.root, 'node_modules/vitest/vitest.mjs'), 'run', ...files], { cwd: ctx.root });
  return result.status === 0 ? pass(`${files.length} test file(s) passed: ${files.join(', ')}`, { files })
    : fail(`vitest exited ${result.status} on ${files.join(', ')}: ${tail(result)}`, { files });
}

// (h) THE CLOCK THE CI RUNNER HAS, NOT THE ONE THIS MAC HAS (4.7.26, preflight 41156104312).
// Tests that turn a clock into a calendar day passed on the owner's Mac (Eastern) for three releases and
// then failed on a UTC runner between 8 p.m. and midnight ET, when the two days differ. A local run can
// only see that if the test process's zone puts it on a different day than Eastern NOW, so these files
// run twice more: once in UTC (the runners' zone, at this hour) and once in a zone chosen so that its
// calendar day differs from the Eastern day at this moment, whatever the hour.
export const CLOCK_SENSITIVE_TEST = /etDay|America\/New_York|timeZone|process\.env\.TZ|toLocaleDateString|getTimezoneOffset|GIT_(?:COMMITTER|AUTHOR)_DATE|toISOString\(\)\.slice\(0, ?10\)|\.getDate\(\)|\.getHours\(\)|toDateString|Intl\.DateTimeFormat/;
export const CLOCK_TEST_DIRS = ['tests/unit/', 'tests/integration/'];
export const PRODUCT_ZONE = 'America/New_York';
// UTC+14 is a day ahead of Eastern from 06:00 ET onward; UTC-12 is a day behind until 08:00 ET.
export const DIVERGENT_ZONE_CANDIDATES = ['Pacific/Kiritimati', 'Etc/GMT+12'];
const DAY_FORMATS = new Map();
const dayIn = (zone, ms) => {
  if (!DAY_FORMATS.has(zone)) DAY_FORMATS.set(zone, new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return DAY_FORMATS.get(zone).format(ms);
};

/**
 * A zone whose calendar day differs from Eastern's at `ms` (always exists: the two candidates cover 24 h).
 * When both differ, the one that keeps differing longest wins, so a run of several minutes stays divergent.
 */
export function dayDivergentZone(ms) {
  const step = 15 * 60 * 1000;
  const divergesAt = (zone, at) => dayIn(zone, at) !== dayIn(PRODUCT_ZONE, at);
  const remaining = (zone) => {
    let t = ms;
    while (t - ms < 12 * 60 * 60 * 1000 && divergesAt(zone, t + step)) t += step;
    return t - ms;
  };
  const divergent = DIVERGENT_ZONE_CANDIDATES.filter((zone) => divergesAt(zone, ms));
  if (divergent.length < 2) return divergent[0] || null;
  return divergent.sort((a, b) => remaining(b) - remaining(a))[0];
}

export async function clockZones(ctx) {
  const tracked = lines(await git(ctx, ['ls-tree', '-r', '--name-only', 'HEAD']));
  const files = [];
  for (const file of tracked) {
    if (!file.endsWith('.test.mjs') || !CLOCK_TEST_DIRS.some((dir) => file.startsWith(dir))) continue;
    if (CLOCK_SENSITIVE_TEST.test(await ctx.deps.readFile(path.join(ctx.root, file)))) files.push(file);
  }
  files.sort();
  if (!files.length) return pass('no clock-sensitive tests', { files });
  const divergent = dayDivergentZone(ctx.deps.now());
  if (!divergent) return fail('no candidate zone is on a different day from Eastern now (unreachable)', { files });
  const zones = ['UTC', divergent];
  const runs = [];
  for (const zone of zones) {
    // One zone at a time: both runs use the same files and temp repos; side by side they only compete.
    runs.push({ zone, result: await ctx.deps.exec(process.execPath, [path.join(ctx.root, 'node_modules/vitest/vitest.mjs'), 'run', ...files],
      { cwd: ctx.root, env: { ...process.env, TZ: zone } }) });
  }
  const failed = runs.filter(({ result }) => result.status !== 0);
  const days = `Eastern ${dayIn(PRODUCT_ZONE, ctx.deps.now())}, UTC ${dayIn('UTC', ctx.deps.now())}, ${divergent} ${dayIn(divergent, ctx.deps.now())}`;
  return failed.length
    ? fail(`${files.length} clock-sensitive test file(s) fail with TZ=${failed.map(({ zone }) => zone).join(' and TZ=')} (${days}): ${failed.map(({ result }) => tail(result)).join(' || ')}`, { files })
    : pass(`${files.length} clock-sensitive test file(s) pass with TZ=UTC and TZ=${divergent} (${days})`, { files });
}

// (i) the deterministic UX gates the preflight's ux-qe lane runs on three OSes (4.7.26 lost a preflight
// to a console selector that changed while ux-qe was never run before the push). Same npm script as CI.
export async function uxGates(ctx) {
  if (!ctx.packageScripts['qe:ux']) return fail('package.json has no "qe:ux" script');
  const result = await ctx.deps.exec('npm', ['run', '--silent', 'qe:ux'], { cwd: ctx.root });
  return result.status === 0 ? pass('npm run qe:ux (the preflight ux-qe lane, this OS)')
    : fail(`npm run qe:ux exited ${result.status}: ${tail(result)} — a missing browser installs with npx playwright install chromium`);
}

/** (g) pre-dispatch: the generation the preflight sealed for SHA must still be the newest. */
export async function sealedGeneration(ctx) {
  const sha = ctx.sha;
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return fail('--pre-dispatch needs --sha <full 40-character commit>');
  const gh = async (args) => {
    const result = await ctx.deps.exec('gh', args, { cwd: ctx.root });
    if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${tail(result)}`);
    return result.stdout;
  };
  const runs = JSON.parse(await gh(['run', 'list', '--repo', ctx.repo, '--workflow', 'release-candidate-preflight.yml', '--commit', sha,
    '--limit', '20', '--json', 'databaseId,conclusion,status,event,headBranch,createdAt']));
  const green = runs.filter((run) => run.event === 'push' && run.conclusion === 'success' && RELEASE_BRANCH.test(run.headBranch || ''))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!green) return fail(`no successful release-candidate-preflight push run for ${sha.slice(0, 8)} on a release/* branch`);
  const newest = await targetGeneration(ctx);
  let sealed = null;
  const jobs = JSON.parse(await gh(['run', 'view', String(green.databaseId), '--repo', ctx.repo, '--json', 'jobs'])).jobs || [];
  const qe = jobs.find((job) => /(^|\/ )release-qe$/.test(job.name || ''));
  if (qe) {
    const log = await ctx.deps.exec('gh', ['run', 'view', '--repo', ctx.repo, '--job', String(qe.databaseId), '--log'], { cwd: ctx.root });
    if (log.status === 0) sealed = [...String(log.stdout).matchAll(SEED_LINE)].map((m) => m[2]).pop() || null;
  }
  if (sealed) {
    return sealed === newest.tag
      ? pass(`preflight run ${green.databaseId} sealed ${sealed}, still the newest generation`)
      : fail(`preflight run ${green.databaseId} sealed ${sealed}, but the newest generation is now ${newest.tag} — restamp the census, push, and re-run preflight`);
  }
  // Fallback when the job log is gone or reworded: the surfaces at SHA must quote the newest census.
  const census = await ctx.deps.census({ tag: newest.tag, bytes: newest.bytes });
  const { problems } = await surfacesAgainst(ctx, sha, census);
  return problems.length
    ? fail(`no sealed-generation line in preflight run ${green.databaseId}; surfaces at ${sha.slice(0, 8)} disagree with ${newest.tag}: ${problems.join('; ')}`)
    : pass(`no sealed-generation line in preflight run ${green.databaseId}; surfaces at ${sha.slice(0, 8)} equal the census of ${newest.tag} (fallback)`);
}
