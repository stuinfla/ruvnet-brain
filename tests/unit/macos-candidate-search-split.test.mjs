// The preflight's exact-candidate macOS search runs one macOS runner per host mode (was: all three, one
// after another, on one runner — 738-866 s on the preflight's critical path). These pin that (1) a mode
// subset really runs only those modes, each with its full install/prewarm/warmup/search/canaries, (2) the
// aggregate requires all three per-mode receipts and holds every leaf to the old acceptance rule, and
// (3) the workflow wires it that way.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCandidateHostEvidence, parseCandidateModes } from '../../scripts/candidate-host-evidence.mjs';
import { MAC_CANDIDATE_MODES, verifyMacCandidateSearch } from '../../scripts/macos-candidate-search-check.mjs';
import { RELEASE_SEARCH_DEADLINE_MS, SELF_STORE_PROOF_QUERY, runHostMatrixAsync } from '../../scripts/host-install-matrix.mjs';
import { createPayloadManifest } from '../../scripts/release-payload.mjs';
import { sha256File } from '../../scripts/coverage-integrity.mjs';
import { runRetrievalCanaries } from '../../scripts/retrieval-canary.mjs';
import { candidateRetrievalFixture } from '../fixtures/candidate-retrieval-fixture.mjs';
import { writeStoredZip } from '../helpers/zip-fixture.mjs';
import { getVersion } from '../../scripts/version.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const roots = [];
afterEach(() => roots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-candidate-split-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'package')); fs.writeFileSync(path.join(root, 'package', 'candidate.txt'), 'sealed package');
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
  return { root, candidate, manifest, args: { manifestFile, packagePath, bundlePath, planFile, coverageFile } };
}

async function passingFixtures(f, searchMs = 25) {
  const retrieval = await runRetrievalCanaries({ ...f.candidate,
    search: async ({ query }) => [f.candidate.plan.cases.find((row) => row.query === query).expected],
    citationResolver: async (_matched, expected) => ({ resolved: true,
      evidence: { passageSha256: expected.passageSha256, passageFileSha256: 'd'.repeat(64) } }) });
  const grounding = { repo: 'ruvnet-brain', path: 'README.md', file: 'ruvnet-brain.passages.jsonl', storedPath: 'README.md' };
  return Object.fromEntries(['claude', 'codex', 'dual'].map((mode) => [mode, { status: 'PASS', process: { status: 0 },
    warmupMs: 100, warmupGrounding: grounding, searchMs, grounding, retrieval }]));
}

async function perModeReceipts(f, { searchMs } = {}) {
  const fixtures = await passingFixtures(f, searchMs);
  const receipts = {};
  for (const leaf of MAC_CANDIDATE_MODES) {
    const modes = parseCandidateModes(leaf);
    const seen = [];
    const receipt = await buildCandidateHostEvidence(f.args, { modes, createVerifier: (options) => ({ verify: async () => {
      seen.push(options.modes);
      return { verdict: 'PASS', fixtures: Object.fromEntries(options.modes.map((mode) => [mode, fixtures[mode]])) };
    } }) });
    expect(seen).toEqual([modes]);
    receipts[leaf] = { ...receipt, hostPlatform: 'darwin' };
  }
  return receipts;
}

