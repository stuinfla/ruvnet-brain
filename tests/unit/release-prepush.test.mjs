// The release pre-push gate (scripts/release-prepush.mjs) driven through its seams: no real git, gh,
// network or vitest. The census fixtures are the two real generations measured on 2026-10-30:
// corpus-sha256-e93bba70… = 206 public stores / 171,583 chunks; corpus-sha256-068fffd4… = 206 / 171,869.
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main, runPrepush } from '../../scripts/release-prepush.mjs';
import { CLOCK_SENSITIVE_TEST, DIVERGENT_ZONE_CANDIDATES, PRODUCT_ZONE, STATIC_GATES, STRAY_PATTERNS, dayDivergentZone, strayFindings,
  surfaceCensusProblems } from '../../scripts/release-prepush-checks.mjs';
import * as claims from '../../scripts/claims-verify.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = '/fixture/repo';
const E93 = { tag: `corpus-sha256-e93bba70${'0'.repeat(56)}`, publicStores: 206, chunks: 171583 };
const F06 = { tag: `corpus-sha256-068fffd4${'0'.repeat(56)}`, publicStores: 206, chunks: 171869 };
const SHA = 'a'.repeat(40);
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const surface = (chunks, stores) => `RuvNet Brain: ${chunks.toLocaleString('en-US')} chunks across ${stores} public stores.\n`;

