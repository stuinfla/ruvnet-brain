// scripts/issue-autofix-night.mjs — one night of the autofix job (ADR-107), after the run has been armed, locked and
// its window opened: fix EVERY eligible issue the time budget allows (each independently), put every fix that passed
// its own verification and security checks into ONE release, run the night's security gate over that release, ship it
// through the protected rail, and give each person one honest reply. One issue's failure never blocks another's fix.
import fs from 'node:fs';
import path from 'node:path';
import { AutofixAbort, nextPatchVersion, etDay } from './issue-autofix-policy.mjs';
import { fixOne } from './issue-autofix-fix.mjs';
import { runBatchGate } from './issue-autofix-gate.mjs';
import { mustGit } from './issue-autofix-release-util.mjs';
import { patchIssue, readNs, patchNs, writeHaltFile } from './issue-autofix-state.mjs';

const HOUR = 3_600_000;
const STOP_RUN = new Set(['kill-switch-off', 'halted', 'deadline', 'sandbox-unavailable']);
// Not the issue's fault (infrastructure, quota, a model we did not ask for): retried next night, nothing said publicly.
// The job's own guards (primary-checkout, forbidden-command) tripping is the job's problem, never the reporter's.
const INFRA = new Set(['agent-failed', 'agent-timeout', 'model-downgrade', 'window-closed', 'transient', 'lock-held',
  'primary-checkout', 'forbidden-command', 'injection-scan-failed', 'plan-malformed']);
// The fix itself looked hostile: held for the owner (URGENT page, never retried until a person labels it autofix:go).
// The reporter is still answered honestly (owner, 2026-10-30) but in words that reveal nothing about what was detected,
// and the hold, not the breaker, keeps it out of later nights.
const HOSTILE = new Set(['security-finding', 'redteam-flagged', 'modules-tampered', 'injection-suspected']);
const BREAKER = new Set(['test-validity', 'verify-not-resolved', 'verify-evidence-failed', 'diff-policy', 'not-editable',
  'test-weakened', 'protected-path', 'plan-not-fixable', 'plan-high-risk', 'gate-failed']);

const iso = (ms) => new Date(ms).toISOString();
const rootCause = (plan) => (plan?.rootCause?.explanation ? `${plan.rootCause.explanation}${plan.rootCause.line > 0 ? ` (${plan.rootCause.file}:${plan.rootCause.line})` : ''}` : '');

/** Decide what one failed issue means: a public item (findings / not-fixed / reply), a private page, or nothing. */
export function classifyFailure(e, { plan, verifySummary } = {}) {
  const code = e.code;
  if (STOP_RUN.has(code)) return { stop: true };
  if (INFRA.has(code)) return { item: null, page: { title: `AUTOFIX ABORTED at ${e.stage}`, priority: 'default' }, breaker: false };
  if (HOSTILE.has(code)) {
    return { hold: true, breaker: false, page: { title: 'AUTOFIX SECURITY HOLD', priority: 'urgent' },
      item: { kind: 'not-fixed', fallback: { whatWasWrong: rootCause(plan) || 'the cause is not yet pinned down.', whatItNeeds: 'a maintainer to review a change by hand.' } },
      facts: { verified: [], notVerified: ['a change that passes every check'] } };
  }
  const wrong = rootCause(plan);
  // "Already fixed" is the planner's reading of main; it may be right (a person's release fixed it and will close it).
  // Saying it publicly from a model's guess, or calling it a maintainer's decision, would be untrue: page privately.
  if (e.stage === 'S3' && plan?.classification === 'already-fixed') return { item: null, page: { title: 'AUTOFIX NEEDS OWNER', priority: 'default' }, breaker: true };
  if (e.stage === 'S3' || (e.stage === 'S5' && e.publicFindings)) {
    if (e.publicFindings && wrong) return { item: { kind: 'findings', fallback: { whatWasWrong: wrong, whatItNeeds: plan?.whatItNeeds || 'a maintainer’s decision.' } }, breaker: BREAKER.has(code) };
    return { item: { kind: 'reply', fallback: { whatWasWrong: wrong || 'I read through this and the code it points at, but could not pin the cause down well enough to change anything safely.', whatItNeeds: plan?.whatItNeeds || 'a maintainer to take a look.' } }, breaker: BREAKER.has(code) };
  }
  return { item: { kind: 'not-fixed', fallback: { whatWasWrong: wrong || String(verifySummary || 'the cause is not yet pinned down.'), whatItNeeds: 'a maintainer to finish or rethink the fix.' } },
    facts: { verified: [], notVerified: ['a fix that passes every check'] }, breaker: BREAKER.has(code) };
}

