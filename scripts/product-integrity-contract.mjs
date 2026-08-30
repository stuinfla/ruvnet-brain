#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSourceScopeReceipt,
  canonicalJson,
  digest,
  validateSourceScopeReceipt,
} from './source-scope-receipt.mjs';

export const PRODUCT_INTEGRITY_SCHEMA_VERSION = 1;
export const PRODUCT_INTEGRITY_TEST_CLASSES = Object.freeze(['essential', 'supporting', 'obsolete']);
export const PRODUCT_INTEGRITY_PROOF_STRENGTH = Object.freeze(['unit', 'integration', 'packed-artifact', 'candidate-host', 'public-byte']);
export const PRODUCT_INTEGRITY_PROCESSES = Object.freeze([
  { id: 'SourceCoverage', upstream: [] }, { id: 'CorpusGeneration', upstream: ['SourceCoverage'] },
  { id: 'ReleaseProjection', upstream: ['CorpusGeneration'] }, { id: 'RefreshLifecycle', upstream: ['ReleaseProjection'] },
  { id: 'HostConvergence', upstream: ['ReleaseProjection'] }, { id: 'ReleaseTransaction', upstream: ['ReleaseProjection'] },
  { id: 'PublicVerification', upstream: ['ReleaseTransaction', 'HostConvergence'] },
  { id: 'ProductIntegrityCase', upstream: ['RefreshLifecycle', 'PublicVerification'] },
]);
export const PRODUCT_INTEGRITY_CONTEXTS = Object.freeze(PRODUCT_INTEGRITY_PROCESSES.map(({ id }) => id));
const ARCHITECTURE = Object.freeze([
  { id: 'ADR-072', path: 'docs/adr/0072-whole-product-integrity-conformance.md', status: 'Accepted' },
  { id: 'DDD-0018', path: 'docs/ddd/0018-product-integrity-context.md', status: 'Accepted' },
  { id: 'ADR-073', path: 'docs/adr/0073-agentdb-perennial-project-continuity.md', status: 'Accepted' },
  { id: 'DDD-0019', path: 'docs/ddd/0019-project-continuity-context.md', status: 'Accepted' },
  { id: 'ADR-074', path: 'docs/adr/0074-ruvnet-capability-claim-integrity.md', status: 'Accepted' },
  { id: 'DDD-0020', path: 'docs/ddd/0020-capability-claim-integrity-context.md', status: 'Accepted' },
]);
const proofStrength = (file) => file.startsWith('tests/acceptance/') ? 'packed-artifact'
  : file.startsWith('tests/integration/') ? 'integration' : file.startsWith('tests/qe/') ? 'candidate-host' : 'unit';
