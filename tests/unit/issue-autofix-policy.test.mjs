// ADR-107 policy rails. Every rule has a case that passes ONLY because the rule exists; scratch mutants of the
// module (AUTOFIX_POLICY_UNDER_TEST=<copy>) are run against this file to prove each one goes red when broken.
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BOT_MARKER, judgeIssue } from '../../scripts/issue-watch.mjs';

const P = await import(process.env.AUTOFIX_POLICY_UNDER_TEST
  ? pathToFileURL(process.env.AUTOFIX_POLICY_UNDER_TEST).href : '../../scripts/issue-autofix-policy.mjs');

const NOW = Date.parse('2026-10-29T15:00:00Z');
const HOUR = 3_600_000;
const BODY = 'Running the updater on Windows crashes with ENOENT in scripts/update.mjs line 12 every time.';
const issue = (o = {}) => ({ number: 7, title: 'update crashes', body: BODY, author: { login: 'alice' }, labels: [],
  createdAt: new Date(NOW - 5 * HOUR).toISOString(), updatedAt: new Date(NOW - 4 * HOUR).toISOString(), comments: [], ...o });
const elig = (i = issue(), o = {}) => P.judgeEligibility(i, { now: NOW, botMarker: BOT_MARKER, ...o });
const file = (path, o = {}) => ({ path, status: 'M', added: [], removed: [], binary: false, symlink: false, ...o });
const rules = (r) => r.violations.map((v) => v.rule);
const throwsCode = (fn, code) => { try { fn(); } catch (e) { expect(e.name).toBe('AutofixAbort'); expect(e.code).toBe(code); return; } throw new Error('did not throw'); };

describe('AutofixAbort and vocabulary', () => {
  it('carries stage, code, private detail and flags; stages and codes are the frozen lists', () => {
    const e = new P.AutofixAbort('S10', 'main-moved', 'x', { halt: true, publicFindings: true });
    expect(e).toBeInstanceOf(Error);
    expect([e.name, e.stage, e.code, e.detail, e.halt, e.publicFindings]).toEqual(['AutofixAbort', 'S10', 'main-moved', 'x', true, true]);
    expect(new P.AutofixAbort('S3', 'diff-policy')).toMatchObject({ halt: false, publicFindings: false, detail: '' });
    expect(P.STAGES_ORDER).toHaveLength(16);
    expect(P.ABORT_CODES).toHaveLength(44);
    expect(new Set(P.ABORT_CODES).size).toBe(44);
    expect(Object.isFrozen(P.ABORT_CODES)).toBe(true);
    expect([...P.HALT_STAGES]).toEqual(['S10', 'S11', 'S12', 'S13']);
    for (const c of ['kill-switch-off', 'forbidden-command', 'comment-failed', 'deadline', 'not-editable', 'security-finding', 'redteam-flagged',
      'sandbox-unavailable', 'injection-scan-failed', 'modules-tampered', 'batch-security', 'prepush-failed', 'transient', 'plan-malformed']) expect(P.ABORT_CODES).toContain(c);
  });
});

