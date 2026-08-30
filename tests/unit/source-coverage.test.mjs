import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCoverage, canonicalGistRows, canonicalJson, canonicalRepositoryRows, classifyGist, classifyRepository,
  digest, gistVersion, observeExternalRepositories, observeSourceUniverse, sealCoverage,
  sourceObservationDigest } from '../../scripts/source-coverage.mjs';

const repo = {
  databaseId: 1, name: 'ruflo', url: 'https://github.com/ruvnet/ruflo', isFork: false,
  isArchived: false, isDisabled: false, diskUsage: 1, updatedAt: '2026-08-21T00:00:00Z',
  pushedAt: '2026-08-21T00:00:00Z',
  defaultBranchRef: { target: { oid: 'a'.repeat(40), committedDate: '2026-08-21T00:00:00Z' } },
};
const evidence = { rvfPresent: true, bytesVerified: true, passagesPresent: true, cardPresent: true,
  receipt: { sourceCommit: 'a'.repeat(40), sha256: 'b'.repeat(64), builtUtc: '2026-08-21T01:00:00Z' } };

describe('artifact-bound source coverage', () => {
  it('canonicalizes objects independently of insertion order', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });

  it('calls a matching verified artifact current and clone state is not an input', () => {
    expect(classifyRepository(repo, evidence)).toMatchObject({ status: 'CURRENT', artifact: { sourceCommit: 'a'.repeat(40) } });
  });

  it('binds an explicit no-corpus exclusion into an ineligible repository row', () => {
    const exclusion = { reason: 'heading-only repository has no functional corpus', pushedAt: repo.pushedAt };
    expect(classifyRepository(repo, { ...evidence, rvfPresent: false }, exclusion)).toMatchObject({
      status: 'INELIGIBLE',
      disposition: 'excluded-no-corpus',
      reasons: [exclusion.reason],
    });
  });

  it('expires no-corpus evidence when the repository changes or the measured revision is absent', () => {
    const stale = { reason: 'previously empty', pushedAt: '2026-08-20T00:00:00Z' };
    expect(classifyRepository(repo, { ...evidence, rvfPresent: false }, stale)).toMatchObject({
      disposition: 'eligible', status: 'MISSING',
    });
    expect(classifyRepository(repo, { ...evidence, rvfPresent: false }, { reason: 'unbound' })).toMatchObject({
      disposition: 'eligible', status: 'MISSING',
    });
  });

  it('enumerates configured public sources outside the primary owner with their explicit store names', () => {
    const replies = new Map([
      ['repos/stuinfla/ruvnet-brain', {
        id: 42, name: 'ruvnet-brain', full_name: 'stuinfla/ruvnet-brain', html_url: 'https://github.com/stuinfla/ruvnet-brain',
        fork: false, archived: false, disabled: false, size: 10, updated_at: 'u', pushed_at: 'p', default_branch: 'main',
      }],
      ['repos/stuinfla/ruvnet-brain/commits/main', {
        sha: 'c'.repeat(40), commit: { committer: { date: '2026-08-21T00:00:00Z' } },
      }],
    ]);
    const gh = (args) => JSON.stringify(replies.get(args[1]));
    const observed = observeExternalRepositories([{ store: 'brain-self', repository: 'stuinfla/ruvnet-brain' }], { gh });
    expect(observed).toMatchObject({ expected: 1, rows: [{ fullName: 'stuinfla/ruvnet-brain', storeName: 'brain-self' }] });
    expect(classifyRepository(observed.rows[0], { ...evidence, receipt: { ...evidence.receipt, sourceCommit: 'c'.repeat(40) } }))
      .toMatchObject({ key: 'repo:stuinfla/ruvnet-brain', artifact: { store: 'brain-self' }, status: 'CURRENT' });
  });

  it('seals complete paginated repositories and gists into one immutable SourceObservation', () => {
    const page1 = { data: { user: { repositories: { pageInfo: { hasNextPage: true, endCursor: 'next' },
      nodes: [{ ...repo, name: 'alpha' }] } } } };
    const page2 = { data: { user: { repositories: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ ...repo, databaseId: 2, name: 'beta' }] } } } };
    const gist = { id: 'gist-1', updated_at: '2026-08-21T00:00:00Z', html_url: 'https://gist.github.com/gist-1', files: {} };
    const gh = (args) => {
      if (args[1] === 'graphql') return JSON.stringify(args.includes('cursor=next') ? page2 : page1);
      if (args[1] === 'users/ruvnet') return JSON.stringify({ public_repos: 2, public_gists: 1 });
      if (String(args[1]).startsWith('users/ruvnet/gists')) return JSON.stringify([[gist]]);
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const first = observeSourceUniverse({ owner: 'ruvnet', externalSources: [], gh,
      observedAt: '2026-08-21T12:00:00.000Z' });
    const second = observeSourceUniverse({ owner: 'ruvnet', externalSources: [], gh,
      observedAt: '2026-08-21T12:00:00.000Z' });
    expect(first).toMatchObject({ schemaVersion: 1, kind: 'ruvnet-brain-source-observation',
      repositories: { expected: 2 }, gists: { expected: 1 } });
    expect(first.repositories.pages).toEqual([{ index: 1, responseDigest: digest(first.repositories.rows),
      count: 2, terminal: true }]);
    expect(first.gists.pages.at(-1)).toMatchObject({ terminal: true });
    expect(first.observationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.observationSha256).toBe(first.observationSha256);
  });

  it('seals source facts independently of clocks, transport receipts, page partitions, and array order', () => {
    const gist = { id: 'abc', updated_at: '2026-08-21T00:00:00Z', html_url: 'https://gist.github.com/abc',
      files: { z: { filename: 'z.md', raw_url: `https://gist.example/raw/${'d'.repeat(40)}/z.md`, size: 3,
        type: 'text/plain', language: 'Markdown' } } };
    const observation = ({ repositories, gists, observedAt, pages }) => ({
      schemaVersion: 1, kind: 'ruvnet-brain-source-observation', owner: 'ruvnet', observedAt,
      repositories: { rows: repositories, expected: repositories.length, pages },
      gists: { rows: gists, expected: gists.length, pages: [...pages].reverse() },
    });
    const first = observation({ repositories: [repo, { ...repo, databaseId: 2, name: 'beta' }], gists: [gist],
      observedAt: '2026-08-21T01:00:00Z', pages: [{ cursor: 'opaque-a', responseDigest: 'transport-a' }] });
    const second = observation({ repositories: [{ ...repo, databaseId: 2, name: 'beta' }, repo],
      gists: [{ ...gist, comments: 99, description: 'irrelevant', owner: { avatar_url: 'changed' } }],
      observedAt: '2026-08-22T01:00:00Z', pages: [{ cursor: 'opaque-b', responseDigest: 'transport-b' }] });
    expect(canonicalRepositoryRows(first.repositories.rows)).toEqual(canonicalRepositoryRows(second.repositories.rows));
    expect(canonicalGistRows(first.gists.rows)).toEqual(canonicalGistRows(second.gists.rows));
    expect(sourceObservationDigest(first)).toBe(sourceObservationDigest(second));
  });

  it.each([
    ['repository HEAD', (base) => ({ ...base, repositories: { ...base.repositories, rows: [
      { ...base.repositories.rows[0], defaultBranchRef: { ...base.repositories.rows[0].defaultBranchRef,
        target: { ...base.repositories.rows[0].defaultBranchRef.target, oid: 'f'.repeat(40) } } },
    ] } })],
    ['repository pushedAt', (base) => ({ ...base, repositories: { ...base.repositories,
      rows: [{ ...base.repositories.rows[0], pushedAt: '2026-08-22T00:00:00Z' }] } })],
    ['gist revision', (base) => ({ ...base, gists: { ...base.gists, rows: [{ ...base.gists.rows[0],
      files: { a: { ...base.gists.rows[0].files.a,
        raw_url: `https://gist.example/raw/${'e'.repeat(40)}/a.md` } } }] } })],
  ])('changes source identity for a meaningful %s change', (_label, mutate) => {
    const gist = { id: 'abc', updated_at: '2026-08-21T00:00:00Z', html_url: 'https://gist.github.com/abc',
      files: { a: { filename: 'a.md', raw_url: `https://gist.example/raw/${'d'.repeat(40)}/a.md` } } };
    const base = { schemaVersion: 1, kind: 'ruvnet-brain-source-observation', owner: 'ruvnet', observedAt: 'now',
      repositories: { rows: [repo], expected: 1, pages: [] }, gists: { rows: [gist], expected: 1, pages: [] } };
    expect(sourceObservationDigest(mutate(base))).not.toBe(sourceObservationDigest(base));
  });

  it('rejects duplicate repository identities and case-folded store collisions before sealing', () => {
    const primary = { data: { user: { repositories: { pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ ...repo, name: 'Alpha' }] } } } };
    const externalRepo = { id: 2, name: 'external', full_name: 'else/external', html_url: 'https://github.com/else/external',
      fork: false, archived: false, disabled: false, size: 1, updated_at: 'u', pushed_at: 'p', default_branch: 'main' };
    const gh = (args) => {
      if (args[1] === 'graphql') return JSON.stringify(primary);
      if (args[1] === 'users/ruvnet') return JSON.stringify({ public_repos: 1, public_gists: 0 });
      if (String(args[1]).startsWith('users/ruvnet/gists')) return JSON.stringify([[]]);
      if (args[1] === 'repos/else/external') return JSON.stringify(externalRepo);
      if (args[1] === 'repos/else/external/commits/main') return JSON.stringify({ sha: 'c'.repeat(40), commit: {} });
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    expect(() => observeSourceUniverse({ owner: 'ruvnet', gh,
      externalSources: [{ repository: 'else/external', store: 'alpha' }] })).toThrow(/colliding store name/);
  });

  it.each([
    [{ ...evidence, receipt: { ...evidence.receipt, sourceCommit: null } }, 'UNVERIFIED'],
    [{ ...evidence, receipt: { ...evidence.receipt, sourceCommit: 'c'.repeat(40) } }, 'STALE'],
    [{ ...evidence, bytesVerified: false }, 'FAILED'],
    [{ ...evidence, cardPresent: false }, 'CURRENT'],
    [{ ...evidence, rvfPresent: false }, 'MISSING'],
  ])('fails closed for incomplete artifact evidence', (input, status) => {
    expect(classifyRepository(repo, input).status).toBe(status);
  });

  it('requires a complete version-bound per-gist receipt before calling a gist current', () => {
    const gist = { id: 'g', updated_at: '2026-08-21T00:00:00Z', html_url: 'https://gist.github.com/g',
      files: { a: { filename: 'a.md', raw_url: `https://gist.githubusercontent.com/ruvnet/g/raw/${'d'.repeat(40)}/a.md` } } };
    expect(gistVersion(gist)).toBe('d'.repeat(40));
    const base = { rvfPresent: true, bytesVerified: true, passagesBound: true, receipt: {}, cache: { g: gist.updated_at } };
    expect(classifyGist(gist, base).status).toBe('UNVERIFIED');
    expect(classifyGist(gist, { ...base, sources: { gists: { g: {
      versionSha: 'd'.repeat(40), ingestedAt: gist.updated_at, contentDigest: 'x', files: [{}], complete: true,
    } } } }).status).toBe('CURRENT');
  });

  it('binds enumeration evidence and every ordered row into one stable generation', () => {
    const repositories = { expected: 1, pages: [{ count: 1, terminal: true }] };
    const gists = { expected: 0, pages: [{ count: 0, terminal: true }] };
    const row = classifyRepository(repo, evidence);
    const sourceObservationSha256 = 'd'.repeat(64);
    const a = sealCoverage({ owner: 'ruvnet', repositories, gists, rows: [row], generatorSourceSha: 'x',
      sourceObservationSha256, snapshotRoot: 'y', observedAt: 'z' });
    const b = sealCoverage({ owner: 'ruvnet', repositories, gists, rows: [row], generatorSourceSha: 'x',
      sourceObservationSha256, snapshotRoot: 'y', observedAt: 'z' });
    expect(a.coverageGeneration).toBe(b.coverageGeneration);
    expect(a.sourceObservationSha256).toBe(sourceObservationSha256);
    expect(a.enumerationReceipt.duplicateKeys).toBe(0);
  });

  it('classifies candidate bytes from a supplied observation without re-enumerating GitHub', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-observation-'));
    try {
      const rvf = 'alpha-rvf';
      const rvfSha = digest(rvf);
      fs.writeFileSync(path.join(kb, 'alpha.big.rvf'), rvf);
      fs.writeFileSync(path.join(kb, 'alpha.passages.jsonl'), '{}\n');
      fs.writeFileSync(path.join(kb, 'capability-cards.md'), '## alpha\nCapability.\n');
      fs.writeFileSync(path.join(kb, 'external-sources.json'), JSON.stringify({ sources: [] }));
      fs.writeFileSync(path.join(kb, 'no-corpus-repos.json'), '{}');
      fs.writeFileSync(path.join(kb, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: {
        file: 'alpha.big.rvf', sha256: rvfSha, bytes: Buffer.byteLength(rvf), sourceCommit: 'a'.repeat(40),
        builtUtc: '2026-08-21T01:00:00Z',
      } } }));
      const observationBase = { schemaVersion: 1, kind: 'ruvnet-brain-source-observation', owner: 'ruvnet',
        observedAt: '2026-08-21T12:00:00Z',
        repositories: { rows: [{ ...repo, name: 'alpha' }], expected: 1, pages: [{ terminal: true }] },
        gists: { rows: [], expected: 0, pages: [{ terminal: true }] } };
      const observation = { ...observationBase, observationSha256: sourceObservationDigest(observationBase) };
      const coverage = buildCoverage({ owner: 'ruvnet', kbDir: kb, policyDir: kb, observation,
        gh: () => { throw new Error('must not re-enumerate'); } });
      expect(coverage).toMatchObject({ sourceObservationSha256: observation.observationSha256,
        rows: [{ name: 'alpha', status: 'CURRENT' }] });
    } finally {
      fs.rmSync(kb, { recursive: true, force: true });
    }
  });
});
