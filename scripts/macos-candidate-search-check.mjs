#!/usr/bin/env node
// macos-candidate-search-check.mjs — the preflight aggregate's acceptance of the exact-candidate macOS
// host searches (release-candidate-preflight.yml, "Require exact-candidate macOS search timing evidence").
//
// The searches run one macOS runner per host mode, so the aggregate receives three receipts of one leaf
// each. All three are required; each must be bound to the sealed candidate (SHA, payload, npm bytes),
// come from darwin, and carry its one mode. Every leaf then meets the same rule the single sequential
// receipt met before: completed, functional cited search, exit 0, first search within
// RELEASE_SEARCH_DEADLINE_MS, a grounding receipt, and a valid retrieval-canary receipt for the plan.
//
//   node scripts/macos-candidate-search-check.mjs --manifest FILE --dir DIR --plan FILE --coverage FILE --sha SHA
import fs from 'node:fs';
import path from 'node:path';
import { payloadIdFor } from './release-payload.mjs';
import { RELEASE_SEARCH_DEADLINE_MS } from './host-install-matrix.mjs';
import { readCandidateRetrieval } from './staged-host-verifier.mjs';
import { validateRetrievalCanaryReceipt } from './retrieval-canary.mjs';
import { CANDIDATE_LEAF_NAMES } from './candidate-host-evidence.mjs';
import { isDirectInvocation } from '../plugin/scripts/entrypoint.mjs';

export const MAC_CANDIDATE_MODES = Object.freeze(Object.values(CANDIDATE_LEAF_NAMES));
export const macReceiptFile = (dir, mode) => path.join(dir, `candidate-host-evidence-macos-${mode}.json`);

/** receipts: { 'claude-only': receipt, ... } as written by candidate-host-evidence.mjs --modes <leaf>. */
export function verifyMacCandidateSearch({ manifest, receipts, plan, candidateSha }) {
  const npm = manifest.members?.filter(({ role }) => role === 'npm') || [];
  const payloadId = payloadIdFor(manifest);
  if (npm.length !== 1) throw new Error('expected one sealed npm payload member');
  const leaves = [];
  for (const mode of MAC_CANDIDATE_MODES) {
    const receipt = receipts?.[mode];
    if (!receipt) throw new Error(`macOS host mode coverage is incomplete: no ${mode} receipt`);
    if (receipt.schemaVersion !== 1 || receipt.hostPlatform !== 'darwin'
      || receipt.sha !== candidateSha || receipt.sha !== manifest.candidateSha
      || receipt.payloadId !== payloadId || receipt.artifactSha256 !== npm[0].sha256
      || receipt.leaves?.length !== 1 || receipt.leaves[0]?.name !== mode) {
      throw new Error(`macOS ${mode} host receipt is not bound to the exact sealed candidate`);
    }
    leaves.push(receipt.leaves[0]);
  }
  for (const leaf of leaves) {
    if (leaf.sha !== candidateSha || leaf.payloadId !== payloadId || leaf.status !== 'completed'
      || leaf.conclusion !== 'success' || leaf.verdict !== 'PASS' || leaf.functionalSearch !== true
      || leaf.searchExit !== 0 || !Number.isFinite(leaf.searchMs) || leaf.searchMs < 0
      || leaf.searchMs > RELEASE_SEARCH_DEADLINE_MS || leaf.artifactSha256 !== npm[0].sha256
      || !leaf.grounding || ['repo', 'path', 'file', 'storedPath'].some((key) => !String(leaf.grounding[key] || '').trim())) {
      throw new Error(`macOS ${leaf.name} search failed exact timing or grounding acceptance`);
    }
    validateRetrievalCanaryReceipt(leaf.retrieval, { plan });
  }
  return { verdict: 'PASS', sourceSha: candidateSha, hostPlatform: 'darwin',
    searchMs: Object.fromEntries(leaves.map(({ name, searchMs }) => [name, searchMs])), deadlineMs: RELEASE_SEARCH_DEADLINE_MS };
}

if (isDirectInvocation(import.meta.url)) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
  const manifest = JSON.parse(fs.readFileSync(arg('--manifest'), 'utf8'));
  const retrieval = readCandidateRetrieval({ manifest, planFile: arg('--plan'), coverageFile: arg('--coverage') });
  const receipts = Object.fromEntries(MAC_CANDIDATE_MODES
    .filter((mode) => fs.existsSync(macReceiptFile(arg('--dir'), mode)))
    .map((mode) => [mode, JSON.parse(fs.readFileSync(macReceiptFile(arg('--dir'), mode), 'utf8'))]));
  console.log(JSON.stringify(verifyMacCandidateSearch({ manifest, receipts, plan: retrieval.plan, candidateSha: arg('--sha') })));
}
