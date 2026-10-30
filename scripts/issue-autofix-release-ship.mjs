// S7-S12 of the autofix pipeline (ADR-107): push the release branch, wait for preflight on the EXACT SHA, open the PR
// for its required checks, re-check the corpus generation, move main by fast-forward only, dispatch the protected
// release, watch every job, then check the terminal state. Every external call goes through ctx.exec.
//
// RESUMABLE. Each step records itself in a journal (ctx.saveJournal) and first looks for its own effect on GitHub, so a
// run killed by a network drop, Mac sleep or the job's wall clock is finished by the next run without a second push,
// a second PR or a second dispatch. The kill switch is re-read (ctx.checkpoint) immediately before every irreversible
// step: push, PR create, main fast-forward, dispatch, recovery dispatch.
//
// HALT only on a definite red once main has moved (a concluded red release run, a terminal check that fails after the
// run concluded green). A transient failure (gh or network unreachable, a watch that timed out, the kill switch
// unreadable or off) keeps the journal and returns phase 'paused': the next armed run resumes it.
import path from 'node:path';
import { AutofixAbort } from './issue-autofix-policy.mjs';
import {
  MIN, SHA_RE, tail, must, git, mustGit, gh, ghJson, ghBin, assertCleanText, assertVersion,
  poll, queryNpmLatest, queryReleasesLatest, queryRemoteMain, resolveRuntime,
} from './issue-autofix-release-util.mjs';

const POLL_MS = 30_000;
const PREFLIGHT_WORKFLOW = 'release-candidate-preflight.yml';
const RELEASE_WORKFLOW = 'protected-release.yml';
const OK_JOB = new Set(['success', 'skipped']);
const TRANSIENT = new Set(['transient', 'kill-switch-off', 'halted', 'preflight-timeout', 'window-closed']);

/** Terminal install-verified check; also used by S13b for an already-published tag. */
export async function verifyTerminal(ctx, { version, sha }) {
  const out = path.join(ctx.runDir || '.', `approved-runtime-${version}.json`);
  const runtimeResolved = await resolveRuntime(ctx, version, out);
  const npmLatest = await queryNpmLatest(ctx);
  const releasesLatest = await queryReleasesLatest(ctx);
  const mainSha = await queryRemoteMain(ctx);
  const installVerified = runtimeResolved && npmLatest === version && releasesLatest === `v${version}` && mainSha === sha;
  return { installVerified, npmLatest, releasesLatest, mainSha, runtimeResolved };
}

const transient = (stage, detail) => new AutofixAbort(stage, 'transient', detail);