describe('macOS candidate search, one runner per mode', () => {
  it('a mode subset installs, warms and searches only those modes', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-matrix-subset-')); roots.push(temp);
    const installs = [], searches = [];
    const ok = (stdout = '') => ({ status: 0, signal: null, error: null, stdout, stderr: '' });
    const result = await runHostMatrixAsync({
      packageRoot: '/candidate/package', version: getVersion(), variant: 'staged', locate: (name) => `/tools/${name}`, temp,
      sequentialSearches: true, modes: ['codex'],
      runCommand: async (_c, args, options) => {
        if (args.some((arg) => /[\\/]bin[\\/]install\.mjs$/.test(arg))) installs.push(options.env.HOME);
        return ok('repo=ruvnet-brain path=README.md');
      },
      runMcpSearch: async ({ mode, query }) => {
        searches.push(`${mode}:${query === SELF_STORE_PROOF_QUERY ? 'warmup' : 'search'}`);
        return { ...ok(`repo=ruvnet-brain path=${mode}.md`), broadMs: 10 };
      },
      verifyGrounding: async () => ({ grounded: true, receipt: { repo: 'ruvnet-brain', path: 'README.md' } }),
      resolveMcpServer: ({ home }) => path.join(home, 'server.mjs'),
    });
    expect(result.verdict).toBe('PASS');
    expect(Object.keys(result.fixtures)).toEqual(['codex']);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatch(/home-codex$/);
    expect(searches).toEqual(['codex:warmup', 'codex:search']);
    await expect(runHostMatrixAsync({ packageRoot: '/p', version: '1', locate: () => '/x', temp, modes: ['grok'] }))
      .rejects.toThrow(/non-empty subset/);
  });

  it('parses --modes leaf names and refuses unknown or repeated ones', () => {
    expect(parseCandidateModes(null)).toBeNull();
    expect(parseCandidateModes('dual-host')).toEqual(['dual']);
    expect(parseCandidateModes('claude-only,codex-only')).toEqual(['claude', 'codex']);
    for (const bad of ['', 'claude', 'dual-host,dual-host', 'grok-only', '--out']) expect(() => parseCandidateModes(bad), bad).toThrow(/--modes/);
  });

  it('the aggregate accepts three bound one-leaf receipts and refuses anything less', async () => {
    const f = fixture();
    const receipts = await perModeReceipts(f);
    for (const leaf of MAC_CANDIDATE_MODES) expect(receipts[leaf].leaves.map(({ name }) => name)).toEqual([leaf]);
    const accept = (r) => verifyMacCandidateSearch({ manifest: f.manifest, receipts: r, plan: f.candidate.plan, candidateSha: f.candidate.sourceSha });
    expect(accept(receipts)).toMatchObject({ verdict: 'PASS', hostPlatform: 'darwin', deadlineMs: RELEASE_SEARCH_DEADLINE_MS });

    const { 'codex-only': _dropped, ...two } = receipts;
    expect(() => accept(two)).toThrow(/no codex-only receipt/);
    expect(() => accept({ ...receipts, 'dual-host': { ...receipts['dual-host'], hostPlatform: 'linux' } })).toThrow(/dual-host host receipt is not bound/);
    expect(() => accept({ ...receipts, 'claude-only': receipts['codex-only'] })).toThrow(/claude-only host receipt is not bound/);
    expect(() => accept({ ...receipts, 'claude-only': { ...receipts['claude-only'], sha: 'f'.repeat(40) } })).toThrow(/not bound/);
    // The old single receipt carried all three leaves; it is not a per-mode receipt.
    const all = { ...receipts['claude-only'], leaves: MAC_CANDIDATE_MODES.map((leaf) => receipts[leaf].leaves[0]) };
    expect(() => accept({ 'claude-only': all, 'codex-only': all, 'dual-host': all })).toThrow(/not bound/);
    const slow = { ...receipts['dual-host'], leaves: [{ ...receipts['dual-host'].leaves[0], searchMs: RELEASE_SEARCH_DEADLINE_MS + 1 }] };
    expect(() => accept({ ...receipts, 'dual-host': slow })).toThrow(/dual-host search failed exact timing/);
    const ungrounded = { ...receipts['codex-only'], leaves: [{ ...receipts['codex-only'].leaves[0], grounding: { repo: 'x' } }] };
    expect(() => accept({ ...receipts, 'codex-only': ungrounded })).toThrow(/codex-only search failed/);
    const noCanary = { ...receipts['codex-only'], leaves: [{ ...receipts['codex-only'].leaves[0], retrieval: null }] };
    expect(() => accept({ ...receipts, 'codex-only': noCanary })).toThrow();
  });

  it('the preflight runs one macOS runner per mode and the aggregate checks all three receipts', () => {
    const source = fs.readFileSync(path.join(ROOT, '.github/workflows/release-candidate-preflight.yml'), 'utf8');
    const macJob = source.split('  macos-candidate-search:')[1]?.split('\n  aggregate:')[0] || '';
    expect(macJob).toContain('runs-on: macos-latest');
    expect(macJob).toMatch(/matrix:\s*\n\s+leaf: \[claude-only, codex-only, dual-host\]/);
    expect(macJob).toContain('fail-fast: false');
    expect(macJob).toContain('--modes "$LEAF"');
    expect(macJob).toContain('name: macos-candidate-search-${{ github.sha }}-${{ matrix.leaf }}');
    const aggregate = source.split('\n  aggregate:')[1] || '';
    expect(aggregate).toContain('pattern: macos-candidate-search-${{ github.sha }}-*');
    expect(aggregate).toContain('node scripts/macos-candidate-search-check.mjs');
  });
});
