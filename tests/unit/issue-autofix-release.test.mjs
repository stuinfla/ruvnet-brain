import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as policy from '../../scripts/issue-autofix-policy.mjs';
import * as rel from '../../scripts/issue-autofix-release.mjs';
import { assertCleanText, sanitizeTitle, parseUnifiedDiff, nextCorpusDispatch } from '../../scripts/issue-autofix-release-util.mjs';
import { makeRepos, makeCtx, makeReleaseWorktree, realGit, write, head, allCalls, isForbidden, REPO } from './issue-autofix-release-harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCES = ['scripts/issue-autofix-release.mjs', 'scripts/issue-autofix-release-ship.mjs', 'scripts/issue-autofix-release-util.mjs'];
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s*#\d+/i;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const FORBIDDEN_SOURCE = [/--force/, /force-with-lease/, /\+refs\//, /['"`]-f['"`]/, /['"`]merge['"`]/, /\/merge/, /child_process/, /pr merge/];
const violations = (src) => FORBIDDEN_SOURCE.filter((re) => re.test(stripComments(src))).map(String);
const CONTRACT = 'scripts/release-qualification-contract.mjs';
const ADR = 'docs/adr/0103-routing-architecture-review-lock.md';
const ADR_TEXT = `---
id: ADR-103
title: Fixture review lock
status: Accepted
date: 2026-10-01
updated: 2026-10-01
version: 0.1.0
impl: built
governs:
  - package.json
  - package-lock.json
  - scripts/release-qualification-contract.mjs
---

# Fixture

## Decision

Governed files need a current review.

## Currency log

| 2026-10-01 | Created. | \`src/a.js\` is governed. |
`;

afterAll(() => { for (const c of allCalls) expect(isForbidden(c.cmd, c.args), `${c.cmd} ${c.args.join(' ')}`).toBe(false); });

