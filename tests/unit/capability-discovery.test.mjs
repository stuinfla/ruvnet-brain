import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../kb/forge-ask.mjs', () => ({ searchKb: vi.fn(async () => []) }));
vi.mock('../../kb/forge-rerank.mjs', () => ({ rerankPairs: vi.fn(async () => []) }));

import { searchAll } from '../../kb/forge-ask-all.mjs';
import { rerankPairs } from '../../kb/forge-rerank.mjs';
import { routeReposFromCards } from '../../kb/card-lane.mjs';
import { buildReviewedCapabilityExcerpt, matchReviewedCapabilityIntent } from '../../kb/capability-families.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function corpusFor({ repo = 'ruvector', title, preview, body, path: relativePath }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-discovery-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, `${repo}.rvf`), 'stub store');
  fs.writeFileSync(path.join(dir, 'other.rvf'), 'stub store');
  fs.writeFileSync(path.join(dir, 'capability-cards.md'), `## ${repo}\n${preview}\n`);
  fs.writeFileSync(path.join(dir, `${repo}.meta.json`), JSON.stringify({
    entries: {
      witness: { path: relativePath, kind: 'doc', title, preview },
    },
  }));
  fs.writeFileSync(path.join(dir, `${repo}.passages.jsonl`), JSON.stringify({
    id: 'source-witness-1', path: relativePath, title, text: body,
  }) + '\n');
  return dir;
}

