import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertBootstrapIdentity,
  executeReconciliation,
  normalizeExtractedCorpus,
  planReconciliation,
  prepareCorpusCandidate,
} from '../../scripts/corpus-reconcile.mjs';

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
      if (command === process.execPath && /[\\/]kb[\\/]forge-refresh\.mjs$/.test(args[0])) {
        const output = args[args.indexOf('--out') + 1];
        fs.mkdirSync(output, { recursive: true });
        for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.writeFileSync(path.join(output, `alpha${suffix}`), suffix.endsWith('.rvf') ? 'rvf' : '{}');
        }
        const rvfDigest = crypto.createHash('sha256').update('rvf').digest('hex');
        fs.writeFileSync(path.join(output, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: {
          file: 'alpha.big.rvf', sourceCommit: sha('a'), sha256: rvfDigest, bytes: 3,
          model: 'local', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z',
        } } }));
        fs.writeFileSync(path.join(output, 'SOURCE.json'), JSON.stringify({ stores: { alpha: { sourceCommit: sha('a') } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    await expect(executeReconciliation({ plan, assetsDir, workspaceDir, root, run }))
      .resolves.toMatchObject({ refreshed: ['alpha'], workers: [{ store: 'alpha', sourceCommit: sha('a') }] });
    expect(calls).toEqual(expect.arrayContaining([
      ['git', 'clone', '--no-checkout', '--filter=blob:none', 'https://github.com/ruvnet/alpha', expect.stringMatching(/[\\/]clones[\\/]workers[\\/]alpha[\\/]clone$/)],
      ['git', '-C', expect.stringMatching(/[\\/]clones[\\/]workers[\\/]alpha[\\/]clone$/), 'fetch', '--depth=1', 'origin', sha('a')],
      ['git', '-C', expect.stringMatching(/[\\/]clones[\\/]workers[\\/]alpha[\\/]clone$/), 'checkout', '--detach', 'FETCH_HEAD'],
      ['git', '-C', expect.stringMatching(/[\\/]clones[\\/]workers[\\/]alpha[\\/]clone$/), 'rev-parse', 'HEAD'],
      [process.execPath, expect.stringMatching(/[\\/]kb[\\/]forge-refresh\.mjs$/), '--repo', expect.stringMatching(/[\\/]clones[\\/]workers[\\/]alpha[\\/]clone$/), '--out', expect.stringMatching(/[\\/]clones[\\/]workers[\\/]alpha[\\/]assets$/), '--name', 'alpha'],
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
      if (command === process.execPath && /[\\/]kb[\\/]forge-refresh\.mjs$/.test(args[0])) {
        const output = args[args.indexOf('--out') + 1];
        fs.mkdirSync(output, { recursive: true });
        for (const suffix of ['.big.rvf', '.big.rvf.idmap.json', '.big.rvf.embed.json', '.passages.jsonl', '.meta.json']) {
          fs.writeFileSync(path.join(output, `alpha${suffix}`), suffix.endsWith('.rvf') ? 'rvf' : '{}');
        }
        const rvfDigest = crypto.createHash('sha256').update('rvf').digest('hex');
        fs.writeFileSync(path.join(output, 'RVF-GENERATIONS.json'), JSON.stringify({ stores: { alpha: {
          file: 'alpha.big.rvf', sourceCommit: sha('a'), sha256: rvfDigest, bytes: 3,
          model: 'local', dimensions: 384, builtUtc: '2026-08-21T12:00:00.000Z',
        } } }));
        fs.writeFileSync(path.join(output, 'SOURCE.json'), JSON.stringify({ stores: { alpha: { sourceCommit: sha('0') } } }));
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    await expect(executeReconciliation({ plan, assetsDir, workspaceDir: path.join(root, 'clones'), root, run }))
      .rejects.toThrow(/worker SOURCE manifest does not bind exact source/i);
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
