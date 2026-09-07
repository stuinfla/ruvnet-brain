#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractZip } from '../kb/zip-extract.mjs';
import { evaluateCandidateReceipt } from './release-proof.mjs';
import { aggregateEvidence } from './release-evidence-aggregate.mjs';
import { payloadIdFor } from './release-payload.mjs';
import { canonicalJson } from './release-transaction.mjs';

const REPO = 'stuinfla/ruvnet-brain';
const WORKFLOW = '.github/workflows/release-candidate-preflight.yml';
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export function trustedQualificationRun(run, workflow, sha) {
  return positive(run?.id) && run.workflow_id === workflow.id && run.path === WORKFLOW
    && run.event === 'push' && run.head_sha === sha && /^release\/.+/.test(run.head_branch || '')
    && positive(run.repository?.id) && run.repository.full_name === REPO
    && run.head_repository?.id === run.repository.id && run.head_repository.full_name === REPO;
}
function trustedArtifact(artifact, run, name) {
  return positive(artifact?.id) && artifact.name === name && artifact.expired === false
    && /^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') && positive(artifact.size_in_bytes)
    && artifact.workflow_run?.id === run.id && artifact.workflow_run.head_sha === run.head_sha
    && artifact.workflow_run.head_branch === run.head_branch
    && artifact.workflow_run.repository_id === run.repository.id
    && artifact.workflow_run.head_repository_id === run.repository.id;
}
export function validateQualificationReceipt(receipt, { sha, run, artifact, requiredCheck }) {
  if (!['canonical-qa', 'integration'].includes(requiredCheck)) throw new Error('unsupported required check');
  if (receipt?.schemaVersion !== 1 || receipt.kind !== 'ruvnet-brain-qualified-candidate'
    || receipt.sha !== sha || receipt.runId !== run.id
    || canonicalJson(receipt.artifact) !== canonicalJson({ id: artifact.id, name: artifact.name,
      digest: artifact.digest, size: artifact.size_in_bytes })) throw new Error('qualification receipt provenance differs');
  const candidate = receipt.candidateReceipt;
  if (evaluateCandidateReceipt(candidate).verdict !== 'PASS' || candidate.sha !== sha) throw new Error('candidate seal failed');
  const manifest = receipt.payloadManifest;
  if (manifest?.schemaVersion !== 1 || manifest.candidateSha !== sha || manifest.version !== candidate.version
    || manifest.tag !== candidate.tag || !Array.isArray(manifest.members) || !manifest.members.length
    || new Set(manifest.members.map(({ name }) => name)).size !== manifest.members.length
    || manifest.members.some((m) => typeof m.name !== 'string' || path.basename(m.name) !== m.name
      || !positive(m.size) || !/^[a-f0-9]{64}$/.test(m.sha256 || ''))) throw new Error('payload manifest identity differs');
  const packageName = String(candidate.artifact.path).replaceAll('\\', '/').split('/').at(-1);
  if (!manifest.members.some((m) => m.name === packageName
    && m.sha256 === String(candidate.artifact.sha256).replace(/^sha256:/, ''))) throw new Error('candidate package is outside payload');
  const envelope = receipt.aggregateEnvelope;
  const rebuilt = aggregateEvidence({ sha, payloadId: payloadIdFor(manifest), leaves: envelope?.leaves });
  if (canonicalJson(rebuilt) !== canonicalJson(envelope)
    || envelope.leaves.some((leaf) => leaf.runId !== run.id)) throw new Error('aggregate evidence digest or run differs');
  return { verdict: 'PASS', sha, requiredCheck, runId: run.id, artifactId: artifact.id,
    payloadId: rebuilt.payloadId, evidenceDigest: rebuilt.evidenceDigest };
}
const api = (endpoint) => JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/${endpoint}`], {
  encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 }));
export async function downloadQualificationReceipt(artifact, fetchArchive = (id) => execFileSync('gh',
  ['api', `repos/${REPO}/actions/artifacts/${id}/zip`], { timeout: 60000, maxBuffer: 2 * 1024 * 1024 })) {
  if (artifact.size_in_bytes > 2 * 1024 * 1024) throw new Error('qualification receipt artifact oversized');
  const bytes = await fetchArchive(artifact.id);
  if (`sha256:${sha256(bytes)}` !== artifact.digest) throw new Error('qualification artifact digest differs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qualified-candidate-'));
  try {
    const zip = path.join(temp, 'receipt.zip');
    fs.writeFileSync(zip, bytes);
    const out = path.join(temp, 'contents');
    const extracted = await extractZip(zip, out);
    if (canonicalJson(extracted.entryNames) !== canonicalJson(['qualification-receipt.json'])) throw new Error('unexpected qualification artifact members');
    const file = path.join(out, 'qualification-receipt.json');
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('qualification receipt oversized');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
export async function checkQualifiedCandidate({ sha, requiredCheck, timeoutMs = 7200000, pollMs = 30000,
  readApi = api, readReceipt = downloadQualificationReceipt, now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !['canonical-qa', 'integration'].includes(requiredCheck)
    || !positive(timeoutMs) || timeoutMs > 7200000 || !positive(pollMs) || pollMs < 30000 || pollMs > 60000) throw new Error('invalid bounded qualification request');
  const workflow = await readApi('actions/workflows/release-candidate-preflight.yml');
  if (!positive(workflow.id) || workflow.path !== WORKFLOW) throw new Error('untrusted qualification workflow');
  const deadline = now() + timeoutMs;
  for (;;) {
    const list = await readApi(`actions/workflows/${workflow.id}/runs?event=push&head_sha=${sha}&per_page=100`);
    if (list.total_count > 100) throw new Error('qualification run listing truncated');
    const selected = (list.workflow_runs || []).filter((r) => trustedQualificationRun(r, workflow, sha)).sort((a,b) => b.id-a.id)[0];
    if (selected) {
      const run = await readApi(`actions/runs/${selected.id}`);
      if (run.id !== selected.id || !trustedQualificationRun(run, workflow, sha)) throw new Error('qualification run provenance changed');
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error(`qualification failed: ${run.conclusion}`);
        const listed = await readApi(`actions/runs/${run.id}/artifacts?per_page=100`);
        if (listed.total_count > 100) throw new Error('qualification artifact listing truncated');
        const select = async (name) => {
          const rows = (listed.artifacts || []).filter((a) => a.name === name);
          if (rows.length !== 1) throw new Error('missing or duplicate qualification artifact');
          const artifact = await readApi(`actions/artifacts/${rows[0].id}`);
          if (artifact.id !== rows[0].id || !trustedArtifact(artifact, run, name)) throw new Error('qualification artifact provenance changed');
          return artifact;
        };
        const artifact = await select(`release-candidate-${sha}`);
        const small = await select(`qualification-receipt-${sha}`);
        return validateQualificationReceipt(await readReceipt(small), { sha, run, artifact, requiredCheck });
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('timed out waiting for exact-SHA qualification');
    process.stderr.write('Waiting for exact-SHA release qualification\n');
    await pause(Math.min(pollMs, remaining));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_REPOSITORY !== REPO) throw new Error('unexpected qualification repository');
    const args = process.argv.slice(2), options = {};
    for (let i=0;i<args.length;i+=2) {
      if (!['--sha','--required-check','--timeout-ms','--poll-ms'].includes(args[i]) || !args[i+1]) throw new Error('invalid qualification arguments');
      options[args[i]] = args[i+1];
    }
    console.log(JSON.stringify(await checkQualifiedCandidate({ sha: options['--sha'], requiredCheck: options['--required-check'],
      ...(options['--timeout-ms'] ? {timeoutMs:Number(options['--timeout-ms'])} : {}),
      ...(options['--poll-ms'] ? {pollMs:Number(options['--poll-ms'])} : {}) })));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
