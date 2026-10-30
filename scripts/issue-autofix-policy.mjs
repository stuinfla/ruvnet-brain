// Issue autofix POLICY (ADR-107): every judgement the unattended fixer makes, as pure functions.
// No fs, no child_process, no network: facts go in, a verdict comes out, so every rail can be proven by
// breaking it in a unit test. Orchestration (A5), agents (A2), release (A3) and the reporter comment (A4)
// all import their shared vocabulary (AutofixAbort, stages, codes) from here.
import { BOT_MARKER, isPersonIssue } from './issue-watch.mjs';
import { isEditablePath } from './issue-autofix-security.mjs';

export { isPersonIssue };

// ---------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------
export const STAGES_ORDER = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S5b', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S13b'];
export const ABORT_CODES = Object.freeze([
  'kill-switch-off', 'halted', 'lock-held', 'window-closed', 'daily-cap', 'no-eligible',
  'primary-checkout', 'forbidden-command', 'plan-not-fixable', 'plan-high-risk', 'injection-suspected',
  'protected-path', 'diff-policy', 'test-weakened', 'test-validity', 'verify-not-resolved', 'verify-evidence-failed',
  'model-downgrade', 'agent-timeout', 'agent-failed', 'governed-change-not-mechanical', 'gate-failed',
  'branch-exists', 'push-failed', 'preflight-failed', 'preflight-timeout', 'checks-failed', 'not-ancestor',
  'main-moved', 'dispatch-not-found', 'release-failed', 'terminal-unverified', 'comment-failed', 'deadline',
  'not-editable', 'security-finding', 'redteam-flagged', 'sandbox-unavailable', 'injection-scan-failed', 'modules-tampered',
  'batch-security', 'prepush-failed', 'transient', 'plan-malformed']);
// A red at or after S10 means main has (or may have) moved: the caller halts the whole job.
export const HALT_STAGES = new Set(['S10', 'S11', 'S12', 'S13']);

export class AutofixAbort extends Error {
  constructor(stage, code, detail = '', { publicFindings = false, halt = false } = {}) {
    super(`${stage}:${code}${detail ? ` — ${detail}` : ''}`);
    this.name = 'AutofixAbort';
    this.stage = stage;
    this.code = code;
    this.detail = detail; // PRIVATE: never put this in a public comment
    this.publicFindings = !!publicFindings;
    this.halt = !!halt;
  }
}

// ---------------------------------------------------------------------------------------------
// Constants (spec §2, §4)
// ---------------------------------------------------------------------------------------------
export const EXCLUDED_LABELS = ['release-blocker', 'needs-owner', 'design', 'enhancement', 'question', 'discussion',
  'wontfix', 'security', 'autofix:skip', 'autofix:needs-owner'];

// The ADR-0103-governed set is passed in by the caller (it is derived from the ADR's `governs` list, never copied here).
// Matching is case-insensitive: macOS is a case-insensitive filesystem, so `.GitHub/` IS `.github/`.
export const PROTECTED_PATTERNS = [
  /^\.github\//i, /^scripts\/release/i, /^scripts\/issue-/i, /^scripts\/job-heartbeat\.sh$/i,
  /^scripts\/nightly-watchdog\.mjs$/i, /^scripts\/single-source-check\.mjs$/i, /^scripts\/doc-currency\.mjs$/i,
  /^plugin\/scripts\/doc-currency\.mjs$/i, /^config\/scheduled-jobs\.json$/i, /^config\/issue-autofix\//i,
  /^scripts\/architecture-review-lock\.mjs$/i, // in the job's own import closure (tests/unit/issue-autofix-deploy.test.mjs)
  /^deploy\//i, /^keys\//i, /^kb\/PRIVATE-STORES\.json$/i, /^CONTRIBUTING\.md$/i, /^docs\/adr\//i, /^plugin\/hooks\//i,
];

