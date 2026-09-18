// Canonical five-stage contract. Model agreement never substitutes for execution evidence.
import { digest } from './coverage-integrity.mjs';

const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safePath = value => text(value) && !value.startsWith('/') && !value.includes('\\')
  && !value.split('/').some(part => ['', '.', '..', '.git', '.swarm'].includes(part));
const safeDataPath = value => text(value) && !value.startsWith('/') && !value.includes('\\')
  && !value.split('/').some(part => ['', '.', '..', '.git'].includes(part));
const unique = (rows, label) => {
  requireThat(Array.isArray(rows) && rows.length > 0, `${label} must not be empty`);
  requireThat(rows.every(text) && new Set(rows).size === rows.length, `${label} must be unique strings`);
};

export function validateDualBrief(brief) {
  requireThat(brief?.schemaVersion === 2, 'reviewed source brief v2 is required before Dual planning');
  requireThat(hex(brief.source?.digest), 'brief requires an exact source digest');
  requireThat(Number.isSafeInteger(brief.source.files) && brief.source.files > 0, 'brief source count is invalid');
  requireThat(Array.isArray(brief.inventory) && brief.inventory.length === brief.source.files, 'whole-source review inventory is incomplete');
  unique(brief.inventory.map(row => row.path), 'inventory paths');
  for (const row of brief.inventory) {
    requireThat(safePath(row.path) && safePath(row.canonicalOwner) && hex(row.sha256) && hex(row.byteSha256), 'inventory owner, digest or path is unsafe');
    requireThat(['retain', 'replace', 'delete', 'non-code'].includes(row.disposition) && text(row.reason), `unreviewed inventory entry: ${row.path}`);
  }
  requireThat(text(brief.review?.path) && hex(brief.review?.sha256)
    && brief.review.sourceDigest === brief.source.digest, 'hash-bound semantic review manifest is required');
  requireThat(hex(brief.objectives?.documentSha256) && safePath(brief.objectives?.path), 'objective source document is required');
  unique(brief.objectives?.goals?.map(row => row.id), 'objective goals');
  for (const goal of brief.objectives.goals) {
    requireThat(text(goal.outcome) && text(goal.acceptance), `goal ${goal.id} lacks customer behavior or acceptance criteria`);
  }
  unique(brief.worktrees?.map(row => row.path), 'worktree reconciliation');
  requireThat(brief.worktrees.filter(row => row.disposition === 'canonical').length === 1, 'exactly one canonical checkout is required');
  for (const tree of brief.worktrees) {
    requireThat(hex(tree.stateDigest) && text(tree.reason) && ['canonical', 'integrate', 'remove'].includes(tree.disposition), 'worktree reconciliation is incomplete');
    if (tree.mutablePaths !== undefined) {
      unique(tree.mutablePaths, 'external mutable paths');
      requireThat(tree.disposition !== 'canonical' && tree.mutablePaths.every(safePath)
        && hex(tree.immutableDigest), 'mutable observations cannot weaken canonical source fencing');
    }
    if (tree.retireAfterJob !== undefined) {
      requireThat(text(tree.retireAfterJob) && Array.isArray(tree.ignoredFiles) && Array.isArray(tree.disposablePaths), 'checkout retirement requires a private-data inventory');
      requireThat(new Set(tree.ignoredFiles.map(row=>row.path)).size === tree.ignoredFiles.length
        && tree.ignoredFiles.every(row=>safeDataPath(row.path) && hex(row.sha256)), 'ignored private inventory is invalid');
      requireThat(tree.disposablePaths.every(row=>safeDataPath(row.path) && text(row.reason)), 'disposable paths need exact scope and reason');
    }
  }
  return brief;
}