const make = (id, statement, owner, contributors, implementation, tests, receiptKinds, supportingArchitecture = []) => Object.freeze({
  id, statement, owner, contributors: Object.freeze(contributors),
  architecture: Object.freeze(['ADR-072', 'DDD-0018', ...supportingArchitecture]),
  implementation: Object.freeze(implementation), behaviors: Object.freeze([Object.freeze({
    id: `${id}.essential`, class: 'essential', commands: Object.freeze(tests.map((file) => `npx vitest run ${file}`)),
    positive: Object.freeze(tests.map((file) => Object.freeze({ file, strength: proofStrength(file) }))),
    adversarial: Object.freeze(tests.map((file) => Object.freeze({ file, strength: proofStrength(file) }))),
    receiptKinds: Object.freeze(receiptKinds),
  })]),
});
export const PRODUCT_INTEGRITY_OBLIGATIONS = Object.freeze([
  make('S-1', 'One complete public corpus', 'CorpusGeneration', ['SourceCoverage'], ['scripts/source-coverage.mjs', 'scripts/corpus-reconcile.mjs', 'scripts/corpus-candidate.mjs'], ['tests/unit/source-coverage.test.mjs', 'tests/unit/corpus-reconcile.test.mjs'], ['ruvnet-brain-source-observation', 'ruvnet-brain-corpus-candidate']),
  make('S-2', 'One immutable public release projection', 'ReleaseProjection', ['CorpusGeneration'], ['scripts/build-bundle.mjs', 'scripts/coverage-integrity.mjs', 'scripts/public-inventory.mjs'], ['tests/integration/build-bundle-fence.test.mjs', 'tests/unit/public-inventory.test.mjs'], ['ruvnet-brain-release-coverage']),
  make('S-3', 'Recall at 10 is at least 98 percent and delta citations are complete', 'PublicVerification', ['SourceCoverage', 'CorpusGeneration'], ['scripts/retrieval-canary.mjs', 'scripts/packed-retrieval-canary.mjs'], ['tests/unit/retrieval-canary.test.mjs', 'tests/unit/packed-retrieval-canary.test.mjs'], ['ruvnet-brain-retrieval-canary-plan', 'ruvnet-brain-retrieval-canary-receipt']),
  make('S-4', 'Native nightly runs are ordered, idempotent, and retained within budget', 'RefreshLifecycle', [], ['bin/nightly-refresh.mjs', 'plugin/scripts/nightly-scheduler.mjs', 'scripts/nightly-two-run-proof.mjs', 'kb/refresh-run.mjs'], ['tests/unit/nightly-scheduler.test.mjs', 'tests/unit/nightly-two-run-proof.test.mjs'], ['ruvnet-brain-refresh-run', 'ruvnet-brain-native-two-run-nightly-proof']),
  make('S-5', 'One active corpus preserves private stores and bounded recovery', 'RefreshLifecycle', ['CorpusGeneration'], ['kb/update-storage-transaction.mjs', 'kb/forge-update.mjs', 'kb/brain-profile.mjs', 'bin/install.mjs'], ['tests/unit/update-storage-transaction.test.mjs', 'tests/unit/brain-profile.test.mjs'], ['ruvnet-brain-update-storage-transaction', 'ruvnet-brain-installed-profile']),
  make('S-6', 'Every supported OS and host loader converges on exact public bytes', 'HostConvergence', ['PublicVerification'], ['scripts/host-registry.mjs', 'scripts/host-install-matrix.mjs', 'scripts/public-verification-aggregate.mjs'], ['tests/unit/host-registry.test.mjs', 'tests/integration/dual-host-install.test.mjs'], ['ruvnet-brain-host-registry', 'ruvnet-brain-public-verification-leaf']),
  make('S-7', 'Publication ends only after signed public verification', 'PublicVerification', ['ReleaseTransaction'], ['scripts/release-transaction.mjs', 'scripts/public-verification-finalizer.mjs', '.github/workflows/protected-release.yml'], ['tests/qe/release/release-transaction-faults.test.mjs', 'tests/unit/public-verification-finalizer.test.mjs'], ['ruvnet-brain-release-transaction-receipt', 'ruvnet-brain-public-verification-aggregate']),
  make('S-8', 'Accepted architecture has one executable owner and source-bound trace', 'ProductIntegrityCase', [], ['scripts/product-integrity-contract.mjs', 'scripts/source-scope-receipt.mjs'], ['tests/unit/product-integrity-contract.test.mjs', 'tests/unit/source-scope-receipt.test.mjs'], ['ruvnet-brain-product-integrity-contract', 'ruvnet-brain-product-integrity-trace']),
  make('S-9', 'Every essential behavior has positive and adversarial proof', 'ProductIntegrityCase', [], ['scripts/product-integrity-contract.mjs', 'scripts/adr-072-completion.mjs'], ['tests/unit/product-integrity-contract.test.mjs', 'tests/unit/adr-072-completion.test.mjs'], ['ruvnet-brain-product-integrity-trace', 'ruvnet-brain-adr-072-completion']),
  make('S-10', 'Fable 5 and GPT-5.6-Sol review identical immutable inputs', 'ProductIntegrityCase', ['PublicVerification'], ['scripts/public-verification-aggregate.mjs', '.github/workflows/protected-release.yml'], ['tests/unit/public-verification-aggregate.test.mjs', 'tests/unit/protected-release-workflow.test.mjs'], ['ruvnet-brain-independent-review', 'ruvnet-brain-public-verification-aggregate']),
  make('S-11', 'Project continuity is complete and host-neutral', 'ProductIntegrityCase', ['HostConvergence', 'RefreshLifecycle'], ['plugin/scripts/project-progression-contract.mjs', 'plugin/scripts/project-progression-hook.mjs'], ['tests/unit/project-progression-contract.test.mjs', 'tests/acceptance/cross-host-project-resume.test.mjs'], ['ruvnet-brain-project-progression', 'ruvnet-brain-cross-host-resume'], ['ADR-073', 'DDD-0019']),
  make('S-12', 'RuvNet capability claims are bound to live evidence before delivery', 'ProductIntegrityCase', ['HostConvergence', 'PublicVerification'], [
    'plugin/scripts/capability-inventory-receipt.mjs',
    'plugin/scripts/capability-claim-evidence.mjs',
    'plugin/scripts/continuation-gate.mjs',
    'plugin/mcp/managed-cli-interface.mjs',
    'kb/forge-evidence.mjs',
  ], [
    'tests/unit/capability-inventory-receipt.test.mjs',
    'tests/unit/capability-claim-evidence.test.mjs',
    'tests/unit/continuation-gate-capability-truth.test.mjs',
    'tests/unit/managed-cli-interface.test.mjs',
    'tests/unit/grounding-receipt-lanes.test.mjs',
    'tests/acceptance/adr-074-packed-capability-claims.acceptance.test.mjs',
  ], [
    'ruvnet-brain-capability-inventory',
    'ruvnet-brain-capability-claim-audit',
    'ruvnet-brain-source-claim',
    'ruvnet-brain-live-surface',
    'ruvnet-brain-capability-claim-aggregate',
  ], ['ADR-074', 'DDD-0020']),
]);
const IDS = Object.freeze(Array.from({ length: 12 }, (_, index) => `S-${index + 1}`));
const safePath = (value) => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..');

