// Test harness for the issue-autofix simulation (ADR-107): builds a throwaway "world" under a temp HOME — a bare
// file:// origin seeded from ./repo, a fixture "primary" checkout that must never be touched, a fake gh state
// file, fake claude script, stub gates — and runs the real orchestrator against it. Nothing here can reach a
// network, the real gh, the real claude or the developer's HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAutofix } from '../../../scripts/issue-autofix.mjs';
import { LOCAL_GATES } from '../../../scripts/issue-autofix-release.mjs';

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '../../..');
export const NOW = Date.UTC(2026, 9, 29, 14, 30, 0); // 10:30 EDT, a Thursday; the next corpus dispatch is 14 h away
export const HOURS = 3_600_000;
export const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sh = (cwd, ...args) => { const r = git(cwd, ...args); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };

export const humanIssue = (over = {}) => ({
  number: 7, title: 'slugify keeps punctuation in slugs', author: { login: 'alice' }, labels: [], state: 'OPEN',
  body: 'slugify("Hello, World!") returns "hello,-world!" but a URL slug should be "hello-world". The bug is in scripts/slugify.mjs.',
  createdAt: new Date(NOW - 3 * HOURS).toISOString(), updatedAt: new Date(NOW - 3 * HOURS).toISOString(), comments: [], ...over });
export const bobIssue = (over = {}) => humanIssue({ number: 8, title: 'titleCase leaves shouted words shouting', author: { login: 'bob' },
  body: "titleCase('HELLO world') gives 'HELLO World' but the rest of a shouted word should be lowercased. Lives in scripts/titlecase.mjs.",
  createdAt: new Date(NOW - 2 * HOURS).toISOString(), updatedAt: new Date(NOW - 2 * HOURS).toISOString(), ...over });

const CLEAN = { verdict: 'CLEAN', findings: [], summary: 'Nothing here reaches the network, a process, a credential or the file system.',
  present: { networkEgress: false, processExec: false, dynamicCode: false, credentialAccess: false, obfuscation: false, fsOutsideRepo: false, installHook: false } };
const verifyFor = (test, other) => ({ verdict: 'RESOLVED', summary: 'The new test fails on main and passes with the change.', risks: [], evidence: [
  { kind: 'test', file: test, line: 4, claim: 'the new test pins the reported behaviour', command: `npx vitest run ${test}` },
  { kind: 'code', file: other, line: 3, claim: 'the existing behaviour still holds', command: `npx vitest run ${other}` }] });

export const CANNED = {
  plan: { classification: 'fixable', rootCause: { file: 'scripts/slugify.mjs', line: 3, explanation: 'slugify only collapses whitespace, so punctuation survives.' },
    files: ['scripts/slugify.mjs'], testPlan: { newTests: ['tests/unit/slugify-punctuation.test.mjs'], failsBeforeFix: true }, risk: 'low',
    platformSpecific: [], injectionSuspected: false, summary: 'Strip punctuation before joining words.' },
  verify: verifyFor('tests/unit/slugify-punctuation.test.mjs', 'tests/unit/slugify.test.mjs'),
  redteam: CLEAN, redteamBatch: CLEAN,
  buildPatch: path.join(HERE, 'fix.patch'),
  byIssue: { 8: {
    plan: { classification: 'fixable', rootCause: { file: 'scripts/titlecase.mjs', line: 3, explanation: 'titleCase upper-cases the first letter but never lowers the rest.' },
      files: ['scripts/titlecase.mjs'], testPlan: { newTests: ['tests/unit/titlecase-shout.test.mjs'], failsBeforeFix: true }, risk: 'low',
      platformSpecific: [], injectionSuspected: false, summary: 'Lower-case the rest of each word.' },
    verify: verifyFor('tests/unit/titlecase-shout.test.mjs', 'tests/unit/titlecase.test.mjs'),
    buildPatch: path.join(HERE, 'fix-titlecase.patch') } },
  notes: {
    alice: { thanks: 'You gave the exact input `Hello, World!` together with the slug it produced, `hello,-world!`, and that pair made the cause plain within a minute. Pointing straight at scripts/slugify.mjs saved me the hunt as well.',
      perIssue: [{ number: 7, whatWasWrong: 'slugify only collapsed whitespace, so commas and exclamation marks stayed in the slug.',
        whatChanged: 'it now removes every character that is not a letter, digit, space or dash before joining words.', whatItNeeds: '' }] },
    bob: { thanks: "Your titleCase('HELLO world') example, set next to what it returns today, was all it took to see the problem; shouted input is a case I had simply never tried.",
      perIssue: [{ number: 8, whatWasWrong: 'titleCase raised the first letter of each word and left every other letter exactly as typed.',
        whatChanged: 'the rest of each word is now lower-cased as well.', whatItNeeds: '' }] },
  },
};

// Off macOS there is no sandbox-exec: the simulation still runs the tests (with a stripped environment) so the pipeline
// is exercised on Linux and Windows CI; the sandbox itself is proved by tests/unit/issue-autofix-sandbox.test.mjs on macOS.
const passThrough = (cmd, args, { cwd, timeoutMs } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env: { PATH: process.env.PATH, HOME: os.tmpdir(), CI: '1', NO_COLOR: '1', SystemRoot: process.env.SystemRoot } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT' };
};