// Structural and source binding, not a claim that a checksum proves comprehension.
// The runtime verifies the referenced raw evidence bytes before plan admission.
export function validateDualReview(brief, review, plan) {
  requireThat(review?.schemaVersion === 1 && review.sourceDigest === brief.source.digest, 'semantic review source is stale');
  requireThat(Array.isArray(review.sources) && review.sources.length === brief.inventory.length, 'semantic review source coverage is incomplete');
  unique(review.sources.map(row => row.path), 'semantic review paths');
  unique(review.artifacts?.map(row => row.id), 'semantic evidence artifacts');
  const artifacts = new Set(review.artifacts.map(row => row.id));
  for (const artifact of review.artifacts) requireThat(text(artifact.path) && hex(artifact.sha256), 'semantic evidence reference is invalid');
  const inventory = new Map(brief.inventory.map(row => [row.path, row]));
  for (const row of review.sources) {
    requireThat(inventory.get(row.path)?.byteSha256 === row.byteSha256 && text(row.assessment)
      && artifacts.has(row.evidenceId), `semantic review is missing or wrong-variant: ${row.path}`);
    requireThat(['text', 'binary'].includes(row.kind) && Number.isSafeInteger(row.lines) && row.lines >= 0
      && Array.isArray(row.readRanges), `semantic review has no bounded coverage: ${row.path}`);
    if (row.kind === 'text') {
      let through = 0;
      for (const range of [...row.readRanges].sort((a,b) => a[0]-b[0])) {
        requireThat(Array.isArray(range) && range.length === 2 && range.every(Number.isSafeInteger)
          && range[0] > 0 && range[0] <= through+1 && range[1] >= range[0] && range[1] <= row.lines,
        `semantic review has a line gap: ${row.path}`);
        through = Math.max(through, range[1]);
      }
      requireThat(through === row.lines, `semantic review is partial: ${row.path}`);
    } else requireThat(row.lines === 0 && row.readRanges.length === 0, 'binary review cannot claim text ranges');
  }
  for (const [kind, count] of Object.entries(brief.review.counts || {})) {
    requireThat(['candidates','adjudications'].includes(kind) && Number.isSafeInteger(count) && count >= 0, 'review population is invalid');
    requireThat(Array.isArray(review[kind]) && review[kind].length === count, `review ${kind} population is incomplete`);
  }
  requireThat(Object.hasOwn(brief.review.counts || {}, 'candidates') && Object.hasOwn(brief.review.counts || {}, 'adjudications'), 'review populations are required');
  for (const kind of ['candidates','adjudications']) {
    const rows = review[kind], ids = new Set(rows.map(row => row.id));
    requireThat(ids.size === rows.length && rows.every(row => text(row.id)), `duplicate ${kind} identity`);
    for (const row of rows) {
      requireThat(['accepted','duplicate','rejected','historical'].includes(row.status)
        && text(row.reason) && artifacts.has(row.evidenceId), `unresolved ${kind} disposition: ${row.id}`);
      if (row.status === 'duplicate') {
        const seen = new Set([row.id]); let next = row;
        while (next.status === 'duplicate') {
          requireThat(ids.has(next.duplicateOf) && !seen.has(next.duplicateOf), 'duplicate disposition is missing or cyclic');
          seen.add(next.duplicateOf); next = rows.find(item => item.id === next.duplicateOf);
        }
      }
      if (row.status === 'accepted') {
        requireThat(text(row.jobId) !== text(row.actionId), `accepted finding needs one execution owner: ${row.id}`);
        if (plan) requireThat(row.jobId ? plan.jobs.some(job => job.id === row.jobId)
          : plan.worktreeReconciliation?.some(action => action.id === row.actionId), `finding ${row.id} has no planned owner`);
      }
    }
  }
  return review;
}