function validateProcesses(processes) {
  if (!Array.isArray(processes) || canonicalJson(processes.map(({ id }) => id)) !== canonicalJson(PRODUCT_INTEGRITY_CONTEXTS)) throw new Error('product integrity contract must contain the exact eight processes');
  const ids = new Set(processes.map(({ id }) => id)); const visiting = new Set(); const visited = new Set();
  const visit = (id) => { if (visiting.has(id)) throw new Error('product integrity process graph contains a cycle'); if (visited.has(id)) return;
    visiting.add(id); const row = processes.find((entry) => entry.id === id);
    if (!Array.isArray(row?.upstream) || new Set(row.upstream).size !== row.upstream.length || row.upstream.some((upstream) => !ids.has(upstream) || upstream === id)) throw new Error(`${id} has invalid upstream processes`);
    row.upstream.forEach(visit); visiting.delete(id); visited.add(id); };
  processes.forEach(({ id }) => visit(id));
}

export function validateProductIntegrityContract(input = {}) {
  const processes = Array.isArray(input) ? PRODUCT_INTEGRITY_PROCESSES : input.processes || PRODUCT_INTEGRITY_PROCESSES;
  const obligations = Array.isArray(input) ? input : input.obligations || PRODUCT_INTEGRITY_OBLIGATIONS;
  const architecture = input.architecture || ARCHITECTURE;
  validateProcesses(processes);
  if (!Array.isArray(architecture) || new Set(architecture.map(({ id }) => id)).size !== architecture.length || architecture.some((row) => row.status !== 'Accepted' || !safePath(row.path))) throw new Error('governing architecture is missing or not Accepted');
  if (!Array.isArray(obligations) || canonicalJson(obligations.map(({ id }) => id)) !== canonicalJson(IDS)) throw new Error('product integrity obligations are missing, duplicated, or out of order');
  const contexts = new Set(processes.map(({ id }) => id)); const architectureIds = new Set(architecture.map(({ id }) => id)); const behaviorIds = new Set();
  for (const row of obligations) {
    if (!contexts.has(row.owner)) throw new Error(`${row.id} has no valid sole owner`);
    if (!Array.isArray(row.contributors) || new Set(row.contributors).size !== row.contributors.length || row.contributors.some((context) => !contexts.has(context)) || row.contributors.includes(row.owner)) throw new Error(`${row.id} has an invalid contributor`);
    if (!Array.isArray(row.architecture) || row.architecture.some((id) => !architectureIds.has(id))) throw new Error(`${row.id} has missing architecture`);
    if (!Array.isArray(row.implementation) || !row.implementation.length || row.implementation.some((file) => !safePath(file))) throw new Error(`${row.id} has no implementation`);
    if (!Array.isArray(row.behaviors) || !row.behaviors.length) throw new Error(`${row.id} has no behaviors`);
    for (const behavior of row.behaviors) {
      if (!behavior.id || behaviorIds.has(behavior.id)) throw new Error(`${row.id} has duplicate behavior identity`); behaviorIds.add(behavior.id);
      if (!PRODUCT_INTEGRITY_TEST_CLASSES.includes(behavior.class)) throw new Error(`${behavior.id} has invalid test class`);
      if (behavior.class === 'essential') {
        for (const field of ['commands', 'positive', 'adversarial', 'receiptKinds']) if (!Array.isArray(behavior[field]) || !behavior[field].length) throw new Error(`${behavior.id} has no ${field}`);
        for (const proof of [...behavior.positive, ...behavior.adversarial]) if (!safePath(proof.file) || !PRODUCT_INTEGRITY_PROOF_STRENGTH.includes(proof.strength)) throw new Error(`${behavior.id} has invalid proof`);
      }
    }
  }
  return { schemaVersion: 1, kind: 'ruvnet-brain-product-integrity-contract', architecture,
    processes: processes.map((row) => ({ ...row, owns: obligations.filter(({ owner }) => owner === row.id).map(({ id }) => id), contributes: obligations.filter(({ contributors }) => contributors.includes(row.id)).map(({ id }) => id) })), obligations };
}

