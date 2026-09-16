#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeSubscriptionHosts, subscriptionOnlyEnv } from './subscription-hosts.mjs';

const HOSTS = Object.freeze(['claude-code', 'codex']);
// Top subscription models verified on the native hosts on 2026-09-10.
// Keep these explicit: an implicit host default silently weakens the dual review.
export const TOP_SUBSCRIPTION_MODELS = Object.freeze({
  'claude-code': 'claude-fable-5-1',
  codex: 'gpt-6-astra',
});
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

function promptFor(stage, payload) {
  return [
    'You are one half of a subscription-only Claude Code and Codex deliberation.',
    'Do not request or use API keys. Work read-only. Return JSON only.',
    `Stage: ${stage}`,
    JSON.stringify(payload),
  ].join('\n');
}

function parseCodexJsonl(stdout) {
  const messages = String(stdout).trim().split('\n').flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.type === 'item.completed' && value.item?.type === 'agent_message'
        ? [value.item.text]
        : [];
    } catch {
      return [];
    }
  });
  return messages.at(-1) ?? stdout;
}

function parseHostValue(host, stdout) {
  const raw = host === 'claude-code'
    ? (() => {
        try {
          const envelope = JSON.parse(stdout);
          return envelope.result ?? envelope;
        } catch {
          return stdout;
        }
      })()
    : parseCodexJsonl(stdout);
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

const STAGE_SCHEMAS = Object.freeze({
  proposal: { required: ['schemaVersion', 'stage', 'artifactSha256', 'proposal'], optional: ['task', 'plan', 'adr', 'ddd', 'qe', 'artifact', 'host'] },
  critique: { required: ['schemaVersion', 'stage', 'artifactSha256', 'findings'], optional: ['corrections', 'risks', 'verdict', 'host'] },
  synthesis: { required: ['schemaVersion', 'stage', 'artifactSha256', 'artifact'], optional: ['adr', 'ddd', 'qe', 'unresolved', 'host'] },
  revise: { required: ['schemaVersion', 'stage', 'artifactSha256', 'artifact'], optional: ['adr', 'ddd', 'qe', 'unresolved', 'host'] },
  verify: { required: ['schemaVersion', 'stage', 'artifactSha256', 'verdict', 'corrections'], optional: ['findings'] },
  reverify: { required: ['schemaVersion', 'stage', 'artifactSha256', 'verdict', 'corrections'], optional: ['findings'] },
});

export function validateStageValue(stage, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.text !== undefined) {
    throw new Error(`${stage} response is not a structured stage object`);
  }
  const schema = STAGE_SCHEMAS[stage];
  if (!schema) throw new Error(`${stage} response has an unknown stage`);
  const allowed = new Set([...schema.required, ...schema.optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${stage} response has unknown field: ${unknown.sort()[0]}`);
  const missing = schema.required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${stage} response is missing ${missing}`);
  if (value.schemaVersion !== 1 || value.stage !== stage || !/^[a-f0-9]{64}$/.test(String(value.artifactSha256))) {
    throw new Error(`${stage} response identity is invalid`);
  }
  if (['verify', 'reverify'].includes(stage)) {
    if (!['accept', 'changes', 'block'].includes(value.verdict)) throw new Error(`${stage} verdict is invalid`);
    if (!Array.isArray(value.corrections) || value.corrections.some((correction) => !correction
      || typeof correction !== 'object' || !/^[a-z0-9][a-z0-9._-]*$/i.test(String(correction.id || ''))
      || typeof correction.text !== 'string' || !correction.text.trim())) {
      throw new Error(`${stage} corrections are invalid`);
    }
  }
  return value;
}

function spawnHost(binary, args, options, input = '') {
  return new Promise((resolve) => {
    const child = spawn(binary, args, options);
    let stdout = '';
    let stderr = '';
    let inputError = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => {
      inputError = error;
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      try { child.kill(); } catch { /* child may already be gone */ }
    });
    child.on('error', (error) => finish({ status: null, stdout, stderr: error.message, error }));
    try {
      child.stdin.end(input);
    } catch (error) {
      inputError = error;
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      try { child.kill(); } catch { /* child may already be gone */ }
    }
    child.on('close', (status) => finish({ status, stdout, stderr, error: inputError }));
  });
}

