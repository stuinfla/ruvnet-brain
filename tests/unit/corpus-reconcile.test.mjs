import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as corpusReconcileModule from '../../scripts/corpus-reconcile.mjs';
import {
  assertBootstrapIdentity,
  executeReconciliation,
  materializeGistReceipts,
  normalizeExtractedCorpus,
  planReconciliation,
  prepareCorpusCandidate,
  reconcileUntilStable,
  syncCorpusInputs,
} from '../../scripts/corpus-reconcile.mjs';
import { sourceObservationDigest } from '../../scripts/source-coverage.mjs';

const temps = [];
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-reconcile-'));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  vi.restoreAllMocks();
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
  status: 'CURRENT',
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

    const fenced = path.join(root, 'fenced');
    fs.mkdirSync(fenced, { recursive: true });
    fs.writeFileSync(path.join(fenced, 'RVF-GENERATIONS.json'), '{"stores":{}}');
    fs.writeFileSync(path.join(fenced, 'PRIVATE-STORES.json'), '{"privateStores":[]}');
    expect(() => normalizeExtractedCorpus({ extractedDir: fenced, assetsDir: path.join(root, 'fenced-assets') }))
      .toThrow(/must not supply a private-store fence/i);
  });
});

describe('reconciliation planning', () => {
  it('reobserves after building until the source universe is stable and fails at the bound', async () => {
    const observations = ['1', '2', '2'].map((value) => ({ observationSha256: value }));
    let observed = 0;
    let ledger = { stores: {} };
    const result = await reconcileUntilStable({ maxRounds: 3,
      observe: () => observations[observed++] || observations.at(-1),
      build: (observation) => coverage([repo({ name: 'alpha', upstream: sha(observation.observationSha256) })]),
      readLedger: () => ledger,
      execute: (plan) => { ledger = { stores: { alpha: { sourceCommit: plan[0].upstreamSha } } }; return { refreshed: ['alpha'] }; },
      prune: () => ({ pruned: [] }), rebuild: () => ({ rebuilt: [] }) });
    expect(result.rounds).toHaveLength(2);
    expect(result.observation.observationSha256).toBe(observations.at(-1).observationSha256);
    await expect(reconcileUntilStable({ maxRounds: 1, observe: (() => { let i = 0; return () => ({ observationSha256: String(i++) }); })(),
      build: (observation) => coverage([repo({ name: 'alpha', upstream: sha(String(Number(observation.observationSha256) % 10)) })]),
      readLedger: () => ({ stores: {} }), execute: () => ({}), prune: () => ({}), rebuild: () => ({}) }))
      .rejects.toThrow(/did not stabilize/);
  });

  it('reobserves a moving gist snapshot instead of accepting mixed-time detail bytes', async () => {
    const observations = ['one', 'two', 'two'].map((observationSha256) => ({ observationSha256 }));
    let index = 0;
    let rebuilds = 0;
    const result = await reconcileUntilStable({ maxRounds: 3,
      observe: () => observations[index++] || observations.at(-1), build: () => coverage([]),
      readLedger: () => ({ stores: {} }), execute: () => ({ refreshed: [] }), prune: () => ({ pruned: [] }),
      rebuild: () => {
        if (rebuilds++ === 0) {
          const error = new Error('moved'); error.code = 'GIST_OBSERVATION_MOVED'; error.gistId = 'abc'; throw error;
        }
        return { rebuilt: ['ruv-gists'] };
      } });
    expect(result.observation.observationSha256).toBe('two');
    expect(result.rounds[0].invalidated).toEqual(expect.objectContaining({ gistId: 'abc' }));
    expect(result.rounds[1].rebuilt).toEqual(['ruv-gists']);
  });

  it('rejects a stable observation while repository artifacts remain unresolved', async () => {
    await expect(reconcileUntilStable({ maxRounds: 1,
      observe: () => ({ observationSha256: 'stable' }),
      build: () => coverage([repo({ name: 'alpha', upstream: sha('a') })]),
      readLedger: () => ({ stores: {} }),
      execute: () => ({ refreshed: [] }), prune: () => ({ pruned: [] }), rebuild: () => ({ rebuilt: [] }),
    })).rejects.toThrow(/stabilized with 1 unresolved repository artifact/);
  });

  it('rejects a stable observation while an eligible source is not CURRENT', async () => {
    const row = { ...repo({ name: 'alpha', upstream: sha('a') }), status: 'STALE' };
    await expect(reconcileUntilStable({ maxRounds: 1,
      observe: () => ({ observationSha256: 'stable' }), build: () => coverage([row]),
      readLedger: () => ({ stores: { alpha: { sourceCommit: sha('a') } } }),
      execute: () => ({ refreshed: [] }), prune: () => ({ pruned: [] }), rebuild: () => ({ rebuilt: [] }),
    })).rejects.toThrow(/stabilized with 1 unresolved eligible source/);
  });

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
  it('fresh-clones, checks out and verifies the exact SHA before isolated forge-refresh, then promotes once', async () => {
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
      if (command === process.execPath && path.basename(args[0]) === 'forge-refresh.mjs'
        && path.basename(path.dirname(args[0])) === 'kb') {
        const out = args[args.indexOf('--out') + 1];
        const body = 'alpha-rvf';
        fs.writeFileSync(path.join(out, 'alpha.big.rvf'), body);
        for (const suffix of ['.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.writeFileSync(path.join(out, `alpha${suffix}`), suffix);
        }
        fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: {
          file: 'alpha.big.rvf', sourceCommit: sha('a'), sha256: crypto.createHash('sha256').update(body).digest('hex'),
          bytes: Buffer.byteLength(body), model: 'fixture', dimensions: 384, builtUtc: '2026-08-22T00:00:00Z',
        } } }));
        fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify({ stores: { alpha: { sourceCommit: sha('a') } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = await executeReconciliation({ plan, assetsDir, workspaceDir, root, run });
    expect(result).toMatchObject({ refreshed: ['alpha'], workers: [{ store: 'alpha', sourceCommit: sha('a') }] });
    expect(calls).toEqual(expect.arrayContaining([
      ['git', 'clone', '--no-checkout', '--filter=blob:none', 'https://github.com/ruvnet/alpha', expect.stringContaining('alpha')],
      ['git', '-C', expect.stringContaining('alpha'), 'fetch', '--depth=1', 'origin', sha('a')],
      ['git', '-C', expect.stringContaining('alpha'), 'checkout', '--detach', 'FETCH_HEAD'],
    ]));
    expect(calls.find((call) => call[0] === process.execPath))
      .toEqual(expect.arrayContaining([process.execPath, expect.stringMatching(/kb[\\/]forge-refresh\.mjs$/),
        '--repo', expect.stringContaining('alpha'), '--out', expect.stringMatching(/workers\/alpha\/assets$/), '--name', 'alpha']));
    expect(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).stores.alpha.sourceCommit).toBe(sha('a'));
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
      .rejects.toThrow(/worker artifact family is incomplete/i);
  });

  it('runs bounded isolated workers and leaves canonical bytes unchanged when any worker fails', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    const ledgerFile = path.join(assetsDir, 'RVF-GENERATIONS.json');
    const sourceFile = path.join(assetsDir, 'SOURCE.json');
    fs.writeFileSync(ledgerFile, '{"schemaVersion":1,"stores":{}}\n');
    fs.writeFileSync(sourceFile, '{"builder":"fixture","stores":{}}\n');
    const before = [fs.readFileSync(ledgerFile), fs.readFileSync(sourceFile)];
    const plan = ['alpha', 'beta'].map((store, index) => ({ name: store, store,
      url: `https://github.com/ruvnet/${store}`, upstreamSha: sha(index ? 'b' : 'a'),
      ledgerSourceCommit: null, reason: 'missing' }));
    let active = 0;
    let peak = 0;
    const run = async (command, args) => {
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) {
        const store = args[1].includes('beta') ? 'b' : 'a';
        return { status: 0, stdout: `${sha(store)}\n`, stderr: '' };
      }
      if (command === process.execPath) {
        active++;
        peak = Math.max(peak, active);
        expect(fs.readFileSync(ledgerFile)).toEqual(before[0]);
        expect(fs.readFileSync(sourceFile)).toEqual(before[1]);
        const store = args[args.indexOf('--name') + 1];
        await new Promise((resolve) => setTimeout(resolve, store === 'alpha' ? 3 : 8));
        active--;
        if (store === 'beta') return { status: 1, stdout: '', stderr: 'injected worker failure' };
        const out = args[args.indexOf('--out') + 1];
        const body = `${store}-rvf`;
        fs.writeFileSync(path.join(out, `${store}.big.rvf`), body);
        for (const suffix of ['.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.writeFileSync(path.join(out, `${store}${suffix}`), suffix);
        }
        fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { [store]: {
          file: `${store}.big.rvf`, sourceCommit: sha('a'), sha256: crypto.createHash('sha256').update(body).digest('hex'),
          bytes: Buffer.byteLength(body), model: 'fixture', dimensions: 384, builtUtc: '2026-08-22T00:00:00Z',
        } } }));
        fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify({ stores: { [store]: { sourceCommit: sha('a') } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    await expect(executeReconciliation({ plan, assetsDir, workspaceDir: path.join(root, 'workers'),
      root, run, concurrency: 2 })).rejects.toThrow(/injected worker failure/);
    expect(peak).toBe(2);
    expect(fs.readFileSync(ledgerFile)).toEqual(before[0]);
    expect(fs.readFileSync(sourceFile)).toEqual(before[1]);
  });

  it('merges successful workers in canonical store order independent of completion order', async () => {
    const root = temp();
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(root, 'kb', 'forge-refresh.mjs'), '// fixture');
    fs.writeFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), '{"schemaVersion":1,"stores":{}}\n');
    fs.writeFileSync(path.join(assetsDir, 'SOURCE.json'), '{"builder":"fixture","stores":{}}\n');
    const plan = ['beta', 'alpha'].map((store) => ({ name: store, store,
      url: `https://github.com/ruvnet/${store}`, upstreamSha: sha(store === 'alpha' ? 'a' : 'b'),
      ledgerSourceCommit: null, reason: 'missing' }));
    const completed = [];
    const run = async (command, args) => {
      if (command === 'git' && args[0] === 'clone') fs.mkdirSync(args.at(-1), { recursive: true });
      if (command === 'git' && args.includes('rev-parse')) {
        return { status: 0, stdout: `${sha(args[1].includes('alpha') ? 'a' : 'b')}\n`, stderr: '' };
      }
      if (command === process.execPath) {
        const store = args[args.indexOf('--name') + 1];
        const sourceCommit = sha(store === 'alpha' ? 'a' : 'b');
        await new Promise((resolve) => setTimeout(resolve, store === 'alpha' ? 8 : 1));
        const out = args[args.indexOf('--out') + 1];
        const body = `${store}-rvf`;
        fs.writeFileSync(path.join(out, `${store}.big.rvf`), body);
        for (const suffix of ['.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.writeFileSync(path.join(out, `${store}${suffix}`), `${store}${suffix}`);
        }
        fs.writeFileSync(path.join(out, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { [store]: {
          file: `${store}.big.rvf`, sourceCommit, sha256: crypto.createHash('sha256').update(body).digest('hex'),
          bytes: Buffer.byteLength(body), model: 'fixture', dimensions: 384, builtUtc: '2026-08-22T00:00:00Z',
        } } }));
        fs.writeFileSync(path.join(out, 'SOURCE.json'), JSON.stringify({ stores: { [store]: { sourceCommit } } }));
        completed.push(store);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await executeReconciliation({ plan, assetsDir, workspaceDir: path.join(root, 'workers'),
      root, run, concurrency: 2 });
    expect(completed).toEqual(['beta', 'alpha']);
    expect(result.refreshed).toEqual(['alpha', 'beta']);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(assetsDir, 'RVF-GENERATIONS.json'), 'utf8')).stores))
      .toEqual(['alpha', 'beta']);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(assetsDir, 'SOURCE.json'), 'utf8')).stores))
      .toEqual(['alpha', 'beta']);
  });
});

