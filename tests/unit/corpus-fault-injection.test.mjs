// THE NIGHTS THAT DIED, replayed (2026-09-21 .. 2026-10-18: 38 corpus nights, 24 failed, 22 in one stage).
// Each case injects the exact cause measured on a real night and asserts the night now does one of two
// things: publishes / no-change with the one store carried AND NAMED, or fails closed only for a genuine
// global invariant. Causes already covered by name elsewhere are referenced, not duplicated:
//   source 404 (12 nights, cognitum-one/ruOS)   tests/unit/source-coverage.test.mjs "an upstream that is gone"
//   corpus-qa failure on one store               tests/unit/corpus-reconcile-isolation.test.mjs
//   canary release read 403 (2026-10-18)         tests/unit/corpus-canary.test.mjs "the 2026-10-18 night"
import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TRANSIENT_CARRY_REASON, TRANSIENT_UNREADABLE_REASON, canonicalJson, canonicalRepositoryRows, classifyRepository,
  observeExternalRepositories, observeGists, observeRepositories } from '../../scripts/source-coverage.mjs';
import { captureGistSources } from '../../scripts/gist-receipts.mjs';
import { acquireSealedGeneration, assessCandidateCoverage, executeReconciliation, transientCarryCommits, TRANSIENT_RETRY_DELAY_MS } from '../../scripts/corpus-reconcile.mjs';
import { storeFreshness } from '../../scripts/corpus-canary.mjs';
import { eligibleRepositoryStanding } from '../../plugin/scripts/coverage-integrity.mjs';
import { CORPUS_QA_FAILED_EXIT } from '../../scripts/corpus-store-failure.mjs';
import { MAX_CORPUS_RUNS_PER_NIGHT, RETRY_CRON, RETRY_WINDOW_MS, decideRetry } from '../../scripts/corpus-dispatch-decision.mjs';

const quiet = () => {};
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const SHA = 'b1762a71bb1ad58b9175e2ae78ed454fed47b655';
const LIVE = 'a'.repeat(40);
const ruos = { store: 'cognitum-ruos', repository: 'cognitum-one/ruOS' };
const liveAnswer = (args) => JSON.stringify(args[1].endsWith('/commits/main')
  ? { sha: LIVE, commit: { committer: { date: '2026-10-01T00:00:00Z' } } }
  : { id: 7, name: 'ruOS', full_name: 'cognitum-one/ruOS', html_url: 'https://github.com/cognitum-one/ruOS',
    default_branch: 'main', fork: false, archived: false, disabled: false, size: 1 });
/** A gh whose first `failures.length` calls throw the given messages, then answers live. */
const flaky = (failures, answer = liveAnswer) => { const queue = [...failures]; const calls = []; const gh = (args) => {
  calls.push(args.join(' ')); if (queue.length) throw new Error(`gh ${args.join(' ')} failed: ${queue.shift()}`); return answer(args); }; return { gh, calls }; };
const evidenceAt = (commit) => ({ receipt: { sourceCommit: commit, sha256: 'x', builtUtc: 't' }, rvfPresent: true, bytesVerified: true, passagesPresent: true, cardPresent: false });