/** A scripted world: git answers from `repo`, gh from `gh`, node/vitest from `node`. Every call is recorded. */
function world(over = {}) {
  const repo = {
    branch: 'release/9.8.7', version: '9.8.7', dirty: '', added: [], changed: [], sizes: {}, rootAtMain: ['README.md', 'package.json'],
    tracked: ['README.md', 'package.json', 'tests/unit/a.test.mjs', 'tests/mesh/coexistence.test.mjs', 'tests/mutation/m.test.mjs', 'bin/install.mjs'],
    surfaces: Object.fromEntries(claims.CHUNK_SURFACES.map((file) => [file, surface(171583, 206)])),
    files: { 'tests/mesh/coexistence.test.mjs': "const INSTALLER = path.join(REPO_ROOT, 'bin/install.mjs');", 'tests/mutation/m.test.mjs': 'nothing' },
    ...over.repo,
  };
  const calls = [];
  const zones = [];
  const gh = { releases: [], runs: [], preflight: [], jobs: [], log: '', ...over.gh };
  const nodeStatus = over.nodeStatus || {};
  const exec = async (command, args, options = {}) => {
    calls.push([command, ...args]);
    if (command === process.execPath && args.some((a) => a.includes('vitest'))) zones.push(options.env?.TZ ?? null);
    const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') {
      const [sub, ...rest] = args;
      if (sub === 'remote') return ok('https://github.com/owner/name.git\n');
      if (sub === 'rev-parse' && rest[0] === '--abbrev-ref') return ok(`${repo.branch}\n`);
      if (sub === 'rev-parse') return ok(`${SHA}\n`);
      if (sub === 'status') return ok(repo.dirty);
      if (sub === 'merge-base') return ok(`${'b'.repeat(40)}\n`);
      if (sub === 'diff') return ok((args.includes('--diff-filter=A') ? repo.added : repo.changed).join('\n'));
      if (sub === 'ls-tree' && rest[0] === '--name-only') return ok(repo.rootAtMain.join('\n'));
      if (sub === 'ls-tree' && rest.includes('-l')) return ok(repo.tracked.map((f) => `100644 blob ${'c'.repeat(40)} ${repo.sizes[f] ?? 10}\t${f}`).join('\n'));
      if (sub === 'ls-tree') return ok(repo.tracked.join('\n'));
      if (sub === 'show' && rest[0] === 'HEAD:package.json') return ok(JSON.stringify({ version: repo.version }));
      if (sub === 'show') return ok(repo.surfaces[rest[0].split(':').slice(1).join(':')] ?? '');
    }
    if (command === 'gh') {
      if (args[0] === 'release') return ok(JSON.stringify(gh.releases));
      if (args[0] === 'run' && args[1] === 'list' && args.includes('protected-release.yml')) return ok(JSON.stringify(gh.runs));
      if (args[0] === 'run' && args[1] === 'list') return ok(JSON.stringify(gh.preflight));
      if (args[0] === 'run' && args.includes('--log')) return ok(gh.log);
      if (args[0] === 'run' && args[1] === 'view') return ok(JSON.stringify({ jobs: gh.jobs }));
    }
    if (command === process.execPath) {
      const key = args.find((a) => a.includes('vitest')) || args.find((a) => a.endsWith('.mjs')) || args[0];
      const zoned = over.zoneStatus && options.env?.TZ ? over.zoneStatus[options.env.TZ] : undefined;
      const status = zoned ?? nodeStatus[path.basename(key)] ?? 0;
      return { status, stdout: 'ran', stderr: status ? 'boom' : '' };
    }
    if (command === 'npm' && args.includes('qe:ux')) return { status: over.uxStatus ?? 0, stdout: '', stderr: over.uxStatus ? 'render probe error' : '' };
    return { status: 1, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` };
  };
  const deps = {
    exec,
    now: () => Date.parse('2026-10-30T12:00:00Z'),
    readFile: async (file) => {
      if (file.endsWith('package.json')) return JSON.stringify({ scripts: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts });
      return repo.files[path.relative(ROOT, file)] ?? '';
    },
    importModule: async (file) => (file.endsWith('claims-verify.mjs') ? claims : over.plan || {
      qualificationPlan: (suite, platform) => ({ files: suite === 'source' ? ['tests/unit/a.test.mjs'] : [`tests/unit/a.test.mjs`].filter(() => platform !== 'x') }),
    }),
    resolveSeed: async () => ({ origin: 'published-generation', tag: (over.newest || E93).tag, bytes: 1 }),
    census: async ({ tag }) => [E93, F06].find((row) => row.tag === tag),
    ...over.deps,
  };
  return { deps, calls, zones };
}
const run = (w, extra = {}) => runPrepush({ root: ROOT, deps: w.deps, ...extra });
const byName = (result) => Object.fromEntries(result.checks.map((check) => [check.name, check]));

it('passes a clean release branch whose surfaces quote the newest generation, timing every check', async () => {
  const w = world();
  const result = await run(w);
  expect(result.ok).toBe(true);
  expect(result.checks.map((c) => c.name)).toEqual(['branch-identity', ...STATIC_GATES.map((g) => g.name),
    'qualification-inventory', 'stray-artifacts', 'census', 'anchored-tests', 'clock-zones', 'ux-gates']);
  for (const check of result.checks) expect(Number.isInteger(check.ms)).toBe(true);
  // Commands come from package.json: version:check is `node scripts/sync-version.mjs --check`.
  expect(w.calls).toContainEqual([process.execPath, 'scripts/sync-version.mjs', '--check']);
  expect(w.calls).toContainEqual([process.execPath, 'scripts/architecture-review-lock.mjs']);
});

it('collects EVERY failure rather than stopping at the first', async () => {
  const w = world({ repo: { branch: 'release/4.7.22', dirty: ' M README.md\n', added: ['agentdb.rvf.idmap.json'], tracked: ['README.md'] },
    nodeStatus: { 'architecture-review-lock.mjs': 1, 'convergence-manifest.mjs': 1 }, newest: F06 });
  const result = byName(await run(w));
  expect(Object.values(result).filter((c) => !c.ok).map((c) => c.name).sort())
    .toEqual(['architecture-review-lock', 'branch-identity', 'census', 'convergence-check', 'qualification-inventory', 'stray-artifacts']);
  expect(result['branch-identity'].detail).toMatch(/4\.7\.22 but package\.json says 9\.8\.7.*tracked change/);
  expect(result['stray-artifacts'].detail).toMatch(/agentdb\.rvf\.idmap\.json: new root-level file/);
  expect(result['qualification-inventory'].detail).toMatch(/tests\/unit\/a\.test\.mjs is not tracked/);
});

it('census: e93bba70 stamps pass against e93bba70 and fail against 068fffd4 naming file, old, new and generation', async () => {
  expect((await run(world({ newest: E93 }))).ok).toBe(true);
  const stale = byName(await run(world({ newest: F06 }))).census;
  expect(stale.ok).toBe(false);
  expect(stale.detail).toContain(F06.tag);
  expect(stale.detail).toContain('README.md: chunk count 171,583 -> 171,869');
  expect(stale.detail).toContain('README.md: chunk count 171,869 absent');
  const fresh = Object.fromEntries(claims.CHUNK_SURFACES.map((f) => [f, surface(171869, 206)]));
  expect((await run(world({ newest: F06, repo: { surfaces: fresh } }))).ok).toBe(true);
  // --generation names the generation for a replay instead of resolving the newest.
  expect(byName(await run(world({ newest: E93 }), { generation: F06.tag })).census.ok).toBe(false);
});

it('applies claims-verify surface rules exactly: public-store drift, and a counter attribute', () => {
  const problems = surfaceCensusProblems('x', '<span data-count="171583">171,583</span> chunks · 205 public stores', E93, claims);
  expect(problems).toEqual(['x: public-store count 205 -> 206']);
  expect(surfaceCensusProblems('x', '<span data-count="171500">171,583</span> chunks', E93, claims)).toEqual(['x: chunk counter 171,500 -> 171,583']);
});

it('warns (never fails) on a fresh corpus prerelease or a corpus publish in flight', async () => {
  const w = world({ gh: { releases: [{ tagName: F06.tag, isPrerelease: true, publishedAt: '2026-10-30T11:00:00Z' }],
    runs: [{ databaseId: 7, displayTitle: 'protected-release corpus corpus-1-1', status: 'in_progress' }] } });
  const census = byName(await run(w)).census;
  expect(census.ok).toBe(true);
  expect(census.warnings.join('\n')).toMatch(/prerelease published 60 min ago[\s\S]*run 7 is in_progress/);
});

it('selects text-anchored mesh/mutation tests for changed source plus changed tests, and fails when they fail', async () => {
  const w = world({ repo: { changed: ['bin/install.mjs', 'tests/unit/a.test.mjs'] } });
  const tests = byName(await run(w))['anchored-tests'];
  expect(tests.files).toEqual(['tests/mesh/coexistence.test.mjs', 'tests/unit/a.test.mjs']);
  const vitest = w.calls.find((c) => c[0] === process.execPath && c.some((a) => a.includes('vitest')));
  expect(vitest.slice(-3)).toEqual(['run', 'tests/mesh/coexistence.test.mjs', 'tests/unit/a.test.mjs']);
  const red = world({ repo: { changed: ['bin/install.mjs'] }, nodeStatus: { 'vitest.mjs': 1 } });
  expect(byName(await run(red))['anchored-tests'].ok).toBe(false);
  expect(byName(await run(world({ repo: { changed: ['README.md'] } })))['anchored-tests']).toMatchObject({ ok: true, files: [] });
});

it('clock-zones: clock-sensitive tests run in UTC and in a zone on a different day than Eastern, and fail in either', async () => {
  const files = { 'tests/unit/day.test.mjs': 'const TODAY = policy.etDay(Date.now());', 'tests/unit/plain.test.mjs': 'expect(1).toBe(1);',
    'tests/mesh/coexistence.test.mjs': 'nothing', 'tests/mutation/m.test.mjs': 'nothing' };
  const tracked = ['README.md', 'package.json', 'tests/unit/day.test.mjs', 'tests/unit/plain.test.mjs', 'tests/unit/a.test.mjs'];
  const plan = { qualificationPlan: () => ({ files: [] }) };
  const w = world({ repo: { files, tracked }, plan });
  const check = byName(await run(w))['clock-zones'];
  expect(check).toMatchObject({ ok: true, files: ['tests/unit/day.test.mjs'] });
  // 2026-10-30T12:00Z is 08:00 ET: Kiritimati (UTC+14) is already on the 31st.
  expect(w.zones).toEqual(['UTC', 'Pacific/Kiritimati']);
  expect(check.detail).toMatch(/Eastern 2026-10-30, UTC 2026-10-30, Pacific\/Kiritimati 2026-10-31/);
  for (const zone of ['UTC', 'Pacific/Kiritimati']) {
    const red = byName(await run(world({ repo: { files, tracked }, plan, zoneStatus: { [zone]: 1 } })))['clock-zones'];
    expect(red.ok, zone).toBe(false);
    expect(red.detail).toContain(`TZ=${zone}`);
  }
});

it('a divergent zone exists at every quarter hour of the year, and a child process in it really is on another day', () => {
  for (let ms = Date.parse('2026-01-01T00:00:00Z'); ms < Date.parse('2027-01-01T00:00:00Z'); ms += 15 * 60 * 1000) {
    const zone = dayDivergentZone(ms);
    expect(DIVERGENT_ZONE_CANDIDATES).toContain(zone);
    const day = (z) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
    if (day(zone) === day(PRODUCT_ZONE)) throw new Error(`${zone} shares Eastern's day at ${new Date(ms).toISOString()}`);
  }
  const now = Date.now();
  const local = execFileSync(process.execPath, ['-e', 'const d = new Date(); console.log(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"))'],
    { encoding: 'utf8', env: { ...process.env, TZ: dayDivergentZone(now) } }).trim();
  const eastern = new Intl.DateTimeFormat('en-CA', { timeZone: PRODUCT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
  // Within a second of a day boundary the two reads can straddle midnight; the zone choice itself is checked above.
  if (Math.abs(Date.now() - now) < 1000) expect(local).not.toBe(eastern);
  // The 4.7.26 test that failed on a UTC runner reads exactly this kind of day.
  expect(CLOCK_SENSITIVE_TEST.test(fs.readFileSync(path.join(REPO_ROOT, 'tests/unit/issue-autofix-release.test.mjs'), 'utf8'))).toBe(true);
});

it('ux-gates runs the preflight ux-qe lane script and fails when it fails', async () => {
  const w = world();
  expect(byName(await run(w))['ux-gates'].ok).toBe(true);
  expect(w.calls).toContainEqual(['npm', 'run', '--silent', 'qe:ux']);
  const red = byName(await run(world({ uxStatus: 1 })))['ux-gates'];
  expect(red.ok).toBe(false);
  expect(red.detail).toMatch(/qe:ux exited 1: render probe error/);
});

it('stray patterns are anchored: real offenders hit, legitimate lookalikes do not, and no tracked file matches', () => {
  const offenders = ['.swarm/memory.db', 'a/.swarm/x.json', 'x.db', 'x.db-wal', 'x.db-shm', '.claude/settings.local.json',
    '.claude/settings.local.json.ak-aqe-backup.1', 'CLAUDE.md.bak-20260926', 'x.bak', '.opencode/a', '.vscode/settings.json'];
  for (const file of offenders) expect(STRAY_PATTERNS.some((rule) => rule.re.test(file)), file).toBe(true);
  for (const file of ['kb/l2/agentdb.md', 'plugin/scripts/package-cards.rvf', 'docs/backup.md', 'src/bakery.mjs', 'x.dbml', 'kb/agentdb.rvf.idmap.json', 'scripts/hive.swarm-plan.mjs']) {
    expect(STRAY_PATTERNS.some((rule) => rule.re.test(file)), file).toBe(false);
  }
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  expect(tracked.length).toBeGreaterThan(1000);
  expect(tracked.filter((file) => STRAY_PATTERNS.some((rule) => rule.re.test(file)))).toEqual([]);
  const big = strayFindings(['data/x.bin', 'NEW.md', 'README.md'], { rootFilesAtMain: new Set(['README.md']), sizes: new Map([['data/x.bin', 6 * 1048576]]) });
  expect(big).toEqual(['data/x.bin: 6.0 MB added (limit 5 MB)', 'NEW.md: new root-level file (absent at origin/main)']);
});

it('pre-dispatch: the sealed generation must still be the newest, read from the release-qe log, else from the surfaces', async () => {
  const preflight = [{ databaseId: 11, conclusion: 'success', status: 'completed', event: 'push', headBranch: 'release/9.8.7', createdAt: '2026-10-30T04:00:00Z' }];
  const jobs = [{ databaseId: 99, name: 'ci / release-qe' }];
  const log = `ci / release-qe\tUNKNOWN STEP\t2026-10-30T04:56:15Z [corpus-next-seed] published-generation ${E93.tag} (judged 1)`;
  const same = await run(world({ gh: { preflight, jobs, log }, newest: E93 }), { preDispatch: true, sha: SHA });
  expect(same.checks.map((c) => c.name)).toEqual(['sealed-generation']);
  expect(same.ok).toBe(true);
  const moved = await run(world({ gh: { preflight, jobs, log }, newest: F06 }), { preDispatch: true, sha: SHA });
  expect(moved.ok).toBe(false);
  expect(moved.checks[0].detail).toMatch(/sealed corpus-sha256-e93bba70.*newest generation is now corpus-sha256-068fffd4/);
  const fallback = await run(world({ gh: { preflight, jobs, log: '' }, newest: E93 }), { preDispatch: true, sha: SHA });
  expect(fallback.checks[0]).toMatchObject({ ok: true });
  expect(fallback.checks[0].detail).toMatch(/fallback/);
  expect((await run(world({ gh: { preflight, jobs, log: '' }, newest: F06 }), { preDispatch: true, sha: SHA })).ok).toBe(false);
  expect((await run(world({ gh: { preflight: [{ ...preflight[0], conclusion: 'failure' }], jobs, log } }), { preDispatch: true, sha: SHA })).ok).toBe(false);
  expect((await run(world(), { preDispatch: true, sha: 'abc' })).checks[0].detail).toMatch(/40-character/);
});

it('CLI writes a JSON receipt, exits 1 on failure and 2 on a bad argument', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prepush-')); dirs.push(dir);
  const out = [];
  const stdout = { write: (s) => out.push(s) };
  const receipt = path.join(dir, 'r.json');
  const code = await main(['--receipt', receipt, '--repo', 'owner/name'], { stdout, stderr: stdout, deps: world({ newest: F06 }).deps, root: ROOT });
  expect(code).toBe(1);
  const written = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  expect(written).toMatchObject({ kind: 'ruvnet-brain-release-prepush', mode: 'pre-push', ok: false, head: SHA });
  expect(written.checks.find((c) => c.name === 'census').ok).toBe(false);
  expect(out.join('')).toMatch(/FAIL {2}census[\s\S]*\[release:prepush\] FAIL \(1: census\)/);
  expect(await main(['--bogus'], { stdout, stderr: stdout })).toBe(2);
  expect(await main(['--sha', SHA], { stdout, stderr: stdout })).toBe(2);
  expect(await main(['--receipt', path.join(dir, 'ok.json')], { stdout, stderr: stdout, deps: world().deps, root: ROOT })).toBe(0);
});

it('is importable in-process by another release path (no top-level side effects)', async () => {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/release-prepush.mjs')).href);
  expect(typeof mod.runPrepush).toBe('function');
});
