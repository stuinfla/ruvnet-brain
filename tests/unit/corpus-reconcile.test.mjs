import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertBootstrapIdentity,
  assertPathNotOverlapping,
  executeReconciliation,
  normalizeExtractedCorpus,
  planReconciliation,
  prepareCorpusCandidate,
  pruneIneligibleStores,
  acquireCorpusGeneration,
  acquireSealedGeneration,
  seedPrivateFenceEvidence,
} from '../../scripts/corpus-reconcile.mjs';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-reconcile-'));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (temps.length) fs.rmSync(temps.pop(), { recursive: true, force: true });
});

const sha = (char) => char.repeat(40);
const coverage = (rows) => ({ schemaVersion: 1, coverageGeneration: 'generation-1', rows });
const repo = ({ name, store = name.toLowerCase(), upstream = sha('a'), disposition = 'eligible' }) => ({
  key: `repo:${name}`,
  kind: 'repository',
  name,
  url: `https://github.com/ruvnet/${name}`,
  disposition,
  upstream: { sha: upstream },
  artifact: { store },
});

describe('exact corpus bootstrap identity', () => {
  it('accepts only a digest-derived tag whose downloaded archive has the configured sha256', () => {
    const root = temp();
    const archive = path.join(root, 'ruvnet-brain.zip');
    fs.writeFileSync(archive, 'sealed corpus bytes');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    expect(assertBootstrapIdentity({ archiveFile: archive, tag: `corpus-sha256-${digest}`, sha256: digest }))
      .toEqual({ tag: `corpus-sha256-${digest}`, sha256: digest });
    expect(() => assertBootstrapIdentity({ archiveFile: archive, tag: 'latest', sha256: digest }))
      .toThrow(/digest-derived tag/i);
    expect(() => assertBootstrapIdentity({ archiveFile: archive, tag: `corpus-sha256-${'0'.repeat(64)}`, sha256: '0'.repeat(64) }))
      .toThrow(/downloaded archive sha256/i);
  });

  it('normalizes the one archive root and rejects ambiguous or pre-fenced seed contents', () => {
    const root = temp();
    const extracted = path.join(root, 'extracted');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(path.join(extracted, 'ruvnet-brain'), { recursive: true });
    fs.writeFileSync(path.join(extracted, 'ruvnet-brain', 'RVF-GENERATIONS.json'), '{"stores":{}}');
    fs.writeFileSync(path.join(extracted, 'ruvnet-brain', 'alpha.big.rvf'), 'rvf');
    expect(normalizeExtractedCorpus({ extractedDir: extracted, assetsDir: assets })).toBe(assets);
    expect(fs.existsSync(path.join(assets, 'alpha.big.rvf'))).toBe(true);

    const ambiguous = path.join(root, 'ambiguous');
    fs.mkdirSync(path.join(ambiguous, 'one'), { recursive: true });
    fs.mkdirSync(path.join(ambiguous, 'two'), { recursive: true });
    fs.writeFileSync(path.join(ambiguous, 'one', 'RVF-GENERATIONS.json'), '{"stores":{}}');
    fs.writeFileSync(path.join(ambiguous, 'two', 'RVF-GENERATIONS.json'), '{"stores":{}}');
    expect(() => normalizeExtractedCorpus({ extractedDir: ambiguous, assetsDir: path.join(root, 'bad-assets') }))
      .toThrow(/exactly one RVF-GENERATIONS/i);

    // A published seed's own PRIVATE-STORES.json is accepted as AUTHENTICATED HISTORICAL EVIDENCE
    // (task 4 / ADR bootstrap-fence correction) — never as current policy. It is kept aside under a
    // distinct name so it can never shadow or be overwritten by the exact builder checkout's own
    // canonical fence (copied in by main(), after normalizeExtractedCorpus returns).
    const fenced = path.join(root, 'fenced');
    fs.mkdirSync(fenced, { recursive: true });
    fs.writeFileSync(path.join(fenced, 'RVF-GENERATIONS.json'), '{"stores":{}}');
    fs.writeFileSync(path.join(fenced, 'alpha.big.rvf'), 'rvf');
    fs.writeFileSync(path.join(fenced, 'PRIVATE-STORES.json'), '{"privateStores":["secret"]}');
    const fencedAssets = path.join(root, 'fenced-assets');
    expect(normalizeExtractedCorpus({ extractedDir: fenced, assetsDir: fencedAssets })).toBe(fencedAssets);
    expect(fs.existsSync(path.join(fencedAssets, 'PRIVATE-STORES.json'))).toBe(false);
    expect(fs.existsSync(path.join(fencedAssets, 'SEED-PRIVATE-STORES.json'))).toBe(true);
    expect(seedPrivateFenceEvidence(fencedAssets)).toMatchObject({
      file: 'SEED-PRIVATE-STORES.json', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: expect.any(Number),
    });
    // No historical fence at all: evidence is simply absent, never fabricated.
    expect(seedPrivateFenceEvidence(assets)).toBeNull();
  });
});

