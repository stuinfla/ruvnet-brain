// ADR-0091 D5 -- per-store failure isolation. One store failing to refresh must not abort the
// generation: it is carried at its re-hashed seed bytes (STALE + carry), or recorded as MISSING +
// failure when it had none; only transient failures are retried, once, in a fresh directory; QA
// failures are never retried; and past max(3, 5% of eligible) the generation still fails loudly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  acquireSealedGeneration,
  assessCandidateCoverage,
  carriedCommittedAt,
  DEGRADED_UNPUBLISHED_EXIT,
  dispositionForFailedStore,
  executeReconciliation,
  main,
  workerRootFor,
} from '../../scripts/corpus-reconcile.mjs';
import { artifactEvidence, classifyRepository } from '../../scripts/source-coverage.mjs';
import { eligibleRepositoryStanding, validatePublicInventory } from '../../plugin/scripts/coverage-integrity.mjs';
import {
  CORPUS_QA_FAILED_EXIT, degradedBound, degradedPublication, TRANSITION_SOAK_DAYS,
} from '../../scripts/corpus-store-failure.mjs';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-isolation-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const sha = (char) => char.repeat(40);
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const FAMILY = ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json'];
const generation = (store, sourceCommit, rvf) => ({
  file: `${store}.big.rvf`, sourceCommit, bytes: Buffer.byteLength(rvf), sha256: hash(rvf),
  model: 'Xenova/bge-base-en-v1.5', dimensions: 768, builtUtc: '2026-08-20T00:00:00.000Z',
});

/** A seed assets directory whose `seeded` stores carry bytes the ledger binds. */
function seedAssets(seeded = {}) {
  const root = temp();
  const assetsDir = path.join(root, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
  fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
  const stores = {};
  for (const [store, sourceCommit] of Object.entries(seeded)) {
    const rvf = `seed ${store} rvf`;
    for (const suffix of FAMILY) fs.writeFileSync(path.join(assetsDir, `${store}${suffix}`), suffix === '.big.rvf' ? rvf : '{}\n');
    stores[store] = generation(store, sourceCommit, rvf);
  }
  fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores }));
  fs.writeFileSync(path.join(assetsDir, 'SOURCE.json'), JSON.stringify({ builder: 'rvf-kb-forge', stores: {} }));
  return { root, assetsDir, workspaceDir: path.join(root, 'clones') };
}

const item = (store, upstream = sha('a')) => ({ name: store, store, url: `https://github.com/ruvnet/${store}`,
  upstreamSha: upstream, ledgerSourceCommit: null, reason: 'sourceCommit differs' });

/**
 * A fake process runner. `script[store]` is a list of per-attempt behaviours consumed in order:
 * 'ok' | 'clone-fail' (transient) | 'qa' (forge exits CORPUS_QA_FAILED_EXIT) | 'build' (forge exits 1).
 */