// Added lines matching any of these abort the diff. The last three catch the same capability imported without the node: prefix.
export const NETWORK_PRIMITIVES = [
  /child_process/, /node:net\b/, /node:https?\b/, /\bfetch\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/,
  /\bcurl\s/, /\bwget\s/,
  /\bfrom\s+['"](?:net|https?|tls|dgram|dns)['"]/, /\brequire\s*\(\s*['"](?:node:)?(?:net|https?|tls|dgram|dns|child_process)['"]/,
  /\bimport\s*\(\s*['"](?:node:)?(?:net|https?|tls|dgram|dns|child_process)['"]/,
];

// maxPlannedPerRun is a sanity bound, not a quota: the run fixes every eligible issue its time budget allows
// (owner, 2026-10-30) and leaves the rest for the next night. One release per night carries every passing fix.
export const CAPS = { maxPlannedPerRun: 50, lifetimeAttempts: 3, maxFailed: 1,
  minAgeMs: 3_600_000, minBodyChars: 40, maxChangedLines: 400, maxFiles: 12 };

export const EVIDENCE_COMMAND = /^npx vitest run [\w./ -]+$/;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
const lc = (s) => String(s ?? '').toLowerCase();

// ---------------------------------------------------------------------------------------------
// No force, no merge, no delete (spec §4 "No force, no merge")
// ---------------------------------------------------------------------------------------------
export function assertCommandAllowed(cmd, args, stage = 'S0') {
  const a = (Array.isArray(args) ? args : []).map(String);
  const deny = (why) => { throw new AutofixAbort(stage, 'forbidden-command', `${why}: ${[cmd, ...a].join(' ').slice(0, 200)}`); };
  const isPush = a.includes('push');
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (/^--force/.test(t)) deny('force flag');
    if (t.includes('+refs/')) deny('forced refspec');
    if (isPush) {
      if (t === '-f' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t)) deny('force push');
      if (t.startsWith('+') && t.length > 1) deny('forced refspec');
      if (t === '--delete' || t === '-d' || /^:[^\s]+/.test(t)) deny('ref deletion');
    }
    if (t === 'pr' && a[i + 1] === 'merge') deny('merge');
    if (/\/merge$/.test(t)) deny('merge endpoint');
    if (/^(-X|--method)$/i.test(t) && /^delete$/i.test(a[i + 1] || '')) deny('DELETE call');
    if (/^--method=delete$/i.test(t)) deny('DELETE call');
  }
}

// ---------------------------------------------------------------------------------------------
// Kill switch (spec §4): unset, unreadable or anything but exactly `on` is OFF.
// ---------------------------------------------------------------------------------------------
export function readKillSwitch({ variable, offFile, haltFile } = {}) {
  if (haltFile) return { armed: false, reason: 'halted' };
  if (offFile) return { armed: false, reason: 'local-off' };
  if (!variable || variable.ok !== true) return { armed: false, reason: 'variable-unreadable' };
  if (variable.value === null || variable.value === undefined || variable.value === '') return { armed: false, reason: 'variable-unset' };
  if (String(variable.value).replace(/\r?\n$/, '') !== 'on') return { armed: false, reason: 'variable-off' };
  return { armed: true, reason: 'on' };
}

// ---------------------------------------------------------------------------------------------
// Eligibility (spec §2)
// ---------------------------------------------------------------------------------------------
const labelNames = (issue) => (issue?.labels || []).map((l) => lc(typeof l === 'string' ? l : l?.name));
const ms = (iso) => Date.parse(iso);

export function judgeEligibility(issue, { record, now = Date.now(), ownerLogin = 'stuinfla', linkedOpenPrs = [], botMarker = BOT_MARKER } = {}) {
  const no = (reason) => ({ eligible: false, reason });
  if (!issue || !isPersonIssue(issue)) return no('not-person');
  const created = ms(issue.createdAt);
  if (!Number.isFinite(created) || now - created < CAPS.minAgeMs) return no('too-young');
  if (typeof issue.body !== 'string') return no('body-unavailable'); // the list call must carry `body`; never guess
  if (issue.body.trim().length < CAPS.minBodyChars) return no('short-body');
  const labels = labelNames(issue);
  for (const l of EXCLUDED_LABELS) if (labels.includes(l)) return no(`label:${l}`);
  if (linkedOpenPrs.length > 0) return no('linked-pr');
  if (!labels.includes('autofix:go')) {
    const owner = lc(ownerLogin);
    const replied = (issue.comments || []).some((c) => lc(c?.author?.login) === owner
      && !String(c?.body || '').trimStart().startsWith(botMarker));
    if (replied) return no('owner-replied');
  }
  if (record) {
    if ((record.failCount || 0) >= CAPS.maxFailed) {
      const last = ms(record.lastAttemptAt); const upd = ms(issue.updatedAt);
      if (!(Number.isFinite(last) && Number.isFinite(upd) && upd > last)) return no('breaker');
    }
    if ((record.attempts || 0) >= CAPS.lifetimeAttempts) return no('lifetime-cap');
    if (record.awaitingVerification) return no('awaiting-verification');
  }
  return { eligible: true, reason: 'eligible' };
}

export function selectCandidates(issues, { state = {}, now = Date.now(), linkedPrsByIssue = {}, botMarker = BOT_MARKER } = {}) {
  const skipped = []; const eligible = []; const releaseBlockers = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (labelNames(issue).includes('release-blocker')) releaseBlockers.push(issue.number);
    const j = judgeEligibility(issue, { record: state?.[issue.number], now, linkedOpenPrs: linkedPrsByIssue?.[issue.number] || [], botMarker });
    if (j.eligible) eligible.push(issue); else skipped.push({ number: issue.number, reason: j.reason });
  }
  eligible.sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.number - b.number);
  for (const extra of eligible.slice(CAPS.maxPlannedPerRun)) skipped.push({ number: extra.number, reason: 'run-cap' });
  return { candidates: eligible.slice(0, CAPS.maxPlannedPerRun), skipped, releaseBlockers };
}