describe('assertCommandAllowed: no force, no merge, no delete', () => {
  const bad = [
    ['git', ['push', '--force', 'origin', 'x']], ['git', ['push', '-f', 'origin', 'x']], ['git', ['-C', 'd', 'push', '--force-with-lease', 'origin', 'x']],
    ['git', ['push', 'origin', '+refs/heads/x:refs/heads/main']], ['git', ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*']], ['git', ['push', 'origin', '+abc:refs/heads/main']],
    ['git', ['push', '--delete', 'origin', 'release/1.0.0']], ['git', ['push', 'origin', ':release/1.0.0']],
    ['gh', ['pr', 'merge', '12']], ['gh', ['-R', 'o/r', 'pr', 'merge', '12', '--squash']], ['gh', ['api', 'repos/o/r/pulls/12/merge', '-X', 'PUT']],
    ['gh', ['api', '-X', 'DELETE', 'repos/o/r/git/refs/heads/x']], ['gh', ['api', '--method=DELETE', 'repos/o/r/git/refs/tags/v1']],
  ];
  for (const [cmd, args] of bad) it(`refuses ${cmd} ${args.join(' ')}`, () => throwsCode(() => P.assertCommandAllowed(cmd, args, 'S10'), 'forbidden-command'));
  it('reports the stage it was called for', () => {
    try { P.assertCommandAllowed('git', ['push', '-f'], 'S7'); } catch (e) { expect(e.stage).toBe('S7'); return; }
    throw new Error('no throw');
  });
  const good = [
    ['git', ['push', 'origin', 'release/4.8.0']], ['git', ['push', 'origin', 'abc123:refs/heads/main']], ['git', ['merge-base', '--is-ancestor', 'a', 'b']],
    ['gh', ['workflow', 'run', 'protected-release.yml', '-f', 'mode=code']], ['gh', ['api', 'repos/o/r/dispatches', '-f', 'event_type=x']],
    ['gh', ['pr', 'create', '--base', 'main']], ['gh', ['pr', 'checks', '3', '--required', '--watch']], ['git', ['commit', '-m', 'force the issue']],
  ];
  for (const [cmd, args] of good) it(`allows ${cmd} ${args.join(' ')}`, () => expect(() => P.assertCommandAllowed(cmd, args, 'S10')).not.toThrow());
});

describe('readKillSwitch: only exactly "on", nothing local, arms it', () => {
  const sw = (o) => P.readKillSwitch({ variable: { ok: true, value: 'on' }, offFile: false, haltFile: false, ...o });
  it('armed only for variable on with no local files', () => expect(sw({})).toEqual({ armed: true, reason: 'on' }));
  it('trailing newline from gh is tolerated', () => expect(sw({ variable: { ok: true, value: 'on\n' } }).armed).toBe(true));
  for (const [name, o, reason] of [
    ['off', { variable: { ok: true, value: 'off' } }, 'variable-off'], ['capital ON', { variable: { ok: true, value: 'ON' } }, 'variable-off'],
    ['truthy "true"', { variable: { ok: true, value: 'true' } }, 'variable-off'], ['padded " on"', { variable: { ok: true, value: ' on' } }, 'variable-off'],
    ['unset null', { variable: { ok: true, value: null } }, 'variable-unset'], ['unset empty', { variable: { ok: true, value: '' } }, 'variable-unset'],
    ['unreadable', { variable: { ok: false, value: 'on' } }, 'variable-unreadable'], ['missing variable', { variable: undefined }, 'variable-unreadable'],
    ['local off file', { offFile: true }, 'local-off'], ['halt file', { haltFile: true }, 'halted'],
    ['halt beats everything', { haltFile: true, offFile: true, variable: { ok: false } }, 'halted'],
  ]) it(`${name} is OFF (${reason})`, () => expect(sw(o)).toEqual({ armed: false, reason }));
});

describe('judgeEligibility: each exclusion alone, against one accepted human issue', () => {
  it('accepts a plain human issue', () => expect(elig()).toEqual({ eligible: true, reason: 'eligible' }));
  const cases = [
    ['stuinfla (owner)', { author: { login: 'stuinfla' } }, 'not-person'], ['dependabot[bot]', { author: { login: 'dependabot[bot]' } }, 'not-person'],
    ['any *[bot] login', { author: { login: 'renovate[bot]' } }, 'not-person'], ['is_bot flag', { author: { login: 'zed', is_bot: true } }, 'not-person'],
    ['59 minutes old', { createdAt: new Date(NOW - 59 * 60_000).toISOString() }, 'too-young'], ['no createdAt', { createdAt: undefined }, 'too-young'],
    ['39-char body', { body: 'x'.repeat(39) }, 'short-body'], ['body not fetched', { body: undefined }, 'body-unavailable'],
    ...P.EXCLUDED_LABELS.map((l) => [`label ${l}`, { labels: [{ name: l }] }, `label:${l}`]),
    ['label upper-case', { labels: [{ name: 'Release-Blocker' }] }, 'label:release-blocker'],
    ['label as plain string', { labels: ['security'] }, 'label:security'],
    ['owner replied as a human', { comments: [{ author: { login: 'stuinfla' }, body: 'looking at it' }] }, 'owner-replied'],
    ['owner reply, login in other case', { comments: [{ author: { login: 'StuInfla' }, body: 'looking' }] }, 'owner-replied'],
  ];
  for (const [name, o, reason] of cases) it(`${name} -> ${reason}`, () => expect(elig(issue(o))).toEqual({ eligible: false, reason }));
  it('the 40-char body boundary and 1-hour boundary are inclusive', () => {
    expect(elig(issue({ body: 'x'.repeat(40) })).eligible).toBe(true);
    expect(elig(issue({ createdAt: new Date(NOW - HOUR).toISOString() })).eligible).toBe(true);
  });
  it('a bot-marked owner comment is not a human reply; a stranger comment is not an owner reply', () => {
    expect(elig(issue({ comments: [{ author: { login: 'stuinfla' }, body: `${BOT_MARKER} acknowledgment` }] })).eligible).toBe(true);
    expect(elig(issue({ comments: [{ author: { login: 'bob' }, body: 'me too' }] })).eligible).toBe(true);
  });
  it('autofix:go overrides an owner reply but nothing else', () => {
    const talked = { comments: [{ author: { login: 'stuinfla' }, body: 'hm' }] };
    expect(elig(issue({ ...talked, labels: [{ name: 'autofix:go' }] })).eligible).toBe(true);
    expect(elig(issue({ ...talked, labels: [{ name: 'autofix:go' }, { name: 'security' }] })).reason).toBe('label:security');
  });
  it('a linked open PR excludes it', () => expect(elig(issue(), { linkedOpenPrs: [41] })).toEqual({ eligible: false, reason: 'linked-pr' }));
  const last = new Date(NOW - 3 * HOUR).toISOString();
  it('breaker: one failure blocks until the issue changes after the last attempt', () => {
    const rec = { attempts: 1, failCount: 1, lastAttemptAt: last };
    expect(elig(issue({ updatedAt: new Date(NOW - 4 * HOUR).toISOString() }), { record: rec }).reason).toBe('breaker');
    expect(elig(issue({ updatedAt: last }), { record: rec }).reason).toBe('breaker'); // equal is not changed
    expect(elig(issue({ updatedAt: new Date(NOW - 2 * HOUR).toISOString() }), { record: rec }).eligible).toBe(true);
    expect(elig(issue(), { record: { attempts: 1, failCount: 0, lastAttemptAt: last } }).eligible).toBe(true);
  });
  it('breaker with an unreadable timestamp fails closed', () => expect(elig(issue(), { record: { failCount: 1, lastAttemptAt: 'garbage' } }).reason).toBe('breaker'));
  it('lifetime cap: 3 attempts block even after the issue changes', () => {
    const upd = issue({ updatedAt: new Date(NOW - 60_000).toISOString() });
    expect(elig(upd, { record: { attempts: 3, failCount: 0, lastAttemptAt: last } }).reason).toBe('lifetime-cap');
    expect(elig(upd, { record: { attempts: 2, failCount: 0, lastAttemptAt: last } }).eligible).toBe(true);
  });
  it('awaiting-verification entries go to the re-check path, not a new attempt', () => {
    expect(elig(issue(), { record: { attempts: 1, awaitingVerification: { version: '9.9.9', sha: 'a'.repeat(40), publishedAt: last } } }).reason).toBe('awaiting-verification');
  });
});

describe('selectCandidates', () => {
  const mk = (n, ageH, o = {}) => issue({ number: n, createdAt: new Date(NOW - ageH * HOUR).toISOString(), ...o });
  it('takes every eligible issue, oldest first, and reports why the rest were skipped', () => {
    const r = P.selectCandidates([mk(1, 5), mk(2, 50), mk(3, 20), mk(4, 100, { author: { login: 'stuinfla' } }), mk(5, 30, { labels: [{ name: 'design' }] })],
      { state: {}, now: NOW, linkedPrsByIssue: {}, botMarker: BOT_MARKER });
    expect(r.candidates.map((i) => i.number)).toEqual([2, 3, 1]);
    expect(r.skipped).toEqual([{ number: 4, reason: 'not-person' }, { number: 5, reason: 'label:design' }]);
  });
  it('the sanity bound: 50 planned per run, the oldest 50; the rest are skipped as run-cap', () => {
    const many = Array.from({ length: 53 }, (_, i) => mk(i + 1, 2 + i)); // issue 53 is the oldest
    const r = P.selectCandidates(many, { now: NOW });
    expect(r.candidates).toHaveLength(50);
    expect(r.candidates[0].number).toBe(53);
    expect(r.skipped).toEqual([1, 2, 3].map((n) => ({ number: n, reason: 'run-cap' })).reverse());
  });
  it('lists every open release-blocker, eligible or not', () => {
    const r = P.selectCandidates([mk(1, 5, { labels: [{ name: 'release-blocker' }] }), mk(2, 9, { author: { login: 'stuinfla' }, labels: [{ name: 'release-blocker' }] })], { now: NOW });
    expect(r.releaseBlockers.sort()).toEqual([1, 2]);
    expect(r.candidates).toEqual([]);
  });
  it('consults per-issue state and linked PRs', () => {
    const r = P.selectCandidates([mk(1, 5), mk(2, 6), mk(3, 7)], { now: NOW, state: { 1: { attempts: 3 } }, linkedPrsByIssue: { 2: [9] } });
    expect(r.candidates.map((i) => i.number)).toEqual([3]);
    expect(r.skipped).toEqual(expect.arrayContaining([{ number: 1, reason: 'lifetime-cap' }, { number: 2, reason: 'linked-pr' }]));
  });
});

describe('judgeReleaseWindow: every blocker alone closes it, and says which', () => {
  const TODAY = '2026-10-29';
  const facts = (o = {}) => ({ openReleaseBlockers: [], activeRuns: [], remoteReleaseBranches: [], openReleasePrs: [], holdFile: false,
    mainVersion: '5.0.1', mainSha: 'a'.repeat(40), npmLatest: '5.0.1', releasesLatestTag: 'v5.0.1', mainVersionInstallVerified: true,
    nextCorpusDispatchAt: NOW + 20 * HOUR, ...o });
  const win = (o, j = {}) => P.judgeReleaseWindow(facts(o), { now: NOW, today: TODAY, lastShippedDay: '2026-10-28', ...j });
  it('open when every fact is clean', () => expect(win({})).toEqual({ open: true, reasons: [] }));
  for (const [name, o, token] of [
    ['release-blocker', { openReleaseBlockers: [12] }, 'release-blocker'],
    ['protected-release running', { activeRuns: [{ workflow: 'protected-release', status: 'in_progress', id: 1 }] }, 'protected-release'],
    ['preflight queued (.yml spelling)', { activeRuns: [{ workflow: 'release-candidate-preflight.yml', status: 'queued', id: 1 }] }, 'release-candidate-preflight'],
    ['corpus dispatch running', { activeRuns: [{ workflow: 'corpus-nightly-dispatch', status: 'in_progress', id: 1 }] }, 'corpus-nightly-dispatch'],
    ['release branch ahead of main', { remoteReleaseBranches: [{ name: 'release/5.0.2', version: '5.0.2' }] }, 'release/5.0.2'],
    ['release branch with junk version', { remoteReleaseBranches: [{ name: 'release/x', version: 'x' }] }, 'release/x'],
    ['open release PR', { openReleasePrs: [88] }, 'open-release-pr'],
    ['release-hold file', { holdFile: true }, 'release-hold'],
    ['npm behind main', { npmLatest: '5.0.0' }, 'version-mismatch'], ['npm unknown', { npmLatest: null }, 'version-mismatch'],
    ['GitHub release behind', { releasesLatestTag: 'v5.0.0' }, 'version-mismatch'], ['GitHub release unknown', { releasesLatestTag: null }, 'version-mismatch'],
    ['main not install-verified', { mainVersionInstallVerified: false }, 'main-not-install-verified'],
    ['corpus dispatch inside the 7h window', { nextCorpusDispatchAt: NOW + 6 * HOUR }, 'corpus-dispatch-too-soon'],
    ['corpus dispatch exactly at the window end', { nextCorpusDispatchAt: NOW + 7 * HOUR }, 'corpus-dispatch-too-soon'],
    ['corpus dispatch time unknown', { nextCorpusDispatchAt: undefined }, 'corpus-dispatch-too-soon'],
  ]) it(`${name} -> closed, naming ${token}`, () => {
    const r = win(o);
    expect(r.open).toBe(false);
    expect(r.reasons.join(' ')).toContain(token);
    expect(r.reasons).toHaveLength(1);
  });
  it('unrelated workflows and completed runs do not block; branches at or below main do not block', () => {
    expect(win({ activeRuns: [{ workflow: 'ci', status: 'in_progress', id: 1 }, { workflow: 'protected-release', status: 'completed', id: 2 }],
      remoteReleaseBranches: [{ name: 'release/5.0.1', version: '5.0.1' }, { name: 'release/4.9.9', version: '4.9.9' }] }).open).toBe(true);
  });
  it('daily cap: shipped today closes it with exactly daily-cap; yesterday does not', () => {
    expect(win({}, { lastShippedDay: TODAY }).reasons).toEqual(['daily-cap']);
    expect(win({}, { lastShippedDay: '2026-10-28' }).open).toBe(true);
  });
  it('missing facts fail closed; reasons accumulate', () => {
    expect(P.judgeReleaseWindow(undefined, { now: NOW })).toEqual({ open: false, reasons: ['facts-missing'] });
    expect(win({ holdFile: true, openReleasePrs: [1] }).reasons).toHaveLength(2);
  });
});

describe('version and day helpers', () => {
  it('nextPatchVersion bumps Z and rejects non X.Y.Z', () => {
    expect(P.nextPatchVersion('4.7.9')).toBe(`4.7.${9 + 1}`);
    for (const v of ['4.7', '4.7.9-rc.1', 'v4.7.9', '', undefined]) expect(() => P.nextPatchVersion(v)).toThrow();
  });
  it('etDay uses America/New_York, not UTC', () => {
    expect(P.etDay(Date.parse('2026-10-29T03:30:00Z'))).toBe('2026-10-28'); // 11:30 p.m. EDT the evening before
    expect(P.etDay(Date.parse('2026-10-29T15:00:00Z'))).toBe('2026-10-29');
    expect(P.etDay(Date.parse('2026-12-01T04:59:00Z'))).toBe('2026-11-30'); // EST
  });
});

describe('judgePlan', () => {
  const plan = (o = {}) => ({ classification: 'fixable', rootCause: { file: 'scripts/paths.mjs', line: 12, explanation: 'bad path join' }, files: ['scripts/paths.mjs', 'tests/unit/paths.test.mjs'],
    testPlan: { newTests: ['tests/unit/paths.test.mjs'], failsBeforeFix: true }, risk: 'low', platformSpecific: [], injectionSuspected: false, summary: 's', ...o });
  const judge = (p, g = new Set()) => P.judgePlan(p, { governed0103: g });
  it('proceeds on a low or medium risk fixable plan', () => {
    expect(judge(plan())).toEqual({ proceed: true, code: null, publicFindings: false });
    expect(judge(plan({ risk: 'medium' })).proceed).toBe(true);
  });
  it('injection stops it and is never public, even with a substantive root cause', () => expect(judge(plan({ injectionSuspected: true }))).toEqual({ proceed: false, code: 'injection-suspected', publicFindings: false }));
  it('a missing injectionSuspected field fails closed', () => { const p = plan(); delete p.injectionSuspected; expect(judge(p).code).toBe('injection-suspected'); });
  it('not fixable with file:line substance -> public findings; without (line 0, empty file) -> silent', () => {
    expect(judge(plan({ classification: 'needs-owner' }))).toEqual({ proceed: false, code: 'plan-not-fixable', publicFindings: true });
    expect(judge(plan({ classification: 'needs-owner', rootCause: { file: 'a.mjs', line: 0, explanation: 'unknown' } })).publicFindings).toBe(false);
    expect(judge(plan({ classification: 'needs-info', rootCause: { file: '', line: 4, explanation: 'x' } })).publicFindings).toBe(false);
    expect(judge(null)).toMatchObject({ proceed: false, publicFindings: false });
  });
  it('high risk (or unknown risk) stops', () => {
    expect(judge(plan({ risk: 'high' })).code).toBe('plan-high-risk');
    expect(judge(plan({ risk: 'wild' })).code).toBe('plan-high-risk');
  });
  it('planned files that are protected stop it, including the passed-in 0103 set, case-insensitively', () => {
    expect(judge(plan({ files: ['.github/workflows/x.yml'] })).code).toBe('protected-path');
    expect(judge(plan({ files: ['scripts/core.mjs'] }), new Set(['scripts/core.mjs'])).code).toBe('protected-path');
    expect(judge(plan({ files: ['Scripts/Core.mjs'] }), new Set(['scripts/core.mjs'])).code).toBe('protected-path');
    expect(judge(plan({ files: ['scripts/core.mjs'] })).proceed).toBe(true); // proves the set is what blocks it
  });
  // Each of these is NOT matched by PROTECTED_PATTERNS, so only the isEditablePath allowlist stops it.
  for (const f of ['bin/cli.mjs', 'src/x.mjs', 'scripts/lib/core.mjs', 'scripts/install-helper.mjs', 'scripts/x.sh', 'data/x.json', 'lib/x.mjs', 'scripts/évil.mjs'])
    it(`a planned file off the editable allowlist stops it: ${f}`, () => {
      expect(P.isProtectedPath(f)).toBe(false);
      expect(judge(plan({ files: [f] }))).toEqual({ proceed: false, code: 'protected-path', publicFindings: true });
    });
  it('every new test must be an editable TEST file; none at all stops it', () => {
    expect(judge(plan({ testPlan: { newTests: ['scripts/x.mjs'], failsBeforeFix: true } })).code).toBe('protected-path'); // editable, not a test
    expect(judge(plan({ testPlan: { newTests: ['tests/unit/install.test.mjs'], failsBeforeFix: true } })).code).toBe('protected-path'); // a test, not editable
    expect(judge(plan({ testPlan: { newTests: ['tests/e2e/x.test.mjs'], failsBeforeFix: true } })).code).toBe('protected-path');
    expect(judge(plan({ testPlan: { newTests: [], failsBeforeFix: true } })).code).toBe('protected-path');
    expect(judge(plan({ testPlan: undefined })).code).toBe('protected-path');
    expect(judge(plan({ testPlan: { newTests: ['tests/regression/x.test.mjs'], failsBeforeFix: true } })).proceed).toBe(true);
  });
});

describe('judgeDiff: path, dependency, network, binary, symlink, size', () => {
  const diff = (files, g = new Set()) => P.judgeDiff({ files, governed0103: g });
  it('a clean fix with a new test is ok and sorted into source and test files', () => {
    const r = diff([file('scripts/paths.mjs', { added: ['  return path.join(a, b);'], removed: ['  return a + b;'] }),
      file('tests/unit/paths.test.mjs', { status: 'A', added: ["import { it } from 'vitest';", "it('joins', () => {});"] })]);
    expect(r).toEqual({ ok: true, violations: [], testFiles: ['tests/unit/paths.test.mjs'], sourceFiles: ['scripts/paths.mjs'] });
  });
  // Not matched by PROTECTED_PATTERNS: only the editable allowlist (rule not-editable) catches these.
  for (const p of ['bin/cli.mjs', 'src/x.mjs', 'scripts/lib/core.mjs', 'scripts/update-paths.mjs', 'scripts/x.sh', 'lib/x.mjs', 'README.txt'])
    it(`not-editable: ${p}`, () => {
      expect(P.isProtectedPath(p)).toBe(false);
      const r = diff([file(p, { added: ['const a = 1;'] })]);
      expect(r.ok).toBe(false);
      expect(r.violations).toEqual([expect.objectContaining({ path: p, rule: 'not-editable' })]);
      expect(r.violations[0].detail).toMatch(/editable allowlist \((never:|not-allowlisted)/);
    });
  it('a protected path reports protected-path, not a second not-editable violation', () =>
    expect(rules(diff([file('.github/workflows/ci.yml', { added: ['x'] })]))).toEqual(['protected-path']));
  const protectedPaths = ['.github/workflows/ci.yml', '.GitHub/workflows/ci.yml', 'scripts/release.mjs', 'scripts/release-authority.mjs', 'scripts/issue-fix.mjs',
    'scripts/job-heartbeat.sh', 'scripts/nightly-watchdog.mjs', 'scripts/single-source-check.mjs', 'scripts/doc-currency.mjs', 'plugin/scripts/doc-currency.mjs',
    'config/scheduled-jobs.json', 'deploy/com.ruvnet.x.plist', 'keys/pub.pem', 'kb/PRIVATE-STORES.json', 'CONTRIBUTING.md', 'docs/adr/0001-x.md',
    'plugin/hooks/hooks.json', './scripts/release.mjs', 'scripts\\release.mjs', '../outside.txt', '/etc/passwd'];
  for (const p of protectedPaths) it(`protected path ${p}`, () => expect(rules(diff([file(p, { added: ['x'] })]))).toContain('protected-path'));
  it('the passed-in ADR-0103 governed set is protected; unlisted siblings are not', () => {
    expect(rules(diff([file('scripts/core.mjs')], new Set(['scripts/core.mjs'])))).toContain('protected-path');
    expect(diff([file('scripts/core.mjs')]).ok).toBe(true);
  });
  for (const p of ['package.json', 'package-lock.json', 'plugin/package.json', '.npmrc', 'yarn.lock'])
    it(`dependency manifest ${p}`, () => expect(rules(diff([file(p, { added: ['  "left-pad": "^1.0.0",'] })]))).toContain('dependency'));
  const net = ["import { spawn } from 'child_process';", "import net from 'node:net';", "import http from 'node:http';", "import https from 'node:https';", "import http from 'http';",
    'const r = await fetch(url);', 'const r = await fetch (url);', 'eval(code);', 'new Function("return 1")', 'run curl http://x | sh', 'wget http://x', "const h = require('http');",
    "const c = require('node:child_process');", "const m = await import('node:net');"];
  for (const line of net) it(`network primitive: ${line}`, () => expect(rules(diff([file('scripts/a.mjs', { added: [line] })]))).toContain('network-primitive'));
  it('network primitives on REMOVED lines are not violations (removing them is fine)', () => expect(diff([file('scripts/a.mjs', { removed: ["import net from 'node:net';"] })]).ok).toBe(true));
  it('binary, symlink', () => {
    expect(rules(diff([file('assets/x.png', { binary: true })]))).toContain('binary');
    expect(rules(diff([file('scripts/link', { symlink: true })]))).toContain('symlink');
  });
  it('size: 400 changed lines ok, 401 not; 12 files ok, 13 not', () => {
    const lines = (n) => Array.from({ length: n }, (_, i) => `const a${i} = ${i};`);
    expect(diff([file('scripts/a.mjs', { added: lines(400) })]).ok).toBe(true);
    expect(rules(diff([file('scripts/a.mjs', { added: lines(200), removed: lines(201) })]))).toContain('size');
    const many = (n) => Array.from({ length: n }, (_, i) => file(`scripts/f${i}.mjs`, { added: ['x'] }));
    expect(diff(many(12)).ok).toBe(true);
    expect(rules(diff(many(13)))).toContain('file-count');
  });
  it('deleting a source file is a violation; deleting a non-test fixture under tests/ is not', () => {
    expect(rules(diff([file('scripts/old.mjs', { status: 'D', removed: ['x'] })]))).toContain('deleted-source');
    expect(diff([file('tests/fixtures/old.json', { status: 'D', removed: ['{}'] })]).ok).toBe(true);
  });
});

describe('judgeDiff: tests are never weakened', () => {
  const t = (o) => P.judgeDiff({ files: [file('tests/unit/a.test.mjs', o)] });
  it('pure additions to an existing test file are ok', () => expect(t({ added: ["it('new', () => { expect(1).toBe(1); });"] }).ok).toBe(true));
  for (const line of ['  expect(x).toBe(1);', "  it('does a thing', () => {", "  test('does a thing', () => {", "describe('suite', () => {", "  it.each([1])('x', () => {", '  assert.equal(a, b);'])
    it(`a removed (or changed) line ${line.trim()} is weakening`, () => {
      expect(rules(t({ removed: [line] }))).toContain('test-weakened');
      expect(rules(t({ removed: [line], added: [line.replace('1', '2')] }))).toContain('test-weakened'); // a changed line is a removed line plus an added one
    });
  it('removing a comment or a blank line is not weakening', () => expect(t({ removed: ['// old note', ''] }).ok).toBe(true));
  for (const line of ["it.skip('x', () => {});", "it.only('x', () => {});", "it.todo('x');", "describe.skip('x', () => {});", "xit('x', () => {});", "fit('x', () => {});", "it.skipIf(true)('x', () => {});"])
    it(`added ${line}`, () => expect(rules(t({ added: [line] }))).toContain('test-weakened'));
  it('a deleted or renamed test file is weakening', () => {
    expect(rules(P.judgeDiff({ files: [file('tests/unit/a.test.mjs', { status: 'D' })] }))).toContain('test-weakened');
    expect(rules(P.judgeDiff({ files: [file('tests/unit/b.test.mjs', { status: 'R' })] }))).toContain('test-weakened');
  });
  for (const p of ['vitest.config.mjs', 'vitest.config.ts', 'tests/unit/vitest.config.mjs', 'vitest.workspace.js'])
    it(`vitest config change ${p}`, () => expect(rules(P.judgeDiff({ files: [file(p, { added: ['x'] })] }))).toContain('test-weakened'));
  it('a *.test.mjs outside tests/ is still a test file', () => expect(rules(P.judgeDiff({ files: [file('scripts/x.test.mjs', { removed: ['expect(1).toBe(1);'] })] }))).toContain('test-weakened'));
  it('removed assertions in SOURCE files are not test-weakening (only tests are guarded)', () => expect(P.judgeDiff({ files: [file('scripts/a.mjs', { removed: ['  expect(x).toBe(1);'] })] }).ok).toBe(true));
});

describe('judgeTestValidity: fail before, pass after, and only the new tests', () => {
  const N = ['tests/unit/new.test.mjs'];
  const v = (before, after, newTests = N) => P.judgeTestValidity({ before, after, newTests });
  it('ok when the new test fails before and everything passes after', () => expect(v({ exitCode: 1, failedTests: ['tests/unit/new.test.mjs > suite > case'] }, { exitCode: 0 })).toEqual({ ok: true, reason: 'ok' }));
  it('passes-before-fix: a test that passes on unfixed code proves nothing', () => expect(v({ exitCode: 0, failedTests: [] }, { exitCode: 0 })).toEqual({ ok: false, reason: 'passes-before-fix' }));
  it('fails-after-fix', () => expect(v({ exitCode: 1, failedTests: [N[0]] }, { exitCode: 1 })).toEqual({ ok: false, reason: 'fails-after-fix' }));
  it('unrelated-failures: failing tests that are not the new ones', () => {
    expect(v({ exitCode: 1, failedTests: ['tests/unit/other.test.mjs > x'] }, { exitCode: 0 }).reason).toBe('unrelated-failures');
    expect(v({ exitCode: 1, failedTests: [N[0], 'tests/unit/other.test.mjs'] }, { exitCode: 0 }).reason).toBe('unrelated-failures');
    expect(v({ exitCode: 1, failedTests: ['tests/unit/new.test.mjs.bak'] }, { exitCode: 0 }).reason).toBe('unrelated-failures'); // a prefix is not a match
  });
  it('a crash with no identifiable failing test is not evidence', () => expect(v({ exitCode: 1, failedTests: [] }, { exitCode: 0 }).reason).toBe('unrelated-failures'));
  it('no-new-tests', () => { expect(v({ exitCode: 1, failedTests: [] }, { exitCode: 0 }, []).reason).toBe('no-new-tests'); expect(v({ exitCode: 1 }, { exitCode: 0 }, null).reason).toBe('no-new-tests'); });
  it('a killed run (null exit) is neither a failure before nor a pass after', () => {
    expect(v({ exitCode: null, failedTests: [N[0]] }, { exitCode: 0 }).reason).toBe('passes-before-fix');
    expect(v({ exitCode: 1, failedTests: [N[0]] }, { exitCode: null }).reason).toBe('fails-after-fix');
  });
});

describe('judgeVerdict', () => {
  const ev = (o = {}) => ({ kind: 'test', file: 'tests/unit/a.test.mjs', line: 3, claim: 'c', command: 'npx vitest run tests/unit/a.test.mjs', ...o });
  const ver = (o = {}) => ({ verdict: 'RESOLVED', evidence: [ev(), ev({ kind: 'code', command: undefined })], summary: 's', risks: [], ...o });
  const run = (c = 'npx vitest run tests/unit/a.test.mjs') => ({ command: c, exitCode: 0 });
  it('ships on RESOLVED, two evidence items, every re-run green', () => expect(P.judgeVerdict(ver(), [run()])).toEqual({ ship: true, code: null }));
  it('NOT_RESOLVED and NEEDS_OWNER never ship', () => {
    expect(P.judgeVerdict(ver({ verdict: 'NOT_RESOLVED' }), [run()])).toEqual({ ship: false, code: 'verify-not-resolved' });
    expect(P.judgeVerdict(ver({ verdict: 'NEEDS_OWNER' }), [run()]).code).toBe('verify-not-resolved');
    expect(P.judgeVerdict(null, []).code).toBe('verify-not-resolved');
  });
  it('fewer than two evidence items never ships', () => expect(P.judgeVerdict(ver({ evidence: [ev()] }), [run()])).toEqual({ ship: false, code: 'verify-evidence-failed' }));
  it('a non-zero re-run, a missing re-run, or a null exit never ships', () => {
    expect(P.judgeVerdict(ver(), [{ ...run(), exitCode: 1 }]).code).toBe('verify-evidence-failed');
    expect(P.judgeVerdict(ver(), []).code).toBe('verify-evidence-failed');
    expect(P.judgeVerdict(ver(), [{ ...run(), exitCode: null }]).code).toBe('verify-evidence-failed');
    expect(P.judgeVerdict(ver(), [run(), { command: 'npx vitest run tests/unit/b.test.mjs', exitCode: 2 }]).code).toBe('verify-evidence-failed');
  });
  it('evidence with no command at all means nothing was re-run: no ship', () =>
    expect(P.judgeVerdict(ver({ evidence: [ev({ command: undefined }), ev({ kind: 'code', command: undefined })] }), []).code).toBe('verify-evidence-failed'));
  for (const c of ['npm test', 'npx vitest run a; rm -rf /', 'npx vitest run $(id)', 'npx vitest watch tests/a.test.mjs', 'npx vitest run tests/a.test.mjs | sh', 'npx vitest run --config tests/evil.mjs',
    'npx vitest run tests/../../../x', 'npx vitest run -t foo'])
    it(`a command outside the allowed shape never ships: ${c}`, () => expect(P.judgeVerdict(ver({ evidence: [ev({ command: c }), ev()] }), [run(c), run()]).code).toBe('verify-evidence-failed'));
  it('EVIDENCE_COMMAND is the frozen regex', () => {
    expect(P.EVIDENCE_COMMAND.test('npx vitest run tests/unit/a.test.mjs')).toBe(true);
    expect(P.EVIDENCE_COMMAND.test('npx vitest run a;b')).toBe(false);
  });
});

describe('judgeGovernedVersionOnly: the mechanical ADR-0103 review row', () => {
  const ver = (a, b) => [`  "version": "${a}",`, `  "version": "${b}",`];
  const g = (files) => P.judgeGovernedVersionOnly(files);
  it('allows a single version bump in package.json and the two-line bump in package-lock.json', () => {
    expect(g([file('package.json', { removed: ['  "version": "5.0.1",'], added: ['  "version": "5.0.2",'] }),
      file('package-lock.json', { removed: [ver('5.0.1', 'x')[0], '    "version": "5.0.1",'], added: ['  "version": "5.0.2",', '    "version": "5.0.2",'] })]).mechanical).toBe(true);
  });
  it('allows append-only lines in the qualification contract', () => expect(g([file('scripts/release-qualification-contract.mjs', { added: ["  'tests/unit/a.test.mjs',"] })]).mechanical).toBe(true));
  it('no governed changes is trivially mechanical', () => expect(g([]).mechanical).toBe(true));
  const bad = [
    ['a dependency line in package.json', file('package.json', { removed: [], added: ['    "left-pad": "^1.0.0",'] })],
    ['a script edit in package.json', file('package.json', { removed: ['"test": "vitest run"'], added: ['"test": "true"'] })],
    ['a version line plus a dependency line', file('package.json', { removed: ['  "version": "5.0.1",'], added: ['  "version": "5.0.2",', '"x": "1"'] })],
    ['two different version bumps in one file', file('package-lock.json', { removed: ['  "version": "1.0.0",', '    "version": "2.0.0",'], added: ['  "version": "1.0.1",', '    "version": "2.0.1",'] })],
    ['one old version but two different new ones', file('package-lock.json', { removed: Array(2).fill('  "version": "1.0.0",'), added: ['  "version": "1.0.1",', '  "version": "2.0.0",'] })],
    ['a deleted contract file even with no removed lines recorded', file('scripts/release-qualification-contract.mjs', { status: 'D' })],
    ['three version lines in the lockfile', file('package-lock.json', { removed: Array(3).fill('  "version": "1.0.0",'), added: Array(3).fill('  "version": "1.0.1",') })],
    ['a removed line in the contract', file('scripts/release-qualification-contract.mjs', { removed: ["  'old',"], added: ["  'new',"] })],
    ['any other governed file', file('scripts/release.mjs', { added: ['x'] })],
    ['a deleted package.json', file('package.json', { status: 'D', removed: ['  "version": "5.0.1",'] })],
    ['a symlinked contract', file('scripts/release-qualification-contract.mjs', { symlink: true, added: ['x'] })],
  ];
  for (const [name, f] of bad) it(`refuses ${name}`, () => { const r = g([f]); expect(r.mechanical).toBe(false); expect(r.reason).toContain(f.path); });
});

describe('findClosingKeywords', () => {
  it('finds every GitHub closing form', () => {
    for (const s of ['fixes #12', 'Fixed #12', 'fix #12', 'closes #3', 'Closed: #3', 'resolve #4', 'Resolves  #4', 'fixes stuinfla/ruvnet-brain#12', 'closes GH-12',
      'fixes https://github.com/stuinfla/ruvnet-brain/issues/12'])
      expect(P.findClosingKeywords(`autofix: ${s} in text`), s).toHaveLength(1);
  });
  it('the planted "fixes #12" is found among otherwise clean text', () => expect(P.findClosingKeywords('Refs issue 12 (ADR-107 autofix).\n\nfixes #12')).toEqual(['fixes #12']));
  it('the real commit and PR wording is clean', () => {
    for (const s of ['autofix: issue 12 — updater crash', 'Refs issue 12 (ADR-107 autofix).', 'release 5.0.2: autofix issue 12', 'prefix #12 and suffixes #3', 'see #12', 'fix the bug in issue 12'])
      expect(P.findClosingKeywords(s), s).toEqual([]);
    expect(P.findClosingKeywords(undefined)).toEqual([]);
  });
  it('is safe to call repeatedly (no sticky global regex state)', () => { for (let i = 0; i < 3; i++) expect(P.findClosingKeywords('fixes #1')).toHaveLength(1); });
});

describe('integration with issue-watch: why the BOT_MARKER prefix rule exists', () => {
  const posted = (body) => [{ author: { login: 'stuinfla' }, body }];
  const old = { createdAt: new Date(NOW - 10 * HOUR).toISOString() };
  it('a marker-prefixed comment does not silence the SLA; the same text with the marker only at the END does', () => {
    expect(judgeIssue(old, posted(`${BOT_MARKER} fix report\n\nhi`), NOW).breach).toBe(true);
    expect(judgeIssue(old, posted(`fix report\n\nhi ${BOT_MARKER}`), NOW).breach).toBe(false);
  });
  it('caps are the frozen values', () => expect(P.CAPS).toEqual({ maxPlannedPerRun: 50, lifetimeAttempts: 3, maxFailed: 1,
    minAgeMs: 3_600_000, minBodyChars: 40, maxChangedLines: 400, maxFiles: 12 }));
});

describe('release window: stale release branches and PRs below main do not close it (measured 2026-10-30)', () => {
  const base = { openReleaseBlockers: [], activeRuns: [], remoteReleaseBranches: [], openReleasePrs: [], holdFile: false, mainVersion: '4.7.22',
    npmLatest: '4.7.22', releasesLatestTag: 'v4.7.22', mainVersionInstallVerified: true, nextCorpusDispatchAt: Date.UTC(2026, 9, 31, 5, 17) };
  const now = Date.UTC(2026, 9, 30, 14, 30);
  const judge = (f) => P.judgeReleaseWindow({ ...base, ...f }, { now });
  it('an old deferred PR from release/4.5.15 does not block; one from release/4.7.23 does; no head names blocks all', () => {
    expect(judge({ openReleasePrs: [413], openReleasePrHeads: { 413: 'release/4.5.15' } })).toEqual({ open: true, reasons: [] });
    expect(judge({ openReleasePrs: [9], openReleasePrHeads: { 9: 'release/4.8.1' } }).reasons).toEqual(['open-release-pr:9']);
    expect(judge({ openReleasePrs: [9], openReleasePrHeads: { 9: 'release/next' } }).reasons).toEqual(['open-release-pr:9']);
    expect(judge({ openReleasePrs: [413] }).reasons).toEqual(['open-release-pr:413']);
  });
  it('a suffixed branch is judged by its leading version (gatherWindowFacts parses it); an unversioned one still blocks', () => {
    expect(judge({ remoteReleaseBranches: [{ name: 'release/4.5.15-stop', version: '4.5.15' }] }).open).toBe(true);
    expect(judge({ remoteReleaseBranches: [{ name: 'release/4.8.1-x', version: '4.8.1' }] }).reasons).toEqual(['release-branch-ahead:release/4.8.1-x']);
    expect(judge({ remoteReleaseBranches: [{ name: 'release/next', version: '' }] }).reasons).toEqual(['release-branch-ahead:release/next']);
  });
});

describe('judgePlan: a plan whose lists are not paths is malformed, not a verdict (rehearsal 2026-10-30)', () => {
  const plan = { classification: 'fixable', risk: 'medium', injectionSuspected: false, summary: 's', platformSpecific: [],
    rootCause: { file: 'scripts/onboarding-console.mjs', line: 1948, explanation: 'x' }, files: ['scripts/onboarding-console.mjs'],
    testPlan: { failsBeforeFix: true, newTests: ['tests/regression/fleet-nested-swarm-dedup.test.mjs — tmp tree root/project/.git'] } };
  it('prose in newTests stops it as plan-malformed with nothing public', () => {
    expect(P.judgePlan(plan)).toEqual({ proceed: false, code: 'plan-malformed', publicFindings: false });
  });
  it('the same plan with a path proceeds', () => {
    expect(P.judgePlan({ ...plan, testPlan: { ...plan.testPlan, newTests: ['tests/regression/fleet-nested-swarm-dedup.test.mjs'] } }).proceed).toBe(true);
  });
});

