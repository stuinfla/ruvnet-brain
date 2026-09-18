/**
 * ADR-086 Step 12 — source completeness ("collects ALL rUv repos and gists", owner criterion C1).
 *
 * Dual's acceptance deliberation (2026-09-13) found C1 only PARTIAL: forks and archives were
 * classified INELIGIBLE and the anonymous gist fallback stopped at ten pages. Two verifier
 * corrections bind this step:
 *   A1 — the ten-page cap never caused SILENT omission (observeGists throws on
 *        rows.length !== public_gists); raise the bound so that existing check stays the proof.
 *   A2 — blanket fork inclusion is wrong: a fork with ahead_by=0 contains none of rUv's code and
 *        would misattribute upstream authors (#286 RC3). Archives are included unconditionally;
 *        forks are dispositioned every run by the compare API and only the delta is creditable.
 *
 * One test per proof item in Dual's spec. Every test in this file FAILED against main's
 * scripts/source-coverage.mjs at b250e808 (RED run recorded in the Step 12 commit message) except
 * the two labelled "control", which pin behaviour that must SURVIVE the change.
 */
import { describe, expect, it } from 'vitest';
import { SOURCE_POLICY_VERSION, classifyRepository, diffCoverageIdentities, explainCoverageDrift,
  isIngestibleDisposition, observeGists, observeSourceUniverse, sealCoverage } from '../../scripts/source-coverage.mjs';

const HEAD = 'a'.repeat(40);
const FORK_HEAD = 'b'.repeat(40);
const UPSTREAM_HEAD = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);

const node = (over = {}) => ({
  databaseId: 1, name: 'ruflo', url: 'https://github.com/ruvnet/ruflo', description: null, homepageUrl: null,
  isFork: false, isArchived: false, isDisabled: false, diskUsage: 1,
  updatedAt: '2026-08-21T00:00:00Z', pushedAt: '2026-08-21T00:00:00Z',
  defaultBranchRef: { name: 'main', target: { oid: HEAD, committedDate: '2026-08-21T00:00:00Z' } },
  ...over,
});
const forkNode = (over = {}) => node({
  databaseId: 2, name: 'buzz', url: 'https://github.com/ruvnet/buzz', isFork: true,
  defaultBranchRef: { name: 'main', target: { oid: FORK_HEAD, committedDate: '2026-08-21T00:00:00Z' } },
  parent: { nameWithOwner: 'block/buzz', isPrivate: false,
    defaultBranchRef: { name: 'main', target: { oid: UPSTREAM_HEAD } } },
  ...over,
});
const COMPARE_PATH = `repos/block/buzz/compare/${UPSTREAM_HEAD}...ruvnet:${FORK_HEAD}`;
const compareReply = (ahead_by, behind_by = 0) => ({
  status: ahead_by && behind_by ? 'diverged' : ahead_by ? 'ahead' : behind_by ? 'behind' : 'identical',
  ahead_by, behind_by, total_commits: ahead_by,
  base_commit: { sha: UPSTREAM_HEAD }, merge_base_commit: { sha: MERGE_BASE },
  commits: Array.from({ length: Math.min(ahead_by, 250) }, (_, i) => ({ sha: String(i).padStart(40, '0') })),
});