describe('reconciliation planning', () => {
  it('plans only eligible repositories whose ledger sourceCommit is absent or differs', () => {
    const rows = [
      repo({ name: 'alpha', upstream: sha('a') }),
      repo({ name: 'beta', upstream: sha('b') }),
      repo({ name: 'gamma', upstream: sha('c'), disposition: 'fork' }),
      { key: 'gist:1', kind: 'gist', disposition: 'eligible', upstream: { sha: sha('d') }, artifact: { store: 'ruv-gists' } },
    ];
    const ledger = { stores: {
      alpha: { sourceCommit: sha('0') },
      beta: { sourceCommit: sha('b') },
    } };
    expect(planReconciliation({ coverage: coverage(rows), ledger })).toEqual([{
      name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: sha('0'), reason: 'sourceCommit differs',
    }]);
  });

  it('fails closed on ambiguous, malformed, or non-GitHub eligible repository evidence', () => {
    const ledger = { stores: {} };
    expect(() => planReconciliation({ coverage: coverage([
      repo({ name: 'alpha', store: 'same' }), repo({ name: 'beta', store: 'same' }),
    ]), ledger })).toThrow(/duplicate eligible store/i);
    expect(() => planReconciliation({ coverage: coverage([
      { ...repo({ name: 'alpha' }), upstream: { sha: 'main' } },
    ]), ledger })).toThrow(/upstream SHA/i);
    expect(() => planReconciliation({ coverage: coverage([
      { ...repo({ name: 'alpha' }), url: 'https://example.com/alpha' },
    ]), ledger })).toThrow(/GitHub repository URL/i);
  });

  it('rebuilds a source-current store when its generation receipt does not bind the seed bytes', () => {
    const assetsDir = temp();
    fs.writeFileSync(path.join(assetsDir, 'alpha.big.rvf'), 'actual seed bytes');
    const rows = [repo({ name: 'alpha', upstream: sha('a') })];
    const ledger = { stores: { alpha: {
      file: 'alpha.big.rvf', sourceCommit: sha('a'), bytes: 1, sha256: '0'.repeat(64),
    } } };
    expect(planReconciliation({ coverage: coverage(rows), ledger, assetsDir })).toEqual([{
      name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: sha('a'),
      reason: 'generation receipt differs from seed bytes',
    }]);
  });
});

