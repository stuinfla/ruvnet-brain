#!/usr/bin/env node
import { nativeReviewEvidenceDigest, readNativeCompletion, NATIVE_PROMPT_BUDGET } from './native-review-evidence.mjs';

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawnNativeHost as spawnHost } from './native-host-process.mjs';
import { fileURLToPath } from 'node:url';
import { probeSubscriptionHosts, subscriptionOnlyEnv } from './subscription-hosts.mjs';
import { digest } from './coverage-integrity.mjs';
import { validateDualPlan } from './dual-workflow-contract.mjs';
import { assertDualBriefCurrent } from './dual-workflow.mjs';
import { DualWorkflowStore } from './dual-workflow-store.mjs';
import { nativeStageJsonSchema, validateNativeStageValue, validateStageValue, TOP_SUBSCRIPTION_MODELS, correctionLedgerFromCritiques, mergeVerifierCorrections, validateDeliberationTrace } from './dual-deliberation-contract.mjs';
export { validateStageValue } from './dual-deliberation-contract.mjs';

const HOSTS = Object.freeze(['claude-code', 'codex']);
export { TOP_SUBSCRIPTION_MODELS } from './dual-deliberation-contract.mjs';
const HARD_PROBLEM = /\b(adr|architecture|architect|ddd|bounded context|aggregate|agentic[- ]?qe|holistic|security|production|migration|irreversible|threat model|experience)\b/i;

export function hardProblem(task) {
  return HARD_PROBLEM.test(String(task));
}

export function chooseRoles(task) {
  const firstByte = createHash('sha256').update(String(task)).digest()[0];
  const scribe = HOSTS[firstByte % HOSTS.length];
  return {
    scribe,
    verifier: HOSTS.find((host) => host !== scribe),
  };
}

function hostKey(host) {
  return host === 'claude-code' ? 'claude' : 'codex';
}

function promptFor(stage, payload, schema) {
  return [
    'You are one half of a subscription-only Claude Code and Codex deliberation.',
    'Do not request or use API keys. Work read-only. Return JSON only.',
    `Stage: ${stage}`,
    'For verify/reverify, copy artifactSha256 AND contentDigest from the exact supplied artifact. These identify the reviewed subject, not your findings.',
    'For proposal/critique/synthesis/revise, omit artifactSha256 and contentDigest: the native adapter computes them from your new content. Do not invent cryptographic hashes.',
    'For review, copy the supplied artifactSha256; omit contentDigest because the adapter hashes your fresh findings.',
    'Verification accept requires corrections []; changes requires at least one concrete correction.',
    `Response contract: ${JSON.stringify(schema)}`,
    JSON.stringify(payload),
  ].join('\n');
}

