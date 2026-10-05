/** Source-bound synthetic validation comparison; deliberately excludes database/host I/O. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createProgressionSnapshot, restoreProjectProgression, digestCanonical } from '../../plugin/scripts/project-progression-contract.mjs';

const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--baseline-module') || !process.argv.includes('--output')) {
  throw new Error('Require --baseline-module <unchanged contract module> --output <receipt.json>');
}
const baselinePath = path.resolve(flag('--baseline-module'));
const baseline = await import(pathToFileURL(baselinePath).href);
const currentPath = fileURLToPath(new URL('../../plugin/scripts/project-progression-contract.mjs', import.meta.url));
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sizes = (process.argv.includes('--sizes') ? flag('--sizes') : '100,400,1000').split(',').map(Number);
if (!sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 10_000)) throw new Error('sizes must be positive integers <= 10000');
const projectIdentity = { id: 'synthetic-validation', canonicalAgentDbPath: '/synthetic/project/.swarm/memory.db' };
const sourceIdentity = { checkoutPath: '/synthetic/project', worktreeId: 'primary', branch: 'main', head: 'a'.repeat(40),
  trackedDigest: 'b'.repeat(64), untrackedDigest: 'c'.repeat(64), dirtyTreeDigest: 'd'.repeat(64) };
const empty = Object.fromEntries(['plan', 'completed', 'inProgress', 'blockers', 'failures', 'decisions',
  'changedFiles', 'commands', 'proofArtifacts', 'untested', 'resumeConflicts'].map(k => [k, []]));
const receipt = { scope: 'Synthetic CPU-only complete-history validation; no native capture/restore deadline claim',
  node: process.version, platform: process.platform, arch: process.arch,
  sources: { baseline: { path: baselinePath, sha256: hash(baselinePath) }, candidate: { path: currentPath, sha256: hash(currentPath) } },
  workloads: [] };
for (const size of sizes) {
  const snapshots = [], observations = [];
  let parents = [];
  for (let sequence = 1; sequence <= size; sequence++) {
    observations.push({ id: `event-${sequence}`, occurredAt: '2026-10-05T00:00:00.000Z', trigger: 'PostToolUse',
      kind: 'tool-observation', source: 'host-observation', authoritative: false, outcome: 'success', exitCode: 0,
      intent: { action: 'verify', subjects: ['project memory'] }, tool: 'exec_command' });
    const snapshot = createProgressionSnapshot({ projectIdentity, sourceIdentity,
      hostIdentity: { host: 'codex', adapterVersion: 'synthetic-benchmark' }, sessionIdentity: 'synthetic',
      sequence, parentEventKeys: parents, occurredAt: '2026-10-05T00:00:00.000Z', trigger: 'PostToolUse', dedupId: `event-${sequence}`,
      completeProjectState: { ...empty, currentGoal: 'Preserve complete history', nextAction: 'Validate all evidence',
        acceptanceContract: { required: ['exact equality'] }, activeProcess: 'verification', activeStep: 'PostToolUse',
        observations: [...observations], commands: [...observations] } });
    snapshots.push(snapshot); parents = [snapshot.eventKey];
  }
  const run = (restore) => {
    const started = performance.now();
    const value = restore(snapshots, { expectedProjectIdentity: projectIdentity });
    return { ms: performance.now() - started, value };
  };
  const original = run(baseline.restoreProjectProgression);
  const candidate = run(restoreProjectProgression);
  if (JSON.stringify(original.value) !== JSON.stringify(candidate.value)) throw new Error('full restored result differs from baseline');
  // Check a historical mutation whose digest was not recomputed, not just the current head.
  const oldGoal = snapshots[0].completeProjectState.currentGoal;
  snapshots[0].completeProjectState.currentGoal = 'tampered historical state';
  const mutatedOriginal = baseline.restoreProjectProgression(snapshots, { expectedProjectIdentity: projectIdentity });
  const mutatedCandidate = restoreProjectProgression(snapshots, { expectedProjectIdentity: projectIdentity });
  if (JSON.stringify(mutatedOriginal) !== JSON.stringify(mutatedCandidate) || mutatedCandidate.ok) {
    throw new Error('historical mutation negative semantics differ');
  }
  snapshots[0].completeProjectState.currentGoal = oldGoal;
  receipt.workloads.push({ snapshots: size, bytes: snapshots.reduce((n, s) => n + Buffer.byteLength(JSON.stringify(s)), 0),
    baselineMs: original.ms, candidateMs: candidate.ms, resultDigest: digestCanonical(candidate.value),
    fullResultEqual: true, historicalMutationRejected: true, observations: candidate.value.state.observations.length,
    commands: candidate.value.state.commands.length, peakRssKiB: process.resourceUsage().maxRSS });
  fs.writeFileSync(path.resolve(flag('--output')), JSON.stringify(receipt, null, 2));
  process.stdout.write(`${JSON.stringify(receipt.workloads.at(-1))}\n`);
}