async function remoteBranchSha(ctx, branch) {
  const r = await git(ctx, ctx.clone, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (r.status !== 0 || r.timedOut) throw transient('S7', `cannot read remote ${branch}`);
  return r.stdout.trim().split(/\s+/)[0] || null;
}

async function stepPush(ctx, j, rwt) {
  const there = await remoteBranchSha(ctx, j.branch);
  if (there === j.sha) return;
  if (there) throw new AutofixAbort('S7', 'branch-exists', `${j.branch} is at ${there} on the remote, not ${j.sha}`);
  await ctx.checkpoint('S7');
  const r = await git(ctx, rwt, ['push', 'origin', j.branch]);
  if (r.status !== 0 || r.timedOut) {
    if (await remoteBranchSha(ctx, j.branch) === j.sha) return; // the push landed; only the reply was lost
    throw transient('S7', `push: ${tail(r.stderr || r.stdout, 300)}`);
  }
}

async function stepPreflight(ctx, j) {
  const list = ['run', 'list', '--repo', ctx.repo, '--workflow', PREFLIGHT_WORKFLOW, '--branch', j.branch,
    '--json', 'databaseId,headSha,status,conclusion', '--limit', '20'];
  const found = await poll(ctx, { limitMs: 10 * MIN, intervalMs: POLL_MS, fn: async () => {
    const r = await ghJson(ctx, list);
    return Array.isArray(r.value) ? r.value.find((x) => x.headSha === j.sha) || null : null;
  } });
  if (!found) throw new AutofixAbort('S8', 'preflight-timeout', `no preflight run for ${j.sha} within 10 minutes`);
  j.preflightRunId = found.databaseId; ctx.saveJournal(j);
  if (found.status !== 'completed') {
    const w = await gh(ctx, ['run', 'watch', String(found.databaseId), '--repo', ctx.repo, '--exit-status'], { timeoutMs: 60 * MIN });
    if (w.timedOut) throw transient('S8', `preflight ${found.databaseId} still running after 60 minutes`);
  }
  const v = await ghJson(ctx, ['run', 'view', String(found.databaseId), '--repo', ctx.repo, '--json', 'status,conclusion,headSha']);
  if (!v.ok) throw transient('S8', `cannot read preflight ${found.databaseId}`);
  if (v.value.status !== 'completed') throw transient('S8', `preflight ${found.databaseId} not finished`);
  if (v.value.conclusion !== 'success' || v.value.headSha !== j.sha) {
    throw new AutofixAbort('S8', 'preflight-failed', `run ${found.databaseId}: conclusion ${v.value.conclusion}, sha ${v.value.headSha}`);
  }
}

async function stepPr(ctx, j) {
  if (!j.prNumber) {
    const open = await ghJson(ctx, ['pr', 'list', '--repo', ctx.repo, '--head', j.branch, '--state', 'open', '--json', 'number', '--limit', '5']);
    if (!open.ok) throw transient('S9', 'cannot list pull requests');
    if (open.value.length) j.prNumber = open.value[0].number;
    else {
      const title = `release ${j.version}: autofix issues ${j.issues.join(', ')}`;
      const body = `Refs issues ${j.issues.join(', ')} (ADR-107 autofix). No merge button is used; main moves by fast-forward.`;
      assertCleanText('S9', `${title}\n${body}`);
      await ctx.checkpoint('S9');
      const created = await gh(ctx, ['pr', 'create', '--repo', ctx.repo, '--base', 'main', '--head', j.branch, '--title', title, '--body', body]);
      const m = String(created.stdout).match(/\/pull\/(\d+)/);
      if (created.status !== 0 || !m) throw transient('S9', `pr create: ${tail(created.stderr || created.stdout, 300)}`);
      j.prNumber = Number(m[1]);
    }
    ctx.saveJournal(j);
  }
  const c = await gh(ctx, ['pr', 'checks', String(j.prNumber), '--repo', ctx.repo, '--required', '--watch', '--fail-fast'], { timeoutMs: 30 * MIN });
  if (c.timedOut) throw transient('S9', 'required checks not finished in 30 minutes');
  if (c.status !== 0) throw new AutofixAbort('S9', 'checks-failed', tail(c.stdout || c.stderr, 400));
}

/** release:prepush --pre-dispatch: the sealed corpus generation must still be the newest one, BEFORE main moves. */
async function stepPreDispatch(ctx, j, rwt) {
  if (ctx.gates?.['release-prepush-dispatch']) {
    const g = await ctx.gates['release-prepush-dispatch'](rwt);
    if (g.exitCode !== 0) throw new AutofixAbort('S9', 'prepush-failed', tail(g.output, 600));
    return;
  }
  const r = await ctx.exec('npm', ['run', 'release:prepush', '--', '--pre-dispatch', '--sha', j.sha], { cwd: rwt, timeoutMs: 20 * MIN });
  if (r.timedOut) throw transient('S9', 'release:prepush --pre-dispatch timed out');
  if (r.status !== 0) throw new AutofixAbort('S9', 'prepush-failed', tail(`${r.stdout}${r.stderr}`, 600));
}

async function stepPromote(ctx, j, rwt) {
  const remote = await queryRemoteMain(ctx, rwt);
  if (!remote) throw transient('S10', 'cannot read remote main');
  if (remote === j.sha) { j.moved = true; ctx.saveJournal(j); return; }
  await mustGit(ctx, 'S10', 'transient', rwt, ['fetch', 'origin', 'main']);
  const anc = await git(ctx, rwt, ['merge-base', '--is-ancestor', 'origin/main', j.sha]);
  if (anc.status === 1) throw new AutofixAbort('S10', 'not-ancestor', 'origin/main is not an ancestor of the candidate; main moved');
  if (anc.status !== 0) throw transient('S10', tail(anc.stderr, 300));
  await ctx.checkpoint('S10'); // kill switch + release window, immediately before the irreversible step
  const push = await git(ctx, rwt, ['push', 'origin', `${j.sha}:refs/heads/main`]);
  const after = await queryRemoteMain(ctx, rwt);
  if (after === j.sha) { j.moved = true; j.movedAt = ctx.now(); ctx.saveJournal(j); return; }
  // The push said yes but the remote names another commit: main may have moved under us. Treat it as moved (halt).
  if (push.status === 0) { j.moved = true; j.movedAt = ctx.now(); ctx.saveJournal(j); throw new AutofixAbort('S10', 'main-moved', `remote main is ${after} after a successful push`); }
  throw transient('S10', `push exit ${push.status}: ${tail(push.stderr, 300)}`);
}

async function findReleaseRun(ctx, j) {
  const r = await ghJson(ctx, ['run', 'list', '--repo', ctx.repo, '--workflow', RELEASE_WORKFLOW,
    '--json', 'databaseId,displayTitle,createdAt,status,conclusion,headSha', '--limit', '30']);
  if (!r.ok) throw transient('S11', 'cannot list protected-release runs');
  const title = `protected-release code ${j.version}`;
  return r.value.find((x) => x.displayTitle === title && Date.parse(x.createdAt) >= (j.dispatchedAt || j.movedAt || 0) - 120_000) || null;
}

async function stepDispatch(ctx, j) {
  let run = j.releaseRunId ? { databaseId: j.releaseRunId } : await findReleaseRun(ctx, j);
  if (!run) {
    if (!j.dispatchedAt) {
      await ctx.checkpoint('S11');
      j.dispatchedAt = ctx.now(); ctx.saveJournal(j);
      const d = await gh(ctx, ['workflow', 'run', RELEASE_WORKFLOW, '--repo', ctx.repo,
        '--raw-field', 'mode=code', '--raw-field', `candidate_sha=${j.sha}`, '--raw-field', `version=${j.version}`]);
      if (d.status !== 0) { j.dispatchedAt = null; ctx.saveJournal(j); throw transient('S11', `dispatch: ${tail(d.stderr, 300)}`); }
    }
    run = await poll(ctx, { limitMs: 5 * MIN, intervalMs: 15_000, fn: () => findReleaseRun(ctx, j) });
    // Never dispatch twice: a run that has not appeared yet is looked for again next run; after 30 min it needs a person.
    if (!run && ctx.now() - j.dispatchedAt < 30 * MIN) throw transient('S11', `no "protected-release code ${j.version}" run yet`);
    if (!run) throw new AutofixAbort('S11', 'dispatch-not-found', `no "protected-release code ${j.version}" run 30 minutes after the dispatch`);
  }
  j.releaseRunId = run.databaseId; ctx.saveJournal(j);
  const w = await gh(ctx, ['run', 'watch', String(run.databaseId), '--repo', ctx.repo, '--exit-status'], { timeoutMs: 150 * MIN });
  if (w.timedOut) throw transient('S11', 'protected-release still running after 150 minutes');
  const v = await ghJson(ctx, ['run', 'view', String(run.databaseId), '--repo', ctx.repo, '--json', 'status,jobs,conclusion']);
  if (!v.ok) throw transient('S11', `cannot read run ${run.databaseId}`);
  if (v.value.status !== 'completed') throw transient('S11', `run ${run.databaseId} not finished`);
  const jobs = Array.isArray(v.value.jobs) ? v.value.jobs : [];
  const bad = jobs.filter((x) => !OK_JOB.has(x.conclusion)).map((x) => `${x.name}=${x.conclusion}`);
  const fin = jobs.find((x) => x.name === 'finalize-public-verification');
  if (!jobs.length || bad.length || !fin || fin.conclusion !== 'success') {
    throw new AutofixAbort('S11', 'release-failed', `run ${run.databaseId}: ${bad.join(', ') || 'none red'}; finalize=${fin?.conclusion}`);
  }
}

/** Once per release (journal-guarded): ask the recovery rail to re-run public verification on a published tag. */
async function recoverOnce(ctx, j) {
  if (j.recoveryDispatched || !j.releaseRunId) return false;
  const a = await ghJson(ctx, ['api', `repos/${ctx.repo}/actions/runs/${j.releaseRunId}/artifacts`]);
  const art = (a.value?.artifacts || []).find((x) => x.name === `publication-evidence-${j.sha}` && x.expired === false);
  if (!art) return false;
  await ctx.checkpoint('S12');
  const payload = { event_type: 'recover-public-verification',
    client_payload: { candidate_sha: j.sha, version: j.version, publication_run_id: String(j.releaseRunId), artifact_id: String(art.id) } };
  j.recoveryDispatched = true; ctx.saveJournal(j);
  const r = await gh(ctx, ['api', `repos/${ctx.repo}/dispatches`, '--method', 'POST', '--input', '-'], { input: JSON.stringify(payload) });
  return r.status === 0;
}

/**
 * Drive the journal `j` ({version, branch, sha, issues, ...}) to a terminal phase:
 * 'shipped' | 'published-unverified' (halt) | 'aborted' (red before main moved; nothing public changed) |
 * 'halted' (red after main moved) | 'paused' (transient; resume next run).
 */
export async function shipRelease(ctx, { rwt, journal: j }) {
  const res = () => ({ version: j.version, sha: j.sha, branch: j.branch, prNumber: j.prNumber || null,
    preflightRunId: j.preflightRunId || null, releaseRunId: j.releaseRunId || null, terminal: j.terminal || null,
    recoveryDispatched: !!j.recoveryDispatched });
  let stage = 'S7';
  try {
    assertVersion('S7', j.version);
    if (!SHA_RE.test(String(j.sha))) throw new AutofixAbort('S7', 'push-failed', `bad candidate sha ${j.sha}`);
    if (!j.moved) {
      stage = 'S7'; await stepPush(ctx, j, rwt);
      stage = 'S8'; await stepPreflight(ctx, j);
      stage = 'S9'; await stepPr(ctx, j);
      await stepPreDispatch(ctx, j, rwt);
      stage = 'S10'; await stepPromote(ctx, j, rwt);
    }
    stage = 'S11'; await stepDispatch(ctx, j);
    stage = 'S12';
    j.terminal = await verifyTerminal(ctx, { version: j.version, sha: j.sha }); ctx.saveJournal(j);
    if (!j.terminal.installVerified) throw new AutofixAbort('S12', 'terminal-unverified', `npm ${j.terminal.npmLatest}, release ${j.terminal.releasesLatest}, main ${j.terminal.mainSha}`);
    j.phase = 'shipped'; ctx.saveJournal(j);
    return { ...res(), phase: 'shipped', abort: null };
  } catch (e) {
    const a = e instanceof AutofixAbort ? e : transient(stage, e?.message || String(e));
    const abort = { stage: a.stage || stage, code: a.code, detail: a.detail, halt: false };
    if (!j.moved) {
      if (TRANSIENT.has(a.code)) { j.phase = 'paused'; ctx.saveJournal(j); return { ...res(), phase: 'paused', abort }; }
      if (j.prNumber) await gh(ctx, ['pr', 'close', String(j.prNumber), '--repo', ctx.repo]); // best effort; the branch is kept
      j.phase = 'aborted'; ctx.saveJournal(j);
      return { ...res(), phase: 'aborted', abort };
    }
    if (TRANSIENT.has(a.code)) { j.phase = 'paused'; ctx.saveJournal(j); return { ...res(), phase: 'paused', abort }; }
    abort.halt = true;
    j.terminal = j.terminal || await verifyTerminal(ctx, { version: j.version, sha: j.sha }).catch(() => null);
    if (j.terminal?.npmLatest === j.version) {
      try { await recoverOnce(ctx, j); } catch { /* the recovery rail is best effort; the halt page carries the state */ }
      j.phase = 'published-unverified'; ctx.saveJournal(j);
      return { ...res(), phase: 'published-unverified', abort };
    }
    j.phase = 'halted'; ctx.saveJournal(j);
    return { ...res(), phase: 'halted', abort };
  }
}