export async function runSubscriptionHost(host, stage, payload, { cwd = process.cwd(), timeoutMs = 900000, reasoningEffort = 'medium' } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('native host deadline must be a positive integer');
  if (!['medium', 'high'].includes(reasoningEffort)) throw new Error('Dual reasoning effort must be medium or high');
  const schema = nativeStageJsonSchema(stage);
  const prompt = promptFor(stage, payload, schema);
  if (prompt.length > NATIVE_PROMPT_BUDGET) return { ok:false, reason:'prompt-exceeds-evidence-budget' };
  const env = subscriptionOnlyEnv();
  const command = host === 'claude-code'
    ? {
        binary: 'claude',
        args: [
          '-p', '--output-format', 'json', '--permission-mode', 'manual', '--permission-prompts', 'none',
          '--safe-mode', '--restricted', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--json-schema', JSON.stringify(schema),
          '--tools', 'Read,Grep,Glob', '--no-session-persistence', '--effort', 'high',
          '--model', TOP_SUBSCRIPTION_MODELS['claude-code'],
        ],
      }
    : {
        binary: 'codex',
        args: [
          'exec', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--json',
          '--ignore-user-config', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'memories',
          '-c', 'project_doc_max_bytes=0', '-c', `projects.${JSON.stringify(fs.realpathSync(cwd))}.trust_level="untrusted"`,
          '-c', 'approval_policy="never"',
          '-m', TOP_SUBSCRIPTION_MODELS.codex, '-c', `model_reasoning_effort="${reasoningEffort}"`,
        ],
      };
  const startedAt = new Date().toISOString();
  const version = await spawnHost(command.binary, ['--version'], { cwd, env, timeout:Math.min(timeoutMs,15000), killSignal:'SIGKILL', stdio: ['pipe','pipe','pipe'] }, '');
  if (version.status !== 0 || version.outputTrusted !== true || !version.stdout.trim()) return { ok:false, reason:'native client version unavailable' };
  const result = await spawnHost(command.binary, command.args, { cwd, env, timeout:timeoutMs, killSignal:'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'] }, prompt);
  if (result.status !== 0 || result.outputTrusted !== true) {
    return {
      ok: false,
      error: result.stderr || `host exited without a status (${result.status})`,
      transport:{host,stage,startedAt,completedAt:new Date().toISOString(),prompt,result},
      timedOut: result.timedOut === true,
      reason: result.timedOut ? 'timeout' : /limit|quota|capacity|usage/i.test(result.stderr)
        ? 'capacity-limited'
        : 'host-failed',
    };
  }
  const completedAt = new Date().toISOString();
  const transport = { host, stage, startedAt, completedAt, prompt, result };
  try {
    const completion = readNativeCompletion(host, result.stdout, TOP_SUBSCRIPTION_MODELS[host]);
    const { threadId, sessionId, observedModels } = completion;
    const evidence = { schemaVersion:1, kind:'ruvnet-brain-native-review-evidence', nativeHost:host,
      clientVersion:version.stdout.trim(), requestedModel:TOP_SUBSCRIPTION_MODELS[host], modelIdentityClass:'requested-only',
      threadId, sessionId, completionStatus:'completed', status:result.status, signal:result.signal,
      startedAt, completedAt, prompt, stdout:result.stdout, stderr:result.stderr };
    const canonicalDigest = nativeReviewEvidenceDigest(evidence);
    const value = validateNativeStageValue(stage, completion.value);
    if (stage === 'review') value.execution = { nativeHost:host, subscriptionAuthenticated:true,
      invocationDigest:canonicalDigest, requestedModel:TOP_SUBSCRIPTION_MODELS[host],
      modelIdentityClass:'requested-only', threadId, sessionId };
    validateStageValue(stage, value);
    return { ok:true, value, extra:{ evidence, canonicalDigest, observedModels } };
  } catch (error) {
    return { ok:false, reason:'invalid-native-response', error:error.message, transport };
  }
}

export function deliberationMemoryStoreRequest(receipt, { now = Date.now } = {}) {
  const recordedAt = now();
  const value = {
    protocol: receipt.protocol,
    taskHash: receipt.taskHash,
    hosts: receipt.hosts,
    roles: receipt.roles,
    accepted: receipt.accepted === true,
    planAccepted: receipt.accepted === true,
    verifiedOutcome: false,
    recordedAt: new Date(recordedAt).toISOString(),
  };
  const key = `dual-deliberation-${recordedAt}-${receipt.taskHash.slice(0, 12)}`;
  return {
    tool: 'memory_store',
    name: 'memory_store',
    arguments: { key, value: JSON.stringify(value), namespace: 'ruvnet-brain' },
  };
}

function persistenceProof(proof, key) {
  return proof === true || (proof?.stored === true && proof?.verified === true && proof?.key === key);
}

export async function persistDeliberationReceipt(receipt, {
  now = Date.now,
  memoryStore,
} = {}) {
  const request = deliberationMemoryStoreRequest(receipt, { now });
  if (typeof memoryStore !== 'function') return request;
  try {
    return persistenceProof(await memoryStore(request), request.arguments.key);
  } catch {
    return false;
  }
}

function missingHosts(probes) {
  return HOSTS.filter((host) => !probes[hostKey(host)]?.eligible);
}

