import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digest } from './coverage-integrity.mjs';
import { sourceIdentity } from './qa-contract.mjs';
import { spawnNativeHost } from './native-host-process.mjs';
import { safeDualPath, safeDualDataPath, validateDualBrief, validateDualProgress, validateDualReview } from './dual-workflow-contract.mjs';
import { nativeReviewEvidenceDigest, readNativeCompletion } from './native-review-evidence.mjs';
import { bindStageContent, validateDeliberationTrace, TOP_SUBSCRIPTION_MODELS } from './dual-deliberation-contract.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000 });
const sourcePaths = root => [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

export function dualFileDigest(root, relative, {privateData = false} = {}) {
  if (!(privateData ? safeDualDataPath : safeDualPath)(relative)) throw new Error('unsafe workflow source path');
  const base = fs.realpathSync(root);
  let cursor = base;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('workflow source symlinks are not supported'); }
    catch (error) { if (error.code === 'ENOENT') return digest({ absent: true }); throw error; }
  }
  const stat = fs.statSync(cursor);
  if (!stat.isFile()) throw new Error(`workflow source is not a regular file: ${relative}`);
  return digest({ mode: stat.mode & 0o777, bytes: hashBytes(fs.readFileSync(cursor)) });
}

export function observeDualWorktree(root, mutablePaths = []) {
  const mutable = new Set(mutablePaths);
  const files = sourcePaths(root).filter(file => !mutable.has(file)).map(file => ({path:file,sha256:dualFileDigest(root,file)}));
  const observations = mutablePaths.map(file => {
    const sha256 = dualFileDigest(root,file);
    if (sha256 === digest({absent:true})) throw new Error(`preserved user file disappeared: ${file}`);
    return {path:file,sha256};
  });
  return {immutableDigest:digest({head:git(root,['rev-parse','HEAD']).trim(),files}),mutable:observations};
}

function expectedFiles(workflow) {
  const expected = new Map(workflow.brief.inventory.map(row=>[row.path,row.sha256]));
  for (const receipt of workflow.completed) for (const row of receipt.files) expected.set(row.path,row.sha256);
  return expected;
}

function assertExpectedSource(root, workflow, allowed, preserved = new Set(), skipReceiptJob) {
  const expected = expectedFiles(workflow);
  for (const file of new Set([...sourcePaths(root),...expected.keys()])) {
    if (preserved.has(file)) { observeDualWorktree(root,[file]); continue; }
    if (!allowed.has(file) && (!expected.has(file) || dualFileDigest(root,file) !== expected.get(file))) {
      throw new Error(`source drift outside active job: ${file}`);
    }
  }
  for (const receipt of workflow.completed.filter(receipt=>receipt.jobId!==skipReceiptJob)) for (const row of receipt.files) {
    if (dualFileDigest(root,row.path) !== row.sha256) throw new Error(`completed job regressed: ${row.path}`);
  }
}