describe('reconciliation execution', () => {
  it('fresh-clones, checks out and verifies the exact SHA before forge-refresh, then verifies the ledger', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    const workspaceDir = path.join(root, 'clones');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    const ledgerFile = path.join(assetsDir, 'RVF-GENERATIONS.json');
    fs.writeFileSync(ledgerFile, JSON.stringify({ stores: { alpha: { sourceCommit: sha('0') } } }));
    const plan = [{ name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: sha('0'), reason: 'sourceCommit differs' }];
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${sha('a')}\n`, stderr: '' };
      if (command === process.execPath && args[0].replaceAll('\\', '/').endsWith('kb/forge-refresh.mjs')) {
        const output = args[args.indexOf('--out') + 1];
        fs.writeFileSync(path.join(output, 'alpha.big.rvf'), 'rvf');
        fs.writeFileSync(path.join(output, 'alpha.big.rvf.idmap.json'), '{}');
        fs.writeFileSync(path.join(output, 'alpha.big.rvf.embed.json'), '{}');
        fs.writeFileSync(path.join(output, 'alpha.passages.jsonl'), '{}\n');
        fs.writeFileSync(path.join(output, 'alpha.meta.json'), '{}');
        fs.writeFileSync(path.join(output, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
          alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a'), bytes: 3,
            sha256: crypto.createHash('sha256').update('rvf').digest('hex') },
        } }));
        fs.writeFileSync(path.join(output, 'SOURCE.json'), JSON.stringify({ stores: { alpha: { sourceCommit: sha('a') } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(executeReconciliation({ plan, assetsDir, workspaceDir, root, run })).resolves.toMatchObject({ refreshed: ['alpha'] });
    expect(calls).toEqual(expect.arrayContaining([
      ['git', 'clone', '--no-checkout', '--filter=blob:none', 'https://github.com/ruvnet/alpha', expect.stringContaining('alpha')],
      ['git', '-C', expect.stringContaining('alpha'), 'fetch', '--depth=1', 'origin', sha('a')],
      ['git', '-C', expect.stringContaining('alpha'), 'checkout', '--detach', sha('a')],
      [process.execPath, expect.stringMatching(/kb[\\/]forge-refresh\.mjs$/), '--repo', expect.stringContaining('alpha'), '--out', expect.stringMatching(/workers[\\/]alpha[\\/]assets$/), '--name', 'alpha'],
    ]));
    expect(calls.find((call) => call[0] === process.execPath))
      .toBeTruthy();
  });

  it('stops when forge-refresh does not produce the exact upstream ledger receipt', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {} }));
    const plan = [{ name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha',
      upstreamSha: sha('a'), ledgerSourceCommit: null, reason: 'missing ledger receipt' }];
    const run = (command, args) => {
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${sha('a')}\n`, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    await expect(executeReconciliation({ plan, assetsDir, workspaceDir: path.join(root, 'clones'), root, run }))
      .rejects.toThrow(/worker artifact family is incomplete|did not bind alpha to the exact upstream SHA/i);
  });

  // Required proof 4 (2026-09-13): a worker failure must abort and join its still-running siblings
  // -- no orphaned processes, no unhandled rejection from a sibling that finishes after the pool has
  // already been given up on. Before this fix `executeReconciliation` had no cancellation at all: a
  // failing lane's `Promise.all` member rejected immediately while sibling lanes kept running,
  // completely unobserved.
  it('aborts and joins still-running sibling workers when one worker fails mid-round', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    const workspaceDir = path.join(root, 'clones');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {} }));
    const plan = [
      { name: 'alpha', store: 'alpha', url: 'https://github.com/ruvnet/alpha', upstreamSha: sha('a'), ledgerSourceCommit: null, reason: 'missing ledger receipt' },
      { name: 'beta', store: 'beta', url: 'https://github.com/ruvnet/beta', upstreamSha: sha('b'), ledgerSourceCommit: null, reason: 'missing ledger receipt' },
    ];
    let betaCloneStarted = false;
    let betaSawAbort = false;
    const run = (command, args, options = {}) => {
      if (command === 'git' && args[0] === 'clone') {
        fs.mkdirSync(args.at(-1), { recursive: true });
        const isBeta = args.at(-1).includes('beta');
        if (!isBeta) return Promise.resolve({ status: 1, stdout: '', stderr: 'simulated alpha clone failure' });
        // beta hangs -- exactly like a real long-running clone would -- until the shared signal
        // aborts it, proving the still-running sibling is actually joined, not left dangling.
        betaCloneStarted = true;
        return new Promise((resolve) => {
          options.signal?.addEventListener('abort', () => {
            betaSawAbort = true;
            resolve({ status: null, error: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
          }, { once: true });
        });
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    await expect(executeReconciliation({ plan, assetsDir, workspaceDir, root, run, concurrency: 2 }))
      .rejects.toThrow(/simulated alpha clone failure/);
    expect(betaCloneStarted, 'beta must actually have started, or this test guards nothing').toBe(true);
    expect(betaSawAbort, 'beta must have observed the shared abort signal and joined promptly').toBe(true);
  });
});