async function singleHostDraft(task, host, context) {
  const draft = await context.runHost(host, 'proposal', { task, cwd: context.cwd });
  if (draft.ok) {
    try { validateStageValue('proposal', draft.value); }
    catch (error) { return { status: 'unresolved', dual: false, missing: HOSTS.filter((candidate) => candidate !== host), error: error.message, learningPersisted: false, verifiedOutcome: false }; }
  }
  return {
    status: draft.ok ? 'degraded' : 'unavailable',
    dual: false,
    missing: HOSTS.filter((candidate) => candidate !== host),
    draft: draft.ok ? draft.value : undefined,
    learningPersisted: false,
    verifiedOutcome: false,
  };
}

export async function deliberate(task, options = {}) {
  const implementation = options.mode === 'implementation' || options.brief !== undefined;
  const cwd = options.cwd ?? process.cwd();
  if (options.mode !== undefined && !['review', 'implementation'].includes(options.mode)) throw new Error('unknown Dual mode');
  if (implementation) {
    try { assertDualBriefCurrent(options.brief, cwd); }
    catch (error) { return { status: 'unresolved', dual: false, planAccepted: false, verifiedOutcome: false, error: error.message }; }
  }
  const probes = options.probes ?? probeSubscriptionHosts();
  const executeHost = options.runHost ?? ((host, stage, payload) => (
    runSubscriptionHost(host, stage, payload, { cwd: options.cwd, reasoningEffort: options.reasoningEffort })
  ));
  const nativeEvidence = [], trace = [];
  const runHost = async (host, stage, payload) => {
    const input = implementation
      ? { ...payload, implementation: { brief:options.brief, briefDigest:digest(options.brief),
        contract:'Synthesis/revise artifact must be a schemaVersion 1 plan: briefDigest, adr, ddd, unresolved [], ordered jobs [{id,outcome,dependsOn,paths,goals,checks:[{id,command,args,timeoutMs,kind,proves,expectedOutput,optional report}]}], completion {jobId,clean,optional branch,root,preservedPaths,worktreeCount}. One owner per path; every goal and deletion mapped. Accepting a plan does not verify implementation.' } } : payload;
    const result = await executeHost(host, stage, input);
    if (result.ok) trace.push(structuredClone({host,stage,payload:input,value:result.value}));
    if (result.ok && result.extra?.evidence) nativeEvidence.push({host,stage,...result.extra});
    return result;
  };
  const eligibleHosts = HOSTS.filter((host) => probes[hostKey(host)]?.eligible);

  if (eligibleHosts.length === 0) {
    return {
      status: 'unavailable',
      dual: false,
      missing: missingHosts(probes),
      learningPersisted: false,
      verifiedOutcome: false,
    };
  }
  if (eligibleHosts.length === 1) {
    return singleHostDraft(task, eligibleHosts[0], { cwd, runHost });
  }

  const proposalResults = await Promise.all(HOSTS.map((host) => (
    runHost(host, 'proposal', { task, cwd })
  )));
  const successfulProposals = HOSTS.flatMap((host, index) => (
    proposalResults[index].ok ? (() => { try { return [{ host, value: validateStageValue('proposal', proposalResults[index].value) }]; } catch { return []; } })() : []
  ));
  if (successfulProposals.length < 2) {
    const host = successfulProposals[0]?.host;
    if (!host) {
      return {
        status: 'unavailable',
        dual: false,
        missing: HOSTS,
        learningPersisted: false,
        verifiedOutcome: false,
      };
    }
    return {
      status: 'degraded',
      dual: false,
      missing: HOSTS.filter((candidate) => candidate !== host),
      draft: successfulProposals[0].value,
      learningPersisted: false,
      verifiedOutcome: false,
    };
  }

  const proposals = Object.fromEntries(successfulProposals.map(({ host, value }) => [host, value]));
  const critiques = Object.fromEntries(await Promise.all(HOSTS.map(async (host) => {
    const other = HOSTS.find((candidate) => candidate !== host);
    const result = await runHost(host, 'critique', { task, proposal: proposals[other] });
    if (!result.ok) return [host, { unavailable: true }];
    try { return [host, validateStageValue('critique', result.value)]; }
    catch (error) { return [host, { unavailable: true, diagnostic: error.message }]; }
  })));
  if (HOSTS.some((host) => critiques[host]?.unavailable === true)) {
    return { status: 'unresolved', dual: true, roles: chooseRoles(task), critiques,
      error: 'both cross-critiques are required before synthesis', verifiedOutcome: false, learningPersisted: false };
  }
  const correctionLedger = correctionLedgerFromCritiques(critiques);
  const roles = chooseRoles(task);
  const synthesis = await runHost(roles.scribe, 'synthesis', { task, proposals, critiques, correctionLedger });
  if (!synthesis.ok) {
    return {
      status: 'unresolved',
      dual: true,
      roles,
      verifiedOutcome: false,
      learningPersisted: false,
    };
  }

  try { validateStageValue('synthesis', synthesis.value); if (implementation) validateDualPlan(synthesis.value.artifact, options.brief); }
  catch (error) { return { status: 'unresolved', dual: true, roles, error: error.message, verifiedOutcome: false, learningPersisted: false }; }

  let artifact = synthesis.value;
  let verification = await runHost(roles.verifier, 'verify', { task, artifact, correctionLedger });
  if (verification.ok) {
    try {
      const checked = validateStageValue('verify', verification.value);
      if (checked.artifactSha256 !== artifact.artifactSha256 || checked.contentDigest !== artifact.contentDigest) throw new Error('verification subject digest differs from synthesized artifact');
      verification.value = checked;
    } catch (error) { verification = { ok: false, error: error.message }; }
  }
  let verificationStage = 'verify';
  if (verification.ok && verification.value?.verdict === 'changes') {
    try { mergeVerifierCorrections(correctionLedger, verification.value, roles.verifier); }
    catch (error) { return {status:'unresolved',dual:true,roles,error:error.message,verifiedOutcome:false,learningPersisted:false}; }
    const revision = await runHost(roles.scribe, 'revise', {
      task,
      artifact,
      corrections: verification.value.corrections ?? [],
      correctionLedger,
    });
    if (revision.ok) {
      try { artifact = validateStageValue('revise', revision.value); if (implementation) validateDualPlan(artifact.artifact, options.brief); }
      catch { verification = { ok: true, value: { verdict: 'block', corrections: ['revision response is not substantive'] } }; }
      if (verification.value?.verdict !== 'block') {
        verification = await runHost(roles.verifier, 'reverify', { task, artifact,
          correctionLedger, resolutions: revision.value.resolutions ?? [] });
        verificationStage = 'reverify';
        if (verification.ok) {
          try {
            const checked = validateStageValue('reverify', verification.value);
            if (checked.artifactSha256 !== artifact.artifactSha256 || checked.contentDigest !== artifact.contentDigest) throw new Error('reverification subject digest differs from revised artifact');
            verification.value = checked;
          } catch (error) { verification = { ok: false, error: error.message }; }
        }
      }
    }
  }

  let accepted = false;
  if (verification.ok) {
    try {
      validateDeliberationTrace(trace, {roles, brief:implementation ? options.brief : undefined});
      if (implementation) { validateDualPlan(artifact.artifact, options.brief); assertDualBriefCurrent(options.brief, cwd, { plan:artifact.artifact }); }
      accepted = true;
    }
    catch { accepted = false; }
  }
  const receipt = {
    protocol: 'dual-host-deliberation-v1',
    taskHash: createHash('sha256').update(String(task)).digest('hex'),
    hosts: HOSTS,
    roles,
    accepted,
  };
  const learningPersistenceRequest = accepted
    ? deliberationMemoryStoreRequest(receipt, { now: options.now ?? Date.now })
    : undefined;
  let learningPersisted = false;
  if (accepted && typeof options.persist === 'function') {
    try {
      const persisted = await options.persist(learningPersistenceRequest, receipt);
      learningPersisted = persistenceProof(persisted, learningPersistenceRequest.arguments.key);
    } catch {
      learningPersisted = false;
    }
  }
  return {
    status: accepted ? 'accepted' : 'unresolved',
    dual: true,
    roles,
    artifact,
    verification: verification.ok ? verification.value : undefined,
    planAccepted: accepted,
    verifiedOutcome: false,
    executionAuthorized: false,
    nativeEvidence, requestedModels:TOP_SUBSCRIPTION_MODELS,
    ...(implementation ? { workflow: { brief: options.brief, completed: [] } } : {}),
    learningPersisted,
    ...(learningPersistenceRequest ? { learningPersistenceRequest } : {}),
  };
}