/** Fix every candidate the budget allows. Returns { ready: [...], items: [...public replies...] }. */
export async function fixAll(rt, candidates, { governed }) {
  const ready = []; const items = [];
  for (const issue of candidates) {
    const n = issue.number;
    if (rt.deadlineAt - rt.now() < rt.releaseReserveMs + HOUR) { rt.note(`# budget: #${n} and later wait for the next night`); break; }
    const rec = readNs(rt.paths.state)[n] || {};
    rt.bump(n, { attempts: (rec.attempts || 0) + 1, failCount: rec.failCount || 0, lastAttemptAt: iso(rt.now()), lastStage: 'S2' });
    rt.current = { issue, plan: null, wt: null };
    try {
      const r = await fixOne(rt, issue, { governed });
      ready.push({ ...r, issue });
      rt.bump(n, { lastStage: 'S5', lastOutcome: 'ready', lastCode: null });
    } catch (e) {
      const a = e instanceof AutofixAbort ? e : new AutofixAbort('S4', 'agent-failed', e?.stack || String(e));
      const c = classifyFailure(a, { plan: rt.current.plan });
      if (c.stop) throw a;
      rt.receipt.dropped.push({ number: n, stage: a.stage, code: a.code, detail: String(a.detail || '').slice(0, 600) }); // private: receipt only
      rt.bump(n, { lastStage: a.stage, lastCode: a.code, lastOutcome: c.item?.kind || (c.hold ? 'security-hold' : 'aborted'),
        failCount: (readNs(rt.paths.state)[n]?.failCount || 0) + (c.breaker ? 1 : 0), ...(c.hold ? { securityHold: { at: iso(rt.now()), code: a.code } } : {}) });
      if (c.page) rt.page(`${c.page.title} #${n}`, `${a.stage}:${a.code} — ${a.detail}`.slice(0, 900), c.page.priority);
      if (c.item) items.push({ issue, ...c.item, facts: c.facts || null });
    }
  }
  return { ready, items };
}

/** S6 for the whole batch: branch, census, ADR-0103 row, the night's security gate, local gates. */
async function prepareBatch(rt, ready, version) {
  const rel = rt.rel;
  const prep = await rel.prepareReleaseBranch(rt.ctx, { version, fixes: ready.map((r) => ({ issueNumber: r.number, fixSha: r.fixSha })) });
  rt.receipt.release = { phase: 'preparing', version, applied: prep.applied, droppedOnApply: prep.dropped };
  await rel.stampCensus(rt.ctx, { rwt: prep.rwt });
  await rel.stamp0103Review(rt.ctx, { rwt: prep.rwt, version, issues: prep.applied, date: etDay(rt.now()) });
  const baseDir = `${prep.rwt}-gatebase`;
  if (!fs.existsSync(baseDir)) await mustGit(rt.ctx, 'S6', 'gate-failed', rt.paths.clone, ['worktree', 'add', '--detach', baseDir, 'origin/main']);
  const gate = await (rt.batchGate || runBatchGate)(rt, { rwt: prep.rwt, fixBase: prep.fixBase, fixHead: prep.fixHead, mainVersion: rt.mainVersion, baseDir });
  rt.receipt.securityGate = { ok: gate.ok, findings: gate.findings.slice(0, 40) };
  if (!gate.ok) {
    throw new AutofixAbort('S6', 'batch-security', gate.findings.slice(0, 10).map((f) => `${f.rule} ${f.path}:${f.line ?? '-'} ${f.detail}`).join('; ').slice(0, 900));
  }
  const g = await rel.runLocalGates(rt.ctx, { rwt: prep.rwt });
  rt.receipt.gates = g.gates.map((x) => ({ name: x.name, exitCode: x.exitCode, durationMs: x.durationMs }));
  if (!g.ok) { const bad = g.gates[g.gates.length - 1]; throw new AutofixAbort('S6', 'gate-failed', `${bad.name} exit ${bad.exitCode}: ${bad.outputTail}`); }
  const sha = rt.exec('git', ['-C', prep.rwt, 'rev-parse', 'HEAD']).stdout.trim();
  return { ...prep, sha };
}

/** Journal entry for an issue in the release: everything S13/S13b need to tell the reporter later. */
const carry = (r) => ({ fixSha: r.fixSha, testPath: r.testPath, platformCaveat: r.platformCaveat, facts: r.facts,
  fallback: { whatWasWrong: rootCause(r.plan) || r.summary, whatChanged: String(r.plan?.summary || r.summary || '').slice(0, 400) } });

