// ADR-107 S7-S12: the journal-driven, resumable ship. A real temp bare origin + clone (git is real against file://), and
// a scripted fake GitHub in which a protected-release run exists ONLY after it was dispatched, so a second dispatch,
// a second PR or a second push shows up as a second recorded call.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { AutofixAbort } from '../../scripts/issue-autofix-policy.mjs';
import { shipRelease, verifyTerminal } from '../../scripts/issue-autofix-release.mjs';
import { makeRepos, makeCtx, makeReleaseWorktree, realGit, head, remoteMain, allCalls, isForbidden, REPO } from './issue-autofix-release-harness.mjs';

const VERSION = '1.0.1';
const MIN = 60_000;
const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s*#\d+/i;
const GOOD_JOBS = [{ name: 'verified-candidate', conclusion: 'success' }, { name: 'publish', conclusion: 'success' }, { name: 'windows', conclusion: 'skipped' }, { name: 'finalize-public-verification', conclusion: 'success' }];
let repos; let rwt; let sha; let st;

beforeEach(() => {
  repos = makeRepos();
  rwt = makeReleaseWorktree(repos, VERSION);
  sha = head(rwt);
  st = { preflight: 'success', preflightStatus: 'completed', checks: 'pass', prepush: 0, jobs: GOOD_JOBS, runs: [], openPrs: [],
    releaseTag: `v${VERSION}`, npmLatest: VERSION, runtimeOk: true };
});
afterAll(() => { for (const c of allCalls) expect(isForbidden(c.cmd, c.args), `${c.cmd} ${c.args.join(' ')}`).toBe(false); });

/** Fake gh/npm/node. `e` gives the world the shared fake clock. */
function world(cmd, args, e) {
  const a = args.join(' ');
  if (cmd === 'gh') {
    if (/^run list .*release-candidate-preflight/.test(a)) return JSON.stringify([{ databaseId: 11, headSha: st.preflightSha || sha, status: st.preflightStatus, conclusion: st.preflight }]);
    if (/^run watch 11/.test(a)) return st.preflightWatchTimeout ? { status: null, timedOut: true } : { status: 0 };
    if (/^run view 11/.test(a)) return JSON.stringify({ status: 'completed', conclusion: st.preflightView ?? st.preflight, headSha: sha });
    if (/^pr list .*--head release\/1\.0\.1/.test(a)) return st.prListFail ? { status: 1, stderr: 'HTTP 502' } : JSON.stringify(st.openPrs);
    if (/^pr create/.test(a)) { st.openPrs = [{ number: 42 }]; return 'https://github.com/owner/repo/pull/42\n'; }
    if (/^pr checks 42/.test(a)) { st.onChecks?.(); return st.checksTimeout ? { status: null, timedOut: true } : { status: st.checks === 'pass' ? 0 : 1, stdout: st.checks }; }
    if (/^pr close 42/.test(a)) return '';
    if (/^workflow run protected-release/.test(a)) {
      if (st.dispatchFail) return { status: 1, stderr: 'HTTP 502' };
      if (!st.runNeverAppears) st.runs.push({ databaseId: 22, displayTitle: `protected-release code ${VERSION}`, createdAt: new Date(e.clock()).toISOString(), status: 'completed' });
      return st.dispatchReplyLost ? { status: 1, stderr: 'connection reset' } : '';
    }
    if (/^run list .*protected-release/.test(a)) return st.runListFail ? { status: 1 } : JSON.stringify(st.runs);
    if (/^run watch 22/.test(a)) return st.releaseWatchTimeout ? { status: null, timedOut: true } : { status: st.jobs.every((j) => ['success', 'skipped'].includes(j.conclusion)) ? 0 : 1 };
    if (/^run view 22/.test(a)) return st.runViewFail ? { status: 1 } : JSON.stringify({ status: 'completed', conclusion: 'x', jobs: st.jobs });
    if (/^release view/.test(a)) return JSON.stringify({ tagName: st.releaseTag });
    if (/^api repos\/owner\/repo\/actions\/runs\/22\/artifacts/.test(a)) return JSON.stringify({ artifacts: [{ id: 33, name: `publication-evidence-${sha}`, expired: false }] });
    if (/^api repos\/owner\/repo\/dispatches/.test(a)) return '';
  }
  if (cmd === 'npm' && /^run release:prepush -- --pre-dispatch --sha [0-9a-f]{40}$/.test(a)) return { status: st.prepush, stdout: st.prepush ? 'corpus generation moved' : '' };
  if (cmd === 'node' && /approved-runtime/.test(a)) return { status: st.runtimeOk ? 0 : 1 };
  if (cmd === 'npm' && /^view ruvnet-brain dist-tags.latest/.test(a)) return st.npmLatest;
  return null;
}