export function validateDualPlan(plan, brief) {
  validateDualBrief(brief);
  requireThat(plan?.schemaVersion === 1 && plan.briefDigest === digest(brief), 'plan does not bind the reviewed source and objective brief');
  requireThat(text(plan.adr) && text(plan.ddd), 'plan requires substantive ADR and DDD decisions');
  requireThat(Array.isArray(plan.unresolved) && plan.unresolved.length === 0, 'plan has unresolved design questions');
  unique(plan.jobs?.map(job => job.id), 'ordered jobs');
  const seen = new Set(), paths = new Set(), covered = new Set(), checkIds = new Set();
  const goals = new Set(brief.objectives.goals.map(goal => goal.id));
  for (const job of plan.jobs) {
    requireThat(text(job.outcome), `job ${job.id} lacks its complete outcome`);
    requireThat(Array.isArray(job.dependsOn) && new Set(job.dependsOn).size === job.dependsOn.length
      && job.dependsOn.every(id => seen.has(id)), `job ${job.id} has a missing, cyclic, or later dependency`);
    unique(job.paths, `job ${job.id} owned paths`);
    for (const file of job.paths) {
      requireThat(safePath(file) && !paths.has(file), `path ${file} has unsafe or multiple job ownership`);
      paths.add(file);
    }
    unique(job.goals, `job ${job.id} goal mapping`);
    requireThat(job.goals.every(id => goals.has(id)), `job ${job.id} refers to an unknown goal`);
    job.goals.forEach(id => covered.add(id));
    unique(job.checks?.map(check => check.id), `job ${job.id} acceptance checks`);
    for (const check of job.checks) {
      requireThat(!checkIds.has(check.id), `duplicate acceptance check ${check.id}`);
      checkIds.add(check.id);
      requireThat(text(check.command) && Array.isArray(check.args) && check.args.every(arg => typeof arg === 'string')
        && text(check.proves) && text(check.expectedOutput) && ['behavior', 'failure', 'integration', 'documentation'].includes(check.kind), `check ${check.id} is not executable acceptance evidence`);
      requireThat(Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0 && check.timeoutMs <= 900000, `check ${check.id} lacks a bounded deadline`);
      if (check.report !== undefined) {
        requireThat(check.report.format === 'vitest-json', `check ${check.id} has an unsupported report`);
        unique(check.report.files, `check ${check.id} required files`);
        requireThat(check.report.files.every(safePath) && Number.isSafeInteger(check.report.minTests)
          && check.report.minTests > 0, `check ${check.id} report population is invalid`);
      }
    }
    seen.add(job.id);
  }
  requireThat([...goals].every(id => covered.has(id)), 'objective goals are missing from the execution plan');
  for (const row of brief.inventory) {
    requireThat(brief.inventory.some(file => file.path === row.canonicalOwner) || paths.has(row.canonicalOwner), `canonical owner ${row.canonicalOwner} is absent`);
    if (['replace', 'delete'].includes(row.disposition)) requireThat(paths.has(row.path), `removal/migration ${row.path} has no owning job`);
  }
  requireThat(plan.completion?.jobId === plan.jobs.at(-1).id && typeof plan.completion.clean === 'boolean', 'completion must belong to the final job');
  requireThat(plan.completion.branch === undefined || text(plan.completion.branch), 'completion branch is invalid');
  requireThat(plan.completion.worktreeCount === undefined || (Number.isSafeInteger(plan.completion.worktreeCount) && plan.completion.worktreeCount > 0), 'completion worktree count is invalid');
  if (plan.worktreeReconciliation !== undefined) {
    unique(plan.worktreeReconciliation.map(action => action.id), 'reconciliation action IDs');
    const targets = new Set();
    for (const action of plan.worktreeReconciliation) {
      requireThat(brief.worktrees.some(tree => tree.path === action.worktreeRoot)
        && safeDataPath(action.relativePath) && safeDataPath(action.targetPath)
        && action.digestEncoding === 'dual-file-v1' && hex(action.expectedSha256)
        && plan.jobs.some(job=>job.id===action.jobId)
        && brief.worktrees.some(tree=>tree.path===action.targetRoot)
        && ['integrate','preserve','remove'].includes(action.action) && text(action.reason), 'external reconciliation action is unsafe or unbound');
      const target = `${action.targetRoot}/${action.targetPath}`;
      requireThat(!targets.has(target), 'reconciliation targets conflict'); targets.add(target);
      requireThat(action.expectedSha256 !== digest({absent:true}), 'reconciliation source must exist');
      if (action.action === 'remove') requireThat(brief.worktrees.find(tree=>tree.path===action.worktreeRoot)?.retireAfterJob, 'removal requires checkout retirement ownership');
      if (action.action !== 'remove') {
        const owner = plan.jobs.find(job=>job.paths.includes(action.targetPath));
        requireThat(!owner || owner.id === action.jobId, 'reconciliation destination belongs to another job');
      }
    }
  }
  for (const tree of brief.worktrees.filter(tree=>tree.retireAfterJob)) {
    requireThat(text(plan.completion.root), 'checkout retirement requires an explicit completion root');
    const index = plan.jobs.findIndex(job=>job.id===tree.retireAfterJob);
    requireThat(index >= 0 && index < plan.jobs.length-1 && tree.path !== plan.completion.root, 'retirement must be accepted before final consolidation');
    const actions = (plan.worktreeReconciliation || []).filter(action=>action.worktreeRoot===tree.path);
    requireThat(actions.every(action=>plan.jobs.findIndex(job=>job.id===action.jobId)<=index), 'retirement precedes reconciliation');
    for (const file of tree.ignoredFiles) requireThat(actions.some(action=>action.relativePath===file.path
      && action.action==='preserve' && action.expectedSha256===file.sha256 && action.targetRoot!==tree.path), 'private data has no preservation action');
    for (const file of tree.mutablePaths || []) requireThat(actions.some(action=>action.relativePath===file
      && action.action==='preserve' && action.targetRoot!==tree.path), 'mutable user data has no preservation action');
    for (const action of actions.filter(action=>action.action==='preserve')) requireThat(
      !brief.worktrees.find(target=>target.path===action.targetRoot)?.retireAfterJob, 'preservation destination must survive retirement');
  }
  if (plan.completion.root !== undefined) requireThat(brief.worktrees.some(tree => tree.path === plan.completion.root), 'final checkout must already be reconciled in the brief');
  if (plan.completion.preservedPaths !== undefined) {
    unique(plan.completion.preservedPaths, 'preserved user paths');
    const target = brief.worktrees.find(tree => tree.path === plan.completion.root);
    requireThat(target && plan.completion.preservedPaths.every(file => safePath(file)
      && target.mutablePaths?.includes(file) && !paths.has(file)), 'preserved user changes must be observed and excluded from all job ownership');
  }
  return plan;
}