describe('candidate preparation', () => {
  // Step 4, rules 5-6 (2026-09-13): prepareCorpusCandidate used to shell out to
  // `source-coverage.mjs --write` then `--check --strict` -- two SEPARATE live re-observations of
  // the real source universe, run AFTER reconciliation had already stabilized. It now trusts an
  // already-measured `coverage` object outright and renders both the committed JSON and Markdown
  // from that one object, never touching source-coverage.mjs at all.
  const coverageFixture = (status) => ({
    kind: 'ruvnet-brain-corpus-coverage', observedAt: '2026-09-13T00:00:00.000Z', coverageGeneration: 'gen-1',
    totals: { repositories: 1, gists: 0, byStatus: { [status]: 1 } },
    rows: [{ kind: 'repository', name: 'alpha', url: 'https://github.com/ruvnet/alpha', disposition: 'eligible',
      status, upstream: {}, artifact: {}, reasons: status === 'CURRENT' ? [] : ['x'] }],
  });

  // ADR-086 Step 15 wired the C3 retrieval-accuracy benchmark into this function, so a candidate root
  // needs the benchmark script and the committed oracle as well as the two older builders. The
  // 2026-09-15 amendment added the BLOCKING repo-recall gate beside it, which brings two more hard
  // inputs — the frozen fixture and the ratchet floor — checked before assembly for the same reason:
  // a missing one must fail in seconds, not after an hour of building.
  const candidateRoot = ({ oracle = true, recallInputs = true } = {}) => {
    const keys = crypto.generateKeyPairSync('ed25519');
    vi.stubEnv('RUVNET_MEASUREMENT_SIGNING_KEY',keys.privateKey.export({type:'pkcs8',format:'pem'}));
    vi.stubEnv('RUVNET_MEASUREMENT_PUBLIC_KEY',keys.publicKey.export({type:'spki',format:'pem'}));
    const root = temp();
    fs.mkdirSync(path.join(root, 'scripts', 'oracle'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const file of ['build-bundle.mjs', 'corpus-candidate.mjs']) {
      fs.writeFileSync(path.join(root, 'scripts', file), '// fixture');
    }
    for (const file of ['retrieval-accuracy.mjs', 'repo-recall.mjs']) {
      fs.writeFileSync(path.join(root, 'scripts', 'oracle', file), '// fixture');
    }
    if (oracle) fs.writeFileSync(path.join(root, 'data', 'retrieval-accuracy-oracle.json'), '{}');
    if (recallInputs) {
      fs.writeFileSync(path.join(root, 'data', 'retrieval-query-evidence.json'), '{}');
      fs.writeFileSync(path.join(root, 'data', 'repo-recall-floor.json'), '{}');
    }
    return root;
  };

  it('MUST BLOCK: a checkout missing the frozen fixture assembles nothing at all', () => {
    const coverage = coverageFixture('CURRENT');
    const run = () => ({ status: 0, stdout: '', stderr: '' });
    const attempt = () => prepareCorpusCandidate({
      root: candidateRoot({ recallInputs: false }),
      assets: path.join(temp(), 'assets'),
      candidate: path.join(temp(), 'out', 'ruvnet-brain'),
      receipt: path.join(temp(), 'out', 'corpus-receipt.json'),
      policy: path.join(temp(), 'out', 'coverage.json'),
      builderSha: 'a'.repeat(40),
      coverage,
      run,
    });
    expect(attempt).toThrow(/repo-recall gate input missing/i);
  });

  it('never re-observes live sources; renders coverage JSON+Markdown from one object, then builds and seals', () => {
    const root = candidateRoot();
    const coverage = coverageFixture('CURRENT');
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    const result = prepareCorpusCandidate({
      root,
      assetsDir: path.join(root, 'assets'),
      builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage,
      run,
    });
    expect(result.bundleFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip'));
    const joined = calls.map((call) => call.join(' '));
    // Step 15 plus the 2026-09-15 amendment: assembly, THEN the C3 benchmark against the assembled
    // archive, THEN the BLOCKING repo-recall gate against the same archive, THEN the seal that binds
    // both reports, THEN independent re-verification. Order is the contract: a measurement run before
    // assembly would measure nothing, and one after the seal could not be bound by it.
    expect(joined).toHaveLength(5);
    expect(joined[0]).toMatch(/build-bundle\.mjs/);
    expect(joined[1]).toMatch(/oracle\/retrieval-accuracy\.mjs .*--bundle .*ruvnet-brain\.zip/);
    expect(joined[1]).toMatch(/--out .*ruvnet-brain\.zip\.accuracy\.json/);
    expect(joined[1]).not.toMatch(/--stores|--sample/);
    expect(joined[2]).toMatch(/oracle\/repo-recall\.mjs .*--bundle .*ruvnet-brain\.zip/);
    expect(joined[2]).toMatch(/--out .*ruvnet-brain\.zip\.recall\.json/);
    expect(joined[3]).toMatch(/corpus-candidate\.mjs/);
    expect(joined[3]).not.toMatch(/--verify/);
    expect(joined[3]).toMatch(/--accuracy-report .*ruvnet-brain\.zip\.accuracy\.json/);
    expect(joined[3]).toMatch(/--recall-report .*ruvnet-brain\.zip\.recall\.json/);
    expect(joined[4]).toMatch(/corpus-candidate\.mjs .*--verify/);
    expect(joined[4]).toMatch(/--recall-report .*ruvnet-brain\.zip\.recall\.json/);
    expect(result.accuracyReportFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip.accuracy.json'));
    expect(result.recallReportFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip.recall.json'));
    expect(joined.join('\n')).not.toMatch(/corpus-seed-publish|release create|--publish|source-coverage\.mjs/);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'data', 'source-coverage.json'), 'utf8'))).toEqual(coverage);
    expect(fs.readFileSync(path.join(root, 'docs', 'RUVNET-COVERAGE.md'), 'utf8')).toContain('alpha');
  });

  it('rejects missing and mismatched measurement authority before assembly', () => {
    const root=candidateRoot(); const run=vi.fn(()=>({status:0}));
    const args={root,assetsDir:path.join(root,'assets'),builderSha:sha('a'),coverage:coverageFixture('CURRENT'),run};
    vi.stubEnv('RUVNET_MEASUREMENT_SIGNING_KEY','');
    expect(()=>prepareCorpusCandidate(args)).toThrow(/keys are required/);expect(run).not.toHaveBeenCalled();
    const wrong=crypto.generateKeyPairSync('ed25519');
    vi.stubEnv('RUVNET_MEASUREMENT_SIGNING_KEY',wrong.privateKey.export({type:'pkcs8',format:'pem'}));
    expect(()=>prepareCorpusCandidate(args)).toThrow(/does not match/);expect(run).not.toHaveBeenCalled();
  });

  it('allows an absent informational floor and passes complete seed provenance into one assembly', () => {
    const root=candidateRoot();fs.rmSync(path.join(root,'data','repo-recall-floor.json'));
    const calls=[];const run=(_command,args)=>{calls.push(args);return{status:0}};
    prepareCorpusCandidate({root,assetsDir:path.join(root,'assets'),builderSha:sha('a'),coverage:coverageFixture('CURRENT'),run,
      bootstrapIdentity:{tag:'corpus-sha256-'+'b'.repeat(64),sha256:'b'.repeat(64),archiveBytes:123,baselineReceiptSha256:'c'.repeat(64)}});
    expect(calls.filter(args=>args[0].endsWith('build-bundle.mjs'))).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['--seed-bytes','123','--baseline-receipt-sha256','c'.repeat(64),'--source-snapshot',sha('a')]));
  });

  it('fails closed on any non-CURRENT eligible row, before ever shelling out to build or seal', () => {
    const root = candidateRoot();
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    expect(() => prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage: coverageFixture('STALE'), run,
    })).toThrow(/strict coverage/i);
    expect(calls).toHaveLength(0);
  });

  it('MUST BLOCK: no committed retrieval-accuracy oracle means nothing is assembled at all', () => {
    const root = candidateRoot({ oracle: false });
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    expect(() => prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage: coverageFixture('CURRENT'), run,
    })).toThrow(/retrieval-accuracy oracle missing/i);
    // Fails BEFORE the expensive single-pass assembly, not after it.
    expect(calls).toHaveLength(0);
  });

  it('a bounded measurement is opt-in and passes its bounds straight through to the benchmark', () => {
    const root = candidateRoot();
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      coverage: coverageFixture('CURRENT'), accuracyStores: 2, accuracySample: 5, run,
    });
    const benchmark = calls.map((call) => call.join(' ')).find((call) => /retrieval-accuracy\.mjs/.test(call));
    expect(benchmark).toMatch(/--stores 2/);
    expect(benchmark).toMatch(/--sample 5/);
  });

  it('rejects a coverage object that is missing or not the real coverage shape', () => {
    const root = temp();
    expect(() => prepareCorpusCandidate({
      root, assetsDir: path.join(root, 'assets'), builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
    })).toThrow(/already-measured coverage object/i);
  });
});