const J = (o = {}) => ({ version: VERSION, branch: `release/${VERSION}`, sha, issues: [5, 9], rwt, ...o });
/** One ctx (one fake clock, one call log) that may run the same journal several times. */
function ship({ checkpoint, gitHook, extra = {} } = {}) {
  const saved = [];
  const box = {};
  box.e = makeCtx(repos, { handler: (c, a) => world(c, a, box.e), checkpoint, gitHook,
    extra: { saveJournal: (j) => saved.push(JSON.parse(JSON.stringify(j))), ...extra } });
  return { e: box.e, saved, run: (journal) => shipRelease(box.e.ctx, { rwt, journal }) };
}
const stopAt = (name, code = 'kill-switch-off') => async (n) => { if (n === name) throw new AutofixAbort(n, code, 'off'); };
const pushMain = () => realGit(rwt, ['push', 'origin', `${sha}:refs/heads/main`]);
const pushBranch = () => realGit(rwt, ['push', 'origin', `release/${VERSION}`]);
const releaseBranchOnOrigin = () => realGit(repos.origin, ['rev-parse', '--verify', `refs/heads/release/${VERSION}`]);

describe('shipRelease: the happy path', () => {
  it('ships in order: push branch, preflight on the exact SHA, PR checks, pre-dispatch prepush, fast-forward main, dispatch, terminal', async () => {
    const { e, saved, run } = ship();
    const j = J();
    const r = await run(j);
    expect(r).toMatchObject({ phase: 'shipped', sha, prNumber: 42, preflightRunId: 11, releaseRunId: 22, recoveryDispatched: false, abort: null });
    expect(r.terminal).toMatchObject({ installVerified: true, npmLatest: VERSION, releasesLatest: `v${VERSION}`, mainSha: sha });
    const order = [/checkpoint S7/, /push origin release\/1\.0\.1/, /run list .*release-candidate-preflight/, /checkpoint S9/, /pr create/, /pr checks 42/,
      /release:prepush -- --pre-dispatch/, /checkpoint S10/, /push origin \S+:refs\/heads\/main/, /checkpoint S11/, /workflow run protected-release/, /run watch 22/, /release view/]
      .map((re) => e.find(re));
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(remoteMain(repos.origin)).toBe(sha);
    expect(realGit(repos.origin, ['rev-parse', 'refs/heads/release/1.0.1']).stdout.trim()).toBe(sha);
    expect(j).toMatchObject({ phase: 'shipped', moved: true, prNumber: 42, releaseRunId: 22 });
    expect(saved.at(-1).phase).toBe('shipped');
    expect(saved.find((s) => s.dispatchedAt && !s.releaseRunId)).toBeTruthy(); // the dispatch time is journalled BEFORE the dispatch
  });

  it('main is pushed as a plain SHA-to-ref fast-forward, the dispatch uses long-form fields, and nothing says Fixes #N', async () => {
    const { e, run } = ship();
    await run(J());
    const push = e.calls.find((c) => c.cmd === 'git' && c.args.includes('push') && c.args.some((x) => /refs\/heads\/main$/.test(x)));
    expect(push.args).toEqual(['-C', rwt, 'push', 'origin', `${sha}:refs/heads/main`]);
    const dispatch = e.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'workflow');
    expect(dispatch.args).toEqual(['workflow', 'run', 'protected-release.yml', '--repo', REPO, '--raw-field', 'mode=code', '--raw-field', `candidate_sha=${sha}`, '--raw-field', `version=${VERSION}`]);
    const text = e.calls.find((c) => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create').args.join(' ');
    expect(text).toContain('Refs issues 5, 9');
    expect(CLOSING.test(text)).toBe(false);
    expect(e.count(/pr merge|\/merge/)).toBe(0);
  });

  it('a ctx.gates override replaces the pre-dispatch prepush; a red one stops before main moves', async () => {
    const { e, run } = ship({ extra: { gates: { 'release-prepush-dispatch': () => ({ exitCode: 1, output: 'stale generation' }) } } });
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'aborted', abort: { stage: 'S9', code: 'prepush-failed', halt: false } });
    expect(e.count(/release:prepush/)).toBe(0);
    expect(e.count(/refs\/heads\/main/)).toBe(0);
  });
});

