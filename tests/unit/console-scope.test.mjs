// console-scope.test.mjs — the "what's in the brain" page must derive every verdict from the
// installed brain's own receipts, never from the shipped `status` word.
//
// Written RED against a gatherScope that read `status` and `pushedAt` (2026-09-11). Every fixture row
// below carries a `status` that LIES in some direction, so any reader that trusts it fails here:
//   - release-projection stamps every seeded row CURRENT regardless of SHA (63 real rows differ)
//   - GitHub `updatedAt` bumps on stars/forks (222/227 repos moved on it in one week); `pushedAt`
//     leads the default-branch HEAD on 39/227 — only `committedAt` is the date of the commit the
//     brain actually ingests. Gists have no branches, so their `updatedAt` IS the content date.
//   - a gist row's `artifact.sourceCommit` is null in the shipped COVERAGE.json (479/479); the gist
//     receipt lives in ruv-gists.sources.json as `versionSha`.
//
// Same child-process harness as the other console suites: gather functions read their roots from
// the environment at module load, so every call runs with RUVNET_BRAIN_KB pointed into a scratch dir.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IMPORT, makeRunner, scratch } from './helpers/console-child.mjs';

const OBSERVED = '2026-08-26T18:42:42.525Z';

let tmp, kb, runJSON;
beforeEach(() => {
  tmp = scratch('console-scope-');
  kb = path.join(tmp, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  ({ runJSON } = makeRunner(tmp));
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const repo = (name, over = {}) => ({
  key: `repo:${name}`, kind: 'repository', name, url: `https://github.com/ruvnet/${name}`,
  disposition: 'eligible', status: 'CURRENT', reasons: [],
  upstream: { sha: `${name}-sha`, committedAt: null, pushedAt: null, updatedAt: '2026-09-10T00:00:00Z' },
  artifact: { store: name, sourceCommit: null, ingestedAt: null, rvfSha256: 'x', bytesVerified: true },
  ...over,
});
const gist = (id, name, over = {}) => ({
  key: `gist:${id}`, kind: 'gist', name, url: `https://gist.github.com/ruvnet/${id}`,
  disposition: 'eligible', status: 'CURRENT', reasons: [],
  upstream: { sha: null, updatedAt: null, fileCount: 1, files: [name] },
  artifact: { store: 'ruv-gists', sourceCommit: null, ingestedAt: '2026-08-26T18:28:14.009Z' },
  ...over,
});

function seed({ rows, generations, sources, installed, cards }) {
  fs.writeFileSync(path.join(kb, 'COVERAGE.json'), JSON.stringify({ kind: 'ruvnet-brain-release-coverage', owner: 'ruvnet', observedAt: OBSERVED, rows }));
  fs.writeFileSync(path.join(kb, 'RVF-GENERATIONS.json'), JSON.stringify({ brainVersion: '9.9.9', releaseTag: 'v9.9.9', stores: generations }));
  if (sources) fs.writeFileSync(path.join(kb, 'ruv-gists.sources.json'), JSON.stringify({ owner: 'ruvnet', generated: OBSERVED, gists: sources }));
  if (cards) fs.writeFileSync(path.join(kb, 'capability-cards.md'), cards);
  for (const s of installed) fs.writeFileSync(path.join(kb, `${s}.big.rvf`), 'rvf');
}

// The installed brain ships capability-cards.md (one `## <repo>` section, first line = what it does,
// second line = the auto-derivation note). That is the only per-repo description present on a
// customer machine — data/ruvnet-registry.json is a repo-side file and never installs.
const CARDS = [
  '# Capability cards', '',
  '## alpha', 'Alpha turns commodity WiFi signals into spatial intelligence — federation over the mesh.',
  '(Auto-derived from the repository\'s own description and README; a hand-written card would be better.)', '',
  '## gamma', 'G'.repeat(400),
  '(Auto-derived from the repository\'s own description and README.)', '',
].join('\n');

const FIXTURE = {
  rows: [
    // alpha: brain holds HEAD. status says STALE (a lie) → must be CURRENT. pushedAt/updatedAt newer
    // than committedAt on purpose — only committedAt may surface as "rUv's last change".
    repo('alpha', { status: 'STALE',
      upstream: { sha: 'aaa', committedAt: '2026-08-01T00:00:00Z', pushedAt: '2026-08-20T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' },
      artifact: { store: 'alpha', sourceCommit: 'aaa', ingestedAt: '2026-08-05T00:00:00Z' } }),
    // beta: brain holds an OLDER commit. status says CURRENT (the projection's lie) → must be BEHIND,
    // and with no ingestedAt the read date comes from the generation ledger.
    repo('beta', {
      upstream: { sha: 'bbb2', committedAt: '2026-08-20T00:00:00Z', pushedAt: '2026-08-21T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' },
      artifact: { store: 'beta', sourceCommit: 'bbb1', ingestedAt: null } }),
    // gamma: covered on paper, but no .big.rvf on this machine → NOT IN THE BRAIN, whatever status says.
    repo('gamma', {
      upstream: { sha: 'ccc', committedAt: '2026-07-01T00:00:00Z' },
      artifact: { store: 'gamma', sourceCommit: 'ccc', ingestedAt: '2026-07-02T00:00:00Z' } }),
    // delta-fork: ineligible → excluded from the tables, counted in the footer.
    repo('delta-fork', { disposition: 'fork', status: 'INELIGIBLE',
      upstream: { sha: 'ddd', committedAt: '2026-01-01T00:00:00Z' },
      artifact: { store: 'delta-fork', sourceCommit: null, ingestedAt: null } }),
    // epsilon: installed, but neither COVERAGE nor the ledger records a source commit, and no
    // committedAt → currency UNVERIFIED and the date UNKNOWN. Never "current".
    repo('epsilon', {
      upstream: { sha: 'eee', committedAt: null },
      artifact: { store: 'epsilon', sourceCommit: null, ingestedAt: '2026-08-10T00:00:00Z' } }),
    // g1: gist receipt holds the live revision. status says FAILED (the "sealed to an older
    // enumeration" vocabulary) → must be CURRENT. Date = gist updatedAt.
    gist('g1', 'notes.md', { status: 'FAILED',
      upstream: { sha: 'g1v2', updatedAt: '2026-08-15T00:00:00Z', fileCount: 1, files: ['notes.md'] } }),
    // g2: receipt holds an older revision → BEHIND by 5 days.
    gist('g2', 'old.md', {
      upstream: { sha: 'g2v9', updatedAt: '2026-08-25T00:00:00Z', fileCount: 1, files: ['old.md'] },
      artifact: { store: 'ruv-gists', sourceCommit: null, ingestedAt: '2026-08-20T00:00:00Z' } }),
  ],
  generations: {
    alpha: { builtUtc: '2026-08-05T00:00:00Z', sourceCommit: 'aaa' },
    beta: { builtUtc: '2026-08-18T00:00:00Z', sourceCommit: 'bbb1' },
    epsilon: { builtUtc: '2026-08-10T00:00:00Z', sourceCommit: null },
    'ruv-gists': { builtUtc: '2026-08-26T00:00:00Z', sourceCommit: null },
    zeta: { builtUtc: '2026-08-01T00:00:00Z', sourceCommit: 'zzz' },
  },
  sources: { g1: { versionSha: 'g1v2' }, g2: { versionSha: 'g2v1' } },
  // zeta is installed but appears in no COVERAGE row: "installed locally, outside release coverage".
  installed: ['alpha', 'beta', 'epsilon', 'delta-fork', 'ruv-gists', 'zeta'],
};

const gather = () => runJSON(`${IMPORT} process.stdout.write(JSON.stringify(m.gatherScope()));`);
const byName = (rows, name) => rows.find((r) => r.name === name);

describe('scope — as-of and shape', () => {
  it('passes observedAt through and measures its age; never implies live', () => {
    seed(FIXTURE);
    const s = gather();
    expect(s.available).toBe(true);
    expect(s.observedAt).toBe(OBSERVED);
    expect(typeof s.ageDays).toBe('number');
    expect(s.ageDays).toBeGreaterThan(0);
    expect(s.sentence).toMatch(/on or before the date the brain read it/);
  });

  it('rows never carry the shipped status word, so no client can fall back to it', () => {
    seed(FIXTURE);
    const s = gather();
    for (const r of [...s.repos, ...s.gists]) expect(r).not.toHaveProperty('status');
  });

  it('a store root that never materialized is reported, not invented', () => {
    // no seed at all — kb/ exists but holds nothing
    const s = gather();
    expect(s.available).toBe(false);
    expect(typeof s.reason).toBe('string');
    expect(s.repos).toEqual([]);
  });
});

describe('scope — repos: truth is sourceCommit === upstream.sha, dates are committedAt / ingestedAt', () => {
  it('alpha is CURRENT although status says STALE; its date is committedAt, not pushedAt or updatedAt', () => {
    seed(FIXTURE);
    const a = byName(gather().repos, 'alpha');
    expect(a.bucket).toBe('current');
    expect(a.ruvChangedAt).toBe('2026-08-01T00:00:00Z');
    expect(a.ruvChangedAt).not.toBe('2026-08-20T00:00:00Z'); // pushedAt
    expect(a.ruvChangedAt).not.toBe('2026-09-10T00:00:00Z'); // updatedAt
    expect(a.brainReadAt).toBe('2026-08-05T00:00:00Z');
  });

  it('beta is BEHIND although status says CURRENT; read date falls back to the generation ledger; gap is measured', () => {
    seed(FIXTURE);
    const b = byName(gather().repos, 'beta');
    expect(b.bucket).toBe('behind');
    expect(b.brainReadAt).toBe('2026-08-18T00:00:00Z');
    expect(b.ruvChangedAt).toBe('2026-08-20T00:00:00Z');
    expect(b.behindDays).toBe(2);
    expect(b.brainSha).toBe('bbb1');
    expect(b.upstreamSha).toBe('bbb2');
  });

  it('gamma is NOT IN THE BRAIN because no .big.rvf exists here, although status says CURRENT', () => {
    seed(FIXTURE);
    expect(byName(gather().repos, 'gamma').bucket).toBe('not-in-brain');
  });

  it('epsilon has no recorded source commit and no commit date → UNVERIFIED with an unknown date, never current', () => {
    seed(FIXTURE);
    const e = byName(gather().repos, 'epsilon');
    expect(e.bucket).toBe('unverified');
    expect(e.bucket).not.toBe('current');
    expect(e.ruvChangedAt).toBeNull();
  });

  it('ineligible rows leave the table and land in the count', () => {
    seed(FIXTURE);
    const s = gather();
    expect(byName(s.repos, 'delta-fork')).toBeUndefined();
    expect(s.counts.repos).toEqual({ total: 5, current: 1, behind: 1, unverified: 1, notInBrain: 1, ineligible: 1 });
  });

  it('is sorted by rUv\'s last change, newest first, unknown dates last', () => {
    seed(FIXTURE);
    expect(gather().repos.map((r) => r.name)).toEqual(['beta', 'alpha', 'gamma', 'epsilon']);
  });
});

describe('scope — gists: truth is the gist receipt versionSha, date is updatedAt', () => {
  it('g1 is CURRENT although status says FAILED', () => {
    seed(FIXTURE);
    const g = byName(gather().gists, 'notes.md');
    expect(g.bucket).toBe('current');
    expect(g.ruvChangedAt).toBe('2026-08-15T00:00:00Z');
    expect(g.brainReadAt).toBe('2026-08-26T18:28:14.009Z');
  });

  it('g2 is BEHIND by the measured gap', () => {
    seed(FIXTURE);
    const g = byName(gather().gists, 'old.md');
    expect(g.bucket).toBe('behind');
    expect(g.behindDays).toBe(5);
  });

  it('counts gists independently of repos', () => {
    seed(FIXTURE);
    expect(gather().counts.gists).toEqual({ total: 2, current: 1, behind: 1, unverified: 0, notInBrain: 0, ineligible: 0 });
  });

  it('without a gist receipt set, gists are UNVERIFIED, never current', () => {
    seed({ ...FIXTURE, sources: null });
    const s = gather();
    for (const g of s.gists) expect(g.bucket).toBe('unverified');
  });
});

describe('scope — every row says what the thing DOES, from the installed brain, so search can find it by topic', () => {
  it('a repo\'s desc is the first line of its installed capability card; no card → null, never invented', () => {
    seed({ ...FIXTURE, cards: CARDS });
    const s = gather();
    expect(byName(s.repos, 'alpha').desc).toBe('Alpha turns commodity WiFi signals into spatial intelligence — federation over the mesh.');
    expect(byName(s.repos, 'beta').desc).toBeNull();
  });

  it('a desc is bounded, so a README pasted into a card cannot bloat the page', () => {
    seed({ ...FIXTURE, cards: CARDS });
    const g = byName(gather().repos, 'gamma');
    expect(g.desc.length).toBeLessThanOrEqual(200);
    expect(g.desc.endsWith('…')).toBe(true);
  });

  it('without a cards file every repo desc is null and the page still renders', () => {
    seed(FIXTURE);
    const s = gather();
    expect(s.available).toBe(true);
    for (const r of s.repos) expect(r.desc).toBeNull();
  });

  it('a gist\'s desc is its file names — the only words a gist has', () => {
    seed(FIXTURE);
    const s = gather();
    expect(byName(s.gists, 'notes.md').desc).toBe('notes.md');
    expect(byName(s.gists, 'old.md').desc).toBe('old.md');
  });

  it('a gist with several files lists them all, in order', () => {
    seed({ ...FIXTURE, rows: [...FIXTURE.rows, gist('g3', '1-readme.md', {
      upstream: { sha: 'g3v1', updatedAt: '2026-08-01T00:00:00Z', fileCount: 3, files: ['1-readme.md', '2-tech.md', 'output.txt'] } })],
      sources: { ...FIXTURE.sources, g3: { versionSha: 'g3v1' } } });
    expect(byName(gather().gists, '1-readme.md').desc).toBe('1-readme.md · 2-tech.md · output.txt');
  });
});

describe('scope — the installed root is the arbiter', () => {
  it('names stores installed locally that no coverage row describes', () => {
    seed(FIXTURE);
    const s = gather();
    expect(s.installedOutsideCoverage).toEqual(['zeta']);
    expect(s.installedStoreCount).toBe(6);
  });
});