export async function runSubscriptionHost(host, stage, payload, { cwd = process.cwd() } = {}) {
  const prompt = promptFor(stage, payload);
  const env = subscriptionOnlyEnv();
  const command = host === 'claude-code'
    ? {
        binary: 'claude',
        args: [
          '-p', '--output-format', 'json', '--permission-mode', 'plan',
          '--tools', 'Read,Grep,Glob', '--no-session-persistence', '--effort', 'high',
          '--model', TOP_SUBSCRIPTION_MODELS['claude-code'],
        ],
      }
    : {
        binary: 'codex',
        args: [
          'exec', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--json',
          '-m', TOP_SUBSCRIPTION_MODELS.codex, '-c', 'model_reasoning_effort="medium"',
        ],
      };
  const result = await spawnHost(command.binary, command.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }, prompt);
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr || `host exited without a status (${result.status})`,
      reason: /limit|quota|capacity|usage/i.test(result.stderr)
        ? 'capacity-limited'
        : 'host-failed',
    };
  }
  return { ok: true, value: parseHostValue(host, result.stdout) };
}

export function deliberationMemoryStoreRequest(receipt, { now = Date.now } = {}) {
  const recordedAt = now();
  const value = {
    protocol: receipt.protocol,
    taskHash: receipt.taskHash,
    hosts: receipt.hosts,
    roles: receipt.roles,
    accepted: receipt.accepted === true,
    verifiedOutcome: receipt.accepted === true,
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
  const probes = options.probes ?? probeSubscriptionHosts();
  const runHost = options.runHost ?? ((host, stage, payload) => (
    runSubscriptionHost(host, stage, payload, { cwd: options.cwd })
  ));
  const cwd = options.cwd ?? process.cwd();
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
  const roles = chooseRoles(task);
  const synthesis = await runHost(roles.scribe, 'synthesis', { task, proposals, critiques });
  if (!synthesis.ok) {
    return {
      status: 'unresolved',
      dual: true,
      roles,
      verifiedOutcome: false,
      learningPersisted: false,
    };
  }

  try { validateStageValue('synthesis', synthesis.value); }
  catch (error) { return { status: 'unresolved', dual: true, roles, error: error.message, verifiedOutcome: false, learningPersisted: false }; }

  let artifact = synthesis.value;
  let verification = await runHost(roles.verifier, 'verify', { task, artifact });
  let verificationStage = 'verify';
  if (verification.ok && verification.value?.verdict === 'changes') {
    const revision = await runHost(roles.scribe, 'revise', {
      task,
      artifact,
      corrections: verification.value.corrections ?? [],
    });
    if (revision.ok) {
      try { artifact = validateStageValue('revise', revision.value); }
      catch { verification = { ok: true, value: { verdict: 'block', corrections: ['revision response is not substantive'] } }; }
      if (verification.value?.verdict !== 'block') {
        verification = await runHost(roles.verifier, 'reverify', { task, artifact });
        verificationStage = 'reverify';
      }
    }
  }

  let accepted = false;
  if (verification.ok) {
    try { accepted = validateStageValue(verificationStage, verification.value).verdict === 'accept'; }
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
    verifiedOutcome: accepted,
    learningPersisted,
    ...(learningPersistenceRequest ? { learningPersistenceRequest } : {}),
  };
}

export async function main(argv = process.argv.slice(2), {
  deliberateFn = deliberate,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const task = argv.join(' ').trim();
  if (!task) {
    stderr.write('Usage: dual-host-deliberation.mjs "<hard problem>"\n');
    return 64;
  }
  try {
    const result = await deliberateFn(task);
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