function observeIgnoredFiles(tree) {
  if (!Array.isArray(tree.ignoredFiles) || !Array.isArray(tree.disposablePaths)) throw new Error('checkout has no private-data inventory');
  const ignored = git(tree.path,['ls-files','-z','--others','--ignored','--exclude-standard']).split('\0').filter(Boolean);
  const files = ignored.filter(file=>!tree.disposablePaths.some(scope=>file===scope.path || file.startsWith(`${scope.path}/`)))
    .sort().map(file=>({path:file,sha256:dualFileDigest(tree.path,file,{privateData:true})}));
  if (digest(files) !== digest([...tree.ignoredFiles].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) throw new Error('ignored private inventory changed or is incomplete');
  return digest(files);
}

function assertReconciliationOutcomes(workflow, {jobId} = {}) {
  const actions = workflow.approval.artifact.artifact.worktreeReconciliation || [];
  for (const receipt of workflow.completed) for (const result of receipt.reconciliation) {
    const action = actions.find(row=>row.id===result.actionId);
    if (!action || (jobId && action.jobId!==jobId)) continue;
    if (action.action !== 'remove' && dualFileDigest(action.targetRoot,action.targetPath,{privateData:true}) !== result.targetSha256) {
      throw new Error(`reconciliation destination was not preserved: ${action.id}`);
    }
  }
}

function observeExternalTrees(brief, root, { finalRoot, completing = false, workflow } = {}) {
  const live = git(root,['worktree','list','--porcelain']).split('\n').filter(line=>line.startsWith('worktree ')).map(line=>line.slice(9));
  if (live.some(tree => !brief.worktrees.some(row => row.path === tree))) throw new Error('worktree reconciliation omits a checkout');
  const observations = [];
  for (const tree of brief.worktrees) {
    const retirement = workflow?.completed.flatMap(row=>row.retirements || []).find(row=>row.root===tree.path);
    if (!live.includes(tree.path)) {
      if (retirement && completing && finalRoot === root && tree.path !== root) {
        assertReconciliationOutcomes(workflow); continue;
      }
      throw new Error(`unreconciled checkout disappeared: ${tree.path}`);
    }
    if (tree.retireAfterJob) observeIgnoredFiles(tree);
    if (fs.realpathSync(tree.path) === fs.realpathSync(root)) continue;
    if (retirement) {
      if (sourceIdentity(tree.path).digest !== retirement.sourceDigest) throw new Error('retired checkout changed after preservation');
      continue;
    }
    if (tree.disposition === 'canonical' && workflow && completing && finalRoot === root) {
      const finalJob = workflow.approval.artifact.artifact.jobs.at(-1);
      assertExpectedSource(tree.path,workflow,new Set(finalJob.paths),new Set(),finalJob.id);
      continue;
    }
    if (tree.mutablePaths) {
      const observed = observeDualWorktree(tree.path,tree.mutablePaths);
      if (observed.immutableDigest !== tree.immutableDigest) throw new Error(`unreconciled worktree changed outside preserved paths: ${tree.path}`);
      observations.push({root:tree.path,...observed});
    } else if (sourceIdentity(tree.path).digest !== tree.stateDigest) throw new Error(`unreconciled worktree changed: ${tree.path}`);
  }
  return observations;
}

export function assertDualReconciliationAction(brief, plan, actionId) {
  const action = plan.worktreeReconciliation?.find(row => row.id === actionId);
  if (!action || !brief.worktrees.some(tree => tree.path === action.worktreeRoot)
    || action.digestEncoding !== 'dual-file-v1' || !safeDualDataPath(action.targetPath)) throw new Error('unapproved reconciliation action');
  const observed = dualFileDigest(action.worktreeRoot,action.relativePath,{privateData:true});
  if (observed === digest({absent:true}) || observed !== action.expectedSha256) throw new Error('reconciliation source identity changed');
  return action;
}

function readBoundEvidence(file, sha256) {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== path.resolve(file) || !fs.statSync(file).isFile()) throw new Error('review evidence must be an exact regular file');
  const bytes = fs.readFileSync(file);
  if (hashBytes(bytes) !== sha256) throw new Error('review evidence bytes changed');
  return bytes;
}

export function assertDualReviewCurrent(brief, plan) {
  const review = validateDualReview(brief, JSON.parse(readBoundEvidence(brief.review.path, brief.review.sha256)), plan);
  for (const artifact of review.artifacts) readBoundEvidence(artifact.path, artifact.sha256);
  return review;
}

export function assertNativePlanApproval(brief, approval) {
  if (!Array.isArray(approval.nativeEvidence)) throw new Error('native Dual approval evidence is missing');
  const trace = [];
  for (const row of approval.nativeEvidence) {
    const evidence = row.evidence;
    if (evidence?.nativeHost !== row.host || evidence.requestedModel !== TOP_SUBSCRIPTION_MODELS[row.host]
      || evidence.requestedModel !== approval.requestedModels?.[row.host]
      || nativeReviewEvidenceDigest(evidence) !== row.canonicalDigest) throw new Error('native Dual stage identity is invalid');
    const payload = JSON.parse(evidence.prompt.trim().split('\n').at(-1));
    const raw = readNativeCompletion(row.host,evidence.stdout,evidence.requestedModel).value;
    trace.push({host:row.host,stage:row.stage,payload,value:bindStageContent(row.stage,raw)});
  }
  const accepted = validateDeliberationTrace(trace,{roles:approval.roles,brief});
  if (digest(accepted.artifact) !== digest(approval.artifact)
    || digest(accepted.verification) !== digest(approval.verification)) throw new Error('native approval does not bind the accepted plan');

}