describe('reconciliation output paths must never overlap the checkout, seed, or installed brain (rule 7)', () => {
  it('rejects an assets or workspace directory that is, contains, or is contained by the checkout kb build workspace', async () => {
    const root = temp();
    const kb = path.join(root, 'kb');
    fs.mkdirSync(kb, { recursive: true });
    await expect(acquireCorpusGeneration({ assetsDir: kb, workspaceDir: path.join(root, 'work'), root }))
      .rejects.toThrow(/checkout kb build workspace/i);
    await expect(acquireCorpusGeneration({ assetsDir: path.join(root, 'assets'), workspaceDir: kb, root }))
      .rejects.toThrow(/checkout kb build workspace/i);
    await expect(acquireCorpusGeneration({ assetsDir: path.join(kb, 'nested'), workspaceDir: path.join(root, 'work'), root }))
      .rejects.toThrow(/checkout kb build workspace/i);
  });

  it('rejects a workspace directory that is, or is nested within, the assets directory', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    await expect(acquireCorpusGeneration({ assetsDir, workspaceDir: path.join(assetsDir, 'sub'), root }))
      .rejects.toThrow(/assets directory/i);
  });

  it('assertPathNotOverlapping fails closed on any direction of overlap, and passes clean, disjoint paths', () => {
    const root = temp();
    const forbidden = [{ label: 'the forbidden root', dir: path.join(root, 'forbidden') }];
    fs.mkdirSync(path.join(root, 'forbidden'), { recursive: true });
    expect(() => assertPathNotOverlapping('target', path.join(root, 'forbidden'), forbidden)).toThrow(/forbidden root/i);
    expect(() => assertPathNotOverlapping('target', path.join(root, 'forbidden', 'nested'), forbidden)).toThrow(/forbidden root/i);
    expect(() => assertPathNotOverlapping('target', root, forbidden)).toThrow(/forbidden root/i); // parent of forbidden
    expect(() => assertPathNotOverlapping('target', path.join(root, 'clean'), forbidden)).not.toThrow();
  });
});