export function makeWorld({ issues = [humanIssue()], script = {}, gh = {}, nowMs = NOW } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-sim-')));
  const home = path.join(tmp, 'home');
  const origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const primary = path.join(home, 'Code', 'ruvnet-brain');
  const bin = path.join(tmp, 'bin');
  for (const d of [home, bin, primary]) fs.mkdirSync(d, { recursive: true });
  fs.cpSync(path.join(HERE, 'repo'), seed, { recursive: true });
  fs.renameSync(path.join(seed, 'gitignore.txt'), path.join(seed, '.gitignore'));
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(seed, 'init', '-q', '-b', 'main');
  sh(seed, 'add', '-A');
  sh(seed, '-c', 'user.name=seed', '-c', 'user.email=seed@example.invalid', 'commit', '-qm', 'seed');
  sh(seed, 'push', '-q', origin, 'main');
  sh(primary, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(primary, 'README.md'), 'developer checkout\n');
  sh(primary, 'add', '-A');
  sh(primary, '-c', 'user.name=dev', '-c', 'user.email=dev@example.invalid', 'commit', '-qm', 'dev');
  fs.copyFileSync(path.join(HERE, 'fake-npm.mjs'), path.join(bin, 'npm'));
  fs.chmodSync(path.join(bin, 'npm'), 0o755);

  const files = { state: path.join(tmp, 'gh-state.json'), log: path.join(tmp, 'gh.log'), script: path.join(tmp, 'claude-script.json'),
    claudeLog: path.join(tmp, 'claude.log'), watch: path.join(home, 'issue-watch-state.json') };
  const write = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
  write(files.state, { variable: 'on', origin, issues, prs: [], activeRuns: [], preflight: 'success', prChecks: 'pass', releaseOutcome: 'success',
    publishOnRelease: true, releaseRuns: [], npmLatest: '9.9.9', releasesLatest: 'v9.9.9', nextVersion: '9.9.10', clockOffsetMs: nowMs - Date.now(), ...gh });
  write(files.script, { ...CANNED, ...script });
  fs.writeFileSync(files.log, ''); fs.writeFileSync(files.claudeLog, '');
  const paths = { clone: path.join(home, '.cache/autofix-repo'), worktrees: path.join(home, '.cache/wts'), state: files.watch,
    receipts: path.join(home, '.cache/runs'), offFile: path.join(home, '.config/issue-autofix.off'), haltFile: path.join(home, '.config/issue-autofix.halt'),
    holdFile: path.join(home, '.config/release-hold'), lock: path.join(home, 'issue-fix.lock'), primary };
  const env = { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_BIN: path.join(HERE, 'fake-gh.mjs'),
    CLAUDE_BIN: path.join(HERE, 'fake-claude.mjs'), AUTOFIX_SIMULATE_ORIGIN: `file://${origin}`, NTFY_TOPIC: '', ISSUE_WATCH_STATE: files.watch };
  // runAgent (scripts/issue-autofix-agents.mjs) spawns with process.env, so the fakes' knobs live there too.
  const fakeEnv = { FAKE_GH_STATE: files.state, FAKE_GH_LOG: files.log, FAKE_CLAUDE_SCRIPT: files.script, FAKE_CLAUDE_LOG: files.claudeLog };
  Object.assign(env, fakeEnv);

  const pages = []; const commands = [];
  const gates = Object.fromEntries([...LOCAL_GATES.map(([name]) => name), 'release-prepush-dispatch'].map((name) => [name, async () => ({ exitCode: 0, output: `${name} ok` })]));
  const world = {
    tmp, home, origin, primary, paths, env, files, pages, commands, gates, seed,
    read: (f) => JSON.parse(fs.readFileSync(f, 'utf8')),
    ghState: () => world.read(files.state),
    setGh: (patch) => write(files.state, { ...world.ghState(), ...patch }),
    setScript: (patch) => write(files.script, { ...world.read(files.script), ...patch }),
    ghCalls: () => fs.readFileSync(files.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    claudeCalls: () => fs.readFileSync(files.claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    ghWrites: () => world.ghCalls().filter((c) => ['comment', 'close', 'edit'].includes(c.argv[1]) && c.argv[0] === 'issue'),
    originRef: (ref) => git(origin, 'rev-parse', '--verify', '-q', ref).stdout.trim(),
    primaryFingerprint: () => ['rev-parse HEAD', 'status --porcelain', 'worktree list', 'for-each-ref'].map((a) => git(primary, ...a.split(' ')).stdout).join('|')
      + fs.readFileSync(path.join(primary, '.git/index')).toString('hex'),
    receipts: () => fs.existsSync(paths.receipts) ? fs.readdirSync(paths.receipts).filter((f) => f.endsWith('.json')).sort().map((f) => world.read(path.join(paths.receipts, f))) : [],
    async run({ now = nowMs, dryRun = true, simulate = true, rehearse = null, deps = {}, env: extra = {} } = {}) {
      const before = commands.length;
      world.setGh({ clockOffsetMs: now - Date.now() }); // the fake gh stamps runs and comments on the same clock as this run
      const receipt = await runAutofix({ now, dryRun, simulate, rehearse, env: { ...env, ...extra }, deps: { paths, gates, governed0103: [],
        ...(process.platform === 'darwin' ? {} : { runSandboxed: passThrough }),
        nodeModules: path.join(ROOT, 'node_modules'), sleep: async () => {}, onCommand: (l) => commands.push(l),
        notify: (title, body, priority) => { pages.push({ title, body, priority }); return 0; },
        release: { stampCensus: async () => ({ changed: false, files: [] }), stamp0103Review: async () => ({ digest: 'sim', rowAdded: false }) }, ...deps } });
      return { receipt, commands: commands.slice(before) };
    },
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
  return world;
}

/** Installs the fakes' env on process.env for the duration of a test file and returns the restore function. */
export function adoptEnv(world) {
  const keys = ['FAKE_GH_STATE', 'FAKE_GH_LOG', 'FAKE_CLAUDE_SCRIPT', 'FAKE_CLAUDE_LOG'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = world.env[k];
  return () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
}