describe('generated gist receipt lifecycle', () => {
  it('starts without a generated gist receipt and materializes it from the sealed live observation', async () => {
    const root = temp();
    const kb = path.join(root, 'kb');
    const assets = path.join(root, 'assets');
    fs.mkdirSync(path.join(kb, 'l2'), { recursive: true });
    fs.mkdirSync(assets);
    for (const name of ['capability-cards.md', 'external-sources.json', 'no-corpus-repos.json',
      'public-store-classes.json']) fs.writeFileSync(path.join(kb, name), `${name}\n`);
    fs.writeFileSync(path.join(kb, 'l2', 'topic.md'), 'topic\n');
    const synced = syncCorpusInputs({ root, assetsDir: assets });
    expect(synced.copied).not.toContain('ruv-gists.sources.json');
    expect(fs.existsSync(path.join(assets, 'ruv-gists.sources.json'))).toBe(false);

    const gistId = 'a'.repeat(32);
    const file = { filename: 'notes.md', raw_url: `https://gist.example/${gistId}/raw/${'b'.repeat(40)}/notes.md`,
      size: 5, type: 'text/plain', language: 'Markdown' };
    const base = { schemaVersion: 1, kind: 'ruvnet-brain-source-observation', owner: 'ruvnet',
      observedAt: '2026-08-22T01:00:00Z', repositories: { rows: [], expected: 0, pages: [] },
      gists: { rows: [{ id: gistId, updated_at: '2026-08-22T00:00:00Z', files: { 'notes.md': file } }],
        expected: 1, pages: [] } };
    const observation = { ...base, observationSha256: sourceObservationDigest(base) };
    const result = await materializeGistReceipts({ observation, assetsDir: assets,
      fetchGist: async () => ({ id: gistId, updated_at: '2026-08-22T00:00:00Z',
        history: [{ version: 'b'.repeat(40) }], files: { 'notes.md': { ...file, content: 'notes', truncated: false } } }),
      now: () => '2026-08-22T02:00:00Z' });
    expect(result.receipt).toMatchObject({ schemaVersion: 3,
      sourceObservationSha256: observation.observationSha256, gistSet: { count: 1 } });
    expect(JSON.parse(fs.readFileSync(result.sourceFile, 'utf8'))).toEqual(result.receipt);

    const moved = structuredClone(observation);
    moved.gists.rows[0].updated_at = '2026-08-22T03:00:00Z';
    await expect(materializeGistReceipts({ observation: moved, assetsDir: assets }))
      .rejects.toThrow(/exact sealed source observation/);
  });

  it('observes the complete configured source universe before materializing production gist receipts', async () => {
    expect(corpusReconcileModule.observeAndMaterializeGistReceipts).toBeTypeOf('function');
    const assets = temp();
    const externalSources = [{ store: 'external', repository: 'ruvnet/external' }];
    fs.writeFileSync(path.join(assets, 'external-sources.json'), JSON.stringify({ sources: externalSources }));
    const gistId = 'c'.repeat(32);
    const listedFile = { filename: 'notes.md', raw_url: `https://gist.example/${gistId}/raw/${'d'.repeat(40)}/notes.md`,
      size: 5, type: 'text/plain', language: 'Markdown' };
    const base = { schemaVersion: 1, kind: 'ruvnet-brain-source-observation', owner: 'ruvnet',
      observedAt: '2026-08-22T03:00:00Z', repositories: { rows: [], expected: 0, pages: [] },
      gists: { rows: [{ id: gistId, updated_at: '2026-08-22T02:00:00Z', files: { 'notes.md': listedFile } }],
        expected: 1, pages: [] } };
    const observation = { ...base, observationSha256: sourceObservationDigest(base) };
    const observe = ({ owner, externalSources: received }) => {
      expect(owner).toBe('ruvnet');
      expect(received).toEqual(externalSources);
      return observation;
    };

    const result = await corpusReconcileModule.observeAndMaterializeGistReceipts({ owner: 'ruvnet', assetsDir: assets,
      observe,
      fetchGist: async () => ({ id: gistId, updated_at: '2026-08-22T02:00:00Z',
        history: [{ version: 'd'.repeat(40) }],
        files: { 'notes.md': { ...listedFile, content: 'notes', truncated: false } } }),
      now: () => '2026-08-22T04:00:00Z' });
    expect(result.observation).toEqual(observation);
    expect(result.receipt).toMatchObject({ schemaVersion: 3,
      sourceObservationSha256: observation.observationSha256, gistSet: { count: 1 } });
    expect(JSON.parse(fs.readFileSync(path.join(assets, 'ruv-gists.sources.json'), 'utf8'))).toEqual(result.receipt);
  });
});

