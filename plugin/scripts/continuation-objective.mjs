import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { writeAtomic } from './learning-queue.mjs';
import path from 'node:path';
import { resolveProjectStore } from './project-store-resolver.mjs';
import { CONTINUITY_NAMESPACE } from './continuity-events.mjs';
import { normalizePromise, extractCommitments } from './completion-claim-evidence.mjs';
import { withProgressionReader } from './project-progression-reader.mjs';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const text = (value) => typeof value === 'string' && value.trim().length > 0;

// Repository identity is the canonical common git directory, NOT a basename or remote URL.
// Linked worktrees share a project identity but require their own explicit worktree authorization.
export function continuationProjectIdentity(cwd, { deadlineAt = Date.now() + 500 } = {}) {
  if (!text(cwd) || !path.isAbsolute(cwd)) return null;
  try {
    const resolved = resolveProjectStore({ projectDir: cwd, deadlineAt, gitTimeoutMs: Math.max(1, Math.min(200, deadlineAt - Date.now())) });
    return { projectId: resolved.projectIdentity.id, worktreeId: hash(resolved.checkoutRoot),
      root: resolved.checkoutRoot };
  } catch { return null; }
}

/** Shared location only; this advisory index never becomes task authority. */
export function continuationLedgerPath({ projectDir = process.cwd(), env = process.env,
  home = env.HOME || os.homedir(), identity = continuationProjectIdentity(projectDir) } = {}) {
  return env.RUVNET_WORK_LEDGER || path.join(home, '.config', 'ruvnet-brain', 'work-ledgers',
    `${identity?.projectId.replace(':', '-') || 'unknown-project'}.json`);
}

// Non-authoritative continuation preferences in the EXISTING ledger, not a second task store.
// These request/suppress a hook nudge only; they neither prove user provenance nor establish task
// completion. Canonical project progression remains in AgentDB. No automatic writer or native
// continuation bridge is supplied here. Configuration must cite an actual user authorization.
export function authorizedContinuationObjective(objective, input, identity) {
  if (!identity || input?.hook_event_name !== 'Stop' || !text(input.session_id)
    || input.interrupted || input.cancelled || input.stop_hook_active) return null;
  if (objective?.schemaVersion !== 1 || objective.kind !== 'continuation-preferences'
    || objective.authoritative !== false || !['active', 'completed'].includes(objective.state)
    || !text(objective.id) || !text(objective.text) || !Number.isFinite(Date.parse(objective.at))
    || objective.authorization?.kind !== 'user' || !text(objective.authorization.reference)
    || objective.projectId !== identity.projectId
    // '*' is the ONLY session wildcard, and it exists for exactly one reason: `--commit-to` (the CLI
    // a model actually runs to arm this gate) writes the objective from a bare terminal invocation,
    // which has no access to the session_id a future Stop event will carry — only a live Stop hook
    // ever sees that. Every OTHER writer must still name real session ids; a wildcard is never
    // implied by omission, only by this exact literal.
    || !Array.isArray(objective.sessionIds)
    || !(objective.sessionIds.includes(input.session_id) || objective.sessionIds.includes('*'))
    || !Array.isArray(objective.worktreeIds) || !objective.worktreeIds.includes(identity.worktreeId)) return null;
  return objective;
}

// Automatic assistant commitments never confer project-wide user authority. Retained legacy
// wildcards belong only to their proven capturing session; unknown ownership stays historical.
export function assistantCommitmentOwned(item, sessionId, identity) {
  return Boolean(identity && text(sessionId) && sessionId !== '*'
    && item?.kind === 'assistant-commitment' && item.schemaVersion === 1
    && item.done !== true && text(item.text) && Number.isFinite(Date.parse(item.at))
    && item.authorization?.kind === 'owner-mandate' && text(item.authorization.reference)
    && item.projectId === identity.projectId
    && Array.isArray(item.worktreeIds) && item.worktreeIds.includes(identity.worktreeId)
    && item.capturedFrom?.sessionId === sessionId
    && Array.isArray(item.sessionIds)
    && (item.sessionIds.includes(sessionId) || item.sessionIds.includes('*')));
}