describe('static rails over the executable source', () => {
  it('no force, +refs, -f, merge call, merge endpoint, or direct child_process in any release module', () => {
    for (const f of SOURCES) expect(violations(fs.readFileSync(path.join(ROOT, f), 'utf8')), f).toEqual([]);
  });
  it('each rail pattern can fail: planted violations are detected (the grep is not vacuous)', () => {
    for (const bad of ["a(['push', '--force'])", "push('+refs/heads/main')", "['push','-f']", "gh(['pr','merge'])", "'/repos/x/pulls/1/merge'", "import 'node:child_process'", 'git push --force-with-lease']) {
      expect(violations(bad), bad).not.toEqual([]);
    }
  });
  it('every source file is under 500 lines', () => {
    for (const f of SOURCES) expect(fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').length, f).toBeLessThan(500);
  });
});

describe('closing keywords and attribution never leave', () => {
  it('assertCleanText refuses a planted "Fixes #12" and a co-author trailer', () => {
    expect(() => assertCleanText('S6', 'Fixes #12')).toThrow(/closing keyword/);
    expect(() => assertCleanText('S6', 'resolved: #3')).toThrow();
    expect(() => assertCleanText('S6', 'x\n\nCo-Authored-By: A <a@b.c>')).toThrow(/co-author/);
    expect(() => assertCleanText('S6', 'Refs issue 12 (ADR-107 autofix).')).not.toThrow();
  });
  it('sanitizeTitle strips # and control characters so a hostile title cannot smuggle a keyword', () => {
    const t = sanitizeTitle('Fixes #12\nCloses #13 \u0007now');
    expect(t).not.toMatch(/#/);
    expect(CLOSING.test(t)).toBe(false);
  });
  it('commitFix: per-command identity, no trailer, no keyword, no repo config written', async () => {
    const repos = makeRepos();
    const wt = path.join(repos.worktrees, 'fix-5');
    realGit(repos.clone, ['worktree', 'add', '-b', 'autofix/issue-5', wt, 'origin/main']);
    write(path.join(wt, 'src/a.js'), 'export const a = 3;\n');
    const e = makeCtx(repos);
    const { fixSha } = await rel.commitFix(e.ctx, { wt, issueNumber: 5, title: 'Fixes #12: crash on start @mallory' }); // a stray title is ignored
    expect(fixSha).toBe(head(wt));
    const commit = e.calls.find((c) => c.args.includes('commit'));
    expect(commit.args).toEqual(expect.arrayContaining(['-c', 'user.name=RuvNet Brain Autofix', '-c', 'user.email=stuinfla@users.noreply.github.com']));
    const msg = realGit(wt, ['log', '-1', '--format=%an <%ae>%n%B']).stdout;
    expect(msg).toContain('RuvNet Brain Autofix <stuinfla@users.noreply.github.com>');
    expect(msg).toContain('Refs issue 5 (ADR-107 autofix).');
    expect(realGit(wt, ['log', '-1', '--format=%s']).stdout.trim()).toBe('autofix: issue 5'); // the number only, never a stranger's title
    expect(msg).not.toMatch(/crash on start|mallory/);
    expect(/co-authored-by/i.test(msg)).toBe(false);
    expect(CLOSING.test(msg)).toBe(false);
    expect(msg).not.toMatch(/#/);
    expect(realGit(repos.clone, ['config', '--local', '--get', 'user.name']).status).not.toBe(0);
  });
  it('commitFix refuses an empty fix', async () => {
    const repos = makeRepos();
    const wt = path.join(repos.worktrees, 'fix-6');
    realGit(repos.clone, ['worktree', 'add', '-b', 'autofix/issue-6', wt, 'origin/main']);
    await expect(rel.commitFix(makeCtx(repos).ctx, { wt, issueNumber: 6 })).rejects.toMatchObject({ code: 'diff-policy' });
  });
  it('commitFix refuses a bad issue number before touching git', async () => {
    const repos = makeRepos();
    const e = makeCtx(repos);
    for (const n of [0, -1, '5', 1.5, undefined]) await expect(rel.commitFix(e.ctx, { wt: repos.clone, issueNumber: n })).rejects.toMatchObject({ code: 'diff-policy' });
    expect(e.calls).toEqual([]);
  });
});

describe('prepareReleaseBranch (S6)', () => {
  const npm = (repos) => (cmd, args, opts) => {
    if (cmd !== 'npm') return null;
    if (args[0] === 'run' && args[1] === 'version:set') {
      for (const f of ['package.json', 'package-lock.json', 'plugin/.claude-plugin/plugin.json']) {
        const p = path.join(opts.cwd, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/"version": "[^"]+"/, `"version": "${args[3]}"`));
      }
    }
    return '';
  };
  async function fixCommit(repos, n = 5, file = 'src/a.js', text = 'export const a = 3;\n') {
    const wt = path.join(repos.worktrees, `fix-${n}`);
    realGit(repos.clone, ['worktree', 'add', '-b', `autofix/issue-${n}`, wt, 'origin/main']);
    write(path.join(wt, file), text);
    return (await rel.commitFix(makeCtx(repos).ctx, { wt, issueNumber: n })).fixSha;
  }

  it('creates release/X.Y.Z off origin/main: version commit first, then the cherry-picked fix, all with the autofix identity', async () => {
    const repos = makeRepos();
    const fixSha = await fixCommit(repos);
    const e = makeCtx(repos, { handler: npm(repos) });
    const r = await rel.prepareReleaseBranch(e.ctx, { version: '1.0.1', fixes: [{ issueNumber: 5, fixSha }] });
    expect(r.branch).toBe('release/1.0.1');
    expect(r.commits).toHaveLength(2);
    expect(r).toMatchObject({ applied: [5], dropped: [], fixBase: r.commits[0], fixHead: r.commits[1] });
    expect(r.fixHead).toBe(head(r.rwt));
    const subjects = realGit(r.rwt, ['log', '--reverse', '--format=%s%n%an|%ae', 'origin/main..HEAD']).stdout;
    expect(subjects).toContain('chore(release): 1.0.1 (autofix, issues 5)');
    expect(subjects).toContain('autofix: issue 5');
    expect(subjects).toContain('RuvNet Brain Autofix|stuinfla@users.noreply.github.com');
    expect(fs.readFileSync(path.join(r.rwt, 'plugin/.claude-plugin/plugin.json'), 'utf8')).toContain('1.0.1');
    expect(fs.readFileSync(path.join(r.rwt, 'src/a.js'), 'utf8')).toContain('= 3');
    const seq = [/^npm ci --no-audit --no-fund/, /^npm run version:set -- 1\.0\.1/, /^npm run convergence:write/].map((re) => e.find(re));
    expect(seq.every((i) => i >= 0) && seq[0] < seq[1] && seq[1] < seq[2]).toBe(true);
    const log = realGit(r.rwt, ['log', 'origin/main..HEAD', '--format=%B']).stdout;
    expect(CLOSING.test(log) || /co-authored-by/i.test(log)).toBe(false);
  });

  it('refuses when the branch already exists on the remote, or locally', async () => {
    const repos = makeRepos();
    const fixSha = await fixCommit(repos);
    realGit(repos.seed, ['push', 'origin', 'HEAD:refs/heads/release/1.0.1']);
    await expect(rel.prepareReleaseBranch(makeCtx(repos, { handler: npm(repos) }).ctx, { version: '1.0.1', fixes: [{ issueNumber: 5, fixSha }] }))
      .rejects.toMatchObject({ code: 'branch-exists' });
    const repos2 = makeRepos();
    const fix2 = await fixCommit(repos2);
    realGit(repos2.clone, ['branch', 'release/1.0.1', 'origin/main']);
    await expect(rel.prepareReleaseBranch(makeCtx(repos2, { handler: npm(repos2) }).ctx, { version: '1.0.1', fixes: [{ issueNumber: 5, fixSha: fix2 }] }))
      .rejects.toMatchObject({ code: 'branch-exists' });
  });

  it('refuses a version that is not main + one patch (main moved)', async () => {
    const repos = makeRepos();
    const fixSha = await fixCommit(repos);
    await expect(rel.prepareReleaseBranch(makeCtx(repos, { handler: npm(repos) }).ctx, { version: '1.0.5', fixes: [{ issueNumber: 5, fixSha }] }))
      .rejects.toMatchObject({ code: 'main-moved' });
  });

  it('several fixes: version commit, then each fix in order; one that does not apply is dropped and the pick aborted', async () => {
    const repos = makeRepos();
    const f5 = await fixCommit(repos, 5);
    const f6 = await fixCommit(repos, 6, 'src/b.js', 'export const b = 1;\n');
    const f7 = await fixCommit(repos, 7, 'src/a.js', 'export const a = 7;\n'); // conflicts with issue 5's edit of the same line
    const e = makeCtx(repos, { handler: npm(repos) });
    const r = await rel.prepareReleaseBranch(e.ctx, { version: '1.0.1', fixes: [{ issueNumber: 5, fixSha: f5 }, { issueNumber: 6, fixSha: f6 }, { issueNumber: 7, fixSha: f7 }] });
    expect(r.applied).toEqual([5, 6]);
    expect(r.dropped).toEqual([expect.objectContaining({ issueNumber: 7, reason: expect.stringMatching(/does not apply/) })]);
    expect(r.commits).toHaveLength(3);
    expect(realGit(r.rwt, ['log', '--reverse', '--format=%s', 'origin/main..HEAD']).stdout.trim().split('\n'))
      .toEqual(['chore(release): 1.0.1 (autofix, issues 5, 6, 7)', 'autofix: issue 5', 'autofix: issue 6']);
    expect(e.count(/cherry-pick --abort/)).toBe(1);
    expect(realGit(r.rwt, ['status', '--porcelain']).stdout.trim()).toBe(''); // no half-applied pick left behind
    expect(fs.readFileSync(path.join(r.rwt, 'src/a.js'), 'utf8')).toContain('= 3');
  });
  it('refuses no fixes, a bad fix sha or a bad issue number before any git call', async () => {
    const repos = makeRepos();
    const e = makeCtx(repos, { handler: npm(repos) });
    await expect(rel.prepareReleaseBranch(e.ctx, { version: '1.0.1', fixes: [] })).rejects.toMatchObject({ code: 'diff-policy' });
    await expect(rel.prepareReleaseBranch(e.ctx, { version: '1.0.1', fixes: [{ issueNumber: 5, fixSha: 'HEAD' }] })).rejects.toMatchObject({ code: 'diff-policy' });
    await expect(rel.prepareReleaseBranch(e.ctx, { version: '1.0.1', fixes: [{ issueNumber: 0, fixSha: 'a'.repeat(40) }] })).rejects.toMatchObject({ code: 'diff-policy' });
    await expect(rel.prepareReleaseBranch(e.ctx, { version: 'v1.0.1', fixes: [{ issueNumber: 5, fixSha: 'a'.repeat(40) }] })).rejects.toMatchObject({ code: 'branch-exists' });
    expect(e.calls).toEqual([]);
  });
  it('a failing cherry-pick aborts the pick and reports gate-failed when no fix applied at all', async () => {
    const repos = makeRepos();
    const fixSha = await fixCommit(repos);
    const conflicting = (cmd, args, opts) => {
      if (cmd === 'npm' && args[1] === 'version:set') { write(path.join(opts.cwd, 'src/a.js'), 'export const a = 99;\n'); }
      return npm(repos)(cmd, args, opts);
    };
    await expect(rel.prepareReleaseBranch(makeCtx(repos, { handler: conflicting }).ctx, { version: '1.0.1', fixes: [{ issueNumber: 5, fixSha }] }))
      .rejects.toMatchObject({ code: 'gate-failed' });
  });
});

describe('mechanical ADR-0103 review row (real doc-currency over a temp repo)', () => {
  // The commit lands with the real clock, and doc-currency compares the row's date with that commit (stamp-lags-doc),
  // so the row is dated today in ET exactly as the night runner does (etDay(rt.now())).
  const TODAY = policy.etDay(Date.now());
  // The night runner commits on the owner's Mac, whose clock is Eastern, so git records the commit's day
  // in ET — the same day etDay() stamps on the row. A CI runner is UTC: between 8 p.m. and midnight ET the
  // commit's UTC day is already tomorrow and doc-currency reported stamp-lags-doc (preflight 41156104312,
  // 2026-10-31 01:40 UTC). Commit in the runner's own time zone, as production does.
  const savedTZ = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/New_York'; });
  afterAll(() => { if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ; });
  async function releaseWithAdr(adrText = ADR_TEXT) {
    const repos = makeRepos({ [ADR]: adrText, [CONTRACT]: 'export const INVENTORY = [];\n', 'README.md': 'readme 1.0.0\n' });
    const rwt = makeReleaseWorktree(repos, '1.0.1');
    write(path.join(rwt, 'package-lock.json'), '{\n  "name": "fixture",\n  "version": "1.0.1"\n}\n');
    realGit(rwt, ['add', '-A']); realGit(rwt, ['commit', '-m', 'lock']);
    return { repos, rwt };
  }

  it('version-only governed diff: a row is added, reviewed_digest binds the bytes, and the architecture review is current', async () => {
    const { repos, rwt } = await releaseWithAdr();
    const e = makeCtx(repos);
    const before = rel.stamp0103Review;
    const out = await before(e.ctx, { rwt, version: '1.0.1', issues: [5], date: TODAY });
    expect(out.rowAdded).toBe(true);
    expect(out.digest).toMatch(/^[0-9a-f]{12}$/);
    const text = fs.readFileSync(path.join(rwt, ADR), 'utf8');
    expect(text).toContain(`reviewed_digest: ${out.digest}`);
    expect(text.indexOf(`| ${TODAY} |`)).toBeLessThan(text.indexOf('| 2026-10-01 |'));
    expect(text).toContain(`Review \`${out.digest}\``);
    expect(text).toContain('autofix issues 5,');
    const lock = await import('../../scripts/architecture-review-lock.mjs');
    expect(lock.evaluateArchitectureReview(rwt).findings).toEqual([]);
    expect(realGit(rwt, ['status', '--porcelain']).stdout.trim()).toBe('');
    expect(realGit(rwt, ['log', '-1', '--format=%s']).stdout).toContain('ADR-0103 mechanical review row');
    // the fix itself (src/a.js) is ungoverned in this fixture, so only the version files were judged and passed
    expect(policy.judgeGovernedVersionOnly([{ path: 'src/a.js', status: 'M', added: ['x'], removed: ['y'] }]).mechanical).toBe(false);
  });

  it('names every issue in the row, and refuses no issues or a bad issue number', async () => {
    const { repos, rwt } = await releaseWithAdr();
    await expect(rel.stamp0103Review(makeCtx(repos).ctx, { rwt, version: '1.0.1', issues: [], date: TODAY })).rejects.toMatchObject({ code: 'governed-change-not-mechanical' });
    await expect(rel.stamp0103Review(makeCtx(repos).ctx, { rwt, version: '1.0.1', issues: [5, 0], date: TODAY })).rejects.toMatchObject({ code: 'diff-policy' });
    await rel.stamp0103Review(makeCtx(repos).ctx, { rwt, version: '1.0.1', issues: [5, 9, 12], date: TODAY });
    expect(fs.readFileSync(path.join(rwt, ADR), 'utf8')).toContain('autofix issues 5, 9, 12,');
  });
  it('a non-mechanical governed diff is refused and the ADR is left untouched', async () => {
    // src/a.js (changed by the fix) is governed here, so the REAL judge must refuse
    const { repos, rwt } = await releaseWithAdr(ADR_TEXT.replace('  - scripts/release-qualification-contract.mjs\n', '  - scripts/release-qualification-contract.mjs\n  - src/a.js\n'));
    const before = fs.readFileSync(path.join(rwt, ADR), 'utf8');
    await expect(rel.stamp0103Review(makeCtx(repos).ctx, { rwt, version: '1.0.1', issues: [5], date: TODAY }))
      .rejects.toMatchObject({ stage: 'S6', code: 'governed-change-not-mechanical' });
    expect(fs.readFileSync(path.join(rwt, ADR), 'utf8')).toBe(before);
  });

  it('only governed files are judged: an ungoverned change is not passed to the judge', async () => {
    const { repos, rwt } = await releaseWithAdr();
    write(path.join(rwt, 'README.md'), 'readme changed a lot\n'); realGit(rwt, ['add', '-A']); realGit(rwt, ['commit', '-m', 'readme']);
    await rel.stamp0103Review(makeCtx(repos).ctx, { rwt, version: '1.0.1', issues: [5], date: TODAY });
    // README.md is ungoverned: had it been judged, the real judge would have refused this stamp
    expect(realGit(rwt, ['log', '-1', '--format=%s']).stdout).toContain('ADR-0103 mechanical review row');
  });
});

describe('parseUnifiedDiff', () => {
  it('reads added/removed lines, status, binary and symlink flags', () => {
    const d = `diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-"version": "1"\n+"version": "2"\n-- keep this dash line\ndiff --git a/l b/l\nnew file mode 120000\ndiff --git a/b.png b/b.png\nBinary files a/b.png and b/b.png differ\n`;
    const f = parseUnifiedDiff(d);
    expect(f[0]).toMatchObject({ path: 'x', status: 'M', added: ['"version": "2"'], removed: ['"version": "1"', '- keep this dash line'] });
    expect(f[1]).toMatchObject({ path: 'l', status: 'A', symlink: true });
    expect(f[2]).toMatchObject({ path: 'b.png', binary: true });
  });
});

describe('runLocalGates', () => {
  it('runs the ten gates in order (release:prepush first) with substituted report paths, and re-checks the kill switch before each', async () => {
    const repos = makeRepos();
    const e = makeCtx(repos, { handler: () => '' });
    const r = await rel.runLocalGates(e.ctx, { rwt: repos.clone });
    expect(r.ok).toBe(true);
    expect(r.gates.map((g) => g.name)).toEqual(rel.LOCAL_GATES.map((g) => g[0]));
    const cmds = e.calls.filter((c) => c.cmd !== 'checkpoint' && c.cmd !== 'git').map((c) => `${c.cmd} ${c.args.join(' ')}`);
    expect(rel.LOCAL_GATES[0][0]).toBe('release-prepush');
    expect(cmds[0]).toMatch(/^npm run release:prepush -- --receipt .*\/prepush-\d+\.json$/);
    expect(cmds[0]).toContain(repos.runDir);
    expect(cmds[1]).toMatch(/^npm run release:qualify -- --suite source --report .*\/source-\d+\.json$/);
    expect(cmds[2]).toMatch(/--suite integration --report .*\/integration-\d+\.json$/);
    expect(cmds.slice(3)).toEqual(['npm test', 'npm run single-source:check', 'node --check scripts/release.mjs', 'npm run version:check', 'npm run release:authority', 'node scripts/architecture-review-lock.mjs', 'npm run doc:currency']);
    expect(e.calls.filter((c) => c.cmd === 'checkpoint').map((c) => c.args[0])).toEqual(rel.LOCAL_GATES.map((g) => `gate:${g[0]}`));
    expect(Object.isFrozen(rel.LOCAL_GATES)).toBe(true);
  });
  it('stops at the first red gate and reports ok:false; later gates never run', async () => {
    const repos = makeRepos();
    const e = makeCtx(repos, { handler: (c, a) => (a[0] === 'test' ? { status: 1, stdout: 'boom' } : '') });
    const r = await rel.runLocalGates(e.ctx, { rwt: repos.clone });
    expect(r.ok).toBe(false);
    expect(r.gates.map((g) => g.name)).toEqual(['release-prepush', 'release-qualify-source', 'release-qualify-integration', 'npm-test']);
    expect(r.gates[3]).toMatchObject({ exitCode: 1, outputTail: 'boom' });
    expect(e.count(/single-source:check/)).toBe(0);
  });
  it('a red release:prepush stops everything before the slow qualification suites', async () => {
    const repos = makeRepos();
    const e = makeCtx(repos, { handler: (c, a) => (a[1] === 'release:prepush' ? { status: 2, stderr: 'stale census' } : '') });
    const r = await rel.runLocalGates(e.ctx, { rwt: repos.clone });
    expect(r).toMatchObject({ ok: false, gates: [{ name: 'release-prepush', exitCode: 2, outputTail: 'stale census' }] });
    expect(e.count(/release:qualify/)).toBe(0);
  });
  it('a kill-switch abort between gates stops the run', async () => {
    const repos = makeRepos();
    let n = 0;
    const e = makeCtx(repos, { handler: () => '', checkpoint: async () => { if (++n === 3) throw new policy.AutofixAbort('S6', 'kill-switch-off'); } });
    await expect(rel.runLocalGates(e.ctx, { rwt: repos.clone })).rejects.toMatchObject({ code: 'kill-switch-off' });
    expect(e.count(/^npm test/)).toBe(0);
  });
  it('doc:currency passes only when it adds no BLOCK beyond origin/main', async () => {
    const repos = makeRepos();
    const blocks = (codes) => JSON.stringify({ docs: [{ file: 'd.md', findings: codes.map((code) => ({ level: 'block', code })) }] });
    const h = (mine) => (cmd, args, opts) => {
      if (args[0] === 'run' && args[1] === 'doc:currency') return { status: 1 };
      if (args.includes('scripts/doc-currency.mjs')) return opts.cwd.endsWith('-base') ? blocks(['old']) : blocks(mine);
      return '';
    };
    const ok = await rel.runLocalGates(makeCtx(repos, { handler: h(['old']), extra: {} }).ctx, { rwt: path.join(repos.root, 'rwt1') });
    expect(ok.ok).toBe(true);
    const repos2 = makeRepos();
    const bad = await rel.runLocalGates(makeCtx(repos2, { handler: h(['old', 'new']) }).ctx, { rwt: path.join(repos2.root, 'rwt2') });
    expect(bad.ok).toBe(false);
  });
  it('simulate-only ctx.gates overrides are honoured', async () => {
    const repos = makeRepos();
    const e = makeCtx(repos, { handler: () => '', extra: { gates: { 'npm-test': () => ({ exitCode: 3, output: 'stub' }) } } });
    const r = await rel.runLocalGates(e.ctx, { rwt: repos.clone });
    expect(r.ok).toBe(false);
    expect(r.gates.at(-1)).toMatchObject({ name: 'npm-test', exitCode: 3 });
  });
});

describe('stampCensus', () => {
  const zipBytes = Buffer.from('seed-bytes');
  const handler = (rwtRef, { badSha = false } = {}) => (cmd, args, opts) => {
    const a = args.join(' ');
    if (cmd === 'node' && /corpus-next-seed/.test(a)) {
      const out = args[args.indexOf('--out') + 1];
      write(out, JSON.stringify({ tag: 'corpus-sha256-aa', asset: 'seed.zip', origin: 'published-generation', bytes: zipBytes.length,
        sha256: badSha ? '0'.repeat(64) : crypto.createHash('sha256').update(zipBytes).digest('hex') }));
      return '';
    }
    if (cmd === 'gh' && args[0] === 'release' && args[1] === 'download') { write(path.join(args[args.indexOf('--dir') + 1], 'seed.zip'), zipBytes); return ''; }
    if (cmd === 'unzip') { write(path.join(args[args.indexOf('-d') + 1], 'x', 'store.big.rvf'), 'z'); return ''; }
    if (cmd === 'node' && /code-release-corpus/.test(a)) return '';
    if (cmd === 'node' && /sync-census/.test(a)) { write(path.join(opts.cwd, 'README.md'), 'readme 2.0.0 chunks 99\n'); return ''; }
    return null;
  };
  it('mirrors the ci.yml sequence and commits only the files the census writer changed', async () => {
    const repos = makeRepos({ 'README.md': 'readme 1.0.0\n' });
    const rwt = makeReleaseWorktree(repos, '1.0.1');
    const e = makeCtx(repos, { handler: handler() });
    const r = await rel.stampCensus(e.ctx, { rwt });
    expect(r).toEqual({ changed: true, files: ['README.md'] });
    const idx = [/corpus-next-seed\.mjs --repo owner\/repo --require-coverage --out /, /^gh release download corpus-sha256-aa --repo owner\/repo --pattern seed\.zip --pattern CORPUS-COVERAGE\.json --pattern coverage-receipt\.json --pattern seed\.zip\.recall\.json/,
      /^unzip -q /, /code-release-corpus\.mjs assemble --descriptor .* --seed-bundle .* --assets .*\/x --evidence-dir .* --coverage .* --coverage-receipt /, /sync-census\.mjs/].map((re) => e.find(re));
    expect(idx.every((i) => i >= 0) && [...idx].sort((p, q) => p - q).join() === idx.join()).toBe(true);
    const sync = e.calls.find((c) => c.args.includes('scripts/sync-census.mjs'));
    expect(sync.opts.env.RUVNET_BRAIN_KB).toBe(path.join(rwt, 'dist', 'ruvnet-brain'));
    expect(realGit(rwt, ['log', '-1', '--format=%s']).stdout).toContain('stamp the census for');
    expect(realGit(rwt, ['status', '--porcelain']).stdout.trim()).toBe('');
  });
  it('a seed whose bytes do not match its descriptor is refused before anything is assembled', async () => {
    const repos = makeRepos({ 'README.md': 'readme 1.0.0\n' });
    const rwt = makeReleaseWorktree(repos, '1.0.1');
    const e = makeCtx(repos, { handler: handler(null, { badSha: true }) });
    await expect(rel.stampCensus(e.ctx, { rwt })).rejects.toMatchObject({ code: 'gate-failed' });
    expect(e.count(/code-release-corpus/)).toBe(0);
  });
});

describe('gatherWindowFacts', () => {
  it('reads blockers, active runs, remote release branches, release PRs, the hold file, versions and the next 05:17 UTC dispatch', async () => {
    const repos = makeRepos();
    realGit(repos.seed, ['push', 'origin', 'HEAD:refs/heads/release/1.0.9']);
    write(path.join(repos.root, 'release-hold'), 'x');
    const h = (cmd, args) => {
      const a = args.join(' ');
      if (cmd === 'gh' && /^issue list/.test(a)) return JSON.stringify([{ number: 7 }]);
      if (cmd === 'gh' && /^run list .*--workflow protected-release\.yml --status in_progress/.test(a)) return JSON.stringify([{ databaseId: 5, status: 'in_progress' }]);
      if (cmd === 'gh' && /^run list/.test(a)) return '[]';
      if (cmd === 'gh' && /^pr list/.test(a)) return JSON.stringify([{ number: 3, headRefName: 'release/1.0.9' }, { number: 4, headRefName: 'fix/x' }]);
      if (cmd === 'npm') return '1.0.0';
      if (cmd === 'gh' && /^release view/.test(a)) return JSON.stringify({ tagName: 'v1.0.0' });
      if (cmd === 'node' && /approved-runtime/.test(a)) return '';
      return null;
    };
    const e = makeCtx(repos, { handler: h });
    const f = await rel.gatherWindowFacts(e.ctx);
    expect(f).toMatchObject({ openReleaseBlockers: [7], openReleasePrs: [3], holdFile: true, mainVersion: '1.0.0', npmLatest: '1.0.0',
      releasesLatestTag: 'v1.0.0', mainVersionInstallVerified: true, openReleasePrHeads: { 3: 'release/1.0.9' } });
    expect(f.activeRuns).toEqual([{ workflow: 'protected-release.yml', status: 'in_progress', id: 5 }]);
    expect(f.remoteReleaseBranches).toEqual([{ name: 'release/1.0.9', version: '1.0.9' }]);
    expect(f.mainSha).toBe(head(repos.clone));
    expect(new Date(f.nextCorpusDispatchAt).toISOString()).toBe('2026-10-30T05:17:00.000Z');
    expect(nextCorpusDispatch(Date.parse('2026-10-29T03:00:00Z'))).toBe(Date.parse('2026-10-29T05:17:00Z'));
  });
  it('an unreadable gh answer closes the window instead of guessing', async () => {
    const repos = makeRepos();
    await expect(rel.gatherWindowFacts(makeCtx(repos, { handler: () => ({ status: 1 }) }).ctx)).rejects.toMatchObject({ code: 'window-closed' });
  });
});