describe('red before main moved: aborted, nothing public, no halt', () => {
  it('red preflight -> no PR, no main push', async () => {
    st.preflight = 'failure';
    const { e, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'aborted', abort: { stage: 'S8', code: 'preflight-failed', halt: false } });
    expect(e.count(/pr create/)).toBe(0);
    expect(e.count(/refs\/heads\/main/)).toBe(0);
    expect(remoteMain(repos.origin)).not.toBe(sha);
  });
  it('a watcher that exits 0 on a run that is not successful is not trusted', async () => {
    st.preflightStatus = 'in_progress'; st.preflightView = 'cancelled';
    const { e, run } = ship();
    const r = await run(J());
    expect(e.count(/run watch 11/)).toBe(1);
    expect(r.abort.code).toBe('preflight-failed');
    expect(e.count(/refs\/heads\/main/)).toBe(0);
  });
  it('red PR checks close the PR, keep the branch, and never push main', async () => {
    st.checks = 'fail';
    const { e, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'aborted', prNumber: 42, abort: { stage: 'S9', code: 'checks-failed', halt: false } });
    expect(e.count(/^gh pr close 42/)).toBe(1);
    expect(e.count(/refs\/heads\/main/)).toBe(0);
    expect(e.count(/push .*--delete|push origin :/)).toBe(0);
    expect(releaseBranchOnOrigin().status).toBe(0);
  });
  it('red release:prepush --pre-dispatch (corpus moved): aborted before main moves', async () => {
    st.prepush = 1;
    const { e, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'aborted', abort: { stage: 'S9', code: 'prepush-failed', halt: false } });
    expect(e.count(/checkpoint S10/)).toBe(0);
    expect(remoteMain(repos.origin)).not.toBe(sha);
  });
  it('main moved underneath (not an ancestor): no push, no halt', async () => {
    st.onChecks = () => { realGit(repos.seed, ['commit', '--allow-empty', '-m', 'someone else']); realGit(repos.seed, ['push', 'origin', 'main']); st.onChecks = null; };
    const { e, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'aborted', abort: { stage: 'S10', code: 'not-ancestor', halt: false } });
    expect(e.count(/:refs\/heads\/main/)).toBe(0);
    expect(remoteMain(repos.origin)).not.toBe(sha);
  });
  it('the release branch on the remote at a DIFFERENT sha is never overwritten', async () => {
    realGit(repos.seed, ['push', 'origin', `HEAD:refs/heads/release/${VERSION}`]);
    const { e, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'aborted', abort: { stage: 'S7', code: 'branch-exists' } });
    expect(e.count(/push origin release/)).toBe(0);
  });
  it('a bad journal (sha or version) is refused before anything runs', async () => {
    const { e, run } = ship();
    expect((await run(J({ sha: 'HEAD' }))).abort).toMatchObject({ code: 'push-failed' });
    expect((await run(J({ version: 'v1.0.1' }))).abort).toMatchObject({ code: 'branch-exists' });
    expect(e.calls).toEqual([]);
  });
});

