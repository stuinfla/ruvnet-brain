// scripts/issue-autofix.mjs — the daily unattended issue fixer (ADR-107). Reached only through
// `node scripts/issue-fix.mjs --mode autofix`, started by launchd (com.ruvnet.issue-autofix); no editor, terminal or
// Claude Code session is involved. This module owns the run's skeleton: kill switch, lock, S13b follow-up (which runs
// even while halted), resuming an unfinished release, the release window, selection and the injection scan. One night's
// work (fix every eligible issue, one batched release, one note per person) lives in issue-autofix-night.mjs.
//
// Every git/gh/npm call goes through issue-autofix-exec.mjs (no force, no merge, never the primary checkout); code a
// model wrote only runs through issue-autofix-sandbox.mjs; the kill switch is re-read before every stage and every
// irreversible step, and an unreadable switch counts as OFF.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_MARKER } from './issue-watch.mjs';
import { AutofixAbort, readKillSwitch, selectCandidates, judgeEligibility, judgeReleaseWindow, etDay, isPersonIssue } from './issue-autofix-policy.mjs';
import { runAgent, STAGE_CONFIG } from './issue-autofix-agents.mjs';
import * as realRelease from './issue-autofix-release.mjs';
import { acquireLock, releaseLock } from './issue-fix-lock.mjs';
import { makeExec, resolveWorkPath, defaultNotify, keepAwake } from './issue-autofix-exec.mjs';
import { makeSandboxRunner } from './issue-autofix-sandbox.mjs';
import { PATHS, STATE_NS, readNs, patchNs, patchIssue, writeAtomic, clearAwaiting } from './issue-autofix-state.mjs';
import { notifyPeople, recheckAwaiting, viewIssue } from './issue-autofix-report.mjs';
import { scanIssueText } from './issue-autofix-gate.mjs';
import { fixAll, releaseBatch, shipAndSettle, haltNight, releaseWorktreeExists } from './issue-autofix-night.mjs';
import { mustGit, must, queryNpmLatest, queryReleasesLatest, resolveRuntime } from './issue-autofix-release-util.mjs';
import { advanceRunner } from './issue-autofix-runner.mjs';

export { PATHS, STATE_NS, resolveWorkPath, makeExec };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'stuinfla/ruvnet-brain';
const ORIGIN_URL = `https://github.com/${REPO}.git`;
const IDENTITY = { name: 'RuvNet Brain Autofix', email: 'stuinfla@users.noreply.github.com' };
const HOUR = 3_600_000;
export const JOB_BUDGET_MS = 9.5 * HOUR;          // JOB_MAX_SECONDS in the plist is 10 h; the heartbeat kills at 10 h
export const RELEASE_RESERVE_MS = 3.5 * HOUR;    // preflight + PR checks + protected-release + verification, measured 1.2-2.6 h
const REPLY_LABELS = ['enhancement', 'design', 'question', 'discussion', 'needs-owner'];
const iso = (ms) => new Date(ms).toISOString();

function assertSimulateAllowed({ dryRun, ghBin, claudeBin, origin }) {
  const bad = [];
  if (!dryRun) bad.push('--dry-run is not set');
  if (!ghBin || path.basename(ghBin) === 'gh') bad.push('GH_BIN is the real gh');
  if (!claudeBin || path.basename(claudeBin) === 'claude') bad.push('CLAUDE_BIN is the real claude');
  if (!String(origin || '').startsWith('file://')) bad.push('the origin is not a file:// path');
  if (bad.length) throw new Error(`--simulate refused: ${bad.join('; ')}`);
}

const labelsOf = (i) => (i.labels || []).map((l) => String(typeof l === 'string' ? l : l?.name).toLowerCase());
/** Issues that get a personal reply instead of a fix: a person's request, question or design point (ADR-107). */
export function replyCandidates(issues, { state, now }) {
  return issues.filter((i) => isPersonIssue(i) && now - Date.parse(i.createdAt) >= HOUR
    && labelsOf(i).some((l) => REPLY_LABELS.includes(l)) && !labelsOf(i).some((l) => ['security', 'release-blocker', 'wontfix', 'autofix:skip'].includes(l))
    && !(state[i.number]?.outcomes || []).some((o) => o.kind === 'reply')
    && !(i.comments || []).some((c) => String(c.author?.login).toLowerCase() === 'stuinfla' && !String(c.body || '').trimStart().startsWith(BOT_MARKER)));
}