// This validates evidence structure and binding, not cryptographic producer authenticity.
// The executable runner supplies observations; model-written PASS flags are insufficient.
export function validateDualProgress(workflow) {
  const { brief, approval, completed } = workflow ?? {};
  const plan = approval?.artifact?.artifact;
  validateDualPlan(plan, brief);
  requireThat(approval.status === 'accepted' && approval.planAccepted === true && approval.dual === true
    && approval.verifiedOutcome === false && approval.artifact.contentDigest === digest(plan)
    && approval.verification?.verdict === 'accept'
    && approval.verification.contentDigest === digest(plan)
    && approval.verification.artifactSha256 === approval.artifact.artifactSha256
    && Array.isArray(approval.verification.corrections) && approval.verification.corrections.length === 0,
  'current two-host plan approval is required');
  requireThat(approval.roles?.scribe !== approval.roles?.verifier
    && ['codex', 'claude-code'].every(host => [approval.roles?.scribe, approval.roles?.verifier].includes(host)), 'both native reviewers are required');
  requireThat(Array.isArray(completed) && completed.length <= plan.jobs.length, 'completion history is malformed');
  let previous = digest(approval);
  for (const [index, receipt] of completed.entries()) {
    const job = plan.jobs[index];
    requireThat(receipt.jobId === job.id && receipt.planDigest === digest(plan) && receipt.previousDigest === previous,
      'jobs must complete exactly once in dependency order against this plan');
    requireThat(hex(receipt.sourceDigest) && hex(receipt.scopeDigest) && receipt.scopeDigest === digest(receipt.files)
      && Array.isArray(receipt.files) && receipt.files.length === job.paths.length
      && receipt.files.every((file, i) => file.path === job.paths[i] && hex(file.sha256)) && Array.isArray(receipt.checks)
      && receipt.checks.length === job.checks.length, `job ${job.id} lacks source-bound acceptance evidence`);
    for (const [i, check] of job.checks.entries()) {
      const result = receipt.checks[i];
      requireThat(result?.id === check.id && result.commandDigest === digest(check) && result.status === 0
        && result.outputComplete === true && result.timedOut === false && result.matchedOutput === check.expectedOutput
        && hex(result.outputDigest), `job ${job.id} acceptance check ${check.id} did not pass`);
      if (check.report) requireThat(hex(result.reportDigest) && result.executedTests >= check.report.minTests
        && digest(result.executedFiles) === digest([...check.report.files].sort()), `check ${check.id} has no complete structured result`);
    }
    const actions = (plan.worktreeReconciliation || []).filter(action=>action.jobId===job.id);
    requireThat(Array.isArray(receipt.reconciliation) && receipt.reconciliation.length===actions.length
      && actions.every((action,i)=>receipt.reconciliation[i]?.actionId===action.id
        && receipt.reconciliation[i]?.actionDigest===digest(action)
        && receipt.reconciliation[i]?.sourceSha256===action.expectedSha256
        && (action.action==='remove' || receipt.reconciliation[i]?.targetSha256===action.expectedSha256)), 'job has unfinished reconciliation actions');
    const retirements=brief.worktrees.filter(tree=>tree.retireAfterJob===job.id);
    requireThat(Array.isArray(receipt.retirements) && receipt.retirements.length===retirements.length
      && retirements.every((tree,i)=>receipt.retirements[i]?.root===tree.path
        && hex(receipt.retirements[i]?.sourceDigest) && hex(receipt.retirements[i]?.ignoredDigest)), 'job has no checkout retirement proof');
    previous = digest(receipt);
  }
  return { plan, nextJob: plan.jobs[completed.length] ?? null, previousDigest: previous };
}

export { safePath as safeDualPath, safeDataPath as safeDualDataPath };