function fakeRun(script, calls = []) {
  const attempt = {};
  const storeOf = (dir) => Object.keys(script).find((store) => dir.split(path.sep).some((part) => part === store || part.startsWith(`${store}-retry`)));
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'clone') {
      const store = storeOf(args.at(-1));
      attempt[store] = (attempt[store] ?? -1) + 1;
      if (script[store][attempt[store]] === 'clone-fail') return { status: 128, stdout: '', stderr: 'fatal: unable to access: Connection reset' };
      fs.mkdirSync(args.at(-1), { recursive: true });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${sha('a')}\n`, stderr: '' };
    if (command === process.execPath && String(args[0]).endsWith('forge-refresh.mjs')) {
      const store = args[args.indexOf('--name') + 1];
      const behaviour = script[store][attempt[store]];
      if (behaviour === 'qa') return { status: CORPUS_QA_FAILED_EXIT, stdout: '', stderr: '' };
      if (behaviour === 'build') return { status: 1, stdout: '', stderr: '' };
      const output = args[args.indexOf('--out') + 1];
      const rvf = `fresh ${store} rvf`;
      for (const suffix of FAMILY) fs.writeFileSync(path.join(output, `${store}${suffix}`), suffix === '.big.rvf' ? rvf : '{}\n');
      fs.writeFileSync(path.join(output, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { [store]: generation(store, sha('a'), rvf) } }));
      fs.writeFileSync(path.join(output, 'SOURCE.json'), JSON.stringify({ stores: { [store]: { sourceCommit: sha('a') } } }));
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}
const forgeCalls = (calls, store) => calls.filter((call) => String(call[1]).endsWith('forge-refresh.mjs')
  && call[call.indexOf('--name') + 1] === store);
const cloneTargets = (calls, store) => calls.filter((call) => call[0] === 'git' && call[1] === 'clone')
  .map((call) => call.at(-1)).filter((dir) => dir.includes(`${path.sep}${store}`));

describe('executeReconciliation isolates a failed store (ADR-0091 D5)', () => {
  it('a failed store leaves a hole in the results; the merge skips it instead of throwing on result.files', async () => {
    // alpha sorts FIRST, so its failure is results[0] -- the exact slot the pre-D5 merge read `.files` from.
    const fx = seedAssets({ alpha: sha('0') });
    const result = await executeReconciliation({ plan: [item('alpha'), item('beta')], ...fx,
      run: fakeRun({ alpha: ['qa'], beta: ['ok'] }), log: () => {} });
    expect(result.refreshed).toEqual(['beta']);
    expect(result.carried.map((row) => row.store)).toEqual(['alpha']);
    const ledger = JSON.parse(fs.readFileSync(path.join(fx.assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(ledger.stores.beta.sourceCommit).toBe(sha('a'));
    expect(ledger.stores.alpha.sourceCommit, 'the carried store keeps its seed generation').toBe(sha('0'));
    expect(fs.readFileSync(path.join(fx.assetsDir, 'alpha.big.rvf'), 'utf8')).toBe('seed alpha rvf');
  });

  it('a QA failure is never retried: one forge run, carried with attempts 1', async () => {
    const fx = seedAssets({ alpha: sha('0') });
    const calls = [];
    const result = await executeReconciliation({ plan: [item('alpha')], ...fx,
      run: fakeRun({ alpha: ['qa', 'ok'] }, calls), log: () => {} });
    expect(forgeCalls(calls, 'alpha')).toHaveLength(1);
    expect(result.refreshed).toEqual([]);
    expect(result.carried).toEqual([{ store: 'alpha', carry: {
      reason: 'qa: forge-refresh failed', carriedSourceCommit: sha('0'), missedUpstream: sha('a'),
      attempts: 1, carriedCommittedAt: null } }]);
  });

  it('a build failure (any other forge exit) is not retried either', async () => {
    const fx = seedAssets({ alpha: sha('0') });
    const calls = [];
    const result = await executeReconciliation({ plan: [item('alpha')], ...fx,
      run: fakeRun({ alpha: ['build', 'ok'] }, calls), log: () => {} });
    expect(forgeCalls(calls, 'alpha')).toHaveLength(1);
    expect(result.carried[0].carry).toMatchObject({ reason: 'build: forge-refresh failed', attempts: 1 });
  });

  it('a transient clone failure is retried exactly once, in a FRESH worker directory, and recovers', async () => {
    const fx = seedAssets({ alpha: sha('0') });
    const calls = [];
    const result = await executeReconciliation({ plan: [item('alpha')], ...fx,
      run: fakeRun({ alpha: ['clone-fail', 'ok'] }, calls), log: () => {} });
    expect(result.refreshed).toEqual(['alpha']);
    expect(result.carried).toEqual([]);
    const workspace = path.resolve(fx.workspaceDir);
    expect(cloneTargets(calls, 'alpha')).toEqual([
      path.join(workspace, 'workers', 'alpha', 'clone'),
      path.join(workspace, 'workers', 'alpha-retry1', 'clone'),
    ]);
    expect(forgeCalls(calls, 'alpha')[0]).toContain(path.join(workspace, 'workers', 'alpha-retry1', 'assets'));
  });

  it('a transient failure that persists is retried once only, then carried with attempts 2', async () => {
    const fx = seedAssets({ alpha: sha('0') });
    const calls = [];
    const result = await executeReconciliation({ plan: [item('alpha')], ...fx,
      run: fakeRun({ alpha: ['clone-fail', 'clone-fail', 'ok'] }, calls), log: () => {} });
    expect(cloneTargets(calls, 'alpha')).toHaveLength(2);
    expect(result.carried[0].carry).toMatchObject({ reason: 'transient: git clone failed', attempts: 2 });
  });

  it('the retry directory is a different path from the first attempt\'s', () => {
    expect(workerRootFor('/w', 'alpha', 0)).toBe(path.join('/w', 'workers', 'alpha'));
    expect(workerRootFor('/w', 'alpha', 1)).toBe(path.join('/w', 'workers', 'alpha-retry1'));
    expect(workerRootFor('/w', 'alpha', 1)).not.toBe(workerRootFor('/w', 'alpha', 0));
  });

  it('a failed store with no prior bytes becomes MISSING with a failure record', async () => {
    const fx = seedAssets({});
    const result = await executeReconciliation({ plan: [item('newrepo')], ...fx,
      run: fakeRun({ newrepo: ['qa'] }), log: () => {} });
    expect(result.missing).toEqual([{ store: 'newrepo', failure: { reason: 'qa: forge-refresh failed', attempts: 1 } }]);
    expect(result.carried).toEqual([]);
  });

  it('carried bytes are RE-HASHED against the seed ledger: a mismatch is an integrity failure, not a carry', async () => {
    const fx = seedAssets({ alpha: sha('0') });
    fs.writeFileSync(path.join(fx.assetsDir, 'alpha.big.rvf'), 'tampered bytes');
    const result = await executeReconciliation({ plan: [item('alpha')], ...fx,
      run: fakeRun({ alpha: ['qa'] }), log: () => {} });
    expect(result.carried).toEqual([]);
    expect(result.integrityFailures).toEqual([{ store: 'alpha', integrity: 'carried bytes differ from the seed generation ledger' }]);
  });

  it('a carried store missing a required family file is not carried', () => {
    const fx = seedAssets({ alpha: sha('0') });
    fs.rmSync(path.join(fx.assetsDir, 'alpha.passages.jsonl'));
    const ledger = JSON.parse(fs.readFileSync(path.join(fx.assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(dispositionForFailedStore({ assetsDir: fx.assetsDir, ledger, item: item('alpha'), attempts: 1, reason: 'qa: x' }))
      .toEqual({ store: 'alpha', integrity: 'carried bytes differ from the seed generation ledger' });
  });

  it('a failed same-commit rebuild cannot be carried: the seed bytes are what it was replacing', () => {
    const fx = seedAssets({ alpha: sha('a') });
    const ledger = JSON.parse(fs.readFileSync(path.join(fx.assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(dispositionForFailedStore({ assetsDir: fx.assetsDir, ledger, item: item('alpha'), attempts: 1, reason: 'qa: x' }).integrity)
      .toMatch(/same-commit rebuild/);
  });

  it('carriedCommittedAt comes only from a prior row that observed exactly the carried commit', () => {
    const prior = { rows: [
      { kind: 'repository', artifact: { store: 'alpha' }, upstream: { sha: sha('0'), committedAt: '2026-08-01T00:00:00Z' } },
      { kind: 'repository', artifact: { store: 'beta' }, upstream: { sha: sha('9'), committedAt: '2026-08-02T00:00:00Z' },
        carry: { carriedSourceCommit: sha('0'), carriedCommittedAt: '2026-07-01T00:00:00Z' } },
      { kind: 'repository', artifact: { store: 'gamma' }, upstream: { sha: sha('9'), committedAt: '2026-08-02T00:00:00Z' } },
    ] };
    expect(carriedCommittedAt({ priorCoverage: prior, store: 'alpha', sourceCommit: sha('0') })).toBe('2026-08-01T00:00:00Z');
    expect(carriedCommittedAt({ priorCoverage: prior, store: 'beta', sourceCommit: sha('0') })).toBe('2026-07-01T00:00:00Z');
    expect(carriedCommittedAt({ priorCoverage: prior, store: 'gamma', sourceCommit: sha('0') }), 'never estimated').toBeNull();
    expect(carriedCommittedAt({ priorCoverage: null, store: 'alpha', sourceCommit: sha('0') })).toBeNull();
  });
});

// ---- coverage labels -----------------------------------------------------------------------------
const repoObservation = (name, head) => ({ name, fullName: `ruvnet/${name}`, url: `https://github.com/ruvnet/${name}`,
  isFork: false, isArchived: false, isDisabled: false, pushedAt: '2026-09-27T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z',
  defaultBranchRef: { target: { oid: head, committedDate: '2026-09-27T00:00:00Z' } } });