/** The same injection seam every source-coverage test uses: `gh(args)` keyed on the API path. */
function ghFor({ nodes, publicRepos = nodes.length, publicGists = 0, gists = [[]], compare = {} }) {
  return (args) => {
    if (args[1] === 'graphql') {
      return JSON.stringify({ data: { user: { repositories: {
        pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    if (args[1] === 'users/ruvnet') return JSON.stringify({ public_repos: publicRepos, public_gists: publicGists });
    if (String(args[1]).startsWith('users/ruvnet/gists')) return JSON.stringify(gists);
    if (/^repos\/.+\/compare\//.test(String(args[1]))) {
      const reply = compare[args[1]];
      if (reply === undefined) throw new Error(`unexpected compare call: ${args[1]}`);
      if (reply instanceof Error) throw reply;
      return JSON.stringify(reply);
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}
const observe = (options) => observeSourceUniverse({ owner: 'ruvnet', externalSources: [], gh: ghFor(options),
  observedAt: '2026-09-13T12:00:00.000Z' });
const rowNamed = (observation, name) => observation.repositories.rows.find((row) => row.name === name);

const evidenceFor = (sourceCommit) => ({ rvfPresent: true, bytesVerified: true, passagesPresent: true, cardPresent: true,
  receipt: { sourceCommit, sha256: 'e'.repeat(64), builtUtc: '2026-08-21T01:00:00Z' } });
const absent = { rvfPresent: false, bytesVerified: false, passagesPresent: false, cardPresent: false, receipt: null };

const coverageOf = (rows) => sealCoverage({ owner: 'ruvnet', rows,
  repositories: { expected: rows.filter((row) => row.kind === 'repository').length, pages: [] },
  gists: { expected: rows.filter((row) => row.kind === 'gist').length, pages: [] },
  generatorSourceSha: 'g', snapshotRoot: 's', observedAt: '2026-09-13T12:00:00.000Z' });
const gistRow = (id) => ({ key: `gist:${id}`, kind: 'gist', name: id, url: `https://gist.github.com/${id}`,
  disposition: 'eligible', upstream: {}, artifact: { store: 'ruv-gists' }, status: 'CURRENT', reasons: [] });

describe('Step 12 — forks are dispositioned by the compare API, never blanket-included or forgotten (A2)', () => {
  it('fork with ahead_by>0: observation records the delta, classification yields an ingestible fork disposition', () => {
    const observation = observe({ nodes: [node(), forkNode()], compare: { [COMPARE_PATH]: compareReply(213, 322) } });
    const fork = rowNamed(observation, 'buzz');
    expect(fork.forkDelta).toEqual({
      upstream: 'block/buzz', upstreamDefaultBranch: 'main', upstreamHeadSha: UPSTREAM_HEAD,
      forkHeadSha: FORK_HEAD, mergeBaseSha: MERGE_BASE, aheadBy: 213, behindBy: 322, status: 'diverged',
    });
    // The compare was pinned to the two observed heads, not to moving branch names.
    expect(observation.observationSha256).toMatch(/^[a-f0-9]{64}$/);

    const missing = classifyRepository(fork, absent);
    expect(missing).toMatchObject({ disposition: 'fork:original-content', status: 'MISSING', archived: false,
      forkDelta: { upstream: 'block/buzz', aheadBy: 213, upstreamHeadSha: UPSTREAM_HEAD, forkHeadSha: FORK_HEAD } });
    expect(isIngestibleDisposition(missing.disposition)).toBe(true);
    // Once a store bound to the FORK's own head exists, the row is CURRENT like any eligible repository.
    // A legacy full-tree artifact at the same head is not delta provenance.
    expect(classifyRepository(fork, evidenceFor(FORK_HEAD))).toMatchObject({ disposition: 'fork:original-content', status: 'UNVERIFIED' });
    // It is NOT literally 'eligible': corpus-reconcile.mjs full-clones every 'eligible' row, which
    // would ingest upstream authors' commits under rUv's name — the misattribution A2 forbids.
    expect(missing.disposition).not.toBe('eligible');
  });

  it('fork with ahead_by=0: recorded as fork:no-original-content WITH the upstream identity, not ineligible-and-forgotten', () => {
    const observation = observe({ nodes: [forkNode()], compare: { [COMPARE_PATH]: compareReply(0, 60) } });
    const row = classifyRepository(rowNamed(observation, 'buzz'), absent);
    expect(row).toMatchObject({ disposition: 'fork:no-original-content', status: 'INELIGIBLE',
      forkDelta: { upstream: 'block/buzz', aheadBy: 0, behindBy: 60, upstreamHeadSha: UPSTREAM_HEAD, forkHeadSha: FORK_HEAD } });
    expect(row.reasons.join(' ')).toMatch(/block\/buzz/);
    expect(row.reasons.join(' ')).toMatch(/0 commits ahead/);
    expect(isIngestibleDisposition(row.disposition)).toBe(false);
  });

  it('a fork row that carries no fork delta cannot be classified — the observation predates this policy or skipped the compare', () => {
    expect(() => classifyRepository(forkNode(), absent)).toThrow(/buzz.*fork delta/);
  });

  it('the fork delta is part of the sealed source identity: a change in ahead_by changes the observation digest', () => {
    const a = observe({ nodes: [forkNode()], compare: { [COMPARE_PATH]: compareReply(1, 5) } });
    const b = observe({ nodes: [forkNode()], compare: { [COMPARE_PATH]: compareReply(2, 5) } });
    expect(a.observationSha256).not.toBe(b.observationSha256);
  });
});

describe('Step 12 — archives are included unconditionally (A2)', () => {
  it('archived=true is eligible, carries archived:true on the row, and is CURRENT when its artifact matches', () => {
    const observation = observe({ nodes: [node({ isArchived: true })] });
    const repo = rowNamed(observation, 'ruflo');
    expect(repo.isArchived).toBe(true);
    expect(classifyRepository(repo, evidenceFor(HEAD))).toMatchObject({ disposition: 'eligible', archived: true, status: 'CURRENT' });
    expect(classifyRepository(repo, absent)).toMatchObject({ disposition: 'eligible', archived: true, status: 'MISSING' });
  });
});

describe('Step 12 — identity accounting: additions, deletions, renames, visibility (stable databaseId keys)', () => {
  const alpha = classifyRepository(node({ databaseId: 1, name: 'alpha' }), evidenceFor(HEAD));
  const beta = classifyRepository(node({ databaseId: 2, name: 'beta' }), evidenceFor(HEAD));

  it('repo addition: a repository absent from the recorded coverage and present now is reported as added', () => {
    const diff = diffCoverageIdentities(coverageOf([alpha]), coverageOf([alpha, beta]));
    expect(diff.repositories).toEqual({ added: [{ key: 'repo:2', name: 'beta' }], removed: [], renamed: [] });
  });

  it('deletion: a repository in the recorded coverage and absent now is reported as removed, never silently dropped', () => {
    const diff = diffCoverageIdentities(coverageOf([alpha, beta]), coverageOf([alpha]));
    expect(diff.repositories).toEqual({ added: [], removed: [{ key: 'repo:2', name: 'beta' }], renamed: [] });
  });

  it('rename: same databaseId with a new name is a rename, not a removal plus an addition', () => {
    const renamed = classifyRepository(node({ databaseId: 2, name: 'beta-renamed' }), evidenceFor(HEAD));
    const diff = diffCoverageIdentities(coverageOf([alpha, beta]), coverageOf([alpha, renamed]));
    expect(diff.repositories).toEqual({ added: [], removed: [], renamed: [{ key: 'repo:2', from: 'beta', to: 'beta-renamed' }] });
  });

  it('gists are accounted the same way by their stable id', () => {
    const diff = diffCoverageIdentities(coverageOf([alpha, gistRow('g1')]), coverageOf([alpha, gistRow('g2')]));
    expect(diff.gists).toEqual({ added: [{ key: 'gist:g2', name: 'g2' }], removed: [{ key: 'gist:g1', name: 'g1' }] });
  });

  it('visibility change mid-run (public -> private between enumeration and compare): the observation fails, it does not skip the row', () => {
    const gone = new Error(`gh api ${COMPARE_PATH} failed: gh: Not Found (HTTP 404)`);
    expect(() => observe({ nodes: [node(), forkNode()], compare: { [COMPARE_PATH]: gone } })).toThrow(/buzz.*block\/buzz.*HTTP 404/);
  });

  it('--check drift explanation names every identity difference and the policy version gap instead of a bare "differ"', () => {
    const recorded = { ...coverageOf([alpha, beta]), observedAt: '2026-09-12T19:02:04.012Z', policy: { policyDispositionDigests: [], exemptionDigests: [] } };
    const movedAlpha = { ...alpha, upstream: { ...alpha.upstream, sha: 'f'.repeat(40) } };
    const current = coverageOf([movedAlpha]);
    const lines = explainCoverageDrift(recorded, current).join('\n');
    expect(lines).toMatch(/rows changed in content: 1 \(first: repo:1\)/);
    expect(lines).toMatch(/repositories: \+0 added, -1 removed \(repo:2 beta\), 0 renamed/);
    expect(lines).toMatch(/recorded policyVersion 1/);
    expect(lines).toMatch(new RegExp(`current policyVersion ${SOURCE_POLICY_VERSION}`));
    expect(lines).toMatch(/next pipeline run/);
  });
});

describe('Step 12 — genuinely empty sources get an explicit record, never an omission', () => {
  it('a repository with no default branch is observed, kept, and classified empty with an explicit reason and null revision', () => {
    const observation = observe({ nodes: [node({ databaseId: 7, name: 'socket', defaultBranchRef: null })] });
    expect(observation.repositories.rows).toHaveLength(1);
    const row = classifyRepository(rowNamed(observation, 'socket'), absent);
    expect(row).toMatchObject({ disposition: 'empty', status: 'INELIGIBLE', upstream: { sha: null },
      reasons: ['repository has no default branch — no commits to collect'] });
  });

  it('an empty FORK (no head) is empty, not a fork: there is nothing to compare, and no compare call is made', () => {
    const observation = observe({ nodes: [forkNode({ defaultBranchRef: null })] }); // no compare reply registered → would throw if called
    expect(classifyRepository(rowNamed(observation, 'buzz'), absent)).toMatchObject({ disposition: 'empty', status: 'INELIGIBLE' });
  });

  it('a disabled repository states why it is ineligible', () => {
    expect(classifyRepository(node({ isDisabled: true }), absent)).toMatchObject({ disposition: 'disabled', status: 'INELIGIBLE',
      reasons: ['repository is disabled by GitHub'] });
  });
});

describe('Step 12 — pushedAt-bound exclusions require independent source-file evidence (zero chunks is not proof)', () => {
  const repo = node({ name: 'santa-ai-workshop' });
  const evidence = { method: 'gh api repos/ruvnet/santa-ai-workshop/git/trees/HEAD?recursive=1', headSha: HEAD,
    inspectedAt: '2026-09-13T00:00:00Z', truncated: false, files: [{ path: 'LICENSE', size: 11357 }] };

  it('an active exclusion whose evidence names the inspected files at the observed head is honoured', () => {
    expect(classifyRepository(repo, absent, { reason: 'LICENSE only', pushedAt: repo.pushedAt, evidence }))
      .toMatchObject({ disposition: 'excluded-no-corpus', status: 'INELIGIBLE', reasons: ['LICENSE only'] });
  });

  it('an active exclusion with NO evidence throws instead of silently excluding the source', () => {
    expect(() => classifyRepository(repo, absent, { reason: '0 chunks produced — nothing embeddable', pushedAt: repo.pushedAt }))
      .toThrow(/santa-ai-workshop.*source-file evidence/);
  });

  it('evidence taken at a different revision than the observed head is not evidence about this source', () => {
    expect(() => classifyRepository(repo, absent, { reason: 'x', pushedAt: repo.pushedAt, evidence: { ...evidence, headSha: 'f'.repeat(40) } }))
      .toThrow(/santa-ai-workshop.*headSha/);
  });

  it('control: an exclusion whose pushedAt no longer matches is inactive and needs no evidence (it simply does not apply)', () => {
    expect(classifyRepository(repo, absent, { reason: 'old', pushedAt: '2020-01-01T00:00:00Z' }))
      .toMatchObject({ disposition: 'eligible', status: 'MISSING' });
  });
});

describe('Step 12 — gist pagination follows to the actual end; rows.length === public_gists stays the completeness proof (A1)', () => {
  const gistsOf = (count, prefix) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, files: {} }));
  const actions403 = (args) => {
    if (String(args[1]).includes('gists')) throw new Error('gh api users/ruvnet/gists?per_page=100 failed: Resource not accessible by integration (HTTP 403)');
    return null;
  };
  const curlPages = (pages) => (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page > pages.length) throw new Error(`page ${page} requested beyond fixture (${pages.length} pages)`);
    return JSON.stringify(pages[page - 1]);
  };

  it('more than 1000 gists: 11 full pages plus the terminating empty page are all collected and the count check passes', () => {
    const pages = [...Array.from({ length: 11 }, (_, p) => gistsOf(100, `p${p}`)), []];
    const gh = (args) => actions403(args) ?? JSON.stringify({ public_gists: 1100 });
    const result = observeGists('ruvnet', { gh, curl: curlPages(pages) });
    expect(result.rows).toHaveLength(1100);
    expect(result.expected).toBe(1100);
    expect(result.pages.at(-1)).toMatchObject({ index: 12, count: 0, terminal: true });
  });

  it('partial response: a short page followed by more is not the end — only an empty page terminates', () => {
    const pages = [gistsOf(100, 'a'), gistsOf(40, 'b'), gistsOf(100, 'c'), []];
    const gh = (args) => actions403(args) ?? JSON.stringify({ public_gists: 240 });
    const result = observeGists('ruvnet', { gh, curl: curlPages(pages) });
    expect(result.rows).toHaveLength(240);
    expect(result.rows.map((g) => g.id)).toContain('c-99');
  });

  it('the hard page ceiling throws rather than truncating', () => {
    const gh = (args) => actions403(args) ?? JSON.stringify({ public_gists: 999999 });
    const curl = (url) => JSON.stringify(gistsOf(100, `x${new URL(url).searchParams.get('page')}`)); // never empty
    expect(() => observeGists('ruvnet', { gh, curl })).toThrow(/exceeded .* pages/);
  });

  it('control: rows.length !== public_gists still throws — the unchanged completeness proof', () => {
    const gh = (args) => actions403(args) ?? JSON.stringify({ public_gists: 6 });
    expect(() => observeGists('ruvnet', { gh, curl: curlPages([gistsOf(5, 'g'), []]) })).toThrow(/gist enumeration incomplete: 5\/6/);
  });

  it('collection-time source movement that surfaces as a duplicated gist identity fails the observation', () => {
    const gist = { id: 'same', files: {} };
    const gh = (args) => (String(args[1]).includes('gists') ? JSON.stringify([[gist], [gist]]) : JSON.stringify({ public_gists: 2 }));
    expect(() => observeGists('ruvnet', { gh })).toThrow(/duplicate gist identit/);
  });
});

describe('Step 12 — inaccessible required content blocks completeness', () => {
  it('a 403 on a fork\'s compare (required to disposition it) fails the observation instead of skipping the fork', () => {
    const blocked = new Error(`gh api ${COMPARE_PATH} failed: gh: Forbidden (HTTP 403)`);
    expect(() => observe({ nodes: [forkNode()], compare: { [COMPARE_PATH]: blocked } })).toThrow(/buzz.*HTTP 403/);
  });

  it('a fork whose upstream parent GitHub cannot name is unresolvable, not silently eligible or silently ineligible', () => {
    expect(() => observe({ nodes: [forkNode({ parent: null })] })).toThrow(/buzz.*upstream/);
  });
});

describe('Step 12 — the policy version is sealed into every coverage so a stale recorded shape is detectable', () => {
  it('sealCoverage stamps policy.policyVersion with the generator\'s SOURCE_POLICY_VERSION', () => {
    expect(SOURCE_POLICY_VERSION).toBe(2);
    expect(coverageOf([]).policy).toMatchObject({ policyVersion: 2, policyDispositionDigests: [], exemptionDigests: [] });
  });
});
