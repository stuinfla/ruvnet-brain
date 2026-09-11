/**
 * source-coverage.mjs measured the BUILD WORKSPACE (<repo>/kb) by default — the directory
 * kb/store-root.mjs declares "never a second brain". On 2026-09-11 three commits projected a dirty
 * workspace as if it were the installed brain: 476 of 719 rows FAILED "RVF bytes do not match the
 * generation receipt" while the canonical store root matched 184/184.
 *
 * The default target must be the one store root every reader uses (storeRoot(): RUVNET_BRAIN_KB,
 * KB_DIR, else ~/.cache/ruvnet-brain/kb). `--assets` remains the explicit override for release
 * candidates. Policy files stay in the repository (kb/external-sources.json, kb/no-corpus-repos.json).
 */
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCoverage, observeSourceUniverse } from '../../scripts/source-coverage.mjs';

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const OID = 'a'.repeat(40);
const repoNode = {
  databaseId: 1, name: 'ruflo', url: 'https://github.com/ruvnet/ruflo', isFork: false, isArchived: false,
  isDisabled: false, diskUsage: 1, updatedAt: '2026-08-21T00:00:00Z', pushedAt: '2026-08-21T00:00:00Z',
  defaultBranchRef: { target: { oid: OID, committedDate: '2026-08-21T00:00:00Z' } },
};
const gh = (args) => {
  if (args[1] === 'graphql') {
    return JSON.stringify({ data: { user: { repositories: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: [repoNode] } } } });
  }
  if (args[1] === 'users/ruvnet') return JSON.stringify({ public_repos: 1, public_gists: 0 });
  if (String(args[1]).startsWith('users/ruvnet/gists')) return JSON.stringify([[]]);
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
};
const observation = () => observeSourceUniverse({ owner: 'ruvnet', externalSources: [], gh,
  observedAt: '2026-09-11T00:00:00.000Z' });

/** A brain directory whose ledger either matches its bytes (a real brain) or does not (a dirty workspace). */
function brain(dir, { receiptMatches }) {
  fs.mkdirSync(dir, { recursive: true });
  const rvf = Buffer.from(`vectors-of-${path.basename(dir)}`);
  fs.writeFileSync(path.join(dir, 'ruflo.big.rvf'), rvf);
  fs.writeFileSync(path.join(dir, 'ruflo.passages.jsonl'), '{"passage":1}\n');
  fs.writeFileSync(path.join(dir, 'capability-cards.md'), '## ruflo\ncard body\n');
  fs.writeFileSync(path.join(dir, 'repo-aliases.json'), '{}');
  fs.writeFileSync(path.join(dir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { ruflo: {
    file: 'ruflo.big.rvf', bytes: rvf.length, sha256: receiptMatches ? sha(rvf) : 'f'.repeat(64),
    sourceCommit: OID, builtUtc: '2026-08-21T01:00:00Z' } } }));
  return dir;
}

const rowFor = (coverage) => coverage.rows.find((row) => row.kind === 'repository' && row.name === 'ruflo');

describe('source coverage measures the store root, never the build workspace', () => {
  it('defaults to RUVNET_BRAIN_KB (the one resolver every reader uses), not <repo>/kb', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-coverage-root-'));
    try {
      const storeDir = brain(path.join(root, 'installed-brain'), { receiptMatches: true });
      const workspace = brain(path.join(root, 'repo-kb'), { receiptMatches: false });
      const viaEnv = buildCoverage({ env: { RUVNET_BRAIN_KB: storeDir }, policyDir: workspace, observation: observation() });
      expect(rowFor(viaEnv)).toMatchObject({ status: 'CURRENT', artifact: { bytesVerified: true } });
      // The same call pointed at the workspace is the 476-FAILED reading — proving the env path was what won.
      const viaWorkspace = buildCoverage({ kbDir: workspace, policyDir: workspace, observation: observation() });
      expect(rowFor(viaWorkspace)).toMatchObject({ status: 'FAILED', reasons: ['RVF bytes do not match receipt'] });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('with no override resolves the canonical ~/.cache/ruvnet-brain/kb of the given home', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-coverage-home-'));
    try {
      brain(path.join(home, '.cache', 'ruvnet-brain', 'kb'), { receiptMatches: true });
      const coverage = buildCoverage({ env: {}, home, policyDir: fs.mkdtempSync(path.join(home, 'policy-')), observation: observation() });
      expect(rowFor(coverage)).toMatchObject({ status: 'CURRENT' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('refuses to measure when the store root was never materialized instead of silently reading the workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'source-coverage-absent-'));
    try {
      expect(() => buildCoverage({ env: {}, home, policyDir: home, observation: observation() }))
        .toThrow(/store root .* does not exist/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