export async function main(argv = process.argv.slice(2), {
  deliberateFn = deliberate,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const operations = ['--activate', '--reapprove', '--verify-job', '--complete', '--workflow-status', '--recover-lock'];
  if (operations.includes(argv[0])) {
    try {
      const store = new DualWorkflowStore();
      let result;
      if (['--activate', '--reapprove'].includes(argv[0])) {
        if (argv.length !== 2) throw new Error('activation requires exactly one accepted Dual result file');
        result = await store.activate(JSON.parse(fs.readFileSync(argv[1], 'utf8')), { replaceActive: argv[0] === '--reapprove' });
      } else if (argv[0] === '--verify-job') {
        if (argv.length !== 2) throw new Error('verification requires exactly one job ID');
        result = await store.verifyJob(argv[1]);
      } else {
        const maintenance = argv[0] === '--recover-lock' && argv.length === 2 && argv[1] === '--controllers-stopped';
        if (argv.length !== 1 && !maintenance) throw new Error('unexpected workflow command argument');
        result = argv[0] === '--complete' ? await store.complete()
          : argv[0] === '--recover-lock' ? store.recoverLock({ controllersStopped: maintenance }) : store.current();
      }
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    } catch (error) { stderr.write(`Dual workflow refused: ${error.message}\n`); return 2; }
  }
  const args = [...argv];
  const briefIndex = args.indexOf('--brief');
  let brief;
  if (briefIndex !== -1) {
    try { brief = JSON.parse(fs.readFileSync(args[briefIndex + 1], 'utf8')); }
    catch { stderr.write('Dual --brief requires a readable reviewed-source JSON document\n'); return 64; }
    args.splice(briefIndex, 2);
  }
  const implementIndex = args.indexOf('--implement');
  const mode = implementIndex !== -1 || brief !== undefined ? 'implementation' : 'review';
  if (implementIndex !== -1) args.splice(implementIndex, 1);
  if (args.some(arg => arg.startsWith('--'))) { stderr.write('unknown Dual option\n'); return 64; }
  const task = args.join(' ').trim();
  if (!task) {
    stderr.write('Usage: dual-host-deliberation.mjs [--implement --brief reviewed-source.json] "<hard problem>"\n');
    return 64;
  }
  try {
    if (implementIndex !== -1 && new DualWorkflowStore().current()?.status === 'active') throw new Error('an implementation plan is already active; finish it or explicitly reapprove a replacement');
    const result = await deliberateFn(task, { mode, ...(brief !== undefined ? { brief } : {}) });
    if (implementIndex !== -1 && result.status === 'accepted') {
      await new DualWorkflowStore().activate(result);
      result.workflowPersisted = true;
    }
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'accepted' ? 0 : result.status === 'unavailable' ? 3 : 2;
  } catch (error) {
    stderr.write(`Dual-host deliberation failed: ${error.message}\n`);
    return 1;
  }
}

// Entry-point guard. Compares REALPATHS on both sides: path.resolve() normalizes a path but does
// NOT follow symlinks, while import.meta.url IS symlink-resolved by Node. Through a symlink (npm bin
// shims, wrapper scripts, and every os.tmpdir() path on macOS) the two sides disagree, so main()
// never runs -- and because nothing throws, the process exits 0. A silent exit 0 is indistinguishable
// from "ran, found nothing", which is how prepareCorpusCandidate once reported SUCCESS with no
// archive on disk. Reproduced live 2026-07-27; pinned by tests/unit/entrypoint-symlink.test.mjs.
function isDirectInvocation() {
  try {
    if (!process.argv[1]) return false;
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  process.exitCode = await main();
}