const noncompletedStates = new Set(['blocked', 'deferred', 'superseded', 'disputed']);

/** Explicit owner-session preference, not verified completion or authority to cancel user work. */
export function setAssistantCommitmentState(ledger, { itemText, state, sessionId, reason,
  replacementReference, identity, at = new Date().toISOString() } = {}) {
  if (!noncompletedStates.has(state) || !text(reason) || reason.length > 4000
    || !text(sessionId) || sessionId === '*' || !Number.isFinite(Date.parse(at))) {
    throw new Error('commitment state requires a supported noncompleted state, exact session id and reason');
  }
  if (state === 'superseded' && (!text(replacementReference) || replacementReference === itemText)) {
    throw new Error('superseded requires a distinct replacement reference');
  }
  const matches = (Array.isArray(ledger.items) ? ledger.items : []).filter((item) => item.text === itemText
    && assistantCommitmentOwned(item, sessionId, identity));
  if (matches.length !== 1) throw new Error('exact assistant commitment is not uniquely owned by this session and worktree');
  const item = matches[0];
  if (item.stateHistory !== undefined && !Array.isArray(item.stateHistory)) {
    throw new Error('existing commitment state history is malformed; retain it for explicit recovery');
  }
  const transition = { from: item.state || 'active', to: state, at, reason: reason.trim(),
    provenance: { kind: 'explicit-session-cli', sessionId },
    ...(text(replacementReference) ? { replacementReference: replacementReference.trim() } : {}) };
  item.stateHistory = [...(Array.isArray(item.stateHistory) ? item.stateHistory : []), transition];
  item.state = state;
  item.stateChangedAt = at;
  return item;
}

/** A future/conditional assistant sentence cannot bootstrap work at the current Stop.
 * Retain its historical state; only an explicit current task can authorize the deferred action.
 * This is intent eligibility, not age expiry, scheduling, or a completion verdict.
 */
export function assistantCommitmentExecutableNow(item) {
  return text(item?.text) && !/\b(?:tomorrow|tonight|later|next\s+(?:day|week|month|time)|on\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|if|unless|once|when|whenever|after|before|until|await|wait|shortly|periodically|regularly|every\s+\d+|check\s+(?:back|again)|say\s+the\s+word|let\s+me\s+know|need\s+your|your\s+(?:approval|confirmation|decision))\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b/i.test(item.text);
}

// A state change suppresses only this assistant's nudge. The independent user objective is untouched.
export function authorizedPromiseItems(items, input, identity) {
  if (!identity || input?.hook_event_name !== 'Stop' || !text(input.session_id)
    || input.interrupted || input.cancelled || input.stop_hook_active) return [];
  return (Array.isArray(items) ? items : []).filter((item) => assistantCommitmentOwned(item, input.session_id, identity)
    && (item.state === undefined || item.state === 'active') && assistantCommitmentExecutableNow(item)
    && ((text(input.turn_id) && item.capturedFrom?.turnId === input.turn_id)
      || extractCommitments(input.last_assistant_message).some(promise => normalizePromise(promise.text) === normalizePromise(item.text))));
}

/** Advisory index only. Malformed/shared ledger bytes are retained for explicit recovery. */
export function readContinuationLedger(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return { items: [] };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('continuation ledger is shared, indirect or foreign');
  }
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger) || !Array.isArray(ledger.items)) {
    throw new Error('continuation ledger is malformed; retain it for recovery');
  }
  return ledger;
}