// ---------------------------------------------------------------------------------------------
// Release window (spec S0.4)
// ---------------------------------------------------------------------------------------------
const verParts = (v) => (/^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split('.').map(Number) : null);
const verCmp = (a, b) => { const x = verParts(a); const y = verParts(b); if (!x || !y) return NaN; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const stripV = (t) => String(t ?? '').replace(/^v/, '');
const GUARDED_WORKFLOWS = new Set(['protected-release', 'release-candidate-preflight', 'corpus-nightly-dispatch']);

export function nextPatchVersion(version) {
  const p = verParts(version);
  if (!p) throw new Error(`nextPatchVersion: not X.Y.Z: ${JSON.stringify(version)}`);
  return `${p[0]}.${p[1]}.${p[2] + 1}`;
}

export function etDay(msValue) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(msValue)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function judgeReleaseWindow(facts, { now = Date.now(), requiredMs = 7 * 3_600_000, today, lastShippedDay } = {}) {
  if (!facts || typeof facts !== 'object') return { open: false, reasons: ['facts-missing'] };
  const reasons = [];
  if ((facts.openReleaseBlockers || []).length) reasons.push(`release-blocker:${facts.openReleaseBlockers.join(',')}`);
  for (const r of facts.activeRuns || []) {
    const wf = String(r.workflow || '').replace(/\.ya?ml$/, '');
    if (GUARDED_WORKFLOWS.has(wf) && r.status !== 'completed') reasons.push(`active-run:${wf}`);
  }
  for (const b of facts.remoteReleaseBranches || []) {
    const c = verCmp(b.version, facts.mainVersion);
    if (!(c <= 0)) reasons.push(`release-branch-ahead:${b.name}`); // NaN (unparseable) closes the window too
  }
  // An open PR from a release branch blocks only when that branch is ahead of main (or its version is unreadable): a
  // stale, deferred PR from an old release/X.Y.Z cannot collide with tonight's release. Without head names, all block.
  const heads = facts.openReleasePrHeads;
  const prBlocks = (facts.openReleasePrs || []).filter((n) => {
    if (!heads) return true;
    const m = String(heads[n] || '').replace(/^release\//, '').match(/^(\d+\.\d+\.\d+)/);
    return !(m && verCmp(m[1], facts.mainVersion) <= 0);
  });
  if (prBlocks.length) reasons.push(`open-release-pr:${prBlocks.join(',')}`);
  if (facts.holdFile) reasons.push('release-hold');
  const mv = facts.mainVersion;
  if (!verParts(mv) || facts.npmLatest !== mv || stripV(facts.releasesLatestTag) !== mv) reasons.push('version-mismatch');
  if (facts.mainVersionInstallVerified !== true) reasons.push('main-not-install-verified');
  if (!(Number.isFinite(facts.nextCorpusDispatchAt) && now + requiredMs < facts.nextCorpusDispatchAt)) reasons.push('corpus-dispatch-too-soon');
  if (lastShippedDay && today && lastShippedDay === today) reasons.push('daily-cap');
  return { open: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// Path rules
// ---------------------------------------------------------------------------------------------
export function isProtectedPath(p, governed0103 = new Set()) {
  const n = norm(p);
  if (!n || n.startsWith('/') || n.split('/').includes('..')) return true; // an escape from the worktree is never fine
  if (PROTECTED_PATTERNS.some((re) => re.test(n))) return true;
  const g = governed0103 instanceof Set ? governed0103 : new Set(governed0103 || []);
  for (const x of g) if (lc(norm(x)) === lc(n)) return true;
  return false;
}
const isTestFile = (p) => /(^|\/)tests?\//i.test(norm(p)) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(norm(p));
const isTestSuiteFile = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/i.test(norm(p));
const isVitestConfig = (p) => /(^|\/)vitest\.(config|workspace)/i.test(norm(p));
const isDependencyFile = (p) => /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.npmrc)$/i.test(norm(p));

// ---------------------------------------------------------------------------------------------
// Plan (spec S3)
// ---------------------------------------------------------------------------------------------
const hasSubstance = (plan) => !!(plan?.rootCause && String(plan.rootCause.file || '').trim()
  && Number.isInteger(plan.rootCause.line) && plan.rootCause.line > 0 && String(plan.rootCause.explanation || '').trim());

export function judgePlan(plan, { governed0103 = new Set() } = {}) {
  const stop = (code, publicFindings) => ({ proceed: false, code, publicFindings });
  if (!plan || typeof plan !== 'object') return stop('plan-not-fixable', false);
  if (plan.injectionSuspected !== false) return stop('injection-suspected', false); // never public; also fails closed when the field is missing
  const substance = hasSubstance(plan);
  if (plan.classification !== 'fixable') return stop('plan-not-fixable', substance);
  if (plan.risk === 'high' || !['low', 'medium'].includes(plan.risk)) return stop('plan-high-risk', substance);
  // A plan whose file lists are not paths at all is the planner's format slip, not a verdict on the issue: retried, never
  // reported as "needs a maintainer" (measured 2026-10-30: prose test descriptions in newTests).
  const notPath = (f) => typeof f !== 'string' || !f || f.length > 200 || /\s/.test(f);
  if (!Array.isArray(plan.files) || plan.files.some(notPath) || (plan.testPlan?.newTests || []).some(notPath)) return stop('plan-malformed', false);
  if (plan.files.some((f) => isProtectedPath(f, governed0103) || !isEditablePath(f).ok)) return stop('protected-path', substance);
  const tests = plan.testPlan?.newTests;
  if (!Array.isArray(tests) || !tests.length || tests.some((f) => !isEditablePath(f).ok || !isTestFile(f))) return stop('protected-path', substance);
  return { proceed: true, code: null, publicFindings: false };
}

// ---------------------------------------------------------------------------------------------
// Diff (spec §4 diff policy + tests never weakened)
// ---------------------------------------------------------------------------------------------
const REMOVED_ASSERTION = /\bexpect\s*\(|\b(?:it|test|describe)(?:\.\w+)*\s*\(|\bassert(?:\.\w+)?\s*\(/;
const SKIPPED_TEST = /\.(?:skip|only|todo)|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/;

export function judgeDiff({ files = [], governed0103 = new Set() } = {}) {
  const violations = []; const testFiles = []; const sourceFiles = [];
  const add = (path, rule, detail) => violations.push({ path, rule, detail });
  let changed = 0;
  for (const f of files) {
    const path = norm(f.path); const status = f.status; const added = f.added || []; const removed = f.removed || [];
    changed += added.length + removed.length;
    const test = isTestFile(path);
    if (isProtectedPath(path, governed0103)) add(path, 'protected-path', 'path is protected');
    else { const e = isEditablePath(path); if (!e.ok) add(path, 'not-editable', `not on the editable allowlist (${e.reason})`); }
    if (isDependencyFile(path)) add(path, 'dependency', 'dependency or install manifest changed');
    if (f.binary) add(path, 'binary', 'binary file');
    if (f.symlink) add(path, 'symlink', 'symlink');
    if (status === 'D' && !test) add(path, 'deleted-source', 'file deleted outside tests/');
    if (!f.binary) {
      for (const line of added) {
        const re = NETWORK_PRIMITIVES.find((r) => r.test(line));
        if (re) { add(path, 'network-primitive', `added line matches ${re}`); break; }
      }
    }
    if (test || isVitestConfig(path)) {
      if (isTestSuiteFile(path) && status === 'D') add(path, 'test-weakened', 'test file deleted');
      else if (isTestSuiteFile(path) && status === 'R') add(path, 'test-weakened', 'test file renamed');
      if (isVitestConfig(path)) add(path, 'test-weakened', 'vitest configuration changed');
      const gone = removed.find((l) => REMOVED_ASSERTION.test(l));
      if (gone) add(path, 'test-weakened', `removed or changed assertion: ${gone.trim().slice(0, 80)}`);
      const skip = added.find((l) => SKIPPED_TEST.test(l));
      if (skip) add(path, 'test-weakened', `skip/only/todo added: ${skip.trim().slice(0, 80)}`);
    }
    if (status !== 'D') (test ? testFiles : sourceFiles).push(path);
  }
  if (changed > CAPS.maxChangedLines) add('*', 'size', `${changed} changed lines > ${CAPS.maxChangedLines}`);
  if (files.length > CAPS.maxFiles) add('*', 'file-count', `${files.length} files > ${CAPS.maxFiles}`);
  return { ok: violations.length === 0, violations, testFiles, sourceFiles };
}

// ---------------------------------------------------------------------------------------------
// Test validity (spec §4): the new tests must FAIL on unfixed code and PASS on the fix
// ---------------------------------------------------------------------------------------------
const sameTest = (failed, wanted) => { const f = norm(failed); const w = norm(wanted); return f === w || [' ', '>', ':', '('].some((c) => f.startsWith(w + c)); };

export function judgeTestValidity({ before, after, newTests } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!Array.isArray(newTests) || newTests.length === 0) return no('no-new-tests');
  if (!Number.isInteger(before?.exitCode) || before.exitCode === 0) return no('passes-before-fix');
  const failed = Array.isArray(before.failedTests) ? before.failedTests : [];
  if (failed.length === 0 || !failed.every((t) => newTests.some((n) => sameTest(t, n)))) return no('unrelated-failures');
  if (after?.exitCode !== 0) return no('fails-after-fix');
  return { ok: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------------------------
// Verifier (spec S5): RESOLVED + >= 2 evidence + >= 1 re-run command, every re-run green
// ---------------------------------------------------------------------------------------------
export function judgeVerdict(verify, reruns = []) {
  if (!verify || verify.verdict !== 'RESOLVED') return { ship: false, code: 'verify-not-resolved' };
  const bad = { ship: false, code: 'verify-evidence-failed' };
  const evidence = Array.isArray(verify.evidence) ? verify.evidence : [];
  if (evidence.length < 2) return bad;
  const commands = evidence.map((e) => e?.command).filter((c) => c !== undefined && c !== null);
  if (commands.length === 0) return bad; // nothing was re-run: the claim is unverified
  const safe = (c) => typeof c === 'string' && EVIDENCE_COMMAND.test(c) && !c.split(/\s+/).slice(3).some((t) => t.startsWith('-') || t.split('/').includes('..'));
  if (!commands.every(safe)) return bad; // option flags (--config x.js) would execute arbitrary code
  const runs = Array.isArray(reruns) ? reruns : [];
  if (runs.some((r) => r?.exitCode !== 0)) return bad;
  if (!commands.every((c) => runs.some((r) => r.command === c))) return bad;
  return { ship: true, code: null };
}

// ---------------------------------------------------------------------------------------------
// Mechanical ADR-0103 review row (spec S6.6)
// ---------------------------------------------------------------------------------------------
const VERSION_LINE = /^\s*"version"\s*:\s*"[^"]*",?\s*$/;

export function judgeGovernedVersionOnly(files = []) {
  const no = (reason) => ({ mechanical: false, reason });
  if (files.length === 0) return { mechanical: true, reason: 'no-governed-changes' };
  for (const f of files) {
    const path = norm(f.path); const removed = f.removed || []; const added = f.added || [];
    if (f.binary || f.symlink || f.status === 'D' || f.status === 'R') return no(`${path}: not a plain edit`);
    if (path === 'package.json' || path === 'package-lock.json') {
      const max = path === 'package.json' ? 1 : 2;
      const lines = [...removed, ...added];
      if (f.status !== 'M' || lines.length === 0 || !lines.every((l) => VERSION_LINE.test(l))) return no(`${path}: changes more than "version" lines`);
      if (removed.length !== added.length || removed.length > max || new Set(removed.map((l) => l.trim())).size > 1
        || new Set(added.map((l) => l.trim())).size > 1) return no(`${path}: not a single version bump`);
    } else if (path === 'scripts/release-qualification-contract.mjs') {
      if (removed.length > 0) return no(`${path}: lines removed or changed, append-only required`);
    } else {
      return no(`${path}: governed file changed beyond the mechanical allowance`);
    }
  }
  return { mechanical: true, reason: 'version-only' };
}

// ---------------------------------------------------------------------------------------------
// Closing keywords (spec §6 / S6.1): a commit or PR must never auto-close an issue
// ---------------------------------------------------------------------------------------------
export const CLOSING_KEYWORD_SOURCE = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:[\w.-]+\/[\w.-]+#\d+|#\d+|GH-\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)`;
export function findClosingKeywords(text) {
  if (typeof text !== 'string') return [];
  return text.match(new RegExp(CLOSING_KEYWORD_SOURCE, 'gi')) || [];
}