describe('transient before main moved: paused, journal kept, nothing closed', () => {
  for (const [name, set, stage] of [
    ['gh cannot list PRs', () => { st.prListFail = true; }, 'S9'],
    ['PR checks still running after 30 minutes', () => { st.checksTimeout = true; }, 'S9'],
    ['preflight watch timed out', () => { st.preflightStatus = 'in_progress'; st.preflightWatchTimeout = true; }, 'S8'],
    ['preflight for the sha never appeared (preflight-timeout)', () => { st.preflightSha = 'd'.repeat(40); }, 'S8'],
  ]) it(name, async () => {
    set();
    const { e, saved, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'paused', abort: { stage, halt: false } });
    expect(saved.at(-1).phase).toBe('paused');
    expect(e.count(/pr close/)).toBe(0);
    expect(e.count(/refs\/heads\/main/)).toBe(0);
  });
  it('a preflight run for a different sha is never accepted: no watch, no PR, 10 fake minutes waited', async () => {
    st.preflightSha = 'd'.repeat(40);
    const { e, run } = ship();
    expect((await run(J())).abort.code).toBe('preflight-timeout');
    expect(e.count(/run watch/)).toBe(0);
    expect(e.count(/pr create/)).toBe(0);
    expect(e.clock() - Date.parse('2026-10-29T14:00:00Z')).toBeGreaterThanOrEqual(10 * MIN);
  });
});

describe('kill switch: re-read immediately before every irreversible step', () => {
  it('is the very next command before branch push, PR create, main push, dispatch and recovery dispatch', async () => {
    const { e, run } = ship();
    await run(J());
    const idx = (re) => e.find(re);
    expect(idx(/^git .* push origin release\/1\.0\.1/)).toBe(idx(/checkpoint S7/) + 1);
    expect(idx(/^gh pr create/)).toBe(idx(/checkpoint S9/) + 1);
    expect(idx(/^git .* push origin \S+:refs\/heads\/main/)).toBe(idx(/checkpoint S10/) + 1);
    expect(idx(/^gh workflow run/)).toBe(idx(/checkpoint S11/) + 1);
    st.jobs = [{ name: 'finalize-public-verification', conclusion: 'failure' }];
    const r2 = ship(); await r2.run(J({ moved: true, movedAt: r2.e.clock() }));
    expect(r2.e.find(/^gh api repos\/owner\/repo\/dispatches/)).toBe(r2.e.find(/checkpoint S12/) + 1);
  });
  it('off at S7: nothing is pushed anywhere; paused', async () => {
    const { e, run } = ship({ checkpoint: stopAt('S7') });
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'paused', abort: { stage: 'S7', code: 'kill-switch-off', halt: false } });
    expect(releaseBranchOnOrigin().status).not.toBe(0);
    expect(e.count(/ push /)).toBe(0);
  });
  it('off at S9: no PR is created; paused', async () => {
    const { e, run } = ship({ checkpoint: stopAt('S9') });
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'paused', abort: { stage: 'S9', code: 'kill-switch-off', halt: false } });
    expect(e.count(/pr create/)).toBe(0);
    expect(e.count(/refs\/heads\/main/)).toBe(0);
  });
  it('off at S10: the release branch exists but main does not move and no halt is written', async () => {
    const { e, run } = ship({ checkpoint: stopAt('S10') });
    const before = remoteMain(repos.origin);
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'paused', abort: { stage: 'S10', code: 'kill-switch-off', halt: false } });
    expect(remoteMain(repos.origin)).toBe(before);
    expect(e.count(/:refs\/heads\/main/)).toBe(0);
  });
  it('off at S11: main has moved, nothing is dispatched, paused (not halted); the next armed run dispatches once', async () => {
    let off = true;
    const { e, run } = ship({ checkpoint: async (n) => { if (off && n === 'S11') throw new AutofixAbort(n, 'kill-switch-off', 'off'); } });
    const j = J();
    const r = await run(j);
    expect(r).toMatchObject({ phase: 'paused', abort: { stage: 'S11', code: 'kill-switch-off', halt: false } });
    expect(j.moved).toBe(true);
    expect(remoteMain(repos.origin)).toBe(sha);
    expect(e.count(/^gh workflow run/)).toBe(0);
    off = false;
    expect((await run(j)).phase).toBe('shipped');
    expect(e.count(/^gh workflow run/)).toBe(1);
    expect(e.count(/:refs\/heads\/main/)).toBe(1);
  });
});