/** Bounded exclusive lock; never mutate stale snapshots or run a writer unlocked. */
export function mutateContinuationLedger(file, mutate, { deadlineAt = Date.now() + 200 } = {}) {
  deadlineAt = Math.min(deadlineAt, Date.now() + 200);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  for (;;) {
    if (Date.now() >= deadlineAt) throw new Error('continuation ledger lock deadline exhausted');
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(10, Math.max(0, deadlineAt - Date.now())));
    }
  }
  const owned = fs.fstatSync(fd);
  try {
    const ledger = readContinuationLedger(file);
    const value = mutate(ledger);
    if (value === false) return { ledger, value }; // Explicit no-change bookkeeping does not create a writer.
    if (Date.now() >= deadlineAt) throw new Error('continuation ledger mutation deadline exhausted');
    ledger.updated = new Date().toISOString();
    writeAtomic(file, JSON.stringify(ledger, null, 2) + '\n');
    return { ledger, value };
  } finally {
    fs.closeSync(fd);
    try {
      const current = fs.lstatSync(lock);
      if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lock);
    } catch { /* A changed/missing lock is not permission to remove another writer's lock. */ }
  }
}

export const MANAGED_CONTINUATION_POINTER_KIND = 'managed-workflow-pointer';
const BINDING_KEYS = ['schemaVersion', 'taskId', 'workflowId', 'host', 'nativeSessionId', 'projectId', 'worktreeId', 'userInstructionRef', 'userInstructionDigest'];
const SHA256 = /^[a-f0-9]{64}$/;
const FRONTEND_KEYS=['schemaVersion','taskId','workflowId','host','projectId','worktreeId','userInstructionRef','userInstructionDigest','intakeOrigin','frontendInstanceId','submissionSequence','parentPermissionDigest'];
const bindingEqual = (a, b) => (a?.schemaVersion===2?FRONTEND_KEYS:BINDING_KEYS).every(key => a?.[key] === b?.[key]);
const assertTask = (value, reason) => { if (!value) throw new Error(reason); };

export function validManagedContinuationBinding(binding) {
  if(binding?.schemaVersion===2)return ['claude','codex'].includes(binding.host) && binding.intakeOrigin==='managed-frontend'
    && ['taskId','workflowId','projectId','worktreeId','userInstructionRef','userInstructionDigest','frontendInstanceId','parentPermissionDigest'].every(key=>text(binding[key]))
    && Number.isSafeInteger(binding.submissionSequence)&&binding.submissionSequence>0&&binding.nativeSessionId===undefined
    && [binding.worktreeId,binding.userInstructionDigest,binding.parentPermissionDigest].every(value=>SHA256.test(value));
  return binding?.schemaVersion === 1 && ['claude', 'codex'].includes(binding.host)
    && BINDING_KEYS.slice(1).every(key => text(binding[key]) && binding[key].length <= 4000)
    && binding.nativeSessionId !== '*' && SHA256.test(binding.userInstructionDigest)
    && SHA256.test(binding.worktreeId);
}

function readCanonicalTaskEvent(ref, db, deadlineAt, expectedSource = 'model-managed-workflow-service', expectedAuthority = true) {
  assertTask(ref?.namespace === CONTINUITY_NAMESPACE && text(ref.key) && ref.key.length <= 400
    && SHA256.test(ref.valueSha256), 'canonical task receipt reference is missing or malformed');
  const result = withProgressionReader(db, reader => reader.readContent(CONTINUITY_NAMESPACE, ref.key), { deadlineAt });
  assertTask(result.ok && typeof result.value === 'string' && Buffer.byteLength(result.value) <= 1024 * 1024,
    'canonical task receipt unavailable; queued/local flags are not completion');
  assertTask(hash(result.value) === ref.valueSha256, 'canonical task receipt bytes changed');
  const event = JSON.parse(result.value);
  assertTask(event?.source === expectedSource && event.kind === 'decision'
    && event.authoritative === expectedAuthority && event.detail && typeof event.detail === 'object', 'canonical task receipt producer is not the managed service');
  return event;
}

function validNativeIntake(intake, binding) {
  return intake?.schemaVersion === 1 && intake.kind === 'native-user-intake' && intake.status === 'native-user-intake'
    && intake.host === binding.host && intake.nativeSessionId === binding.nativeSessionId
    && intake.projectId === binding.projectId && intake.worktreeId === binding.worktreeId
    && text(intake.nativeUserEventRef?.id) && intake.nativeUserEventRef.id !== '*'
    && intake.nativeUserEventRef.kind === (binding.host === 'claude' ? 'claude-prompt-id' : 'codex-turn-id');
}