describe('candidate preparation', () => {
  it('runs strict coverage before building and sealing, and never invokes a publisher', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    for (const file of ['source-coverage.mjs', 'build-bundle.mjs', 'corpus-candidate.mjs']) {
      fs.writeFileSync(path.join(root, 'scripts', file), '// fixture');
    }
    const calls = [];
    const run = (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '', stderr: '' }; };
    const result = prepareCorpusCandidate({
      root,
      assetsDir: path.join(root, 'assets'),
      owner: 'ruvnet',
      builderSha: sha('e'),
      candidateDir: path.join(root, 'candidate', 'ruvnet-brain'),
      receiptFile: path.join(root, 'evidence', 'corpus-receipt.json'),
      coverageFile: path.join(root, 'data', 'source-coverage.json'),
      run,
    });
    expect(result.bundleFile).toBe(path.join(root, 'candidate', 'ruvnet-brain.zip'));
    const joined = calls.map((call) => call.join(' '));
    expect(joined[0]).toMatch(/source-coverage\.mjs .*--write/);
    expect(joined[1]).toMatch(/source-coverage\.mjs .*--check .*--strict/);
    expect(joined[2]).toMatch(/build-bundle\.mjs/);
    expect(joined[3]).toMatch(/corpus-candidate\.mjs/);
    expect(joined[4]).toMatch(/corpus-candidate\.mjs .*--verify/);
    expect(joined.join('\n')).not.toMatch(/corpus-seed-publish|release create|--publish/);
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