describe('sealed-generation acquisition (acquireSealedGeneration)', () => {
  // The round-stability loop this replaced only returned when a fresh observation of the ENTIRE live
  // source universe hashed identically to the one it started with. Measured 2026-09-14/15: a round takes
  // about an hour, the hash covers each repository's updatedAt/pushedAt/diskUsage/head oid, and the org
  // pushes continuously -- so progress was unreliable under sustained churn and a local run died there
  // after refreshing 90 stores. Dual's ruling: freeze one discovery manifest, accept on completeness
  // against its immutable pins, and demote the closing observation to telemetry that cannot veto.
  const observationA = { observationSha256: 'a'.repeat(64) };
  const coverageStub = { schemaVersion: 1, coverageGeneration: 'g1', rows: [] };
  const noopLedger = () => ({ stores: {} });
  const seams = () => ({
    build: vi.fn(async () => coverageStub),
    execute: vi.fn(async () => ({ refreshed: [] })),
    prune: vi.fn(async () => ({ pruned: [] })),
    rebuild: vi.fn(async () => ({ rebuilt: [] })),
  });

  it('observes ONCE and accepts on completeness against the sealed manifest', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    const result = await acquireSealedGeneration({
      maxAttempts: 3, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.observation).toEqual(observationA);
    expect(result.consistencyModel).toBe('sealed-acquisition-manifest/1');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('re-derives coverage AFTER rebuilding aggregates, against the same sealed observation', async () => {
    // The refactor to sealed acquisition originally dropped this, and a real 56-minute build died at
    // build-bundle with "coverage row gist:... was measured against different ruv-gists RVF bytes than
    // this corpus carries" -- the rows still pinned the PRE-rebuild aggregate digest. Coverage must be
    // recomputed after the rebuild, from the SAME observation (never a fresh one).
    const observe = vi.fn(async () => observationA);
    const f = seams();
    const stale = { ...coverageStub, coverageGeneration: 'before-rebuild' };
    const settled = { ...coverageStub, coverageGeneration: 'after-rebuild' };
    let builds = 0;
    f.build = vi.fn(async () => { builds += 1; return builds === 1 ? stale : settled; });
    const result = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(builds).toBe(2);
    expect(f.build).toHaveBeenNthCalledWith(1, observationA);
    expect(f.build).toHaveBeenNthCalledWith(2, observationA); // same sealed observation, not a new one
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.coverage).toEqual(settled); // the post-rebuild coverage is what ships
  });

  it('MUST NOT restart when the universe keeps moving: continuous churn cannot invalidate a sealed generation', async () => {
    // Every call returns a DIFFERENT universe hash -- the exact condition that made the old loop fail
    // after exhausting its rounds. A sealed generation never re-observes, so it simply completes.
    let n = 0;
    const observe = vi.fn(async () => ({ observationSha256: String(n++).padStart(64, '0') }));
    const f = seams();
    const result = await acquireSealedGeneration({
      maxAttempts: 3, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('retries the SAME pinned inputs when a gist revision moves mid-fetch, without re-observing', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    let calls = 0;
    f.rebuild = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('gist moved');
        error.code = 'GIST_OBSERVATION_MOVED';
        error.gistId = 'g1';
        throw error;
      }
      return { rebuilt: ['concepts'] };
    });
    const result = await acquireSealedGeneration({
      maxAttempts: 3, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    });
    expect(observe).toHaveBeenCalledTimes(1); // the universe is never re-observed
    expect(calls).toBe(2);
    expect(result.attempts[0].retried).toMatchObject({ reason: expect.stringMatching(/gist revision moved/i), gistId: 'g1' });
    expect(result.observation).toEqual(observationA);
  });

  it('MUST BLOCK: an exhausted partial generation fails explicitly rather than being accepted', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    // One eligible source never reaches CURRENT: completeness against the manifest is unmet.
    f.build = vi.fn(async () => ({
      ...coverageStub,
      rows: [{
        kind: 'repository', disposition: 'eligible', status: 'STALE', name: 'x',
        url: 'https://github.com/ruvnet/x', upstream: { sha: 'a'.repeat(40) },
        artifact: { store: 'x', sourceCommit: 'b'.repeat(40) },
      }],
    }));
    await expect(acquireSealedGeneration({
      maxAttempts: 2, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
    })).rejects.toThrow(/sealed generation incomplete after 2 acquisition attempt\(s\).*unresolved against the sealed manifest/is);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('reports freshness as telemetry only: a moved universe is recorded, never a veto', async () => {
    const observe = vi.fn(async () => observationA);
    const f = seams();
    const result = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...f,
      closingObservation: async () => ({ observationSha256: 'f'.repeat(64) }),
    });
    expect(result.freshness).toMatchObject({ checkStatus: 'NEWER_REVISION_OBSERVED', closingObservationSha256: 'f'.repeat(64) });
    expect(result.coverage).toEqual(coverageStub); // accepted regardless
  });

  it('a failed or absent closing observation yields UNKNOWN freshness and still accepts', async () => {
    const observe = vi.fn(async () => observationA);
    const failing = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...seams(),
      closingObservation: async () => { throw new Error('rate limited'); },
    });
    expect(failing.freshness).toMatchObject({ checkStatus: 'UNKNOWN', reason: expect.stringMatching(/rate limited/) });
    const absent = await acquireSealedGeneration({
      maxAttempts: 1, assetsDir: temp(), observe, readLedger: noopLedger, ...seams(),
    });
    expect(absent.freshness).toMatchObject({ checkStatus: 'UNKNOWN', reason: expect.stringMatching(/no closing observation/) });
  });
});