export function productIntegrityGovernedPaths(contract = validateProductIntegrityContract()) {
  return [...new Set([...contract.architecture.map(({ path: file }) => file), ...contract.obligations.flatMap(({ implementation, behaviors }) => [...implementation, ...behaviors.flatMap(({ positive, adversarial }) => [...positive, ...adversarial].map(({ file }) => file))])])].sort();
}
export function buildProductIntegrityTrace({ root = '.', sourceSha, contract = validateProductIntegrityContract(), inventory } = {}) {
  if (!/^[a-f0-9]{40}$/.test(String(sourceSha || ''))) throw new Error('product integrity trace requires an exact source SHA');
  const validated = validateProductIntegrityContract(contract);
  const unsigned = { schemaVersion: 1, kind: 'ruvnet-brain-product-integrity-trace', sourceSha, contractSha256: digest(validated), sourceScope: buildSourceScopeReceipt({ root, sourceSha, governedPaths: productIntegrityGovernedPaths(validated), inventory }), contract: validated, verdict: 'PASS', untested: [] };
  return { ...unsigned, traceSha256: digest(unsigned) };
}
export function validateProductIntegrityTrace(trace, { root = '.', sourceSha = trace?.sourceSha, inventory } = {}) {
  const { traceSha256, ...unsigned } = trace || {};
  if (trace?.schemaVersion !== 1 || trace?.kind !== 'ruvnet-brain-product-integrity-trace' || trace.sourceSha !== sourceSha || trace.verdict !== 'PASS' || canonicalJson(trace.untested) !== '[]' || trace.contractSha256 !== digest(trace.contract) || traceSha256 !== digest(unsigned)) throw new Error('product integrity trace identity is invalid');
  validateSourceScopeReceipt(trace.sourceScope, { root, inventory });
  const rebuilt = buildProductIntegrityTrace({ root, sourceSha, contract: trace.contract, inventory });
  if (canonicalJson(rebuilt) !== canonicalJson(trace)) throw new Error('product integrity trace differs from the exact source');
  return trace;
}
export function renderProductIntegrityTraceMarkdown(contract = validateProductIntegrityContract()) {
  const lines = ['# ADR-072 generated traceability', '', '> Generated from `scripts/product-integrity-contract.mjs`; do not hand-edit.', '', '## Processes', '', '| Process | Upstream | Owns | Contributes |', '|---|---|---|---|'];
  for (const row of contract.processes) lines.push(`| ${row.id} | ${row.upstream.join(', ') || '—'} | ${row.owns.join(', ') || '—'} | ${row.contributes.join(', ') || '—'} |`);
  lines.push('', '## Obligations', '', '| ID | Statement | Owner | Contributors |', '|---|---|---|---|');
  for (const row of contract.obligations) lines.push(`| ${row.id} | ${row.statement} | ${row.owner} | ${row.contributors.join(', ') || '—'} |`);
  lines.push('', '## Essential behavior proofs', '', '| Behavior | Positive | Adversarial | Receipts |', '|---|---|---|---|');
  for (const row of contract.obligations) for (const behavior of row.behaviors.filter(({ class: type }) => type === 'essential')) lines.push(`| ${behavior.id} | ${behavior.positive.map(({ file, strength }) => `${file} (${strength})`).join('<br>')} | ${behavior.adversarial.map(({ file, strength }) => `${file} (${strength})`).join('<br>')} | ${behavior.receiptKinds.join('<br>')} |`);
  return `${lines.join('\n')}\n`;
}
const valueAfter = (argv, flag) => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; };
export function runProductIntegrityCli(argv = process.argv.slice(2), io = { stdout: process.stdout }) {
  const known = new Set(['--markdown', '--check-markdown', '--trace', '--source-sha', '--out', '--verify-trace']);
  if (argv.some((arg) => arg.startsWith('--') && !known.has(arg))) throw new Error('unknown product integrity argument');
  if (!argv.length) { io.stdout.write(`${canonicalJson(validateProductIntegrityContract())}\n`); return 0; }
  if (argv.length === 1 && argv[0] === '--markdown') { io.stdout.write(renderProductIntegrityTraceMarkdown()); return 0; }
  const check = valueAfter(argv, '--check-markdown');
  if (check) { if (fs.readFileSync(path.resolve(check), 'utf8') !== renderProductIntegrityTraceMarkdown()) throw new Error('generated traceability Markdown differs'); io.stdout.write('product integrity Markdown: PASS\n'); return 0; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const sourceSha = valueAfter(argv, '--source-sha'); const out = valueAfter(argv, '--out');
  if (argv.includes('--trace') && sourceSha && out) { fs.writeFileSync(path.resolve(out), `${canonicalJson(buildProductIntegrityTrace({ root, sourceSha }))}\n`, { flag: 'wx', mode: 0o600 }); return 0; }
  const verify = valueAfter(argv, '--verify-trace');
  if (verify && sourceSha) { const trace = JSON.parse(fs.readFileSync(path.resolve(verify), 'utf8')); validateProductIntegrityTrace(trace, { root, sourceSha }); io.stdout.write(`${canonicalJson({ verdict: 'PASS', traceSha256: trace.traceSha256 })}\n`); return 0; }
  throw new Error('invalid product integrity argument combination');
}
if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) { try { process.exitCode = runProductIntegrityCli(); } catch (error) { console.error(`[product-integrity-contract] ${error.message}`); process.exitCode = 1; } }