describe('source-backed capability discovery', () => {
  it('answers the installer smoke phrasing only from documentation covering storage and no-server use', async () => {
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Client-side vector search with zero server dependencies, IndexedDB persistence, privacy first.',
      body,
    });

    const out = await searchAll({
      dir,
      query: 'How should I store embeddings in this project without running a server?',
      k: 3,
      allowFullCorpus: false,
    });

    expect(out.routing).toMatchObject({
      lane: 'source-backed-discovery',
      implementationRequired: false,
      implementationVerdict: 'unproven',
    });
    expect(out.evidence).toMatchObject({ grade: 'source_grounded', topScore: null });
    expect(out.implementation).toMatchObject({ required: false, verdict: 'unproven' });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      repo: 'ruvector',
      path: 'crates/ruvector-router-wasm/README.md',
      evidenceClass: 'documentation',
      ceScore: null,
    });
    expect(out.results[0].text).toContain('Persist vector data locally');
    expect(out.results[0].text).toContain('zero server dependencies');
    expect(out.sourceDiscovery).toMatchObject({
      proofMethod: 'reviewed-source-catalog',
      passageSha256: '44404f0c1ae135b021ece8e5e30c271fb1900ea0c4f583f1f891ee3196386662',
    });
  });

  it('does not combine browser persistence with an unsupported on-disk-file claim', async () => {
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Offline browser vector database with IndexedDB persistence.',
      body: 'The vector database provides semantic search in the browser. IndexedDB persistence stores data for offline use with zero server round-trips.',
    });

    const out = await searchAll({
      dir,
      query: 'How should I store and search embeddings on disk locally and privately?',
      k: 3,
      allowFullCorpus: false,
    });

    expect(out.routing?.lane).not.toBe('source-backed-discovery');
  });

  it('requires explicit learned-pattern transfer across projects, not same-project memory', async () => {
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruflo-cross-project-transfer-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      repo: 'ruflo',
      title: 'Cross-project pattern transfer',
      path: 'plugins/ruflo-intelligence/agents/intelligence-specialist.md',
      preview: 'Explicit cross-project pattern transfer: publish and pull learned patterns via IPFS.',
      body,
    });

    const out = await searchAll({
      dir,
      query: 'How can agents carry useful learning from one project to another?',
      k: 3,
      allowFullCorpus: false,
    });

    expect(out.routing).toMatchObject({
      lane: 'source-backed-discovery',
      implementationRequired: false,
      implementationVerdict: 'unproven',
    });
    expect(out.results[0].path).toBe('plugins/ruflo-intelligence/agents/intelligence-specialist.md');
    expect(out.results[0].text).toContain("Publish current project's patterns to IPFS");
    expect(out.results[0].text).toContain("Pull a peer's patterns from IPFS by CID");
    expect(out.results[0].text).toContain('Requires `PINATA_API_JWT` configured.');
    expect(out.sourceDiscovery).toMatchObject({
      proofMethod: 'reviewed-source-catalog',
      passageSha256: '3af770c2c5bceb4b612eac6757656d6e2be74b914bdf75f1d6f422af54dcdd36',
    });
  });

  it('accepts only exact reviewed query templates and source bytes', () => {
    const local = matchReviewedCapabilityIntent(
      'How should I store embeddings in this project without running a server?',
      'local-vector-storage',
    );
    const source = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    expect(local).toBeTruthy();
    expect(buildReviewedCapabilityExcerpt(source, local)).toContain('IndexedDB Integration');
    expect(buildReviewedCapabilityExcerpt(`${source} changed`, local)).toBeNull();
    expect(matchReviewedCapabilityIntent(
      'How should I store 1000000000 embeddings in this project without running a server?',
      'local-vector-storage',
    )).toBeNull();
    expect(matchReviewedCapabilityIntent(
      'How should I store embeddings in this project without running a server and use native Rust?',
      'local-vector-storage',
    )).toBeNull();
    expect(matchReviewedCapabilityIntent(
      'How can I stop learned patterns from transferring between projects?',
      'cross-project-agent-learning',
    )).toBeNull();
  });

  it('rechecks the current passage bytes after a same-size, same-mtime source edit', async () => {
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Client-side vector search with zero server dependencies, IndexedDB persistence, privacy first.',
      body,
    });
    const query = 'How should I store embeddings in this project without running a server?';
    const first = await searchAll({ dir, query, k: 3, allowFullCorpus: false });
    expect(first.routing?.lane).toBe('source-backed-discovery');

    const passagesPath = path.join(dir, 'ruvector.passages.jsonl');
    const before = fs.statSync(passagesPath);
    const original = fs.readFileSync(passagesPath, 'utf8');
    const modified = original.replace('User data never leaves the device', 'User data maybe leaves the device');
    expect(Buffer.byteLength(modified)).toBe(Buffer.byteLength(original));
    fs.writeFileSync(passagesPath, modified);
    fs.utimesSync(passagesPath, before.atime, before.mtime);

    const second = await searchAll({ dir, query, k: 3, allowFullCorpus: false });
    expect(second.routing?.lane).not.toBe('source-backed-discovery');
  });

  it('adds the reviewed passage as a reranker candidate for an unseen family paraphrase', async () => {
    vi.mocked(rerankPairs).mockClear();
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Client-side vector search with zero server dependencies and IndexedDB persistence.',
      body,
    });
    const query = 'Can I keep vector embeddings locally and search them while disconnected?';
    expect(routeReposFromCards(query, dir, ['other', 'ruvector'])).toMatchObject({
      family: 'local-vector-storage',
      repos: ['ruvector'],
    });
    await searchAll({ dir, query, repos: ['ruvector'], _routeStage: true,
      _capabilityFamily: 'local-vector-storage', k: 3, allowFullCorpus: false });

    const [rerankedQuery, candidates] = vi.mocked(rerankPairs).mock.calls.at(-1);
    expect(rerankedQuery).toBe(query);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'crates/ruvector-router-wasm/README.md',
        _proofMethod: 'reviewed-capability-witness-candidate',
        _sourcePassageSha256: '44404f0c1ae135b021ece8e5e30c271fb1900ea0c4f583f1f891ee3196386662',
      }),
    ]));
  });

  it('sends unsupported qualifiers intact through ordinary reranking without a positive shortcut', async () => {
    vi.mocked(rerankPairs).mockClear();
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Client-side vector search with zero server dependencies and IndexedDB persistence.',
      body,
    });
    const query = 'Can I keep vector embeddings locally and search them at one billion dimensions without a server?';
    const out = await searchAll({ dir, query, repos: ['ruvector'], _routeStage: true,
      _capabilityFamily: 'local-vector-storage', k: 3, allowFullCorpus: false });

    const [rerankedQuery, candidates] = vi.mocked(rerankPairs).mock.calls.at(-1);
    expect(rerankedQuery).toBe(query);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ _proofMethod: 'reviewed-capability-witness-candidate' }),
    ]));
    expect(out.routing?.lane).not.toBe('source-backed-discovery');
    expect(out.sourceDiscovery).toBeUndefined();
    expect(out.evidence?.grade).not.toBe('source_grounded');
  });

  it('rejects a changed witness hash and continues through ordinary reranking', async () => {
    vi.mocked(rerankPairs).mockClear();
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Client-side vector search with zero server dependencies and IndexedDB persistence.',
      body,
    });
    const passagesPath = path.join(dir, 'ruvector.passages.jsonl');
    fs.writeFileSync(passagesPath, fs.readFileSync(passagesPath, 'utf8').replace('User data never leaves the device', 'User data maybe leaves the device'));
    const query = 'Can I keep vector embeddings locally and search them while disconnected?';
    const out = await searchAll({ dir, query, repos: ['ruvector'], _routeStage: true,
      _capabilityFamily: 'local-vector-storage', k: 3, allowFullCorpus: false });

    const [rerankedQuery, candidates] = vi.mocked(rerankPairs).mock.calls.at(-1);
    expect(rerankedQuery).toBe(query);
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ _proofMethod: 'reviewed-capability-witness-candidate' }),
    ]));
    expect(out.routing?.lane).not.toBe('source-backed-discovery');
  });

  it('leaves ordinary non-family retrieval without a reviewed capability witness', async () => {
    vi.mocked(rerankPairs).mockClear();
    const body = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/retrieval/ruvector-router-wasm-reviewed-passage.txt'), 'utf8');
    const dir = corpusFor({
      title: 'Browser vector storage',
      path: 'crates/ruvector-router-wasm/README.md',
      preview: 'Client-side vector search with zero server dependencies and IndexedDB persistence.',
      body,
    });
    await searchAll({ dir, query: 'What is the release process for this project?', repos: ['ruvector'],
      _routeStage: true, k: 3, allowFullCorpus: false });

    const [, candidates] = vi.mocked(rerankPairs).mock.calls.at(-1);
    expect(candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ _proofMethod: 'reviewed-capability-witness-candidate' }),
    ]));
  });

  it.each([
    {
      name: 'does not drop a native-Rust/no-browser qualifier',
      query: 'How should I store embeddings offline in native Rust without a browser?',
      body: 'The vector database provides semantic search in the browser. IndexedDB persistence stores data for offline use with zero server round-trips.',
    },
    {
      name: 'does not drop an automation and approval qualifier',
      repo: 'ruflo',
      query: 'How can I automatically transfer learned patterns between projects without user approval?',
      body: 'Publish learned patterns to IPFS manually after explicit user approval in a different project.',
    },
    {
      name: 'does not invert a negated transfer request',
      repo: 'ruflo',
      query: 'How can I stop learned patterns from transferring between projects?',
      body: 'The intelligence specialist publishes learned patterns to IPFS from one project and fetches them by CID in a different project.',
    },
    {
      name: 'does not treat cloud-upload privacy concerns as a privacy guarantee',
      query: 'How should I store embeddings locally and privately?',
      body: 'The vector database provides semantic search and persistent storage. Privacy remains a concern because records are uploaded to our cloud.',
    },
    {
      name: 'does not combine separate backend sections into one witness',
      query: 'How should I store embeddings on disk locally?',
      body: 'The vector database supports semantic search and IndexedDB persistence.\n\nThe native RVF file format stores vectors on disk.',
    },
    {
      name: 'does not ignore a request to avoid persistence',
      query: 'How should I store embeddings locally without persistence?',
      body: 'The vector database provides semantic search in the browser. IndexedDB persists vector data with zero server dependencies.',
    },
    {
      name: 'does not drop a numeric scale requirement',
      query: 'How should I store 1000000000 embeddings locally?',
      body: 'The vector database provides semantic search in the browser with zero server dependencies.',
    },
    {
      name: 'does not confuse unrelated persisted objects with vector persistence',
      query: 'How should I persist vector embeddings locally?',
      body: 'The vector database provides semantic search. IndexedDB persists user preferences. Zero server dependencies.',
    },
    {
      name: 'does not infer learned-pattern transfer from an unrelated IPFS action',
      repo: 'ruflo',
      query: 'How can agents carry useful learning from one project to another?',
      body: 'Learned patterns persist inside each project. A different project downloads release binaries using IPFS.',
    },
    {
      name: 'does not erase a source contradiction before accepting a positive example',
      repo: 'ruflo',
      query: 'How can agents carry useful learning from one project to another?',
      body: '## Cross-project pattern transfer\n\nCross-project transfer is not supported.\n\nFor sharing learned patterns across machines or projects:\n\n- Publish current project’s patterns to IPFS.\n- Pull a peer’s patterns from IPFS by CID.',
    },
  ])('$name', async ({ name, query, body, repo }) => {
    const effectiveRepo = repo || 'ruvector';
    const dir = corpusFor({
      repo: effectiveRepo,
      title: 'Capability overview',
      path: 'docs/capability.md',
      preview: body,
      body,
    });
    const out = await searchAll({ dir, query, k: 3, allowFullCorpus: false });
    expect(out.routing?.lane, name).not.toBe('source-backed-discovery');
  });
});