function rowFor(assetsDir, name, head, outcome = null) {
  const ledger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
  return classifyRepository(repoObservation(name, head), artifactEvidence(assetsDir, ledger, new Set(), name), null, outcome);
}

describe('a carried store is STALE, a storeless one MISSING -- never CURRENT (ADR-0091 D5)', () => {
  const carry = { reason: 'qa: forge-refresh failed', carriedSourceCommit: sha('0'), missedUpstream: sha('a'),
    attempts: 1, carriedCommittedAt: null };

  it('labels a carried store STALE with its carry record, and the shipped validator accepts it', () => {
    const fx = seedAssets({ alpha: sha('0') });
    const row = rowFor(fx.assetsDir, 'alpha', sha('a'), { carry });
    expect(row.status).toBe('STALE');
    expect(row.carry).toEqual(carry);
    expect(eligibleRepositoryStanding(row)).toBe('shipped');
  });

  it('labels an eligible store with no bytes MISSING with its failure record; it ships as absent', () => {
    const fx = seedAssets({});
    const row = rowFor(fx.assetsDir, 'newrepo', sha('a'), { failure: { reason: 'qa: forge-refresh failed', attempts: 1 } });
    expect(row.status).toBe('MISSING');
    expect(eligibleRepositoryStanding(row)).toBe('absent');
  });

  it('never attaches a carry to a row the bytes do not support, and an integrity outcome is FAILED', () => {
    const fx = seedAssets({ alpha: sha('a') });
    const current = rowFor(fx.assetsDir, 'alpha', sha('a'), { carry });
    expect(current.status).toBe('CURRENT');
    expect(current.carry, 'a carry never decorates a CURRENT row').toBeUndefined();
    const failed = rowFor(fx.assetsDir, 'alpha', sha('b'), { integrity: 'carried bytes differ from the seed generation ledger' });
    expect(failed.status).toBe('FAILED');
    expect(eligibleRepositoryStanding(failed)).toBeNull();
  });

  it('the validator keeps rejecting STALE/MISSING without the record, a mismatched carry, FAILED and UNVERIFIED', () => {
    const fx = seedAssets({ alpha: sha('0') });
    const stale = rowFor(fx.assetsDir, 'alpha', sha('a'));
    expect(stale.status).toBe('STALE');
    expect(eligibleRepositoryStanding(stale)).toBeNull();
    expect(eligibleRepositoryStanding({ ...stale, carry: { ...carry, carriedSourceCommit: sha('1') } })).toBeNull();
    expect(eligibleRepositoryStanding({ ...stale, carry: { ...carry, attempts: 0 } })).toBeNull();
    expect(eligibleRepositoryStanding({ ...stale, carry, artifact: { ...stale.artifact, bytesVerified: false } })).toBeNull();
    expect(eligibleRepositoryStanding({ status: 'MISSING', artifact: { store: 'x' } })).toBeNull();
    expect(eligibleRepositoryStanding({ status: 'UNVERIFIED', artifact: { store: 'x' }, carry })).toBeNull();
    expect(eligibleRepositoryStanding({ status: 'CURRENT', artifact: { store: 'x' }, failure: { reason: 'x', attempts: 1 } })).toBeNull();
  });
});