// Identity is the typed ordered path/digest tuple, not JSON object insertion order.
function sameOrderedSourceRefs(left, right) {
  const valid = ref => ref && typeof ref === 'object' && !Array.isArray(ref)
    && Object.keys(ref).length === 2 && Object.hasOwn(ref, 'path') && Object.hasOwn(ref, 'digest')
    && text(ref.path) && typeof ref.digest === 'string' && SHA256.test(ref.digest);
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((ref, index) => valid(ref) && valid(right[index])
      && ref.path === right[index].path && ref.digest === right[index].digest);
}

function verifyCurrentRefs(refs, label) {
  assertTask(Array.isArray(refs) && refs.length > 0 && new Set(refs.map(ref => ref?.path)).size === refs.length,
    `${label} references unavailable or duplicated`);
  for (const ref of refs) {
    assertTask(text(ref?.path) && path.isAbsolute(ref.path) && SHA256.test(ref.digest)
      && fs.realpathSync(ref.path) === ref.path && fs.lstatSync(ref.path).isFile(), `${label} reference is indirect or malformed`);
    assertTask(hash(fs.readFileSync(ref.path)) === ref.digest, `${label} source bytes changed`);
  }
}

function verifiedManagedCompletion(receipt, review, binding, registration) {
  const tasks = receipt.taskChecklist;
  assertTask(Array.isArray(tasks) && tasks.length > 0 && new Set(tasks.map(task => task?.id)).size === tasks.length,
    'complete label has no verified task checklist');
  assertTask(Array.isArray(registration.taskChecklist) && registration.taskChecklist.length > 0
    && registration.taskChecklist.every(required => tasks.some(task => task.id === required.id
      && Array.isArray(required.requiredCheckIds) && required.requiredCheckIds.every(id => task.requiredCheckIds?.includes(id))
      && (!required.assistantCommitmentText || task.assistantCommitmentText === required.assistantCommitmentText))),
    'completion changed the registered task/check obligations');
  assertTask(SHA256.test(receipt.artifactDigest) && text(receipt.reviewerWorkerId)
    && Array.isArray(receipt.reviewEvidence) && receipt.reviewEvidence.length > 0
    && Array.isArray(receipt.acceptanceEvidence) && receipt.acceptanceEvidence.length > 0,
    'complete label has no bound acceptance and independent review evidence');
  for (const task of tasks) {
    assertTask(task.state === 'verified' && Array.isArray(task.requiredCheckIds) && task.requiredCheckIds.length > 0
      && task.proof?.artifactDigest === receipt.artifactDigest && Array.isArray(task.proof.checks), 'unfinished or unproven task in complete receipt');
    for (const id of task.requiredCheckIds) {
      assertTask(task.proof.checks.some(check => check.id === id && check.passed === true)
        && receipt.acceptanceEvidence.some(check => check.taskId === task.id && check.checkId === id && check.passed === true),
        'required task acceptance check is not proven');
    }
  }
  assertTask(review?.status === 'review-finished' && review.workflowId === receipt.workflowId
    && review.originalPromptDigest === receipt.originalPromptDigest
    && bindingEqual(review.continuationBinding, binding) && Array.isArray(review.nativeReceipts), 'preceding same-task native review receipt unavailable');
  const reviewer = review.nativeReceipts.find(item => item.workerId === receipt.reviewerWorkerId);
  assertTask(reviewer?.status === 'succeeded' && reviewer.exitCategory === 'success' && text(reviewer.sessionId)
    && reviewer.sessionId !== binding.nativeSessionId && text(reviewer.observedModel)
    && ['claude', 'codex'].includes(reviewer.host) && reviewer.receiptRef?.path && SHA256.test(reviewer.receiptRef.digest),
    'independent native reviewer result/model/session is not proven');
  assertTask(!review.nativeReceipts.some(item => item.workerId !== receipt.reviewerWorkerId && item.sessionId === reviewer.sessionId),
    'reviewer shares a worker session');
  const requiredReviewer = registration.continuationRequirements?.reviewer;
  assertTask(requiredReviewer?.kind === 'native-independent', 'registered independent reviewer requirement unavailable');
  if (requiredReviewer.observedModel !== undefined) assertTask(reviewer.observedModel === requiredReviewer.observedModel, 'native reviewer model differs from registered obligation');
  if (requiredReviewer.host !== undefined) assertTask(reviewer.host === requiredReviewer.host, 'native reviewer host differs from registered obligation');
  if (requiredReviewer.observedEffort !== undefined) assertTask(reviewer.observedEffort === requiredReviewer.observedEffort, 'native reviewer effort differs from registered obligation');
  verifyCurrentRefs([reviewer.receiptRef], 'native reviewer');
  const nativeBytes = fs.readFileSync(reviewer.receiptRef.path);
  assertTask(hash(nativeBytes) === reviewer.receiptRef.digest, 'native reviewer receipt changed while read');
  const native = JSON.parse(nativeBytes);
  assertTask(native.workerId === receipt.reviewerWorkerId && native.role === 'reviewer' && native.readOnly === true
    && native.completed === true && native.modelObserved === true && native.host === reviewer.host
    && native.sessionId === reviewer.sessionId && native.observedModel === reviewer.observedModel
    && native.workflowId === receipt.workflowId && native.originalPromptDigest === receipt.originalPromptDigest
    && native.artifactDigest === receipt.artifactDigest
    && sameOrderedSourceRefs(native.checkerSourceRefs, receipt.checkerSourceRefs),
    'native review file does not prove this task/artifact/model/checker source');
  assertTask(!receipt.workerObservations?.items?.some(item => item.sessionId === reviewer.sessionId),
    'independent reviewer shares an implementation session');
  verifyCurrentRefs(receipt.artifactRefs, 'accepted artifact');
  verifyCurrentRefs(receipt.checkerSourceRefs, 'acceptance checker');
  assertTask(hash(JSON.stringify([...receipt.artifactRefs].sort((a, b) => a.path.localeCompare(b.path)))) === receipt.artifactDigest,
    'accepted artifact reference digest changed');
}