describe('positive-selection pruning (pruneIneligibleStores) — required proof 5', () => {
  it('removes a store\'s full artifact family and ledger/SOURCE entries once it is no longer eligible', () => {
    const assetsDir = temp();
    for (const store of ['alpha', 'beta']) {
      for (const name of ['big.rvf', 'big.rvf.idmap.json', 'big.rvf.embed.json', 'passages.jsonl', 'meta.json']) {
        fs.writeFileSync(path.join(assetsDir, `${store}.${name}`), 'x');
      }
    }
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
      alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a') },
      beta: { file: 'beta.big.rvf', sourceCommit: sha('b') },
      'ruv-gists': { file: 'ruv-gists.big.rvf', sourceCommit: null },
    } }));
    fs.writeFileSync(path.join(assetsDir, 'SOURCE.json'), JSON.stringify({ stores: {
      alpha: { sourceCommit: sha('a') }, beta: { sourceCommit: sha('b') },
    } }));

    // beta was eligible in a prior round (present in ledger + SOURCE + on disk) but is no longer
    // eligible this round (removed from policy, gone private, or deleted upstream) -- it must not
    // linger in the finalized corpus.
    const result = pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha'] });

    expect(result.pruned).toEqual(['beta']);
    for (const name of ['big.rvf', 'big.rvf.idmap.json', 'big.rvf.embed.json', 'passages.jsonl', 'meta.json']) {
      expect(fs.existsSync(path.join(assetsDir, `beta.${name}`))).toBe(false);
      expect(fs.existsSync(path.join(assetsDir, `alpha.${name}`))).toBe(true);
    }
    const ledger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    expect(Object.keys(ledger.stores).sort()).toEqual(['alpha', 'ruv-gists']);
    const source = JSON.parse(fs.readFileSync(path.join(assetsDir, 'SOURCE.json'), 'utf8'));
    expect(Object.keys(source.stores)).toEqual(['alpha']);
  });

  it('never prunes ruv-gists or concepts, and no-ops cleanly when there is nothing stale', () => {
    const assetsDir = temp();
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
      alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a') },
      'ruv-gists': { file: 'ruv-gists.big.rvf', sourceCommit: null },
      concepts: { file: 'concepts.big.rvf', sourceCommit: null },
    } }));
    expect(pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha'] })).toEqual({ pruned: [] });
  });

  it('no-ops cleanly when the ledger does not exist yet (nothing to prune)', () => {
    expect(pruneIneligibleStores({ assetsDir: temp(), eligibleStores: [] })).toEqual({ pruned: [] });
  });
});