describe('validatePublicInventory over a degraded corpus (ADR-0091 D5)', () => {
  const carry = { reason: 'qa: forge-refresh failed', carriedSourceCommit: sha('0'), missedUpstream: sha('a'),
    attempts: 1, carriedCommittedAt: null };
  const inventory = () => {
    const fx = seedAssets({ alpha: sha('0'), beta: sha('a') });
    fs.writeFileSync(path.join(fx.assetsDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
    fs.writeFileSync(path.join(fx.assetsDir, 'public-store-classes.json'), JSON.stringify({ schemaVersion: 1, derived: [] }));
    const ledger = JSON.parse(fs.readFileSync(path.join(fx.assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    const rows = [
      rowFor(fx.assetsDir, 'alpha', sha('a'), { carry }),
      rowFor(fx.assetsDir, 'beta', sha('a')),
      rowFor(fx.assetsDir, 'newrepo', sha('a'), { failure: { reason: 'qa: forge-refresh failed', attempts: 1 } }),
    ];
    return { ...fx, ledger, rows };
  };

  it('accepts a carried STALE store as shipped and excludes a MISSING-with-failure store from the store set', () => {
    const fx = inventory();
    const result = validatePublicInventory({ assetsDir: fx.assetsDir, coverage: { rows: fx.rows }, ledger: fx.ledger });
    expect(result.repositories).toEqual(['alpha', 'beta']);
    expect(result.publicStores).toEqual(['alpha', 'beta']);
  });

  it('rejects the same bundle when the carried row lost its record (the pre-D5 behaviour, still enforced)', () => {
    const fx = inventory();
    const rows = fx.rows.map((row) => (row.carry ? (({ carry: _c, ...rest }) => rest)(row) : row));
    expect(() => validatePublicInventory({ assetsDir: fx.assetsDir, coverage: { rows }, ledger: fx.ledger }))
      .toThrow(/an eligible repository is not CURRENT \(alpha: STALE/);
  });

  it('rejects a carry whose commit is not the one the ledger carries', () => {
    const fx = inventory();
    const rows = fx.rows.map((row) => (row.carry ? { ...row, artifact: { ...row.artifact, sourceCommit: sha('7') },
      carry: { ...row.carry, carriedSourceCommit: sha('7') } } : row));
    expect(() => validatePublicInventory({ assetsDir: fx.assetsDir, coverage: { rows }, ledger: fx.ledger }))
      .toThrow(/carry record names a source commit the generation ledger does not carry/);
  });

  it('rejects bytes shipped under a MISSING store\'s name (an absent store must ship nothing)', () => {
    const fx = inventory();
    fs.writeFileSync(path.join(fx.assetsDir, 'newrepo.big.rvf'), 'stray');
    expect(() => validatePublicInventory({ assetsDir: fx.assetsDir, coverage: { rows: fx.rows }, ledger: fx.ledger }))
      .toThrow(/unclassified public stores: newrepo/);
  });
});

// ---- the loop, the bound and publication ----------------------------------------------------------
const eligibleRows = (count, overrides = {}) => Array.from({ length: count }, (_, index) => {
  const store = `s${String(index).padStart(3, '0')}`;
  const base = { kind: 'repository', disposition: 'eligible', status: 'CURRENT', name: store, key: `repo:${store}`,
    url: `https://github.com/ruvnet/${store}`, upstream: { sha: sha('a') }, artifact: { store, sourceCommit: sha('a') },
    reasons: [] };
  return { ...base, ...(overrides[store] || {}), artifact: { ...base.artifact, ...(overrides[store]?.artifact || {}) } };
});
const carriedRow = (store) => ({ status: 'STALE', artifact: { store, sourceCommit: sha('0'), bytesVerified: true, passagesPresent: true },
  carry: { reason: 'qa: forge-refresh failed', carriedSourceCommit: sha('0'), missedUpstream: sha('a'), attempts: 1, carriedCommittedAt: null } });

describe('acquireSealedGeneration continues past an isolated failure (ADR-0091 D5)', () => {
  const observation = { observationSha256: 'a'.repeat(64) };
  // A coverage builder that behaves like buildCoverage: a store with a carry outcome is STALE+carry.
  const buildFrom = (count) => vi.fn(async (_observation, outcomes = {}) => ({
    schemaVersion: 1, coverageGeneration: 'g', rows: eligibleRows(count, Object.fromEntries(Object.entries(outcomes)
      .filter(([, outcome]) => outcome.carry).map(([store]) => [store, carriedRow(store)]))),
  }));
  const ledgerAtUpstream = (count, except = []) => () => ({ stores: Object.fromEntries(eligibleRows(count).map(({ artifact }) =>
    [artifact.store, { sourceCommit: except.includes(artifact.store) ? sha('0') : sha('a') }])) });
  const seams = () => ({
    prune: vi.fn(async () => ({ pruned: [] })),
    rebuild: vi.fn(async () => ({ rebuilt: ['ruv-gists', 'concepts'] })),
  });

  it('one carried store does not re-attempt the loop, does not abort, and is reported as degraded', async () => {
    const f = seams();
    const execute = vi.fn(async (plan) => ({ refreshed: plan.filter((row) => row.store !== 's001').map((row) => row.store),
      carried: plan.some((row) => row.store === 's001') ? [{ store: 's001', carry: carriedRow('s001').carry }] : [],
      missing: [], integrityFailures: [] }));
    const result = await acquireSealedGeneration({ maxAttempts: 3, assetsDir: null, observe: async () => observation,
      build: buildFrom(20), readLedger: ledgerAtUpstream(20, ['s001']), execute, ...f });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.rebuild, 'one aggregate rebuild, not three').toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.degraded.carried.map((row) => row.store)).toEqual(['s001']);
    expect(result.coverage.rows.find((row) => row.artifact.store === 's001').status).toBe('STALE');
  });

  it('a store that failed once is not re-executed when a gist move forces another attempt', async () => {
    const f = seams();
    let rebuilds = 0;
    f.rebuild = vi.fn(async () => {
      rebuilds += 1;
      if (rebuilds === 1) throw Object.assign(new Error('gist moved'), { code: 'GIST_OBSERVATION_MOVED' });
      return { rebuilt: [] };
    });
    const planned = [];
    const execute = vi.fn(async (plan) => {
      planned.push(plan.map((row) => row.store));
      return { refreshed: [], carried: plan.filter((row) => row.store === 's001').map(() => ({ store: 's001', carry: carriedRow('s001').carry })),
        missing: [], integrityFailures: [] };
    });
    await acquireSealedGeneration({ maxAttempts: 3, assetsDir: null, observe: async () => observation,
      build: buildFrom(20), readLedger: ledgerAtUpstream(20, ['s001']), execute, ...f });
    expect(planned).toEqual([['s001'], []]);
  });

  it('above max(3, 5% of eligible) the failure is systemic: the generation fails BEFORE prune and rebuild', async () => {
    const f = seams();
    const failing = ['s000', 's001', 's002', 's003'];
    const execute = vi.fn(async () => ({ refreshed: [], missing: [], integrityFailures: [],
      carried: failing.map((store) => ({ store, carry: carriedRow(store).carry })) }));
    await expect(acquireSealedGeneration({ maxAttempts: 3, assetsDir: null, observe: async () => observation,
      build: buildFrom(20), readLedger: ledgerAtUpstream(20, failing), execute, ...f }))
      .rejects.toThrow(/systemic failure: 4 of 20 eligible store\(s\).*max\(3, 5% of eligible\) = 3/s);
    expect(f.prune).not.toHaveBeenCalled();
    expect(f.rebuild).not.toHaveBeenCalled();
  });

  it('exactly at the bound the generation still completes', async () => {
    const f = seams();
    const failing = ['s000', 's001', 's002'];
    const execute = vi.fn(async () => ({ refreshed: [], missing: [], integrityFailures: [],
      carried: failing.map((store) => ({ store, carry: carriedRow(store).carry })) }));
    const result = await acquireSealedGeneration({ maxAttempts: 3, assetsDir: null, observe: async () => observation,
      build: buildFrom(20), readLedger: ledgerAtUpstream(20, failing), execute, ...f });
    expect(result.degraded.carried).toHaveLength(3);
  });

  it('any integrity failure fails the generation at once: FAILED is never shippable', async () => {
    const f = seams();
    const execute = vi.fn(async () => ({ refreshed: [], carried: [], missing: [],
      integrityFailures: [{ store: 's001', integrity: 'carried bytes differ from the seed generation ledger' }] }));
    await expect(acquireSealedGeneration({ maxAttempts: 3, assetsDir: null, observe: async () => observation,
      build: buildFrom(20), readLedger: ledgerAtUpstream(20, ['s001']), execute, ...f }))
      .rejects.toThrow(/integrity failure in 1 store\(s\): s001/);
    expect(f.rebuild).not.toHaveBeenCalled();
  });
});

describe('the candidate gate that replaced strict coverage (ADR-0091 D5)', () => {
  const coverageOf = (rows) => ({ rows });
  it('passes an all-CURRENT corpus and a bounded degraded one, reporting what is degraded', () => {
    expect(assessCandidateCoverage(coverageOf(eligibleRows(20)))).toMatchObject({ carried: [], missing: [], bound: 3 });
    const degraded = assessCandidateCoverage(coverageOf(eligibleRows(20, { s004: carriedRow('s004'),
      s005: { status: 'MISSING', failure: { reason: 'qa: forge-refresh failed', attempts: 1 } } })));
    expect(degraded.carried.map((row) => row.store)).toEqual(['s004']);
    expect(degraded.missing.map((row) => row.store)).toEqual(['s005']);
  });
  it('fails a STALE row without its record, FAILED, and a non-CURRENT gist', () => {
    expect(() => assessCandidateCoverage(coverageOf(eligibleRows(20, { s004: { status: 'STALE' } }))))
      .toThrow(/strict coverage: 1 eligible row\(s\) are not CURRENT and carry no verified carry\/failure record \(s004:STALE\)/);
    expect(() => assessCandidateCoverage(coverageOf(eligibleRows(20, { s004: { status: 'FAILED' } })))).toThrow(/s004:FAILED/);
    expect(() => assessCandidateCoverage(coverageOf([...eligibleRows(20), { kind: 'gist', disposition: 'eligible', status: 'STALE',
      key: 'gist:x', artifact: { store: 'ruv-gists' } }]))).toThrow(/ruv-gists:STALE/);
  });
  it('fails above the bound: 5% of 200 eligible is 10', () => {
    expect(degradedBound(20)).toBe(3);
    expect(degradedBound(200)).toBe(10);
    const eleven = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${String(i).padStart(3, '0')}`, carriedRow(`s${String(i).padStart(3, '0')}`)]));
    expect(() => assessCandidateCoverage(coverageOf(eligibleRows(200, eleven))))
      .toThrow(/11 carried \+ 0 missing store\(s\) exceed max\(3, 5% of 200 eligible\) = 10/);
  });
});

describe('degraded publication waits for the ADR-0091 D10 validator transition', () => {
  it('is refused while no transition is recorded (today) and during the soak, allowed after it', () => {
    expect(degradedPublication()).toMatchObject({ allowed: false, reason: expect.stringMatching(/D10/) });
    const latestSince = '2026-10-01T00:00:00.000Z';
    const during = new Date(Date.parse(latestSince) + (TRANSITION_SOAK_DAYS - 1) * 86400000);
    const after = new Date(Date.parse(latestSince) + TRANSITION_SOAK_DAYS * 86400000);
    expect(degradedPublication({ transition: { version: '4.9.1', latestSince }, now: during }).allowed).toBe(false);
    expect(degradedPublication({ transition: { version: '4.9.1', latestSince }, now: after }).allowed).toBe(true);
    expect(degradedPublication({ transition: { version: '', latestSince }, now: after }).allowed).toBe(false);
  });

  it(`main() prints a sealed degraded generation and exits ${DEGRADED_UNPUBLISHED_EXIT}; an all-CURRENT one exits 0`, async () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'PRIVATE-STORES.json'), '{"privateStores":[]}');
    fs.writeFileSync(path.join(root, 'kb', 'external-sources.json'), '{"sources":[]}');
    fs.writeFileSync(path.join(root, 'kb', 'no-corpus-repos.json'), '{}');
    const makeSeed = () => {
      const staging = path.join(temp(), 'ruvnet-brain');
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, 'RVF-GENERATIONS.json'), '{"schemaVersion":2,"kind":"ruvnet-brain-runtime-generation-ledger","stores":{}}');
      const zip = path.join(path.dirname(staging), 'seed.zip');
      execFileSync('zip', ['-qr', zip, 'ruvnet-brain'], { cwd: path.dirname(staging) });
      return { zip, digest: hash(fs.readFileSync(zip)) };
    };
    const invoke = async (degraded) => {
      const seed = makeSeed();
      const out = [];
      const err = [];
      const code = await main(['--root', root, '--seed-archive', seed.zip, '--seed-tag', `corpus-sha256-${seed.digest}`,
        '--seed-sha256', seed.digest, '--assets', path.join(temp(), 'assets'), '--workspace', path.join(temp(), 'clones'),
        '--builder-sha', sha('c')], {
        reconcileAndPrepare: async () => ({ reconciliation: { observation: {}, attempts: [], degraded },
          candidate: { bundleFile: '/x.zip', degraded } }),
        stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) },
      });
      return { code, out: JSON.parse(out.join('')), err: err.join('') };
    };
    const sealed = await invoke({ carried: [{ store: 'bigstore', ...carriedRow('bigstore').carry }], missing: [] });
    expect(sealed.code).toBe(DEGRADED_UNPUBLISHED_EXIT);
    expect(sealed.out).toMatchObject({ ok: false, bundleFile: '/x.zip',
      degraded: { publishable: false, carried: [{ store: 'bigstore' }] } });
    expect(sealed.err).toMatch(/::warning title=Degraded corpus generation sealed, not published::1 carried \(bigstore\)/);
    const clean = await invoke({ carried: [], missing: [] });
    expect(clean.code).toBe(0);
    expect(clean.out).toMatchObject({ ok: true, degraded: { publishable: true } });
  });
});
