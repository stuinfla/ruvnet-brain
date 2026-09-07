import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { buildCandidateHostEvidence } from '../../scripts/candidate-host-evidence.mjs';
import { stagedHostVerifier } from '../../scripts/staged-host-verifier.mjs';
import { runHostMatrixAsync } from '../../scripts/host-install-matrix.mjs';
import { createPayloadManifest } from '../../scripts/release-payload.mjs';
import { sha256File } from '../../scripts/coverage-integrity.mjs';
import { candidateRetrievalFixture } from '../fixtures/candidate-retrieval-fixture.mjs';
import { writeStoredZip } from '../helpers/zip-fixture.mjs';
const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-host-evidence-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'package')); fs.writeFileSync(path.join(root, 'package', 'candidate.txt'), 'sealed package');
  fs.writeFileSync(path.join(root, 'bundle.txt'), 'sealed corpus');
  const packagePath = path.join(root, 'candidate.tgz'), bundlePath = path.join(root, 'bundle.zip');
  execFileSync('tar', ['-czf', './candidate.tgz', 'package'], { cwd: root });
  writeStoredZip({ archiveFile: bundlePath, entries: [{ name: 'bundle.txt', data: 'sealed corpus' }] });
  const candidate = candidateRetrievalFixture({ packageSha256: sha256File(packagePath), archiveSha256: sha256File(bundlePath) });
  const manifest = createPayloadManifest({ version: '9.9.9', tag: 'v9.9.9', candidateSha: candidate.sourceSha,
    producer: { runId: 'fixture' }, members: [{ role: 'npm', name: 'candidate.tgz', file: packagePath },
      { role: 'bundle', name: 'bundle.zip', file: bundlePath }] });
  const manifestFile = path.join(root, 'manifest.json'), planFile = path.join(root, 'plan.json'), coverageFile = path.join(root, 'coverage.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest)); fs.writeFileSync(planFile, JSON.stringify(candidate.plan));
  fs.writeFileSync(coverageFile, candidate.coverageBytes);
  return { root, candidate, args: { manifestFile, packagePath, bundlePath, planFile, coverageFile } };
}
it.each(['valid', 'body-spoof', 'legacy-text'])('executes %s through staged extraction, real RPC, and cleanup', async (mode) => {
  const f = fixture(); let prepared, observed;
  const produced = buildCandidateHostEvidence(f.args, { createVerifier: (options) => stagedHostVerifier(options, {
    runMatrix: async (matrix) => {
      prepared = matrix.temp;
      expect(fs.readFileSync(path.join(matrix.packageRoot, 'candidate.txt'), 'utf8')).toBe('sealed package');
      expect(fs.readFileSync(path.join(matrix.packageRoot, 'dist/ruvnet-brain/bundle.txt'), 'utf8')).toBe('sealed corpus');
      observed = await runHostMatrixAsync({ ...matrix, locate: (name) => `/tools/${name}`,
        runCommand: async (_cmd, _args, { env }) => {
          fs.mkdirSync(env.RUVNET_BRAIN_KB, { recursive: true });
          fs.writeFileSync(path.join(env.RUVNET_BRAIN_KB, 'fixture-plan.json'), JSON.stringify(f.candidate.plan));
          env.CANARY_TRACE = path.join(f.root, 'trace.jsonl');
          env.CANARY_FIXTURE_MODE = mode;
          for (const [store, row] of Object.entries(f.candidate.passages)) fs.writeFileSync(path.join(env.RUVNET_BRAIN_KB, `${store}.passages.jsonl`), JSON.stringify(row) + '\n');
          return { status: 0, stdout: 'smoke', stderr: '' };
        },
        resolveMcpServer: () => path.resolve('tests/fixtures/candidate-canary-mcp.mjs'),
        verifyGrounding: async () => ({ grounded: true, receipt: { repo: 'new', path: 'src/new.mjs', file: 'new.passages.jsonl', storedPath: 'src/new.mjs' } }),
      });
      return observed;
    },
  }) });
  if (mode === 'valid') {
    const result = await produced;
    expect(result.leaves).toHaveLength(3);
    expect(result.leaves.every(({ retrieval }) => retrieval.metrics.deltaCitationRate === 1 && retrieval.metrics.recallAt10 === 1)).toBe(true);
  } else {
    await expect(produced).rejects.toThrow(/canary rejected/);
    expect(observed.fixtures.claude.retrieval.metrics.recallAt10).toBe(0);
    if (mode === 'legacy-text') {
      expect(observed.fixtures.claude.retrieval.cases.every((row) => row.status === 'UNKNOWN'
        && /UNKNOWN.*structured retrieval/.test(row.error))).toBe(true);
    }
  }
  expect(fs.existsSync(prepared)).toBe(false);
});
it('CLI fails before host execution or receipt output when the required plan is absent', () => {
  const f = fixture(); const out = path.join(f.root, 'receipt.json');
  const result = spawnSync(process.execPath, ['scripts/candidate-host-evidence.mjs', '--manifest', f.args.manifestFile,
    '--package', f.args.packagePath, '--bundle', f.args.bundlePath, '--coverage', f.args.coverageFile, '--out', out], { encoding: 'utf8' });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('requires sealed plan'); expect(fs.existsSync(out)).toBe(false);
});
it.each(['missing-retrieval', 'changed-bytes'])('does not seal %s behind a green verifier', async (mutant) => {
  const f = fixture();
  await expect(buildCandidateHostEvidence(f.args, { createVerifier: () => ({ verify: async () => {
    if (mutant === 'changed-bytes') fs.appendFileSync(f.args.packagePath, 'mutation');
    return { verdict: 'PASS', fixtures: Object.fromEntries(['claude', 'codex', 'dual'].map((mode) => [mode,
      { status: 'PASS', process: { status: 0 }, grounding: { repo: 'new', path: 'src/new.mjs', file: 'new.passages.jsonl', storedPath: 'src/new.mjs' } }])) };
  } }) })).rejects.toThrow();
});