/** Resolve a scoped pointer through the existing canonical store, never a caller-supplied task status. */
export function readManagedContinuationTask(pointer, { projectDir, host, nativeSessionId, frontendInstanceId, submissionSequence, deadlineAt = Date.now() + 500 } = {}) {
  try {
    const binding = pointer?.binding;
    assertTask(pointer?.schemaVersion === 1 && pointer.kind === MANAGED_CONTINUATION_POINTER_KIND
      && validManagedContinuationBinding(binding), 'registered task binding unavailable');
    const identity = continuationProjectIdentity(projectDir, { deadlineAt });
    assertTask(identity && binding.projectId === identity.projectId && binding.worktreeId === identity.worktreeId
      && binding.host === host && (binding.schemaVersion===2
        ? (binding.frontendInstanceId===frontendInstanceId&&binding.submissionSequence===submissionSequence || text(nativeSessionId)&&pointer.nativeParentLink)
        : binding.nativeSessionId === nativeSessionId), 'registered task belongs to another observed owner scope');
    assertTask(Date.now() < deadlineAt, 'task receipt deadline exhausted');
    const resolution = resolveProjectStore({ projectDir, deadlineAt, gitTimeoutMs: Math.max(1, Math.min(200, deadlineAt - Date.now())) });
    if(binding.schemaVersion===2&&nativeSessionId){
      const parent=readCanonicalTaskEvent(pointer.nativeParentLink,resolution.canonicalAgentDbPath,deadlineAt).detail;
      assertTask(parent.status==='parent-observed'&&bindingEqual(parent.continuationBinding,binding)
        &&parent.nativeSessionId===nativeSessionId&&parent.modelObserved===true&&parent.effortSettingsObserved===true,
        'Frontend native parent identity is not observed');
    }
    const event = readCanonicalTaskEvent(pointer.receipt, resolution.canonicalAgentDbPath, deadlineAt);
    const receipt = event.detail;
    assertTask(bindingEqual(receipt.continuationBinding, binding) && receipt.workflowId === binding.workflowId
      && receipt.originalPromptDigest === binding.userInstructionDigest, 'canonical task authorization binding changed');
    const registration = readCanonicalTaskEvent(pointer.registrationReceipt, resolution.canonicalAgentDbPath, deadlineAt).detail;
    assertTask(['registered', 'queued'].includes(registration.status) && bindingEqual(registration.continuationBinding, binding)
      && registration.workflowId === binding.workflowId && registration.originalPromptDigest === binding.userInstructionDigest,
      'pre-execution registered authorization receipt unavailable');
    const intakeRef = registration.userInstructionReceipt;
    const frontend=binding.schemaVersion===2;
    const intake = readCanonicalTaskEvent(intakeRef,resolution.canonicalAgentDbPath,deadlineAt,frontend?'managedFrontendPromptSubmit':'nativeUserPromptSubmit',false).detail;
    assertTask(binding.userInstructionRef===intakeRef.key&&intake.userInstructionDigest===binding.userInstructionDigest
      &&(frontend?intake.kind==='managed-frontend-intent'&&intake.inputKind==='interactive'&&intake.origin?.kind==='managed-frontend'
        &&intake.host===binding.host&&intake.projectId===binding.projectId&&intake.worktreeId===binding.worktreeId
        &&intake.frontendInstanceId===binding.frontendInstanceId&&intake.submissionSequence===binding.submissionSequence
        &&intake.parentPermissionRef?.digest===binding.parentPermissionDigest&&intake.permissions?.apiBilling===false
        :validNativeIntake(intake,binding)), 'Original input intake provenance unavailable or mismatched');
    let obligations=registration;
    if(frontend&&registration.definitionPending){
      if(pointer.definitionReceipt){
        obligations=readCanonicalTaskEvent(pointer.definitionReceipt,resolution.canonicalAgentDbPath,deadlineAt).detail;
        assertTask(obligations.status==='defined'&&bindingEqual(obligations.continuationBinding,binding)
          &&obligations.definitionOf?.key===pointer.registrationReceipt.key
          &&obligations.definitionOf?.valueSha256===pointer.registrationReceipt.valueSha256,'Frozen frontend acceptance definition unavailable');
      }else assertTask(receipt.status!=='complete','Pending task definition cannot complete original work');
    }
    if(frontend&&intake.scopeContractRequired?.schemaVersion===2&&pointer.definitionReceipt){
      const contract=obligations.scopeContract,scope=contract?.sourceReview;
      assertTask(contract?.schemaVersion===2&&contract.requestBinding?.workflowId===binding.workflowId
        &&contract.requestBinding.originalPromptDigest===binding.userInstructionDigest
        &&JSON.stringify(contract.requestBinding.userInstructionReceipt)===JSON.stringify(intakeRef)
        &&scope?.state==='qualified'&&scope.consumedAttempt===1,'Canonical required inventory/preflight definition unavailable');
      const preflight=readCanonicalTaskEvent(scope.attestationRef,resolution.canonicalAgentDbPath,deadlineAt).detail;
      const frozen={...scope};delete frozen.attestationRef;
      assertTask(preflight.status==='scope-preflight-finished'&&preflight.workflowId===binding.workflowId
        &&preflight.originalPromptDigest===binding.userInstructionDigest&&bindingEqual(preflight.continuationBinding,binding)
        &&JSON.stringify(preflight.scopeReview)===JSON.stringify(frozen),'Original canonical preflight/definition join changed');
      verifyCurrentRefs([scope.packetRef,scope.observationRef],'scope preflight');
      const observed=JSON.parse(fs.readFileSync(scope.observationRef.path)),packet=JSON.parse(fs.readFileSync(scope.packetRef.path));
      assertTask(observed.role==='reviewer'&&observed.readOnly===true&&observed.completed===true&&observed.workflowId===binding.workflowId
        &&observed.originalPromptDigest===binding.userInstructionDigest&&observed.sessionId===scope.reviewer.sessionId
        &&observed.sessionId!==obligations.planner.sessionId&&observed.model===scope.reviewer.model&&observed.effort===scope.reviewer.effort
        &&observed.verdict.passed===true&&observed.verdict.packetDigest===packet.packetDigest
        &&packet.originalPromptDigest===binding.userInstructionDigest&&packet.inventoryDigest===contract.inventory.digest
        &&packet.tasksDigest===hash(JSON.stringify(obligations.frozenTaskDefinitions)),'Scope reviewer observation or submitted inventory/task packet changed');
      if(receipt.status==='complete')assertTask(receipt.scopeContractDigest===hash(JSON.stringify(contract))
        &&JSON.stringify(receipt.preflightReceipt)===JSON.stringify(scope.attestationRef)
        &&contract.inventory.requirements.every(r=>r.disposition!=='pending'),'First cohort cannot complete retained whole inventory');
    }
    if (receipt.status === 'complete') {
      assertTask(!frontend||intake.scopeContractRequired?.schemaVersion===2,'Legacy frontend inventory remains unqualified for whole completion');
      assertTask(JSON.stringify(receipt.reviewReceipt) === JSON.stringify(pointer.reviewReceipt) && pointer.reviewReceipt,
        'complete receipt does not bind its exact preceding canonical review');
      const review = readCanonicalTaskEvent(pointer.reviewReceipt, resolution.canonicalAgentDbPath, deadlineAt).detail;
      verifiedManagedCompletion(receipt, review, binding, obligations);
      return { state: 'complete', binding, receipt };
    }
    if (['paused', 'cancelled'].includes(receipt.status)) {
      const user = receipt.userDisposition;
      assertTask(user?.kind === (receipt.status === 'paused' ? 'pause' : 'cancel') && user.source === 'trusted-native-user-event'
        && bindingEqual(user.binding, binding) && text(user.reference) && SHA256.test(user.digest), 'pause/cancel lacks an explicit scoped user event');
      const disposition = readCanonicalTaskEvent(user.receipt, resolution.canonicalAgentDbPath, deadlineAt, 'nativeUserPromptSubmit', false).detail;
      assertTask(user.reference === user.receipt.key && validNativeIntake(disposition, binding)
        && disposition.userInstructionDigest === user.digest && disposition.disposition?.kind === user.kind
        && bindingEqual(disposition.disposition?.binding, binding), 'pause/cancel native user disposition authority unavailable or mismatched');
      return { state: receipt.status, binding, receipt };
    }
    if (receipt.status === 'blocked') {
      assertTask(text(receipt.reason) && Array.isArray(receipt.blockerEvidence) && receipt.blockerEvidence.length > 0,
        'blocked label lacks concrete retained evidence');
      return { state: 'blocked', binding, receipt, reason: receipt.reason };
    }
    assertTask(Number.isFinite(receipt.deadline) && Array.isArray(receipt.taskChecklist) && receipt.taskChecklist.length > 0,
      'registered unfinished task has no bounded checklist');
    const progressDigest = hash(JSON.stringify({ taskChecklist: receipt.taskChecklist.map(task => ({ id: task.id, state: task.state,
      attempted: task.attempted, proof: task.proof, requiredCheckIds: task.requiredCheckIds })),
      artifactDigest: receipt.artifactDigest }));
    return { state: 'active', binding, receipt, progressDigest,
      nextSafeStep: receipt.resumeHandoff?.nextStep || 'Read the exact task checklist and continue its next authorized safe step; never replay a completed writer.' };
  } catch (error) { return { state: 'unknown', reason: error.message, binding: pointer?.binding }; }
}