describe('resume: every step first looks for its own effect', () => {
  it('branch already pushed at the sha: no S7 checkpoint, no second branch push', async () => {
    pushBranch();
    const { e, run } = ship();
    expect((await run(J())).phase).toBe('shipped');
    expect(e.count(/checkpoint S7/)).toBe(0);
    expect(e.count(/push origin release\//)).toBe(0);
  });
  it('PR already open for the head: it is adopted, never created again', async () => {
    pushBranch(); st.openPrs = [{ number: 42 }];
    const { e, run } = ship();
    const r = await run(J());
    expect(r).toMatchObject({ phase: 'shipped', prNumber: 42 });
    expect(e.count(/pr create/)).toBe(0);
    expect(e.count(/checkpoint S9/)).toBe(0);
  });
  it('PR number already in the journal: no list, no create', async () => {
    pushBranch();
    const { e, run } = ship();
    expect((await run(J({ prNumber: 42 }))).phase).toBe('shipped');
    expect(e.count(/pr list|pr create/)).toBe(0);
  });
  it('main already at the sha (died after the push, before the journal said so): no second main push', async () => {
    pushBranch(); pushMain();
    const { e, run } = ship();
    const j = J({ prNumber: 42 });
    expect((await run(j)).phase).toBe('shipped');
    expect(j.moved).toBe(true);
    expect(e.count(/:refs\/heads\/main/)).toBe(0);
    expect(e.count(/checkpoint S10/)).toBe(0);
    expect(e.count(/merge-base/)).toBe(0);
  });
  it('moved in the journal: S7-S10 are skipped entirely', async () => {
    pushBranch(); pushMain();
    const { e, run } = ship();
    expect((await run(J({ moved: true, movedAt: Date.parse('2026-10-29T13:59:00Z') }))).phase).toBe('shipped');
    expect(e.count(/push|pr create|pr checks|release-candidate-preflight|release:prepush/)).toBe(0);
  });
  it('run already dispatched and visible: watched, never dispatched again', async () => {
    pushBranch(); pushMain();
    const t = Date.parse('2026-10-29T13:59:00Z');
    st.runs = [{ databaseId: 22, displayTitle: `protected-release code ${VERSION}`, createdAt: new Date(t + 30_000).toISOString(), status: 'completed' }];
    const { e, run } = ship();
    expect((await run(J({ moved: true, movedAt: t, dispatchedAt: t }))).phase).toBe('shipped');
    expect(e.count(/workflow run/)).toBe(0);
    expect(e.count(/checkpoint S11/)).toBe(0);
  });
  it('run id already in the journal: no list, no dispatch', async () => {
    pushMain();
    const { e, run } = ship();
    expect((await run(J({ moved: true, releaseRunId: 22 }))).phase).toBe('shipped');
    expect(e.count(/workflow run|run list .*protected-release/)).toBe(0);
  });
  it('dispatch reply lost but the run exists: the next run finds it and does not dispatch twice', async () => {
    st.dispatchReplyLost = true;
    const { e, run } = ship();
    const j = J();
    const r1 = await run(j);
    expect(r1).toMatchObject({ phase: 'paused', abort: { stage: 'S11', code: 'transient' } });
    expect(j.dispatchedAt).toBeNull();
    st.dispatchReplyLost = false;
    expect((await run(j)).phase).toBe('shipped');
    expect(e.count(/^gh workflow run/)).toBe(1);
  });
  it('an older run with the same title, created before main moved, is not ours: we dispatch our own', async () => {
    pushMain();
    const { e, run } = ship();
    const movedAt = e.clock();
    st.runs = [{ databaseId: 99, displayTitle: `protected-release code ${VERSION}`, createdAt: new Date(movedAt - 60 * MIN).toISOString(), status: 'completed' }];
    const r = await run(J({ moved: true, movedAt }));
    expect(r).toMatchObject({ phase: 'shipped', releaseRunId: 22 });
    expect(e.count(/^gh workflow run/)).toBe(1);
  });
  it('a whole interrupted night (watch timed out) resumes to shipped with exactly one push, PR, main push and dispatch', async () => {
    st.releaseWatchTimeout = true;
    const { e, run } = ship();
    const j = J();
    expect((await run(j))).toMatchObject({ phase: 'paused', abort: { stage: 'S11', halt: false } });
    st.releaseWatchTimeout = false;
    expect((await run(j)).phase).toBe('shipped');
    for (const re of [/push origin release\//, /^gh pr create/, /:refs\/heads\/main/, /^gh workflow run/]) expect(e.count(re), String(re)).toBe(1);
  });
});

describe('after main moved: transient -> paused, definite red -> halted or published-unverified', () => {
  const moved = (o = {}) => { pushMain(); return J({ moved: true, movedAt: Date.parse('2026-10-29T13:59:00Z'), ...o }); };
  for (const [name, set] of [
    ['gh cannot list runs', () => { st.runListFail = true; }],
    ['the release watch timed out', () => { st.releaseWatchTimeout = true; }],
    ['the run view is unreadable', () => { st.runViewFail = true; }],
    ['the dispatch call failed', () => { st.dispatchFail = true; }],
  ]) it(`${name}: paused, halt false, no recovery`, async () => {
    set();
    const { e, run } = ship();
    const r = await run(moved());
    expect(r).toMatchObject({ phase: 'paused', abort: { stage: 'S11', halt: false } });
    expect(e.count(/dispatches/)).toBe(0);
  });
  it('a run missing < 30 min after the dispatch is transient (no second dispatch); after 30 min it is dispatch-not-found and halts', async () => {
    st.runNeverAppears = true;
    const { e, run } = ship();
    const j = moved();
    const r1 = await run(j);
    expect(r1).toMatchObject({ phase: 'paused', abort: { stage: 'S11', code: 'transient', halt: false } });
    expect(e.clock() - j.dispatchedAt).toBeLessThan(30 * MIN);
    e.tick(10 * MIN);
    expect((await run(j)).phase).toBe('paused');
    e.tick(20 * MIN);
    st.npmLatest = '1.0.0';
    const r3 = await run(j);
    expect(r3).toMatchObject({ phase: 'halted', abort: { stage: 'S11', code: 'dispatch-not-found', halt: true } });
    expect(e.count(/^gh workflow run/)).toBe(1);
  });
  it('failed release job on a published version: published-unverified, halt, ONE recovery dispatch with the exact payload', async () => {
    st.jobs = [{ name: 'publish', conclusion: 'success' }, { name: 'finalize-public-verification', conclusion: 'failure' }];
    const { e, saved, run } = ship();
    const j = moved();
    const r = await run(j);
    expect(r).toMatchObject({ phase: 'published-unverified', recoveryDispatched: true, abort: { stage: 'S11', code: 'release-failed', halt: true } });
    const calls = e.calls.filter((c) => c.cmd === 'gh' && /dispatches/.test(c.args.join(' ')));
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['api', 'repos/owner/repo/dispatches', '--method', 'POST', '--input', '-']);
    expect(JSON.parse(calls[0].opts.input)).toEqual({ event_type: 'recover-public-verification',
      client_payload: { candidate_sha: sha, version: VERSION, publication_run_id: '22', artifact_id: '33' } });
    expect(saved.find((s) => s.recoveryDispatched)).toBeTruthy();
    // a re-run of the same journal never recovers twice
    expect((await run(j)).phase).toBe('published-unverified');
    expect(e.count(/dispatches/)).toBe(1);
  });
  it('recovery already dispatched in the journal: never again', async () => {
    st.jobs = [{ name: 'finalize-public-verification', conclusion: 'failure' }];
    const { e, run } = ship();
    const r = await run(moved({ releaseRunId: 22, recoveryDispatched: true }));
    expect(r).toMatchObject({ phase: 'published-unverified', recoveryDispatched: true });
    expect(e.count(/dispatches|artifacts/)).toBe(0);
  });
  it('kill switch off at the recovery checkpoint: no recovery, still published-unverified with halt', async () => {
    st.jobs = [{ name: 'finalize-public-verification', conclusion: 'failure' }];
    const { e, run } = ship({ checkpoint: stopAt('S12') });
    const r = await run(moved());
    expect(r).toMatchObject({ phase: 'published-unverified', recoveryDispatched: false, abort: { halt: true } });
    expect(e.count(/dispatches/)).toBe(0);
  });
  it('red and NOT published: halted, no recovery dispatch', async () => {
    st.npmLatest = '1.0.0'; st.releaseTag = 'v1.0.0';
    st.jobs = [{ name: 'verified-candidate', conclusion: 'failure' }];
    const { e, run } = ship();
    const r = await run(moved());
    expect(r).toMatchObject({ phase: 'halted', recoveryDispatched: false, abort: { code: 'release-failed', halt: true } });
    expect(e.count(/dispatches/)).toBe(0);
  });
  it('all jobs green but releases/latest stale: published-unverified at S12, halt', async () => {
    st.releaseTag = 'v1.0.0';
    const { run } = ship();
    const r = await run(moved());
    expect(r).toMatchObject({ phase: 'published-unverified', abort: { stage: 'S12', code: 'terminal-unverified', halt: true } });
    expect(r.terminal.installVerified).toBe(false);
  });
  it('a skipped finalize-public-verification is not a release; no jobs at all is not a release', async () => {
    st.jobs = [{ name: 'publish', conclusion: 'success' }, { name: 'finalize-public-verification', conclusion: 'skipped' }];
    expect((await ship().run(moved())).abort.code).toBe('release-failed');
    st.jobs = [];
    expect((await ship().run(J({ moved: true, movedAt: 0 }))).abort.code).toBe('release-failed');
  });
});

describe('main promotion is confirmed on the remote', () => {
  // A push to main that SUCCEEDED while the remote then reads another sha means main has (or may have) moved: halt.
  // (Found by this suite on 2026-10-30 as an it.fails; fixed in stepPromote, which now marks the journal moved.)
  it('a push that reports success while the remote ref is not the candidate halts (main may have moved)', async () => {
    const other = 'e'.repeat(40);
    let pushed = false;
    const { run } = ship({ gitHook: (args) => {
      if (args.includes('push') && args.some((x) => /:refs\/heads\/main$/.test(x))) pushed = true;
      return pushed && args.includes('ls-remote') && args.includes('refs/heads/main') && args.includes(rwt) ? { stdout: `${other}\trefs/heads/main\n` } : null;
    } });
    const r = await run(J());
    expect(r.abort).toMatchObject({ stage: 'S10', code: 'main-moved' });
    expect(r.abort.halt).toBe(true);
  });
  it('the same case at least never reports shipped and never dispatches', async () => {
    const other = 'e'.repeat(40);
    let pushed = false;
    const { e, run } = ship({ gitHook: (args) => {
      if (args.includes('push') && args.some((x) => /:refs\/heads\/main$/.test(x))) pushed = true;
      return pushed && args.includes('ls-remote') && args.includes('refs/heads/main') && args.includes(rwt) ? { stdout: `${other}\trefs/heads/main\n` } : null;
    } });
    const r = await run(J());
    expect(r.abort).toMatchObject({ stage: 'S10', code: 'main-moved' });
    expect(r.phase).not.toBe('shipped');
    expect(e.count(/workflow run/)).toBe(0);
  });
});

describe('verifyTerminal: every disagreement is not install-verified', () => {
  it.each([
    ['runtime does not resolve', { runtimeOk: false }],
    ['npm latest is older', { npmLatest: '1.0.0' }],
    ['releases/latest is older', { releaseTag: 'v1.0.0' }],
  ])('%s', async (_n, patch) => {
    Object.assign(st, patch);
    pushMain();
    expect((await verifyTerminal(ship().e.ctx, { version: VERSION, sha })).installVerified).toBe(false);
  });
  it('main is not the candidate sha', async () => expect((await verifyTerminal(ship().e.ctx, { version: VERSION, sha })).installVerified).toBe(false));
  it('everything agrees', async () => {
    pushMain();
    expect(await verifyTerminal(ship().e.ctx, { version: VERSION, sha })).toMatchObject({ installVerified: true, mainSha: sha });
  });
});
