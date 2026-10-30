// scripts/issue-autofix-fix.mjs — one issue, start to verified fix commit (ADR-107 S2..S5). Each issue gets its own
// worktree, its own plan, build, red-team and verifier, and its own sandboxed evidence; one issue's failure never
// touches another's. Returns { status: 'ready', fixSha, ... } or throws AutofixAbort; the orchestrator decides what the
// reporter is told. Order matters: nothing a model wrote is EXECUTED until the static scan has passed, and then only
// inside the sandbox (issue-autofix-sandbox.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { AutofixAbort, judgePlan, judgeVerdict, EVIDENCE_COMMAND } from './issue-autofix-policy.mjs';
import { collectDiff, assertDiffAllowed, measureTestValidity, runVitest, linkModules } from './issue-autofix-diff.mjs';
import { staticScan, redTeam } from './issue-autofix-gate.mjs';
import { mustGit } from './issue-autofix-release-util.mjs';
import { commitFix } from './issue-autofix-release.mjs';

const PLATFORMS = { windows: 'Windows', linux: 'Linux', macos: 'macOS', codex: 'Codex', grok: 'Grok' };

/** Any file under node_modules newer than `stamp` means a model wrote through the link: never trust that tree again. */
function assertModulesUntouched(rt, nodeModules, stamp) {
  if (!nodeModules) return;
  const r = rt.exec('find', [fs.realpathSync(nodeModules), '-newer', stamp, '-not', '-path', '*/.vite/*', '-print', '-quit']);
  if (r.status !== 0 || r.stdout.trim()) throw new AutofixAbort('S4', 'modules-tampered', `node_modules changed during the build: ${r.stdout.trim().slice(0, 200)}`);
}

const evidenceFiles = (cmd) => {
  if (typeof cmd !== 'string' || !EVIDENCE_COMMAND.test(cmd)) return null;
  const files = cmd.split(/\s+/).slice(3);
  return files.length && files.every((t) => !t.startsWith('-') && !t.split('/').includes('..')) ? files : null;
};

export async function fixOne(rt, issue, { governed }) {
  const n = issue.number;
  const out = { number: n, status: 'dropped', plan: null, verify: null, testValidity: null, diff: null, wt: null, fixSha: null };
  rt.current.wt = null;

  // S2 — own worktree at origin/main; node_modules is a link to the clone's install made at origin/main.
  rt.begin('S2');
  const stamp = rt.now();
  const wt = path.join(rt.paths.worktrees, `issue-${n}-${stamp}`);
  rt.resolveWorkPath(wt);
  fs.mkdirSync(rt.paths.worktrees, { recursive: true });
  await mustGit(rt.ctx, 'S2', 'agent-failed', rt.paths.clone, ['worktree', 'add', '-b', `autofix/issue-${n}-${stamp}`, wt, rt.base || 'origin/main']);
  out.wt = wt; rt.current.wt = wt;
  linkModules(rt.nodeModules, wt);
  rt.end(true);

  // S3 — plan (read-only tools), judged against the allowlist and the protected set.
  const plan = (await rt.agent('plan', 'S3', wt, { issue: rt.agentIssue(issue), repo: rt.repo })).result;
  out.plan = plan; rt.current.plan = plan;
  const jp = judgePlan(plan, { governed0103: governed });
  if (!jp.proceed) throw new AutofixAbort('S3', jp.code, String(plan?.summary || ''), { publicFindings: jp.publicFindings });

  // S4 — build (file tools only), then: diff policy → static scan → modules check → sandboxed test validity.
  let repair = null; let diff; let tv;
  for (let round = 0; round < 2; round += 1) {
    const stampFile = path.join(rt.runDir, `build-${n}-${round}.stamp`);
    fs.writeFileSync(stampFile, '');
    await rt.agent('build', 'S4', wt, { issue: rt.agentIssue(issue), plan, repair });
    const head = rt.exec('git', ['-C', wt, 'rev-parse', 'HEAD']).stdout.trim();
    diff = collectDiff(rt.exec, wt);
    if (head !== diff.base) throw new AutofixAbort('S4', 'diff-policy', 'HEAD moved during the build');
    out.diff = { files: diff.files.length, changedLines: diff.changedLines, violations: [] };
    try { assertDiffAllowed(diff, governed); } catch (e) { out.diff.violations = [e.detail]; throw e; }
    const scan = staticScan(diff);
    if (!scan.ok) {
      out.diff.violations = scan.findings.map((f) => `${f.rule} ${f.path}:${f.line ?? '-'}`);
      throw new AutofixAbort('S4', 'security-finding', scan.findings.slice(0, 8).map((f) => `${f.rule} ${f.path}:${f.line ?? '-'} ${f.excerpt}`).join('; ').slice(0, 900));
    }
    assertModulesUntouched(rt, rt.nodeModules, stampFile);
    tv = measureTestValidity(rt.exec, { wt, scratch: `${wt}-scratch-${round}`, diff, newTests: plan.testPlan.newTests,
      nodeModules: rt.nodeModules, runSandboxed: rt.runSandboxed });
    out.testValidity = { ok: tv.verdict.ok, reason: tv.verdict.reason, round };
    if (tv.verdict.ok) break;
    if (round === 1 || tv.verdict.reason === 'no-new-tests') throw new AutofixAbort('S4', 'test-validity', tv.verdict.reason);
    repair = `test-validity: ${tv.verdict.reason}\n--- unfixed code ---\n${tv.before?.output || ''}\n--- fixed code ---\n${tv.after?.output || ''}`;
  }

  // S4b — an independent Opus red-team that sees only this diff.
  await redTeam(rt, { stage: 'S4', diffText: diff.text, files: diff.files, staticFindings: [], scope: `one fix for issue ${n}` });

  // S5 — independent verifier (read-only), then the orchestrator re-runs its evidence in the sandbox.
  const verify = (await rt.agent('verify', 'S5', wt, { issue: rt.agentIssue(issue), diffText: diff.text,
    testValidity: { beforeOutput: tv.before.output, afterOutput: tv.after.output, newTests: tv.newTests } })).result;
  const reruns = [];
  for (const ev of verify.evidence || []) {
    if (ev.command === undefined) continue;
    const files = evidenceFiles(ev.command);
    if (!files) { reruns.push({ command: ev.command, exitCode: -1 }); continue; }
    const r = runVitest(rt.runSandboxed, wt, files);
    reruns.push({ command: ev.command, exitCode: r.exitCode });
  }
  out.verify = { verdict: verify.verdict, evidence: (verify.evidence || []).length, reruns, summary: verify.summary };
  const jv = judgeVerdict(verify, reruns);
  if (!jv.ship) {
    throw new AutofixAbort('S5', jv.code, `${verify.verdict}: ${verify.summary}`,
      { publicFindings: verify.verdict === 'NEEDS_OWNER' && plan.rootCause?.line > 0 });
  }

  // Commit in the issue worktree (message names only the issue number: no stranger text enters git history).
  const { fixSha } = await commitFix(rt.ctx, { wt, issueNumber: n });
  const missing = [...new Set(plan.platformSpecific || [])].filter((p) => !['macos', 'linux'].includes(p)).map((p) => PLATFORMS[p]).filter(Boolean);
  return { ...out, status: 'ready', fixSha, testPath: tv.newTests[0], platformCaveat: plan.platformSpecific || [],
    facts: { verified: ['a new test that fails on the old code and passes with the fix (run in an isolated sandbox on macOS)',
      'an independent review of the change, whose cited checks were re-run'],
    notVerified: [`your exact setup${missing.length ? ` on ${missing.join(' and ')}` : ''}`] }, summary: verify.summary };
}