/** Assistant history closes only through its explicit, exact canonical task/check linkage. */
export function verifiedAssistantCommitmentCompletion(item, pointers, options) {
  const link = item?.completionLink;
  if (!link || !validManagedContinuationBinding(link.binding) || !text(link.checklistItemId) || !text(link.checkId)) return null;
  const pointer = (Array.isArray(pointers) ? pointers : []).find(value => bindingEqual(value.binding, link.binding));
  if (!pointer) return null;
  const task = readManagedContinuationTask(pointer, options);
  if (task.state !== 'complete') return null;
  const criterion = task.receipt.taskChecklist.find(value => value.id === link.checklistItemId);
  if (!criterion || normalizePromise(criterion.assistantCommitmentText) !== normalizePromise(item.text)
    || !criterion.requiredCheckIds.includes(link.checkId)
    || !criterion.proof.checks.some(check => check.id === link.checkId && check.passed === true)) return null;
  return { kind: 'canonical-managed-task-check', receipt: pointer.receipt, checklistItemId: link.checklistItemId,
    checkId: link.checkId, artifactDigest: task.receipt.artifactDigest };
}

/** Called only by the existing native intake/service producer after its exact canonical readback. */
export function registerManagedContinuationTask({ ledgerFile, projectDir, binding, receipt, reviewReceipt, definitionReceipt, deadlineAt = Date.now() + 500 }) {
  const snapshot = readContinuationLedger(ledgerFile);
  assertTask(snapshot.managedTasks === undefined || Array.isArray(snapshot.managedTasks), 'managed task pointer index is malformed');
  const previous = snapshot.managedTasks?.find(item => bindingEqual(item.binding, binding));
  const pointer = { schemaVersion: 1, kind: MANAGED_CONTINUATION_POINTER_KIND, binding: structuredClone(binding),
    receipt: structuredClone(receipt), registrationReceipt: previous?.registrationReceipt ?? structuredClone(receipt),
    ...((definitionReceipt||previous?.definitionReceipt)?{definitionReceipt:structuredClone(definitionReceipt||previous.definitionReceipt)}:{}),
    ...((reviewReceipt || previous?.reviewReceipt) ? { reviewReceipt: structuredClone(reviewReceipt || previous.reviewReceipt) } : {}) };
  const verified = readManagedContinuationTask(pointer, { projectDir, host: binding?.host, nativeSessionId: binding?.nativeSessionId, frontendInstanceId:binding?.frontendInstanceId,submissionSequence:binding?.submissionSequence, deadlineAt });
  assertTask(verified.state !== 'unknown', `task pointer not registered: ${verified.reason}`);
  if (!previous) assertTask(['registered', 'queued'].includes(verified.receipt.status), 'task registration requires a pre-execution canonical receipt');
  return mutateContinuationLedger(ledgerFile, ledger => {
    if (ledger.managedTasks !== undefined && !Array.isArray(ledger.managedTasks)) throw new Error('managed task pointer index is malformed');
    const tasks = ledger.managedTasks ?? [];
    const index = tasks.findIndex(item => bindingEqual(item.binding, binding));
    // Expensive canonical verification occurs before this brief critical section. Re-read and fence
    // the exact prior index entry so a concurrent producer cannot be silently overwritten.
    assertTask((index < 0 && !previous) || (index >= 0 && JSON.stringify(tasks[index]) === JSON.stringify(previous)),
      'task pointer changed during verification; retain the newer canonical reference');
    if (index < 0) tasks.push(pointer); else tasks[index] = pointer;
    ledger.managedTasks = tasks;
    return pointer;
  }, { deadlineAt }).value;
}


export function attachObservedFrontendParent({ledgerFile,projectDir,binding,receipt,deadlineAt=Date.now()+1900}){
  assertTask(binding?.schemaVersion===2,'Only frontend origins attach an observed native parent');
  const resolution=resolveProjectStore({projectDir,deadlineAt});
  const parent=readCanonicalTaskEvent(receipt,resolution.canonicalAgentDbPath,deadlineAt).detail;
  assertTask(parent.status==='parent-observed'&&bindingEqual(parent.continuationBinding,binding)
    &&parent.modelObserved===true&&parent.effortSettingsObserved===true&&text(parent.nativeSessionId),
    'Observed native parent receipt required; caller labels cannot attach');
  return mutateContinuationLedger(ledgerFile,ledger=>{const pointer=ledger.managedTasks?.find(value=>bindingEqual(value.binding,binding));
    assertTask(pointer,'Existing frontend task required');pointer.nativeParentLink=structuredClone(receipt);pointer.observedNativeSessionId=parent.nativeSessionId;return pointer;},{deadlineAt}).value;
}