// rehearse: { base?: sha, only?: number[] } — the real model stages, gate and sandbox on real issues, with every write
// that would reach GitHub refused by the exec layer, a separate state file, no pages and no release. It proves the
// night end to end before the job is armed (ADR-107); the would-be comments are in the receipt.
export async function runAutofix({ now = Date.now(), dryRun = false, simulate = false, rehearse = null, env = process.env, deps = {} } = {}) {
  const home = env.HOME || os.homedir();
  const ghBin = deps.ghBin || env.GH_BIN || 'gh';
  const claudeBin = deps.claudeBin || env.CLAUDE_BIN || 'claude';
  const originUrl = simulate ? env.AUTOFIX_SIMULATE_ORIGIN : ORIGIN_URL;
  if (simulate) assertSimulateAllowed({ dryRun, ghBin, claudeBin, origin: originUrl });
  const basePaths = deps.paths || PATHS(home);
  // Each rehearsal starts from a clean state of its own: an earlier rehearsal's attempts never feed this one's breaker.
  const paths = rehearse ? { ...basePaths, state: path.join(basePaths.receipts, `rehearsal-state-${now}.json`), runner: null } : basePaths;
  const live = !dryRun || simulate; // a plain --dry-run executes no write and persists nothing
  const t0 = Date.now();
  const nowFn = () => now + (Date.now() - t0);
  const rel = simulate && deps.release ? { ...realRelease, ...deps.release } : realRelease;

  const transcript = [];
  const note = (l) => { transcript.push(l); deps.onCommand?.(l); };
  const rcp = { schemaVersion: 2, job: 'com.ruvnet.issue-autofix', startedAt: iso(now), endedAt: null, status: 'running', dryRun, simulate,
    killSwitch: null, window: null, candidates: [], skipped: [], replies: [], dropped: [], stages: [], followUp: [], release: null,
    securityGate: null, gates: null, comments: [], pages: [], abort: null, exitCode: null };
  const runId = rcp.startedAt.replace(/[:.]/g, '-');
  const rcpFile = path.join(paths.receipts, `${runId}.json`);
  const runDir = path.join(paths.receipts, runId);
  const flush = () => { if (live) writeAtomic(rcpFile, rcp); };
  const settle = (status, exitCode) => {
    Object.assign(rcp, { status, exitCode, endedAt: iso(nowFn()) });
    if (live) { flush(); fs.writeFileSync(path.join(paths.receipts, `${runId}.commands.log`), `${transcript.join('\n')}\n`); }
    return rcp;
  };

  const exec = deps.exec || makeExec({ dryRun: !live, rehearse: !!rehearse, log: note, primary: paths.primary, ghBin, env });
  const notifyFn = rehearse ? () => 2 : deps.notify || defaultNotify(ROOT);
  const page = (title, body = '', priority = 'default') => { const exit = live ? notifyFn(title, body, priority) : null; rcp.pages.push({ title, exit }); return exit; };
  const ns = () => readNs(paths.state);
  const bump = (n, patch) => { if (live && n) patchIssue(paths.state, n, patch); };

  const killState = () => {
    const off = fs.existsSync(paths.offFile); const halt = fs.existsSync(paths.haltFile);
    let variable = { ok: false, value: null };
    if (!off) {
      const v = exec(ghBin, ['variable', 'get', 'ISSUE_AUTOFIX', '--repo', REPO]);
      const unset = v.status !== 0 && /HTTP 404|not found/i.test(v.stderr); // gh's answer for a variable that does not exist
      variable = { ok: v.status === 0 || unset, value: v.status === 0 ? v.stdout.trim() : null };
    }
    return { ...readKillSwitch({ variable, offFile: off, haltFile: halt }), variableOn: readKillSwitch({ variable, offFile: off, haltFile: false }).armed };
  };
  const guard = (stage, { allowHalted = false } = {}) => {
    exec.setStage?.(stage);
    if (rehearse) return; // a rehearsal cannot reach GitHub with a write (makeExec rehearse); there is nothing to stop
    const ks = killState();
    rcp.killSwitch = { armed: ks.armed, reason: ks.reason };
    if (ks.armed || (allowHalted && ks.reason === 'halted' && ks.variableOn)) return;
    throw new AutofixAbort(stage, ks.reason === 'halted' ? 'halted' : 'kill-switch-off', ks.reason);
  };

  const ctx = { repo: REPO, clone: paths.clone, worktrees: paths.worktrees, holdFile: paths.holdFile, exec, ghBin, now: nowFn,
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), identity: IDENTITY, runDir, paths,
    log: (l) => transcript.push(`# ${l}`), gates: simulate ? deps.gates : undefined, page, env,
    evaluateDoc: simulate ? deps.evaluateDoc : undefined, evaluateReview: simulate ? deps.evaluateReview : undefined,
    saveJournal: (j) => { if (live) patchNs(paths.state, { _release: { ...j } }); } };
  const lastShippedDay = () => { const d = ns()._daily; return d?.shipped ? d.day : undefined; };
  async function checkWindow({ exclude, requiredMs } = {}) {
    const facts = await rel.gatherWindowFacts(ctx);
    if (exclude) { // only OUR release branch and its PR; every other release in flight still closes the window
      facts.remoteReleaseBranches = facts.remoteReleaseBranches.filter((b) => b.name !== exclude);
      facts.openReleasePrs = facts.openReleasePrs.filter((n) => facts.openReleasePrHeads?.[n] !== exclude);
    }
    return { facts, verdict: judgeReleaseWindow(facts, { now: nowFn(), requiredMs, today: etDay(nowFn()), lastShippedDay: exclude ? undefined : lastShippedDay() }) };
  }
  ctx.checkpoint = async (name) => {
    const stage = name.startsWith('gate:') ? 'S6' : name;
    guard(stage);
    if (['S7', 'S9', 'S10'].includes(name)) {
      const own = ns()._release?.branch;
      const { verdict } = await checkWindow({ exclude: own, requiredMs: name === 'S7' ? 3 * HOUR : 2 * HOUR });
      if (!verdict.open) throw new AutofixAbort(stage, 'window-closed', verdict.reasons.join(', '));
    }
  };

  const rt = { exec, ghBin, repo: REPO, paths, ctx, page, bump, note, rel, receipt: rcp, runDir, tmpRoot: path.join(runDir, 'tmp'),
    now: nowFn, deadlineAt: now + (deps.deadlineMs ?? JOB_BUDGET_MS), releaseReserveMs: deps.releaseReserveMs ?? RELEASE_RESERVE_MS,
    current: {}, tonightNotes: [], nodeModules: deps.nodeModules || path.join(paths.clone, 'node_modules'), batchGate: simulate ? deps.batchGate : undefined,
    resolveWorkPath: (p) => resolveWorkPath(p, { primary: paths.primary }),
    runSandboxed: deps.runSandboxed || makeSandboxRunner({ exec, tmpRoot: path.join(runDir, 'sbx'), home }),
    saveJournal: ctx.saveJournal, mainVersion: null };
  let stageEntry = null;
  rt.begin = (id) => { guard(id); stageEntry = { stage: id, startedAt: iso(nowFn()), durationMs: 0, ok: null, resolvedModel: null, code: null }; rcp.stages.push(stageEntry); flush(); stageEntry.t = Date.now(); };
  rt.end = (ok, extra = {}) => { if (stageEntry) Object.assign(stageEntry, { ok, durationMs: Date.now() - stageEntry.t, ...extra }); };
  rt.agentIssue = (i) => ({ number: i.number, title: i.title, body: i.body, labels: labelsOf(i), comments: (i.comments || []).map((c) => ({ author: c.author?.login ?? '', body: c.body })) });
  rt.agent = async (name, id, cwd, input) => {
    const cfg = STAGE_CONFIG[name];
    if (['plan', 'build', 'verify'].includes(name) && cfg.timeoutMs + rt.releaseReserveMs > rt.deadlineAt - nowFn()) throw new AutofixAbort(id, 'deadline', `${name} needs ${cfg.timeoutMs} ms plus the release reserve`);
    rt.begin(id);
    fs.mkdirSync(rt.tmpRoot, { recursive: true });
    const logPath = path.join(runDir, `${name}-${rt.current.issue?.number ?? 'night'}-${rcp.stages.length}.log`);
    let r;
    try { r = await (deps.runAgentImpl || runAgent)({ stage: name, cwd, input, claudeBin, logPath, root: ROOT }); }
    catch (e) { rt.end(false, { code: e.code }); if (e instanceof AutofixAbort) e.stage = id; throw e; }
    rt.end(r.ok, { resolvedModel: r.resolvedModel, logPath, code: r.ok ? null : (r.timedOut ? 'agent-timeout' : 'agent-failed') });
    if (!r.ok) throw new AutofixAbort(id, r.timedOut ? 'agent-timeout' : 'agent-failed', r.error || '');
    return r;
  };

  // The clone at origin/main with its own node_modules (installed only when the lockfile changed). It is the trusted
  // base every worktree branches from and links node_modules to; the sandbox forbids writes into it.
  async function ensureClone() {
    resolveWorkPath(paths.clone, { primary: paths.primary });
    if (!fs.existsSync(path.join(paths.clone, '.git'))) {
      fs.mkdirSync(path.dirname(paths.clone), { recursive: true });
      await must(ctx, 'S2', 'transient', 'git', ['clone', '--no-checkout', originUrl, paths.clone]);
    } else if (simulate) {
      const o = exec('git', ['-C', paths.clone, 'remote', 'get-url', 'origin']);
      if (!o.stdout.trim().startsWith('file://')) throw new Error(`--simulate refused: the clone's origin is ${o.stdout.trim()}, not a file:// path`);
    }
    await mustGit(ctx, 'S0', 'transient', paths.clone, ['fetch', 'origin', 'main']);
    await mustGit(ctx, 'S0', 'transient', paths.clone, ['checkout', '-q', '--detach', 'origin/main']);
    if (deps.nodeModules) return;
    const lock = exec('git', ['-C', paths.clone, 'rev-parse', 'origin/main:package-lock.json']).stdout.trim();
    const marker = path.join(paths.clone, 'node_modules', '.autofix-lock');
    if (!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8').trim() !== lock) {
      await must(ctx, 'S0', 'transient', 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: paths.clone, timeoutMs: 30 * 60_000 });
      if (live) fs.writeFileSync(marker, lock);
    }
  }
  async function governedSet(wt) {
    if (simulate && deps.governed0103) return new Set(deps.governed0103);
    const { evaluateDoc } = await import('../plugin/scripts/doc-currency.mjs');
    const { GOVERNING_ADR } = await import('./architecture-review-lock.mjs');
    const set = new Set((evaluateDoc(wt, GOVERNING_ADR, { checkWiring: false }).governed || []).filter((g) => g.resolved).map((g) => g.path));
    if (!set.size) throw new AutofixAbort('S2', 'protected-path', 'cannot derive the ADR-0103 governed set');
    return set;
  }
  function listIssues() {
    const r = exec(ghBin, ['issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '200', '--json', 'number,title,author,labels,createdAt,updatedAt,comments,body']);
    if (r.status !== 0) return { error: `gh issue list exit ${r.status}` };
    try { return { issues: JSON.parse(r.stdout || '[]') }; } catch { return { error: 'gh issue list returned bad JSON' }; }
  }
  function select(issues) {
    const state = ns(); const linked = {};
    for (const i of issues) {
      if (!judgeEligibility(i, { record: state[i.number], now: nowFn(), botMarker: BOT_MARKER }).eligible) continue;
      const p = exec(ghBin, ['pr', 'list', '--repo', REPO, '--state', 'open', '--search', `${i.number} in:body`, '--json', 'number', '--limit', '20']);
      try { linked[i.number] = p.status === 0 ? JSON.parse(p.stdout || '[]').map((x) => x.number) : [0]; } catch { linked[i.number] = [0]; }
    }
    const sel = selectCandidates(issues, { state, now: nowFn(), linkedPrsByIssue: linked, botMarker: BOT_MARKER });
    const held = sel.candidates.filter((c) => state[c.number]?.securityHold && !labelsOf(c).includes('autofix:go'));
    // A security hold outranks every other reason in the receipt: it is the one the owner must act on.
    const skipped = sel.skipped.map((x) => (state[x.number]?.securityHold && !labelsOf(issues.find((i) => i.number === x.number) || {}).includes('autofix:go') ? { number: x.number, reason: 'security-hold' } : x));
    return { ...sel, candidates: sel.candidates.filter((c) => !held.includes(c)), skipped: [...skipped, ...held.map((c) => ({ number: c.number, reason: 'security-hold' }))] };
  }
  async function screen(candidates) {
    const clean = [];
    for (const c of candidates) {
      const s = await (deps.scanIssueText || scanIssueText)(c);
      if (s.safe) { clean.push(c); continue; }
      rcp.skipped.push({ number: c.number, reason: `injection:${s.threats.slice(0, 3).join(',')}` });
      if (!ns()[c.number]?.injectionPagedAt) {
        page(`AUTOFIX NEEDS OWNER #${c.number}: issue text flagged as prompt injection`, `AIDefence: ${s.threats.join(', ')}. Not attempted, nothing posted. Label autofix:skip to silence, or remove the text.`, 'high');
        bump(c.number, { injectionPagedAt: iso(nowFn()) });
      }
    }
    return clean;
  }
  /** Tell everyone, then clear what was said. The kill switch (and, unless following up, the halt) is re-read per post. */
  async function tell(items, { allowHalted = false } = {}) {
    const full = [];
    for (const it of items) { const v = it.issue?.comments ? it.issue : viewIssue(rt, it.n ?? it.issue?.number); if (v) full.push({ ...it, issue: v }); }
    const res = await notifyPeople(rt, full, { checkpoint: async () => guard('S13', { allowHalted }) });
    rcp.comments.push(...res);
    for (const r of res) if (['fixed'].includes(r.kind) && (r.commented || r.deduped) && r.closed !== false) clearAwaiting(paths.state, r.number);
    return res;
  }

  async function rehearseNight() {
    await ensureClone();
    rt.base = rehearse.base ? exec('git', ['-C', paths.clone, 'rev-parse', '--verify', `${rehearse.base}^{commit}`]).stdout.trim() : null;
    if (rehearse.base && !rt.base) throw new AutofixAbort('S0', 'transient', `unknown base ${rehearse.base}`);
    const listed = listIssues();
    if (listed.error) throw new AutofixAbort('S1', 'transient', listed.error);
    const sel = select(listed.issues);
    const picked = sel.candidates.filter((c) => !rehearse.only?.length || rehearse.only.includes(c.number));
    rcp.candidates = picked.map((c) => ({ number: c.number, reason: 'eligible' }));
    rcp.skipped = sel.skipped;
    rt.mainVersion = JSON.parse(exec('git', ['-C', paths.clone, 'show', 'origin/main:plugin/.claude-plugin/plugin.json']).stdout).version;
    const candidates = await screen(picked);
    const { ready, items } = candidates.length ? await fixAll(rt, candidates, { governed: await governedSet(paths.clone) }) : { ready: [], items: [] };
    const version = rt.mainVersion.replace(/\d+$/, (z) => String(Number(z) + 1));
    rcp.ready = ready.map((r) => ({ number: r.number, fixSha: r.fixSha, wt: r.wt, diff: r.diff, testValidity: r.testValidity, verify: r.verify }));
    await tell([...ready.map((r) => ({ issue: r.issue, kind: 'fixed', version, sha: r.fixSha, testPath: r.testPath, platformCaveat: r.platformCaveat,
      facts: { verified: [...r.facts.verified, 'install-verified on Linux, macOS and Windows (would be, after the release)'], notVerified: r.facts.notVerified },
      fallback: { whatWasWrong: String(r.plan?.rootCause?.explanation || r.summary), whatChanged: String(r.plan?.summary || '').slice(0, 400) } })), ...items]);
    return ['rehearsed'];
  }

  let lockOwned = false;
  try {
    if (live) fs.mkdirSync(runDir, { recursive: true });
    flush();
    const ks0 = killState();
    rcp.killSwitch = { armed: ks0.armed, reason: ks0.reason };
    const halted = ks0.reason === 'halted' && ks0.variableOn;
    // A plain --dry-run executes no write and spawns no model, so it still evaluates the window and the selection while
    // disarmed: that is how the job is checked before it is armed. Everything else stops at the switch.
    const readOnly = (dryRun && !simulate) || !!rehearse;
    if (!ks0.armed && !halted && !readOnly) return settle(ks0.reason === 'halted' ? 'halted' : 'disabled', 0);
    if (live) {
      const lk = acquireLock(paths.lock, { now: nowFn(), mode: 'autofix' });
      lockOwned = lk.acquired;
      if (!lk.acquired && lk.holder?.pid !== process.pid) { rcp.abort = { stage: 'S0', code: 'lock-held', detail: `held by pid ${lk.holder?.pid}`, halt: false }; return settle('stood-down', 75); }
    }
    const cloneReady = live || fs.existsSync(path.join(paths.clone, '.git'));
    if (cloneReady && live && rehearse) return settle(...await rehearseNight(), 0);
    if (cloneReady && live) {
      guard('S0', { allowHalted: true }); await ensureClone();
      rcp.followUp = await recheckAwaiting(rt, ctx, { checkpoint: async () => guard('S13b', { allowHalted: true }) });
    }
    if (halted && !readOnly) return settle('halted', 0); // the halt was paged when it was written; only the follow-up runs
    if (cloneReady && !readOnly) guard('S0');

    // An unfinished release from an earlier run is finished first; nothing new starts until it is.
    const j = ns()._release;
    if (live && j && ['ready', 'paused'].includes(j.phase)) {
      if (!releaseWorktreeExists(j)) { page(`AUTOFIX NEEDS OWNER: release/${j.version} journal without its worktree`, JSON.stringify(j).slice(0, 600), 'urgent'); return settle('stood-down', 1); }
      rt.mainVersion = j.version;
      const out = await shipAndSettle(rt, j);
      if (out.items.length) await tell(out.items);
      if (out.halt) haltNight(rt, j, out.halt);
      return settle(out.status, out.exitCode);
    }

    let window = null;
    if (cloneReady) {
      window = await checkWindow().catch((e) => {
        if (e instanceof AutofixAbort && !['kill-switch-off', 'halted'].includes(e.code)) return { facts: null, verdict: { open: false, reasons: [e.detail || e.code] } };
        throw e;
      });
      rcp.window = window.verdict;
    }
    const listed = listIssues();
    if (listed.error) { rcp.abort = { stage: 'S1', code: 'no-eligible', detail: listed.error, halt: false }; return settle('stood-down', 1); }
    const sel = select(listed.issues);
    rcp.candidates = sel.candidates.map((c) => ({ number: c.number, reason: 'eligible' }));
    rcp.skipped = sel.skipped;
    const replies = replyCandidates(listed.issues, { state: ns(), now: nowFn() });
    rcp.replies = replies.map((i) => i.number);

    if (!cloneReady || (dryRun && !simulate)) {
      note(`# kill switch: ${ks0.armed ? 'armed' : `NOT armed (${ks0.reason})`}`);
      note(`# would fix ${sel.candidates.map((c) => `#${c.number}`).join(', ') || 'nothing'}; would reply to ${replies.map((c) => `#${c.number}`).join(', ') || 'nobody'}${window ? `; window ${window.verdict.open ? 'open' : `closed (${window.verdict.reasons.join(', ')})`}` : ' (window not evaluated: no clone yet)'}`);
      return settle(sel.candidates.length || replies.length ? 'dry-run' : 'nothing-eligible', 0);
    }
    if (!window.verdict.open) {
      const reasons = window.verdict.reasons;
      const dailyOnly = reasons.every((r) => r === 'daily-cap');
      const st = ns()._standDownStreak || { count: 0, since: null };
      const today = etDay(nowFn());
      const counted = sel.candidates.length > 0 && !dailyOnly;
      const count = (st.count || 0) + (counted && st.lastDay !== today ? 1 : 0);
      patchNs(paths.state, { _standDownStreak: { count, since: count ? (st.since || iso(nowFn())) : null, lastReason: reasons[0], lastDay: counted ? today : st.lastDay } });
      if (!dailyOnly) page(`AUTOFIX STANDING DOWN: ${reasons[0].replace(/^release-blocker:(.*)$/, (m, l) => `release-blocker ${l.split(',').map((x) => `#${x}`).join(' ')}`)}`, reasons.join('; '), 'low');
      rcp.abort = { stage: 'S0', code: dailyOnly ? 'daily-cap' : 'window-closed', detail: reasons.join('; '), halt: false };
      if (replies.length) await tell(replies.map((issue) => ({ issue, kind: 'reply', facts: null, fallback: { whatWasWrong: 'I read what you asked.', whatItNeeds: 'a maintainer’s decision.' } })));
      return settle('stood-down', count >= 3 && sel.candidates.length ? 1 : 0);
    }
    if ((ns()._standDownStreak?.count || 0) > 0) patchNs(paths.state, { _standDownStreak: { count: 0, since: null, lastReason: null } });
    rt.mainVersion = window.facts.mainVersion;

    const candidates = await screen(sel.candidates);
    const { ready, items } = candidates.length ? await fixAll(rt, candidates, { governed: await governedSet(paths.clone) }) : { ready: [], items: [] };
    items.push(...replies.map((issue) => ({ issue, kind: 'reply', facts: null, fallback: { whatWasWrong: 'I read what you asked.', whatItNeeds: 'a maintainer’s decision.' } })));
    let out = { items: [], status: ready.length || items.length ? 'replied' : 'nothing-eligible', exitCode: 0 };
    const journal = await releaseBatch(rt, ready);
    if (journal?.aborted) out = { items: [], status: 'aborted', exitCode: 1 };
    else if (journal) out = await shipAndSettle(rt, journal);
    await tell([...out.items, ...items]);
    if (out.halt) haltNight(rt, journal, out.halt);
    return settle(out.status, out.exitCode);
  } catch (e) {
    const a = e instanceof AutofixAbort ? e : new AutofixAbort('S0', 'transient', e?.stack || String(e));
    rcp.abort = { stage: a.stage, code: a.code, detail: a.detail, halt: false };
    if (['kill-switch-off', 'halted'].includes(a.code)) { page(`AUTOFIX STOPPED at ${a.stage}`, `Kill switch: ${a.detail}.`, 'low'); return settle('disabled', 0); }
    page(`AUTOFIX ABORTED at ${a.stage}`, `${a.code}: ${a.detail}`.slice(0, 900), 'high');
    return settle('aborted', 1);
  } finally {
    // The job's own code moves to the newest install-verified release for the NEXT run (issue-autofix-runner.mjs).
    if (live && lockOwned && paths.runner) {
      try {
        const npm = await queryNpmLatest(ctx); const latest = await queryReleasesLatest(ctx);
        const verified = !!npm && latest === `v${npm}` && await resolveRuntime(ctx, npm, path.join(runDir, 'runner-runtime.json'));
        rcp.runner = await advanceRunner(rt, { latestTag: npm ? `v${npm}` : null, installVerified: verified });
        flush();
      } catch (e) { rcp.runner = { moved: false, reason: e.message }; }
    }
    if (lockOwned) releaseLock(paths.lock);
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--rehearse')) {
    keepAwake();
    const at = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
    const only = (at('--only') || '').split(',').filter(Boolean).map(Number);
    const r = await runAutofix({ rehearse: { base: at('--base'), only }, env: process.env, deps: { onCommand: (l) => console.log(l) } });
    console.log(`issue-autofix: ${r.status}${r.abort ? ` (${r.abort.stage}:${r.abort.code})` : ''} [rehearsal: nothing reached GitHub]`);
    for (const c of r.comments || []) console.log(`\n===== would post on #${c.number} (${c.kind}) =====\n${c.body || '(none)'}`);
    return r.exitCode;
  }
  if (argv.includes('--self-test')) {
    const { selfTest } = await import('./issue-autofix-selftest.mjs');
    return selfTest({ env: process.env, notify: defaultNotify(ROOT) });
  }
  const dryRun = argv.includes('--dry-run');
  const simulate = argv.includes('--simulate');
  if (!simulate && process.platform === 'darwin') keepAwake(); // also for a live dry run: proves caffeinate works under launchd
  try {
    const r = await runAutofix({ dryRun, simulate, env: process.env, deps: dryRun && !simulate ? { onCommand: (l) => console.log(l) } : {} });
    console.log(`issue-autofix: ${r.status}${r.abort ? ` (${r.abort.stage}:${r.abort.code})` : ''}${dryRun && !simulate ? ' [dry-run: no write executed]' : ''}`);
    return r.exitCode;
  } catch (err) {
    console.error(`issue-autofix: ${err.message}`);
    return 1;
  }
}