describe('an external source rate-limited or unreadable for a moment (TRANSIENT, then PER-SOURCE)', () => {
  it('a 429 then a 503 on the first read are retried and the LIVE row is used, nothing carried', () => {
    const { gh, calls } = flaky(['API rate limit exceeded (HTTP 429)', 'gh: Service Unavailable (HTTP 503)']);
    const { rows } = observeExternalRepositories([ruos], { gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': SHA } });
    expect(rows[0].upstreamUnavailable).toBeUndefined();
    expect(rows[0].defaultBranchRef.target.oid).toBe(LIVE);
    expect(calls.filter((call) => call === 'api repos/cognitum-one/ruOS')).toHaveLength(3);
  });

  it('still unreadable after the bound: pinned ONE night at the seed ledger commit as STALE + carry, never CURRENT', () => {
    const { gh } = flaky(Array(6).fill('API rate limit exceeded (HTTP 403)'));
    const { rows } = observeExternalRepositories([ruos], { gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': SHA } });
    const [row] = canonicalRepositoryRows(rows);
    expect(row.upstreamUnavailable).toBe(true);
    expect(row.upstreamUnavailableKind).toBe('transient');
    expect(row.upstreamUnavailableReason).toBe(TRANSIENT_UNREADABLE_REASON);
    expect(row.defaultBranchRef.target.oid).toBe(SHA);
    const classified = classifyRepository(row, evidenceAt(SHA));
    // THE REVIEWED BUG: a source nobody read tonight must not look fresh. It is STALE with a recorded carry whose
    // missedUpstream is null (unknown), accepted by the shipped validator, and it counts as a degraded store.
    expect(classified.status).toBe('STALE');
    expect(classified.upstreamUnavailableKind).toBe('transient');
    expect(classified.carry).toEqual({ reason: TRANSIENT_CARRY_REASON, carriedSourceCommit: SHA, missedUpstream: null, attempts: 1, carriedCommittedAt: null });
    expect(classified.reasons.join(' ')).toMatch(/was unreadable this observation .*serving the content last ingested at b1762a71/);
    expect(eligibleRepositoryStanding(classified)).toBe('shipped');
    // The validator admits that shape ONLY with upstreamUnavailable and the carried commit pinned as upstream.
    expect(eligibleRepositoryStanding({ ...classified, upstreamUnavailable: undefined })).toBeNull();
    expect(eligibleRepositoryStanding({ ...classified, upstreamUnavailableKind: 'gone' })).toBeNull();
    expect(eligibleRepositoryStanding({ ...classified, carry: { ...classified.carry, reason: 'qa: forge-refresh failed' } })).toBeNull();
    expect(eligibleRepositoryStanding({ ...classified, upstream: { ...classified.upstream, sha: LIVE } })).toBeNull();
    // The carried bytes must BE the seed's: a ledger at another commit is STALE with NO record, and fails closed.
    const mismatched = classifyRepository(row, evidenceAt(LIVE));
    expect(mismatched.status).toBe('STALE');
    expect(mismatched.carry).toBeUndefined();
    expect(eligibleRepositoryStanding(mismatched)).toBeNull();
    // It counts toward max(3, 5% of eligible) with every other carried store.
    const filler = Array.from({ length: 20 }, (_, i) => ({ kind: 'repository', disposition: 'eligible', status: 'CURRENT', artifact: { store: `s${i}` } }));
    expect(assessCandidateCoverage({ rows: [...filler, classified] }).carried.map((r) => r.store)).toEqual(['cognitum-ruos']);
    const three = ['x', 'y', 'z'].map((s) => ({ kind: 'repository', disposition: 'eligible', status: 'STALE', artifact: { store: s, sourceCommit: SHA, bytesVerified: true, passagesPresent: true },
      upstream: { sha: LIVE }, carry: { reason: 'qa: forge-refresh failed', carriedSourceCommit: SHA, missedUpstream: LIVE, attempts: 1, carriedCommittedAt: null } }));
    expect(() => assessCandidateCoverage({ rows: [...filler, ...three, classified] })).toThrow(/4 carried \+ 0 missing store\(s\) exceed max\(3, 5% of 24 eligible\) = 3/);
  });

  it('the observation digest is a FIXED shape: two nights with different error texts seal identically (no-change stays reachable)', () => {
    const a = observeExternalRepositories([ruos], { gh: flaky(Array(6).fill('HTTP 429')).gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': SHA } });
    const b = observeExternalRepositories([ruos], { gh: flaky(Array(6).fill('gh: Service Unavailable (HTTP 503) at 03:14:15')).gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': SHA } });
    expect(canonicalJson(canonicalRepositoryRows(a.rows))).toBe(canonicalJson(canonicalRepositoryRows(b.rows)));
    expect(a.pages[0].responseDigest).toBe(b.pages[0].responseDigest);
    expect(canonicalJson(a.rows[0])).not.toMatch(/429|503|03:14/);
  });

  it('a SECOND consecutive carry of the same source is refused: the seed coverage already shows it carried (either way)', () => {
    const ledger = { stores: { 'cognitum-ruos': { sourceCommit: SHA }, ruflo: { sourceCommit: LIVE }, broken: { sourceCommit: 'main' } } };
    const clean = { rows: [{ kind: 'repository', artifact: { store: 'cognitum-ruos' }, upstream: { sha: SHA, committedAt: '2026-09-16T08:51:41Z' } }] };
    const carriedLastNight = { rows: [{ kind: 'repository', artifact: { store: 'cognitum-ruos' }, upstreamUnavailable: true, upstreamUnavailableKind: 'transient',
      carry: { reason: TRANSIENT_CARRY_REASON } }] };
    const refreshFailedLastNight = { rows: [{ kind: 'repository', artifact: { store: 'cognitum-ruos' }, upstream: { sha: LIVE },
      carry: { reason: 'qa: forge-refresh failed', carriedSourceCommit: SHA, missedUpstream: LIVE, attempts: 1 } }] };
    // Dated from the seed's own coverage row (carriedCommittedAt), never estimated.
    expect(transientCarryCommits({ ledger, priorCoverage: clean })).toEqual({ 'cognitum-ruos': { sourceCommit: SHA, committedAt: '2026-09-16T08:51:41Z' }, ruflo: { sourceCommit: LIVE, committedAt: null } });
    // FAIL CLOSED: no sealed coverage to prove the allowance is unspent (bootstrap lineage, invalid sidecar) = no carry.
    expect(transientCarryCommits({ ledger, priorCoverage: null })).toEqual({});
    expect(transientCarryCommits({ ledger, priorCoverage: { rows: 'not-an-array' } })).toEqual({});
    // ANY carry last night spends it: transient OR a failed refresh, so the two can never alternate forever.
    expect(transientCarryCommits({ ledger, priorCoverage: carriedLastNight })).toEqual({ ruflo: { sourceCommit: LIVE, committedAt: null } });
    expect(transientCarryCommits({ ledger, priorCoverage: refreshFailedLastNight })).toEqual({ ruflo: { sourceCommit: LIVE, committedAt: null } });
    // A gone (404) row last night is not a carry and does not spend it.
    const goneLastNight = { rows: [{ kind: 'repository', artifact: { store: 'cognitum-ruos' }, upstreamUnavailable: true, upstreamUnavailableKind: 'gone', upstream: { sha: SHA } }] };
    expect(transientCarryCommits({ ledger, priorCoverage: goneLastNight })['cognitum-ruos']).toEqual({ sourceCommit: SHA, committedAt: null });
    // Fed to the observation: the second night fails for that source exactly as before; a clean night carries, dated.
    expect(() => observeExternalRepositories([ruos], { gh: flaky(Array(6).fill('HTTP 429')).gh, sleep: quiet,
      carriedCommits: transientCarryCommits({ ledger, priorCoverage: carriedLastNight }) })).toThrow(/429/);
    const { rows } = observeExternalRepositories([ruos], { gh: flaky(Array(6).fill('HTTP 429')).gh, sleep: quiet,
      carriedCommits: transientCarryCommits({ ledger, priorCoverage: clean }) });
    expect(classifyRepository(canonicalRepositoryRows(rows)[0], evidenceAt(SHA)).carry.carriedCommittedAt).toBe('2026-09-16T08:51:41Z');
  });

  it('the bound is shared by transient and failed-refresh carries: exactly at the bound seals, one over fails', () => {
    const filler = Array.from({ length: 20 }, (_, i) => ({ kind: 'repository', disposition: 'eligible', status: 'CURRENT', artifact: { store: `s${i}` } }));
    const refreshCarry = (s) => ({ kind: 'repository', disposition: 'eligible', status: 'STALE', artifact: { store: s, sourceCommit: SHA, bytesVerified: true, passagesPresent: true },
      upstream: { sha: LIVE }, carry: { reason: 'qa: forge-refresh failed', carriedSourceCommit: SHA, missedUpstream: LIVE, attempts: 1, carriedCommittedAt: null } });
    const transientCarry = (s) => ({ kind: 'repository', disposition: 'eligible', status: 'STALE', upstreamUnavailable: true, upstreamUnavailableKind: 'transient',
      artifact: { store: s, sourceCommit: SHA, bytesVerified: true, passagesPresent: true }, upstream: { sha: SHA },
      carry: { reason: TRANSIENT_CARRY_REASON, carriedSourceCommit: SHA, missedUpstream: null, attempts: 1, carriedCommittedAt: null } });
    // 23 eligible -> bound max(3, 1) = 3: one failed refresh + two unreadable upstreams is exactly the bound.
    const atBound = assessCandidateCoverage({ rows: [...filler, refreshCarry('a'), transientCarry('b'), transientCarry('c')] });
    expect(atBound.carried.map((r) => r.store).sort()).toEqual(['a', 'b', 'c']);
    expect(atBound.bound).toBe(3);
    // 24 eligible, bound still 3: one over, whichever kind the fourth is.
    expect(() => assessCandidateCoverage({ rows: [...filler, refreshCarry('a'), refreshCarry('b'), transientCarry('c'), transientCarry('d')] }))
      .toThrow(/4 carried \+ 0 missing store\(s\) exceed max\(3, 5% of 24 eligible\) = 3/);
    expect(() => assessCandidateCoverage({ rows: [...filler, refreshCarry('a'), transientCarry('b'), transientCarry('c'), transientCarry('d')] }))
      .toThrow(/4 carried \+ 0 missing store\(s\) exceed max\(3, 5% of 24 eligible\) = 3/);
  });

  it('the acquisition loop treats a transiently carried row as resolved (one attempt, not three then failure)', async () => {
    // A plain repository store (cognitum-ruos is capability-only and is always re-planned).
    const carriedRow = { kind: 'repository', disposition: 'eligible', status: 'STALE', name: 'ruos-fixture', key: 'repo:cognitum-one/ruos', url: 'https://github.com/cognitum-one/ruOS',
      upstream: { sha: SHA }, upstreamUnavailable: true, upstreamUnavailableKind: 'transient', reasons: [],
      artifact: { store: 'ruos-fixture', sourceCommit: SHA, bytesVerified: true, passagesPresent: true },
      carry: { reason: TRANSIENT_CARRY_REASON, carriedSourceCommit: SHA, missedUpstream: null, attempts: 1, carriedCommittedAt: null } };
    const build = async () => ({ schemaVersion: 1, coverageGeneration: 'g', rows: [carriedRow] });
    const execute = async () => ({ refreshed: [], carried: [], missing: [], integrityFailures: [] });
    const result = await acquireSealedGeneration({ maxAttempts: 3, assetsDir: null, observe: async () => ({ observationSha256: 'a'.repeat(64) }), build,
      readLedger: () => ({ stores: { 'ruos-fixture': { sourceCommit: SHA } } }), execute, prune: async () => ({ pruned: [] }), rebuild: async () => ({ rebuilt: [] }) });
    expect(result.attempts).toHaveLength(1);
    expect(assessCandidateCoverage(result.coverage).carried.map((r) => r.store)).toEqual(['ruos-fixture']);
  });

  it('the customer canary names a transiently carried store, like any other carried store', () => {
    const after = { observedAt: new Date(Date.now() - 3_600_000).toISOString(), rows: [
      { key: 'repo:a', kind: 'repository', status: 'STALE', upstream: { sha: SHA }, upstreamUnavailable: true, upstreamUnavailableKind: 'transient',
        artifact: { store: 'cognitum-ruos', sourceCommit: SHA, bytesVerified: true, passagesPresent: true },
        carry: { reason: TRANSIENT_CARRY_REASON, carriedSourceCommit: SHA, missedUpstream: null, attempts: 1, carriedCommittedAt: null } },
      { key: 'repo:b', kind: 'repository', status: 'CURRENT', upstream: { sha: LIVE }, artifact: { store: 'ruflo', sourceCommit: LIVE } }] };
    const fresh = storeFreshness({ after, now: Date.now() });
    expect(fresh.ok).toBe(true);
    expect(fresh.detail).toMatch(/0 stale, 1 carried at their last verified bytes with a recorded reason: cognitum-ruos/);
    // The same row with its record stripped is an unrecorded stale store and still FAILS.
    const stripped = { ...after, rows: [(({ carry: _c, ...rest }) => rest)(after.rows[0]), after.rows[1]] };
    expect(storeFreshness({ after: stripped, now: Date.now() }).ok).toBe(true); // pinned == built: nothing to call stale...
    const moved = { ...stripped, rows: [{ ...stripped.rows[0], upstream: { sha: LIVE } }, after.rows[1]] };
    expect(storeFreshness({ after: moved, now: Date.now() })).toMatchObject({ ok: false, detail: expect.stringMatching(/no recorded carry: cognitum-ruos/) });
  });

  it('GLOBAL stays closed: no prior bytes to carry, a bare 403 (a permission answer), or a 404 without ifGone all fail the observation', () => {
    expect(() => observeExternalRepositories([ruos], { gh: flaky(Array(6).fill('HTTP 429')).gh, sleep: quiet, carriedCommits: {} })).toThrow(/429/);
    expect(() => observeExternalRepositories([ruos], { gh: flaky(Array(6).fill('HTTP 429')).gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': 'main' } })).toThrow(/429/);
    expect(() => observeExternalRepositories([ruos], { gh: flaky(['gh: Forbidden (HTTP 403)']).gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': SHA } })).toThrow(/403/);
    expect(() => observeExternalRepositories([ruos], { gh: flaky(['gh: Not Found (HTTP 404)']).gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': SHA } })).toThrow(/404/);
  });

  it('the gone path (ifGone, 404) keeps its wording and still wins over a carried commit', () => {
    const gone = { ...ruos, ifGone: { sourceCommit: SHA, committedAt: '2026-07-02T11:14:33Z' } };
    const { rows } = observeExternalRepositories([gone], { gh: flaky(['gh: Not Found (HTTP 404)']).gh, sleep: quiet, carriedCommits: { 'cognitum-ruos': LIVE } });
    expect(rows[0].defaultBranchRef.target.oid).toBe(SHA);
    expect(classifyRepository(canonicalRepositoryRows(rows)[0], evidenceAt(SHA)).reasons.join(' ')).toMatch(/no longer reachable \(HTTP 404\/410\)/);
  });

  it("the owner's own enumeration survives one 502 (GLOBAL: still fails when GitHub stays down)", () => {
    const page = JSON.stringify({ data: { user: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      { databaseId: 1, name: 'ruflo', url: 'https://github.com/ruvnet/ruflo', isFork: false, defaultBranchRef: { name: 'main', target: { oid: LIVE } } }] } } } });
    const answer = (args) => (args[1] === 'graphql' ? page : JSON.stringify({ public_repos: 1 }));
    expect(observeRepositories('ruvnet', { gh: flaky(['HTTP 502'], answer).gh, sleep: quiet }).rows).toHaveLength(1);
    expect(() => observeRepositories('ruvnet', { gh: flaky(Array(4).fill('HTTP 502'), answer).gh, sleep: quiet })).toThrow(/502/);
  });
});

describe('the gist API rate limit (2026-09-26) and a gist clone blip', () => {
  it('a rate-limited gist LIST is retried before the anonymous fallback is ever tried', () => {
    const gists = [{ id: 'g1', files: {} }];
    const { gh, calls } = flaky(['API rate limit exceeded for installation (HTTP 403)'],
      (args) => (String(args[1]).includes('gists') ? JSON.stringify(gists) : JSON.stringify({ public_gists: 1 })));
    const curl = () => { throw new Error('the anonymous fallback must not be reached'); };
    expect(observeGists('ruvnet', { gh, curl, sleep: quiet }).rows).toEqual(gists);
    expect(calls.filter((call) => call.includes('gists'))).toHaveLength(2);
  });

  it('a transient gist Git clone is retried, bounded; a gist that is gone is an answer, thrown at once', async () => {
    const observation = { owner: 'ruvnet', observedAt: '2026-10-20T07:17:00Z', observationSha256: 'f'.repeat(64),
      gists: { rows: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', updated_at: '2026-10-19T00:00:00Z', truncated: false, files: { 'a.md': { filename: 'a.md', size: 2 } } }] } };
    const snapshot = { headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), treeFileCount: 1, files: [{ filename: 'a.md', size: 2, body: Buffer.from('hi'),
      sourceGit: { headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40), blobSha: 'd'.repeat(40) } }] };
    let attempts = 0;
    const transport = async () => { attempts += 1; if (attempts === 1) throw new Error('gist Git transport failed (exit 128): fatal: unable to access: Connection reset by peer'); return snapshot; };
    const captured = await captureGistSources({ observation, fetchGitSnapshot: transport, snapshotRetryDelayMs: 0 });
    expect(attempts).toBe(2);
    expect(captured.gists.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.versionSha).toBe('b'.repeat(40));
    let gone = 0;
    await expect(captureGistSources({ observation, snapshotRetryDelayMs: 0,
      fetchGitSnapshot: async () => { gone += 1; throw new Error('gist Git transport failed (exit 128): fatal: repository not found'); } }))
      .rejects.toThrow(/repository not found/);
    expect(gone).toBe(1);
  });
});

describe("git's credential prompt on a clone (2026-10-17: 'could not read Username') -- PER-SOURCE", () => {
  const FAMILY = ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json'];
  // A plain repository store: the real cognitum-ruos is capability-only, whose worker output has its own shape.
  const STORE = 'ruos-fixture';
  const fixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fault-injection-'));
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.mkdirSync(assetsDir);
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    const rvf = 'seed ruos rvf';
    for (const suffix of FAMILY) fs.writeFileSync(path.join(assetsDir, `${STORE}${suffix}`), suffix === '.big.rvf' ? rvf : '{}\n');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { [STORE]: {
      file: `${STORE}.big.rvf`, sourceCommit: SHA, bytes: Buffer.byteLength(rvf), sha256: hash(rvf),
      model: 'Xenova/bge-base-en-v1.5', dimensions: 768, builtUtc: '2026-08-20T00:00:00.000Z' } } }));
    fs.writeFileSync(path.join(assetsDir, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', stores: {} }));
    return { root, assetsDir, workspaceDir: path.join(root, 'clones') };
  };
  const item = { name: STORE, store: STORE, url: 'https://github.com/cognitum-one/ruOS', upstreamSha: LIVE, ledgerSourceCommit: SHA, reason: 'sourceCommit differs' };
  const PROMPT = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";

  it('a persistent prompt (the repository is gone or private) is retried once after the delay, then the store is CARRIED, named, with reason and attempts', async () => {
    const fx = fixture();
    const slept = [];
    const result = await executeReconciliation({ plan: [item], ...fx, log: quiet, sleep: async (ms) => { slept.push(ms); }, retryDelayMs: TRANSIENT_RETRY_DELAY_MS,
      run: (command, args) => (command === 'git' && args[0] === 'clone' ? { status: 128, stdout: '', stderr: PROMPT } : { status: 0, stdout: '', stderr: '' }) });
    expect(TRANSIENT_RETRY_DELAY_MS).toBe(30_000);
    expect(slept).toEqual([TRANSIENT_RETRY_DELAY_MS]);
    expect(result.refreshed).toEqual([]);
    expect(result.carried).toEqual([{ store: STORE, carry: { reason: 'transient: git clone failed', carriedSourceCommit: SHA,
      missedUpstream: LIVE, attempts: 2, carriedCommittedAt: null } }]);
    expect(result.integrityFailures).toEqual([]);
  });

  it('a one-off prompt recovers on the retry and the generation is not degraded', async () => {
    const fx = fixture();
    let clones = 0;
    const run = (command, args) => {
      if (command === 'git' && args[0] === 'clone') { clones += 1; if (clones === 1) return { status: 128, stdout: '', stderr: PROMPT }; fs.mkdirSync(args.at(-1), { recursive: true }); return { status: 0, stdout: '', stderr: '' }; }
      if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${LIVE}\n`, stderr: '' };
      if (command === process.execPath) {
        const output = args[args.indexOf('--out') + 1];
        const rvf = 'fresh ruos rvf';
        for (const suffix of FAMILY) fs.writeFileSync(path.join(output, `${STORE}${suffix}`), suffix === '.big.rvf' ? rvf : '{}\n');
        fs.writeFileSync(path.join(output, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { [STORE]: { file: `${STORE}.big.rvf`, sourceCommit: LIVE,
          bytes: Buffer.byteLength(rvf), sha256: hash(rvf), model: 'm', dimensions: 1, builtUtc: 't' } } }));
        fs.writeFileSync(path.join(output, 'SOURCE.json'), JSON.stringify({ stores: { [STORE]: { sourceCommit: LIVE } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await executeReconciliation({ plan: [item], ...fx, log: quiet, sleep: async () => {}, run });
    expect(clones).toBe(2);
    expect(result.refreshed).toEqual([STORE]);
    expect(result.carried).toEqual([]);
  });

  it('a corpus-qa refusal is never retried and never sleeps (the deterministic class)', async () => {
    const fx = fixture();
    const slept = [];
    const result = await executeReconciliation({ plan: [item], ...fx, log: quiet, sleep: async (ms) => { slept.push(ms); },
      run: (command, args) => (command === 'git' && args[0] === 'clone' ? (fs.mkdirSync(args.at(-1), { recursive: true }), { status: 0, stdout: '', stderr: '' })
        : command === 'git' && args.includes('rev-parse') ? { status: 0, stdout: `${LIVE}\n`, stderr: '' }
          : command === process.execPath ? { status: CORPUS_QA_FAILED_EXIT, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' }) });
    expect(slept).toEqual([]);
    expect(result.carried[0].carry).toMatchObject({ reason: 'qa: forge-refresh failed', attempts: 1 });
  });
});

describe('the whole-night safety net: one retry, never a loop, never a double publish', () => {
  const run = (id, outcome, conclusion = 'failure') => ({ id, outcome, conclusion });
  it('retries exactly when the only run of the night failed, or reached no outcome WITHOUT concluding success', () => {
    expect(decideRetry({ runs: [run(1, 'failed')] })).toMatchObject({ verdict: 'retry', reason: expect.stringMatching(/run 1 failed/) });
    expect(decideRetry({ runs: [run(1, 'unknown', 'cancelled')] }).verdict).toBe('retry');
    // A GREEN run that reached no outcome is a workflow defect (corpus-terminal-outcome fails it loudly), not weather.
    expect(decideRetry({ runs: [run(1, 'unknown', 'success')] })).toMatchObject({ verdict: 'stand-down', reason: /run 1 ended unknown/ });
  });
  it.each(['published', 'no-change', 'superseded', 'canary-rejected'])('%s is an answer: stand down even beside a failed run', (outcome) => {
    expect(decideRetry({ runs: [run(1, 'failed'), run(2, outcome)] })).toMatchObject({ verdict: 'stand-down', reason: expect.stringMatching(new RegExp(`run 2 ended ${outcome}`)) });
  });
  it('a run still in progress, or no run at all, stands down', () => {
    expect(decideRetry({ runs: [run(1, 'in-progress')] })).toMatchObject({ verdict: 'stand-down', reason: /still in progress/ });
    expect(decideRetry({ runs: [] })).toMatchObject({ verdict: 'stand-down', reason: /dispatched no corpus run/ });
  });
  it(`BOUND: ${MAX_CORPUS_RUNS_PER_NIGHT} failed runs already means the retry was spent`, () => {
    expect(MAX_CORPUS_RUNS_PER_NIGHT).toBe(2);
    expect(decideRetry({ runs: [run(1, 'failed'), run(2, 'failed')] })).toMatchObject({ verdict: 'stand-down', reason: /bound is 2 per night/ });
  });
  it('the retry window reaches back past the 05:17 UTC first slot and never into the previous night', () => {
    expect(RETRY_CRON).toBe('17 9 * * *');
    expect(RETRY_WINDOW_MS).toBeGreaterThan(4 * 3_600_000);
    expect(RETRY_WINDOW_MS).toBeLessThan(24 * 3_600_000);
  });
});