export function assertDualBriefCurrent(brief, root = process.cwd(), { plan } = {}) {
  validateDualBrief(brief);
  const source = sourceIdentity(root);
  if (source.digest !== brief.source.digest || source.files !== brief.source.files) throw new Error('reviewed source snapshot is stale');
  const paths = sourcePaths(root);
  if (digest(paths) !== digest(brief.inventory.map(row => row.path).sort())) throw new Error('review inventory omits source paths');
  for (const row of brief.inventory) if (dualFileDigest(root, row.path) !== row.sha256) throw new Error(`reviewed file changed: ${row.path}`);
  for (const row of brief.inventory) if (hashBytes(fs.readFileSync(path.join(root,row.path))) !== row.byteSha256) throw new Error(`reviewed bytes changed: ${row.path}`);
  const review = assertDualReviewCurrent(brief, plan);
  for (const row of review.sources) {
    const bytes = fs.readFileSync(path.join(root,row.path));
    // Valid UTF-8 source can contain NUL (including existing JS fixtures).
    // It still requires full line coverage rather than a binary-review exemption.
    const kind = Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes) ? 'text' : 'binary';
    if (row.kind !== kind) throw new Error(`semantic review source kind differs: ${row.path}`);
    if (kind === 'binary') continue;
    const lines = bytes.length ? bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0) : 0;
    if (lines !== row.lines) throw new Error(`semantic review line population differs: ${row.path}`);
  }
  if (hashBytes(fs.readFileSync(path.join(root, brief.objectives.path))) !== brief.objectives.documentSha256) throw new Error('objective document changed');
  observeExternalTrees(brief,root);
  if (fs.realpathSync(brief.worktrees.find(row => row.disposition === 'canonical').path) !== fs.realpathSync(root)) throw new Error('planning must use the designated canonical checkout');
  return source;
}

export function assertDualJob(workflow, { root = process.cwd(), jobId, changedFiles = [] } = {}) {
  const progress = validateDualProgress(workflow);
  assertNativePlanApproval(workflow.brief,workflow.approval);
  assertDualReviewCurrent(workflow.brief, progress.plan);
  assertReconciliationOutcomes(workflow);
  const { nextJob } = progress;
  if (!nextJob || nextJob.id !== jobId) throw new Error('only the next unfinished job may execute');
  const canonical = workflow.brief.worktrees.find(tree=>tree.disposition==='canonical').path;
  const final = nextJob.id === progress.plan.completion.jobId;
  if (fs.realpathSync(root) !== path.resolve(canonical)
    && (!final || root !== progress.plan.completion.root)) throw new Error('job must execute in its approved checkout');
  observeExternalTrees(workflow.brief,root,{finalRoot:progress.plan.completion.root,completing:final,workflow});
  if (!Array.isArray(changedFiles) || changedFiles.some(file => !nextJob.paths.includes(file))) throw new Error('requested change is outside the active job');
  const allowed = new Set(nextJob.paths);
  const preserved = root === progress.plan.completion.root ? new Set(progress.plan.completion.preservedPaths || []) : new Set();
  assertExpectedSource(root,workflow,allowed,preserved);
  return progress;
}

export function validateDualCheckReport(check, stdout, root) {
  if (!check.report) return {};
  const report = JSON.parse(stdout);
  if (report.success !== true || !Array.isArray(report.testResults)) throw new Error('structured report did not pass');
  const files = report.testResults.map(row => path.relative(root, path.resolve(root, row.name)).split(path.sep).join('/')).sort();
  if (digest(files) !== digest([...check.report.files].sort())) throw new Error('structured report executed the wrong file population');
  const cases = report.testResults.flatMap(row => {
    if (row.status !== 'passed' || !Array.isArray(row.assertionResults) || !row.assertionResults.length) throw new Error('structured report has an empty or failed file');
    return row.assertionResults;
  });
  if (cases.length < check.report.minTests || cases.some(row => row.status !== 'passed')
    || report.numTotalTests !== cases.length || report.numPassedTests !== cases.length
    || report.numFailedTests !== 0 || report.numPendingTests !== 0
    || (report.numTodoTests !== undefined && report.numTodoTests !== 0)) throw new Error('structured report has missing, skipped or failed cases');
  return { reportDigest:digest(report), executedFiles:files, executedTests:cases.length };
}