describe('legacy provenance is preserved distinctly from current-round rebuilds — required proof 6', () => {
  it('pruning never touches a still-eligible store, whether legacy-reused or freshly rebuilt this round', () => {
    const assetsDir = temp();
    const legacyGeneration = { file: 'alpha.big.rvf', sourceCommit: sha('a'),
      builtUtc: '2026-01-01T00:00:00.000Z', model: 'legacy-model' };
    const freshGeneration = { file: 'beta.big.rvf', sourceCommit: sha('b'),
      builtUtc: '2026-09-13T00:00:00.000Z', model: 'fresh-model' };
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({
      stores: { alpha: legacyGeneration, beta: freshGeneration },
    }));
    fs.writeFileSync(path.join(assetsDir, 'alpha.big.rvf'), 'legacy-bytes');
    fs.writeFileSync(path.join(assetsDir, 'beta.big.rvf'), 'fresh-bytes');

    const result = pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha', 'beta'] });

    expect(result).toEqual({ pruned: [] });
    const ledger = JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8'));
    // The legacy row is preserved byte-for-byte -- pruning must never re-stamp or reclassify a
    // still-eligible store's generation record just because a round ran, which is exactly what
    // would erase the distinction between "verified this round" and "legacy, already verified".
    expect(ledger.stores.alpha).toEqual(legacyGeneration);
    expect(ledger.stores.beta).toEqual(freshGeneration);
  });

  it('a seed\'s bootstrap fence evidence is untouched by reconciliation pruning', () => {
    const assetsDir = temp();
    fs.writeFileSync(path.join(assetsDir, 'SEED-PRIVATE-STORES.json'), JSON.stringify({ privateStores: ['secret'] }));
    fs.writeFileSync(path.join(assetsDir, 'PRIVATE-STORES.json'), JSON.stringify({ privateStores: [] }));
    const before = seedPrivateFenceEvidence(assetsDir);
    expect(before).not.toBeNull();

    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: {
      alpha: { file: 'alpha.big.rvf', sourceCommit: sha('a') },
      ghost: { file: 'ghost.big.rvf', sourceCommit: sha('c') },
    } }));
    fs.writeFileSync(path.join(assetsDir, 'alpha.big.rvf'), 'x');
    fs.writeFileSync(path.join(assetsDir, 'ghost.big.rvf'), 'x');

    const result = pruneIneligibleStores({ assetsDir, eligibleStores: ['alpha'] });

    expect(result.pruned).toEqual(['ghost']);
    expect(fs.existsSync(path.join(assetsDir, 'ghost.big.rvf'))).toBe(false);
    // The bootstrap-fence distinction Step 1 established (seedPrivateFenceEvidence /
    // bootstrapIdentity) must never be weakened or bypassed by the new positive-selection prune.
    expect(seedPrivateFenceEvidence(assetsDir)).toEqual(before);
  });
});

describe('standalone workflow boundary', () => {
  it('binds preparation to exact main SHA/tag/digest and leaves publication to protected-release', () => {
    const workflow = fs.readFileSync(path.resolve('.github/workflows/corpus-seed.yml'), 'utf8');
    expect(workflow).toContain('candidate_sha:');
    expect(workflow).toContain('seed_tag:');
    expect(workflow).toContain('seed_sha256:');
    expect(workflow).toContain('ref: ${{ inputs.candidate_sha }}');
    expect(workflow).toContain('git rev-parse origin/main');
    expect(workflow).toContain('gh release download "$SEED_TAG"');
    expect(workflow).toContain('node scripts/corpus-reconcile.mjs');
    expect(workflow).toContain('kb/PRIVATE-STORES.json');
    expect(workflow).not.toMatch(/releases\/latest|download\/latest|\brelease create\b|node scripts\/corpus-seed-publish\.mjs/);
    expect(workflow).toMatch(/protected-release\.yml/);
  });
});


describe('admitted fork reconciliation', () => {
  const forkDelta = { version: 'fork-delta/2', forkRepository: 'ruvnet/alpha', upstream: 'original/alpha',
    forkHeadSha: sha('a'), upstreamHeadSha: sha('b'), mergeBaseSha: sha('c'), aheadBy: 1, behindBy: 2 };
  const row = { ...repo({ name: 'alpha', disposition: 'fork:original-content' }), forkDelta };
  it('plans a delta build even when an old full-tree generation claims the same head', () => {
    const plan = planReconciliation({ coverage: coverage([row]), ledger: { stores: { alpha: { sourceCommit: sha('a') } } } });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ sourceMode: 'fork-delta', forkDelta });
  });
  it('does not reuse a delta receipt for a different upstream baseline', () => {
    const generation = { sourceCommit: sha('a'), sourceMode: 'fork-delta', forkDelta: {
      ...forkDelta, upstreamHeadSha: sha('d'), inventorySha256: 'e'.repeat(64), passagesSha256: 'f'.repeat(64) } };
    expect(planReconciliation({ coverage: coverage([row]), ledger: { stores: { alpha: generation } } })).toHaveLength(1);
  });
});