/** Build and start the night's release. Returns the journal, or null when there is nothing to release. */
export async function releaseBatch(rt, ready) {
  if (!ready.length) return null;
  const version = nextPatchVersion(rt.mainVersion);
  let prep;
  try { prep = await prepareBatch(rt, ready, version); }
  catch (e) {
    const a = e instanceof AutofixAbort ? e : new AutofixAbort('S6', 'gate-failed', e?.stack || String(e));
    if (STOP_RUN.has(a.code)) throw a;
    rt.receipt.abort = { stage: a.stage, code: a.code, detail: a.detail, halt: false };
    rt.page(a.code === 'batch-security' ? `AUTOFIX SECURITY HOLD: night release v${version} blocked` : `AUTOFIX ABORTED v${version} at ${a.stage}`,
      `${a.code}: ${a.detail}`.slice(0, 900), a.code === 'batch-security' ? 'urgent' : 'high');
    for (const r of ready) rt.bump(r.number, { lastStage: 'S6', lastCode: a.code, lastOutcome: 'aborted' });
    return { aborted: true };
  }
  const byNum = Object.fromEntries(ready.map((r) => [r.number, r]));
  const journal = { version, branch: prep.branch, sha: prep.sha, rwt: prep.rwt, issues: prep.applied, phase: 'ready', startedAt: iso(rt.now()),
    items: Object.fromEntries(prep.applied.map((n) => [n, carry(byNum[n])])) };
  rt.saveJournal(journal);
  return journal;
}

/** Ship (or resume) the journal and turn the outcome into reporter items, state and pages. */
export async function shipAndSettle(rt, journal) {
  const res = await rt.rel.shipRelease(rt.ctx, { rwt: journal.rwt, journal });
  rt.receipt.release = { ...res };
  const items = [];
  const publish = (kind, extraVerified) => {
    for (const n of journal.issues) {
      const c = journal.items[n] || {};
      const facts = { verified: [...(c.facts?.verified || []), 'the full test suite and every release check', ...extraVerified], notVerified: c.facts?.notVerified || [] };
      rt.bump(n, { lastOutcome: 'shipped', lastStage: 'S13', awaitingVerification: { version: journal.version, sha: journal.sha, publishedAt: iso(rt.now()), ...c, facts } });
      items.push({ n, kind, facts, version: journal.version, sha: c.fixSha, testPath: c.testPath, platformCaveat: c.platformCaveat, fallback: c.fallback });
    }
  };
  if (res.phase === 'shipped') {
    publish('fixed', ['install-verified on Linux, macOS and Windows']);
    patchNs(rt.paths.state, { _daily: { day: etDay(rt.now()), shipped: true, version: journal.version, issues: journal.issues } });
    rt.page(`AUTOFIX SHIPPED v${journal.version}`, `Issues ${journal.issues.join(', ')}; install-verified on main ${journal.sha}.`, 'low');
    return { items, status: res.phase, exitCode: 0 }; // derived from the release result, never a literal (ADR-0024)
  }
  if (res.phase === 'published-unverified') {
    publish('shipping', []);
    return { items, status: 'published-unverified', exitCode: 1, halt: res.abort };
  }
  if (res.phase === 'halted') return { items, status: 'halted', exitCode: 1, halt: res.abort };
  if (res.phase === 'paused') {
    rt.page(`AUTOFIX PAUSED v${journal.version} at ${res.abort.stage}`, `${res.abort.code}: ${res.abort.detail}. The next armed run resumes it${journal.moved ? '; main has ALREADY moved' : ''}.`.slice(0, 900), journal.moved ? 'urgent' : 'high');
    return { items, status: 'paused', exitCode: journal.moved ? 1 : 0 };
  }
  rt.receipt.abort = res.abort;
  rt.page(`AUTOFIX ABORTED v${journal.version} at ${res.abort.stage}`, `${res.abort.code}: ${res.abort.detail}. Nothing public changed; release/${journal.version} is kept and blocks the window until a person deletes it.`.slice(0, 900), 'high');
  return { items, status: 'aborted', exitCode: 1 };
}

/** A red after main moved: the halt file, then the URGENT page. Only a person removes the file. */
export function haltNight(rt, journal, abort) {
  writeHaltFile(rt.paths.haltFile, { stage: abort.stage, code: abort.code, version: journal.version, sha: journal.sha, detail: abort.detail });
  rt.page(`AUTOFIX HALTED v${journal.version} at ${abort.stage}`, `${abort.code}: ${abort.detail}`.slice(0, 900), 'urgent');
}

export const releaseWorktreeExists = (j) => !!(j?.rwt && fs.existsSync(path.join(j.rwt, '.git')));