// Check commands are taken ONLY from the reviewed plan, never from a completion claim.
// No state database is created: the caller retains receipts in canonical project AgentDB.
export async function verifyDualJob(workflow, { root = process.cwd(), jobId } = {}) {
  const { plan, nextJob, previousDigest } = assertDualJob(workflow, { root, jobId });
  const files = nextJob.paths.map(file => ({ path: file, sha256: dualFileDigest(root, file) }));
  const before = sourceIdentity(root);
  const checks = [];
  for (const check of nextJob.checks) {
    const result = await spawnNativeHost(check.command, check.args, {
      cwd: root, env: { ...process.env, RUFLO_DAEMON_AUTOSTART: '0' }, timeout: check.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'], killSignal: 'SIGKILL',
    }, '');
    const row = { id: check.id, commandDigest: digest(check), status: result.status,
      outputComplete: result.outputComplete === true, timedOut: result.timedOut === true,
      matchedOutput: String(result.stdout).includes(check.expectedOutput) ? check.expectedOutput : null,
      outputDigest: digest({ stdout: result.stdout, stderr: result.stderr }) };
    checks.push(row);
    if (row.status !== 0 || !row.outputComplete || row.timedOut || row.matchedOutput === null) throw new Error(`acceptance failed: ${check.id}; dependent work must not advance`);
    try { Object.assign(row, validateDualCheckReport(check, result.stdout, root)); }
    catch (error) { throw new Error(`acceptance failed: ${check.id}; ${error.message}`); }
  }
  const after = sourceIdentity(root);
  if (before.digest !== after.digest) throw new Error('source changed while acceptance checks ran');
  const observedFiles = nextJob.paths.map(file => ({ path: file, sha256: dualFileDigest(root, file) }));
  if (digest(observedFiles) !== digest(files)) throw new Error('owned source changed while acceptance checks ran');
  assertDualJob(workflow, { root, jobId });
  if (nextJob.id === plan.completion.jobId) assertConsolidated(root, plan.completion);
  const reconciliation = (plan.worktreeReconciliation || []).filter(action=>action.jobId===jobId).map(action=> {
    assertDualReconciliationAction(workflow.brief,plan,action.id);
    const targetSha256 = action.action === 'remove' ? null : dualFileDigest(action.targetRoot,action.targetPath,{privateData:true});
    if (action.action !== 'remove' && targetSha256 !== action.expectedSha256) throw new Error(`unfinished reconciliation action: ${action.id}`);
    return {actionId:action.id,actionDigest:digest(action),sourceSha256:action.expectedSha256,targetSha256};
  });
  const retirements = workflow.brief.worktrees.filter(tree=>tree.retireAfterJob===jobId).map(tree=> {
    // A user may refresh mutable content after an earlier preservation job.
    // Recheck the source and surviving copy at retirement, not just the old receipt.
    for (const action of (plan.worktreeReconciliation || []).filter(action=>action.worktreeRoot===tree.path && action.action==='preserve')) {
      assertDualReconciliationAction(workflow.brief,plan,action.id);
      if (dualFileDigest(action.targetRoot,action.targetPath,{privateData:true}) !== action.expectedSha256) throw new Error(`retirement preservation changed: ${action.id}`);
    }
    return {root:tree.path,sourceDigest:sourceIdentity(tree.path).digest,ignoredDigest:observeIgnoredFiles(tree)};
  });
  const externalObservations = observeExternalTrees(workflow.brief,root,{finalRoot:plan.completion.root,completing:nextJob.id === plan.completion.jobId,workflow});
  const preservedObservations = plan.completion.root === root ? observeDualWorktree(root,plan.completion.preservedPaths || []).mutable : [];
  return { schemaVersion: 1, kind: 'dual-job-acceptance', jobId, planDigest: digest(plan), previousDigest,
    sourceDigest: after.digest, files, scopeDigest: digest(files), checks, externalObservations, preservedObservations, reconciliation, retirements };
}

function assertConsolidated(root, completion) {
  const preserved = new Set(completion.preservedPaths || []);
  const dirty = git(root,['status','--porcelain=v1','-z']).split('\0').filter(Boolean);
  const unexplained = dirty.some(row => row.length < 4 || /[RC]/.test(row.slice(0,2)) || !preserved.has(row.slice(3)));
  if ((completion.branch !== undefined && git(root, ['branch', '--show-current']).trim() !== completion.branch)
    || (completion.root !== undefined && fs.realpathSync(root) !== fs.realpathSync(completion.root))
    || (completion.clean && unexplained)
    || (completion.worktreeCount !== undefined && git(root, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length !== completion.worktreeCount)) {
    throw new Error('repository does not meet the approved completion conditions');
  }
}

export function verifyDualCompletion(workflow, { root = process.cwd() } = {}) {
  const { plan, nextJob } = validateDualProgress(workflow);
  assertNativePlanApproval(workflow.brief,workflow.approval);
  if (nextJob) throw new Error(`unfinished job: ${nextJob.id}`);
  assertConsolidated(root, plan.completion);
  assertReconciliationOutcomes(workflow);
  observeExternalTrees(workflow.brief,root,{finalRoot:plan.completion.root,completing:true,workflow});
  const preserved = observeDualWorktree(root,plan.completion.preservedPaths || []).mutable;
  if (digest(preserved) !== digest(workflow.completed.at(-1).preservedObservations || [])) throw new Error('preserved user state changed after final acceptance');
  const source = sourceIdentity(root);
  if (source.digest !== workflow.completed.at(-1).sourceDigest) throw new Error('final acceptance is stale');
  return { status: 'complete', verifiedOutcome: true, sourceDigest: source.digest, workflowDigest: digest(workflow) };
}
